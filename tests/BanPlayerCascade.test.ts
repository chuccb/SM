import { expect, test } from "bun:test";
import { CBanChief, type BanChiefState } from "../FXGS/CBanChief.ts";
import { PlanBanPlayerCascade } from "../FXGS/BanPlayerCascade.ts";
import { PlanDeferBanChief } from "../FXGS/WaitingChief.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { BanObservation } from "./helpers/BanPlayer.ts";
import data from "./fixtures/ban-player-cascade-vectors.json";
interface Vector {
  Counts: number[];
  Chief: number;
  TargetSlot: number;
  Depart: number;
  Votes: number[];
  TimeBase: number;
  TimeStep: number;
  Expected: {
    RemainingPlayers: number[];
    RemainingVotes: number[];
    RemainingChief: number;
    TargetAfter: number;
    Result: number;
    EjectSocket: number;
    ResetKeys: number[];
    ClockReads: number[];
    After: BanChiefState;
  };
}
const vectors = data as unknown as {
  Model: string;
  CaseCount: number;
  Cases: Vector[];
  OfficialPE: { SHA256: string };
  InstructionAnchors: { VA: number; Bytes: string; Meaning: string }[];
};
const initial: BanChiefState = {
  CanStartTime: 17,
  CanStart: true,
  OddSlot: true,
  LastTimeEvenSlot: 19,
  WarnedBan: true,
  WarnedTime: 23,
  WarnedBanOddSlot: true,
  WarnedTimeOddSlot: 29,
};
function before(state: BanChiefState = initial) {
  const c = new CBanChief(() => {
    throw new Error("original clock must stay unread");
  });
  c.InstallSnapshot(state);
  return c;
}
function observation(c: Vector) {
  const s = BanObservation(c.Counts);
  return {
    ...s,
    Votes: c.Votes,
    TargetSerialNo: s.Actors[c.TargetSlot]!.SerialNo,
    ChiefSlot: c.Chief,
  };
}

test("model26:25 read-only anchors prove ordinary chief Init BEFORE deferred144 and whole second table removal BEFORE outer final clock; supplied binary never executes", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(25);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(vectors.Model).toContain("NOT original execution");
});

test("ALL1792 independent C++ cascade compositions: original-capture socket labels,missing/pass/fail/pending after removal,strict weighted votes,zero/one/TWO Init samples and unsigned rollover", () => {
  expect(vectors.CaseCount).toBe(1792);
  expect(vectors.Cases).toHaveLength(1792);
  let doubles = 0;
  const codes = new Set<number>();
  for (const c of vectors.Cases) {
    const source = observation(c),
      snapshot = JSON.stringify(source),
      chief = before(),
      reads: number[] = [],
      p = PlanBanPlayerCascade(source, c.Depart, chief, () => {
        const n = (c.TimeBase + Math.imul(reads.length, c.TimeStep)) >>> 0;
        reads.push(n);
        return n;
      });
    const d = p.Departure,
      decision = d.Decision!;
    expect(d.Remaining.Actors.map((a) => a?.SocketKey ?? -1)).toEqual(
      c.Expected.RemainingPlayers,
    );
    expect(d.Remaining.Votes).toEqual(c.Expected.RemainingVotes);
    expect(d.Remaining.ChiefSlot).toBe(c.Expected.RemainingChief);
    expect(decision.After.TargetSerialNo).toBe(c.Expected.TargetAfter);
    const result = decision.Messages[0]?.Message;
    const code = result?.Kind === "Result" ? result.Code : -1;
    codes.add(code);
    expect(code).toBe(c.Expected.Result);
    expect(decision.Eject?.SocketKey ?? -1).toBe(c.Expected.EjectSocket);
    expect(p.Resets.map((r) => r.SocketKey)).toEqual(c.Expected.ResetKeys);
    expect(reads).toEqual(c.Expected.ClockReads);
    expect(p.Resets.map((r) => r.State.CanStartTime)).toEqual(reads);
    expect(p.After).toEqual(c.Expected.After);
    expect(d.ChiefInitializations).toBe(p.Resets.length);
    expect(chief.CaptureSnapshot()).toEqual(initial);
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.Resets)).toBe(true);
    expect(
      p.Resets.every((r) => Object.isFrozen(r) && Object.isFrozen(r.State)),
    ).toBe(true);
    if (p.Resets.length === 2) doubles++;
  }
  expect([...codes].sort((a, b) => a - b)).toEqual([-1, 2, 3, 4]);
  expect(doubles).toBeGreaterThan(0);
});

