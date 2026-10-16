import { expect, test } from "bun:test";
import { CDBClock } from "../Common/DB/CDBClock.ts";
import { CTime, StrictCalendarEnvironment } from "../Common/CTime.ts";
import { StrictSystemTimeToVariantTime } from "../Common/Calendar.ts";
import {
  Get_FieldDate,
  type tagDBTIMESTAMP,
} from "../Common/DB/NativeCalendar.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { PlanInitUserInventory } from "../FXGS/UserInventory.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { PreCatalog } from "./helpers/PreInventory.ts";
import {
  DBTime,
  SystemTime,
  TimeArray,
  VariantHex,
  CalendarVectors,
} from "./helpers/Calendar.ts";

function setup(input = DBTime()) {
  let now = 100;
  const clock = new CDBClock(() => now),
    env = StrictCalendarEnvironment(() => clock.GetLocalTime());
  clock.SyncLocalTimeFromDB(0, input);
  return {
    clock,
    env,
    set(value: number) {
      now = value;
    },
    tick(ms: number) {
      now += ms;
    },
  };
}

test("ALL1680 independent clock advances use isolated civil arithmetic/CTime and exact DATE bytes; range overflow retires anchor, never wraps into valid inventory eligibility", () => {
  let count = 0;
  for (const c of CalendarVectors.Cases) {
    if (!c.Advances.length) continue;
    const e = setup(c.Input);
    expect(e.clock.GetState()).toEqual({ Synchronized: true, Revision: 1 });
    for (const a of c.Advances) {
      e.set(100 + a.Delta);
      if (a.System === null) {
        expect(() => e.clock.GetLocalTime()).toThrow("range");
        expect(e.clock.GetState()).toEqual({
          Synchronized: false,
          Revision: 2,
        });
        expect(() => e.clock.GetLocalTime()).toThrow("not synchronized");
      } else {
        expect(TimeArray(e.clock.GetLocalTime())).toEqual(a.System);
        expect<unknown>(
          VariantHex(CTime.GetTickCount(e.env).GetVariantTime()),
        ).toBe(a.VariantHex);
        expect(e.clock.GetState()).toEqual({ Synchronized: true, Revision: 1 });
      }
      count++;
    }
  }
  expect(count).toBe(1680);
});

test("negative signed/unsigned observed ExecResult never reads timestamp OR monotonic port and preserves existing private clock", () => {
  let reads = 0;
  const clock = new CDBClock(() => {
    reads++;
    return 100;
  });
  clock.SyncLocalTimeFromDB(0, DBTime());
  const before = clock.GetState(),
    initial = reads,
    bad = Object.defineProperty({}, "year", {
      get() {
        throw new Error("MUST NOT inspect failed DB output");
      },
    }) as tagDBTIMESTAMP;
  for (const exec of [-1, -2147483648, 0x80000000, 0xffffffff])
    expect(clock.SyncLocalTimeFromDB(exec, bad)).toBe(false);
  expect(reads).toBe(initial);
  expect(clock.GetState()).toEqual(before);
  for (const exec of [NaN, Infinity, -2147483649, 0x100000000, 0.5])
    expect(() => clock.SyncLocalTimeFromDB(exec, DBTime())).toThrow(
      "ExecResult",
    );
  expect(reads).toBe(initial);
});

test("invalid replacement civil data fails BEFORE clock sampling and preserves previous anchor/revision; native field-copy validity is not API success", () => {
  let reads = 0;
  const clock = new CDBClock(() => {
    reads++;
    return 100;
  });
  clock.SyncLocalTimeFromDB(0, DBTime());
  const state = clock.GetState(),
    initial = reads;
  for (const partial of [
    { year: 50 },
    { month: 13 },
    { day: 0 },
    { year: 1900, month: 2, day: 29 },
    { hour: 24 },
    { second: 60 },
  ]) {
    expect(() => clock.SyncLocalTimeFromDB(0, DBTime(partial))).toThrow(
      "strict Gregorian",
    );
    expect(clock.GetState()).toEqual(state);
  }
  expect(reads).toBe(initial);
  expect(clock.GetLocalTime().wYear).toBe(2026);
});

