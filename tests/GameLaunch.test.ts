import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import {
  ChannelType,
  GamePlayerState,
  GameStage,
  SessionLimit,
  SlotStateMask,
  StartGameResult,
  DynInfoLayout,
} from "../Common/OfficialValues.ts";
import { CItemAttr } from "../FXGS/CItemAttr.ts";
import { CServerApp } from "../CServerApp.ts";
import { TestConfig } from "./helpers/Accounts.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import { CGameSessionTable } from "../FXGS/CGameSessionTable.ts";
import { CGameMapTmpl } from "../FXGS/CGameMapTmpl.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import { MissionInfo } from "../FXGS/MissionInfo.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import {
  GameLaunchFixture,
  LaunchReadyPacket,
  DiscoverLaunchPeer,
  LaunchResources,
} from "./helpers/GameLaunch.ts";
import { Received } from "./helpers/Clients.ts";
import vectors from "./fixtures/game-launch-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function game(
  counts: readonly number[] = [2, 1],
  channel = ChannelType.Normal as number,
  random: () => number = () => 1,
  joinTime = 100,
) {
  const e = GameLaunchFixture(counts, channel, random, joinTime);
  cleanup.push(e.close);
  return e;
}
type Environment = ReturnType<typeof game>;
function launch(e: Environment): void {
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
}
function ready(e: Environment, index: number): void {
  const peer = e.clients[index]!;
  e.table.OnPacket(Received(LaunchReadyPacket(e.room, peer)), peer);
}
function discover(e: Environment, index: number): void {
  expect(DiscoverLaunchPeer(e.room, e.clients[index]!, 40000 + index)).toBe(
    true,
  );
}
function opcodes(e: Environment): number[][] {
  return e.clients.map((p) => p.packets.map((packet) => packet.m_nPacketType));
}
function snapshot(e: Environment) {
  return {
    slots: e.room.m_rgSlotInfo.map((s) => [...s]),
    states: [...e.room.m_aPlayerState],
    bom: [...e.room.m_aBomberIdxPlaying],
    context: [...e.room.GetCurrentGameContext().m_aBoxItemState],
    statistics: e.room.m_dynInfoCalculator.IsInitialized(),
    playing: e.room.m_bPlaying,
    generation: e.room.GetGameLaunchState(),
    result: e.room.GetResultRoundID(),
  };
}
function receipts(e: Environment): number {
  return e.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
    .get()!.n;
}

