import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestoreV5CatalogColumnsForFixture } from "./helpers/UserItemCatalog.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import {
  CDBMan,
  type HouseClaimSubmission,
  type MoneyPickupSubmission,
} from "../FXGS/CDBMan.ts";
import { PlanTakeHouse, MakeTakeHousePacket } from "../FXGS/HouseClaim.ts";
import {
  HouseSubmission,
  SeedHouseUser,
  HouseReceiptCount,
  EmptyHouseResult,
} from "./helpers/HouseClaim.ts";
import { MoneySubmission, SeedMoneyUser } from "./helpers/MoneyPickup.ts";
import vectors from "./fixtures/house-claim-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function memory(input = HouseSubmission()) {
  const session = new CDBSession(":memory:"),
    db = new CDBMan(session);
  cleanup.push(() => session.Close());
  SeedHouseUser(db, input);
  return { session, db, input };
}
function path() {
  const dir = mkdtempSync(join(tmpdir(), "sm-house-store-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "users.sqlite");
}
function next(input: HouseClaimSubmission): HouseClaimSubmission {
  const p = input.Plan,
    plan = PlanTakeHouse(p.After, p.Slot, p.Color, [[12, 14]], []),
    before = { ...input.After },
    wrapped = (before.Money + plan.Delta) | 0;
  return {
    ...input,
    ClaimSequence: input.ClaimSequence + 1,
    Plan: plan,
    Before: before,
    After: { ...before, Money: Math.min(1_000_000, Math.max(0, wrapped)) },
    Packet: MakeTakeHousePacket(plan).GetBuffer(),
  };
}
function money(input: HouseClaimSubmission): MoneyPickupSubmission {
  const original = MoneySubmission(),
    before = { ...input.After };
  return {
    ...original,
    RoundID: input.RoundID,
    ChannelIndex: input.ChannelIndex,
    SessionIndex: input.SessionIndex,
    SessionSerialNo: input.SessionSerialNo,
    StartTick: input.StartTick,
    Before: before,
    After: { ...before, Money: before.Money + original.Delta },
  };
}
test("all safe independent C++ board/allocator/native money images commit exact178 and deduplicate, including zero awards, wrap, clamp and out-of-count colors", () => {
  for (const row of vectors.Cases.filter((r) => r.Safe)) {
    const input = HouseSubmission(row),
      s = new CDBSession(":memory:"),
      db = new CDBMan(s);
    try {
      SeedHouseUser(db, input);
      expect(db.CommitHouseClaim(input)).toBe("committed");
      expect(db.CommitHouseClaim(input)).toBe("duplicate");
      expect(db.ConfirmHouseClaim(input)).toBe(true);
      expect(db.GetUserInfo(input.Before.ID)!.Money).toBe(row.MoneyAfter);
      const receipt = db.GetHouseClaimReceipt(input.RoundID, 1)!,
        data = JSON.parse(receipt.Payload);
      expect(receipt.Packet.toString("hex")).toBe(row.NativeResponse);
      expect(data.Plan.After.States).toEqual(row.StatesAfter);
      expect(data.Plan.After.Counts).toEqual(row.CountsAfter);
      expect(data.Plan.After.NextBoxItem).toBe(row.Next + row.Allocated);
      expect(data.Plan.AcceptedCells).toEqual(row.Accepted);
      expect(data.Plan.Delta).toBe(row.Delta);
      expect(receipt.Digest).toBe(
        createHash("sha256").update(receipt.Payload).digest("hex"),
      );
      expect(receipt.CommittedAt).toBeGreaterThan(0);
      expect(HouseReceiptCount(db)).toBe(1);
      expect(s.db.query("SELECT TicketDate FROM FxUserDynamic").get()).toEqual({
        TicketDate: 12345,
      });
    } finally {
      s.Close();
    }
  }
}, 30_000);
test("canonical ordering/case-normalized IDs and detached receipt buffers cannot become a second award", () => {
  const { db, input } = memory();
  db.CommitHouseClaim(input);
  const retry = Object.fromEntries(
    Object.entries({
      ...input,
      Before: { ...input.Before, ID: input.Before.ID.toUpperCase() },
      After: { ...input.After, ID: input.After.ID.toLowerCase() },
      Packet: Uint8Array.from(input.Packet),
    }).reverse(),
  ) as unknown as HouseClaimSubmission;
  expect(db.CommitHouseClaim(retry)).toBe("duplicate");
  const a = db.GetHouseClaimReceipt(input.RoundID, 1)!,
    hex = a.Packet.toString("hex");
  a.Packet.fill(0);
  expect(
    db.GetHouseClaimReceipt(input.RoundID, 1)!.Packet.toString("hex"),
  ).toBe(hex);
  expect(Object.isFrozen(a)).toBe(true);
  expect(HouseReceiptCount(db)).toBe(1);
});
test("individually valid same-key mutations are rejected BEFORE stale CAS; zero-delta plans also have distinct immutable identity", () => {
  const { db, input } = memory();
  db.CommitHouseClaim(input);
  for (const variant of [
    { ...input, GlobalSerialNo: input.GlobalSerialNo + 1 },
    { ...input, ChannelIndex: 1 },
    { ...input, SessionIndex: 18 },
    { ...input, SessionSerialNo: 92 },
    { ...input, StartTick: 101 },
  ])
    expect(() => db.CommitHouseClaim(variant)).toThrow("key reused");
  expect(HouseReceiptCount(db)).toBe(1);
  const n = next(input);
  db.CommitHouseClaim(n);
  const z = next(n);
  db.CommitHouseClaim(z);
  const p = PlanTakeHouse(z.Plan.Before, z.Plan.Slot, z.Plan.Color, [], []);
  expect(() =>
    db.CommitHouseClaim({
      ...z,
      Plan: p,
      Packet: MakeTakeHousePacket(p).GetBuffer(),
    }),
  ).toThrow("key reused");
});
test("ordinal holes, stale board/allocator chain and changed round descriptors reject without rebasing or writing money", () => {
  const { db, input } = memory();
  expect(() => db.CommitHouseClaim({ ...input, ClaimSequence: 2 })).toThrow(
    "contiguous",
  );
  db.CommitHouseClaim(input);
  const n = next(input);
  for (const variant of [
    { ...n, ChannelIndex: 1 },
    { ...n, SessionIndex: 18 },
    { ...n, SessionSerialNo: 92 },
    { ...n, StartTick: 101 },
  ])
    expect(() => db.CommitHouseClaim(variant)).toThrow("descriptor changed");
  expect(() =>
    db.CommitHouseClaim({
      ...input,
      ClaimSequence: 2,
      Before: input.After,
      After: { ...input.After, Money: input.After.Money + input.Plan.Delta },
    }),
  ).toThrow("chain changed");
  expect(db.CommitHouseClaim(n)).toBe("committed");
  expect(HouseReceiptCount(db)).toBe(2);
});
test("ALL five wallet fields use CAS, missing users and late receipt insert failures roll back the wallet atomically", () => {
  for (const field of ["Money", "Exp", "Win", "Draw", "Lose"] as const) {
    const { db, input } = memory();
    db.session.db.query(`UPDATE FxUserDynamic SET ${field}=${field}+1`).run();
    expect(db.CommitHouseClaim(input)).toBe("conflict");
    expect(HouseReceiptCount(db)).toBe(0);
    expect(db.GetUserInfo(input.Before.ID)![field]).toBe(
      input.Before[field] + 1,
    );
  }
  const { db, input } = memory();
  db.session.db.exec(
    "CREATE TRIGGER TestHouseFailure BEFORE INSERT ON RuntimeHouseClaim BEGIN SELECT RAISE(FAIL,'house-write-fault'); END",
  );
  expect(() => db.CommitHouseClaim(input)).toThrow("house-write-fault");
  expect(db.GetUserInfo(input.Before.ID)!.Money).toBe(input.Before.Money);
  expect(HouseReceiptCount(db)).toBe(0);
  db.session.db.exec("DROP TRIGGER TestHouseFailure");
  expect(db.CommitHouseClaim(input)).toBe("committed");
  const absent = {
    ...next(input),
    Before: { ...input.After, ID: "Absent" },
    After: { ...next(input).After, ID: "Absent" },
  };
  expect(db.CommitHouseClaim(absent)).toBe("conflict");
});
test("receipt operations refuse enclosing transactions/savepoints, including Confirm of a committed duplicate", () => {
  const { db, input, session } = memory();
  session.db.transaction(() => {
    expect(() => db.CommitHouseClaim(input)).toThrow("top-level");
    expect(() => db.ConfirmHouseClaim(input)).toThrow("top-level");
  })();
  expect(HouseReceiptCount(db)).toBe(0);
  db.CommitHouseClaim(input);
  session.db.transaction(() => {
    expect(() => db.CommitHouseClaim(input)).toThrow("top-level");
    expect(() => db.ConfirmHouseClaim(input)).toThrow("top-level");
  })();
});
test("house and money ordinals are separate, but BOTH descriptors bind the shared result UUID in either ordering", () => {
  const { db, input } = memory();
  db.CommitHouseClaim(input);
  const m = money(input);
  expect(() => db.CommitMoneyPickup({ ...m, StartTick: 101 })).toThrow(
    "descriptor changed",
  );
  expect(db.CommitMoneyPickup(m)).toBe("committed");
  const n = next(input),
    adjusted = {
      ...n,
      Before: m.After,
      After: { ...m.After, Money: m.After.Money + n.Plan.Delta },
    };
  expect(db.CommitHouseClaim(adjusted)).toBe("committed");
  expect(() =>
    db.CommitGameResult({ ...EmptyHouseResult(input), StartTick: 101 }),
  ).toThrow("descriptor changed");
  expect(db.CommitGameResult(EmptyHouseResult(input))).toBe("committed");
  expect(db.CommitHouseClaim(input)).toBe("duplicate");
  expect(db.CommitMoneyPickup(m)).toBe("duplicate");
  expect(() => db.CommitHouseClaim(next(adjusted))).toThrow("already settled");
  const other = memory();
  const firstMoney = money({ ...other.input, After: other.input.Before });
  expect(other.db.CommitMoneyPickup(firstMoney)).toBe("committed");
  const h = {
    ...other.input,
    Before: firstMoney.After,
    After: {
      ...firstMoney.After,
      Money: firstMoney.After.Money + other.input.Plan.Delta,
    },
  };
  expect(() =>
    other.db.CommitHouseClaim({ ...h, SessionSerialNo: 92 }),
  ).toThrow("descriptor changed");
  expect(other.db.CommitHouseClaim(h)).toBe("committed");
});
test("house-only result binding and SQL closure trigger block new awards; duplicates remain legal after settlement", () => {
  const { db, input, session } = memory();
  db.CommitHouseClaim(input);
  expect(() =>
    db.CommitGameResult({ ...EmptyHouseResult(input), ChannelIndex: 1 }),
  ).toThrow("descriptor changed");
  db.CommitGameResult(EmptyHouseResult(input));
  expect(db.CommitHouseClaim(input)).toBe("duplicate");
  expect(() => db.CommitHouseClaim(next(input))).toThrow("already settled");
  expect(() =>
    session.db
      .query(
        `INSERT INTO RuntimeHouseClaim SELECT RoundID,2,Digest,ChannelIndex,SessionIndex,SessionSerialNo,StartTick,Payload,Packet,CommittedAt FROM RuntimeHouseClaim`,
      )
      .run(),
  ).toThrow("already settled");
});
test("immutable triggers forbid update/delete; packet/metadata/canonical-plan corruption remains detectable even after digest recomputation", () => {
  for (const mode of [
    "digest",
    "packet",
    "metadata",
    "plan",
    "version",
    "extra",
  ]) {
    const { db, input, session } = memory();
    db.CommitHouseClaim(input);
    expect(() => session.db.exec("DELETE FROM RuntimeHouseClaim")).toThrow(
      "immutable",
    );
    expect(() =>
      session.db.exec("UPDATE RuntimeHouseClaim SET StartTick=101"),
    ).toThrow("immutable");
    session.db.exec("DROP TRIGGER RuntimeHouseClaim_NoUpdate");
    const receipt = db.GetHouseClaimReceipt(input.RoundID, 1)!;
    if (mode === "digest")
      session.db.exec("UPDATE RuntimeHouseClaim SET Digest=printf('%064d',0)");
    if (mode === "packet")
      session.db.exec(
        "UPDATE RuntimeHouseClaim SET Packet=zeroblob(length(Packet))",
      );
    if (mode === "metadata")
      session.db.exec("UPDATE RuntimeHouseClaim SET StartTick=101");
    if (["plan", "version", "extra"].includes(mode)) {
      const data = JSON.parse(receipt.Payload);
      if (mode === "plan") data.Plan.After.States[0] = 7;
      if (mode === "version") data.Version = 99;
      if (mode === "extra") data.Unrecognized = true;
      const payload = JSON.stringify(data),
        digest = createHash("sha256").update(payload).digest("hex");
      session.db
        .query("UPDATE RuntimeHouseClaim SET Payload=?,Digest=?")
        .run(payload, digest);
    }
    expect(() => db.GetHouseClaimReceipt(input.RoundID, 1)).toThrow(
      "Corrupt house",
    );
  }
});
test("false ACK without an exact matching receipt is not confirmation, even for a no-op wallet", () => {
  const zero = vectors.Cases.find((r) => r.Safe && r.Delta === 0)!;
  const { db, input } = memory(HouseSubmission(zero));
  expect(db.ConfirmHouseClaim(input)).toBe(false);
  db.CommitHouseClaim(input);
  expect(db.ConfirmHouseClaim(input)).toBe(true);
  expect(db.ConfirmHouseClaim({ ...input, ClaimSequence: 2 })).toBe(false);
});
test("normalization rejects tampered derived plan, money/identity/stats, scalar domains, response and exhausted allocator without a receipt", () => {
  const { db, input } = memory(),
    p = input.Plan;
  const variants: HouseClaimSubmission[] = [
    { ...input, ClaimSequence: 0 },
    { ...input, ClaimSequence: 2 ** 32 },
    { ...input, ChannelIndex: -1 },
    { ...input, SessionIndex: 255 },
    { ...input, GlobalSerialNo: NaN },
    { ...input, RoundID: "not-a-uuid" },
    { ...input, Plan: { ...p, Slot: 8 } },
    { ...input, Plan: { ...p, Color: 32 } },
    { ...input, Plan: { ...p, Delta: p.Delta + 1 } },
    { ...input, Plan: { ...p, After: { ...p.After, NextBoxItem: 251 } } },
    { ...input, Plan: { ...p, AcceptedCells: [] } },
    { ...input, Plan: { ...p, AllocatedDrops: [[0, 126, 0, 0]] } },
    { ...input, Plan: { ...p, Before: { ...p.Before, States: [] } } },
    { ...input, Plan: { ...p, Cells: [[256, 0]] } },
    { ...input, Plan: { ...p, DropRequests: [[0, 0, 256]] } },
    { ...input, After: { ...input.After, Money: input.After.Money + 1 } },
    { ...input, After: { ...input.After, Exp: 1201 } },
    { ...input, After: { ...input.After, ID: "Different" } },
    { ...input, Before: { ...input.Before, Money: -1 } },
    { ...input, Packet: Buffer.alloc(5) },
    {
      ...input,
      Packet: Buffer.concat([Buffer.from(input.Packet), Buffer.from([0])]),
    },
  ];
  for (const invalid of variants)
    expect(() => db.CommitHouseClaim(invalid)).toThrow();
  expect(HouseReceiptCount(db)).toBe(0);
  expect(db.GetUserInfo(input.Before.ID)!.Money).toBe(input.Before.Money);
  for (const row of vectors.Cases.filter((r) => !r.Safe))
    expect(() => HouseSubmission(row)).toThrow("exhausted");
});
test("file reopen preserves exact immutable plan/wallet; competing connections cannot pay stale snapshots or bypass busy locks", () => {
  const file = path(),
    one = new CDBSession(file),
    db = new CDBMan(one),
    input = HouseSubmission();
  SeedHouseUser(db, input);
  db.CommitHouseClaim(input);
  const receipt = db.GetHouseClaimReceipt(input.RoundID, 1)!;
  one.Close();
  const two = new CDBSession(file),
    other = new CDBSession(file);
  cleanup.push(
    () => other.Close(),
    () => two.Close(),
  );
  const a = new CDBMan(two),
    b = new CDBMan(other);
  expect(a.GetHouseClaimReceipt(input.RoundID, 1)).toEqual(receipt);
  expect(a.CommitHouseClaim(input)).toBe("duplicate");
  const n = next(input);
  two.db.exec("BEGIN IMMEDIATE");
  other.db.exec("PRAGMA busy_timeout=1");
  try {
    expect(() => b.CommitHouseClaim(n)).toThrow("locked");
  } finally {
    two.db.exec("ROLLBACK");
  }
  expect(b.CommitHouseClaim(n)).toBe("committed");
  expect(a.CommitHouseClaim(n)).toBe("duplicate");
  two.IntegrityCheck();
});
test("schema3 ->current transactional migration preserves money receipts, accounts/dynamics and inventory without recreating them", () => {
  const file = path(),
    current = new CDBSession(file),
    db = new CDBMan(current),
    input = MoneySubmission();
  SeedMoneyUser(db, input);
  db.CommitMoneyPickup(input);
  const receipt = db.GetMoneyPickupReceipt(input.RoundID, 1)!;
  RestoreV5CatalogColumnsForFixture(current);
  current.db.exec(
    "INSERT INTO FxUserInventory(ID,ItemID,Amount) SELECT ID,32,2 FROM FxUserDynamic; DROP TABLE RuntimeSpecialItemUse; DROP TABLE RuntimeHouseClaim; PRAGMA user_version=3",
  );
  current.Close();
  const upgraded = new CDBSession(file);
  cleanup.push(() => upgraded.Close());
  const after = new CDBMan(upgraded);
  expect(upgraded.db.query("PRAGMA user_version").get()).toEqual({
    user_version: RuntimePolicy.SchemaVersion,
  });
  expect(after.GetMoneyPickupReceipt(input.RoundID, 1)).toEqual(receipt);
  expect(after.GetUserInfo(input.Before.ID)!.Money).toBe(input.After.Money);
  expect(
    upgraded.db.query("SELECT ItemID,Amount FROM FxUserInventory").get(),
  ).toEqual({ ItemID: 32, Amount: 2 });
  expect(HouseReceiptCount(after)).toBe(0);
  upgraded.IntegrityCheck();
});
test("failing004 DDL rolls back schema version and leaves old v3 tables/data intact without partial triggers", () => {
  const file = path(),
    old = new Database(file);
  for (const name of [
    "001_Initial.sql",
    "002_GameResult.sql",
    "003_MoneyPickup.sql",
  ])
    old.exec(
      readFileSync(
        new URL(`../Common/DB/Migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  old.exec(
    "PRAGMA user_version=3; INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES('OldUser',0,'fixture'); INSERT INTO FxUserDynamic(ID,Money) VALUES('OldUser',37); CREATE TABLE RuntimeHouseClaim(RoundID TEXT)",
  );
  old.close();
  expect(() => new CDBSession(file)).toThrow("already exists");
  const verify = new Database(file);
  try {
    expect(verify.query("PRAGMA user_version").get()).toEqual({
      user_version: 3,
    });
    expect(verify.query("SELECT Money FROM FxUserDynamic").get()).toEqual({
      Money: 37,
    });
    expect(
      verify
        .query(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'RuntimeHouseClaim_%'",
        )
        .all(),
    ).toEqual([]);
  } finally {
    verify.close();
  }
});
test("maximal255-pair/124-drop request accepts195 distinct cells, binds the891-byte complete178 and stays within explicit32KiB receipt policy", () => {
  const base = HouseSubmission(),
    cells: [number, number][] = [];
  for (let row = 0; row < 13; row++)
    for (let col = 0; col < 15; col++) cells.push([row, col]);
  while (cells.length < 255) cells.push([0, 0]);
  const plan = PlanTakeHouse(
    { States: Array(195).fill(-1), Counts: Array(8).fill(0), NextBoxItem: 126 },
    0,
    0,
    cells,
    Array.from({ length: 124 }, (_, i) => [i, 255, 128] as const),
  );
  const input = {
    ...base,
    Plan: plan,
    Before: { ...base.Before, Money: 0 },
    After: { ...base.Before, Money: 975 },
    Packet: MakeTakeHousePacket(plan).GetBuffer(),
  };
  const { db } = memory(input);
  expect(db.CommitHouseClaim(input)).toBe("committed");
  const receipt = db.GetHouseClaimReceipt(input.RoundID, 1)!;
  expect(receipt.Packet.length).toBe(891);
  expect(JSON.parse(receipt.Payload).Plan.AllocatedDrops).toHaveLength(124);
  expect(Buffer.byteLength(receipt.Payload)).toBeLessThan(
    RuntimePolicy.MaxHouseClaimReceiptBytes,
  );
  expect(() => PlanTakeHouse(plan.After, 0, 0, [], [[0, 0, 0]])).toThrow(
    CProtocolError,
  );
});

async function children(
  file: string,
  input: HouseClaimSubmission,
  operations: readonly ("house" | "result")[],
) {
  const encoded = JSON.stringify({
      ...input,
      Packet: Buffer.from(input.Packet).toString("hex"),
    }),
    result = EmptyHouseResult(input),
    encodedResult = JSON.stringify({
      ...result,
      Packet: Buffer.from(result.Packet).toString("hex"),
    });
  const jobs = operations.map((op) => {
    const code = `import {CDBSession} from './Common/DB/CDBSession.ts'; import {CDBMan} from './FXGS/CDBMan.ts';
      const s=new CDBSession(${JSON.stringify(file)}), db=new CDBMan(s), h=${encoded}, r=${encodedResult};
      h.Packet=Buffer.from(h.Packet,'hex');r.Packet=Buffer.from(r.Packet,'hex');
      try {try {console.log(JSON.stringify({status:db.${op === "house" ? "CommitHouseClaim(h)" : "CommitGameResult(r)"}}));}
      catch(e) {if(e.code==='house-round-closed') console.log(JSON.stringify({status:e.code}));else throw e;}}
      finally{s.Close();}`;
    return Bun.spawn([process.execPath, "-e", code], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
  });
  return Promise.all(
    jobs.map(async (p) => ({
      code: await p.exited,
      out: (await new Response(p.stdout).text()).trim(),
      err: (await new Response(p.stderr).text()).trim(),
    })),
  );
}
test("two independent Bun processes race the SAME frozen receipt: exactly one root COMMIT, one duplicate and one wallet award", async () => {
  const file = path(),
    s = new CDBSession(file),
    db = new CDBMan(s),
    input = HouseSubmission();
  SeedHouseUser(db, input);
  s.Close();
  const outcomes = await children(file, input, ["house", "house"]);
  expect(outcomes.map((r) => r.code)).toEqual([0, 0]);
  expect(outcomes.map((r) => r.err)).toEqual(["", ""]);
  expect(outcomes.map((r) => JSON.parse(r.out).status).sort()).toEqual([
    "committed",
    "duplicate",
  ]);
  const reopened = new CDBSession(file);
  cleanup.push(() => reopened.Close());
  const after = new CDBMan(reopened);
  expect(after.GetUserInfo(input.Before.ID)!.Money).toBe(input.After.Money);
  expect(HouseReceiptCount(after)).toBe(1);
  reopened.IntegrityCheck();
}, 30_000);
test("separate Bun processes race NEW house against settlement: atomic ordered closure, never an award after the durable result", async () => {
  for (let i = 0; i < 3; i++) {
    const file = path(),
      s = new CDBSession(file),
      db = new CDBMan(s),
      input = HouseSubmission();
    SeedHouseUser(db, input);
    s.Close();
    const outcomes = await children(file, input, ["house", "result"]);
    expect(outcomes.map((r) => r.code)).toEqual([0, 0]);
    expect(outcomes.map((r) => r.err)).toEqual(["", ""]);
    const house = JSON.parse(outcomes[0]!.out).status;
    expect(["committed", "house-round-closed"]).toContain(house);
    expect(JSON.parse(outcomes[1]!.out).status).toBe("committed");
    const reopened = new CDBSession(file);
    try {
      const after = new CDBMan(reopened);
      expect(after.GetGameResultReceipt(input.RoundID)).toBeDefined();
      expect(HouseReceiptCount(after)).toBe(house === "committed" ? 1 : 0);
      expect(after.GetUserInfo(input.Before.ID)!.Money).toBe(
        house === "committed" ? input.After.Money : input.Before.Money,
      );
      reopened.IntegrityCheck();
    } finally {
      reopened.Close();
    }
  }
}, 30_000);
