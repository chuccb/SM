/** Bounded catalog extraction for the shipped SQL Server 2000 backup only.
 * NOT a general RESTORE implementation: no log redo/undo or arbitrary .bak
 * carving. SHA-256 pins the reviewed snapshot. Catalog identities, physical
 * column offsets, clustered leaf chains and sysindexes row counts are checked.
 * ANSI strings are Latin-1 byte carriers, as required by the packet writers.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DecodeCP950 } from "../core/Encoding.ts";

const LOCAL_CAITEM_BAK_PATH = join(import.meta.dir, "../../data/db/CAItem.bak");
const REPO_CAITEM_BAK_PATH = join(import.meta.dir, "../../../DB/CAItem.bak");

export const CAITEM_BAK_PATH = existsSync(LOCAL_CAITEM_BAK_PATH)
  ? LOCAL_CAITEM_BAK_PATH
  : REPO_CAITEM_BAK_PATH;
export const CAITEM_BAK_SHA256 = "28eb28c71bc6ccde2f01c0c7d4b98242a526453a95b1fe2f3362a15b59b10420";
export const CAITEM_TABLES = ["FxItem", "FxStock", "FxString", "FxPackageMap", "FxCouponMap", "FxBonusMap"] as const;
export type CAItemTable = typeof CAITEM_TABLES[number];
export type CatalogRow = Record<string, string | number | null>;
export interface CAItemCatalog {
  sha256: string;
  tables: Record<CAItemTable, CatalogRow[]>;
  sourceRows: Record<CAItemTable, number>;
  duplicateStrings: number;
}
// User-selected FILE=1: FILE=2 changes 1452 prices to 1; never mix the sets.
export const CAITEM_BACKUP_SET = 1;
const SET_START = 0x600, SET_END = 0x2a7200;
const PAGE_SIZE = 8192, SECTOR_SIZE = 512, PAGE_HEADER_SIZE = 96;
const SOURCE = {
  FxItem: { object: 686625489, rows: 1103, columns: 7, fixed: 21 },
  FxStock: { object: 734625660, rows: 1453, columns: 22, fixed: 68 },
  FxString: { object: 766625774, rows: 189, columns: 2, fixed: 8 },
  FxPackageMap: { object: 718625603, rows: 988, columns: 5, fixed: 28 },
  FxCouponMap: { object: 622625261, rows: 0, columns: 6, fixed: 0 },
  FxBonusMap: { object: 654625375, rows: 0, columns: 3, fixed: 0 },
} as const;
function requireFormat(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`CAItem.bak: ${message}`);
}
interface Page { data: Buffer; id: number; object: number; type: number }
interface Row { data: Buffer; fixed: number; columns: number; nulls: Buffer; variables: Buffer[] }

/** SQL 2000 torn-page protection replaces the low two bits of each sector
 * trailer (sectors 1..15). Restore them BEFORE reading the row slot array;
 * the last slot's high byte is itself protected. Sector 0 holds the signature.
 */
