import { expect, test } from "bun:test";
import {
  CTime,
  StrictCalendarEnvironment,
  type CTimeEnvironment,
} from "../Common/CTime.ts";
import {
  CaptureSystemTime,
  CivilTimeMilliseconds,
  StrictSystemTimeToVariantTime,
  SystemTimeFromCivilMilliseconds,
  type _SYSTEMTIME,
} from "../Common/Calendar.ts";
import {
  CaptureDBTimestamp,
  ReadDBTimestamp,
  ConvertDBTimeToSystemTime,
  ConvertSystemTimeToDBTime,
  Get_FieldDate,
} from "../Common/DB/NativeCalendar.ts";
import { CDBClock } from "../Common/DB/CDBClock.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBManBase } from "../Common/DB/CDBManBase.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CipherDegree, NativeTimeFormat } from "../Common/OfficialValues.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import {
  SystemTime,
  DBTime,
  TimeArray,
  VariantHex,
  CalendarVectors,
} from "./helpers/Calendar.ts";

const env = StrictCalendarEnvironment(() => {
  throw new Error("NO implicit local clock");
});

test("30 fixed PE anchors /THREE full or prefix-identical LS-GS routines prove DB ms ZERO versus rowset ms+weekday UNWRITTEN; no original binary executes", () => {
  const fx = new CPeImage(OFFICIAL_SERVICES.FXGS),
    ls = new CPeImage(OFFICIAL_SERVICES.LS);
  expect(CalendarVectors.OfficialPE).toEqual({
    FXGS: fx.sha256,
    LS: ls.sha256,
  });
  expect(CalendarVectors.InstructionAnchors).toHaveLength(30);
  for (const a of CalendarVectors.InstructionAnchors)
    expect(
      (a.Service === "FXGS" ? fx : ls)
        .read(a.VA, a.Bytes.length / 2)
        .toString("hex"),
    ).toBe(a.Bytes);
  for (const r of CalendarVectors.SharedRoutines)
    expect(fx.read(r.FXGS, r.Size)).toEqual(ls.read(r.LS, r.Size));
  expect(NativeTimeFormat.DBTimestampBytes).toBe(16);
  expect(NativeTimeFormat.SystemTimeBytes).toBe(16);
  expect(CalendarVectors.Profile).toContain("STRICT");
});

test("ALL2773 independent C++ calendar cases match timestamp bytes, BOTH native mapping cores, signed reverse/fraction0 and strict DATE f64; invalid native fields stay unmapped to a fake date", () => {
  expect(CalendarVectors.Cases).toHaveLength(2773);
  for (const c of CalendarVectors.Cases) {
    const input = ReadDBTimestamp(Buffer.from(c.InputHex, "hex")),
      db = ConvertDBTimeToSystemTime(input),
      row = Get_FieldDate(input);
    expect(input).toEqual(c.Input);
    expect(TimeArray(db)).toEqual(c.DBSystem);
    expect(TimeArray(row)).toEqual(c.RowSystem);
    expect(ConvertSystemTimeToDBTime(db)).toEqual(c.Reverse);
    expect(ConvertSystemTimeToDBTime(row)).toEqual(c.Reverse);
    const time = new CTime(env, row);
    if (c.VariantHex === null) {
      expect(() => time.GetVariantTime()).toThrow("strict Gregorian");
      continue;
    }
    expect(VariantHex(StrictSystemTimeToVariantTime(row))).toBe(c.VariantHex);
    expect(VariantHex(time.GetVariantTime())).toBe(c.VariantHex);
  }
});

