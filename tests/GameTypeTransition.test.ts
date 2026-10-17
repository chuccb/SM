import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  PlanGameTypeTransition,
  type GameTypeObservation,
  type GameTypePlan,
} from "../FXGS/GameTypeTransition.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import data from "./fixtures/game-type-transition-vectors.json";
const vectors = data as unknown as {
  Model: string;
  Cases: {
    Before: GameTypeObservation;
    Requested: number;
    Expected: GameTypePlan;
    Scalar: string;
    Plain: string;
  }[];
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

test("model29:complete94/97-byte mode setters,65/65-byte chief handlers,447-byte mode-independent CanStart and23 literal anchors; no original execution", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.FunctionImages.map((p) => p.Length)).toEqual([
    94, 97, 65, 65, 447,
  ]);
  for (const p of vectors.FunctionImages)
    expect(
      createHash("sha256").update(pe.read(p.VA, p.Length)).digest("hex"),
    ).toBe(p.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(23);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(vectors.Model).toContain("NOT original execution");
});

test("ALL2048 independent C++ game-type cases:all256 Manner values,mode/signed-DWORD edges,Playing true/false,target/ballots untouched;ONLY mode0/1 plus opcode93/92 plain/scalar", () => {
  expect(vectors.CaseCount).toBe(2048);
  expect(vectors.Cases).toHaveLength(2048);
  for (const c of vectors.Cases) {
    const source = structuredClone(c.Before),
      original = JSON.stringify(source),
      p = PlanGameTypeTransition(source, c.Requested);
    expect(p).toEqual(c.Expected);
    expect(JSON.stringify(source)).toBe(original);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.Votes)).toBe(true);
    expect(p.Votes).not.toBe(source.Votes);
    expect(new CSendPacket(p.Opcode).GetBuffer().toString("hex")).toBe(
      c.Scalar,
    );
    expect(
      new CSendPacket(p.Opcode, CipherDegree.None).GetBuffer().toString("hex"),
    ).toBe(c.Plain);
    expect(new CSendPacket(p.Opcode).GetBuffer()).toHaveLength(1);
  }
});

test("game-type projection is immutable data-only,never strategy/clock/financial/combat permission; malformed snapshots reject without changing source", () => {
  const source = {
      GameType: 0,
      Playing: false,
      Manner: 1,
      TargetSerialNo: 0xffffffff,
      Votes: [0, 1, 2, 3, 4, 0xffffffff, 0x80000000, 17],
    },
    before = JSON.stringify(source),
    p = PlanGameTypeTransition(source, 1);
  expect(p.GameType).toBe(1);
  expect(p.TargetSerialNo).toBe(source.TargetSerialNo);
  expect(Reflect.has(p, "Apply")).toBe(false);
  expect(Reflect.has(p, "Issuer")).toBe(false);
  for (const bad of [
    { ...source, GameType: NaN },
    { ...source, Manner: 256 },
    { ...source, TargetSerialNo: -1 },
    { ...source, Votes: [] },
    { ...source, Votes: Array(8).fill(1.5) },
    { ...source, Playing: 1 as unknown as boolean },
  ])
    expect(() => PlanGameTypeTransition(bad, 1)).toThrow();
  for (const requested of [-1, 2, NaN])
    expect(() => PlanGameTypeTransition(source, requested)).toThrow();
  expect(JSON.stringify(source)).toBe(before);
});
