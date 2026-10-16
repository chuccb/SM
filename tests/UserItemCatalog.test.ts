import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import type { UserItem } from "../Common/DB/Rows.ts";
import { CTextCodec, type LegacyEncoding } from "../Common/CTextCodec.ts";
import {
  CopyUserItem,
  DecodeUserItemExport,
  UpgradeLegacyUserItem,
} from "../Common/UserItem.ts";
import { CUserItemMan } from "../FXGS/CUserItemMan.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { RestoreV5CatalogColumnsForFixture } from "./helpers/UserItemCatalog.ts";
import {
  SeedSpecialUser,
  SpecialSubmission,
} from "./helpers/SpecialItemUse.ts";
import { SeedMoneyUser, MoneySubmission } from "./helpers/MoneyPickup.ts";
import { SeedHouseUser, HouseSubmission } from "./helpers/HouseClaim.ts";
import { SeedResultUsers, ResultSubmission } from "./helpers/GameResult.ts";
import vectors from "./fixtures/user-item-catalog-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(text = new CTextCodec()) {
  const s = new CDBSession(":memory:");
  cleanup.push(() => s.Close());
  return { s, db: new CDBMan(s, text) };
}
function path() {
  const dir = mkdtempSync(join(tmpdir(), "sm-user-items-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "test.sqlite");
}
function definition(extra: Partial<UserItem> = {}): UserItem {
  return {
    SN: 1,
    Category: 5,
    strAttr: "Item/Fixture",
    nAttr1: -1,
    nAttr2: 0,
    nAttr3: 2147483647,
    strName: "synthetic definition",
    ...extra,
  };
}
function seed(s: CDBSession, rows: readonly Readonly<UserItem>[]) {
  const q = s.db.query(
    "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES(?,?,?,?,?,?,?)",
  );
  for (const r of rows)
    q.run(r.SN, r.Category, r.strAttr, r.nAttr1, r.nAttr2, r.nAttr3, r.strName);
}
function body(
  m: CUserItemMan,
  text = new CTextCodec(),
  cipher: CipherDegree = CipherDegree.CRC8,
) {
  const p = new CSendPacket(202, cipher, text);
  m.PutUserItemList(p);
  return p.GetBuffer();
}
function fromModel(
  r: (typeof vectors.Cases)[number]["Input"][number],
  text: CTextCodec,
): UserItem {
  return {
    SN: r.SN,
    Category: r.Category,
    strAttr: text.Decode(Buffer.from(r.AttrHex, "hex")),
    nAttr1: r.nAttr1,
    nAttr2: r.nAttr2,
    nAttr3: r.nAttr3,
    strName: text.Decode(Buffer.from(r.NameHex, "hex")),
  };
}
function cli(file: string, doc: unknown, dbfile = path()) {
  writeFileSync(file, JSON.stringify(doc));
  const p = Bun.spawnSync(
    [
      process.execPath,
      "run",
      "Tools/Database.ts",
      "--db",
      dbfile,
      "import-items",
      file,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
    dbfile,
  };
}

test("25 read-only PE anchors and native select bind the SEVEN actual FxItem column names, distinct from resource Type/inventory Verbose/pricing", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(25);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(
    pe.read(vectors.SelectEvidence.VA, vectors.SelectEvidence.Text.length + 1),
  ).toEqual(Buffer.from(vectors.SelectEvidence.Text + "\0"));
  expect(vectors.SelectEvidence.Text).toBe(
    "SN , Category , strAttr , nAttr1, nAttr2 , nAttr3, strName",
  );
});

test("ALL1542 independent C++ catalog images exercise real snapshot/GetUserItem/202 bytes: all256 categories, signed DWORD edges, unsigned sort, empty/multibyte strings, and explicit duplicate hardening", () => {
  expect(vectors.Cases).toHaveLength(1542);
  const { s } = create();
  let paid = 0,
    duplicates = 0;
  for (const c of vectors.Cases) {
    const text = new CTextCodec(c.Encoding as LegacyEncoding),
      db = new CDBMan(s, text),
      input = c.Input.map((r) => fromModel(r, text));
    db.GetUserItemList = () => input;
    if (c.Duplicate) {
      expect(() => new CUserItemMan(db)).toThrow("Duplicate");
      duplicates++;
      continue;
    }
    const man = new CUserItemMan(db);
    expect(man.GetState()).toEqual({ Revision: 1, Count: c.Native.length });
    expect(body(man, text).toString("hex")).toBe(c.BodyHex);
    expect(body(man, text, CipherDegree.None).toString("hex")).toBe(
      c.PlainBodyHex,
    );
    for (const row of c.Native) {
      expect(man.GetUserItem(row.SN)).toEqual(fromModel(row, text));
      expect(Object.isFrozen(man.GetUserItem(row.SN))).toBe(true);
    }
    paid++;
  }
  expect([paid, duplicates]).toEqual([1541, 1]);
});

test("GetUserItem signed int parameter preserves unsigned key bits; no rowid, StockSn, name or arbitrary-number fallback", () => {
  const { db, s } = create();
  const c = vectors.Cases.find((c) => !c.Duplicate && c.Input.length === 5)!;
  seed(
    s,
    c.Native.map((r) => fromModel(r, db.text)),
  );
  const man = new CUserItemMan(db);
  for (const p of vectors.KeyProbes) {
    expect(man.GetUserItem(p.Input)?.SN).toBe(p.Found ? p.Unsigned : undefined);
  }
  for (const n of [NaN, Infinity, -2147483649, 4294967296, 1.5])
    expect(() => man.GetUserItem(n)).toThrow();
});

test("snapshot changes ONLY on explicit trusted reload; returned rows/state are immutable and later SQL/source-array mutations cannot alter an old generation", () => {
  const { s, db } = create();
  seed(s, [definition()]);
  const man = new CUserItemMan(db),
    old = man.GetUserItem(1)!,
    first = body(man);
  expect(() => Object.assign(old, { nAttr1: 77 })).toThrow();
  expect(Object.isFrozen(man.GetState())).toBe(true);
  s.db.exec(
    "UPDATE FxItem SET nAttr1=99,strName='new';INSERT INTO FxItem VALUES(2,6,'other',1,2,3,'other')",
  );
  expect(man.GetUserItem(2)).toBeUndefined();
  expect(body(man)).toEqual(first);
  expect(man.GetUserItem(1)).toBe(old);
  expect(man.UpdateUserItemTable()).toBe(true);
  expect(man.GetState()).toEqual({ Revision: 2, Count: 2 });
  expect(man.GetUserItem(1)!.nAttr1).toBe(99);
  expect(man.GetUserItem(1)).not.toBe(old);
  expect(old.nAttr1).toBe(-1);
  const rows = [definition({ SN: 7 })];
  db.GetUserItemList = () => rows;
  man.UpdateUserItemTable();
  rows[0]!.strName = "mutated";
  rows.push(definition({ SN: 8 }));
  expect(man.GetUserItem(7)!.strName).toBe("synthetic definition");
  expect(man.GetUserItem(8)).toBeUndefined();
});

test("SQL error, late invalid row, duplicate, oversized count and reentrant reload retain the ENTIRE old map/revision; no empty/partial successful catalog", () => {
  const { db } = create();
  db.GetUserItemList = () => [definition()];
  const man = new CUserItemMan(db),
    old = man.GetUserItem(1)!,
    before = body(man);
  const cases: (() => UserItem[])[] = [
    () => {
      throw new Error("SQL unavailable");
    },
    () => [definition({ SN: 2 }), definition({ SN: 3, Category: 256 })],
    () => [definition({ SN: 2 }), definition({ SN: 2 })],
    () => Array<UserItem>(65536).fill(definition()),
    () => {
      man.UpdateUserItemTable();
      return [];
    },
  ];
  for (const source of cases) {
    db.GetUserItemList = source;
    expect(() => man.UpdateUserItemTable()).toThrow();
    expect(man.GetState()).toEqual({ Revision: 1, Count: 1 });
    expect(man.GetUserItem(1)).toBe(old);
    expect(body(man)).toEqual(before);
  }
  db.GetUserItemList = () => [definition({ SN: 7 })];
  man.UpdateUserItemTable();
  expect(man.GetUserItem(1)).toBeUndefined();
  expect(man.GetUserItem(7)).toBeDefined();
});

test("serializer captures ONE immutable generation even when a caller codec triggers a successful reload during a string encode", () => {
  const { db } = create();
  db.GetUserItemList = () => [definition(), definition({ SN: 2 })];
  const man = new CUserItemMan(db),
    before = body(man),
    text = new CTextCodec(),
    encode = text.Encode.bind(text);
  let changed = false;
  text.Encode = (value) => {
    if (!changed) {
      changed = true;
      db.GetUserItemList = () => [definition({ SN: 9 })];
      man.UpdateUserItemTable();
    }
    return encode(value);
  };
  expect(body(man, text)).toEqual(before);
  expect(man.GetState()).toEqual({ Revision: 2, Count: 1 });
  expect(man.GetUserItem(9)).toBeDefined();
  expect(body(man)).not.toEqual(before);
});

test("outgoing catalog append is atomic for wrong codepage, whole-catalog overflow AND caller-prefix overflow; invalid text never replaces prior bytes", () => {
  const { db } = create(new CTextCodec("utf8"));
  db.GetUserItemList = () => [definition({ strName: "🎮" })];
  const man = new CUserItemMan(db),
    p = new CSendPacket(202).Encode1(17),
    before = p.GetBuffer();
  expect(() => man.PutUserItemList(p)).toThrow("representable");
  expect(p.GetBuffer()).toEqual(before);
  db.GetUserItemList = () =>
    Array.from({ length: 20 }, (_, i) =>
      definition({
        SN: i,
        strAttr: "A".repeat(4096),
        strName: "B".repeat(4096),
      }),
    );
  man.UpdateUserItemTable();
  expect(() => man.PutUserItemList(p)).toThrow("too long");
  expect(p.GetBuffer()).toEqual(before);
  db.GetUserItemList = () => [definition()];
  man.UpdateUserItemTable();
  const prefix = new CSendPacket(202).EncodeBuffer(Buffer.alloc(65500)),
    save = prefix.GetBuffer();
  expect(() => man.PutUserItemList(prefix)).toThrow();
  expect(prefix.GetBuffer()).toEqual(save);
});

test("modern row validation normalizes only DWORD spelling, never invents category-specific prices, stock, expiry, template identity or nonempty strAttr", () => {
  const source = definition({
    SN: 0xffffffff,
    Category: 255,
    strAttr: "",
    strName: "",
    nAttr1: 0xffffffff,
    nAttr2: 0x80000000,
  });
  const row = CopyUserItem(source);
  expect(row).toEqual({ ...source, nAttr1: -1, nAttr2: -2147483648 });
  expect(source.nAttr1).toBe(4294967295);
  for (const patch of [
    { SN: -1 },
    { SN: 4294967296 },
    { SN: 0.5 },
    { Category: -1 },
    { Category: 256 },
    { nAttr1: -2147483649 },
    { nAttr2: 4294967296 },
    { nAttr3: NaN },
    { strAttr: "a\0b" },
    { strName: "a\0b" },
    { strAttr: "A".repeat(4097) },
    { strName: "A".repeat(4097) },
    { strName: "🎮" },
  ])
    expect(() => CopyUserItem({ ...source, ...patch })).toThrow();
  for (const value of [undefined, null, [], 7, "row"])
    expect(() => CopyUserItem(value)).toThrow();
});

test("native WORD count truncation is NOT accepted as a modern oversized catalog;65536 rows reject before map insertion", () => {
  for (const c of vectors.CountProbes) {
    const p = new CSendPacket(undefined, CipherDegree.CRC8).Encode2(c.Count);
    expect(p.GetBuffer().toString("hex")).toBe(c.NativeWordHex);
    expect(c.ModernAllowed).toBe(c.Count <= 65535);
  }
  const { db } = create();
  db.GetUserItemList = () => Array<UserItem>(65536).fill(definition());
  expect(() => new CUserItemMan(db)).toThrow("count field");
});

test("version2 import requires exact native-named columns; version1 aliases are explicit and preserve DWORD bits, not a silent best-effort mixed mapping", () => {
  const item = definition({ nAttr2: -1 }),
    legacy = {
      ItemID: 1,
      Type: 5,
      TmplName: "Item/Fixture",
      OpaqueColumn3: -1,
      OpaqueColumn4: 4294967295,
      OpaqueColumn5: 2147483647,
      Verbose: "synthetic definition",
    };
  expect(UpgradeLegacyUserItem(legacy)).toEqual(item);
  expect(
    DecodeUserItemExport({ schemaVersion: 1, kind: "FxItem", rows: [legacy] }),
  ).toEqual([item]);
  expect(
    DecodeUserItemExport({ schemaVersion: 2, kind: "FxItem", rows: [item] }),
  ).toEqual([item]);
  for (const doc of [
    { schemaVersion: 2, kind: "FxItem", rows: [legacy] },
    { schemaVersion: 1, kind: "FxItem", rows: [item] },
    { schemaVersion: 2, kind: "FxItem", rows: [{ ...item, StockSn: 1 }] },
    {
      schemaVersion: 2,
      kind: "FxItem",
      rows: [{ ...item, nAttr1: undefined }],
    },
    { schemaVersion: 2, kind: "FxItem", rows: [item, item] },
    { schemaVersion: 6, kind: "FxItem", rows: [item] },
    { schemaVersion: 2, kind: "ShopItem", rows: [item] },
    { rows: [item] },
  ])
    expect(() => DecodeUserItemExport(doc)).toThrow();
});

test("real CLI native-named version2 imports an atomic signed/unsigned catalog; duplicate existing SN/late invalid/mixed column batches leave no partial data or audit", () => {
  const file = path() + ".json",
    dbfile = path(),
    item = definition();
  cleanup.push(() => rmSync(file, { force: true }));
  const good = cli(
    file,
    { schemaVersion: 2, kind: "FxItem", rows: [item] },
    dbfile,
  );
  expect(good.code).toBe(0);
  expect(good.out).toContain("NOT shop stock/prices");
  for (const rows of [
    [definition({ SN: 2 }), item],
    [definition({ SN: 2 }), definition({ SN: 3, Category: 256 })],
    [definition({ SN: 2 }), { ...definition({ SN: 3 }), Type: 1 }],
  ]) {
    expect(
      cli(file, { schemaVersion: 2, kind: "FxItem", rows }, dbfile).code,
    ).toBe(1);
    const s = new CDBSession(dbfile);
    try {
      expect(new CDBMan(s).GetUserItemList()).toEqual([item]);
      expect(
        s.db
          .query(
            "SELECT count(*) AS n FROM RuntimeAudit WHERE Action='cli:import-FxItem'",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      s.Close();
    }
  }
});

test("late audit SQL failure rolls back all new item definitions, not just the audit record", () => {
  const file = path() + ".json",
    dbfile = path();
  cleanup.push(() => rmSync(file, { force: true }));
  const s = new CDBSession(dbfile);
  s.db.exec(
    "CREATE TRIGGER TestAuditFail BEFORE INSERT ON RuntimeAudit BEGIN SELECT RAISE(FAIL,'fixture-audit');END",
  );
  s.Close();
  expect(
    cli(
      file,
      {
        schemaVersion: 2,
        kind: "FxItem",
        rows: [definition(), definition({ SN: 2 })],
      },
      dbfile,
    ).code,
  ).toBe(1);
  const after = new CDBSession(dbfile);
  try {
    expect(new CDBMan(after).GetUserItemList()).toEqual([]);
  } finally {
    after.Close();
  }
});

const preserved = [
  "FxUserAccount",
  "FxUserDynamic",
  "FxUserInventory",
  "RuntimeGameResult",
  "RuntimeMoneyPickup",
  "RuntimeHouseClaim",
  "RuntimeSpecialItemUse",
  "RuntimeAudit",
];
function snapshot(s: CDBSession) {
  return preserved.map((t) => s.db.query(`SELECT * FROM ${t}`).all());
}
function oldV5(file: string) {
  const s = new CDBSession(file),
    db = new CDBMan(s),
    sp = SpecialSubmission(),
    money = MoneySubmission(),
    house = HouseSubmission(),
    result = ResultSubmission();
  SeedSpecialUser(db, sp);
  expect(db.CommitSpecialItemUse(sp)).toBe("committed");
  SeedMoneyUser(db, money);
  expect(db.CommitMoneyPickup(money)).toBe("committed");
  SeedHouseUser(db, house);
  expect(db.CommitHouseClaim(house)).toBe("committed");
  SeedResultUsers(db, result);
  expect(db.CommitGameResult(result)).toBe("committed");
  seed(s, [definition({ nAttr2: 4294967295 })]);
  const before = snapshot(s);
  RestoreV5CatalogColumnsForFixture(s);
  s.db.exec("PRAGMA user_version=5");
  s.Close();
  return before;
}

test("schema5->6 renames ONLY the seven catalog columns: literal values/202 bits and accounts/inventory/ALL FOUR receipt kinds remain byte-for-byte intact across reopen", () => {
  const file = path(),
    before = oldV5(file),
    s = new CDBSession(file);
  try {
    expect(snapshot(s)).toEqual(before);
    expect(s.db.query("PRAGMA user_version").get()).toEqual({
      user_version: 6,
    });
    expect(
      s.db
        .query(
          "SELECT SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName FROM FxItem",
        )
        .get(),
    ).toEqual(definition({ nAttr2: 4294967295 }));
    expect(new CDBMan(s).GetUserItemList()).toEqual([
      definition({ nAttr2: -1 }),
    ]);
    s.IntegrityCheck();
  } finally {
    s.Close();
  }
  const reopen = new CDBSession(file);
  try {
    expect(snapshot(reopen)).toEqual(before);
  } finally {
    reopen.Close();
  }
});

test("a LATE006 rename collision rolls back the ENTIRE upgrade/version, preserves v5 names/data/receipts, and allows a genuine retry after explicit repair", () => {
  const file = path(),
    before = oldV5(file),
    raw = new Database(file);
  raw.exec("ALTER TABLE FxItem ADD COLUMN nAttr2 INTEGER");
  raw.close();
  expect(() => new CDBSession(file)).toThrow();
  const verify = new Database(file);
  try {
    expect(verify.query("PRAGMA user_version").get()).toEqual({
      user_version: 5,
    });
    expect(
      verify
        .query(
          "SELECT ItemID,Type,TmplName,OpaqueColumn3,OpaqueColumn4,OpaqueColumn5,Verbose FROM FxItem",
        )
        .get(),
    ).toEqual({
      ItemID: 1,
      Type: 5,
      TmplName: "Item/Fixture",
      OpaqueColumn3: -1,
      OpaqueColumn4: 4294967295,
      OpaqueColumn5: 2147483647,
      Verbose: "synthetic definition",
    });
    expect(
      verify
        .query("PRAGMA table_info(FxItem)")
        .all()
        .some((r: any) => r.name === "SN"),
    ).toBe(false);
    verify.exec("ALTER TABLE FxItem DROP COLUMN nAttr2");
  } finally {
    verify.close();
  }
  const repaired = new CDBSession(file);
  try {
    expect(snapshot(repaired)).toEqual(before);
    repaired.IntegrityCheck();
  } finally {
    repaired.Close();
  }
});

test("two separate Bun processes upgrade the SAME real v5 file transactionally without partial/double rename or lost receipts", async () => {
  const file = path(),
    before = oldV5(file),
    script = `import {CDBSession} from './Common/DB/CDBSession.ts';const s=new CDBSession(process.argv[1]);try{console.log(s.db.query('PRAGMA user_version').get().user_version);}finally{s.Close();}`;
  const run = async () => {
    const p = Bun.spawn([process.execPath, "-e", script, file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: await p.exited,
      out: (await new Response(p.stdout).text()).trim(),
      err: await new Response(p.stderr).text(),
    };
  };
  expect(await Promise.all([run(), run()])).toEqual([
    { code: 0, out: String(RuntimePolicy.SchemaVersion), err: "" },
    { code: 0, out: String(RuntimePolicy.SchemaVersion), err: "" },
  ]);
  const s = new CDBSession(file);
  try {
    expect(snapshot(s)).toEqual(before);
    s.IntegrityCheck();
  } finally {
    s.Close();
  }
});

test("catalog reload cannot publish uncommitted definitions from early OR late outer transactions; savepoint release is not a durable generation", () => {
  const { s, db } = create();
  seed(s, [definition()]);
  const man = new CUserItemMan(db),
    before = body(man),
    original = db.GetUserItemList.bind(db);
  s.db.exec(
    "BEGIN IMMEDIATE;UPDATE FxItem SET strName='uncommitted';SAVEPOINT nested",
  );
  try {
    expect(() => man.UpdateUserItemTable()).toThrow("committed root");
    expect(() => new CUserItemMan(db)).toThrow("committed root");
    s.db.exec("RELEASE nested");
    expect(() => man.UpdateUserItemTable()).toThrow("committed root");
    expect(body(man)).toEqual(before);
  } finally {
    s.db.exec("ROLLBACK");
  }
  db.GetUserItemList = () => {
    const rows = original();
    s.db.exec("BEGIN IMMEDIATE");
    return rows;
  };
  try {
    expect(() => man.UpdateUserItemTable()).toThrow("opened a transaction");
    expect(man.GetState()).toEqual({ Revision: 1, Count: 1 });
    expect(body(man)).toEqual(before);
  } finally {
    s.db.exec("ROLLBACK");
    db.GetUserItemList = original;
  }
  expect(man.UpdateUserItemTable()).toBe(true);
  expect(man.GetState().Revision).toBe(2);
});

test("returned202 bytes are detached and revision exhaustion refuses reload BEFORE SQL rather than wrapping onto a stale generation", () => {
  const { db } = create();
  db.GetUserItemList = () => [definition()];
  const man = new CUserItemMan(db),
    original = body(man),
    mutated = body(man);
  mutated.fill(0);
  expect(body(man)).toEqual(original);
  Reflect.set(man, "m_nRevision", 0xffffffff);
  db.GetUserItemList = () => {
    throw new Error("must not query at exhaustion");
  };
  expect(() => man.UpdateUserItemTable()).toThrow("exhausted");
  expect(man.GetState()).toEqual({ Revision: 0xffffffff, Count: 1 });
  expect(body(man)).toEqual(original);
});