test("ALL2748 supported calendar cases feed REAL CUser native201 in plain/scalar modes: DATE stays raw LE8, never Unix/DWORD/scalar encoded", () => {
  let count = 0;
  for (const c of CalendarVectors.Cases) {
    if (c.VariantHex === null) continue;
    const date = new CTime(env, Get_FieldDate(c.Input)).GetVariantTime(),
      user = new CUser(UserInfo("Calendar"), 1);
    user.InstallUserInventory([
      NativeInventory({
        ItemSn: 0x80000000,
        Slot: 255,
        DateCreated: date,
        Verbose: "calendar",
      }),
    ]);
    for (const [cipher, expected] of [
      [CipherDegree.CRC8, c.PacketHex],
      [CipherDegree.None, c.PlainPacketHex],
    ] as const) {
      const p = new CSendPacket(201, cipher).Encode1(1);
      user.MakeUserInventoryPacket(p);
      expect<unknown>(p.GetBuffer().toString("hex")).toBe(expected);
    }
    count++;
  }
  expect(count).toBe(2748);
}, 15000);

test("known Gregorian/OLE goldens include epoch0, negative ABS fraction, seconds,1970 and2000 without using JS Date", () => {
  const dates = [
    [
      SystemTime({
        wYear: 1899,
        wMonth: 12,
        wDay: 30,
        wHour: 0,
        wMinute: 0,
        wSecond: 0,
      }),
      0,
    ],
    [
      SystemTime({
        wYear: 1899,
        wMonth: 12,
        wDay: 29,
        wHour: 6,
        wMinute: 0,
        wSecond: 0,
      }),
      -1.25,
    ],
    [
      SystemTime({
        wYear: 1899,
        wMonth: 12,
        wDay: 29,
        wHour: 18,
        wMinute: 0,
        wSecond: 0,
      }),
      -1.75,
    ],
    [
      SystemTime({
        wYear: 1900,
        wMonth: 1,
        wDay: 1,
        wHour: 12,
        wMinute: 0,
        wSecond: 0,
      }),
      2.5,
    ],
    [
      SystemTime({
        wYear: 1970,
        wMonth: 1,
        wDay: 1,
        wHour: 0,
        wMinute: 0,
        wSecond: 0,
      }),
      25569,
    ],
    [
      SystemTime({
        wYear: 2000,
        wMonth: 1,
        wDay: 1,
        wHour: 0,
        wMinute: 0,
        wSecond: 0,
      }),
      36526,
    ],
  ] as const;
  for (const [time, expected] of dates)
    expect(StrictSystemTimeToVariantTime(time)).toBe(expected);
  const epoch = dates[0]![0];
  expect(StrictSystemTimeToVariantTime({ ...epoch, wSecond: 1 })).toBe(
    1 / 86400,
  );
});

test("seconds are INCLUDED; ms and weekday are ignored even when explicitly unknown or unusual WORDs, not fabricated from DB fraction", () => {
  const t = SystemTime(),
    expected = StrictSystemTimeToVariantTime(t);
  for (const wMilliseconds of [null, 0, 1, 999, 65535])
    for (const wDayOfWeek of [null, 0, 7, 65535])
      expect(
        StrictSystemTimeToVariantTime({ ...t, wMilliseconds, wDayOfWeek }),
      ).toBe(expected);
  expect(
    StrictSystemTimeToVariantTime({ ...t, wSecond: t.wSecond + 1 }),
  ).not.toBe(expected);
  expect(
    StrictSystemTimeToVariantTime(
      Get_FieldDate(DBTime({ fraction: 0xffffffff })),
    ),
  ).toBe(expected);
});

test("strict profile deliberately REJECTS API day rolling and OS-dependent00..99 years, as well as invalid centuries/time components", () => {
  const invalid: Partial<_SYSTEMTIME>[] = [
    ...[0, 29, 30, 49, 50, 99, 10000, 65535].map((wYear) => ({ wYear })),
    { wMonth: 0 },
    { wMonth: 13 },
    { wDay: 0 },
    { wDay: 32 },
    { wMonth: 2, wDay: 30 },
    { wYear: 1900, wMonth: 2, wDay: 29 },
    { wYear: 2100, wMonth: 2, wDay: 29 },
    { wHour: 24 },
    { wMinute: 60 },
    { wSecond: 60 },
  ];
  for (const p of invalid)
    expect(() => StrictSystemTimeToVariantTime(SystemTime(p))).toThrow(
      "strict Gregorian",
    );
  for (const wYear of [400, 1600, 2000, 2400])
    expect(
      Number.isFinite(
        StrictSystemTimeToVariantTime(
          SystemTime({ wYear, wMonth: 2, wDay: 29 }),
        ),
      ),
    ).toBe(true);
});

