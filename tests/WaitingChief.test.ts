import { expect, test } from "bun:test";
import { CBanChief, type BanChiefState } from "../FXGS/CBanChief.ts";
import {
  PlanDeferBanChief,
  MakeBanChiefPacket,
  type BanChiefNotice,
} from "../FXGS/WaitingChief.ts";
import { CUser } from "../Common/CUser.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { Received } from "./helpers/Clients.ts";
import { WaitingChiefVectors as vectors } from "./helpers/WaitingChief.ts";

const observation = {
  Playing: false,
  ChiefAvailable: true,
  SuperChief: false,
  Manner: false,
  Capacity: 8,
  PlayerCount: 8,
};
function state(before: Partial<BanChiefState> = {}) {
  const c = new CBanChief(() => {
    throw new Error("original provider must stay unread");
  });
  c.InstallSnapshot({
    CanStartTime: 100,
    CanStart: true,
    OddSlot: false,
    LastTimeEvenSlot: 0,
    WarnedBan: false,
    WarnedTime: 0,
    WarnedBanOddSlot: false,
    WarnedTimeOddSlot: 0,
    ...before,
  });
  return c;
}

test("48 read-only PE anchors prove native121 roles, CAPACITY833 versus count832, stub authority and playing-map CanStart argument; no EXE is run", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(48);
  for (const { VA, Bytes } of vectors.InstructionAnchors)
    expect(pe.read(VA, Bytes.length / 2).toString("hex")).toBe(Bytes);
  expect(vectors.Model).toContain("OUR manual");
  expect(vectors.Model).toContain("observation");
  expect(vectors.Model).toContain("NOT original execution");
});

test("2356 independent C++ cases match ALL helper DWORDs, separate clock reads, conditional CanStart calls,121 bodies/order and ordinary reset; source stays untouched", () => {
  expect(vectors.CaseCount).toBe(2356);
  expect(vectors.Cases).toHaveLength(vectors.CaseCount);
  for (const c of vectors.Cases) {
    const before = state(c.Before),
      initial = before.GetStateBytes(),
      reads: number[] = [];
    let canCalls = 0;
    const plan = PlanDeferBanChief(
      before,
      c.Observation,
      () => {
        const n = (c.TimeBase + Math.imul(reads.length, c.TimeIncrement)) >>> 0;
        reads.push(n);
        return n;
      },
      () => {
        canCalls++;
        return c.CanStartResult;
      },
    );
    expect(plan.After).toEqual(c.After);
    const after = state(plan.After);
    expect(after.GetStateBytes().toString("hex")).toBe(c.StateHex);
    expect(plan.Notices).toEqual(c.Notices.map(({ BodyHex: _, ...n }) => n));
    expect(
      plan.Notices.map((n) =>
        MakeBanChiefPacket(n).GetBuffer().toString("hex"),
      ),
    ).toEqual(c.Notices.map((n) => n.BodyHex));
    expect(plan.Eject).toBe(c.Eject);
    expect(reads).toEqual(c.ClockReads);
    expect(canCalls).toBe(c.CanStartCalls);
    expect(before.GetStateBytes()).toEqual(initial);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.After)).toBe(true);
    expect(Object.isFrozen(plan.Notices)).toBe(true);
    expect(plan.Notices.every((n) => Object.isFrozen(n))).toBe(true);
  }
});

test("THIS native HasAuthority stub always returns0 for all256 parameter bytes and arbitrary SQLite Authority;22/23/25 are not invented role bits", () => {
  for (const Authority of [
    -2147483648, -1, 0, 1, 22, 23, 25, 0x400000, 0x7fffffff,
  ]) {
    const user = new CUser(UserInfo("Authority", { Authority }), 7);
    for (let param = 0; param < 256; param++)
      expect(user.HasAuthority(param)).toBe(0);
    expect(user.HasAuthority(-1)).toBe(0);
    expect(user.HasAuthority(0x7fffffff)).toBe(0);
  }
});