test("DB fractions are discarded, ms progress is private/monotonic and SAME-value trusted resync creates a new generation instead of ABA", () => {
  const e = setup(DBTime({ fraction: 999999999 }));
  expect(e.clock.GetLocalTime().wMilliseconds).toBe(0);
  e.tick(999);
  expect(e.clock.GetLocalTime().wMilliseconds).toBe(999);
  expect(new CTime(e.env).GetSecond()).toBe(5);
  e.tick(1);
  expect(new CTime(e.env).GetSecond()).toBe(6);
  expect(e.clock.SyncLocalTimeFromDB(2147483647, DBTime())).toBe(true);
  expect(e.clock.GetState()).toEqual({ Synchronized: true, Revision: 2 });
  expect(e.clock.GetLocalTime().wSecond).toBe(5);
});

test("invalid/backwards monotonic samples cancel the old anchor; recovering clock values alone CANNOT resurrect it without NEW explicit trusted synchronization", () => {
  for (const value of [
    NaN,
    Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    99,
  ]) {
    const e = setup();
    e.set(value);
    expect(() => e.clock.GetLocalTime()).toThrow("clock");
    expect(e.clock.GetState()).toEqual({ Synchronized: false, Revision: 2 });
    e.set(100);
    expect(() => e.clock.GetLocalTime()).toThrow("not synchronized");
    expect(e.clock.SyncLocalTimeFromDB(0, DBTime())).toBe(true);
    expect(e.clock.GetState()).toEqual({ Synchronized: true, Revision: 3 });
  }
});

test("a sync-time monotonic exception also invalidates old anchor, but a malformed DB timestamp getter never publishes or poisons a prior valid clock", () => {
  let fail = false;
  const clock = new CDBClock(() => {
    if (fail) throw new Error("injected monotonic failure");
    return 100;
  });
  clock.SyncLocalTimeFromDB(0, DBTime());
  const bad = Object.defineProperty({}, "year", {
    get() {
      throw new Error("injected DB observation");
    },
  }) as tagDBTIMESTAMP;
  expect(() => clock.SyncLocalTimeFromDB(0, bad)).toThrow("DB observation");
  expect(clock.GetState()).toEqual({ Synchronized: true, Revision: 1 });
  fail = true;
  expect(() => clock.SyncLocalTimeFromDB(0, DBTime())).toThrow(
    "monotonic failure",
  );
  expect(clock.GetState()).toEqual({ Synchronized: false, Revision: 2 });
});

test("clock reentry guards encompass DB getters AND monotonic callouts; nested reads/sync cannot replace the outer in-flight anchor", () => {
  let blocked = 0;
  const clock = new CDBClock(() => {
    expect(() => clock.GetLocalTime()).toThrow("Reentrant");
    expect(() => clock.SyncLocalTimeFromDB(0, DBTime())).toThrow("Reentrant");
    blocked += 2;
    return 100;
  });
  const input = DBTime();
  Object.defineProperty(input, "fraction", {
    get() {
      expect(() => clock.SyncLocalTimeFromDB(0, DBTime())).toThrow("Reentrant");
      blocked++;
      return 0;
    },
  });
  clock.SyncLocalTimeFromDB(0, input);
  expect(blocked).toBe(3);
  expect(clock.GetLocalTime().wYear).toBe(2026);
  expect(blocked).toBe(5);
  expect(clock.GetState()).toEqual({ Synchronized: true, Revision: 1 });
});

test("9999 end-of-range progresses milliseconds without clipping; huge elapsed/civil overflow retires rather than clamping or precision-losing", () => {
  const input = DBTime({
      year: 9999,
      month: 12,
      day: 31,
      hour: 23,
      minute: 59,
      second: 59,
    }),
    e = setup(input);
  e.tick(999);
  expect(TimeArray(e.clock.GetLocalTime())).toEqual([
    9999, 12, 5, 31, 23, 59, 59, 999,
  ]);
  e.tick(1);
  expect(() => e.clock.GetLocalTime()).toThrow("range");
  expect(e.clock.GetState().Synchronized).toBe(false);
  const huge = setup();
  huge.set(Number.MAX_SAFE_INTEGER);
  expect(() => huge.clock.GetLocalTime()).toThrow("range");
  expect(huge.clock.GetState().Synchronized).toBe(false);
});

