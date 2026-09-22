import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CIDFMan } from "../src/FXGS/IDFMan.ts";
import { CItemAttr } from "../src/FXGS/ItemAttr.ts";
import { inflateSync } from "node:zlib";
import { LoadCAItemBak, ParseCAItemBak, CAITEM_BAK_PATH, CAITEM_BAK_SHA256, CAITEM_TABLES } from "../src/db/CAItemBak.ts";
import { EnsureCAItemCatalog, AuditCAItem, CatalogCounts } from "../src/db/CAItemImport.ts";
import { SCHEMA_ITEM } from "../src/db/CAItemSchema.ts";
import { CDBMan } from "../src/db/DBMan.ts";
import { CItemMan } from "../src/FXSS/ItemMan.ts";
import { CUserItemMan } from "../src/FXGS/ItemMan.ts";
import { CSendPacket } from "../src/core/Packet.ts";
import { DecodeCP950 } from "../src/core/Encoding.ts";

const source = LoadCAItemBak();
const dirs: string[] = [];
function directory() { const d = mkdtempSync(join(tmpdir(), "sm-caitem-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const expected = { FxItem: 1103, FxStock: 1453, FxString: 112, FxPackageMap: 988, FxCouponMap: 0, FxBonusMap: 0 };

test("original backup FILE=1 agrees with sysobjects/syscolumns/sysindexes and native reader column sets", () => {
  expect(source.sha256).toBe(CAITEM_BAK_SHA256);
  // Independent Python page/schema extraction, normalized SQL datetime and
  // byte-identical string deduplication; pin all decoded values, not just counts.
  const canonical = CAITEM_TABLES.map(t => [t, source.tables[t]
    .map(r => Object.fromEntries(Object.keys(r).sort().map(k => [k, r[k]])))
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)]);
  expect(createHash("sha256").update(JSON.stringify(canonical)).digest("hex"))
    .toBe("71a0248f1a07e2bb86b8eb0cb80bf79a901a4fc3332c309fd084e4e9d2ac216c");
  expect(source.sourceRows).toEqual({ ...expected, FxString: 189 });
  expect(source.duplicateStrings).toBe(77);
  const row = source.tables.FxStock.find(r => r.SN === 1102)!;
  expect([row.ItemSN, row.Unit, row.Price, row.FixedPrice, row.MoneyType, row.IsValid]).toEqual([1, 15, 29, 29, 0, 1]);
  expect(row.DateCreated).toBe("2002-01-01T00:00:00.000");
  expect(row.Name).toBe("針 (15個)");
  expect(source.tables.FxItem.find(r => r.SN === 20122)?.strName).toBe("耶誕節可愛毛帽");
  expect(source.tables.FxPackageMap[0].DateCreated).toBe("2003-12-16T16:02:48.640");
});
test("all source records and UTF-8 strings survive; no old table, second backup or duplicate page is mixed in", () => {
  for (const table of CAITEM_TABLES) {
    expect(source.tables[table]).toHaveLength(expected[table]);
  }
  const audit = AuditCAItem(source);
  expect(audit.activeStocks).toBe(549); expect(audit.missingItemStocks).toEqual([]);
  expect(audit.missingStrings).toEqual([
    { stock: 6203, active: 0, column: "StringUsage", string: 204 },
    { stock: 6205, active: 0, column: "StringUsage", string: 207 },
  ]);
  expect(audit.orphanPackageRows).toHaveLength(21);
  expect([...new Set(audit.orphanPackageRows.map(r => r.PackageSN))]).toEqual([4024, 4025, 4026, 4027, 4028, 4029, 4030]);
});
test("truncated, changed and unreviewed backups fail closed before database import", () => {
  const bytes = readFileSync(CAITEM_BAK_PATH);
  expect(() => ParseCAItemBak(bytes.subarray(0, bytes.length - 1))).toThrow("checksum");
  bytes[1202784] ^= 1; expect(() => ParseCAItemBak(bytes)).toThrow("checksum");
  const dir = directory(), path = join(dir, "broken.bak"); writeFileSync(path, bytes);
  expect(() => EnsureCAItemCatalog(dir, path)).toThrow("checksum");
  const db = new Database(join(dir, "CAItem.db"));
  try { expect(Object.values(CatalogCounts(db)).every(n => n === 0)).toBe(true); expect(db.query("SELECT * FROM CAItemImport").all()).toEqual([]); }
  finally { db.close(); }
});
test("atomic import is idempotent, preserves every source column and touches only CAItem.db", () => {
  const dir = directory();
  expect(EnsureCAItemCatalog(dir)).toEqual({ status: "imported", rows: expected });
  expect(EnsureCAItemCatalog(dir).status).toBe("already-imported");
  expect(readdirSync(dir).filter(f => !f.endsWith("-wal") && !f.endsWith("-shm"))).toEqual(["CAItem.db"]);
  const db = new Database(join(dir, "CAItem.db"));
  try {
    for (const table of CAITEM_TABLES) {
      for (const row of source.tables[table]) {
        const columns = Object.keys(row);
        const where = columns.map(c => `"${c}" IS ?`).join(" AND ");
        expect(db.query(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(...columns.map(c => row[c]))).toEqual({ n: 1 });
      }
    }
    expect(db.query("SELECT SHA256,BackupSet FROM CAItemImport").get()).toEqual({ SHA256: CAITEM_BAK_SHA256, BackupSet: 1 });
    expect(db.query("SELECT typeof(Usage) AS kind FROM FxStock WHERE SN=1102").get()).toEqual({ kind: "text" });
  } finally { db.close(); }
});
test("custom/partial catalogs are never merged, overwritten, or silently made buyable", () => {
  const dir = directory(), db = new Database(join(dir, "CAItem.db")); db.exec(SCHEMA_ITEM);
  db.exec("INSERT INTO FxItem(SN,strName) VALUES(999,'operator-owned')");
  try {
    expect(EnsureCAItemCatalog(dir).status).toBe("existing-catalog");
    expect(db.query("SELECT SN,strName FROM FxItem").all()).toEqual([{ SN: 999, strName: "operator-owned" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM FxStock").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
test("a completed import marker prevents later intentional emptying or price edits from being undone", () => {
  const dir = directory(); EnsureCAItemCatalog(dir);
  const db = new Database(join(dir, "CAItem.db"));
  try {
    db.exec("UPDATE FxStock SET Price=789 WHERE SN=1102"); EnsureCAItemCatalog(dir);
    expect(db.query("SELECT Price FROM FxStock WHERE SN=1102").get()).toEqual({ Price: 789 });
    for (const t of CAITEM_TABLES) db.exec(`DELETE FROM ${t}`);
    expect(EnsureCAItemCatalog(dir)).toEqual({ status: "already-imported", rows: Object.fromEntries(CAITEM_TABLES.map(t => [t, 0])) });
  } finally { db.close(); }
});
test("legacy empty schema upgrades in the same import, including varchar Usage and original extra columns", () => {
  const dir = directory(), db = new Database(join(dir, "CAItem.db"));
  db.exec(SCHEMA_ITEM.replace("Usage          TEXT NOT NULL DEFAULT ''", "Usage          INTEGER NOT NULL DEFAULT 0"));
  db.exec("ALTER TABLE FxStock DROP COLUMN ExItemSN; ALTER TABLE FxPackageMap DROP COLUMN DateCreated;");
  try {
    expect(EnsureCAItemCatalog(dir).status).toBe("imported");
    expect(db.query("SELECT ExItemSN,typeof(Usage) AS kind FROM FxStock WHERE SN=1102").get()).toEqual({ ExItemSN: 0, kind: "text" });
    expect(db.query("SELECT DateCreated FROM FxPackageMap LIMIT 1").get()).toEqual({ DateCreated: "2003-12-16T16:02:48.640" });
  } finally { db.close(); }
});
test("late table failure rolls back earlier item, stock and string writes, allowing a clean retry", () => {
  const dir = directory(), db = new Database(join(dir, "CAItem.db")); db.exec(SCHEMA_ITEM);
  db.exec("CREATE TRIGGER fail_package BEFORE INSERT ON FxPackageMap BEGIN SELECT RAISE(ABORT, 'injected'); END");
  try {
    expect(() => EnsureCAItemCatalog(dir)).toThrow("injected");
    expect(Object.values(CatalogCounts(db)).every(n => n === 0)).toBe(true);
    expect(db.query("SELECT * FROM CAItemImport").all()).toEqual([]);
    db.exec("DROP TRIGGER fail_package"); expect(EnsureCAItemCatalog(dir).status).toBe("imported");
  } finally { db.close(); }
});

/** Independent reader for the actual wire cache, not a producer/consumer
 * round trip through COSmartStream/CISmartStream's shared assumptions. */
function cacheBody(packet: CSendPacket): Buffer {
  const b = Buffer.from(packet.m_pBlock.subarray(0, packet.m_uOffset));
  expect((b.readUInt32BE(1) ^ 0x96ca5395) >>> 0).toBe(b.length - 5); expect(b[5]).toBe(0x18);
  expect(b.readUInt32LE(6)).toBe(b.length - 10);
  const raw = b[10] === 1 ? inflateSync(b.subarray(15)) : b.subarray(11);
  if (b[10] === 1) expect(b.readUInt32LE(11)).toBe(raw.length);
  return raw;
}
test("Shop compressed caches contain every active product/string/package, with native field widths and raw names", () => {
  const dir = directory(); EnsureCAItemCatalog(dir); const db = new CDBMan(dir);
  try {
    const shop = new CItemMan(); expect(shop.Init(db)).toBe(1);
    let data = cacheBody(shop.m_pShopItemListPacket!);
    let off = 0;
    const u8 = () => data[off++];
    const u16 = () => { const n = data.readUInt16LE(off); off += 2; return n; };
    const u32 = () => { const n = data.readUInt32LE(off); off += 4; return n; };
    const str = () => { const n = u32(), value = DecodeCP950(data.subarray(off, off + n)); off += n; return value; };
    expect(u16()).toBe(549);
    for (const row of source.tables.FxStock.filter(r => Number(r.IsValid) > 0)) {
      const actual: (number | string | null)[] = [u32(), u8(), str(), u16(), u16(), u32(), u32(), str(), u32(), u32(), u16(), u16(), u16(), u16(), u32(), u8(), u8()];
      expect(actual).toEqual([row.SN, row.Category, row.Name, row.StringDesc, row.StringUsage, row.ItemSN, row.Unit, row.DataFile,
          row.Price, row.FixedPrice, row.LimitLevel, row.LimitEx, row.ValidityPeriod, row.ValidityLevel,
          Number(row.Zorder) >>> 0, row.CardNo, row.MoneyType]);
    }
    expect(off).toBe(data.length);
    data = cacheBody(shop.m_pStringTablePacket!); off = 0;
    expect(u16()).toBe(112);
    for (const row of source.tables.FxString) {
      const actual: (number | string | null)[] = [u32(), str()];
      expect(actual).toEqual([row.SN, row.String]);
    }
    expect(off).toBe(data.length);
    data = cacheBody(shop.m_pPackageMapPacket!); off = 0;
    expect(u16()).toBe(988);
    for (const row of source.tables.FxPackageMap.toSorted((a, b) => Number(a.PackageSN) - Number(b.PackageSN))) {
      const actual: (number | string | null)[] = [u32(), u32(), u32(), u32()];
      expect(actual).toEqual([row.PackageSN, row.StockSN, row.Units, row.ValidityLevel]);
    }
    expect(off).toBe(data.length);
    expect(shop.m_mapShopItem.has(6203)).toBe(false); // do not activate products to hide source defects
    const gs = new CUserItemMan(); expect(gs.Init(db)).toBe(true);
    expect(gs.m_vtUserItem.size).toBe(1103); expect(gs.m_vtShopItem.size).toBe(1453);
    const p = new CSendPacket(202, 2); gs.PutUserItemList(p);
    expect(p.m_uOffset).toBeLessThan(65535); // entire native client frame must fit
    data = Buffer.from(p.m_pBlock); off = 1;
    const e1 = () => data[off++] ^ 0x5a;
    const e2 = () => { const n = data.readUInt16BE(off) ^ 0xa569; off += 2; return n; };
    const e4 = () => { const n = (data.readUInt32BE(off) ^ 0x96ca5395) >>> 0; off += 4; return n; };
    const estr = () => { const n = e2(), value = DecodeCP950(data.subarray(off, off + n)); off += n; return value; };
    expect(e2()).toBe(1103);
    for (const row of source.tables.FxItem) {
      const actual: (number | string | null)[] = [e4(), e1(), estr(), e4(), e4(), e4(), estr()];
      expect(actual).toEqual([row.SN, row.Category, row.strAttr, Number(row.nAttr1) >>> 0,
        Number(row.nAttr2) >>> 0, Number(row.nAttr3) >>> 0, row.strName]);
    }
    expect(off).toBe(p.m_uOffset);
  } finally { db.Close(); }
});
test("two real startup processes import one catalog without duplicate package rows", async () => {
  const dir = directory();
  const children = [0, 1].map(() => Bun.spawn([process.execPath, join(import.meta.dir, "../tools/caitem.ts"), "import", "--db", dir], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async c => {
    const [code, out, error] = await Promise.all([c.exited, new Response(c.stdout).text(), new Response(c.stderr).text()]);
    expect(code).toBe(0); expect(error).toBe(""); return out;
  }));
  expect(results.filter(r => r.includes('"status": "imported"'))).toHaveLength(1);
  expect(EnsureCAItemCatalog(dir).rows).toEqual(expected);
});

test("CLI inspection is read-only, reports the target, and import rejects mistyped or duplicate flags", async () => {
  const dir = directory(); EnsureCAItemCatalog(dir);
  const path = join(import.meta.dir, "../tools/caitem.ts");
  const inspect = Bun.spawn([process.execPath, path, "inspect", "--db", dir], { stdout: "pipe", stderr: "pipe" });
  const [code, text, error] = await Promise.all([inspect.exited, new Response(inspect.stdout).text(), new Response(inspect.stderr).text()]);
  expect(code).toBe(0); expect(error).toBe("");
  expect(JSON.parse(text).destination.rows).toEqual(expected);
  expect(JSON.parse(text).source.sampleProducts[0]).toMatchObject({ NameBig5: "針 (15個)", Price: 29 });
  for (const flags of [["--db=" + dir], ["--db", dir, "--db", dir], ["--db"]]) {
    const child = Bun.spawn([process.execPath, path, "import", ...flags], { stdout: "pipe", stderr: "pipe" });
    const [exit, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(1); expect(output).toContain("Invalid or duplicate option");
  }
});


test("shipped server IDF entries are bounded and the original needle resolves through CItemAttr", () => {
  const priorIDF = CIDFMan.ms_pInstance, priorAttr = CItemAttr.ms_pInstance;
  try {
    const idf = new CIDFMan(join(import.meta.dir, "../data/FxServer"));
    expect(idf.m_FastFile.GetDataCount()).toBe(256);
    for (const entry of idf.m_FastFile.m_vtEntry) {
      expect(entry.offset + entry.length).toBeLessThanOrEqual(idf.m_FastFile.m_pData!.length);
      expect(idf.m_FastFile.FFReadFileSize(entry.strName)?.buf.length).toBe(entry.length);
    }
    const attr = new CItemAttr(); attr.Load();
    expect(attr.m_vtName).toHaveLength(71);
    const needle = source.tables.FxStock.find(r => r.SN === 1102)!;
    expect(attr.GetItemidx(needle.DataFile as string)).toBe(46);
    // Strip-prefix matching is native: Item/Niddle -> Item/ItemNiddle.
    expect(attr.m_vtName[46]).toBe("Item/ItemNiddle");
  } finally { CIDFMan.ms_pInstance = priorIDF; CItemAttr.ms_pInstance = priorAttr; }
});
