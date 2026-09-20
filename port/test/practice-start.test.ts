/** Native 00421205 -> vtbl+200; normal 004209B9 is empty, practice
 * 004259AC -> vtbl+148 -> 004259B4 -> DoStartGame / packet150. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { CServerConfig } from "../src/core/Config.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CIDFMan } from "../src/FXGS/CData.ts";
import { CBomberAttr, CItemAttr } from "../src/FXGS/GameData.ts";
import { CGameMapTmpl, CGameMapTmplList } from "../src/FXGS/GameMap.ts";
import { CMainSystem } from "../src/FXGS/System.ts";
import { CGameSession } from "../src/FXGS/Session.ts";
import { CPracticeSession } from "../src/FXGS/Practice.ts";
import { CGameSessionTable } from "../src/FXGS/SessionTable.ts";
import { CClientSocket, CUser } from "../src/FXGS/User.ts";

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
  new CIDFMan(join(import.meta.dir, "..", "..", "FXGS", "FxServer"));
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
const e4 = (p: Buffer, off: number) => (p.readUInt32BE(off) ^ 0x96ca5395) >>> 0;

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
