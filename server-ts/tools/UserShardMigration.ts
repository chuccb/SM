/** Port-only, offline migration for the pre-A23 Unicode account shard formula. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  GetLegacyPortUserHashNo,
  GetUserHashNo,
  USER_DB_SHARD_COUNT,
} from "../src/db/DBMan.ts";

export const USER_SHARD_FORMULA = "ascii-lower(first-unsigned-byte)%6";
export const LEGACY_PORT_USER_SHARD_FORMULA = "unicode-toLowerCase(first-code-unit-low-byte)%6";

const MIGRATION_LOCK_FILE = ".user-shard-migration.lock";
const MIGRATION_BUSY_TIMEOUT_MS = 1_000;
const BACKUP_MANIFEST_FILE = "manifest.json";

type FamilyName = "UserInfo" | "UserInventory";
type SqlValue = string | number | bigint | boolean | NodeJS.TypedArray | null;
type SqlRow = Record<string, SqlValue>;

interface UniqueRule {
  readonly name: string;
  readonly columns: readonly string[];
  readonly applies?: (row: SqlRow) => boolean;
}

interface TableSpec {
  readonly name: string;
  readonly ownerColumn: string;
  readonly primaryKey: readonly string[];
  readonly optional?: boolean;
  readonly unique?: readonly UniqueRule[];
}

interface FamilySpec {
  readonly name: FamilyName;
  readonly filePrefix: FamilyName;
  readonly tables: readonly TableSpec[];
}

const USER_INFO_TABLES = [
  { name: "FxUserAccount", ownerColumn: "ID", primaryKey: ["ID"], unique: [{ name: "SN", columns: ["SN"] }] },
  { name: "FxUserDynamic", ownerColumn: "ID", primaryKey: ["ID"] },
  { name: "TxUserDynamic", ownerColumn: "ID", primaryKey: ["ID"] },
] as const satisfies readonly TableSpec[];

const INVENTORY_TABLES = [
  { name: "FxUserInventory", ownerColumn: "UserID", primaryKey: ["UserID", "ItemSN"] },
  { name: "FxPreInventory", ownerColumn: "UserID", primaryKey: ["SN"] },
  { name: "FxCart", ownerColumn: "UserID", primaryKey: ["UserID"] },
  { name: "LocalBillingWallet", ownerColumn: "Account", primaryKey: ["Account"], optional: true },
  { name: "LocalBillingAuthorization", ownerColumn: "Account", primaryKey: ["Account", "World"], optional: true },
  {
    name: "LocalBillingReservation",
    ownerColumn: "Account",
    primaryKey: ["Reference"],
    optional: true,
    unique: [{ name: "one-held-reservation", columns: ["Account"], applies: row => row.State === "held" }],
  },
  { name: "LocalBillingLedger", ownerColumn: "Account", primaryKey: ["Account", "Reference"], optional: true },
] as const satisfies readonly TableSpec[];

const FAMILY_SPECS = [
  { name: "UserInfo", filePrefix: "UserInfo", tables: USER_INFO_TABLES },
  { name: "UserInventory", filePrefix: "UserInventory", tables: INVENTORY_TABLES },
] as const satisfies readonly FamilySpec[];

interface OpenFamily {
  readonly spec: FamilySpec;
  readonly paths: readonly string[];
  readonly databases: readonly Database[];
}

interface PlannedRow {
  readonly table: TableSpec;
  readonly columns: readonly string[];
  readonly row: SqlRow;
  readonly sourceShard: number;
}

interface MigrationUnit {
  readonly family: OpenFamily;
  readonly accountHex: string;
  readonly targetShard: number;
  readonly rows: PlannedRow[];
  inserts: PlannedRow[];
}

interface BuildPlan {
  readonly units: MigrationUnit[];
  readonly conflicts: UserShardMigrationConflict[];
  readonly scannedRows: number;
  readonly misplacedRows: number;
  readonly misplacedAccounts: number;
  readonly legacyFormulaAccounts: number;
  readonly destinationCopies: number;
  readonly sourceDeletes: number;
}

export interface UserShardMigrationConflict {
  readonly family: FamilyName;
  readonly table: string;
  readonly accountHex: string;
  readonly sourceShards: readonly number[];
  readonly targetShard: number;
  readonly key: string;
  readonly reason: string;
}

export interface UserShardMigrationReport {
  readonly mode: "inspect" | "migrate";
  readonly status: "clean" | "ready" | "conflict" | "migrated";
  readonly formula: typeof USER_SHARD_FORMULA;
  readonly legacyFormula: typeof LEGACY_PORT_USER_SHARD_FORMULA;
  readonly scannedRows: number;
  readonly misplacedAccounts: number;
  readonly legacyFormulaAccounts: number;
  readonly misplacedRows: number;
  readonly destinationCopies: number;
  readonly sourceDeletes: number;
  readonly conflicts: readonly UserShardMigrationConflict[];
  readonly backupDirectory?: string;
  readonly verifiedClean: boolean;
}

interface BackupManifest {
  readonly format: 1;
  readonly createdAt: string;
  readonly sourceDirectory: string;
  readonly formulaBefore: typeof LEGACY_PORT_USER_SHARD_FORMULA;
  readonly formulaAfter: typeof USER_SHARD_FORMULA;
  readonly files: readonly { name: string; bytes: number; sha256: string }[];
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function accountHex(account: string): string {
  return Buffer.from(account, "latin1").toString("hex");
}

function validNativeAccountKey(value: SqlValue): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0xff) return false;
  }
  return true;
}

function valueEqual(left: SqlValue | undefined, right: SqlValue | undefined): boolean {
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    return Buffer.from(left.buffer, left.byteOffset, left.byteLength)
      .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
  }
  return Object.is(left, right);
}

function rowsEqual(columns: readonly string[], left: SqlRow, right: SqlRow): boolean {
  return columns.every(column => valueEqual(left[column], right[column]));
}

function encodedValue(value: SqlValue | undefined): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (typeof value === "string") return `text:${Buffer.from(value, "utf8").toString("hex")}`;
  if (typeof value === "bigint") return `integer:${value}`;
  if (typeof value === "number") return `number:${Object.is(value, -0) ? "-0" : value}`;
  if (typeof value === "boolean") return `boolean:${value ? 1 : 0}`;
  return `blob:${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}`;
}

function rowKey(row: SqlRow, columns: readonly string[]): string {
  return columns.map(column => `${column}=${encodedValue(row[column])}`).join(",");
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

function shardFileName(prefix: FamilyName, shard: number): string {
  return `${prefix}${String(shard).padStart(2, "0")}.db`;
}

function quickCheck(db: Database, path: string): void {
  const rows = db.query<Record<string, string>, []>("PRAGMA quick_check").all();
  if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
    throw new Error(`SQLite quick_check failed for ${path}.`);
  }
}

function openFamilies(dbDirectory: string, writable: boolean): OpenFamily[] {
  const families: OpenFamily[] = [];
  const opened: Database[] = [];
  try {
    for (const spec of FAMILY_SPECS) {
      const paths = Array.from({ length: USER_DB_SHARD_COUNT }, (_, shard) =>
        join(dbDirectory, shardFileName(spec.filePrefix, shard)));
      const missing = paths.filter(path => !existsSync(path));
      if (missing.length !== 0) {
        throw new Error(`Missing shard database(s): ${missing.map(path => basename(path)).join(", ")}.`);
      }
      const databases = paths.map(path => {
        const db = new Database(path, writable
          ? { readwrite: true, create: false, strict: true, safeIntegers: true }
          : { readonly: true, create: false, strict: true, safeIntegers: true });
        opened.push(db);
        return db;
      });
      for (let shard = 0; shard < databases.length; shard++) {
        const db = databases[shard]!;
        db.exec(`PRAGMA busy_timeout=${MIGRATION_BUSY_TIMEOUT_MS}`);
        if (writable) db.exec("PRAGMA synchronous=FULL");
        quickCheck(db, paths[shard]!);
      }
      families.push({ spec, paths, databases });
    }
    return families;
  } catch (error) {
    for (const db of opened.toReversed()) db.close();
    throw error;
  }
}

function closeFamilies(families: readonly OpenFamily[]): void {
  for (const family of families.toReversed()) {
    for (const db of family.databases.toReversed()) db.close();
  }
}

function tableExists(db: Database, table: string): boolean {
  return db.query<{ present: bigint }, [string]>(
    "SELECT COUNT(*) AS present FROM sqlite_schema WHERE type='table' AND name=?",
  ).get(table)!.present !== 0n;
}

function tableColumns(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map(row => row.name);
}

function tableTriggers(db: Database, table: string): string[] {
  return db.query<{ name: string }, [string]>(
    "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name",
  ).all(table).map(row => row.name);
}

function selectByColumns(
  db: Database,
  table: string,
  columns: readonly string[],
  row: SqlRow,
): SqlRow[] {
  const where = columns.map(column => `${quoteIdentifier(column)} IS ?`).join(" AND ");
  const bindings = columns.map(column => row[column] ?? null) as SQLQueryBindings[];
  return db.query<SqlRow, SQLQueryBindings[]>(
    `SELECT * FROM ${quoteIdentifier(table)} WHERE ${where}`,
  ).all(...bindings);
}

function conflictKey(conflict: UserShardMigrationConflict): string {
  return [conflict.family, conflict.table, conflict.accountHex, conflict.targetShard,
    conflict.key, conflict.reason].join("\u001f");
}

function addConflict(
  conflicts: UserShardMigrationConflict[],
  seen: Set<string>,
  conflict: UserShardMigrationConflict,
): void {
  const key = conflictKey(conflict);
  if (seen.has(key)) return;
  seen.add(key);
  conflicts.push(conflict);
}

function makeConflict(
  unit: Pick<MigrationUnit, "family" | "accountHex" | "targetShard" | "rows">,
  table: TableSpec,
  key: string,
  reason: string,
): UserShardMigrationConflict {
  return {
    family: unit.family.spec.name,
    table: table.name,
    accountHex: unit.accountHex,
    sourceShards: [...new Set(unit.rows.filter(row => row.table.name === table.name)
      .map(row => row.sourceShard))].toSorted((left, right) => left - right),
    targetShard: unit.targetShard,
    key,
    reason,
  };
}

function buildPlan(families: readonly OpenFamily[]): BuildPlan {
  const unitsByKey = new Map<string, MigrationUnit>();
  const conflicts: UserShardMigrationConflict[] = [];
  const seenConflicts = new Set<string>();
  const misplacedAccountKeys = new Set<string>();
  const legacyAccountKeys = new Set<string>();
  const schemas = new WeakMap<Database, Map<string, readonly string[] | null>>();
  const triggers = new WeakMap<Database, Map<string, readonly string[]>>();
  const schemaFor = (db: Database, table: string): readonly string[] | null => {
    let cache = schemas.get(db);
    if (!cache) {
      cache = new Map();
      schemas.set(db, cache);
    }
    if (cache.has(table)) return cache.get(table)!;
    const columns = tableExists(db, table) ? tableColumns(db, table) : null;
    cache.set(table, columns);
    return columns;
  };
  const triggersFor = (db: Database, table: string): readonly string[] => {
    let cache = triggers.get(db);
    if (!cache) {
      cache = new Map();
      triggers.set(db, cache);
    }
    const prior = cache.get(table);
    if (prior) return prior;
    const names = tableTriggers(db, table);
    cache.set(table, names);
    return names;
  };
  let scannedRows = 0;
  let misplacedRows = 0;

  for (const family of families) {
    for (let sourceShard = 0; sourceShard < USER_DB_SHARD_COUNT; sourceShard++) {
      const source = family.databases[sourceShard]!;
      for (const table of family.spec.tables) {
        const columns = schemaFor(source, table.name);
        if (!columns) {
          if (table.optional) continue;
          throw new Error(`${basename(family.paths[sourceShard]!)} is missing required table ${table.name}.`);
        }
        if (!columns.includes(table.ownerColumn) || table.primaryKey.some(column => !columns.includes(column))) {
          throw new Error(`${basename(family.paths[sourceShard]!)} has an incompatible ${table.name} schema.`);
        }
        const rows = source.query<SqlRow, []>(`SELECT * FROM ${quoteIdentifier(table.name)}`).iterate();
        for (const row of rows) {
          scannedRows++;
          const owner = row[table.ownerColumn];
          if (!validNativeAccountKey(owner)) {
            addConflict(conflicts, seenConflicts, {
              family: family.spec.name,
              table: table.name,
              accountHex: typeof owner === "string" ? accountHex(owner) : "",
              sourceShards: [sourceShard],
              targetShard: 0,
              key: rowKey(row, table.primaryKey),
              reason: "owner key is empty, contains NUL/non-byte code units, or is not TEXT",
            });
            continue;
          }
          const targetShard = GetUserHashNo(owner);
          if (targetShard === sourceShard) continue;
          misplacedRows++;
          const encodedAccount = accountHex(owner);
          misplacedAccountKeys.add(encodedAccount);
          if (sourceShard === GetLegacyPortUserHashNo(owner)) legacyAccountKeys.add(encodedAccount);
          const unitKey = `${family.spec.name}:${encodedAccount}:${targetShard}`;
          let unit = unitsByKey.get(unitKey);
          if (!unit) {
            unit = { family, accountHex: encodedAccount, targetShard, rows: [], inserts: [] };
            unitsByKey.set(unitKey, unit);
          }
          const target = family.databases[targetShard]!;
          const targetColumns = schemaFor(target, table.name);
          if (!targetColumns) {
            addConflict(conflicts, seenConflicts, {
              family: family.spec.name,
              table: table.name,
              accountHex: encodedAccount,
              sourceShards: [sourceShard],
              targetShard,
              key: rowKey(row, table.primaryKey),
              reason: "target shard is missing this optional table",
            });
            continue;
          }
          if (!sameColumns(columns, targetColumns)) {
            addConflict(conflicts, seenConflicts, {
              family: family.spec.name,
              table: table.name,
              accountHex: encodedAccount,
              sourceShards: [sourceShard],
              targetShard,
              key: rowKey(row, table.primaryKey),
              reason: "source and target table columns differ",
            });
            continue;
          }
          const sourceTriggers = triggersFor(source, table.name);
          const targetTriggers = triggersFor(target, table.name);
          if (sourceTriggers.length !== 0 || targetTriggers.length !== 0) {
            addConflict(conflicts, seenConflicts, {
              family: family.spec.name,
              table: table.name,
              accountHex: encodedAccount,
              sourceShards: [sourceShard],
              targetShard,
              key: rowKey(row, table.primaryKey),
              reason: `table has migration-unsafe trigger(s): ${[
                ...sourceTriggers.map(name => `source:${name}`),
                ...targetTriggers.map(name => `target:${name}`),
              ].join(",")}`,
            });
            continue;
          }
          unit.rows.push({ table, columns, row, sourceShard });
        }
      }
    }
  }

  const units = [...unitsByKey.values()].toSorted((left, right) =>
    left.family.spec.name.localeCompare(right.family.spec.name)
      || left.targetShard - right.targetShard
      || left.accountHex.localeCompare(right.accountHex));

  // First collapse exact duplicates of the same logical primary-key row. A
  // differing duplicate is a conflict and no write is attempted anywhere.
  const desiredRows = new Map<MigrationUnit, PlannedRow[]>();
  for (const unit of units) {
    const byPrimaryKey = new Map<string, PlannedRow>();
    for (const planned of unit.rows) {
      const key = `${planned.table.name}:${rowKey(planned.row, planned.table.primaryKey)}`;
      const prior = byPrimaryKey.get(key);
      if (!prior) {
        byPrimaryKey.set(key, planned);
      } else if (!rowsEqual(planned.columns, prior.row, planned.row)) {
        addConflict(conflicts, seenConflicts, makeConflict(unit, planned.table,
          rowKey(planned.row, planned.table.primaryKey), "different source rows share one primary key"));
      }
    }
    desiredRows.set(unit, [...byPrimaryKey.values()]);
  }

  // Check primary and explicit unique constraints across every planned account,
  // not just within one account unit (PreInventory.SN and reservation references
  // can collide across users).
  const proposedConstraints = new Map<string, { unit: MigrationUnit; planned: PlannedRow }>();
  for (const unit of units) {
    const target = unit.family.databases[unit.targetShard]!;
    for (const planned of desiredRows.get(unit) ?? []) {
      const rules: UniqueRule[] = [
        { name: "primary-key", columns: planned.table.primaryKey },
        ...(planned.table.unique ?? []),
      ];
      for (const rule of rules) {
        if (rule.applies && !rule.applies(planned.row)) continue;
        const key = rowKey(planned.row, rule.columns);
        const globalKey = [unit.family.spec.name, unit.targetShard, planned.table.name, rule.name, key].join("\u001f");
        const prior = proposedConstraints.get(globalKey);
        if (prior && !rowsEqual(planned.columns, prior.planned.row, planned.row)) {
          addConflict(conflicts, seenConflicts, makeConflict(unit, planned.table, key,
            `planned rows collide on ${rule.name}`));
        } else if (!prior) {
          proposedConstraints.set(globalKey, { unit, planned });
        }

        if (rule.name !== "primary-key") {
          const existing = selectByColumns(target, planned.table.name, rule.columns, planned.row)
            .find(row => !rule.applies || rule.applies(row));
          if (existing && !rowsEqual(planned.columns, existing, planned.row)) {
            addConflict(conflicts, seenConflicts, makeConflict(unit, planned.table, key,
              `target row collides on ${rule.name}`));
          }
        }
      }

      const existingPrimary = selectByColumns(
        target,
        planned.table.name,
        planned.table.primaryKey,
        planned.row,
      )[0];
      if (!existingPrimary) unit.inserts.push(planned);
      else if (!rowsEqual(planned.columns, existingPrimary, planned.row)) {
        addConflict(conflicts, seenConflicts, makeConflict(unit, planned.table,
          rowKey(planned.row, planned.table.primaryKey), "target primary-key row has different data"));
      }
    }
  }

  conflicts.sort((left, right) => left.family.localeCompare(right.family)
    || left.targetShard - right.targetShard
    || left.accountHex.localeCompare(right.accountHex)
    || left.table.localeCompare(right.table)
    || left.key.localeCompare(right.key));

  return {
    units,
    conflicts,
    scannedRows,
    misplacedRows,
    misplacedAccounts: misplacedAccountKeys.size,
    legacyFormulaAccounts: legacyAccountKeys.size,
    destinationCopies: units.reduce((total, unit) => total + unit.inserts.length, 0),
    sourceDeletes: units.reduce((total, unit) => total + unit.rows.length, 0),
  };
}

function reportFromPlan(
  mode: "inspect" | "migrate",
  plan: BuildPlan,
  status: UserShardMigrationReport["status"],
  backupDirectory?: string,
  verifiedClean = false,
): UserShardMigrationReport {
  return {
    mode,
    status,
    formula: USER_SHARD_FORMULA,
    legacyFormula: LEGACY_PORT_USER_SHARD_FORMULA,
    scannedRows: plan.scannedRows,
    misplacedAccounts: plan.misplacedAccounts,
    legacyFormulaAccounts: plan.legacyFormulaAccounts,
    misplacedRows: plan.misplacedRows,
    destinationCopies: plan.destinationCopies,
    sourceDeletes: plan.sourceDeletes,
    conflicts: plan.conflicts,
    ...(backupDirectory ? { backupDirectory } : {}),
    verifiedClean,
  };
}

function dataVersion(db: Database): bigint {
  return Object.values(db.query<Record<string, bigint>, []>("PRAGMA data_version").get() ?? {})[0] ?? -1n;
}

function captureDataVersions(families: readonly OpenFamily[]): Map<Database, bigint> {
  const versions = new Map<Database, bigint>();
  for (const family of families) for (const db of family.databases) versions.set(db, dataVersion(db));
  return versions;
}

function assertDataVersions(versions: ReadonlyMap<Database, bigint>): void {
  for (const [db, expected] of versions) {
    if (dataVersion(db) !== expected) {
      throw new Error("A shard changed after inspection. Stop every service and run inspect/migrate again.");
    }
  }
}

function assertNoCurrentWriter(families: readonly OpenFamily[]): void {
  for (const family of families) {
    for (const db of family.databases) {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
    }
  }
}

function writeDurable(path: string, data: string | Uint8Array): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number;
  try { descriptor = openSync(path, "r"); }
  catch (error) {
    // Windows does not expose directory handles through node:fs openSync.
    if (process.platform === "win32") return;
    throw error;
  }
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function createBackup(
  dbDirectory: string,
  backupDirectory: string,
  families: readonly OpenFamily[],
): string {
  const destination = resolve(backupDirectory);
  if (existsSync(destination)) throw new Error(`Backup destination already exists: ${destination}`);
  mkdirSync(destination);
  try {
    const files: { name: string; bytes: number; sha256: string }[] = [];
    for (const family of families) {
      for (let shard = 0; shard < family.databases.length; shard++) {
        const name = shardFileName(family.spec.filePrefix, shard);
        const image = family.databases[shard]!.serialize();
        writeDurable(join(destination, name), image);
        const backup = new Database(join(destination, name), { readonly: true, create: false });
        try { quickCheck(backup, join(destination, name)); }
        finally { backup.close(); }
        files.push({
          name,
          bytes: image.byteLength,
          sha256: createHash("sha256").update(image).digest("hex"),
        });
      }
    }
    const manifest: BackupManifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      sourceDirectory: resolve(dbDirectory),
      formulaBefore: LEGACY_PORT_USER_SHARD_FORMULA,
      formulaAfter: USER_SHARD_FORMULA,
      files,
    };
    writeDurable(join(destination, BACKUP_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    fsyncDirectory(destination);
    fsyncDirectory(dirname(destination));
    return destination;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function insertRow(db: Database, planned: PlannedRow): void {
  const columns = planned.columns.map(quoteIdentifier).join(",");
  const values = planned.columns.map(() => "?").join(",");
  const bindings = planned.columns.map(column => planned.row[column] ?? null) as SQLQueryBindings[];
  const result = db.query<never, SQLQueryBindings[]>(
    `INSERT INTO ${quoteIdentifier(planned.table.name)} (${columns}) VALUES (${values})`,
  ).run(...bindings);
  if (result.changes !== 1) throw new Error(`Failed to copy ${planned.table.name} row.`);
}

function deleteExactRow(db: Database, planned: PlannedRow): void {
  const where = planned.columns.map(column => `${quoteIdentifier(column)} IS ?`).join(" AND ");
  const bindings = planned.columns.map(column => planned.row[column] ?? null) as SQLQueryBindings[];
  const result = db.query<never, SQLQueryBindings[]>(
    `DELETE FROM ${quoteIdentifier(planned.table.name)} WHERE ${where}`,
  ).run(...bindings);
  if (result.changes !== 1) {
    throw new Error(`Source ${planned.table.name} row changed; its copied target was retained for safe recovery.`);
  }
}

function applyUnit(unit: MigrationUnit): void {
  const target = unit.family.databases[unit.targetShard]!;
  target.transaction(() => {
    for (const planned of unit.inserts) insertRow(target, planned);
    const verified = new Set<string>();
    for (const planned of unit.rows) {
      const key = `${planned.table.name}:${rowKey(planned.row, planned.table.primaryKey)}`;
      if (verified.has(key)) continue;
      verified.add(key);
      const copied = selectByColumns(
        target,
        planned.table.name,
        planned.table.primaryKey,
        planned.row,
      )[0];
      if (!copied || !rowsEqual(planned.columns, copied, planned.row)) {
        throw new Error(`Target ${planned.table.name} row did not preserve the exact source data.`);
      }
    }
  }).immediate();

  const rowsBySource = new Map<number, PlannedRow[]>();
  for (const planned of unit.rows) {
    const rows = rowsBySource.get(planned.sourceShard) ?? [];
    rows.push(planned);
    rowsBySource.set(planned.sourceShard, rows);
  }
  for (const [sourceShard, rows] of [...rowsBySource].toSorted(([left], [right]) => left - right)) {
    const source = unit.family.databases[sourceShard]!;
    source.transaction(() => {
      for (const planned of rows) deleteExactRow(source, planned);
    }).immediate();
  }
}

interface MigrationLock {
  readonly token: string;
  release(): void;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireMigrationLock(dbDirectory: string): MigrationLock {
  const path = join(dbDirectory, MIGRATION_LOCK_FILE);
  const token = randomUUID();
  const body = `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeDurable(path, body);
      return {
        token,
        release() {
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
            if (current.token === token) unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let prior: { pid?: number };
      try { prior = JSON.parse(readFileSync(path, "utf8")) as { pid?: number }; }
      catch { throw new Error(`Migration lock is unreadable: ${path}`); }
      if (processIsAlive(prior.pid ?? 0)) {
        throw new Error(`Another shard migration is active (PID ${prior.pid}).`);
      }
      unlinkSync(path);
    }
  }
  throw new Error("Could not acquire the shard migration lock.");
}

/** Read-only audit. It never creates databases, tables, backups, or locks. */
export function inspectUserShardLayout(dbDirectory: string): UserShardMigrationReport {
  const directory = resolve(dbDirectory);
  const families = openFamilies(directory, false);
  try {
    const plan = buildPlan(families);
    const status = plan.conflicts.length !== 0 ? "conflict" : plan.misplacedRows === 0 ? "clean" : "ready";
    return reportFromPlan("inspect", plan, status, undefined, status === "clean");
  } finally {
    closeFamilies(families);
  }
}