test("DBMan ZERO milliseconds is NOT rowset UNWRITTEN; explicit unwritten-word observations don't leak fraction or old CTime values", () => {
  const input = DBTime({ fraction: 0xffffffff }),
    db = ConvertDBTimeToSystemTime(input),
    row = Get_FieldDate(input),
    observed = Get_FieldDate(input, { wDayOfWeek: 7, wMilliseconds: 65535 });
  expect([db.wDayOfWeek, db.wMilliseconds]).toEqual([null, 0]);
  expect([row.wDayOfWeek, row.wMilliseconds]).toEqual([null, null]);
  expect([observed.wDayOfWeek, observed.wMilliseconds]).toEqual([7, 65535]);
  expect(ConvertDBTimeToSystemTime(input, 6).wDayOfWeek).toBe(6);
  expect(ConvertSystemTimeToDBTime(observed).fraction).toBe(0);
  const t = new CTime(env, SystemTime({ wDayOfWeek: 3, wMilliseconds: 777 }));
  t.SetTime(row);
  expect([
    t.GetAsSystemTime().wDayOfWeek,
    t.GetAsSystemTime().wMilliseconds,
  ]).toEqual([null, null]);
  expect(() => t.GetDayOfWeek()).toThrow("not observed");
});

test("signed/unsigned SHORT year spellings preserve WORD bits through BOTH mapping cores and signed reverse; no1900 offset is invented", () => {
  for (const year of [-32768, -1, 32768, 65535]) {
    const input = DBTime({ year });
    expect(CaptureDBTimestamp(input).year).toBe((year << 16) >> 16);
    for (const t of [Get_FieldDate(input), ConvertDBTimeToSystemTime(input)]) {
      expect(t.wYear).toBe(year & 0xffff);
      expect(ConvertSystemTimeToDBTime(t).year).toBe((year << 16) >> 16);
      expect(() => StrictSystemTimeToVariantTime(t)).toThrow();
    }
  }
});

test("WORD/DWORD input validation is distinct from Gregorian validity; null is allowed ONLY for the two unobserved SYSTEMTIME words", () => {
  for (const value of [-1, 65536, 0.5, NaN, Infinity, undefined, "1", null])
    expect(() =>
      CaptureSystemTime(SystemTime({ wYear: value as number })),
    ).toThrow("SYSTEMTIME");
  for (const value of [-1, 65536, 0.5, NaN, Infinity, undefined])
    expect(() =>
      CaptureSystemTime(SystemTime({ wMilliseconds: value as number })),
    ).toThrow("SYSTEMTIME");
  for (const value of [-32769, 65536, NaN, Infinity, 1.5])
    expect(() => CaptureDBTimestamp(DBTime({ year: value }))).toThrow(
      "DBTIMESTAMP",
    );
  for (const value of [-1, 0x100000000, Infinity, NaN, 1.5])
    expect(() => CaptureDBTimestamp(DBTime({ fraction: value }))).toThrow(
      "DBTIMESTAMP",
    );
  expect(CaptureSystemTime(SystemTime({ wMonth: 0 })).wMonth).toBe(0);
  expect(() =>
    StrictSystemTimeToVariantTime(SystemTime({ wMonth: 0 })),
  ).toThrow();
});

