/** Original CAItem catalog bootstrap. Only CAItem.db is ever opened here;
 * no account, inventory, billing, guild or CAConfig data is restored. */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CAITEM_BACKUP_SET, CAITEM_TABLES, LoadCAItemBak, type CAItemCatalog } from "./CAItemBak.ts";
import { SCHEMA_ITEM } from "./CAItemSchema.ts";

const STAMP_SCHEMA = `CREATE TABLE IF NOT EXISTS CAItemImport (
  ID INTEGER PRIMARY KEY CHECK(ID=1), SHA256 TEXT NOT NULL, BackupSet INTEGER NOT NULL,
  SourceRows TEXT NOT NULL, ImportedAt TEXT NOT NULL DEFAULT (datetime('now')));`;
export type ImportResult = { status: "imported" | "already-imported" | "existing-catalog"; rows: Record<string, number> };
export function CatalogCounts(db: Database): Record<string, number> {
  return Object.fromEntries(CAITEM_TABLES.map(table => [table,
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()!.n]));
}
function upgradeEmptySchema(db: Database): void {
  for (const [table, name, definition] of [
    ["FxStock", "ExItemSN", "INTEGER NOT NULL DEFAULT 0"],
    ["FxPackageMap", "DateCreated", "TEXT"], ["FxCouponMap", "DateCreated", "TEXT"],
    ["FxBonusMap", "GameDomain", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().some(c => c.name === name))
      db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
  }
  // Older port schema incorrectly declared Usage as INTEGER. This migration
  // runs only on a wholly empty catalog, inside the import transaction.
  const usage = db.query<{ name: string; type: string }, []>('PRAGMA table_info("FxStock")').all().find(c => c.name === "Usage");
  if (usage?.type.toUpperCase() !== "TEXT") {
    db.exec('ALTER TABLE FxStock DROP COLUMN Usage; ALTER TABLE FxStock ADD COLUMN Usage TEXT NOT NULL DEFAULT \'\';');
  }
}

/** The second emptiness check is under BEGIN IMMEDIATE, so simultaneous
 * standalone Shop/GS startup cannot partially seed or duplicate package rows.
 * Existing operator catalogs (even incomplete ones) always win. */
export function EnsureCAItemCatalog(dbDir: string, sourcePath?: string): ImportResult {
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(join(dbDir, "CAItem.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    db.exec(SCHEMA_ITEM); db.exec(STAMP_SCHEMA);
    const existing = (): ImportResult | null => {
      const rows = CatalogCounts(db);
      if (db.query("SELECT 1 FROM CAItemImport WHERE ID=1").get()) return { status: "already-imported", rows };
      if (Object.values(rows).some(n => n > 0)) return { status: "existing-catalog", rows };
      return null;
    };
    const prior = existing(); if (prior) return prior;
    const catalog = LoadCAItemBak(sourcePath); // fully validate before acquiring writer lock
    return db.transaction((): ImportResult => {
      const raced = existing(); if (raced) return raced;
      upgradeEmptySchema(db);
      for (const table of CAITEM_TABLES) {
        const rows = catalog.tables[table]; if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        // Column names come from the pinned, verified source catalog only.
        const sql = db.query(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
        for (const row of rows) sql.run(...columns.map(c => row[c]));
      }
      db.query("INSERT INTO CAItemImport(ID,SHA256,BackupSet,SourceRows) VALUES(1,?,?,?)")
        .run(catalog.sha256, CAITEM_BACKUP_SET, JSON.stringify(catalog.sourceRows));
      return { status: "imported", rows: CatalogCounts(db) };
    }).immediate();
  } finally { db.close(); }
}

/** Report defects in the ORIGINAL data, rather than inventing missing rows,
 * enabling off-sale products, or pretending server files contain client art. */
export function AuditCAItem(catalog: CAItemCatalog) {
  const stocks = new Map(catalog.tables.FxStock.map(r => [r.SN, r]));
  const items = new Set(catalog.tables.FxItem.map(r => r.SN));
  const strings = new Set(catalog.tables.FxString.map(r => r.SN));
  const active = catalog.tables.FxStock.filter(r => Number(r.IsValid) > 0);
  const missingStrings = catalog.tables.FxStock.flatMap(r => ["StringDesc", "StringUsage"]
    .filter(k => r[k] !== 0 && !strings.has(r[k])).map(k => ({ stock: r.SN, active: r.IsValid, column: k, string: r[k] })));
  return {
    sha256: catalog.sha256, backupSet: CAITEM_BACKUP_SET, sourceRows: catalog.sourceRows,
    effectiveRows: Object.fromEntries(CAITEM_TABLES.map(t => [t, catalog.tables[t].length])),
    activeStocks: active.length, identicalStringDuplicates: catalog.duplicateStrings,
    missingItemStocks: catalog.tables.FxStock.filter(r => !items.has(r.ItemSN)).map(r => r.SN),
    missingStrings,
    orphanPackageRows: catalog.tables.FxPackageMap.filter(r => !stocks.has(r.PackageSN) || !stocks.has(r.StockSN)),
    activePackageOffSaleChildren: catalog.tables.FxPackageMap.filter(r => Number(stocks.get(r.PackageSN)?.IsValid) > 0 &&
      Number(stocks.get(r.StockSN)?.IsValid ?? 0) <= 0).map(r => ({ package: r.PackageSN, stock: r.StockSN })),
    sampleProducts: active.filter(r => r.Category === 1).slice(0, 5).map(r => ({
      SN: r.SN, NameBig5: new TextDecoder("big5").decode(Buffer.from(r.Name as string, "latin1")),
      ItemSN: r.ItemSN, Unit: r.Unit, Price: r.Price, FixedPrice: r.FixedPrice, MoneyType: r.MoneyType,
    })),
    clientAssetReferences: [...new Set(active.map(r => r.DataFile))].sort(),
  };
}