test("ready/odd/warning boundaries are strict unsigned > and SuperChief triples ALL three deadlines, not only announced seconds", () => {
  for (const SuperChief of [false, true]) {
    const m = SuperChief ? 3 : 1;
    for (const full of [false, true]) {
      const obs = { ...observation, SuperChief, PlayerCount: full ? 8 : 2 },
        delay = (full ? 10000 : 20000) * m;
      expect(
        PlanDeferBanChief(
          state(),
          obs,
          () => 100 + delay,
          () => 0,
        ).Notices,
      ).toEqual([]);
      const warned = PlanDeferBanChief(
        state(),
        obs,
        () => 101 + delay,
        () => 0,
      );
      expect(warned.Notices).toEqual([
        { Reason: 0, Seconds: 10 * m, ChiefOnly: false },
      ]);
      const c = state(warned.After),
        last = warned.After.WarnedTime;
      expect(
        PlanDeferBanChief(
          c,
          obs,
          () => last + 10000 * m,
          () => 0,
        ).Eject,
      ).toBe(false);
      const kicked = PlanDeferBanChief(
        c,
        obs,
        () => last + 10000 * m + 1,
        () => 0,
      );
      expect(kicked.Notices).toEqual([
        { Reason: 2, Seconds: 10 * m, ChiefOnly: true },
      ]);
      expect(kicked.After.CanStart).toBe(false);
    }
    const odd = state({
        CanStart: false,
        OddSlot: true,
        LastTimeEvenSlot: 100,
      }),
      obs = {
        ...observation,
        SuperChief,
        Manner: true,
        Capacity: 3,
        PlayerCount: 2,
      };
    expect(
      PlanDeferBanChief(
        odd,
        obs,
        () => 100 + 5000 * m,
        () => 2,
      ).Notices,
    ).toEqual([]);
    const warned = PlanDeferBanChief(
      odd,
      obs,
      () => 101 + 5000 * m,
      () => 2,
    );
    expect(warned.Notices).toEqual([
      { Reason: 1, Seconds: 10 * m, ChiefOnly: false },
    ]);
    const c = state(warned.After),
      last = warned.After.WarnedTimeOddSlot;
    expect(
      PlanDeferBanChief(
        c,
        obs,
        () => last + 10000 * m,
        () => 2,
      ).Eject,
    ).toBe(false);
    const kicked = PlanDeferBanChief(
      c,
      obs,
      () => last + 10000 * m + 1,
      () => {
        throw new Error("odd kick must skip CanStart");
      },
    );
    expect(kicked.Notices).toEqual([
      { Reason: 3, Seconds: 10 * m, ChiefOnly: true },
    ]);
    expect(kicked.After.OddSlot).toBe(false);
  }
});

test("parity is CAPACITY, even for an EVEN current count; normal rooms instead test capacity<=1, never current<=1", () => {
  for (let Capacity = 0; Capacity <= 8; Capacity++)
    for (let PlayerCount = 0; PlayerCount <= 8; PlayerCount++)
      for (const Manner of [false, true]) {
        const plan = PlanDeferBanChief(
          state({ CanStart: false }),
          { ...observation, Manner, Capacity, PlayerCount },
          () => 100,
          () => 3,
        );
        expect(plan.After.OddSlot).toBe(
          Manner ? Capacity % 2 !== 0 : Capacity <= 1,
        );
      }
});

test("distinct time ports matter: IsBanChief may cross the limit after ENTRY; warning expiry still uses the older ENTRY sample", () => {
  const samples = [10100, 10101, 10102];
  const warned = PlanDeferBanChief(
    state(),
    observation,
    () => samples.shift()!,
    () => 0,
  );
  expect(warned.Notices.map((n) => n.Reason)).toEqual([0]);
  expect(warned.After.WarnedTime).toBe(10102);
  expect(samples).toEqual([]);
  const c = state({ WarnedBan: true, WarnedTime: 10102 }),
    ticks = [20102, 20103];
  expect(
    PlanDeferBanChief(
      c,
      observation,
      () => ticks.shift()!,
      () => 0,
    ).Eject,
  ).toBe(false);
  expect(ticks).toEqual([]);
});

test("odd warning precedes normal warning/kick on the SAME call; odd kick takes precedence and never calls CanStartGame", () => {
  expect(
    vectors.Cases.some((c) => c.Notices.map((n) => n.Reason).join() === "1,0"),
  ).toBe(true);
  expect(
    vectors.Cases.some((c) => c.Notices.map((n) => n.Reason).join() === "1,2"),
  ).toBe(true);
  const oddKicks = vectors.Cases.filter((c) =>
    c.Notices.some((n) => n.Reason === 3),
  );
  expect(oddKicks.length).toBeGreaterThan(0);
  expect(
    oddKicks.every((c) => c.CanStartCalls === 0 && c.Notices.length === 1),
  ).toBe(true);
});

