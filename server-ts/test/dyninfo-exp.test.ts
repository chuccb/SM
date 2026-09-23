/** GetWinExp / GetDrawExp must keep colourCount in the divisor.
 *  FxServer.exe.lst 0040B50F..0040B52A and 0040B5DA..0040B5F6. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { CDynInfoCalculator } from "../src/FXGS/DynInfoCalculator.ts";
import { CMainSystem } from "../src/FXGS/MainSystem.ts";
import { PREMIUM_CHANNEL_TYPE } from "../src/FXGS/Defs.ts";
import type { CUser } from "../src/FXGS/User.ts";

const prior = CMainSystem.ms_pInstance;
const channel = { m_nChannelType: 0 } as CMainSystem;

afterEach(() => {
  CMainSystem.ms_pInstance = prior;
});

function calc(): CDynInfoCalculator {
  CMainSystem.ms_pInstance = channel;
  channel.m_nChannelType = 0;
  const c = new CDynInfoCalculator();
  c.m_nInvalidGame = 0;
  return c;
}

test("a two-player colour does not cancel out of the win and draw base", () => {
  const c = calc();
  c.m_nPlayerCount = 4;
  c.m_dwAvgWeight = 10;
  c.m_vtColour[0] = 0;
  c.m_vtColourCount[0] = 2;
  c.m_dwColourWeight[0] = 10;
  c.m_vtSlotWeight[0] = 10;
  const flag = [7];
  // (4*10*100)/(2*10) * 0.5 = 100. Cancelling the count yields 200.
  expect(c.GetWinExp(0, flag)).toBe(100);
  expect(flag).toEqual([0]);
  // (4*10*10)/(2*10) * 0.5 = 10, not 20.
  expect(c.GetDrawExp(0)).toBe(10);
});

test("the lighter player on an uneven team is floored, the heavier one is not capped at the cancelled value", () => {
  const c = calc();
  c.m_nPlayerCount = 2;
  c.m_dwAvgWeight = 20;
  c.m_vtColour[0] = 0;
  c.m_vtColour[1] = 0;
  c.m_vtColourCount[0] = 2;
  c.m_dwColourWeight[0] = 20;
  c.m_vtSlotWeight[0] = 10;
  c.m_vtSlotWeight[1] = 30;
  // 25 clamps to 50. The heavy slot is 75, not the cancelled 150.
  expect(c.GetWinExp(0, [0])).toBe(50);
  expect(c.GetWinExp(1, [0])).toBe(75);
  c.m_nPremiumFlag = 1;
  expect(c.GetWinExp(1, [0])).toBe(82); // 75 * 11 / 10, toward zero
});

test("kills and saves are added before the win and draw caps", () => {
  const c = calc();
  c.m_nPlayerCount = 4;
  c.m_dwAvgWeight = 10;
  c.m_vtColour[0] = 0;
  c.m_vtColourCount[0] = 2;
  c.m_dwColourWeight[0] = 10;
  c.m_vtSlotWeight[0] = 10;
  c.m_vtKills[0] = 6;
  c.m_vtSaves[0] = 1;
  expect(c.GetWinExp(0, [0])).toBe(200); // 100 + 140, cap 200
  expect(c.GetDrawExp(0)).toBe(50); // 10 + 140, cap 50
});

test("a zero colour count or weight logs and returns 0; an invalid game does not log", () => {
  const c = calc();
  c.m_nPlayerCount = 4;
  c.m_dwAvgWeight = 10;
  c.m_vtColour[0] = 0;
  c.m_vtSlotWeight[0] = 10;
  c.m_dwColourWeight[0] = 10;
  const spy = spyOn(console, "error");
  expect(c.GetWinExp(0, [3])).toBe(0);
  expect(c.GetDrawExp(0)).toBe(0);
  c.m_vtColourCount[0] = 2;
  c.m_dwColourWeight[0] = 0;
  expect(c.GetWinExp(0, [3])).toBe(0);
  expect(spy).toHaveBeenCalledWith("Invalid CDynInfoCalculator context");
  spy.mockClear();
  c.m_nInvalidGame = 1;
  c.m_dwColourWeight[0] = 10;
  expect(c.GetWinExp(0, [3])).toBe(0);
  expect(c.GetDrawExp(0)).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("Init's per-colour average still feeds the uncancelled win formula", () => {
  const c = calc();
  const left = {};
  const right = {};
  const users = [0, 1, 2, 3].map((slot) => ({ m_nLevel: 0, m_pSocket: slot < 2 ? left : right }) as CUser);
  const states = new Uint8Array(24);
  states[2] = 0;
  states[5] = 0;
  states[8] = 1;
  states[11] = 1;
  c.Init([...users, null, null, null, null], states);
  expect(c.IsInvalidGame()).toBe(0);
  expect(c.GetTeamColor(0)).toBe(0);
  expect(c.GetWinExp(0, [0])).toBe(100);
  expect(c.GetDrawExp(3)).toBe(10);
});

test("loser kill/save exp is premium-only and does not log an invalid game", () => {
  const c = calc();
  c.m_vtColour[0] = 0;
  c.m_vtColourCount[0] = 2;
  c.m_dwColourWeight[0] = 10;
  c.m_vtKills[0] = 3;
  c.m_vtSaves[0] = 1;
  const spy = spyOn(console, "error");
  expect(c.GetKillNSaveExp(0)).toBe(0);
  c.m_nInvalidGame = 1;
  channel.m_nChannelType = PREMIUM_CHANNEL_TYPE;
  expect(c.GetKillNSaveExp(0)).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  c.m_nInvalidGame = 0;
  c.m_vtColourCount[0] = 0;
  expect(c.GetKillNSaveExp(0)).toBe(0);
  expect(spy).toHaveBeenCalledWith("Invalid CDynInfoCalculator context");
  spy.mockClear();
  c.m_vtColourCount[0] = 2;
  c.m_vtKills[0] = 8;
  c.m_vtSaves[0] = 0;
  expect(c.GetKillNSaveExp(0)).toBe(140);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