test("revision exhaustion rejects sync BEFORE getters/monotonic work; later clock fault clears anchor without wrapping max revision", () => {
  let now = 100,
    reads = 0;
  const clock = new CDBClock(() => {
    reads++;
    return now;
  });
  clock.SyncLocalTimeFromDB(0, DBTime());
  Reflect.set(clock, "m_nRevision", 0xffffffff);
  const initial = reads,
    bad = Object.defineProperty({}, "year", {
      get() {
        throw new Error("should not read input");
      },
    }) as tagDBTIMESTAMP;
  expect(() => clock.SyncLocalTimeFromDB(0, bad)).toThrow("exhausted");
  expect(reads).toBe(initial);
  expect(clock.GetState()).toEqual({
    Synchronized: true,
    Revision: 0xffffffff,
  });
  now = 99;
  expect(() => clock.GetLocalTime()).toThrow("backwards");
  expect(clock.GetState()).toEqual({
    Synchronized: false,
    Revision: 0xffffffff,
  });
  now = 100;
  expect(() => clock.SyncLocalTimeFromDB(0, DBTime())).toThrow("exhausted");
});

test("independent server clocks share NO static calendar state/host timezone, and unsynchronized clocks refuse before monotonic sampling", () => {
  let reads = 0;
  const empty = new CDBClock(() => {
    reads++;
    return 0;
  });
  expect(() => empty.GetLocalTime()).toThrow("not synchronized");
  expect(reads).toBe(0);
  const a = setup(DBTime({ year: 2000 })),
    b = setup(DBTime({ year: 2030 }));
  a.tick(86400000);
  expect(a.clock.GetLocalTime().wYear).toBe(2000);
  expect(a.clock.GetLocalTime().wDay).toBe(3);
  expect(b.clock.GetLocalTime().wYear).toBe(2030);
  expect(b.clock.GetLocalTime().wDay).toBe(2);
});

test("explicit native DB timestamp -> rowset calendar -> CTime raw DATE -> EXISTING owned loader -> CUser201, with NO legacy SN/ItemID or DB mutations", () => {
  const e = setup(),
    stored = new CTime(e.env, Get_FieldDate(DBTime({ day: 3 }))),
    record = NativeInventory({
      ItemSn: 7,
      StockSn: 99999,
      DateCreated: stored.GetVariantTime(),
      Verbose: "calendar resident",
    }),
    catalog = PreCatalog([]);
  const definition = {
      SN: 7,
      Category: 2,
      strAttr: "native attribute",
      nAttr1: 1,
      nAttr2: 0,
      nAttr3: -1,
      strName: "NOT owned verbose",
    },
    bound = {
      ...catalog,
      Count: 1,
      GetUserItem: (sn: number) => (sn === 7 ? definition : undefined),
    };
  const plan = PlanInitUserInventory([record], bound, 1, () =>
      new CTime(e.env).GetVariantTime(),
    ),
    user = new CUser(UserInfo("Calendar"), 1);
  user.InstallUserInventory(plan.Rows, plan.Equipment);
  const packet = new CSendPacket(201).Encode1(1);
  user.MakeUserInventoryPacket(packet);
  expect(plan.Rows).toHaveLength(1);
  expect(plan.ClockReads).toBe(1);
  expect(plan.DeleteAttempts).toEqual([]);
  expect(packet.GetBuffer().subarray(-8).toString("hex")).toBe(
    VariantHex(stored.GetVariantTime()),
  );
  expect(user.m_aInventory).toEqual([]);
  expect(user.CaptureUserInventory()!.Rows[0]!.StockSn).toBe(99999);
  expect(user.m_userInfo.Money).toBe(0);
  expect(user.m_userInfo.Exp).toBe(0);
});

test("second-resolution strict > DATE expiry survives999ms, expires at next second; missing definition NEVER reads calendar while level-invalid STILL does", () => {
  const e = setup(),
    date = new CTime(e.env, Get_FieldDate(DBTime())).GetVariantTime(),
    row = NativeInventory({ DateCreated: date }),
    definition = {
      SN: 7,
      Category: 2,
      strAttr: "attr",
      nAttr1: 0,
      nAttr2: 0,
      nAttr3: 0,
      strName: "name",
    },
    catalog = { Revision: 1, Count: 1, GetUserItem: () => definition };
  e.tick(999);
  const equal = PlanInitUserInventory([row], catalog, 1, () =>
    new CTime(e.env).GetVariantTime(),
  );
  expect(equal.Rows).toHaveLength(1);
  e.tick(1);
  const expired = PlanInitUserInventory([row], catalog, 1, () =>
    new CTime(e.env).GetVariantTime(),
  );
  expect(expired.DeleteAttempts[0]!.DateExpired).toBe(true);
  let reads = 0;
  const clock = () => {
    reads++;
    return new CTime(e.env).GetVariantTime();
  };
  const missing = PlanInitUserInventory(
    [row],
    { ...catalog, GetUserItem: () => undefined },
    1,
    clock,
  );
  expect(missing.ClockReads).toBe(0);
  expect(reads).toBe(0);
  const level = PlanInitUserInventory(
    [{ ...row, LevelCreated: 1 }],
    catalog,
    1,
    clock,
  );
  expect(level.DeleteAttempts[0]!.LevelExpired).toBe(true);
  expect(reads).toBe(1);
});

