import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vectors from "./fixtures/game-result-vectors.json";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import type { _USERDYNINFO, UserDynamicChange } from "../Common/DB/Rows.ts";
import { g_nLevel2ExpTable } from "../Common/Protocol/OfficialTables.ts";
import { UserDynamicRule } from "../Common/OfficialValues.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { Received } from "./helpers/Clients.ts";

const sessions: CDBSession[] = [],
  paths: string[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.Close();
  for (const path of paths.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function open(path = ":memory:") {
  const session = new CDBSession(path);
  sessions.push(session);
  return new CDBMan(session);
}
function user(exp = 0) {
  const info = UserInfo("User");
  info.Exp = exp;
  return new CUser(info, 123);
}
function dynamic(db: CDBMan, id: string): _USERDYNINFO {
  const { ID, Money, Exp, Win, Draw, Lose } = db.GetUserInfo(id)!;
  return { ID, Money, Exp, Win, Draw, Lose };
}
async function accounts(db: CDBMan) {
  await db.RegisterNewUser({ ID: "A", Password: "test" });
  await db.RegisterNewUser({ ID: "B", Password: "test" });
  return ["A", "B"].map((id): UserDynamicChange => {
    const before = dynamic(db, id);
    return { Before: before, After: { ...before, Exp: 50, Win: 1 } };
  });
}

test("IncDecExp signed32 wrap/clamp/level direction matches 63 independent C++ transitions", () => {
  expect(vectors.ExperienceTransitions.length).toBe(63);
  for (const row of vectors.ExperienceTransitions) {
    const player = user(row.BeforeExp);
    expect(player.GetLevel()).toBe(row.BeforeLevel);
    expect(player.IncDecExp(row.Delta)).toBe(row.Direction);
    expect(player.GetExp()).toBe(row.AfterExp);
    expect(player.GetLevel()).toBe(row.AfterLevel);
    const state = player.GetDynamicInfoSnapshot();
    expect(state.DynamicModified).toBe(row.DynamicModified);
    expect(state.SimpleInfoModified).toBe(row.SimpleInfoModified);
    expect(state.Dynamic.Money).toBe(0);
    expect(state.GamesSinceFlush).toBe(0);
  }
});
test("cached level changes only through explicit SetLevel or IncDecExp; zero XP still dirties", () => {
  const player = user();
  player.m_userInfo.Exp = g_nLevel2ExpTable[100]!;
  expect(player.GetLevel()).toBe(1);
  expect(player.GetLookLevel()).toBe(1);
  player.SetLevel();
  expect(player.GetLevel()).toBe(101);
  expect(player.GetDynamicInfoSnapshot().DynamicModified).toBe(0);
  expect(player.GetDynamicInfoSnapshot().SimpleInfoModified).toBe(0);
  expect(player.IncDecExp(0)).toBe(0);
  expect(player.GetDynamicInfoSnapshot().DynamicModified).toBe(1);
  expect(player.GetDynamicInfoSnapshot().SimpleInfoModified).toBe(0);
  player.m_userInfo.Exp = 0;
  expect(player.IncDecExp(0)).toBe(-1);
  expect(player.GetDynamicInfoSnapshot().SimpleInfoModified).toBe(1);
});
test("invalid XP arguments leave the original user and dirty flags unchanged", () => {
  const player = user(20),
    before = player.GetDynamicInfoSnapshot();
  for (const delta of [NaN, Infinity, 0.1, 0x80000000, -0x80000001]) {
    expect(() => player.IncDecExp(delta)).toThrow();
    expect(player.GetDynamicInfoSnapshot()).toEqual(before);
  }
  player.m_userInfo.Exp = NaN;
  expect(() => player.IncDecExp(1)).toThrow();
  expect(player.GetDynamicInfoSnapshot().DynamicModified).toBe(0);
});
test("fake level is signed32 offset, clamped 1..450, independent of icon enable/SN", () => {
  const player = user(g_nLevel2ExpTable[99]!);
  for (const [fake, look] of [
    [0, 100],
    [-99, 1],
    [-100, 1],
    [350, 450],
    [1000, 450],
    [0x7fffffff, 1],
    [-0x80000000, 1],
  ]) {
    player.SetFakeLevel(fake!);
    expect(player.GetFakeLevel()).toBe(fake!);
    expect(player.GetLookLevel()).toBe(look!);
  }
  player.SetFakeLevel(10);
  player.SetLevelIcon(1, -1);
  expect(player.GetLevel()).toBe(100);
  expect(player.GetLookLevel()).toBe(110);
  const packet = new CSendPacket(121);
  player.AppendSimpleInfoPacket(packet);
  const p = Received(packet);
  p.Decode1();
  expect(p.DecodeStr()).toBe("User");
  p.Decode1();
  expect(p.Decode2()).toBe(110);
  expect(p.Decode4()).toBe(0xffffffff);
  p.Decode4();
  p.Decode2();
  expect(p.remaining).toBe(0);
  player.SetLevelIcon(0, 123);
  expect(player.GetLevelIconSn()).toBe(123);
  const withoutIcon = new CSendPacket(121);
  player.AppendSimpleInfoPacket(withoutIcon);
  const q = Received(withoutIcon);
  q.Decode1();
  q.DecodeStr();
  q.Decode1();
  q.Decode2();
  expect(q.Decode4()).toBe(0);
  expect(player.GetDynamicInfoSnapshot().SimpleInfoModified).toBe(0);
  for (const n of [NaN, 0.5, 0x80000000]) {
    expect(() => player.SetFakeLevel(n)).toThrow();
    expect(() => player.SetLevelIcon(n, 0)).toThrow();
  }
});
test("Win/Draw/Lose wrap signed32, while IncGame affects only the unsigned flush counter", () => {
  const player = user();
  for (let i = 0; i < UserDynamicRule.GamesPerNativeFlush + 1; i++)
    player.IncGame();
  expect(player.GetDynamicInfoSnapshot().GamesSinceFlush).toBe(26);
  expect(player.GetDynamicInfoSnapshot().DynamicModified).toBe(0);
  expect(player.GetDynamicInfoSnapshot().SimpleInfoModified).toBe(0);
  player.m_userInfo.Win =
    player.m_userInfo.Draw =
    player.m_userInfo.Lose =
      0x7fffffff;
  player.IncWin();
  player.IncDraw();
  player.IncLose();
  expect([
    player.m_userInfo.Win,
    player.m_userInfo.Draw,
    player.m_userInfo.Lose,
  ]).toEqual([-0x80000000, -0x80000000, -0x80000000]);
  expect(player.GetDynamicInfoSnapshot().DynamicModified).toBe(1);
  expect(player.GetDynamicInfoSnapshot().SimpleInfoModified).toBe(0);
  expect(player.GetDynamicInfoSnapshot().GamesSinceFlush).toBe(26); // no invented automatic flush
});
test("detached result copy preserves native cached/dirty fields without socket/inventory ownership", () => {
  const player = user(100);
  player.SetFakeLevel(7);
  player.SetLevelIcon(1, 999);
  player.SetAuthenCode(1);
  player.IncGame();
  player.IncWin();
  player.SetSimpleInfoModified(7);
  const before = player.GetDynamicInfoSnapshot(),
    clone = player.CloneForResultCalculation();
  expect(clone.GetDynamicInfoSnapshot()).toEqual(before);
  expect(clone.GetAuthencode()).toBe(1);
  expect(clone.m_userInfo).not.toBe(player.m_userInfo);
  expect(clone.m_pClientSocket).toBeUndefined();
  expect(clone.GetSelfidx()).toBe(-1);
  expect(clone.m_aInventory).toEqual([]);
  clone.IncDecExp(100);
  clone.IncLose();
  expect(player.GetDynamicInfoSnapshot()).toEqual(before);
});

test("SQLite batch commits all absolute dynamic fields, not TicketDate/account data", async () => {
  const db = open(),
    changes = await accounts(db);
  db.session.db.query("UPDATE FxUserDynamic SET TicketDate = 12345").run();
  expect(db.UpdateUserDynamicBatch(changes)).toBe(true);
  for (const { After } of changes) {
    expect(dynamic(db, After.ID)).toEqual(After);
    expect(db.GetUserInfo(After.ID)!.TicketDate).toBe(12345);
    expect(db.GetUserInfo(After.ID)!.TotalConn).toBe(0);
  }
  expect(db.UpdateUserDynamicBatch(changes)).toBe(false); // stale snapshot, no second award
  db.session.IntegrityCheck();
});
test("last-user stale values roll back earlier users, including untouched Money conflicts", async () => {
  const db = open(),
    changes = await accounts(db);
  expect(db.SetMoney("B", 1)).toBe(true);
  expect(db.UpdateUserDynamicBatch(changes)).toBe(false);
  expect(dynamic(db, "A")).toEqual(changes[0]!.Before);
  expect(dynamic(db, "B")).toEqual({ ...changes[1]!.Before, Money: 1 });
  db.session.IntegrityCheck();
});
test("missing final user rolls back the earlier write", async () => {
  const db = open(),
    changes = await accounts(db),
    last = changes[1]!;
  const missing = {
    Before: { ...last.Before, ID: "Missing" },
    After: { ...last.After, ID: "Missing" },
  };
  expect(db.UpdateUserDynamicBatch([changes[0]!, missing])).toBe(false);
  expect(dynamic(db, "A")).toEqual(changes[0]!.Before);
  expect(dynamic(db, "B")).toEqual(changes[1]!.Before);
});
test("SQLite error in final update rolls back the first and is not disguised as conflict", async () => {
  const db = open(),
    changes = await accounts(db);
  db.session.db.exec(`CREATE TEMP TRIGGER RejectB BEFORE UPDATE ON FxUserDynamic
    WHEN NEW.ID = 'B' BEGIN SELECT RAISE(ABORT, 'forced final-user error'); END`);
  expect(() => db.UpdateUserDynamicBatch(changes)).toThrow(
    "forced final-user error",
  );
  for (const { Before } of changes)
    expect(dynamic(db, Before.ID)).toEqual(Before);
  db.session.IntegrityCheck();
});
test("validation rejects sparse/empty/oversize batches, renames and ASCII-NOCASE aliases before writes", async () => {
  const db = open(),
    changes = await accounts(db),
    first = changes[0]!;
  for (const bad of [
    [],
    new Array<UserDynamicChange>(2),
    Array(9).fill(first),
    [first, first],
    [
      first,
      {
        Before: { ...first.Before, ID: "a" },
        After: { ...first.After, ID: "a" },
      },
    ],
    [
      first,
      {
        Before: { ...changes[1]!.Before },
        After: { ...changes[1]!.After, ID: "C" },
      },
    ],
  ])
    expect(() => db.UpdateUserDynamicBatch(bad)).toThrow();
  for (const { Before } of changes)
    expect(dynamic(db, Before.ID)).toEqual(Before);
});
test("negative native counter overflow/invalid numeric snapshots cannot partially persist", async () => {
  const db = open(),
    changes = await accounts(db);
  for (const field of ["Money", "Exp", "Win", "Draw", "Lose"] as const)
    for (const bad of [-0x80000000, -1, NaN, Infinity, 0.5, 0x80000000]) {
      const last = changes[1]!;
      expect(() =>
        db.UpdateUserDynamicBatch([
          changes[0]!,
          { Before: last.Before, After: { ...last.After, [field]: bad } },
        ]),
      ).toThrow();
      expect(() =>
        db.UpdateUserDynamicBatch([
          changes[0]!,
          { Before: { ...last.Before, [field]: bad }, After: last.After },
        ]),
      ).toThrow();
      expect(dynamic(db, "A")).toEqual(changes[0]!.Before);
      expect(dynamic(db, "B")).toEqual(changes[1]!.Before);
    }
});
test("bound ID lookup permits case-insensitive canonical matching and SQL metacharacters", async () => {
  const db = open();
  await db.RegisterNewUser({ ID: "x'OR'1'='1", Password: "test" });
  const before = dynamic(db, "x'OR'1'='1");
  expect(
    db.UpdateUserDynamicBatch([
      { Before: before, After: { ...before, Exp: 1 } },
    ]),
  ).toBe(true);
  await db.RegisterNewUser({ ID: "Alice", Password: "test" });
  const lowercase = { ...dynamic(db, "Alice"), ID: "alice" };
  expect(
    db.UpdateUserDynamicBatch([
      { Before: lowercase, After: { ...lowercase, Win: 1 } },
    ]),
  ).toBe(true);
  expect(db.GetUserInfo("ALICE")!.Win).toBe(1);
});
test("SQLite ASCII-NOCASE duplicate defense does not Unicode-fold distinct Big5 names", async () => {
  const db = open();
  for (const ID of ["Ａ", "ａ"])
    await db.RegisterNewUser({ ID, Password: "test" });
  const changes = ["Ａ", "ａ"].map((id) => {
    const before = dynamic(db, id);
    return { Before: before, After: { ...before, Win: 1 } };
  });
  expect(db.UpdateUserDynamicBatch(changes)).toBe(true);
  expect(db.GetUserInfo("Ａ")!.Win).toBe(1);
  expect(db.GetUserInfo("ａ")!.Win).toBe(1);
});
test("separate SQLite connection changing money invalidates the complete prior snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-dynamic-"));
  paths.push(dir);
  const db = open(join(dir, "test.sqlite")),
    changes = await accounts(db),
    other = open(db.session.path);
  expect(other.SetMoney("B", 5)).toBe(true);
  expect(db.UpdateUserDynamicBatch(changes)).toBe(false);
  expect(dynamic(other, "A")).toEqual(changes[0]!.Before);
  expect(db.GetUserInfo("B")!.Money).toBe(5);
  db.session.IntegrityCheck();
  other.session.IntegrityCheck();
});
test("batch is optimistic CAS only, not a durable round receipt or ABA/exactly-once claim", async () => {
  const db = open(),
    changes = await accounts(db);
  expect(db.UpdateUserDynamicBatch(changes)).toBe(true);
  for (const { Before } of changes)
    db.UpdateUserDynamic(
      Before.ID,
      Before.Money,
      Before.Exp,
      Before.Win,
      Before.Draw,
      Before.Lose,
    );
  // Deliberately demonstrates the boundary: reverting all compared fields makes
  // an old snapshot match again. The live payout lifecycle MUST add its guard.
  expect(db.UpdateUserDynamicBatch(changes)).toBe(true);
  const unchanged = { Before: dynamic(db, "A"), After: dynamic(db, "A") };
  expect(db.UpdateUserDynamicBatch([unchanged])).toBe(true);
  expect(db.UpdateUserDynamicBatch([unchanged])).toBe(true);
});