test("all captured primitives latch once before later fields can mutate earlier input; frozen snapshots never alias caller objects", () => {
  const raw = SystemTime();
  Object.defineProperty(raw, "wMilliseconds", {
    get() {
      Reflect.set(raw, "wYear", 1999);
      return 0;
    },
  });
  const copy = CaptureSystemTime(raw);
  expect(copy.wYear).toBe(2026);
  expect(raw.wYear).toBe(1999);
  expect(Object.isFrozen(copy)).toBe(true);
  const db = DBTime();
  Object.defineProperty(db, "fraction", {
    get() {
      Reflect.set(db, "year", 1999);
      return 0;
    },
  });
  const captured = CaptureDBTimestamp(db);
  expect(captured.year).toBe(2026);
  expect(db.year).toBe(1999);
  expect(Object.isFrozen(captured)).toBe(true);
});

test("binary DBTIMESTAMP reader requires EXACT detached16 LE bytes, accepts offset views but never SQL text/Unix/NULL/status guesses", () => {
  const c = CalendarVectors.Cases[0]!,
    padded = Buffer.concat([
      Buffer.alloc(7),
      Buffer.from(c.InputHex, "hex"),
      Buffer.alloc(3),
    ]),
    view = padded.subarray(7, 23),
    result = ReadDBTimestamp(view);
  expect(result).toEqual(c.Input);
  view.fill(0);
  expect(result).toEqual(c.Input);
  expect(Object.isFrozen(result)).toBe(true);
  for (const input of [
    Buffer.alloc(0),
    Buffer.alloc(15),
    Buffer.alloc(17),
    c.InputHex,
    0,
    null,
  ])
    expect(() => ReadDBTimestamp(input as Uint8Array)).toThrow("exactly16");
});

test("CTime explicit ctor avoids sampling; default ctor/SetCurrentTime sample ONCE; GetAsSystemTime only copies and GetTickCount is calendar not WinMM", () => {
  let reads = 0;
  const input = SystemTime(),
    environment = StrictCalendarEnvironment(() => {
      reads++;
      return input;
    }),
    explicit = new CTime(environment, input);
  expect(reads).toBe(0);
  const current = new CTime(environment);
  expect(reads).toBe(1);
  Reflect.set(input, "wSecond", 9);
  expect(current.GetSecond()).toBe(5);
  current.SetCurrentTime();
  expect(reads).toBe(2);
  expect(current.GetSecond()).toBe(9);
  const copied = current.GetAsSystemTime();
  expect(reads).toBe(2);
  expect(Object.isFrozen(copied)).toBe(true);
  expect(copied).not.toBe(input);
  expect(CTime.GetTickCount(environment)).toBeInstanceOf(CTime);
  expect(reads).toBe(3);
  expect(explicit.GetSecond()).toBe(5);
});

test("native calendar getters/FormatTimePlain preserve raw WORDs and minimum-two-digit formatting; Sunday aliases0/7, unknown weekdays are not guessed", () => {
  const t = new CTime(env, SystemTime());
  expect([
    t.GetYear(),
    t.GetMonth(),
    t.GetDay(),
    t.GetHour(),
    t.GetMinute(),
    t.GetSecond(),
  ]).toEqual([2026, 1, 2, 3, 4, 5]);
  expect(t.FormatTimePlain()).toBe("0102030405");
  for (const [n, name] of [
    "Sun",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
    "Sun",
  ].entries()) {
    t.SetTime(SystemTime({ wDayOfWeek: n }));
    expect(t.GetDayOfWeekString()).toBe(name);
  }
  t.SetTime(SystemTime({ wMonth: 999, wDayOfWeek: 65535 }));
  expect(t.FormatTimePlain()).toBe("99902030405");
  expect(t.GetDayOfWeekString()).toBe("");
  t.SetTime(SystemTime({ wDayOfWeek: null }));
  expect(() => t.GetDayOfWeekString()).toThrow("not observed");
});

