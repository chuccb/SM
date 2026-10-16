import { afterEach, expect, test } from "bun:test";
import vectors from "./fixtures/scoring-vectors.json";
import { CDynInfoCalculator } from "../Common/CDynInfoCalculator.ts";
import { DynInfoLayout, DynInfoRule } from "../Common/OfficialValues.ts";
import { g_nLevel2ExpTable } from "../Common/Protocol/OfficialTables.ts";
import { CUser } from "../Common/CUser.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { ScoringPlayers } from "./helpers/Scoring.ts";
import { MemoryClient } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";

const sockets: MemoryClient[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.Close();
});
function setup(spec = vectors.Rooms[3]!) {
  const input = ScoringPlayers(spec.Players);
  sockets.push(...input.Clients);
  const calc = new CDynInfoCalculator(() => spec.PremiumChannel);
  return { ...input, calc, spec };
}

for (const row of vectors.Rooms) {
  test(`calculator fixed-width C++ vectors: ${row.Name}`, () => {
    const { Players, Slots, calc } = setup(row);
    calc.Init(Players, Slots);
    for (const snapshot of row.Snapshots) {
      if (snapshot.Name === "Teams") {
        for (let slot = 0; slot < 8; slot++) {
          if (!Players[slot]) continue;
          calc.IncMyTeamNo(slot);
          for (let other = slot + 1; other < 8; other++) {
            if (!Players[other]) continue;
            if (row.Players[slot]!.Color === row.Players[other]!.Color) {
              calc.IncMyTeamNo(slot);
              calc.IncMyTeamNo(other);
            } else {
              calc.IncOtherTeamNo(slot);
              calc.IncOtherTeamNo(other);
            }
          }
        }
      } else if (snapshot.Name === "Actions") {
        for (const action of row.Actions) {
          if (action.Kind === "kill")
            calc.SetKillerIndex(action.Victim, action.Actor);
          else if (action.Kind === "save")
            calc.SetSaverIndex(action.Victim, action.Actor);
          else if (action.Kind === "nice")
            calc.SetNice(action.Actor, action.Value);
        }
      } else if (snapshot.Name === "Premium") calc.SetHasPremium(row.Premium);
      else if (snapshot.Name === "Reset") calc.Init(Players, Slots);
      const expected = Buffer.from(snapshot.State, "hex");
      expect(calc.GetStateBytes().toString("hex")).toBe(snapshot.State);
      expect(calc.IsInitialized()).toBe(true);
      expect(calc.IsInvalidGame()).toBe(expected.readInt32LE(592));
      for (let slot = 0; slot < 8; slot++) {
        const extra = { value: 12345 };
        expect([
          calc.GetIncMoney(slot),
          calc.GetWinExp(slot, extra),
          calc.GetDrawExp(slot),
          calc.GetKillNSaveExp(slot),
        ]).toEqual(snapshot.Rewards[slot]!);
        expect(extra.value).toBe(0);
        // Independent native byte offsets, not offsets imported from the port.
        expect(calc.GetKillCount(slot)).toBe(
          expected.readInt32LE(364 + slot * 4),
        );
        expect(calc.GetSaveCount(slot)).toBe(
          expected.readInt32LE(332 + slot * 4),
        );
        expect(calc.GetTeamColor(slot)).toBe(
          expected.readInt32LE(460 + slot * 4),
        );
        expect(calc.GetMyTeamNo(slot)).toBe(
          expected.readInt32LE(524 + slot * 4),
        );
        expect(calc.GetOtherTeamNo(slot)).toBe(
          expected.readInt32LE(556 + slot * 4),
        );
      }
    }
  });
}

test("threshold/per-mille vectors retain signed IMUL wrapping and final-level sentinel", () => {
  for (const [exp, level, percentage] of vectors.Levels) {
    expect(CDynInfoCalculator.GetLevel(exp!)).toBe(level!);
    expect(CDynInfoCalculator.GetExpPercentage(exp!)).toBe(percentage!);
  }
  for (let level = 0; level < g_nLevel2ExpTable.length; level++)
    expect(CDynInfoCalculator.GetMaxExpInLevel(level)).toBe(
      g_nLevel2ExpTable[level]!,
    );
  for (const invalid of [-0x80000000, -1, 450, 0x7fffffff])
    expect(CDynInfoCalculator.GetMaxExpInLevel(invalid)).toBe(0x7fffffff);
  expect(CDynInfoCalculator.GetExpPercentage(13815000)).toBe(0);
  expect(CDynInfoCalculator.GetExpPercentage(-2147484)).toBeGreaterThan(0); // wrapped IMUL, not a clamped fraction
  for (const invalid of [NaN, Infinity, 1.5, -0x80000001, 0x80000000])
    expect(() => CDynInfoCalculator.GetExpPercentage(invalid)).toThrow();
  expect(() => CDynInfoCalculator.GetMaxExpInLevel(NaN)).toThrow();
});

