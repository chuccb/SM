/** Client-visible consumers of the FXGS worker's CRT stream. Each fixture
 * seeds explicitly; no probabilistic assertions or dependence on wall time. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { CRand } from "../src/core/CRand.ts";
import { CServerConfig } from "../src/core/ServerConfig.ts";
import { CReceivedPacket, CSendPacket } from "../src/core/Packet.ts";
import { CIDFMan } from "../src/FXGS/IDFMan.ts";
import { CBomberAttr } from "../src/FXGS/BomberAttr.ts";
import { CItemAttr } from "../src/FXGS/ItemAttr.ts";
import { CGameMapTmpl } from "../src/FXGS/GameMapTmpl.ts";
import { CGameMapTmplList } from "../src/FXGS/GameMapTmplList.ts";
import { CMainSystem } from "../src/FXGS/MainSystem.ts";
import { CGameSession } from "../src/FXGS/GameSession.ts";
import { CGameSessionTable } from "../src/FXGS/GameSessionTable.ts";
import { CPracticeSession } from "../src/FXGS/PracticeSession.ts";
import { CUdpLossRegulator } from "../src/FXGS/UdpLossRegulator.ts";
import { CClientSocket } from "../src/FXGS/ClientSocket.ts";
import { CUser } from "../src/FXGS/User.ts";
import { GS_ClientSend } from "../src/protocol/PacketIDs.ts";

let saved: {
  idf: CIDFMan | null; bomber: CBomberAttr | null; item: CItemAttr | null;
  maps: CGameMapTmplList | null; main: CMainSystem | null;
  table: CGameSessionTable | null; serial: number;
};
let main: CMainSystem;
let maps: CGameMapTmplList;
let bomber: CBomberAttr;
let item: CItemAttr;

beforeEach(() => {
  saved = {
    idf: CIDFMan.ms_pInstance, bomber: CBomberAttr.ms_pInstance, item: CItemAttr.ms_pInstance,
    maps: CGameMapTmplList.ms_pInstance, main: CMainSystem.ms_pInstance,
    table: CGameSessionTable.ms_pInstance, serial: CGameSession.ms_ulSerialNo,
  };
  main = new CMainSystem(new CServerConfig([]));
  main.m_WorkerRandom.srand(1);
  new CIDFMan(join(import.meta.dir, "..", "..", "FXGS", "FxServer"));
  bomber = new CBomberAttr();
  bomber.Load();
  item = new CItemAttr();
  item.Load();
  maps = new CGameMapTmplList();
  maps.m_apGameMapTmpl = [0, 1, 2].map((idx) => {
    const map = new CGameMapTmpl();
    map.m_nIdx = idx;
    return map;
  });
  maps.m_nMapCount = 3;
});
afterEach(() => {
  CIDFMan.ms_pInstance = saved.idf;
  CBomberAttr.ms_pInstance = saved.bomber;
  CItemAttr.ms_pInstance = saved.item;
  CGameMapTmplList.ms_pInstance = saved.maps;
  CMainSystem.ms_pInstance = saved.main;
  CGameSessionTable.ms_pInstance = saved.table;
  CGameSession.ms_ulSerialNo = saved.serial;
});

function decode(packet: CSendPacket): CReceivedPacket {
  const n = new CReceivedPacket();
  n.SetRcvPacket(packet.m_pBlock, packet.m_uOffset);
  n.SetCipherDegree(packet.m_nCipherDegree);
  n.m_nPacketType = n.Decode1();
  return n;
}
function capture(session = new CGameSession()) {
  const packets: CReceivedPacket[] = [];
  session.SendPacket = (p) => { packets.push(decode(p)); };
  session.m_nGameMapIdx = 0;
  return { session, packets };
}
function player(session: CGameSession, slot: number, select: number, color = slot) {
  const socket = Object.create(CClientSocket.prototype) as CClientSocket;
  const user = new CUser(socket);
  socket.m_apUser = [user];
  socket.m_nUserCount = 1;
  user.SetName(`player${slot}`);
  session.AddUser(slot, user, select, color);
  return { user, socket };
}
function launchBody(packets: CReceivedPacket[]) {
  const packet = packets.find((p) => p.m_nPacketType === GS_ClientSend.OnStartGame)!;
  expect(packet).toBeDefined();
  packet.Decode4(); // nondeterministic uptime stamp, NOT part of CRT state
  const map = packet.Decode2();
  const count = packet.Decode1();
  const players = Array.from({ length: count }, () => ({
    slot: packet.Decode1(), captain: packet.Decode1(), spawn: packet.Decode1(),
    bomber: packet.Decode1(), color: packet.Decode1(),
  }));
  expect(packet.m_uOffset).toBe(packet.m_uLength);
  return { map, players };
}
function eatRequest(slot: number, box: number, idx: number): CReceivedPacket {
  const n = new CReceivedPacket();
  n.SetRcvPacket(Uint8Array.from([slot, box, idx]), 3);
  return n;
}

describe("FXGS logical-worker ownership", () => {
  test("seed is epoch seconds, not milliseconds or uptime; new systems have independent streams", () => {
    const now = spyOn(Date, "now").mockReturnValue(1789881234567);
    try {
      const a = new CMainSystem(new CServerConfig([]));
      const b = new CMainSystem(new CServerConfig([]));
      const expected = new CRand(1789881234);
      const first = expected.rand();
      expect(a.m_WorkerRandom.rand()).toBe(first);
      expect(a.m_WorkerRandom.rand()).toBe(expected.rand());
      expect(b.m_WorkerRandom.rand()).toBe(first);
    } finally { now.mockRestore(); }
  });

  test("ordinary and practice Init share the persistent worker stream, not per-room seeds", () => {
    const regular = new CGameSession();
    const practice = new CPracticeSession();
    regular.Init("room", "", 0);
    practice.Init();
    regular.Init("again", "", 0);
    expect(practice.m_nGameVersion).toBe(18467);
    expect(regular.m_nGameVersion).toBe(6334);
    expect(main.m_WorkerRandom.rand()).toBe(26500);
  });

  test("normal-timer loss diagnostics do not consume the worker's stream", () => {
    new CUdpLossRegulator().RegulateConnection(new CGameSession());
    expect(main.m_WorkerRandom.rand()).toBe(41);
  });
});

describe("GetRandomMapIdx draw count and modulo", () => {
  test("uses rand % candidates in load order, not a scaled float", () => {
    const values = Array.from({ length: 5 }, () => maps.GetRandomMapIdx(2, 0, -1, 0, 0, 0));
    expect(values).toEqual([2, 2, 1, 1, 2]); // 41,18467,6334,26500,19169 modulo 3
    expect(main.m_WorkerRandom.rand()).toBe(15724);
  });

  test("one eligible map still consumes a draw; zero eligible maps or invalid players consume none", () => {
    maps.m_apGameMapTmpl[0]!.m_nLevelLimit = 20;
    maps.m_apGameMapTmpl[2]!.m_nLevelLimit = 20;
    expect(maps.GetRandomMapIdx(2, 0, -1, 0, 0, 0)).toBe(1);
    expect(main.m_WorkerRandom.rand()).toBe(18467);
    expect(maps.GetRandomMapIdx(2, -1, -1, 0, 0, 0)).toBe(-1);
    expect(maps.GetRandomMapIdx(0, 100, -1, 0, 0, 0)).toBe(-1);
    expect(maps.GetRandomMapIdx(9, 100, -1, 0, 0, 0)).toBe(-1);
    expect(main.m_WorkerRandom.rand()).toBe(6334);
  });
});

describe("Init → random map → launch 116 → kickoff 150", () => {
  test("fixed native sequence determines gameVersion, map, spawn order and random bombers together", () => {
    const { session, packets } = capture();
    session.Init("rng", "", 0); // draw 1: gameVersion 41
    player(session, 0, bomber.GetRandomBomberIdx(), 0);
    player(session, 2, 3, 3); // explicit choice consumes no rand
    player(session, 5, bomber.GetRandomBomberIdx(), 5);
    session.SetMapIdxPlayingByLevel(0, 0, 0); // draw 2: 18467 % 3 == 2
    session.LaunchGameStage(); // draws 3..9 shuffle; 10..13 random bomber pairs
    expect(session.m_nGameVersion).toBe(41);
    expect(launchBody(packets)).toEqual({ map: 2, players: [
      { slot: 0, captain: 0, spawn: 6, bomber: 1, color: 0 },
      { slot: 2, captain: 0, spawn: 3, bomber: 3, color: 3 },
      { slot: 5, captain: 0, spawn: 7, bomber: 1, color: 5 },
    ] });
    expect(Array.from(session.m_aBomberIdx)).toEqual([1, -1, 3, -1, -1, 1, -1, -1]);
    expect([0, 2, 5].map((slot) => session.m_DynInfoCalculator.GetMyTeamNo(slot))).toEqual([1, 1, 1]);
    expect([0, 2, 5].map((slot) => session.m_DynInfoCalculator.GetOtherTeamNo(slot))).toEqual([2, 2, 2]);

    // Keep the actual DoStartGame/ClearModifiedFlag implementations; only
    // the unused 510 preallocated room objects are omitted from this fixture.
    const table = Object.create(CGameSessionTable.prototype) as CGameSessionTable;
    table.m_acTableFlags = new Uint8Array(255);
    CGameSessionTable.ms_pInstance = table;
    const serial = session.m_nGameSerial;
    session.DoStartGame();
    const kickoff = packets.find((p) => p.m_nPacketType === GS_ClientSend.OnStartGame2)!;
    kickoff.Decode4();
    expect(kickoff.Decode4()).toBe((serial ^ 41) >>> 0);
    expect(session.m_nGameSerial).toBe((serial + 1) >>> 0);
    expect(main.m_WorkerRandom.rand()).toBe(16827); // no hidden extra draws in kickoff
  });

  test.each([[9, 9, 8047], [29, 8, 16158]])("seed %i takes the hidden-bomber branch and selects index %i", (seed, selected, next) => {
    main.m_WorkerRandom.srand(seed);
    const { session, packets } = capture();
    player(session, 4, bomber.GetRandomBomberIdx());
    session.LaunchGameStage();
    const body = launchBody(packets);
    expect(body.players[0]!.bomber).toBe(selected);
    expect(session.m_aBomberIdx[4]).toBe(selected);
    expect(main.m_WorkerRandom.rand()).toBe(next);
  });

  test("explicit bomber plus a four-spawn map uses three shuffle draws, even for one player", () => {
    maps.m_apGameMapTmpl[0]!.m_nMaxPlayer = 4;
    const { session, packets } = capture();
    player(session, 3, 2);
    session.LaunchGameStage();
    expect(launchBody(packets)).toEqual({ map: 0, players: [
      { slot: 3, captain: 0, spawn: 0, bomber: 2, color: 3 },
    ] }); // seed 1 forward shuffle of four entries is [0,1,3,2]
    expect(main.m_WorkerRandom.rand()).toBe(26500);
  });

  test("launch builds the native inclusive own-team and opposing-team counts", () => {
    const { session } = capture();
    player(session, 0, 0, 0);
    player(session, 2, 1, 0);
    player(session, 5, 2, 3);
    session.LaunchGameStage();
    expect([0, 2, 5].map((slot) => session.m_DynInfoCalculator.GetMyTeamNo(slot)))
      .toEqual([2, 2, 1]);
    expect([0, 2, 5].map((slot) => session.m_DynInfoCalculator.GetOtherTeamNo(slot)))
      .toEqual([1, 1, 2]);
    expect(session.m_DynInfoCalculator.GetMyTeamNo(1)).toBe(0);
    expect(session.m_DynInfoCalculator.GetOtherTeamNo(1)).toBe(0);
  });

  test("practice AI seats get spawn positions in slot order but do not add a draw for explicit bombers", () => {
    const practice = new CPracticeSession();
    const { packets } = capture(practice);
    const { socket } = player(practice, 0, 0);
    practice.m_argpAISocket[3] = socket;
    practice.SetBomber(3, 5);
    practice.SetColor(3, 7);
    practice.m_nCurPlayerNum = 2;
    practice.LaunchGameStage();
    expect(launchBody(packets)).toEqual({ map: 0, players: [
      { slot: 0, captain: 0, spawn: 4, bomber: 0, color: 0 },
      { slot: 3, captain: 0, spawn: 1, bomber: 5, color: 7 },
    ] });
    expect([practice.m_DynInfoCalculator.GetMyTeamNo(0), practice.m_DynInfoCalculator.GetOtherTeamNo(0)])
      .toEqual([1, 1]);
    expect([practice.m_DynInfoCalculator.GetMyTeamNo(3), practice.m_DynInfoCalculator.GetOtherTeamNo(3)])
      .toEqual([1, 1]);
    expect(main.m_WorkerRandom.rand()).toBe(29358);
  });
});

describe("premium lucci item draws (OnRequestEatItem)", () => {
  test.each([[0, 1], [1, 2]])("seed %i produces multiplier %i in both packet 156 and money", (seed, multiplier) => {
    main.m_WorkerRandom.srand(seed);
    const { session, packets } = capture();
    const { user, socket } = player(session, 0, 0);
    user.m_fPremiumTicket = 1;
    const gem = item.m_vtEffect.findIndex((effect) => effect === 99);
    session.OnRequestEatItem(eatRequest(0, 0, gem), socket);
    const packet = packets[0]!;
    expect(packet.m_nPacketType).toBe(GS_ClientSend.OnRequestEatItemRes);
    expect([packet.Decode1(), packet.Decode1(), packet.Decode1(), packet.Decode1()]).toEqual([0, 0, gem, multiplier]);
    expect(packet.m_uOffset).toBe(packet.m_uLength);
    expect(user.dyn.money).toBe(multiplier * item.m_vtAmount[gem]!);
    session.OnRequestEatItem(eatRequest(0, 0, gem), socket); // same box: ignored, no second draw
    expect(packets).toHaveLength(1);
    expect(main.m_WorkerRandom.rand()).toBe(seed === 0 ? 7719 : 18467);
  });

  test.each([0, 2])("non-premium ticket byte %i gets one gem without consuming a draw", (ticket) => {
    const { session, packets } = capture();
    const { user, socket } = player(session, 0, 0);
    user.m_fPremiumTicket = ticket;
    const gem = item.m_vtEffect.findIndex((effect) => effect === 99);
    session.OnRequestEatItem(eatRequest(0, 0, gem), socket);
    expect(user.dyn.money).toBe(item.m_vtAmount[gem]!);
    expect(packets).toHaveLength(1);
    expect(main.m_WorkerRandom.rand()).toBe(41);
  });

  test("a non-lucci item consumes no draw even for a premium player", () => {
    const { session, packets } = capture();
    const { user, socket } = player(session, 0, 0);
    user.m_fPremiumTicket = 1;
    session.OnRequestEatItem(eatRequest(0, 0, 0), socket);
    expect(packets[0]!.m_uLength).toBe(4); // opcode + slot,box,item; no multiplier
    expect(user.dyn.money).toBe(0);
    expect(main.m_WorkerRandom.rand()).toBe(41);
  });
});