function unprotectPage(raw: Buffer): Buffer {
  const data = Buffer.from(raw);
  if (data.readUInt16LE(4) & 0x100) {
    const saved = data.readUInt32LE(60), signature = saved & 3;
    for (let sector = 1; sector < PAGE_SIZE / SECTOR_SIZE; sector++) {
      const end = (sector + 1) * SECTOR_SIZE - 1;
      requireFormat((data[end] & 3) === signature, "torn sector signature mismatch");
      data[end] = (data[end] & 0xfc) | ((saved >>> (sector * 2)) & 3);
    }
  }
  return data;
}
function readPages(bytes: Buffer): Map<number, Page> {
  const rawPages = new Map<number, Buffer>();
  requireFormat(bytes.toString("ascii", SET_START, SET_START + 4) === "SSET" &&
    bytes.toString("ascii", SET_END, SET_END + 4) === "SSET", "backup set boundaries");
  // Both backup sets reuse page IDs. Read only FILE=1, including its own
  // catalog/index pages, rather than deduplicating or mixing snapshots.
  for (let off = SET_START; off + PAGE_SIZE <= SET_END; off += SECTOR_SIZE) {
    if (bytes[off] !== 1 || ![1, 2, 3, 8, 9, 10, 11, 15, 16, 17].includes(bytes[off + 1])) continue;
    if (bytes.readUInt16LE(off + 36) !== 1 || bytes.readUInt32LE(off + 32) > 2000) continue;
    const free = bytes.readUInt16LE(off + 30), slots = bytes.readUInt16LE(off + 22);
    if (free < PAGE_HEADER_SIZE || free > PAGE_SIZE || slots > 1000) continue;
    const id = bytes.readUInt32LE(off + 32), raw = bytes.subarray(off, off + PAGE_SIZE);
    const prior = rawPages.get(id);
    requireFormat(!prior || prior.equals(raw), `conflicting page ${id}`);
    rawPages.set(id, raw);
  }
  requireFormat(rawPages.size === 305, "unexpected data-page inventory");
  return new Map([...rawPages].map(([id, raw]) => {
    const data = unprotectPage(raw);
    return [id, { data, id, object: data.readUInt32LE(24), type: data[1] }];
  }));
}
function pageRows(page: Page): Row[] {
  const p = page.data, free = p.readUInt16LE(30), count = p.readUInt16LE(22);
  const out: Row[] = [], seen = new Set<number>();
  for (let slot = 0; slot < count; slot++) {
    const off = p.readUInt16LE(PAGE_SIZE - 2 * (slot + 1));
    requireFormat(off >= PAGE_HEADER_SIZE && off + 4 <= free && !seen.has(off), `invalid slot on page ${page.id}`);
    seen.add(off);
    const r = p.subarray(off, free), fixed = r.readUInt16LE(2);
    requireFormat((r[0] === 0x10 || r[0] === 0x30) && fixed >= 4 && fixed + 2 <= r.length, "unsupported row format");
    const columns = r.readUInt16LE(fixed), nullEnd = fixed + 2 + Math.ceil(columns / 8);
    requireFormat(columns > 0 && columns < 100 && nullEnd <= r.length, "invalid null bitmap");
    const variables: Buffer[] = [];
    let end = nullEnd;
    if (r[0] & 0x20) {
      requireFormat(end + 2 <= r.length, "truncated variable count");
      const n = r.readUInt16LE(end);
      let start = end + 2 + n * 2;
      requireFormat(n <= columns && start <= r.length, "invalid variable directory");
      for (let i = 0; i < n; i++) {
        // High bit denotes a complex field in system tables (e.g. stats LOB).
        // Only bounded in-row fields are consumed for the selected catalog.
        const next = r.readUInt16LE(end + 2 + i * 2) & 0x7fff;
        requireFormat(next >= start && next <= r.length, "invalid variable offset");
        variables.push(r.subarray(start, next)); start = next;
      }
      end = start;
    }
    out.push({ data: r.subarray(0, end), fixed, columns, nulls: r.subarray(fixed + 2, nullEnd), variables });
  }
  return out;
}
interface Column { name: string; id: number; type: number; offset: number }
function readValue(row: Row, col: Column): string | number | null {
  if (row.nulls[(col.id - 1) >> 3] & (1 << ((col.id - 1) & 7))) return null;
  if (col.type === 167) {
    const value = row.variables[-col.offset - 1];
    requireFormat(col.offset < 0 && value !== undefined, `missing varchar ${col.name}`);
    return DecodeCP950(value);
  }
  const size = col.type === 48 ? 1 : col.type === 56 ? 4 : col.type === 61 ? 8 : 0;
  requireFormat(size > 0 && col.offset >= 4 && col.offset + size <= row.fixed, `invalid fixed column ${col.name}`);
  if (col.type === 48) return row.data[col.offset];
  if (col.type === 56) return row.data.readInt32LE(col.offset);
  // SQL 2000 on-page datetime: time ticks first, signed days second.
  const ticks = row.data.readUInt32LE(col.offset), days = row.data.readInt32LE(col.offset + 4);
  requireFormat(ticks < 86400 * 300, "invalid SQL datetime");
  // SQL datetime is an unzoned wall clock. Do not label the old site's time UTC.
  return new Date(Date.UTC(1900, 0, 1) + days * 86400_000 + Math.round(ticks * 1000 / 300)).toISOString().slice(0, -1);
}

