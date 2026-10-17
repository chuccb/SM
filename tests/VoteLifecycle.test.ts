import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  PlanNativeVoteTransition,
  type NativeVoteTransition,
} from "../FXGS/VoteLifecycle.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import data from "./fixtures/vote-lifecycle-vectors.json";
interface Vector {
  Target: number;
  Votes: number[];
  TargetsAfter: number[];
  StartTick: number;
  Suspended: number;
  ClockAfter: {
    Start: number;
    End: number;
    Stopped: number;
    Suspended: number;
  };
  Sequence: number;
  Key: number;
  GhostStart: number;
  GhostFrequency: number;
  Scalar150: string;
  Plain150: string;
}
const vectors = data as unknown as {
  Model: string;
  Cases: Vector[];
  CaseCount: number;
  OfficialPE: { SHA256: string };
  FunctionImages: {
    VA: number;
    Length: number;
    SHA256: string;
    Meaning: string;
  }[];
  InstructionAnchors: { VA: number; Bytes: string; Meaning: string }[];
};

test("model28:complete916/870/332/217 native106/116/150/164 images and24 literal PE anchors pin no vote reset at launch/start, target-only reset at return,distinct clock markers; ORIGINAL NEVER EXECUTES", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.FunctionImages.map((x) => x.Length)).toEqual([
    916, 870, 332, 217,
  ]);
  for (const p of vectors.FunctionImages)
    expect(
      createHash("sha256").update(pe.read(p.VA, p.Length)).digest("hex"),
    ).toBe(p.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(24);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(vectors.Model).toContain("NOT original execution");
});

test("ALL2048 independent C++ lifecycle cases:all BYTE ballots in each slot plusDWORD edges,RequestFailed/Launch/Begin preserve all votes AND target;ReturnPrepare clears target only; StartAt preserves Suspended,exact plain/scalar150", () => {
  expect(vectors.CaseCount).toBe(2048);
  expect(vectors.Cases).toHaveLength(2048);
  for (const c of vectors.Cases) {
    const source = { TargetSerialNo: c.Target, Votes: [...c.Votes] },
      before = JSON.stringify(source),
      phases: NativeVoteTransition[] = [
        "RequestFailed",
        "Launch",
        "Begin",
        "ReturnPrepare",
      ];
    for (const [i, phase] of phases.entries()) {
      const p = PlanNativeVoteTransition(source, phase);
      expect(p.TargetSerialNo).toBe(c.TargetsAfter[i]!);
      expect(p.Votes).toEqual(c.Votes);
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.Votes)).toBe(true);
    }
    expect(JSON.stringify(source)).toBe(before);
    let reads = 0;
    const clock = new CGameClock(() => {
      reads++;
      return c.Suspended;
    });
    clock.StartGameAt(17);
    clock.EndGameAt(23);
    clock.m_dwTimeStopped = 31;
    clock.SuspendGame();
    expect(reads).toBe(1);
    clock.StartGameAt(c.StartTick);
    expect(clock.GetStateSnapshot()).toEqual(c.ClockAfter);
    expect(reads).toBe(1);
    for (const degree of [CipherDegree.CRC8, CipherDegree.None]) {
      const p = new CSendPacket(150, degree)
        .Encode4(c.StartTick)
        .Encode4((c.Sequence ^ c.Key) >>> 0)
        .Encode4(c.GhostStart)
        .Encode4(c.GhostFrequency);
      expect(p.GetBuffer().toString("hex")).toBe(
        degree === CipherDegree.None ? c.Plain150 : c.Scalar150,
      );
    }
  }
});

test("pure lifecycle observation does not mutate/rebase electorate or return an Apply/authority capability; malformed DWORD/length/kind rejects atomically", () => {
  const source = {
      TargetSerialNo: 0xffffffff,
      Votes: [0, 1, 2, 3, 4, 0x80000000, 0x7fffffff, 0xffffffff],
    },
    original = JSON.stringify(source),
    p = PlanNativeVoteTransition(source, "ReturnPrepare");
  expect(p.TargetSerialNo).toBe(0);
  expect(p.Votes).toEqual(source.Votes);
  expect(Reflect.has(p, "Apply")).toBe(false);
  expect(Reflect.has(p, "Token")).toBe(false);
  for (const bad of [
    { ...source, TargetSerialNo: -1 },
    { ...source, Votes: [1] },
    { ...source, Votes: Array(8).fill(1.5) },
  ])
    expect(() => PlanNativeVoteTransition(bad, "Begin")).toThrow();
  expect(() =>
    PlanNativeVoteTransition(source, "unknown" as NativeVoteTransition),
  ).toThrow();
  expect(JSON.stringify(source)).toBe(original);
});