// These C++ vectors do not import production launch/map/packet functions. The
// read-only PE anchors attest instruction identity, NOT original execution.
test("independent manual launch vectors match the supplied PE's twenty-five instruction anchors", () => {
  const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(image.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(25);
  for (const row of vectors.InstructionAnchors)
    expect(image.read(row.VA, row.Bytes.length / 2).toString("hex")).toBe(
      row.Bytes,
    );
});
test("510 independent occupied-color subsets preserve upper bits and use native start remapping, not waiting redistribution", () => {
  const e = game([2, 2, 2, 2]);
  for (const row of vectors.Colors) {
    for (const [slot, value] of row.Before.entries())
      e.room.m_rgSlotInfo[slot]![2] = value;
    const plan = e.room.MakeStartColorStates(row.MaxTeams === 8 ? 200 : 0);
    expect(plan.map((s) => s[2])).toEqual(row.After);
    expect(plan.flatMap((s, i) => (s[2] === row.Before[i] ? [] : [i]))).toEqual(
      row.Changed,
    );
    expect(e.room.m_rgSlotInfo.map((s) => s[2])).toEqual(row.Before);
    expect(plan.every((s, i) => s !== e.room.m_rgSlotInfo[i])).toBe(true);
  }
});
test("2160 independent random-map filter combinations cover Guild77, premium41, practice, authority and zero-draw failure", () => {
  const maps = new CGameMapTmplList();
  for (const [index, m] of vectors.MapMetadata.entries()) {
    const words = [
      1001,
      m.Teams,
      1,
      15,
      13,
      m.Players,
      m.Level,
      m.Premium,
      0,
      0,
      0,
      0,
      0,
      m.Mission,
      0,
      0,
      0,
      0,
    ];
    const bytes = Buffer.alloc(words.length * 4);
    words.forEach((value, i) => bytes.writeInt32LE(value, i * 4));
    maps.m_aMapTmpl.push(
      new CGameMapTmpl(
        `Map/Test${index}`,
        bytes,
        m.Theme,
        false,
        !!m.Practice,
        false,
      ),
    );
  }
  for (const row of vectors.RandomMaps) {
    let calls = 0;
    expect(
      maps.GetRandomMapIdx(
        row.Players,
        row.Level,
        row.Theme,
        row.Practice,
        row.MinimumTeams,
        !!row.Auth,
        row.Channel,
        () => {
          calls++;
          return row.Draw;
        },
      ),
    ).toBe(row.Expected);
    expect(calls).toBe(row.Draws);
  }
});
for (const row of vectors.Starts)
  test(`106/discovery/109 starts native map${row.Map}, tick${row.Time}, key${row.Key} without a trusted Running adapter`, () => {
    const e = game([2, 1], ChannelType.Normal, () => row.Key),
      room = e.room;
    const chief = room.m_rgPlayer[room.m_nChiefSlotidx]!;
    chief.m_userInfo.Exp = 1_000_000_000;
    chief.SetLevel();
    chief.SetAuthenCode(1);
    room.m_nMapIdx = row.Map;
    e.random(() => 1);
    const context = room.GetCurrentGameContext();
    context.m_aBoxItemState.fill(7);
    context.m_aPlayerStateTime.fill(12345);
    context.m_aGhostPosition[0] = { x: 1000, y: 2000 };
    room.m_aShopItemAttempted.fill(17);
    room.m_aPlayerState.fill(GamePlayerState.PendingDie);
    // Discovery may legitimately precede106; launch MUST NOT erase it.
    discover(e, 0);
    discover(e, 1);
    e.clear();
    const joins = room.m_rgPlayer.flatMap((u, slot) =>
      u ? [room.GetPlayerJoinTime(slot)] : [],
    );
    launch(e);
    expect(room.IsLoadingGame()).toBe(true);
    expect(room.GetResultRoundID()).toBeUndefined();
    expect(e.table.GetLoadingSessionCount()).toBe(1);
    expect(e.table.GetScheduledRoundCount()).toBe(0);
    expect(room.m_dynInfoCalculator.IsInitialized()).toBe(true);
    expect([...room.m_aPlayerState]).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
    expect([...room.m_aShopItemAttempted]).toEqual(Array(8).fill(0));
    expect([...context.m_aBoxItemState].every((n) => n === 0)).toBe(true);
    expect([...context.m_aPlayerStateTime]).toEqual(Array(8).fill(12345));
    expect(context.m_aGhostPosition[0]).toEqual({ x: 1000, y: 2000 });
    expect(
      room.m_rgPlayer.flatMap((u, slot) =>
        u ? [room.GetPlayerJoinTime(slot)] : [],
      ),
    ).toEqual(joins);
    for (const peer of e.clients)
      expect(
        peer.packets
          .find((p) => p.m_nPacketType === 173)!
          .m_pBlock.toString("hex"),
      ).toBe(row.Airplane);
    const loading = room.GetGameLaunchState();
    expect(loading.LaunchTime).toBe(100);
    expect(loading.Mission).toEqual(
      room.maps.GetMapTmpl(row.Map).m_aMissionInfo,
    );
    expect(loading.LapSort).toEqual(Array(16).fill(0xffffffff));
    expect(loading.LapPrefix).toEqual(Array(8).fill(0));
    expect({
      ByPlayer: [...room.m_anSlotGhost],
      ByGhost: [...room.m_anGhostSlot],
    }).toEqual({ ByPlayer: Array(8).fill(-1), ByGhost: Array(8).fill(-1) });
    e.time(200);
    e.table.UpdateGameSessions();
    expect(room.GetLastUpdateTime()).toBe(200);
    e.time(row.Time);
    ready(e, 0);
    expect(room.GetResultRoundID()).toBeUndefined();
    ready(e, 1);
    expect(room.m_nGameState).toBe(GameStage.Running);
    expect(room.IsLoadingGame()).toBe(false);
    expect(e.table.GetLoadingSessionCount()).toBe(0);
    expect(e.table.GetScheduledRoundCount()).toBe(1);
    expect(room.GetResultRoundID()).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipts(e)).toBe(0);
    expect(room.GetLastUpdateTime()).toBe(200);
    expect(e.clock.GetStartGameTime()).toBe(row.Time);
    expect(e.table.GetUpdateFailures()).toEqual([]);
    for (const peer of e.clients) {
      const begin = peer.packets.find((p) => p.m_nPacketType === 150)!;
      expect(begin.m_pBlock.toString("hex")).toBe(row.Begin);
      const types = peer.packets.map((p) => p.m_nPacketType);
      expect(types.at(-1)).toBe(150);
      expect(types.filter((n) => n === 175)).toHaveLength(row.Sync);
      if (row.Sync) expect(types.indexOf(175)).toBeLessThan(types.indexOf(150));
    }
    const state = room.GetGameLaunchState();
    expect(state.NativeLaunch).toBe(true);
    expect(state.GameSequence).toBe(row.NextSequence);
    expect(state.GameSequenceKey).toBe(row.Key);
    expect(state.GhostStart).toBe(row.GhostMilliseconds);
    expect(state.GhostFrequency).toBe(row.FrequencyMilliseconds);
    expect(state.RebirthMap).toBe(row.Rebirth);
    expect(state.Opaque11612).toEqual([-1, -1]);
    expect(state.Opaque12552).toBe(0);
    expect(state.LastAirplaneRequestTime).toBe(0);
    expect(room.m_syncGameObjMan.GetObjectCount()).toBe(row.Sync);
    const round = room.GetResultRoundID(),
      beforeSequence = state.GameSequence;
    e.clear();
    room.DeferStartGame();
    e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
    expect(room.GetResultRoundID()).toBe(round);
    expect(room.GetGameLaunchState().GameSequence).toBe(beforeSequence);
    expect(opcodes(e)).toEqual([[], []]);
  });