test("actual LS/GS PE level tables, x87 default precision and percentage opcode anchors", () => {
  const ls = new CPeImage(OFFICIAL_SERVICES.LS);
  const gs = new CPeImage(OFFICIAL_SERVICES.FXGS);
  const length = ls.read(ls.symbolVA("kLevelTableSize"), 4).readUInt32LE();
  expect(length).toBe(450);
  expect(gs.read(gs.symbolVA("kLevelTableSize"), 4).readUInt32LE()).toBe(
    length,
  );
  const bytes = ls.read(ls.symbolVA("g_nLevel2ExpTable"), length * 4);
  expect(gs.read(gs.symbolVA("g_nLevel2ExpTable"), length * 4)).toEqual(bytes);
  expect(Array.from({ length }, (_, i) => bytes.readInt32LE(i * 4))).toEqual([
    ...g_nLevel2ExpTable,
  ]);
  // __setdefaultprecision: _controlfp(0x10000 /* PC_53 */, 0x30000).
  expect(gs.read(0x4768bc, 18).toString("hex")).toBe(
    "68000003006800000100e8618000005959c3",
  );
  // __fpreset executes FNINIT then calls that precision initializer.
  expect(gs.read(0x47e75d, 7).toString("hex")).toBe("dbe3e85881ffff");
  // This STATIC anchor is not a claim to have executed the original CRT/thread.
  expect(gs.read(0x40b29e, 61).toString("hex")).toContain(
    "69c0e8030000992bf1f7fe",
  );
});

test("native layout is centralized and GetStateBytes returns a detached copy", () => {
  expect(DynInfoLayout.Size).toBe(596);
  expect(DynInfoLayout.MyTeamNo * 4).toBe(524);
  expect(DynInfoLayout.OtherTeamNo * 4).toBe(556);
  const { Players, Slots, calc } = setup();
  calc.Init(Players, Slots);
  const before = calc.GetStateBytes();
  const copy = calc.GetStateBytes();
  copy.fill(0xff);
  expect(calc.GetStateBytes()).toEqual(before);
  expect(calc.GetStateBytes().readUInt32LE(0)).toBe(0); // no fabricated native vtable
});

test("same TCP socket remains invalid even with two users/colors; one color on two sockets is valid", () => {
  const local = setup(vectors.Rooms.find((v) => v.Name === "same-socket")!);
  local.calc.Init(local.Players, local.Slots);
  expect(local.calc.IsInvalidGame()).toBe(1);
  expect(local.calc.GetWinExp(0)).toBe(0);
  const team = setup(
    vectors.Rooms.find((v) => v.Name === "one-team-two-sockets")!,
  );
  team.calc.Init(team.Players, team.Slots);
  expect(team.calc.IsInvalidGame()).toBe(0);
  expect(team.calc.GetIncMoney(0)).toBeGreaterThan(0);
});

test("explicit premium and premium channel are different predicates; Nice does not change rewards", () => {
  const { Players, Slots } = setup();
  let premiumChannel = false;
  const calc = new CDynInfoCalculator(() => premiumChannel);
  calc.Init(Players, Slots);
  calc.SetKillerIndex(7, 0); // victim is ignored, not required to be occupied
  calc.SetKillerIndex(7, 0);
  calc.SetSaverIndex(1, 0);
  calc.SetSaverIndex(1, 0);
  calc.SetSaverIndex(0, 0);
  expect(calc.GetKillCount(0)).toBe(2);
  expect(calc.GetSaveCount(0)).toBe(2);
  const rewards = () => [
    calc.GetIncMoney(0),
    calc.GetWinExp(0),
    calc.GetDrawExp(0),
    calc.GetKillNSaveExp(0),
  ];
  const ordinary = rewards();
  calc.SetNice(0, 1);
  expect(rewards()).toEqual(ordinary);
  calc.SetHasPremium(2); // calculator flag is nonzero, NOT user authencode==1
  expect(calc.IsPremiumRewardCondition()).toBe(true);
  expect(calc.GetKillNSaveExp(0)).toBe(0);
  expect(calc.GetWinExp(0)).toBe(Math.trunc((11 * ordinary[1]!) / 10));
  calc.SetHasPremium(0);
  premiumChannel = true;
  expect(calc.GetKillNSaveExp(0)).toBe(80);
  for (let i = 0; i < 20; i++) calc.SetKillerIndex(1, 0);
  expect(calc.GetWinExp(0)).toBe(220);
  expect(calc.GetDrawExp(0)).toBe(55);
  expect(calc.GetKillNSaveExp(0)).toBe(140); // no extra 1.1 multiplier
  premiumChannel = false;
  expect(calc.GetKillNSaveExp(0)).toBe(0);
  expect(calc.GetWinExp(0)).toBe(200);
});

