import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { NormalizeID } from "../Common/CIDCompare.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import {
  CDBMan,
  type MoneyPickupSubmission,
  type GameResultSubmission,
} from "../FXGS/CDBMan.ts";
import {
  MoneySubmission,
  MoneyReceiptCount,
  SeedMoneyUser,
} from "./helpers/MoneyPickup.ts";
import vectors from "./fixtures/item-pickup-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function memory(input = MoneySubmission()) {
  const session = new CDBSession(":memory:"),
    db = new CDBMan(session);
  cleanup.push(() => session.Close());
  SeedMoneyUser(db, input);
  return { session, db, input };
}
function current(db: CDBMan, input: MoneyPickupSubmission) {
  const u = db.GetUserInfo(input.Before.ID)!;
  return {
    ID: NormalizeID(u.ID),
    Money: u.Money,
    Exp: u.Exp,
    Win: u.Win,
    Draw: u.Draw,
    Lose: u.Lose,
  };
}
function expected(state: MoneyPickupSubmission["Before"]) {
  return { ...state, ID: NormalizeID(state.ID) };
}
function next(input: MoneyPickupSubmission): MoneyPickupSubmission {
  const before = { ...input.After },
    wrapped = (before.Money + input.Delta) | 0;
  return {
    ...input,
    ClaimSequence: input.ClaimSequence + 1,
    Before: before,
    After: { ...before, Money: Math.min(1_000_000, Math.max(0, wrapped)) },
    Packet: Buffer.from(input.Packet),
  };
}
/** Trusted empty settlement tests ONLY the storage ordering/descriptor boundary. */
function emptyResult(input: MoneyPickupSubmission): GameResultSubmission {
  const p = new CSendPacket(163)
    .Encode1(0)
    .Encode1(255)
    .Encode1(0)
    .Encode1(0)
    .Encode1(0);
  for (let i = 0; i < 8; i++) p.Encode1(0);
  return {
    RoundID: input.RoundID,
    ChannelIndex: input.ChannelIndex,
    SessionIndex: input.SessionIndex,
    SessionSerialNo: input.SessionSerialNo,
    StartTick: input.StartTick,
    ElapsedMilliseconds: 100,
    WinningColor: -1,
    Reason: "timeout",
    InvalidGame: false,
    CountedSlots: [],
    Changes: [],
    Packet: p.GetBuffer(),
  };
}
function file() {
  const dir = mkdtempSync(join(tmpdir(), "sm-money-store-")),
    path = join(dir, "users.sqlite");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

// These are modern durability tests. Native arithmetic/156 images are OUR
// frozen manually translated C++ models, not execution of the supplied binary.
describe("SQLite schema3 money144 receipts / absolute native wallet CAS", () => {
  test("all800 real-resource +10 synthetic independent C++ IMUL/ADD/clamp/156 images commit and deduplicate", () => {
    for (const row of [
      ...vectors.MoneyPreviews,
      ...vectors.SyntheticMoneyPreviews,
    ]) {
      const input = MoneySubmission(row),
        session = new CDBSession(":memory:"),
        db = new CDBMan(session);
      try {
        SeedMoneyUser(db, input);
        expect(db.CommitMoneyPickup(input)).toBe("committed");
        expect(db.CommitMoneyPickup(input)).toBe("duplicate");
        expect(current(db, input)).toEqual(expected(input.After));
        const receipt = db.GetMoneyPickupReceipt(input.RoundID, 1)!;
        expect(receipt.Packet.toString("hex")).toBe(row.Response);
        expect(receipt.Digest).toBe(
          createHash("sha256").update(receipt.Payload).digest("hex"),
        );
        expect(receipt.CommittedAt).toBeGreaterThan(0);
        const data = JSON.parse(receipt.Payload);
        expect(data.Version).toBe(RuntimePolicy.MoneyPickupReceiptVersion);
        expect(data.Before).toEqual(expected(input.Before));
        expect(data.After).toEqual(expected(input.After));
        expect(data.Delta).toBe(row.Delta);
        expect(data.DiagnosticAmountExceeded).toBe(
          row.DiagnosticAmountExceeded,
        );
        expect(MoneyReceiptCount(db)).toBe(1);
        expect(
          db.session.db.query("SELECT TicketDate FROM FxUserDynamic").get(),
        ).toEqual({ TicketDate: 12345 });
      } finally {
        session.Close();
      }
    }
    //810 genuinely fresh SQLite DBs now each run the seven real schema6
    //column renames. This is a heavy vector fixture, not a gameplay deadline.
  }, 30000);
  test("canonical ordering, ASCII-case IDs and detached packet/snapshots cannot produce a second payment", () => {
    const { db, input } = memory();
    expect(db.CommitMoneyPickup(input)).toBe("committed");
    const shuffled = Object.fromEntries(
      Object.entries(input).reverse(),
    ) as unknown as MoneyPickupSubmission;
    const retry = {
      ...shuffled,
      Before: { ...input.Before, ID: input.Before.ID.toUpperCase() },
      After: Object.fromEntries(
        Object.entries({
          ...input.After,
          ID: input.After.ID.toLowerCase(),
        }).reverse(),
      ) as unknown as MoneyPickupSubmission["After"],
      Packet: Uint8Array.from(input.Packet),
    };
    expect(db.CommitMoneyPickup(retry)).toBe("duplicate");
    const a = db.GetMoneyPickupReceipt(input.RoundID, 1)!,
      original = a.Packet.toString("hex");
    a.Packet.fill(0);
    expect(
      db.GetMoneyPickupReceipt(input.RoundID, 1)!.Packet.toString("hex"),
    ).toBe(original);
    expect(Object.isFrozen(a)).toBe(true);
    expect(MoneyReceiptCount(db)).toBe(1);
  });
  test("same-key DIFFERENT but individually valid metadata/calculation is rejected before a stale CAS can hide reuse", () => {
    const { db, input } = memory();
    db.CommitMoneyPickup(input);
    const variants: MoneyPickupSubmission[] = [
      { ...input, ChannelIndex: 1 },
      { ...input, SessionIndex: 18 },
      { ...input, SessionSerialNo: 92 },
      { ...input, StartTick: 101 },
      { ...input, GlobalSerialNo: 1001 },
      {
        ...input,
        Slot: 1,
        Packet: new CSendPacket(156)
          .Encode1(1)
          .Encode1(0)
          .Encode1(25)
          .Encode1(1)
          .GetBuffer(),
      },
      {
        ...input,
        BoxIndex: 1,
        Packet: new CSendPacket(156)
          .Encode1(0)
          .Encode1(1)
          .Encode1(25)
          .Encode1(1)
          .GetBuffer(),
      },
      {
        ...input,
        Authencode: 1,
        Multiplier: 2,
        Delta: 20,
        After: { ...input.After, Money: 20 },
        Packet: new CSendPacket(156)
          .Encode1(0)
          .Encode1(0)
          .Encode1(25)
          .Encode1(2)
          .GetBuffer(),
      },
    ];
    for (const changed of variants) {
      expect(() => db.CommitMoneyPickup(changed)).toThrow("key reused");
      expect(current(db, input)).toEqual(expected(input.After));
      expect(MoneyReceiptCount(db)).toBe(1);
    }
  });
  test("ALL five optimistic fields (not only Money) conflict without a receipt, overwrite or sequence consumption", () => {
    for (const field of ["Money", "Exp", "Win", "Draw", "Lose"] as const) {
      const { db, session, input } = memory();
      session.db.query(`UPDATE FxUserDynamic SET ${field}=${field}+1`).run();
      const before = current(db, input);
      expect(db.CommitMoneyPickup(input)).toBe("conflict");
      expect(current(db, input)).toEqual(before);
      expect(MoneyReceiptCount(db)).toBe(0);
      session.db.query(`UPDATE FxUserDynamic SET ${field}=${field}-1`).run();
      expect(db.CommitMoneyPickup(input)).toBe("committed");
    }
  });
  test("missing account is a conflict, never an INSERT or synthetic wallet", () => {
    const { db, session, input } = memory();
    session.db.query("DELETE FROM FxUserAccount").run();
    expect(db.CommitMoneyPickup(input)).toBe("conflict");
    expect(MoneyReceiptCount(db)).toBe(0);
    expect(db.GetUserInfo(input.Before.ID)).toBeUndefined();
  });
  test("receipt insertion failure rolls back the successful absolute CAS and all metadata atomically", () => {
    const { db, session, input } = memory();
    session.db.exec(
      "CREATE TRIGGER TestMoneyInsertFailure BEFORE INSERT ON RuntimeMoneyPickup BEGIN SELECT RAISE(FAIL,'fixture money insert failure'); END",
    );
    expect(() => db.CommitMoneyPickup(input)).toThrow(
      "fixture money insert failure",
    );
    expect(current(db, input)).toEqual(expected(input.Before));
    expect(MoneyReceiptCount(db)).toBe(0);
    session.db.exec("DROP TRIGGER TestMoneyInsertFailure");
    expect(db.CommitMoneyPickup(input)).toBe("committed");
    expect(MoneyReceiptCount(db)).toBe(1);
    expect(() => session.IntegrityCheck()).not.toThrow();
  });
  test("exact duplicate is checked before CAS: ABA rollback cannot repay an old key; a NEW distinct claim may pay", () => {
    const { db, session, input } = memory();
    db.CommitMoneyPickup(input);
    session.db
      .query("UPDATE FxUserDynamic SET Money=?")
      .run(input.Before.Money);
    expect(db.CommitMoneyPickup(input)).toBe("duplicate");
    expect(current(db, input)).toEqual(expected(input.Before));
    expect(db.CommitMoneyPickup({ ...input, ClaimSequence: 2 })).toBe(
      "committed",
    );
    expect(current(db, input)).toEqual(expected(input.After));
    expect(MoneyReceiptCount(db)).toBe(2);
  });
  test("zero, saturation, negative clamp and IMUL-to-zero STILL have distinct durable receipts, including equal Before/After", () => {
    const rows = [
      vectors.MoneyPreviews.find(
        (r) => r.Before === 1_000_000 && r.Amount === 10 && r.Authencode === 0,
      )!,
      vectors.MoneyPreviews.find(
        (r) => r.Before === 0 && r.Amount === -1000 && r.Authencode === 0,
      )!,
      vectors.SyntheticMoneyPreviews.find((r) => r.Amount === 0)!,
      vectors.SyntheticMoneyPreviews.find(
        (r) => r.Amount === -2147483648 && r.Multiplier === 2,
      )!,
    ];
    for (const row of rows) {
      expect(row.Before).toBe(row.After);
      const { db, input } = memory(MoneySubmission(row));
      expect(db.CommitMoneyPickup(input)).toBe("committed");
      expect(db.CommitMoneyPickup(input)).toBe("duplicate");
      expect(db.CommitMoneyPickup(next(input))).toBe("committed");
      expect(MoneyReceiptCount(db)).toBe(2);
      expect(current(db, input).Money).toBe(row.After);
    }
  });
  test("sequence starts at1 and is contiguous; same-box reset needs a NEW ordinal, never a box-only key", () => {
    const { db, input } = memory();
    expect(() => db.CommitMoneyPickup({ ...input, ClaimSequence: 2 })).toThrow(
      "contiguous",
    );
    expect(MoneyReceiptCount(db)).toBe(0);
    db.CommitMoneyPickup(input);
    const second = next(input);
    expect(() => db.CommitMoneyPickup({ ...second, ClaimSequence: 3 })).toThrow(
      "contiguous",
    );
    expect(db.CommitMoneyPickup(second)).toBe("committed");
    expect(db.CommitMoneyPickup(input)).toBe("duplicate");
    expect(current(db, input).Money).toBe(20);
    expect(MoneyReceiptCount(db)).toBe(2);
  });
  test("new ordinal cannot borrow a UUID from another channel/room generation/start tick", () => {
    const { db, input } = memory();
    db.CommitMoneyPickup(input);
    for (const field of [
      "ChannelIndex",
      "SessionIndex",
      "SessionSerialNo",
      "StartTick",
    ] as const) {
      expect(() =>
        db.CommitMoneyPickup({ ...next(input), [field]: input[field] + 1 }),
      ).toThrow("descriptor changed");
      expect(MoneyReceiptCount(db)).toBe(1);
    }
    expect(db.CommitMoneyPickup(next(input))).toBe("committed");
  });
  test("settlement binds existing money descriptor; exact old replay remains duplicate AFTER close, but NEW claims fail", () => {
    const { db, input } = memory();
    db.CommitMoneyPickup(input);
    for (const field of [
      "ChannelIndex",
      "SessionIndex",
      "SessionSerialNo",
      "StartTick",
    ] as const)
      expect(() =>
        db.CommitGameResult({
          ...emptyResult(input),
          [field]: input[field] + 1,
        }),
      ).toThrow("descriptor changed");
    expect(db.CommitGameResult(emptyResult(input))).toBe("committed");
    expect(db.CommitMoneyPickup(input)).toBe("duplicate");
    expect(() => db.CommitMoneyPickup(next(input))).toThrow("already settled");
    expect(current(db, input).Money).toBe(10);
    expect(MoneyReceiptCount(db)).toBe(1);
  });
  test("a round settled BEFORE any pickup is also closed to first claims", () => {
    const { db, input } = memory();
    db.CommitGameResult(emptyResult(input));
    expect(() => db.CommitMoneyPickup(input)).toThrow("already settled");
    expect(current(db, input)).toEqual(expected(input.Before));
    expect(MoneyReceiptCount(db)).toBe(0);
  });
  test("SQL closed-round and immutable UPDATE/DELETE triggers protect against accidental bypass of application guards", () => {
    const { db, session, input } = memory();
    db.CommitMoneyPickup(input);
    for (const statement of [
      "UPDATE RuntimeMoneyPickup SET Digest='" + "0".repeat(64) + "'",
      "DELETE FROM RuntimeMoneyPickup",
    ])
      expect(() => session.db.exec(statement)).toThrow("immutable");
    db.CommitGameResult(emptyResult(input));
    expect(() =>
      session.db.exec(
        "INSERT INTO RuntimeMoneyPickup SELECT RoundID,2,Digest,ChannelIndex,SessionIndex,SessionSerialNo,StartTick,Payload,Packet,CommittedAt FROM RuntimeMoneyPickup",
      ),
    ).toThrow("already settled");
    expect(MoneyReceiptCount(db)).toBe(1);
  });
  test("invalid keys, widths, native deltas/flags, snapshots and exact scalar156 bytes fail before ALL SQL mutation", () => {
    const { db, input } = memory();
    const invalid: Partial<MoneyPickupSubmission>[] = [
      { RoundID: "client-round" },
      { RoundID: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      ...[0, -1, 1.5, NaN, Infinity, 4294967296].map((ClaimSequence) => ({
        ClaimSequence,
      })),
      { ChannelIndex: -1 },
      { ChannelIndex: 4294967296 },
      { SessionIndex: 255 },
      { SessionIndex: -1 },
      { SessionSerialNo: -1 },
      { StartTick: 4294967296 },
      { GlobalSerialNo: -1 },
      { Slot: 8 },
      { Slot: 0.5 },
      { BoxIndex: 250 },
      { ItemIndex: 256 },
      { Authencode: 256 },
      { AmountParameter: 2147483648 },
      { AmountParameter: -2147483649 },
      { AmountParameter: 0.5 },
      { Multiplier: 0 },
      { Multiplier: 3 },
      { Authencode: 0, Multiplier: 2 },
      { Delta: 11 },
      { DiagnosticAmountExceeded: true },
      { Before: { ...input.Before, Money: -1 } },
      { Before: { ...input.Before, Exp: 2147483648 } },
      { After: { ...input.After, Money: 11 } },
      { After: { ...input.After, Exp: 1201 } },
      { After: { ...input.After, Win: 8 } },
      { After: { ...input.After, Draw: 9 } },
      { After: { ...input.After, Lose: 10 } },
      { After: { ...input.After, ID: "Another" } },
      { Before: { ...input.Before, ID: "bad'id" } },
      { Packet: Buffer.alloc(0) },
      { Packet: Buffer.alloc(6) },
      { Packet: Buffer.alloc(5) },
      ...[0, 1, 2, 3, 4].map((i) => {
        const Packet = Buffer.from(input.Packet);
        Packet[i] = Packet[i]! ^ 1;
        return { Packet };
      }),
    ];
    for (const patch of invalid) {
      expect(() => db.CommitMoneyPickup({ ...input, ...patch })).toThrow(
        CProtocolError,
      );
      expect(current(db, input)).toEqual(expected(input.Before));
      expect(MoneyReceiptCount(db)).toBe(0);
    }
    expect(db.CommitMoneyPickup(input)).toBe("committed");
  });
  test("corrupt digest/blob/canonical body/denormalized metadata/invalid native calculation is never a successful replay or new tail", () => {
    for (const field of [
      "Digest",
      "Packet",
      "ChannelIndex",
      "Payload",
      "NativeAfter",
    ]) {
      const { db, session, input } = memory();
      db.CommitMoneyPickup(input);
      session.db.exec("DROP TRIGGER RuntimeMoneyPickup_NoUpdate");
      if (field === "Digest")
        session.db
          .query("UPDATE RuntimeMoneyPickup SET Digest=?")
          .run("0".repeat(64));
      else if (field === "Packet")
        session.db
          .query("UPDATE RuntimeMoneyPickup SET Packet=?")
          .run(Buffer.alloc(5));
      else if (field === "ChannelIndex")
        session.db.exec("UPDATE RuntimeMoneyPickup SET ChannelIndex=1");
      else {
        const data = JSON.parse(
          db.GetMoneyPickupReceipt(input.RoundID, 1)!.Payload,
        );
        if (field === "NativeAfter") data.After.Exp++;
        const payload =
          field === "Payload"
            ? JSON.stringify(Object.fromEntries(Object.entries(data).reverse()))
            : JSON.stringify(data);
        session.db
          .query("UPDATE RuntimeMoneyPickup SET Payload=?,Digest=?")
          .run(payload, createHash("sha256").update(payload).digest("hex"));
      }
      expect(() => db.GetMoneyPickupReceipt(input.RoundID, 1)).toThrow(
        "Corrupt",
      );
      expect(() => db.CommitMoneyPickup(input)).toThrow("Corrupt");
      expect(() => db.CommitMoneyPickup(next(input))).toThrow("Corrupt");
      expect(current(db, input)).toEqual(expected(input.After));
    }
  });
  test("no receipt for unknown valid key; invalid lookups fail, and receipts do not mutate inventory/audit/account/TicketDate", () => {
    const { db, session, input } = memory();
    session.db
      .query("INSERT INTO FxUserInventory(ID,ItemID,Amount) VALUES(?,32,2)")
      .run(input.Before.ID);
    session.db.exec(
      "INSERT INTO RuntimeAudit(Action,Details) VALUES('fixture','preserve')",
    );
    const before = ["FxUserAccount", "FxUserInventory", "RuntimeAudit"].map(
      (t) => session.db.query(`SELECT * FROM ${t}`).all(),
    );
    expect(db.GetMoneyPickupReceipt(input.RoundID, 1)).toBeUndefined();
    expect(() => db.GetMoneyPickupReceipt("client", 1)).toThrow();
    expect(() => db.GetMoneyPickupReceipt(input.RoundID, 0)).toThrow();
    db.CommitMoneyPickup(input);
    expect(
      ["FxUserAccount", "FxUserInventory", "RuntimeAudit"].map((t) =>
        session.db.query(`SELECT * FROM ${t}`).all(),
      ),
    ).toEqual(before);
    expect(
      session.db.query("SELECT TicketDate FROM FxUserDynamic").get(),
    ).toEqual({ TicketDate: 12345 });
  });
  test("receipt commits refuse an enclosing SQL transaction: savepoint release cannot masquerade as durable success", () => {
    const { db, session, input } = memory();
    session.db.transaction(() => {
      expect(() => db.CommitMoneyPickup(input)).toThrow(
        "top-level transaction",
      );
      expect(() => db.CommitGameResult(emptyResult(input))).toThrow(
        "top-level transaction",
      );
      expect(() => db.ConfirmMoneyPickup(input)).toThrow(
        "top-level transaction",
      );
    })();
    expect(current(db, input)).toEqual(expected(input.Before));
    expect(MoneyReceiptCount(db)).toBe(0);
    expect(db.CommitMoneyPickup(input)).toBe("committed");
    expect(db.ConfirmMoneyPickup(input)).toBe(true);
    expect(() =>
      db.ConfirmMoneyPickup({ ...input, GlobalSerialNo: 1001 }),
    ).toThrow("key reused");
  });
  test("receipt survives actual close/reopen; a fresh CDBMan duplicate never reapplies money", () => {
    const path = file(),
      input = MoneySubmission(),
      a = new CDBSession(path),
      first = new CDBMan(a);
    SeedMoneyUser(first, input);
    first.CommitMoneyPickup(input);
    const receipt = first.GetMoneyPickupReceipt(input.RoundID, 1)!;
    a.Close();
    const b = new CDBSession(path),
      second = new CDBMan(b);
    cleanup.push(() => b.Close());
    expect(second.CommitMoneyPickup(input)).toBe("duplicate");
    expect(second.GetMoneyPickupReceipt(input.RoundID, 1)).toEqual(receipt);
    expect(current(second, input)).toEqual(expected(input.After));
    expect(() => b.IntegrityCheck()).not.toThrow();
  });
  test("real SQLite writer lock fails without a half wallet/receipt, then the SAME frozen input succeeds", () => {
    const path = file(),
      input = MoneySubmission(),
      a = new CDBSession(path),
      b = new CDBSession(path),
      db = new CDBMan(a);
    cleanup.push(
      () => a.Close(),
      () => b.Close(),
    );
    SeedMoneyUser(db, input);
    a.db.exec("PRAGMA busy_timeout=1");
    b.db.exec("BEGIN IMMEDIATE");
    try {
      expect(() => db.CommitMoneyPickup(input)).toThrow();
      expect(current(db, input)).toEqual(expected(input.Before));
      expect(MoneyReceiptCount(db)).toBe(0);
    } finally {
      b.db.exec("ROLLBACK");
    }
    expect(db.CommitMoneyPickup(input)).toBe("committed");
    expect(MoneyReceiptCount(db)).toBe(1);
  });
  test("independent concurrent processes: same key pays ONCE, different keys with stale wallet conflict rather than lose an update", async () => {
    const script = `import { CDBSession } from './Common/DB/CDBSession.ts'; import { CDBMan } from './FXGS/CDBMan.ts';
      const s=new CDBSession(process.argv[1]), i=JSON.parse(process.argv[2]); i.Packet=Buffer.from(i.Packet,'hex');
      try {console.log(new CDBMan(s).CommitMoneyPickup(i));} finally{s.Close();}`;
    for (const sameKey of [true, false]) {
      const path = file(),
        input = MoneySubmission(),
        a = new CDBSession(path),
        db = new CDBMan(a);
      SeedMoneyUser(db, input);
      a.Close();
      const other = sameKey ? input : { ...input, RoundID: randomUUID() };
      const children = [input, other].map((i) =>
        Bun.spawn(
          [
            process.execPath,
            "-e",
            script,
            path,
            JSON.stringify({
              ...i,
              Packet: Buffer.from(i.Packet).toString("hex"),
            }),
          ],
          { stdout: "pipe", stderr: "pipe" },
        ),
      );
      try {
        const output = await Promise.all(
          children.map(async (p) => ({
            code: await p.exited,
            out: (await new Response(p.stdout).text()).trim(),
            error: await new Response(p.stderr).text(),
          })),
        );
        expect(output.every((p) => p.code === 0 && p.error === "")).toBe(true);
        expect(output.map((p) => p.out).sort()).toEqual(
          ["committed", sameKey ? "duplicate" : "conflict"].sort(),
        );
        const b = new CDBSession(path);
        try {
          const verify = new CDBMan(b);
          expect(current(verify, input)).toEqual(expected(input.After));
          expect(MoneyReceiptCount(verify)).toBe(1);
          b.IntegrityCheck();
        } finally {
          b.Close();
        }
      } finally {
        for (const p of children) {
          p.kill();
          await p.exited;
        }
      }
    }
  });
  test("v2 upgrades preserve old accounts/dynamic/inventory/audit/result receipt bytes, then enable money", () => {
    const path = file(),
      input = MoneySubmission(),
      modern = memory(),
      oldResult = emptyResult({ ...input, RoundID: randomUUID() });
    modern.db.CommitGameResult(oldResult);
    const oldReceipt = modern.db.GetGameResultReceipt(oldResult.RoundID)!;
    const old = new Database(path);
    for (const name of ["001_Initial.sql", "002_GameResult.sql"])
      old.exec(
        readFileSync(
          new URL(`../Common/DB/Migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    old.exec("PRAGMA user_version=2");
    old
      .query(
        "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES(?,0,'fixture')",
      )
      .run(input.Before.ID);
    old
      .query(
        "INSERT INTO FxUserDynamic(ID,Money,Exp,Win,Draw,Lose,TicketDate) VALUES(?,?,?,?,?,?,12345)",
      )
      .run(
        input.Before.ID,
        input.Before.Money,
        input.Before.Exp,
        input.Before.Win,
        input.Before.Draw,
        input.Before.Lose,
      );
    old
      .query("INSERT INTO FxUserInventory(ID,ItemID,Amount) VALUES(?,32,2)")
      .run(input.Before.ID);
    old.exec(
      "INSERT INTO RuntimeAudit(Action,Details) VALUES('fixture','preserve')",
    );
    old
      .query(
        "INSERT INTO RuntimeGameResult(RoundID,Digest,ChannelIndex,SessionIndex,SessionSerialNo,Payload,Packet,CommittedAt) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        oldReceipt.RoundID,
        oldReceipt.Digest,
        oldResult.ChannelIndex,
        oldResult.SessionIndex,
        oldResult.SessionSerialNo,
        oldReceipt.Payload,
        oldReceipt.Packet,
        oldReceipt.CommittedAt,
      );
    const tables = [
        "FxUserAccount",
        "FxUserDynamic",
        "FxUserInventory",
        "RuntimeAudit",
        "RuntimeGameResult",
      ],
      before = tables.map((t) => old.query(`SELECT * FROM ${t}`).all());
    old.close();
    const session = new CDBSession(path),
      db = new CDBMan(session);
    cleanup.push(() => session.Close());
    expect(session.db.query("PRAGMA user_version").get()).toEqual({
      user_version: RuntimePolicy.SchemaVersion,
    });
    expect(
      tables.map((t) => session.db.query(`SELECT * FROM ${t}`).all()),
    ).toEqual(before);
    expect(db.GetGameResultReceipt(oldReceipt.RoundID)).toEqual(oldReceipt);
    expect(db.CommitMoneyPickup(input)).toBe("committed");
    expect(() => session.IntegrityCheck()).not.toThrow();
  });
  test("a failing003 DDL rolls back the upgrade, keeps user_version2 and old user rows, and creates no partial money triggers", () => {
    const path = file(),
      old = new Database(path);
    for (const name of ["001_Initial.sql", "002_GameResult.sql"])
      old.exec(
        readFileSync(
          new URL(`../Common/DB/Migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    old.exec(
      "PRAGMA user_version=2; INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES('OldUser',0,'fixture'); INSERT INTO FxUserDynamic(ID,Money) VALUES('OldUser',37); CREATE TABLE RuntimeMoneyPickup (RoundID TEXT)",
    );
    const before = old.query("SELECT * FROM FxUserDynamic").all();
    old.close();
    expect(() => new CDBSession(path)).toThrow();
    const verify = new Database(path);
    try {
      expect(verify.query("PRAGMA user_version").get()).toEqual({
        user_version: 2,
      });
      expect(verify.query("SELECT * FROM FxUserDynamic").all()).toEqual(before);
      expect(
        verify
          .query(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'RuntimeMoneyPickup%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      verify.close();
    }
  });
});
