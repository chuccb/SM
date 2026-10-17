import { expect, test } from "bun:test";
import {
  PlanWaitingVoteJoin,
  type WaitingVoteJoinObservation,
} from "../FXGS/WaitingVoteJoin.ts";
import { CBaseSession } from "../FXGS/CBaseSession.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import data from "./fixtures/waiting-vote-join-vectors.json";
interface Vector extends WaitingVoteJoinObservation {
  Bombers: number[];
  PrimaryColor: number;
  Accepted: boolean;
  Slots?: number[];
  AfterInfo?: number[][];
  Scalar?: { Self: string[]; Room: string[] };
  Plain?: { Self: string[]; Room: string[] };
}
const vectors = data as unknown as {
  Model: string;
  Cases: Vector[];
  CaseCount: number;
  OfficialPE: { SHA256: string };
  InstructionAnchors: { VA: number; Bytes: string; Meaning: string }[];
};
function user(slot: number, local = -1) {
  return new CUser(
    UserInfo(local < 0 ? (slot === 3 ? "中文" : `Old${slot}`) : `New${local}`, {
      Gender: slot % 2,
      CommunitySvr: slot % 2 ? 7 : 0,
    }),
    local < 0 ? 0x81234000 + slot : 0xfedcba90 + local,
  );
}
function bodies(
  c: Vector,
  info: readonly (readonly number[])[],
  slots: readonly number[],
  cipher: CipherDegree,
) {
  const text = new CTextCodec(),
    view = new CBaseSession(1, 2, text);
  for (let i = 0; i < 8; i++) {
    view.m_rgSlotInfo[i] = Buffer.from(info[i]!);
    if (c.Occupied[i]) view.m_rgPlayer[i] = user(i);
  }
  slots.forEach((slot, i) => {
    view.m_rgPlayer[slot] = user(slot, i);
  });
  const packet = (slot: number, self: boolean) =>
    view.MakeSetPlayerPacket(slot, self, cipher).GetBuffer().toString("hex");
  const Self = [
    new CSendPacket(81, cipher, text).Encode1(0).GetBuffer().toString("hex"),
  ];
  for (let i = 0; i < 8; i++)
    Self.push(
      view.m_rgPlayer[i]
        ? packet(i, slots.includes(i))
        : new CSendPacket(107, cipher, text)
            .Encode1(i)
            .EncodeBuffer(Buffer.from(info[i]!))
            .GetBuffer()
            .toString("hex"),
    );
  const map = new CSendPacket(112, cipher, text)
    .Encode2(200)
    .GetBuffer()
    .toString("hex");
  Self.push(
    map,
    map,
    new CSendPacket(93, cipher, text).GetBuffer().toString("hex"),
  );
  return { Self, Room: slots.map((slot) => packet(slot, true)) };
}

test("model27:28 literal PE anchors include COMPLETE List.AddUser/AddPlayer/Game.AddUser, prove ballots/target not rewritten and no113/114/Defer on join", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(28);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(
    vectors.InstructionAnchors.filter((a) => a.Meaning.includes("ENTIRE")).map(
      (a) => a.Bytes.length / 2,
    ),
  ).toEqual([41, 79, 60]);
  expect(vectors.Model).toContain("NOT original execution");
});

test("ALL1476 independent C++ waiting-vote join cases: all nonempty/nonfull roster masks,closed holes,1/2 locals,high slot bits,observed colors/bombers,EXACT original votes/target/chief and scalar81/105/107/112/93", () => {
  expect(vectors.CaseCount).toBe(1476);
  expect(vectors.Cases).toHaveLength(1476);
  let accepted = 0,
    rejected = 0,
    preservedGarbage = 0;
  for (const c of vectors.Cases) {
    const source = structuredClone(c),
      before = JSON.stringify(source);
    if (!c.Accepted) {
      expect(() =>
        PlanWaitingVoteJoin(source, c.Bombers, c.PrimaryColor),
      ).toThrow("Insufficient");
      expect(JSON.stringify(source)).toBe(before);
      rejected++;
      continue;
    }
    const p = PlanWaitingVoteJoin(source, c.Bombers, c.PrimaryColor);
    expect(p.Slots).toEqual(c.Slots!);
    expect(p.SlotInfo).toEqual(c.AfterInfo!);
    expect(p.Votes).toEqual(c.Votes);
    expect(p.TargetSerialNo).toBe(c.TargetSerialNo);
    expect(p.ChiefSlot).toBe(c.ChiefSlot);
    expect(JSON.stringify(source)).toBe(before);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.Slots)).toBe(true);
    expect(p.SlotInfo.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(p.Votes)).toBe(true);
    expect(bodies(c, p.SlotInfo, p.Slots, CipherDegree.CRC8)).toEqual(
      c.Scalar!,
    );
    expect(bodies(c, p.SlotInfo, p.Slots, CipherDegree.None)).toEqual(c.Plain!);
    if (p.Slots.some((slot) => c.Votes[slot] === 0xffffffff))
      preservedGarbage++;
    accepted++;
  }
  expect(accepted).toBeGreaterThan(0);
  expect(rejected).toBeGreaterThan(0);
  expect(preservedGarbage).toBeGreaterThan(0);
});

test("native AddUser does NOT clear arbitrary vacant ballot bits or reset the whole electorate; pure plans expose data, never permission to install malformed private state", () => {
  const c = vectors.Cases.find(
      (c) => c.Accepted && c.Slots!.some((s) => c.Votes[s] === 0xffffffff),
    )!,
    p = PlanWaitingVoteJoin(c, c.Bombers, c.PrimaryColor);
  expect(p.Votes).toEqual(c.Votes);
  expect(p.Votes.some((v) => v === 0xffffffff)).toBe(true);
  expect(Reflect.has(p, "Apply")).toBe(false);
  expect(Reflect.has(p, "Authority")).toBe(false);
});

test("modern shape/range/capacity hardening is atomic and does not pretend to reproduce native corruption/UB", () => {
  const c = vectors.Cases.find((c) => c.Accepted)!,
    before = JSON.stringify(c);
  for (const bad of [
    { ...c, Occupied: [] },
    { ...c, SlotInfo: [] },
    { ...c, Votes: [1] },
    { ...c, TargetSerialNo: 0 },
    { ...c, ChiefSlot: -1 },
    { ...c, Votes: Array(8).fill(-1) },
    { ...c, SlotInfo: Array.from({ length: 8 }, () => [0, 0, NaN]) },
  ])
    expect(() => PlanWaitingVoteJoin(bad, c.Bombers, c.PrimaryColor)).toThrow();
  for (const selected of [[], [1, 2, 3], [-1], [64], [NaN]])
    expect(() => PlanWaitingVoteJoin(c, selected, c.PrimaryColor)).toThrow();
  for (const color of [-1, 32, NaN])
    expect(() => PlanWaitingVoteJoin(c, c.Bombers, color)).toThrow();
  expect(JSON.stringify(c)).toBe(before);
});