test("CTime refuses FALSE/indeterminate/NaN API outputs, but valid DATE0 is accepted and result primitives are read ONCE", () => {
  for (const result of [
    { Success: false, Value: 0 },
    { Success: true },
    { Success: true, Value: NaN },
    { Success: true, Value: Infinity },
  ]) {
    const t = new CTime(
      { ...env, SystemTimeToVariantTime: () => result },
      SystemTime(),
    );
    expect(() => t.GetVariantTime()).toThrow("indeterminate");
  }
  let reads = 0;
  const t = new CTime(
    {
      ...env,
      SystemTimeToVariantTime: () => ({
        Success: true,
        get Value() {
          reads++;
          return reads === 1 ? 0 : NaN;
        },
      }),
    },
    SystemTime(),
  );
  expect(t.GetVariantTime()).toBe(0);
  expect(reads).toBe(1);
});

test("CTime conversion latches frozen input before callback mutation and rejects recursive conversion; later environment swaps cannot change captured ports", () => {
  const original = SystemTime(),
    next = SystemTime({ wSecond: 6 }),
    environment: CTimeEnvironment = {
      GetLocalTime: () => original,
      SystemTimeToVariantTime: (time) => {
        expect(Object.isFrozen(time)).toBe(true);
        t.SetTime(next);
        expect(() => t.GetVariantTime()).toThrow("Reentrant");
        return { Success: true, Value: StrictSystemTimeToVariantTime(time) };
      },
    },
    t = new CTime(environment);
  Reflect.set(environment, "SystemTimeToVariantTime", () => ({
    Success: true,
    Value: 999,
  }));
  expect(t.GetVariantTime()).toBe(StrictSystemTimeToVariantTime(original));
  expect(t.GetVariantTime()).toBe(StrictSystemTimeToVariantTime(next));
});

test("CTime bad SetTime/clock failure leaves previous snapshot intact; nested SetCurrentTime/SetTime cannot overwrite a clock read", () => {
  let bad = false;
  const input = SystemTime(),
    environment = StrictCalendarEnvironment(() => {
      if (bad) throw new Error("injected local failure");
      return input;
    }),
    t = new CTime(environment);
  bad = true;
  expect(() => t.SetCurrentTime()).toThrow("local failure");
  expect(() => t.SetTime(SystemTime({ wSecond: 65536 }))).toThrow();
  expect(t.GetAsSystemTime()).toEqual(input);
  const nested = new CTime(
    StrictCalendarEnvironment(() => {
      expect(() => nested.SetCurrentTime()).toThrow("Reentrant");
      expect(() => nested.SetTime(input)).toThrow("Reentrant");
      return input;
    }),
    input,
  );
  nested.SetCurrentTime();
  expect(nested.GetAsSystemTime()).toEqual(input);
});

test("portable conversion/isolated clock do NOT access host Date APIs or mutate timezone", () => {
  const original = globalThis.Date,
    tz = process.env.TZ;
  let result = 0;
  try {
    Reflect.set(
      globalThis,
      "Date",
      new Proxy(original, {
        construct() {
          throw new Error("host Date forbidden");
        },
        apply() {
          throw new Error("host Date forbidden");
        },
        get(target, prop, receiver) {
          if (["now", "UTC", "parse"].includes(String(prop)))
            throw new Error("host Date forbidden");
          return Reflect.get(target, prop, receiver);
        },
      }),
    );
    const clock = new CDBClock(() => 0);
    clock.SyncLocalTimeFromDB(0, DBTime());
    result = new CTime(
      StrictCalendarEnvironment(() => clock.GetLocalTime()),
    ).GetVariantTime();
  } finally {
    Reflect.set(globalThis, "Date", original);
  }
  expect(result).toBe(StrictSystemTimeToVariantTime(SystemTime()));
  expect(process.env.TZ).toBe(tz);
});