test("success publishes115/changed-only107/116/173 with remapped launch colors already bound into statistics", () => {
  const e = game([1, 1]);
  e.room.m_rgPlayer[0]!.SetAuthenCode(1);
  e.room.m_nMapIdx = 0;
  e.room.m_rgSlotInfo[0]![2] = 0x80 | 7;
  e.room.m_rgSlotInfo[1]![2] = 0x80 | 3;
  launch(e);
  expect(opcodes(e)).toEqual([
    [115, 107, 116, 173],
    [107, 116, 173],
  ]);
  expect(e.clients[0]!.Take(115).Decode1()).toBe(StartGameResult.Valid);
  const changed = e.clients[0]!.Take(107);
  expect(changed.Decode1()).toBe(0);
  expect([...changed.DecodeBuffer(3)]).toEqual([...e.room.m_rgSlotInfo[0]!]);
  changed.AssertEnd();
  expect(e.room.m_rgSlotInfo.map((s) => s[2]).slice(0, 2)).toEqual([
    0x80, 0x83,
  ]);
  expect(e.room.m_dynInfoCalculator.GetTeamColor(0)).toBe(0);
  expect(e.room.m_dynInfoCalculator.GetTeamColor(1)).toBe(3);
  expect(e.notices).toEqual([86]);
});
test("109-first stays Loading until discovery supplies ALL slots, including the second local player", () => {
  const e = game();
  launch(e);
  e.clear();
  ready(e, 0);
  ready(e, 1);
  expect(e.room.IsAllPlayerReadyForStart()).toBe(false);
  expect(e.room.GetResultRoundID()).toBeUndefined();
  discover(e, 1);
  expect(e.room.m_nGameState).toBe(GameStage.Loading);
  discover(e, 0);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(opcodes(e)).toEqual([
    [120, 120, 150],
    [120, 120, 150],
  ]);
});
test("malformed second-local109 attributes do not change either ready bit or initialize a result round", () => {
  const e = game();
  launch(e);
  e.clear();
  discover(e, 0);
  discover(e, 1);
  e.clear();
  const before = snapshot(e),
    packet = LaunchReadyPacket(e.room, e.clients[0]!);
  packet.Encode1At(packet.m_uOffset - 1, 255);
  expect(() => e.table.OnPacket(Received(packet), e.clients[0]!)).toThrow(
    "attributes",
  );
  expect(snapshot(e)).toEqual(before);
  expect(opcodes(e)).toEqual([[], []]);
  expect(receipts(e)).toBe(0);
  const crc = LaunchReadyPacket(e.room, e.clients[0]!);
  crc.Encode4At(1, 0);
  expect(() => e.table.OnPacket(Received(crc), e.clients[0]!)).toThrow(
    "CRC mismatch",
  );
  expect(snapshot(e)).toEqual(before);
});
test("failed readiness validates the selected playing map first but produces ONLY115 and no launch/reset/statistics", () => {
  const e = game();
  e.room.m_nMapIdx = -1;
  let draws = 0;
  e.random(() => {
    draws++;
    return 1;
  });
  e.room.m_rgSlotInfo[2]![0] =
    e.room.m_rgSlotInfo[2]![0]! & ~SlotStateMask.Status;
  const before = snapshot(e);
  launch(e);
  expect(draws).toBe(1);
  expect(e.room.m_nMapIdxPlaying).toBeGreaterThanOrEqual(0);
  expect(snapshot(e)).toEqual(before);
  expect(opcodes(e)).toEqual([[115], []]);
  expect(e.clients[0]!.Take(115).Decode1()).toBe(StartGameResult.NotReady);
  expect(receipts(e)).toBe(0);
});
test("authencode1 bypasses random candidate filtering, NOT the final selected-map level requirement", () => {
  const e = game();
  e.room.m_rgPlayer[0]!.SetAuthenCode(1);
  e.room.m_nMapIdx = 194;
  launch(e);
  expect(e.clients[0]!.Take(115).Decode1()).toBe(StartGameResult.LevelLimit);
  expect(e.room.m_nMapIdxPlaying).toBe(194);
  expect(e.room.m_bPlaying).toBe(false);
  expect(e.room.m_dynInfoCalculator.IsInitialized()).toBe(false);
  expect(e.room.GetResultRoundID()).toBeUndefined();
});
test("nonchief, trailing payload, invalid RNG and sparse local-group requests fail before success or mutation", () => {
  const e = game(),
    before = snapshot(e);
  expect(() =>
    e.table.OnPacket(Received(new CSendPacket(106)), e.clients[1]!),
  ).toThrow(CProtocolError);
  expect(() =>
    e.table.OnPacket(Received(new CSendPacket(106).Encode1(0)), e.clients[0]!),
  ).toThrow(CProtocolError);
  for (const value of [NaN, Infinity, -1, 0x8000, 1.5, undefined]) {
    e.random(() => value as number);
    expect(() => launch(e)).toThrow(CProtocolError);
    expect(snapshot(e)).toEqual(before);
    expect(opcodes(e)).toEqual([[], []]);
  }
  e.random(() => 1);
  const second = e.clients[0]!.m_aUser[1]!;
  delete e.clients[0]!.m_aUser[1];
  expect(() => launch(e)).toThrow(CProtocolError);
  e.clients[0]!.m_aUser[1] = second;
  expect(snapshot(e)).toEqual(before);
  expect(opcodes(e)).toEqual([[], []]);
});
test("resources without durable-result wiring remain gated, never manufacture successful115/116/150", () => {
  const e = game(),
    table = new CGameSessionTable(
      new CTextCodec(),
      e.room.bombers,
      e.room.maps,
      ChannelType.Normal,
      () => {},
      undefined,
      { Items: LaunchResources.items, Random: () => 1 },
    );
  // Direct, separate kernel generation: same injected auth fixtures, no Running.
  const room = new CGameSession(
    17,
    10,
    "gated",
    "",
    0,
    new CTextCodec(),
    e.room.bombers,
    e.room.maps,
    ChannelType.Normal,
    e.clock,
    undefined,
    undefined,
    { Items: LaunchResources.items, Random: () => 1 },
  );
  const a = e.clients[0]!,
    b = e.clients[1]!;
  room.AddAllUser(a, [0, 0]);
  room.AddAllUser(b, [0]);
  room.OnPacket(Received(new CSendPacket(96).Encode1(1)), b);
  room.m_nMapIdx = 200;
  e.clear();
  expect(() => room.OnPacket(Received(new CSendPacket(106)), a)).toThrow(
    CUnsupportedOperation,
  );
  expect(room.m_bPlaying).toBe(false);
  expect(room.GetResultRoundID()).toBeUndefined();
  expect(opcodes(e)).toEqual([[], []]);
  expect(table.GetLoadingSessionCount()).toBe(0);
});
test("transition sends observe committed state; callback reentry cannot mutate launch/discovery/start/result binding", () => {
  const e = game(),
    room = e.room,
    peer = e.clients[0]!,
    original = peer.SendPacket;
  let calls = 0;
  peer.SendPacket = function (packet) {
    calls++;
    expect(room.m_bPlaying).toBe(true);
    expect(room.m_dynInfoCalculator.IsInitialized()).toBe(true);
    expect(() =>
      room.OnPacket(Received(new CSendPacket(96).Encode1(1)), peer),
    ).toThrow("round update");
    expect(() =>
      room.OnRequestStartGame(Received(new CSendPacket()), peer),
    ).toThrow();
    expect(() => DiscoverLaunchPeer(room, peer)).toThrow("transition");
    expect(() => room.DeferStartGame()).toThrow("transition");
    expect(() => room.BeginResultLifecycle()).toThrow();
    expect(() => room.DeleteAllUser(peer)).toThrow();
    expect(() => room.SetMapIdxPlayingByLevel(1, 0, false)).toThrow();
    expect(() => room.SendGameTypeNormal()).toThrow();
    expect(() => room.SendGameTypeMod()).toThrow();
    expect(room.DeferHandleGameEnd()).toBe(false);
    expect(room.UpdateResultLifecycle()).toBe(false);
    expect(room.DeferReturnPrepareStage()).toBe(false);
    expect(room.DoReturnPrepareStage()).toBe(false);
    room.Update();
    original.call(this, packet);
  };
  launch(e);
  peer.SendPacket = original;
  expect(calls).toBe(3);
  expect(opcodes(e)).toEqual([
    [115, 116, 173],
    [116, 173],
  ]);
  discover(e, 0);
  discover(e, 1);
  ready(e, 0);
  e.clear();
  peer.SendPacket = function (packet) {
    if (packet.m_nPacketType === 150) {
      expect(room.m_nGameState).toBe(GameStage.Running);
      expect(room.GetResultRoundID()).toBeDefined();
      expect(() => room.DeferStartGame()).toThrow();
    }
    original.call(this, packet);
  };
  ready(e, 1);
  peer.SendPacket = original;
  expect(opcodes(e)).toEqual([[150], [150]]);
});
test("throwing transports do not undo committed launch or duplicate start packets/generation", () => {
  const e = game(),
    peer = e.clients[0]!,
    original = peer.SendPacket;
  peer.SendPacket = () => {
    throw new Error("test delivery failure");
  };
  launch(e);
  peer.SendPacket = original;
  expect(e.room.IsLoadingGame()).toBe(true);
  expect(e.clients[1]!.packets.map((p) => p.m_nPacketType)).toEqual([116, 173]);
  discover(e, 0);
  discover(e, 1);
  ready(e, 0);
  e.clear();
  peer.SendPacket = () => {
    throw new Error("test delivery failure");
  };
  ready(e, 1);
  peer.SendPacket = original;
  const key = e.room.GetResultRoundID();
  expect(key).toBeDefined();
  expect(opcodes(e)).toEqual([[], [150]]);
  e.room.DeferStartGame();
  expect(e.room.GetResultRoundID()).toBe(key);
  expect(opcodes(e)).toEqual([[], [150]]);
  expect(e.room.GetPacketPublicationFailureCount()).toBeGreaterThanOrEqual(4);
});
test("loading timeout uses JOIN-relative strict25s, table recovery, secondary notice guards and can start ready survivors", () => {
  const e = game([1, 2]),
    dropped = e.clients[1]!;
  discover(e, 0);
  launch(e);
  ready(e, 0);
  e.clear();
  const joined = e.room.GetPlayerJoinTime(1);
  e.time((joined + 25000) >>> 0);
  e.table.UpdateGameSessions();
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(opcodes(e)).toEqual([[], []]);
  e.time((joined + 25001) >>> 0);
  e.table.UpdateGameSessions();
  expect(e.room.GetCurPlayer()).toBe(1);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.GetResultRoundID()).toBeDefined();
  expect(e.room.GetLastUpdateTime()).toBe((joined + 25001) >>> 0);
  expect(
    dropped.m_aUser.every((u) => u.m_nSessionIdx === SessionLimit.NoSession),
  ).toBe(true);
  expect(dropped.packets.map((p) => p.m_nPacketType)).toEqual([195]);
  expect(e.clients[0]!.packets.map((p) => p.m_nPacketType)).toEqual([
    106, 106, 150,
  ]);
  expect(e.notices).toEqual([86]);
  expect(e.table.GetUpdateFailures()).toEqual([]);
  expect(
    e.room.m_dynInfoCalculator
      .GetStateBytes()
      .readInt32LE(DynInfoLayout.PlayerCount * 4),
  ).toBe(3); // original launch snapshot retained
});
test("all unpeered loading sockets recover and close87 without stale86 or a fabricated150", () => {
  const e = game();
  launch(e);
  e.clear();
  e.time(25101);
  e.table.UpdateGameSessions();
  expect(e.room.GetCurPlayer()).toBe(0);
  expect(!!e.table.GetBaseSession(e.room.m_nIdx, e.room.m_ulSerialNo)).toBe(
    false,
  );
  expect(e.room.m_bPlaying).toBe(true);
  expect(e.room.GetResultRoundID()).toBeUndefined();
  expect(opcodes(e)).toEqual([[195], [106, 106, 107, 107, 195]]);
  expect(e.notices).toEqual([86, 87]);
  expect(e.table.GetLoadingSessionCount()).toBe(0);
  expect(e.table.GetScheduledRoundCount()).toBe(0);
  expect(receipts(e)).toBe(0);
  expect(e.table.GetUpdateFailures()).toEqual([]);
});
test("25s peer budget is not restarted by late106; UInt32 join-time rollover remains strict", () => {
  const e = game([1, 1]);
  e.time(25099);
  launch(e);
  e.clear();
  e.time(25100);
  e.table.UpdateGameSessions();
  expect(e.room.GetCurPlayer()).toBe(2);
  e.clear();
  e.time(25101);
  e.table.UpdateGameSessions();
  expect(e.room.GetCurPlayer()).toBe(0);
  expect(e.notices).toEqual([86, 87]);
  const rolled = game([1, 1]);
  // Rejoin through the ordinary table so AddUser records the wrap-edge join tick.
  const a = rolled.clients[0]!,
    b = rolled.clients[1]!;
  rolled.time(0xfffffff0);
  rolled.table.DestroyPlayer(b);
  rolled.table.DestroyPlayer(a);
  rolled.table.OnPacket(
    Received(
      new CSendPacket(80)
        .EncodeStr("rollover")
        .EncodeStr("")
        .Encode1(0)
        .Encode1(1)
        .Encode1(0),
    ),
    a,
  );
  const room = rolled.table.GetSession(a)!;
  rolled.table.DoJoinSession(b, room.m_nIdx, room.m_ulSerialNo, "", [0]);
  room.m_nMapIdx = 200;
  room.OnPacket(Received(new CSendPacket(96).Encode1(1)), b);
  rolled.table.OnPacket(Received(new CSendPacket(106)), a);
  rolled.clear();
  rolled.time((0xfffffff0 + 25000) >>> 0);
  rolled.table.UpdateGameSessions();
  expect(room.GetCurPlayer()).toBe(2);
  rolled.clear();
  rolled.time((0xfffffff0 + 25001) >>> 0);
  rolled.table.UpdateGameSessions();
  expect(room.GetCurPlayer()).toBe(0);
  expect(rolled.notices).toEqual([86, 87]);
  expect(rolled.table.GetUpdateFailures()).toEqual([]);
});
test("MissionInfo stores only four signed opaque words, validates atomically and never interprets pointer-looking fields", () => {
  const mission = new MissionInfo();
  mission.Assign([0, 1, 2090075592, 15233840]);
  const before = mission.GetWords(),
    copy = mission.GetWords() as number[];
  copy[2] = -1;
  expect(mission.GetWords()).toEqual(before);
  expect(mission.GetType()).toBe(0);
  for (const bad of [
    [1, 2, 3],
    [1, 2, 3, 0x80000000],
    [1, 2, NaN, 3],
    Array(4),
  ]) {
    expect(() => mission.Assign(bad)).toThrow(CProtocolError);
    expect(mission.GetWords()).toEqual(before);
  }
  mission.Assign([-1, -2147483648, 2147483647, 0]);
  expect(mission.GetWords()).toEqual([-1, -2147483648, 2147483647, 0]);
});
test("launch diagnostics are detached and cannot forge a committed native token or result key", () => {
  const e = game();
  launch(e);
  const state = e.room.GetGameLaunchState();
  (state.LapSort as number[])[0] = 123;
  (state.Mission as number[])[0] = 999;
  (state.Opaque11612 as number[])[0] = 7;
  expect(e.room.GetGameLaunchState().LapSort[0]).toBe(0xffffffff);
  expect(e.room.GetGameLaunchState().Mission[0]).toBe(0);
  expect(e.room.GetGameLaunchState().Opaque11612).toEqual([-1, -1]);
  expect(e.room.GetResultRoundID()).toBeUndefined();
});

