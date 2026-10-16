import { expect, test } from "bun:test";
import vectors from "./fixtures/gameplay-vectors.json";
import { CGameContext } from "../FXGS/CGameContext.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { BombState, GameContextLimit } from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";

test("CGameContext native Init separates all state planes and preserves player timestamps/points", () => {
  const c = new CGameContext();
  c.m_aBoxItemState.fill(7);
  c.m_aObstacleState.fill(7);
  c.m_aHouseCount.fill(7);
  c.m_aHouseState.fill(7);
  c.m_aBulaState.fill(7);
  c.m_aPlayerStateTime[3] = 0xfedcba98;
  c.m_aGhostPosition[3] = { x: 17, y: 23 };
  c.m_nNextBoxItem = 249;
  c.m_nNextBombSerialNo = 500;
  c.Init();
  expect(c.m_aBoxItemState.length).toBe(250);
  expect(c.m_aObstacleState.length).toBe(195);
  expect(c.m_aBulaState.length).toBe(1170);
  expect(c.m_aHouseState.length).toBe(195);
  expect(
    [...c.m_aBoxItemState, ...c.m_aObstacleState, ...c.m_aHouseCount].every(
      (x) => x === 0,
    ),
  ).toBe(true);
  expect([...c.m_aBulaState, ...c.m_aHouseState].every((x) => x === -1)).toBe(
    true,
  );
  expect(c.m_aPlayerStateTime[3]).toBe(0xfedcba98);
  expect(c.m_aGhostPosition[3]).toEqual({ x: 17, y: 23 });
  expect(c.m_nNextBombSerialNo).toBe(0);
  expect(c.m_nNextBoxItem).toBe(126);
  const generated = Array.from({ length: 124 }, () => c.AddBoxItem());
  expect(generated).toEqual(Array.from({ length: 124 }, (_, i) => i + 126));
  expect(c.AddBoxItem()).toBe(-1);
  expect(c.AddBoxItem()).toBe(-1);
});
test("Bula 26x45 and house/obstacle 13x15 have distinct bounded coordinates; house score is per color", () => {
  const c = new CGameContext();
  c.Init();
  c.SetBulaState(25, 44, 7);
  expect(c.GetBulaState(25, 44)).toBe(7);
  expect(c.GetHouseState(12, 14)).toBe(-1);
  c.SetHouseState(12, 14, 2, 5);
  expect(c.GetHouseState(12, 14)).toBe(2);
  expect(c.m_aHouseCount[5]).toBe(1);
  expect(c.m_aHouseCount[2]).toBe(0);
  c.SetObstacleState(12, 14, 1);
  expect(c.GetObstacleState(12, 14)).toBe(1);
  expect(c.GetHouseState(12, 14)).toBe(2);
  for (const [row, column] of [
    [-1, 0],
    [13, 0],
    [0, 15],
    [0, 0.5],
    [0, NaN],
  ])
    expect(() => c.SetHouseState(row!, column!, 1, 1)).toThrow("coordinate");
  expect(() => c.GetBulaState(26, 0)).toThrow("coordinate");
  expect(c.m_aHouseCount[1]).toBe(0);
});
test("bomb update matches independent fixed-width C++ loops, swap-last order and native opcode-152 body", () => {
  const c = new CGameContext();
  c.Init();
  c.m_aBomb.push(...vectors.initialBombs.map((row) => ({ ...row })));
  for (const step of vectors.bombSteps) {
    const events = c.AdvanceBombTimers(step.delta);
    expect(events).toEqual(step.events);
    expect(c.m_aBomb).toEqual(step.bombs);
    const packet = new CSendPacket(152).Encode1(events.length);
    for (const event of events)
      packet.Encode2(event.SerialNo).Encode1(event.Landed ? 1 : 0);
    expect(packet.GetBuffer().toString("hex")).toBe(step.body);
  }
});
test("bomb pause, shortening, movement landing, stale coordinates and capacity follow native state rules", () => {
  const c = new CGameContext();
  c.Init();
  const bomb = c.AddBomb(0x12, 0xc3);
  expect(bomb).toEqual({
    SerialNo: 0,
    State: 0,
    RemainingMilliseconds: 2800,
    Row: 1,
    Column: 2,
    Power: 3,
    RemotelyPaused: true,
  });
  expect(c.AdvanceBombTimers(10000)).toEqual([]);
  expect(bomb.RemainingMilliseconds).toBe(2800);
  expect(c.SetBombTimer(0, 0x13, 1)).toBe(false);
  expect(bomb.RemotelyPaused).toBe(true);
  expect(c.SetBombTimer(0, 0x12, 6000)).toBe(true);
  expect(bomb.RemainingMilliseconds).toBe(2800);
  expect(bomb.RemotelyPaused).toBe(false);
  expect(c.KickBomb(0, 0x13, 0x22, 100)).toBe(false);
  expect(c.KickBomb(0, 0x12, 0x22, 100)).toBe(true);
  expect(bomb.State).toBe(BombState.Moving);
  expect(c.SetBombTimer(0, 0x22, 0)).toBe(false);
  expect(c.AdvanceBombTimers(100)).toEqual([{ SerialNo: 0, Landed: true }]);
  expect(bomb.RemainingMilliseconds).toBe(2000);
  expect(c.AdvanceBombTimers(1999)).toEqual([]);
  expect(c.AdvanceBombTimers(1)).toEqual([{ SerialNo: 0, Landed: false }]);
  expect(c.m_aBomb.length).toBe(0);
  for (let i = 0; i < 150; i++) c.AddBomb(0x12, 3);
  expect(() => c.AddBomb(0x12, 3)).toThrow("overflow");
  const full = c.m_aBomb.length;
  expect(() => c.AddBomb(0xdf, 3)).toThrow();
  expect(c.m_aBomb.length).toBe(full);
  expect(() => c.AdvanceBombTimers(-1)).toThrow("delta");
  expect(GameContextLimit.Bombs).toBe(150);
});
for (const scenario of vectors.clocks)
  test(`CGameClock independent C++ reference: ${scenario.name}`, () => {
    let now = 0;
    const errors: string[] = [];
    const clock = new CGameClock(
      () => now,
      (error) => errors.push(error),
    );
    for (const step of scenario.steps) {
      now = step.time;
      switch (step.op) {
        case "start":
          clock.StartGame();
          break;
        case "end":
          clock.EndGame();
          break;
        case "suspend":
          clock.SuspendGame();
          break;
        case "resume":
          clock.ResumeGame();
          break;
      }
      expect(clock.GetStartGameTime()).toBe(step.start);
      expect(clock.GetEndGameTime()).toBe(step.end);
      expect(clock.m_dwTimeStopped).toBe(step.stopped);
      expect(clock.ElapsedTime()).toBe(step.elapsed);
      expect(clock.GetRealElapsedTime()).toBe(step.real);
      expect(errors).toEqual(step.errors);
    }
  });
test("116 is LaunchGameStage; native start-running is 150 and settlement is 163, not 116", () => {
  expect(ServerResponse.StartGame).toBe(115);
  expect(ServerResponse.LaunchGameStage).toBe(116);
  expect(ServerResponse.BeginGame).toBe(150);
  expect(ServerResponse.GameResult).toBe(163);
});