test("civil millisecond math is range-checked, NOT raw negative DATE addition, and requires observed0..999 ms", () => {
  const value = CivilTimeMilliseconds(SystemTime());
  expect(SystemTimeFromCivilMilliseconds(value)).toEqual(SystemTime());
  expect(() =>
    CivilTimeMilliseconds(SystemTime({ wMilliseconds: null })),
  ).toThrow("observed");
  expect(() =>
    CivilTimeMilliseconds(SystemTime({ wMilliseconds: 1000 })),
  ).toThrow("observed");
  for (const n of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 0.5])
    expect(() => SystemTimeFromCivilMilliseconds(n)).toThrow("range");
  const earliest = CivilTimeMilliseconds(
    SystemTime({
      wYear: 100,
      wMonth: 1,
      wDay: 1,
      wHour: 0,
      wMinute: 0,
      wSecond: 0,
    }),
  );
  expect(() => SystemTimeFromCivilMilliseconds(earliest - 1)).toThrow("range");
});

test("real CDBManBase exposes the same detached native copy cores without any SQL write, schema change or automatic legacy date conversion", () => {
  const session = new CDBSession(":memory:");
  try {
    const db = new CDBManBase(session),
      changes = () =>
        session.db
          .query<{ n: number }, []>("SELECT total_changes() AS n")
          .get()!.n,
      before = changes();
    expect(db.ConvertDBTimeToSystemTime(DBTime())).toEqual(
      ConvertDBTimeToSystemTime(DBTime()),
    );
    expect(db.ConvertSystemTimeToDBTime(SystemTime())).toEqual(
      ConvertSystemTimeToDBTime(SystemTime()),
    );
    expect(changes()).toBe(before);
    expect(session.db.query("PRAGMA user_version").get()).toEqual({
      user_version: 6,
    });
  } finally {
    session.Close();
  }
});

test("raw finite OLE DATE numbers/strings/SQL-null cannot masquerade as an observed SYSTEMTIME or DBTIMESTAMP", () => {
  for (const value of [0, -1.25, "2026-01-02", null, undefined, []]) {
    expect(() => CaptureSystemTime(value as unknown as _SYSTEMTIME)).toThrow();
    expect(() =>
      CaptureDBTimestamp(value as unknown as ReturnType<typeof DBTime>),
    ).toThrow();
  }
});

test("explicit observed variant ports retain negative-zero raw f64; malformed environment or explicit null time MUST NOT trigger a default clock read", () => {
  let reads = 0;
  const environment = {
      GetLocalTime: () => {
        reads++;
        return SystemTime();
      },
      SystemTimeToVariantTime: () => ({ Success: true, Value: -0 }),
    },
    time = new CTime(environment, SystemTime());
  expect(VariantHex(time.GetVariantTime())).toBe("0000000000000080");
  expect(reads).toBe(0);
  expect(
    () =>
      new CTime(environment, null as unknown as ReturnType<typeof SystemTime>),
  ).toThrow("SYSTEMTIME");
  expect(reads).toBe(0);
  expect(() => new CTime(null as unknown as CTimeEnvironment)).toThrow(
    "explicit",
  );
});

test("SetTime guards getter-driven nested mutation for the WHOLE copy: invalid outer fields cannot commit a nested time or sample the clock; guard resets after failure", () => {
  let reads = 0;
  const original = SystemTime(),
    replacement = SystemTime({ wYear: 1999 }),
    time = new CTime(
      StrictCalendarEnvironment(() => {
        reads++;
        return replacement;
      }),
      original,
    ),
    blocked: string[] = [],
    malformed = SystemTime({ wSecond: 65536 });
  Object.defineProperty(malformed, "wYear", {
    get() {
      for (const mutate of [
        () => time.SetTime(replacement),
        () => time.SetCurrentTime(),
      ]) {
        try {
          mutate();
        } catch (error) {
          blocked.push(error instanceof Error ? error.message : String(error));
        }
      }
      return original.wYear;
    },
  });
  expect(() => time.SetTime(malformed)).toThrow("wSecond");
  expect(blocked).toHaveLength(2);
  expect(blocked.every((message) => message.includes("Reentrant"))).toBe(true);
  expect(reads).toBe(0);
  expect(time.GetAsSystemTime()).toEqual(original);
  time.SetTime(replacement);
  expect(time.GetAsSystemTime()).toEqual(replacement);
  time.SetCurrentTime();
  expect(reads).toBe(1);
});
