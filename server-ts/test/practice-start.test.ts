/** Native 00421205 -> vtbl+200; normal 004209B9 is empty, practice
 * 004259AC -> vtbl+148 -> 004259B4 -> DoStartGame / packet150. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { CServerConfig } from "../src/core/ServerConfig.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CIDFMan } from "../src/FXGS/IDFMan.ts";
import { CBomberAttr } from "../src/FXGS/BomberAttr.ts";
import { CItemAttr } from "../src/FXGS/ItemAttr.ts";
import { CGameMapTmpl } from "../src/FXGS/GameMapTmpl.ts";
import { CGameMapTmplList } from "../src/FXGS/GameMapTmplList.ts";
import { CMainSystem } from "../src/FXGS/MainSystem.ts";
import { CGameSession } from "../src/FXGS/GameSession.ts";
import { CGameSessionTable } from "../src/FXGS/GameSessionTable.ts";
import { CClientSocket } from "../src/FXGS/ClientSocket.ts";
import { CUser } from "../src/FXGS/User.ts";

let restore: () => void;
let packets: Buffer[], map: CGameMapTmpl, table: CGameSessionTable;
beforeEach(() => {
  const saved = [CIDFMan.ms_pInstance, CBomberAttr.ms_pInstance, CItemAttr.ms_pInstance,
    CGameMapTmplList.ms_pInstance, CMainSystem.ms_pInstance, CGameSessionTable.ms_pInstance, CGameSession.ms_ulSerialNo] as const;
  restore = () => {
    [CIDFMan.ms_pInstance, CBomberAttr.ms_pInstance, CItemAttr.ms_pInstance,
      CGameMapTmplList.ms_pInstance, CMainSystem.ms_pInstance, CGameSessionTable.ms_pInstance, CGameSession.ms_ulSerialNo] = saved;
  };
  new CMainSystem(new CServerConfig([])).m_WorkerRandom.srand(1);
  new CIDFMan(join(import.meta.dir, "..", "data", "FxServer"));
  new CBomberAttr().Load(); new CItemAttr().Load();
  const maps = new CGameMapTmplList(); map = new CGameMapTmpl();
  Object.assign(map, { m_nIdx: 0, m_fPracticeMap: 1, m_nGhostStart: 10, m_nGhostFreq: 3, m_fReBirthMap: 1 });
  maps.m_apGameMapTmpl = [map]; maps.m_nMapCount = 1;
  table = new CGameSessionTable(); packets = [];
});
afterEach(() => restore());
function send(p: CSendPacket) {
  packets.push(Buffer.from(p.m_pBlock.subarray(0, p.m_uOffset))); return enSocket.kioOk;
}
function request(hex: string) {
  const n = new CReceivedPacket(), bytes = Buffer.from(hex, "hex");
  n.SetCipherDegree(2); n.SetRcvPacket(bytes, bytes.length); return n;
}
function seat(session: CGameSession, count = 1, first = 0) {
  const socket = Object.create(CClientSocket.prototype) as CClientSocket;
  socket.m_apUser = []; socket.m_nUserCount = count; socket.m_bConnected = true; socket.SendPacket = send;
  for (let i = 0; i < count; i++) {
    const user = new CUser(socket); user.SetName(`human${first + i}`); user.m_nLevel = 1;
    socket.m_apUser.push(user); session.AddUser(first + i, user, 0, first);
  }
  session.m_setSocket.add(socket); return socket;
}
function practice(count = 1) {
  const session = table.m_apPracticeSession[0]!; session.Init(); session.m_nMapIdx = 0;
  const socket = seat(session, count); session.m_nChiefSlotidx = 0; session.InitComputerPlayer(socket);
  return { session, socket };
}
const ids = () => packets.map(p => p[0]! ^ 0x5a);
const kickoff = () => packets.find(p => (p[0]! ^ 0x5a) === 150)!;
const e1 = (p: Buffer, off: number) => p[off]! ^ 0x5a;
const e2 = (p: Buffer, off: number) => p.readUInt16BE(off) ^ 0xa569;
const e4 = (p: Buffer, off: number) => (p.readUInt32BE(off) ^ 0x96ca5395) >>> 0;

test("packet 86 reduces each bomber selection modulo native total plus its random sentinel", () => {
  const socket = Object.create(CClientSocket.prototype) as CClientSocket;
  socket.m_apUser = [new CUser(socket)]; socket.m_nUserCount = 1;
  const wire = new CSendPacket(86);
  wire.Encode1(1);
  wire.Encode1(0xff);
  const received = new CReceivedPacket();
  // CSendPacket defaults to cipher 2, so the handler must decrypt before Decode1.
  received.SetCipherDegree(2);
  received.SetRcvPacket(wire.m_pBlock.subarray(0, wire.m_uOffset), wire.m_uOffset);
  expect(received.Decode1()).toBe(86); // channel dispatch consumes the id
  let decoded: number[] = [];
  const create = spyOn(table, "DoCreatePracticeSession").mockImplementation((_socket, selects) => { decoded = selects; });
  try {
    table.CreateSessionPractice(received, socket);
    expect(decoded).toEqual([0xff % (CBomberAttr.ms_pInstance!.GetTotalCount() + 1)]);
  } finally { create.mockRestore(); }
});

test("practice random/theme map selection uses native practice, max-team and ticket arguments", () => {
  const { session } = practice();
  const pick = spyOn(CGameMapTmplList.ms_pInstance!, "GetRandomMapIdx").mockReturnValue(7);
  try {
    session.m_nMapIdx = -1;
    session.SetMapIdxPlayingByLevel(9, 99, 1);
    expect(pick).toHaveBeenLastCalledWith(2, 9, -1, 1, 2, 0);
    expect(session.m_nGameMapIdx).toBe(7);
    session.m_nMapIdx = -3;
    session.SetMapIdxPlayingByLevel(11, 0, 0);
    expect(pick).toHaveBeenLastCalledWith(2, 11, 1, 1, 2, 0);
    expect(session.m_nGameMapIdx).toBe(7);
    session.m_nMapIdx = 4;
    session.SetMapIdxPlayingByLevel(13, 0, 0);
    expect(pick).toHaveBeenCalledTimes(2);
    expect(session.m_nGameMapIdx).toBe(4);
  } finally {
    pick.mockRestore();
  }
});

for (const count of [1, 2]) for (const staleAge of [25001, 259878, 0xfffffff0]) {
  test(`practice ${count}P + AI starts without 109/UDP and bypasses a ${staleAge}ms-stale launch sweep`, () => {
    const { session, socket } = practice(count);
    session.OnPacket(request("30"), socket); // literal encrypted client106
    expect(ids()).toEqual([115, 116, 173, 150]);
    expect(packets[0]).toEqual(Buffer.from([0x29, 0x5a])); // 115 / success
    expect(session.m_nGamePhase).toBe(1); expect(session.m_fPlaying).toBe(1);
    expect(session.m_nGameType100).toBe(0); // practice overrides map's rebirth flag AFTER DoStartGame
    expect([session.m_nGhostStart, session.m_nGhostFreq]).toEqual([10000, 3000]);
    expect(kickoff()).toHaveLength(17);
    expect(e4(kickoff(), 1)).toBe(session.m_GameClock.m_dwStartTime);
    expect([e4(kickoff(), 9), e4(kickoff(), 13)]).toEqual([10, 3]);
    expect(session.m_nCurPlayerNum).toBe(count * 2);
    expect([...session.m_rgUdpAlive]).toEqual(Array(8).fill(0));
    expect([...session.m_rgJoinTime]).toEqual(Array(8).fill(0)); // native practice AddUser does not set these

    // Make every human's join stamp old enough that the phase-0 sweep would
    // immediately emit 195. Phase 1 must take the normal in-play update path.
    const tick = performance.now() >>> 0;
    session.m_rgJoinTime.fill((tick - staleAge) >>> 0);
    session.Update();
    expect(session.m_nGamePhase).toBe(1);
    expect(session.m_nCurPlayerNum).toBe(count * 2); expect(socket.m_nPoolType).toBe(6);
    expect(ids()).not.toContain(195);
  });
}
test("late/repeated practice109 and repeated106 do not launch twice or change the game serial", () => {
  const { session, socket } = practice(); session.OnPacket(request("30"), socket);
  const serial = session.m_nGameSerial, started = session.m_GameClock.m_dwStartTime;
  // User-reported exact packet109 body (including its opaque trailing bytes).
  session.OnPacket(request("379440f5905f5b5b5f6935ac6a"), socket);
  session.OnPacket(request("379440f5905f5b5b5f6935ac6a"), socket);
  session.OnPacket(request("30"), socket);
  expect(ids()).toEqual([115, 116, 173, 150]);
  expect(session.m_nGameSerial).toBe(serial); expect(session.m_GameClock.m_dwStartTime).toBe(started);
});
test("failed practice validation never reaches the launch extension", () => {
  const { session, socket } = practice(); session.DestroyComputerPlayer(socket);
  session.OnPacket(request("30"), socket);
  expect(ids()).toEqual([115]); expect(packets[0]![1]! ^ 0x5a).toBe(3);
  expect([session.m_fPlaying, session.m_nGamePhase]).toEqual([0, 0]);
});

test("practice CanStartGame logs and dumps a non-standby chief but does not reject it", () => {
  const { session } = practice();
  session.m_nGameMapIdx = 0;
  session.m_rgSlotState[0] = 4; // chief socket's human is marked ready, not standby
  const report = spyOn(console, "error").mockImplementation(() => {});
  const dump = spyOn(session, "DumpLog").mockImplementation(() => {});
  try {
    expect(session.CanStartGame(1)).toBe(0);
    expect(report).toHaveBeenCalledWith("[GS] Chief Player is not stand-by, but [1].");
    expect(dump).toHaveBeenCalledTimes(1);
  } finally { report.mockRestore(); dump.mockRestore(); }
});

test("ordinary CanStartGame has the same diagnostic-only chief branch", () => {
  map.m_fPracticeMap = 0;
  const session = table.m_apGameSession[0]!; session.Init("normal", "", 0); session.m_nGameMapIdx = 0;
  seat(session, 1, 0); seat(session, 1, 1); session.m_nChiefSlotidx = 0;
  session.m_rgSlotState[0] = 4;
  session.m_rgSlotState[3] = 4;
  const report = spyOn(console, "error").mockImplementation(() => {});
  const dump = spyOn(session, "DumpLog").mockImplementation(() => {});
  try {
    expect(session.CanStartGame(1)).toBe(0);
    expect(report).toHaveBeenCalledWith("[GS] Chief Player is not stand-by, but [1].");
    expect(dump).toHaveBeenCalledTimes(1);
  } finally { report.mockRestore(); dump.mockRestore(); }
});

test("practice event4 -> event6 -> 163 reports the human kill and returns through 164", () => {
  const { session, socket } = practice();
  const human = socket.GetUser(0)!;
  session.OnPacket(request("30"), socket); // 106: 115 -> 116 -> 173 -> 150

  // 146 event 4: AI slot 1 dies, human slot 0 is the killer, zero drops.
  session.OnPacket(request("c81ba569a5695a5a"), socket);
  expect(session.m_DynInfoCalculator.GetKillCount(0)).toBe(1);
  expect(session.m_abDeleted[1]).toBe(1);
  // 146 event 6: human slot 0 reports the finish.  The exclude relay has no
  // recipient in one-socket practice; Update performs the native end defer.
  session.OnPacket(request("c83aa569a569"), socket);
  session.Update();

  expect(ids()).toEqual([115, 116, 173, 150, 159, 163]);
  expect([session.m_nGamePhase, session.m_fPlaying]).toEqual([2, 1]);
  const result = packets.at(-1)!;
  expect(result).toHaveLength(35);
  // EXE head: flag, winner, constant 0, ladder, different-team item flag.
  expect(Array.from({ length: 5 }, (_, i) => e1(result, 1 + i))).toEqual([0, 0, 0, 0, 0]);

  // Human row: marker, serial, win, kill=1, save=0, unchanged exp/look.
  expect(e1(result, 6)).toBe(1);
  expect(e4(result, 7)).toBe(human.GetGlobalSerialNo());
  expect([e1(result, 11), e1(result, 12), e1(result, 13)]).toEqual([0, 1, 0]);
  expect([e2(result, 14), e2(result, 16), e2(result, 18), e1(result, 20), e1(result, 21)])
    .toEqual([0, 0, human.GetLookLevel(), 0, 0]);

  // AI row: marker 2, loss, its own calculator counts and native AI level.
  expect([e1(result, 22), e1(result, 23), e1(result, 24), e1(result, 25), e2(result, 26)])
    .toEqual([2, 2, 0, 0, session.m_anAILevel[1]]);
  expect(Array.from({ length: 7 }, (_, i) => e1(result, 28 + i))).toEqual(Array(7).fill(0));

  // Native return delay emits practice code 3, clears only round state, and
  // keeps the human/AI roster ready for a later 106.
  session.m_GameClock.m_dwEndTime = ((performance.now() >>> 0) - 8001) >>> 0;
  session.Update();
  expect(ids().at(-1)).toBe(164); expect(e1(packets.at(-1)!, 1)).toBe(3);
  expect([session.m_nGamePhase, session.m_fPlaying, session.m_nGameMapIdx]).toEqual([0, 0, -1]);
  expect([session.IsValidSlot(0), session.IsValidSlot(1), session.m_nCurPlayerNum]).toEqual([true, true, 2]);
  expect([...session.m_aBomberIdx]).toEqual(Array(8).fill(-1));

  // Practice vtbl+224 is an empty override: an idle Update must not run the
  // normal room's chief-ban state machine after the 164 transition.
  Object.assign(session.m_BanChief, { m_nCanStart: 123, m_dwCanStartTime: 456 });
  session.Update();
  expect([session.m_BanChief.m_nCanStart, session.m_BanChief.m_dwCanStartTime]).toEqual([123, 456]);
  const beforeRelaunch = packets.length;
  session.OnPacket(request("30"), socket);
  expect(ids().slice(beforeRelaunch)).toEqual([115, 116, 173, 150]);
  expect([session.m_nGamePhase, session.m_fPlaying]).toEqual([1, 1]);
});

test("practice serializes an AI killer's and saver's counts in the AI result row", () => {
  const { session, socket } = practice(); session.OnPacket(request("30"), socket);
  session.OnPacket(request("c87ba569a569"), socket); // event 2: AI slot 1 is trapped
  session.OnPacket(request("c86ba569a5695b"), socket); // event 3: AI slot 1 is saved by AI slot 1
  session.OnPacket(request("c81aa569a5695b5a"), socket); // event 4: human slot 0, killer AI slot 1
  session.OnPacket(request("c83ba569a569"), socket); // event 6: AI slot 1 finishes
  expect([session.m_DynInfoCalculator.GetKillCount(1), session.m_DynInfoCalculator.GetSaveCount(1)]).toEqual([1, 1]);
  session.Update();
  const result = packets.at(-1)!;
  expect(ids().at(-1)).toBe(163);
  expect(e1(result, 2)).toBe(7); // winning colour (byte 2; the inserted zero is byte 3)
  expect([e1(result, 11), e1(result, 12), e1(result, 13)]).toEqual([2, 0, 0]);
  expect([e1(result, 22), e1(result, 23), e1(result, 24), e1(result, 25)])
    .toEqual([2, 0, 1, 1]);
});

test("ordinary room still needs BOTH TCP109 and UDP readiness", () => {
  map.m_fPracticeMap = 0;
  const session = table.m_apGameSession[0]!; session.Init("normal", "", 0); session.m_nMapIdx = 0;
  const chief = seat(session), member = seat(session, 1, 1); session.m_nChiefSlotidx = 0;
  session.m_rgSlotState[3] = 4; // member ready
  // Capture broadcasts once, instead of twice for two sockets.
  session.SendPacket = send;
  session.OnPacket(request("30"), chief);
  expect(ids()).toEqual([115, 116, 173]); expect(session.m_nGamePhase).toBe(0);
  for (const socket of [chief, member]) session.OnPacket(request("379440f5905f5b5b5f6935ac6a"), socket);
  expect(ids()).toEqual([115, 116, 173]); expect(session.m_nGamePhase).toBe(0);
  session.OnUDPPeerInfo(chief.GetUser(0)!, { ip: 0x7f000001, port: 9000 }, [0, 0], [0, 0]);
  expect(session.m_nGamePhase).toBe(0);
  session.OnUDPPeerInfo(member.GetUser(0)!, { ip: 0x7f000001, port: 9001 }, [0, 0], [0, 0]);
  expect(session.m_nGamePhase).toBe(1); expect(ids().filter(id => id === 150)).toHaveLength(1);
  expect(session.m_nGameType100).toBe(1); // no practice override for ordinary rooms
});