test("Init validates every occupied color and detached/free/duplicate players atomically", () => {
  const { Players, Slots, calc } = setup();
  calc.Init(Players, Slots);
  calc.SetKillerIndex(1, 0);
  calc.SetHasPremium(1);
  const before = calc.GetStateBytes();
  for (let color = 8; color < 32; color++) {
    const invalid = Slots.map((s) => Buffer.from(s));
    invalid[0]![2] = color;
    expect(() => calc.Init(Players, invalid)).toThrow("color");
    expect(calc.GetStateBytes()).toEqual(before);
  }
  const detached = new CUser(UserInfo("DetachedScore"), 11);
  const invalid = [...Players];
  invalid[0] = detached;
  expect(() => calc.Init(invalid, Slots)).toThrow("attached");
  expect(calc.GetStateBytes()).toEqual(before);
  detached.m_pClientSocket = Players[0]!.m_pClientSocket;
  expect(() => calc.Init(invalid, Slots)).toThrow("attached");
  invalid[0] = Players[1]; // same user appears in two slots
  expect(() => calc.Init(invalid, Slots)).toThrow("Duplicate");
  expect(calc.GetStateBytes()).toEqual(before);
  const closed = new MemoryClient();
  sockets.push(closed);
  const gone = new CUser(UserInfo("ClosedScore"), 12);
  gone.m_pClientSocket = closed;
  closed.m_aUser.push(gone);
  closed.Close();
  const closedPlayers = [...Players];
  closedPlayers[0] = gone;
  expect(() => calc.Init(closedPlayers, Slots)).toThrow("live socket");
  expect(calc.GetStateBytes()).toEqual(before);
  Players[1]!.SetFree();
  expect(() => calc.Init(Players, Slots)).toThrow("live socket");
  expect(calc.GetStateBytes()).toEqual(before);
  expect(() => calc.Init(Players.slice(0, 7), Slots)).toThrow("arrays");
  const sparse = new Array<Uint8Array>(8);
  expect(() => calc.Init(Players, sparse)).toThrow("arrays");
  const short = Slots.map((slot) => Buffer.from(slot));
  short[7] = Buffer.alloc(2);
  expect(() => calc.Init(Players, short)).toThrow("arrays");
  expect(calc.GetStateBytes()).toEqual(before);
});

test("upper slot-color bits are masked; vacant colors are never indexed", () => {
  const { Players, Slots, calc } = setup();
  for (const slot of Slots) slot[2] = slot[2]! | 0xe0;
  Slots[7]![2] = 0xff;
  calc.Init(Players, Slots);
  expect(calc.GetTeamColor(0)).toBe(0);
  expect(calc.GetTeamColor(1)).toBe(3);
  expect(calc.GetTeamColor(7)).toBe(-1);
  expect(calc.GetWinExp(7)).toBe(0);
  expect(calc.GetIncMoney(7)).toBe(0);
});

test("uninitialized access and invalid indices/values cannot mutate counters", () => {
  const { Players, Slots, calc } = setup();
  expect(calc.IsInitialized()).toBe(false);
  expect(calc.IsInvalidGame()).toBe(1);
  expect(() => calc.GetWinExp(0)).toThrow("not initialized");
  expect(() => calc.SetSaverIndex(0, 0)).toThrow("not initialized");
  calc.Init(Players, Slots);
  const before = calc.GetStateBytes();
  for (const slot of [-1, 8, 0.5, NaN, Infinity]) {
    expect(() => calc.SetKillerIndex(slot, 0)).toThrow();
    expect(() => calc.SetKillerIndex(0, slot)).toThrow();
    expect(() => calc.SetSaverIndex(slot, 0)).toThrow();
    expect(() => calc.SetSaverIndex(0, slot)).toThrow();
    expect(() => calc.IncMyTeamNo(slot)).toThrow();
    expect(() => calc.IncOtherTeamNo(slot)).toThrow();
    expect(() => calc.GetIncMoney(slot)).toThrow();
  }
  for (const value of [0x80000000, -0x80000001, 1.2, NaN, Infinity]) {
    expect(() => calc.SetNice(0, value)).toThrow();
    expect(() => calc.SetHasPremium(value)).toThrow();
  }
  expect(calc.GetStateBytes()).toEqual(before);
  expect(DynInfoRule.PremiumNumerator).toBe(11);
});