export function ParseCAItemBak(input: Uint8Array): CAItemCatalog {
  const bytes = Buffer.from(input), sha256 = createHash("sha256").update(bytes).digest("hex");
  requireFormat(sha256 === CAITEM_BAK_SHA256, "unreviewed backup checksum; refusing speculative recovery");
  const pages = readPages(bytes);
  const rowsFor = (object: number) => [...pages.values()].filter(p => p.type === 1 && p.object === object).flatMap(pageRows);
  const objects = rowsFor(1), columns = rowsFor(3), indexes = rowsFor(2);
  const tables = {} as CAItemCatalog["tables"], sourceRows = {} as CAItemCatalog["sourceRows"];
  for (const table of CAITEM_TABLES) {
    const spec = SOURCE[table];
    const object = objects.find(r => r.data.readUInt32LE(4) === spec.object);
    requireFormat(object?.variables[0]?.toString("utf16le") === table && object.data[8] === 0x55, `missing table identity ${table}`);
    const cols: Column[] = columns.filter(r => r.data.readUInt32LE(4) === spec.object).map(r => ({
      name: r.variables[0].toString("utf16le"), id: r.data.readUInt16LE(16), type: r.data[8], offset: r.data.readInt16LE(18),
    })).sort((a, b) => a.id - b.id);
    requireFormat(cols.length === spec.columns && cols.every((c, i) => c.id === i + 1), `column schema ${table}`);
    const index = indexes.find(r => r.data.readUInt32LE(4) === spec.object && r.data.readUInt16LE(18) <= 1);
    requireFormat(!!index && index.data.readUInt32LE(44) === spec.rows, `sysindexes row count ${table}`);
    const dataPages = [...pages.values()].filter(p => p.type === 1 && p.object === spec.object);
    if (index.data.readUInt16LE(18) === 1) {
      // Clustered leaf chain: reject orphan/stale pages, broken links or cycles.
      const visited = new Set<number>(); let id = index.data.readUInt32LE(12), prev = 0;
      while (id !== 0) {
        const page = pages.get(id);
        requireFormat(!!page && page.type === 1 && page.object === spec.object && !visited.has(id), `leaf chain ${table}`);
        requireFormat(page.data.readUInt32LE(8) === prev, `previous leaf ${table}`);
        visited.add(id); prev = id; id = page.data.readUInt32LE(16);
      }
      requireFormat(visited.size === dataPages.length, `unlinked data pages ${table}`);
    }
    const rows = dataPages.flatMap(pageRows);
    requireFormat(rows.length === spec.rows, `missing/extra rows ${table}`);
    tables[table] = rows.map(row => {
      requireFormat(row.fixed === spec.fixed && row.columns === spec.columns, `row schema ${table}`);
      return Object.fromEntries(cols.map(col => [col.name, readValue(row, col)]));
    });
    sourceRows[table] = rows.length;
  }
  // FxString is a heap with 77 identical duplicate keys. Native insert_unique
  // emits one string per SN. Only identical duplicates may be collapsed.
  const strings = new Map<number, CatalogRow>();
  for (const row of tables.FxString) {
    const sn = row.SN as number, prior = strings.get(sn);
    requireFormat(!prior || prior.String === row.String, `conflicting FxString ${sn}`);
    strings.set(sn, row);
  }
  const duplicateStrings = tables.FxString.length - strings.size;
  tables.FxString = [...strings.values()];
  for (const table of ["FxItem", "FxStock", "FxString"] as const) {
    requireFormat(new Set(tables[table].map(r => r.SN)).size === tables[table].length, `duplicate ${table} SN`);
    tables[table].sort((a, b) => Number(a.SN) - Number(b.SN));
  }
  return { sha256, tables, sourceRows, duplicateStrings };
}
export function LoadCAItemBak(path = CAITEM_BAK_PATH): CAItemCatalog { return ParseCAItemBak(readFileSync(path)); }