test("playing resets helper with ONE setter time; absent chief reads NO time/CanStart or otherwise-unreached observation fields", () => {
  const before = state({
    WarnedBan: true,
    WarnedTime: 1,
    OddSlot: true,
    LastTimeEvenSlot: 2,
    WarnedBanOddSlot: true,
    WarnedTimeOddSlot: 3,
  });
  let clocks = 0;
  const unreachable = () => {
      throw new Error("unreached");
    },
    obs = {
      ...observation,
      Playing: true,
      get SuperChief(): boolean {
        return unreachable();
      },
    };
  const reset = PlanDeferBanChief(
    before,
    obs,
    () => {
      clocks++;
      return 123;
    },
    unreachable,
  );
  expect(clocks).toBe(1);
  expect(reset.After).toEqual({
    CanStartTime: 123,
    CanStart: false,
    OddSlot: false,
    LastTimeEvenSlot: 0,
    WarnedBan: false,
    WarnedTime: 0,
    WarnedBanOddSlot: false,
    WarnedTimeOddSlot: 0,
  });
  const missing = PlanDeferBanChief(
    before,
    { ...observation, ChiefAvailable: false },
    unreachable,
    unreachable,
  );
  expect(missing.After).toEqual(before.CaptureSnapshot());
  expect(missing.Notices).toEqual([]);
});

test("all clock/CanStart failures discard detached work including two-notice/removal reset; original helper is never partially installed", () => {
  const c = vectors.Cases.find(
    (c) => c.Notices.map((n) => n.Reason).join() === "1,2",
  )!;
  expect(c.ClockReads.length).toBeGreaterThan(3);
  for (let stop = 0; stop < c.ClockReads.length; stop++) {
    const before = state(c.Before),
      bytes = before.GetStateBytes();
    let reads = 0;
    expect(() =>
      PlanDeferBanChief(
        before,
        c.Observation,
        () => {
          if (reads === stop) throw new Error("clock fault");
          return c.ClockReads[reads++]!;
        },
        () => c.CanStartResult,
      ),
    ).toThrow("clock fault");
    expect(before.GetStateBytes()).toEqual(bytes);
  }
  const before = state(c.Before),
    bytes = before.GetStateBytes();
  expect(() =>
    PlanDeferBanChief(
      before,
      c.Observation,
      () => c.TimeBase,
      () => {
        throw new Error("map fault");
      },
    ),
  ).toThrow("map fault");
  expect(before.GetStateBytes()).toEqual(bytes);
});

test("snapshot install latches ALL fields and validates atomically; Fork does not sample or replace the live clock provider", () => {
  let reads = 0;
  const before = new CBanChief(() => ++reads);
  before.Init();
  const fork = before.Fork(() => 123);
  fork.SetCanStart(true);
  expect(reads).toBe(1);
  expect(before.IsCanStart()).toBe(false);
  before.InstallSnapshot(fork.CaptureSnapshot());
  expect(reads).toBe(1);
  before.SetCanStart(false);
  expect(before.CaptureSnapshot().CanStartTime).toBe(2);
  const snapshot = before.CaptureSnapshot();
  for (const field of [
    "CanStartTime",
    "LastTimeEvenSlot",
    "WarnedTime",
    "WarnedTimeOddSlot",
  ])
    for (const value of [-1, 2 ** 32, NaN, Infinity, 0.5]) {
      expect(() =>
        before.InstallSnapshot({ ...snapshot, [field]: value }),
      ).toThrow("snapshot");
      expect(before.CaptureSnapshot()).toEqual(snapshot);
    }
  for (const field of ["CanStart", "OddSlot", "WarnedBan", "WarnedBanOddSlot"])
    expect(() => before.InstallSnapshot({ ...snapshot, [field]: 1 })).toThrow(
      "snapshot",
    );
  expect(reads).toBe(2);
});

test("invalid capacity/count observations fail BEFORE clock ports; malformed121 cannot encode a reason, seconds or recipient mismatch", () => {
  const before = state(),
    clock = () => {
      throw new Error("unexpected clock");
    };
  for (const field of ["Capacity", "PlayerCount"])
    for (const value of [-1, 9, NaN, Infinity, 0.5])
      expect(() =>
        PlanDeferBanChief(
          before,
          { ...observation, [field]: value },
          clock,
          () => 0,
        ),
      ).toThrow("observation");
  const valid: BanChiefNotice = { Reason: 0, Seconds: 10, ChiefOnly: false };
  for (const bad of [
    ...[-1, 4, NaN, 0.5].map((Reason) => ({ ...valid, Reason })),
    ...[-1, 65536, NaN, 0.5].map((Seconds) => ({ ...valid, Seconds })),
    { ...valid, ChiefOnly: true },
  ])
    expect(() => MakeBanChiefPacket(bad as BanChiefNotice)).toThrow("notice");
  const packet = MakeBanChiefPacket(valid),
    received = Received(packet);
  expect(packet.GetBuffer().toString("hex")).toBe("235aa563");
  expect(received.Decode1()).toBe(121);
  expect(received.Decode1()).toBe(0);
  expect(received.Decode2()).toBe(10);
  received.AssertEnd();
});