test("negative DATE raw-comparison quirk is NOT repaired into chronological expiry: later civil afternoon has numerically SMALLER DATE on a pre-epoch day", () => {
  const e = setup(
      DBTime({ year: 1899, month: 12, day: 29, hour: 6, minute: 0, second: 0 }),
    ),
    stored = new CTime(e.env).GetVariantTime();
  e.tick(12 * 60 * 60 * 1000);
  const now = new CTime(e.env).GetVariantTime();
  expect(stored).toBe(-1.25);
  expect(now).toBe(-1.75);
  const catalog = {
      Revision: 1,
      Count: 1,
      GetUserItem: () => ({
        SN: 7,
        Category: 2,
        strAttr: "attr",
        nAttr1: 0,
        nAttr2: 0,
        nAttr3: 0,
        strName: "name",
      }),
    },
    plan = PlanInitUserInventory(
      [NativeInventory({ DateCreated: stored })],
      catalog,
      1,
      () => now,
    );
  expect(plan.Rows).toHaveLength(1);
  expect(plan.DeleteAttempts).toEqual([]);
  expect(
    StrictSystemTimeToVariantTime(
      SystemTime({
        wYear: 1899,
        wMonth: 12,
        wDay: 29,
        wHour: 18,
        wMinute: 0,
        wSecond: 0,
      }),
    ),
  ).toBe(now);
});

test("isolated clock/calendar conversions DO NOT migrate/read legacy pre, mutate SQL/receipts or reinterpret legacy201 Unix expiry bridge", () => {
  const session = new CDBSession(":memory:");
  try {
    const db = new CDBMan(session);
    session.db.exec(
      "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES('Legacy',0,'disabled-test-fixture');INSERT INTO FxUserDynamic(ID) VALUES('Legacy')",
    );
    const row = db.AddInventory("Legacy", 7, 3, 0xffffffff, "legacy"),
      user = new CUser(db.GetUserInfo("Legacy")!, 1);
    user.m_aInventory = [row];
    const before = new CSendPacket(201);
    user.MakeUserInventoryPacket(before);
    const changes = session.db
      .query<{ n: number }, []>("SELECT total_changes() AS n")
      .get()!.n;
    const clock = setup();
    clock.tick(1000);
    expect(Number.isFinite(new CTime(clock.env).GetVariantTime())).toBe(true);
    db.ConvertDBTimeToSystemTime(DBTime());
    const after = new CSendPacket(201);
    user.MakeUserInventoryPacket(after);
    expect(after.GetBuffer()).toEqual(before.GetBuffer());
    expect(user.GetUserInventoryGeneration().Native).toBe(false);
    expect(
      session.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!
        .n,
    ).toBe(changes);
    expect(session.db.query("PRAGMA user_version").get()).toEqual({
      user_version: 6,
    });
    for (const table of [
      "RuntimeGameResult",
      "RuntimeMoneyPickup",
      "RuntimeHouseClaim",
      "RuntimeSpecialItemUse",
    ])
      expect(
        session.db
          .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
          .get()!.n,
      ).toBe(0);
  } finally {
    session.Close();
  }
});

test("atomic captured local-time DTO binds one clock generation and stays frozen/detached across same-value resync; it is NOT a transferable financial grant", () => {
  const e = setup(),
    old = e.clock.CaptureLocalTime();
  expect(Object.isFrozen(old)).toBe(true);
  expect(Object.isFrozen(old.Time)).toBe(true);
  expect(old.Revision).toBe(1);
  expect(old.Time.wSecond).toBe(5);
  e.tick(1000);
  e.clock.SyncLocalTimeFromDB(0, DBTime());
  const next = e.clock.CaptureLocalTime();
  expect(next.Revision).toBe(2);
  expect(old.Revision).toBe(1);
  expect(old.Time).toEqual(next.Time);
  expect(old).not.toBe(next);
  expect(old.Time).not.toBe(next.Time);
});