/** Separate original constructor enables native DWORD serial-wrap cases without
 * manipulating private sequence fields or using a trusted Running hook. */
function originalRoom(
  e: Environment,
  serial = 1,
  key = 1,
  maps = e.room.maps,
  items = LaunchResources.items,
): CGameSession {
  return new CGameSession(
    17,
    serial,
    "Original constructor",
    "",
    0,
    new CTextCodec(),
    e.room.bombers,
    maps,
    ChannelType.Normal,
    e.clock,
    { DB: e.db, ChannelIndex: 0, UpdateRankList: () => {} },
    undefined,
    { Items: items, Random: () => key },
  );
}
test("six independent sequence vectors cover room serial0/1/FFFFFFFF, per-room keys0/7FFF and native DWORD increment wrap", () => {
  for (const row of vectors.Sequences) {
    const e = game(),
      room = originalRoom(e, row.Before, row.Key),
      [a, b] = e.clients;
    room.AddAllUser(a!, [0, 0]);
    room.AddAllUser(b!, [0]);
    room.m_nMapIdx = 200;
    room.OnPacket(Received(new CSendPacket(96).Encode1(1)), b!);
    e.clear();
    room.OnPacket(Received(new CSendPacket(106)), a!);
    for (const peer of e.clients)
      room.OnPacket(Received(LaunchReadyPacket(room, peer)), peer);
    e.time(7);
    DiscoverLaunchPeer(room, a!);
    DiscoverLaunchPeer(room, b!);
    expect(room.m_nGameState).toBe(GameStage.Running);
    expect(room.GetGameLaunchState().GameSequence).toBe(row.After);
    expect(room.GetGameLaunchState().GameSequenceKey).toBe(row.Key);
    expect(room.GetResultRoundID()).toBeDefined();
    for (const peer of e.clients)
      expect(
        peer.packets
          .find((p) => p.m_nPacketType === 150)!
          .m_pBlock.toString("hex"),
      ).toBe(row.Begin);
    expect(receipts(e)).toBe(0);
  }
});
test("eight independent173 vectors distinguish mission1 from ordinary/other types, retain raw DWORD milliseconds and never apply an ordinary ladder cap", () => {
  const e = game();
  for (const row of vectors.Airplanes) {
    const maps = new CGameMapTmplList(),
      words = [
        1001,
        8,
        1,
        15,
        13,
        8,
        1,
        0,
        0,
        0,
        0,
        row.Initial | 0,
        row.Frequency,
        row.Mission,
        0,
        0,
        0,
        0,
      ];
    const bytes = Buffer.alloc(words.length * 4);
    words.forEach((word, i) => bytes.writeInt32LE(word, i * 4));
    maps.m_aMapTmpl.push(
      new CGameMapTmpl("Map/Plane00", bytes, 0, true, false, false),
    );
    const room = originalRoom(e, 1, 1, maps);
    expect(room.IsLadderGame()).toBe(0);
    expect(
      room.MakeAirplaneItemProbPacket(0)!.GetBuffer().toString("hex"),
    ).toBe(row.Packet);
  }
  const missing = new CItemAttr(),
    room = originalRoom(e, 1, 1, e.room.maps, missing);
  expect(room.MakeAirplaneItemProbPacket(200)).toBeUndefined();
  missing.LoadAirplaneItemInfoData("1 DeliberatelyUnknownNativeName 255 0");
  const packet = Received(room.MakeAirplaneItemProbPacket(200)!);
  expect(packet.Decode1()).toBe(173);
  expect(packet.Decode4()).toBe(60000);
  expect(packet.Decode4()).toBe(22000);
  expect(packet.Decode1()).toBe(1);
  expect(packet.Decode1()).toBe(255);
  expect(packet.Decode1()).toBe(255);
  packet.AssertEnd();
});
test("all48 independent join/deadline vectors match loading traversal; callback-driven mid-loop Playing=false uses native30s, not a restarted launch budget", () => {
  for (const row of vectors.LoadingDeadlines) {
    const e = game([1, 1], ChannelType.Normal, () => 1, row.Joined);
    launch(e);
    e.clear();
    if (!row.Playing) {
      const original = e.table.EjectPlayerForUDP;
      // Explicit synthetic changing-state edge only, not a network transition or
      // proof of the still-unported full waiting-chief/BangPok traversal.
      e.table.EjectPlayerForUDP = function (room, peer, user) {
        original.call(this, room, peer, user);
        room.SetPlaying(false);
      };
    }
    e.time(row.Now);
    e.table.UpdateGameSessions();
    expect(!!e.table.GetSession(e.clients[1]!)).toBe(!row.Expired);
    const firstExpired = (row.Now - row.Joined) >>> 0 > 25000;
    expect(!!e.table.GetSession(e.clients[0]!)).toBe(!firstExpired);
    expect(e.room.GetLastUpdateTime()).toBe(row.Now);
    expect(e.table.GetUpdateFailures()).toEqual([]);
    expect(
      e.clients.every((peer) =>
        peer.packets.every((p) => p.m_nPacketType !== 150),
      ),
    ).toBe(true);
    expect(receipts(e)).toBe(0);
  }
});
test("committed Loading cannot replace statistics or use public start/map/mode adapters to forge another generation", () => {
  const e = game();
  launch(e);
  e.clear();
  const before = snapshot(e);
  expect(() => e.room.PrepareRoundStatistics()).toThrow("active launch");
  expect(() => e.room.SetMapIdxPlayingByLevel(1, 0, false)).toThrow("active");
  expect(() => e.room.BeginResultLifecycle()).toThrow();
  expect(() =>
    e.room.OnPacket(Received(new CSendPacket(103)), e.clients[0]!),
  ).toThrow(CUnsupportedOperation);
  expect(snapshot(e)).toEqual(before);
  expect(opcodes(e)).toEqual([[], []]);
  expect(receipts(e)).toBe(0);
});
test("Loading and Running retain native97 echo-only,99/100 ignore and98 broadcast-without-mutation semantics", () => {
  const e = game();
  launch(e);
  e.clear();
  for (const running of [false, true]) {
    if (running) {
      discover(e, 0);
      discover(e, 1);
      ready(e, 0);
      ready(e, 1);
      e.clear();
    }
    const before = snapshot(e),
      actualMap = e.room.m_nMapIdxPlaying;
    e.room.OnPacket(
      Received(new CSendPacket(97).Encode2(0x7fff)),
      e.clients[0]!,
    );
    for (const peer of e.clients) {
      const p = peer.Take(112);
      expect(p.Decode2()).toBe(200);
      p.AssertEnd();
    }
    expect(e.room.m_nMapIdx).toBe(200);
    expect(e.room.m_nMapIdxPlaying).toBe(actualMap);
    // Native wrappers ignore even a payload-less99/100 while playing.
    e.room.OnPacket(Received(new CSendPacket(99)), e.clients[0]!);
    e.room.OnPacket(Received(new CSendPacket(100)), e.clients[1]!);
    expect(opcodes(e)).toEqual([[], []]);
    e.room.OnPacket(Received(new CSendPacket(98).Encode1(0x17)), e.clients[0]!);
    for (const peer of e.clients) {
      const p = peer.Take(108);
      expect(p.Decode1()).toBe(0x17);
      p.AssertEnd();
    }
    expect(snapshot(e)).toEqual(before);
    expect(opcodes(e)).toEqual([[], []]);
  }
});
test("last109 start preflight rejects invalid survivors BEFORE either local ready bit changes; recovery can retry the same generation", () => {
  const e = game([2, 1]);
  launch(e);
  discover(e, 0);
  discover(e, 1);
  ready(e, 1);
  e.clear();
  const color = e.room.m_rgSlotInfo[2]![2]!;
  e.room.m_rgSlotInfo[2]![2] = 31;
  const before = snapshot(e);
  expect(() => ready(e, 0)).toThrow("team color");
  expect(snapshot(e)).toEqual(before);
  expect(opcodes(e)).toEqual([[], []]);
  e.room.m_rgSlotInfo[2]![2] = color;
  ready(e, 0);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(opcodes(e)).toEqual([[150], [150]]);
});
test("last discovery start preflight rejects invalid survivors BEFORE peer flags/hosts or120 change", () => {
  const e = game([1, 1]);
  launch(e);
  ready(e, 0);
  ready(e, 1);
  discover(e, 0);
  e.clear();
  const color = e.room.m_rgSlotInfo[0]![2]!;
  e.room.m_rgSlotInfo[0]![2] = 31;
  const before = snapshot(e),
    hosts = e.room.GetUDPPeerHosts(1);
  expect(() => DiscoverLaunchPeer(e.room, e.clients[1]!)).toThrow("team color");
  expect(snapshot(e)).toEqual(before);
  expect(e.room.HasUDPPeerInfo(1)).toBe(false);
  expect(e.room.GetUDPPeerHosts(1)).toEqual(hosts);
  expect(opcodes(e)).toEqual([[], []]);
  e.room.m_rgSlotInfo[0]![2] = color;
  discover(e, 1);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(opcodes(e)).toEqual([
    [120, 150],
    [120, 150],
  ]);
});
test("loading timeout preflights every possible start survivor before any removal/history/pool mutation or frame-delta consumption", () => {
  const e = game([1, 2]);
  launch(e);
  discover(e, 0);
  ready(e, 0);
  e.clear();
  const color = e.room.m_rgSlotInfo[0]![2]!;
  e.room.m_rgSlotInfo[0]![2] = 31;
  const before = snapshot(e),
    last = e.room.GetLastUpdateTime();
  e.time(25101);
  e.table.UpdateGameSessions();
  expect(snapshot(e)).toEqual(before);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.room.GetLastUpdateTime()).toBe(last);
  expect(opcodes(e)).toEqual([[], []]);
  expect(e.clients[1]!.GetBeforeJoinSessions()).toEqual([]);
  expect(e.table.GetUpdateFailures().map((f) => f.Code)).toEqual([
    "protocol-error",
  ]);
  e.room.m_rgSlotInfo[0]![2] = color;
  e.table.UpdateGameSessions();
  expect(e.room.GetCurPlayer()).toBe(1);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.table.GetUpdateFailures()).toEqual([]);
});
test("deployment with discovery UDP disabled cannot publish successful launch; health reports that boundary explicitly", async () => {
  const e = game([1, 1]),
    app = new CServerApp(TestConfig()),
    sessions = app.m_gameServers[0]!.m_gameSessionTable,
    [a, b] = e.clients;
  try {
    e.table.DestroyPlayer(b!);
    e.table.DestroyPlayer(a!);
    e.clear();
    sessions.OnPacket(
      Received(
        new CSendPacket(80)
          .EncodeStr("No UDP")
          .EncodeStr("")
          .Encode1(0)
          .Encode1(1)
          .Encode1(0),
      ),
      a!,
    );
    const room = sessions.GetSession(a!)!;
    sessions.DoJoinSession(b!, room.m_nIdx, room.m_ulSerialNo, "", [0]);
    room.OnPacket(Received(new CSendPacket(96).Encode1(1)), b!);
    room.m_nMapIdx = 200;
    e.clear();
    expect(() => sessions.OnPacket(Received(new CSendPacket(106)), a!)).toThrow(
      CUnsupportedOperation,
    );
    expect(room.m_bPlaying).toBe(false);
    expect(room.m_dynInfoCalculator.IsInitialized()).toBe(false);
    expect(room.GetResultRoundID()).toBeUndefined();
    expect(opcodes(e)).toEqual([[], []]);
    expect(app.GetStatus().gameUpdate[0]!.launchEnabled).toBe(false);
    expect(app.GetStatus().gameUpdate[0]!.loadingRooms).toBe(0);
    expect(app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(app.GetStatus().officialClientVerified).toBe(false);
  } finally {
    await app.CleanUp();
  }
});

test("trusted partial-peer edge: loading passes the first UNPEERED secondary to table's post-removal IsSetFree guard, not always primary", () => {
  const e = game([1, 2]),
    room = e.room,
    dropped = e.clients[1]!,
    secondary = dropped.m_aUser[1]!;
  launch(e);
  // Explicit unusual native-state fixture; ordinary network discovery commits
  // BOTH locals atomically, so this is not a client-reachability claim.
  room.HasUDPPeerInfo = (slot) => slot !== secondary.m_nSlotIdx;
  ready(e, 0);
  e.clear();
  const eject = e.table.EjectPlayerForUDP;
  let observed = false;
  e.table.EjectPlayerForUDP = function (r, peer, notice) {
    expect(notice).toBe(secondary);
    observed = true;
    eject.call(this, r, peer, notice);
  };
  const survivor = e.clients[0]!,
    send = survivor.SendPacket;
  survivor.SendPacket = function (packet) {
    if (packet.m_nPacketType === 106) secondary.SetFree();
    send.call(this, packet);
  };
  e.time(25101);
  e.table.UpdateGameSessions();
  survivor.SendPacket = send;
  expect(observed).toBe(true);
  expect(room.GetCurPlayer()).toBe(1);
  expect(room.m_nGameState).toBe(GameStage.Running);
  expect(dropped.m_aUser[0]!.IsSetFree()).toBe(0);
  expect(secondary.IsSetFree()).toBe(1);
  expect(dropped.packets).toEqual([]);
  expect(dropped.m_nPoolType).toBe("Lobby");
  expect(e.table.GetUpdateFailures()).toEqual([]);
  expect(receipts(e)).toBe(0);
});