/**
 * Offline, copy-before-delete migration. Every known conflict is found before
 * the backup or first write. A crash after a destination commit can leave an
 * exact duplicate, never a delete-without-copy; the next run recognizes that
 * duplicate and finishes the source cleanup.
 */
export function migrateUserShards(dbDirectory: string, backupDirectory: string): UserShardMigrationReport {
  const directory = resolve(dbDirectory);
  const lock = acquireMigrationLock(directory);
  let families: OpenFamily[] = [];
  try {
    families = openFamilies(directory, true);
    const versions = captureDataVersions(families);
    const plan = buildPlan(families);
    if (plan.conflicts.length !== 0) return reportFromPlan("migrate", plan, "conflict");
    if (plan.misplacedRows === 0) return reportFromPlan("migrate", plan, "clean", undefined, true);

    assertNoCurrentWriter(families);
    assertDataVersions(versions);
    const backup = createBackup(directory, backupDirectory, families);
    assertDataVersions(versions);

    for (const unit of plan.units) {
      assertDataVersions(versions);
      applyUnit(unit);
    }
    for (const family of families) {
      for (let shard = 0; shard < family.databases.length; shard++) {
        quickCheck(family.databases[shard]!, family.paths[shard]!);
      }
    }
    const verification = buildPlan(families);
    if (verification.conflicts.length !== 0 || verification.misplacedRows !== 0) {
      throw new Error("Migration committed safely but post-migration verification is not clean; keep services stopped and rerun inspect.");
    }
    return reportFromPlan("migrate", plan, "migrated", backup, true);
  } finally {
    try {
      if (families.length !== 0) closeFamilies(families);
    } finally {
      lock.release();
    }
  }
}
