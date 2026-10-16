import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { CDBMan, type SpecialItemUseSubmission } from "../FXGS/CDBMan.ts";
import { MakeSpecialItemPacket } from "../FXGS/SpecialItemUse.ts";
import {
  SpecialSubmission,
  SeedSpecialUser,
  SpecialReceiptCount,
  EmptySpecialResult,
} from "./helpers/SpecialItemUse.ts";
import { MoneySubmission } from "./helpers/MoneyPickup.ts";
import { HouseSubmission } from "./helpers/HouseClaim.ts";
import { RestoreV5CatalogColumnsForFixture } from "./helpers/UserItemCatalog.ts";
import vectors from "./fixtures/special-item-use-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function memory(input = SpecialSubmission()) {
  const session = new CDBSession(":memory:"),
    db = new CDBMan(session);
  cleanup.push(() => session.Close());
  SeedSpecialUser(db, input);
  return { session, db, input };
}
function path() {
  const dir = mkdtempSync(join(tmpdir(), "sm-special-store-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "users.sqlite");
}
function next(p: SpecialItemUseSubmission): SpecialItemUseSubmission {
  return {
    ...p,
    UseSequence: p.UseSequence + 1,
    Before: { ...p.Before, Amount: p.AfterAmount },
    AfterAmount: p.AfterAmount - p.Request.Quantity,
  };
}
function money(p: SpecialItemUseSubmission) {
  const m = MoneySubmission(),
    d = { ID: p.Before.ID, Money: 17, Exp: 1200, Win: 7, Draw: 8, Lose: 9 };
  return {
    ...m,
    RoundID: p.RoundID,
    ChannelIndex: p.ChannelIndex,
    SessionIndex: p.SessionIndex,
    SessionSerialNo: p.SessionSerialNo,
    StartTick: p.StartTick,
    Before: d,
    After: { ...d, Money: d.Money + m.Delta },
  };
}
function house(p: SpecialItemUseSubmission) {
  const h = HouseSubmission(undefined, p.Before.ID),
    d = { ID: p.Before.ID, Money: 17, Exp: 1200, Win: 7, Draw: 8, Lose: 9 };
  return {
    ...h,
    RoundID: p.RoundID,
    ChannelIndex: p.ChannelIndex,
    SessionIndex: p.SessionIndex,
    SessionSerialNo: p.SessionSerialNo,
    StartTick: p.StartTick,
    Before: d,
    After: { ...d, Money: 17 + h.Plan.Delta },
  };
}
function wallet(db: CDBMan) {
  const u = db.GetUserInfo("StockUser")!;
  return [u.Money, u.Exp, u.Win, u.Draw, u.Lose, u.TicketDate];
}
function rawSnapshot(s: CDBSession) {
  return [
    "FxUserAccount",
    "FxUserDynamic",
    "FxUserInventory",
    "RuntimeMoneyPickup",
    "RuntimeHouseClaim",
    "RuntimeGameResult",
  ].map((table) => s.db.query(`SELECT * FROM ${table}`).all());
}

test("ALL988 safe positive-quantity independent C++ images commit exact159 with full inventory CAS and no wallet mutation, including exhausted-row SQL deletion", () => {
  const rows = vectors.Cases.filter(
    (r) => r.Quantity > 0 && r.ModernStatus === "relayed",
  );
  expect(rows).toHaveLength(988);
  for (const row of rows) {
    const input = SpecialSubmission(row),
      s = new CDBSession(":memory:"),
      db = new CDBMan(s);
    try {
      SeedSpecialUser(db, input);
      expect(db.CommitSpecialItemUse(input)).toBe("committed");
      expect(db.CommitSpecialItemUse(input)).toBe("duplicate");
      expect(db.ConfirmSpecialItemUse(input)).toBe(true);
      const receipt = db.GetSpecialItemUseReceipt(input.RoundID, 1)!,
        data = JSON.parse(receipt.Payload);
      expect(receipt.Packet.toString("hex")).toBe(row.NativeResponse);
      expect(receipt.Packet).toHaveLength(9);
      expect(data.Before.ID).toBe("stockuser");
      expect(data.AfterAmount).toBe(row.NativeAmount);
      expect(data.RefreshStateTime).toBe(
        row.NativeRefreshTime ? 0xfffffff0 : null,
      );
      expect(db.GetInventoryRecord(input.Before.SN)?.Amount ?? 0).toBe(
        row.NativeAmount,
      );
      expect(db.GetInventoryRecord(input.Before.SN) === undefined).toBe(
        row.NativeAmount === 0,
      );
      expect(receipt.Digest).toBe(
        createHash("sha256").update(receipt.Payload).digest("hex"),
      );
      expect(receipt.CommittedAt).toBeGreaterThan(0);
      expect(wallet(db)).toEqual([17, 1200, 7, 8, 9, 12345]);
      expect(SpecialReceiptCount(db)).toBe(1);
    } finally {
      s.Close();
    }
  }
}, 30000);
test("canonical case/order normalization and detached receipt buffers cannot spend twice; ItemID is metadata, NEVER a guessed resource mapping", () => {
  const { db, input } = memory();
  db.CommitSpecialItemUse(input);
  const retry = Object.fromEntries(
    Object.entries({
      ...input,
      Before: Object.fromEntries(
        Object.entries({ ...input.Before, ID: "sToCkUsEr" }).reverse(),
      ),
    }).reverse(),
  ) as unknown as SpecialItemUseSubmission;
  expect(db.CommitSpecialItemUse(retry)).toBe("duplicate");
  const first = db.GetSpecialItemUseReceipt(input.RoundID, 1)!;
  first.Packet.fill(0);
  expect(
    db.GetSpecialItemUseReceipt(input.RoundID, 1)!.Packet.toString("hex"),
  ).toBe(Buffer.from(input.Packet).toString("hex"));
  expect(db.GetInventoryRecord(input.Before.SN)!.ItemID).toBe(0xfedcba98);
});
test("same key changed but individually valid metadata, time, caller identity or packet is an error BEFORE stale CAS hides reuse", () => {
  const { db, input } = memory();
  db.CommitSpecialItemUse(input);
  const changed = [
    { ...input, GlobalSerialNo: input.GlobalSerialNo + 1 },
    { ...input, RefreshStateTime: 0 },
    { ...input, Before: { ...input.Before, Verbose: "changed" } },
    {
      ...input,
      Request: { ...input.Request, X: 7 },
      Packet: MakeSpecialItemPacket({ ...input.Request, X: 7 }).GetBuffer(),
    },
  ];
  for (const p of changed)
    expect(() => db.CommitSpecialItemUse(p)).toThrow("different submission");
  expect(SpecialReceiptCount(db)).toBe(1);
  expect(db.GetInventoryRecord(input.Before.SN)!.Amount).toBe(
    input.AfterAmount,
  );
});
test("EVERY persisted inventory column participates in CAS; foreign owner, metadata/amount drift and missing rows never rebase, overwrite or take an ordinal", () => {
  const changes: Record<string, number | string> = {
    SN: 5,
    ID: "OtherUser",
    ItemID: 3,
    Slot: 0,
    Amount: 255,
    ExpireDate: 0,
    Verbose: "other",
    CreatedAt: 0,
  };
  for (const [column, value] of Object.entries(changes)) {
    const { session, db, input } = memory();
    session.db.exec(
      "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES('OtherUser',0,'fixture');INSERT INTO FxUserDynamic(ID) VALUES('OtherUser')",
    );
    session.db.query(`UPDATE FxUserInventory SET ${column}=?`).run(value);
    const before = session.db.query("SELECT * FROM FxUserInventory").all();
    expect(db.CommitSpecialItemUse(input)).toBe("conflict");
    expect(session.db.query("SELECT * FROM FxUserInventory").all()).toEqual(
      before,
    );
    expect(SpecialReceiptCount(db)).toBe(0);
    expect(wallet(db)).toEqual([17, 1200, 7, 8, 9, 12345]);
  }
  for (const sql of [
    "DELETE FROM FxUserInventory",
    "DELETE FROM FxUserAccount",
  ]) {
    const { session, db, input } = memory();
    session.db.exec(sql);
    expect(db.CommitSpecialItemUse(input)).toBe("conflict");
    expect(SpecialReceiptCount(db)).toBe(0);
  }
});
test("receipt INSERT failure rolls back both decrement AND final-use DELETE in the same real root transaction", () => {
  for (const exhausted of [false, true]) {
    let input = SpecialSubmission();
    if (exhausted)
      input = {
        ...input,
        Before: { ...input.Before, Amount: 1 },
        AfterAmount: 0,
      };
    const { session, db } = memory(input);
    session.db.exec(
      "CREATE TRIGGER TestSpecialFail BEFORE INSERT ON RuntimeSpecialItemUse BEGIN SELECT RAISE(FAIL,'fixture-special-write'); END",
    );
    expect(() => db.CommitSpecialItemUse(input)).toThrow(
      "fixture-special-write",
    );
    expect(db.GetInventoryRecord(input.Before.SN)!.Amount).toBe(
      input.Before.Amount,
    );
    expect(SpecialReceiptCount(db)).toBe(0);
    session.db.exec("DROP TRIGGER TestSpecialFail");
    expect(db.CommitSpecialItemUse(input)).toBe("committed");
    expect(db.GetInventoryRecord(input.Before.SN)?.Amount ?? 0).toBe(
      input.AfterAmount,
    );
  }
});
test("exact duplicates precede CAS even after ABA/metadata restoration or final DELETE; NEW ordinals must be contiguous and consume their OWN current snapshot", () => {
  const { session, db, input } = memory();
  expect(() => db.CommitSpecialItemUse({ ...input, UseSequence: 2 })).toThrow(
    "contiguous",
  );
  db.CommitSpecialItemUse(input);
  session.db
    .query("UPDATE FxUserInventory SET Amount=?")
    .run(input.Before.Amount);
  expect(db.CommitSpecialItemUse(input)).toBe("duplicate");
  expect(db.GetInventoryRecord(input.Before.SN)!.Amount).toBe(
    input.Before.Amount,
  );
  expect(db.CommitSpecialItemUse(next(input))).toBe("conflict");
  session.db
    .query("UPDATE FxUserInventory SET Amount=?")
    .run(input.AfterAmount);
  expect(() =>
    db.CommitSpecialItemUse({ ...next(input), UseSequence: 3 }),
  ).toThrow("contiguous");
  expect(db.CommitSpecialItemUse(next(input))).toBe("committed");
  expect(SpecialReceiptCount(db)).toBe(2);
  const final = {
      ...SpecialSubmission(),
      Before: { ...input.Before, Amount: 1 },
      AfterAmount: 0,
    },
    f = memory(final);
  f.db.CommitSpecialItemUse(final);
  expect(f.db.GetInventoryRecord(final.Before.SN)).toBeUndefined();
  expect(f.db.CommitSpecialItemUse(final)).toBe("duplicate");
  expect(f.db.ConfirmSpecialItemUse(final)).toBe(true);
  expect(SpecialReceiptCount(f.db)).toBe(1);
});
test("all three OTHER receipt kinds bind a special-only UUID in every descriptor; special use also binds existing money/house receipts", () => {
  for (const field of [
    "ChannelIndex",
    "SessionIndex",
    "SessionSerialNo",
    "StartTick",
  ] as const) {
    const { db, input } = memory();
    db.CommitSpecialItemUse(input);
    const p = { ...input, [field]: input[field] + 1 };
    expect(() => db.CommitSpecialItemUse({ ...next(p) })).toThrow("descriptor");
    expect(() => db.CommitMoneyPickup(money(p))).toThrow("descriptor");
    expect(() => db.CommitHouseClaim(house(p))).toThrow("descriptor");
    expect(() => db.CommitGameResult(EmptySpecialResult(p))).toThrow(
      "descriptor",
    );
    expect(SpecialReceiptCount(db)).toBe(1);
    expect(wallet(db)[0]).toBe(17);
    for (const kind of ["money", "house"] as const) {
      const e = memory();
      kind === "money"
        ? e.db.CommitMoneyPickup(money(e.input))
        : e.db.CommitHouseClaim(house(e.input));
      expect(() =>
        e.db.CommitSpecialItemUse({ ...e.input, [field]: e.input[field] + 1 }),
      ).toThrow("descriptor");
      expect(SpecialReceiptCount(e.db)).toBe(0);
    }
  }
});
test("special, money and house ordinals are INDEPENDENT while matching descriptors settle together; old duplicates remain legal after closure, new special use does not", () => {
  const { db, input, session } = memory();
  db.CommitSpecialItemUse(input);
  const m = money(input);
  db.CommitMoneyPickup(m);
  const h = house(input);
  db.CommitHouseClaim({
    ...h,
    Before: m.After,
    After: { ...m.After, Money: m.After.Money + h.Plan.Delta },
  });
  expect(db.CommitGameResult(EmptySpecialResult(input))).toBe("committed");
  expect(db.CommitSpecialItemUse(input)).toBe("duplicate");
  expect(db.ConfirmSpecialItemUse(input)).toBe(true);
  expect(() => db.CommitSpecialItemUse(next(input))).toThrow("settled");
  expect(() =>
    session.db.exec(
      "INSERT INTO RuntimeSpecialItemUse SELECT RoundID,2,Digest,ChannelIndex,SessionIndex,SessionSerialNo,StartTick,Payload,Packet,CommittedAt FROM RuntimeSpecialItemUse",
    ),
  ).toThrow("already settled");
  expect(SpecialReceiptCount(db)).toBe(1);
  const fresh = memory();
  fresh.db.CommitGameResult(EmptySpecialResult(fresh.input));
  expect(() => fresh.db.CommitSpecialItemUse(fresh.input)).toThrow("settled");
});
test("immutable triggers protect receipts; corrupt digest, packet, canonical body, valid-looking recomputed payload or metadata never confirms", () => {
  const mutations = [
    "UPDATE RuntimeSpecialItemUse SET Digest=printf('%064d',0)",
    "UPDATE RuntimeSpecialItemUse SET Packet=zeroblob(9)",
    "UPDATE RuntimeSpecialItemUse SET ChannelIndex=ChannelIndex+1",
    "UPDATE RuntimeSpecialItemUse SET Payload=json_set(Payload,'$.AfterAmount',-1)",
    "UPDATE RuntimeSpecialItemUse SET Payload=json_set(Payload,'$.Before.ID','StockUser')",
  ];
  for (const sql of mutations) {
    const { session, db, input } = memory();
    db.CommitSpecialItemUse(input);
    expect(() =>
      session.db.exec("UPDATE RuntimeSpecialItemUse SET StartTick=1"),
    ).toThrow("immutable");
    expect(() => session.db.exec("DELETE FROM RuntimeSpecialItemUse")).toThrow(
      "immutable",
    );
    session.db.exec("DROP TRIGGER RuntimeSpecialItemUse_NoUpdate");
    session.db.exec(sql);
    if (sql.includes("Payload")) {
      const p = session.db
        .query<
          { Payload: string },
          []
        >("SELECT Payload FROM RuntimeSpecialItemUse")
        .get()!.Payload;
      session.db
        .query("UPDATE RuntimeSpecialItemUse SET Digest=?")
        .run(createHash("sha256").update(p).digest("hex"));
    }
    expect(() => db.GetSpecialItemUseReceipt(input.RoundID, 1)).toThrow(
      "Corrupt",
    );
    expect(() => db.ConfirmSpecialItemUse(input)).toThrow("Corrupt");
    expect(() => db.CommitSpecialItemUse(input)).toThrow("Corrupt");
  }
});
test("root transaction ownership applies to first commit, duplicate AND confirmation: savepoint release is NOT durability", () => {
  const { session, db, input } = memory();
  const nested = () => {
    expect(() => db.CommitSpecialItemUse(input)).toThrow();
    expect(() => db.ConfirmSpecialItemUse(input)).toThrow();
  };
  session.db.transaction(nested)();
  expect(SpecialReceiptCount(db)).toBe(0);
  db.CommitSpecialItemUse(input);
  session.db.transaction(nested)();
  expect(SpecialReceiptCount(db)).toBe(1);
});
test("invalid quantities, unsigned widths, channel108, effects29/30, state/time matrix, snapshots and exact159 fields reject BEFORE SQL", () => {
  const { db, input } = memory();
  const bad: SpecialItemUseSubmission[] = [
    { ...input, UseSequence: 0 },
    { ...input, UseSequence: 0x100000000 },
    { ...input, RoundID: "not-a-uuid" },
    { ...input, SessionIndex: 255 },
    { ...input, ChannelType: 108 },
    { ...input, ItemType: 29 },
    { ...input, ItemType: 30 },
    { ...input, ItemType: 99 },
    { ...input, PlayerState: 256 },
    { ...input, RefreshStateTime: null },
    { ...input, PlayerState: 0 },
    { ...input, RefreshStateTime: -1 },
    { ...input, AfterAmount: input.AfterAmount + 1 },
    { ...input, Before: { ...input.Before, Amount: 0 } },
    { ...input, Before: { ...input.Before, ItemID: -1 } },
    { ...input, Before: { ...input.Before, Slot: 256 } },
    { ...input, Before: { ...input.Before, CreatedAt: -1 } },
    { ...input, Before: { ...input.Before, ExpireDate: 0x100000000 } },
    { ...input, Before: { ...input.Before, Verbose: "\0" } },
    { ...input, Before: { ...input.Before, Verbose: "x".repeat(4097) } },
    { ...input, Before: { ...input.Before, SN: 0 } },
    { ...input, Before: { ...input.Before, SN: input.Before.SN + 1 } },
    { ...input, Request: { ...input.Request, Quantity: 0 } },
    { ...input, Request: { ...input.Request, Quantity: 256 } },
    { ...input, Request: { ...input.Request, Slot: 8 } },
    { ...input, Request: { ...input.Request, X: 65536 } },
    { ...input, Request: { ...input.Request, ItemIndex: 256 } },
    { ...input, Packet: Buffer.alloc(9) },
    { ...input, Packet: Buffer.concat([input.Packet, Buffer.from([0])]) },
  ];
  for (const p of bad) expect(() => db.CommitSpecialItemUse(p)).toThrow();
  expect(SpecialReceiptCount(db)).toBe(0);
  expect(db.GetInventoryRecord(input.Before.SN)!.Amount).toBe(
    input.Before.Amount,
  );
  expect(db.ConfirmSpecialItemUse(input)).toBe(false);
  expect(db.GetSpecialItemUseReceipt(input.RoundID, 1)).toBeUndefined();
  expect(() => db.GetSpecialItemUseReceipt(input.RoundID, 0)).toThrow();
});
test("maximal4096 encoded description remains bounded and exact; load-time-expired resident rows are not silently re-filtered on use", () => {
  const p = SpecialSubmission(),
    input = { ...p, Before: { ...p.Before, Verbose: "\u0001".repeat(4096) } };
  const { db } = memory(input);
  expect(db.LoadInventory(input.Before.ID)).toEqual([]);
  expect(db.GetInventoryRecord(input.Before.SN)!.ExpireDate).toBe(1);
  expect(db.CommitSpecialItemUse(input)).toBe("committed");
  expect(
    Buffer.byteLength(db.GetSpecialItemUseReceipt(input.RoundID, 1)!.Payload),
  ).toBeLessThan(RuntimePolicy.MaxSpecialItemUseReceiptBytes);
  expect(db.ConfirmSpecialItemUse(input)).toBe(true);
});
test("real close/reopen preserves exact receipt/decrement; a competing WAL writer fails without a half use and stale metadata conflicts", () => {
  const file = path(),
    p = SpecialSubmission();
  let a = new CDBSession(file),
    db = new CDBMan(a);
  SeedSpecialUser(db, p);
  db.CommitSpecialItemUse(p);
  const saved = db.GetSpecialItemUseReceipt(p.RoundID, 1)!;
  a.Close();
  a = new CDBSession(file);
  cleanup.push(() => a.Close());
  db = new CDBMan(a);
  expect(db.GetSpecialItemUseReceipt(p.RoundID, 1)).toEqual(saved);
  expect(db.CommitSpecialItemUse(p)).toBe("duplicate");
  const b = new CDBSession(file);
  cleanup.push(() => b.Close());
  a.db.exec("PRAGMA busy_timeout=1");
  b.db.exec("BEGIN IMMEDIATE");
  try {
    expect(() => db.CommitSpecialItemUse(next(p))).toThrow("locked");
    expect(SpecialReceiptCount(db)).toBe(1);
  } finally {
    b.db.exec("ROLLBACK");
  }
  expect(db.CommitSpecialItemUse(next(p))).toBe("committed");
  expect(
    new CDBMan(b).CommitSpecialItemUse({
      ...next(p),
      RoundID: crypto.randomUUID(),
      UseSequence: 1,
    }),
  ).toBe("conflict");
});
test("v4 ->5 transactional upgrade retains all previous receipt BLOBs/accounts/wallet/inventory; no drop/recreate/export is needed", () => {
  const file = path(),
    p = SpecialSubmission();
  let s = new CDBSession(file),
    db = new CDBMan(s);
  SeedSpecialUser(db, p);
  db.CommitMoneyPickup(money({ ...p, RoundID: crypto.randomUUID() }));
  db.CommitHouseClaim({
    ...house({ ...p, RoundID: crypto.randomUUID() }),
    Before: { ...house(p).Before, Money: 27 },
    After: { ...house(p).After, Money: 27 + house(p).Plan.Delta },
  });
  db.CommitGameResult(
    EmptySpecialResult({ ...p, RoundID: crypto.randomUUID() }),
  );
  const before = rawSnapshot(s);
  RestoreV5CatalogColumnsForFixture(s);
  s.db.exec("DROP TABLE RuntimeSpecialItemUse;PRAGMA user_version=4");
  s.Close();
  s = new CDBSession(file);
  cleanup.push(() => s.Close());
  db = new CDBMan(s);
  expect(s.db.query("PRAGMA user_version").get()).toEqual({
    user_version: RuntimePolicy.SchemaVersion,
  });
  expect(rawSnapshot(s)).toEqual(before);
  expect(SpecialReceiptCount(db)).toBe(0);
  expect(db.CommitSpecialItemUse(p)).toBe("committed");
});
test("late failing005 DDL rolls back the version/table/triggers while preserving v4 rows; removing the unrelated conflicting index allows a genuine retry", () => {
  const file = path(),
    old = new Database(file);
  for (const name of [
    "001_Initial.sql",
    "002_GameResult.sql",
    "003_MoneyPickup.sql",
    "004_HouseClaim.sql",
  ])
    old.exec(readFileSync(`Common/DB/Migrations/${name}`, "utf8"));
  old.exec(
    "PRAGMA user_version=4;INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES('OldUser',0,'fixture');INSERT INTO FxUserDynamic(ID,Money) VALUES('OldUser',37);CREATE INDEX IX_RuntimeSpecialItemUse_Room ON FxUserInventory(SN)",
  );
  old.close();
  expect(() => new CDBSession(file)).toThrow("already exists");
  const verify = new Database(file);
  try {
    expect(verify.query("PRAGMA user_version").get()).toEqual({
      user_version: 4,
    });
    expect(verify.query("SELECT Money FROM FxUserDynamic").get()).toEqual({
      Money: 37,
    });
    expect(
      verify
        .query(
          "SELECT name FROM sqlite_master WHERE name LIKE 'RuntimeSpecialItemUse%'",
        )
        .all(),
    ).toEqual([]);
    verify.exec("DROP INDEX IX_RuntimeSpecialItemUse_Room");
  } finally {
    verify.close();
  }
  const good = new CDBSession(file);
  cleanup.push(() => good.Close());
  expect(good.db.query("PRAGMA user_version").get()).toEqual({
    user_version: RuntimePolicy.SchemaVersion,
  });
});
async function race(file: string, p: SpecialItemUseSubmission, settle = false) {
  const encoded = JSON.stringify({
      ...p,
      Packet: Buffer.from(p.Packet).toString("hex"),
    }),
    r = EmptySpecialResult(p),
    encodedResult = JSON.stringify({
      ...r,
      Packet: Buffer.from(r.Packet).toString("hex"),
    });
  const jobs = [false, settle].map((result) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {CDBSession} from './Common/DB/CDBSession.ts';import {CDBMan} from './FXGS/CDBMan.ts';
  const s=new CDBSession(${JSON.stringify(file)}),db=new CDBMan(s),p=${encoded},r=${encodedResult};p.Packet=Buffer.from(p.Packet,'hex');r.Packet=Buffer.from(r.Packet,'hex');
  try{try{console.log(JSON.stringify({status:db.${result ? "CommitGameResult(r)" : "CommitSpecialItemUse(p)"}}));}catch(e){if(e.code==='special-round-closed')console.log(JSON.stringify({status:e.code}));else throw e;}}finally{s.Close();}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    ),
  );
  return Promise.all(
    jobs.map(async (job) => ({
      code: await job.exited,
      out: (await new Response(job.stdout).text()).trim(),
      err: (await new Response(job.stderr).text()).trim(),
    })),
  );
}
test("two independent Bun processes spend the SAME frozen receipt exactly once, with one root commit and one duplicate", async () => {
  const file = path(),
    p = SpecialSubmission(),
    s = new CDBSession(file),
    db = new CDBMan(s);
  cleanup.push(() => s.Close());
  SeedSpecialUser(db, p);
  const jobs = await race(file, p);
  for (const j of jobs) {
    expect(j.code).toBe(0);
    expect(j.err).toBe("");
  }
  expect(jobs.map((j) => JSON.parse(j.out).status).sort()).toEqual([
    "committed",
    "duplicate",
  ]);
  expect(SpecialReceiptCount(db)).toBe(1);
  expect(db.GetInventoryRecord(p.Before.SN)!.Amount).toBe(p.AfterAmount);
});
test("separate Bun processes race NEW special use against result: atomic ordered closure, never inventory consumption AFTER the durable result", async () => {
  for (let i = 0; i < 3; i++) {
    const file = path(),
      p = SpecialSubmission(),
      s = new CDBSession(file),
      db = new CDBMan(s);
    cleanup.push(() => s.Close());
    SeedSpecialUser(db, p);
    const jobs = await race(file, p, true);
    for (const j of jobs) {
      expect(j.code).toBe(0);
      expect(j.err).toBe("");
    }
    expect(db.GetGameResultReceipt(p.RoundID)).toBeDefined();
    const use = JSON.parse(jobs[0]!.out).status;
    expect(["committed", "special-round-closed"]).toContain(use);
    expect(SpecialReceiptCount(db)).toBe(use === "committed" ? 1 : 0);
    expect(db.GetInventoryRecord(p.Before.SN)!.Amount).toBe(
      use === "committed" ? p.AfterAmount : p.Before.Amount,
    );
  }
});