test("actual pure waiting ready removal hook: ENTRY,IsBan,ALL native Init reads,then FINAL SetCanStart read; no collapsed reset, even when a different whole group succeeds the chief", () => {
  let checked = 0;
  for (const c of vectors.Cases.filter(
    (c) => c.Expected.ResetKeys[0] === c.Depart,
  )) {
    const source = observation(c),
      chief = before({
        ...initial,
        CanStartTime: 0,
        CanStart: true,
        OddSlot: false,
        WarnedTime: 1,
      }),
      reads: number[] = [],
      time = () => {
        const n = 30102 + reads.length;
        reads.push(n);
        return n;
      };
    const p = PlanDeferBanChief(
      chief,
      {
        Playing: false,
        ChiefAvailable: true,
        SuperChief: false,
        Manner: false,
        Capacity: 8,
        PlayerCount: source.Actors.filter(Boolean).length,
      },
      time,
      () => 0,
      (next) => {
        const cascade = PlanBanPlayerCascade(source, c.Depart, next, time);
        next.InstallSnapshot(cascade.After);
      },
    );
    expect(p.Eject).toBe(true);
    expect(reads).toEqual(
      Array.from(
        { length: c.Expected.ResetKeys.length + 3 },
        (_, i) => 30102 + i,
      ),
    );
    expect(p.After.CanStartTime).toBe(reads.at(-1)!);
    expect(p.After.CanStart).toBe(false);
    expect(p.Notices.at(-1)!.Reason).toBe(2);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
});

test("actual pure waiting odd removal hook: final SetOdd(false) reads NO clock; distinct first/second Init snapshots survive until correct final state", () => {
  for (const c of vectors.Cases.filter(
    (c) => c.Expected.ResetKeys.length === 2,
  )) {
    const source = observation(c),
      chief = before({ ...initial, LastTimeEvenSlot: 1, WarnedTimeOddSlot: 1 }),
      reads: number[] = [],
      time = () => {
        const n = 15102 + reads.length;
        reads.push(n);
        return n;
      };
    const p = PlanDeferBanChief(
      chief,
      {
        Playing: false,
        ChiefAvailable: true,
        SuperChief: false,
        Manner: true,
        Capacity: 7,
        PlayerCount: source.Actors.filter(Boolean).length,
      },
      time,
      () => {
        throw new Error("odd kick never calls CanStart");
      },
      (next) => {
        const cascade = PlanBanPlayerCascade(source, c.Depart, next, time);
        next.InstallSnapshot(cascade.After);
      },
    );
    expect(p.Eject).toBe(true);
    expect(reads).toEqual([15102, 15103, 15104]);
    expect(p.After.CanStartTime).toBe(15104);
    expect(p.After.OddSlot).toBe(false);
    expect(p.Notices.at(-1)!.Reason).toBe(3);
  }
});

test("any first/second Init clock fault discards detached cascade, never changes source helper/roster or grants authority", () => {
  const c = vectors.Cases.find((c) => c.Expected.ResetKeys.length === 2)!,
    source = observation(c),
    original = JSON.stringify(source),
    chief = before();
  for (const fault of [1, 2]) {
    let reads = 0;
    expect(() =>
      PlanBanPlayerCascade(source, c.Depart, chief, () => {
        if (++reads === fault) throw new Error("clock-fault");
        return reads;
      }),
    ).toThrow("clock-fault");
    expect(chief.CaptureSnapshot()).toEqual(initial);
    expect(JSON.stringify(source)).toBe(original);
  }
});
