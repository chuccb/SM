/** CGameSession::DeferBanChief / packet 121 native timing regression. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CServerConfig } from "../src/core/ServerConfig.ts";
import { CSendPacket, enSocket } from "../src/core/Packet.ts";
import { UserInventory } from "../src/FXGS/Recordsets.ts";
import { CBanChief } from "../src/FXGS/BanChief.ts";
import { CGameClock } from "../src/FXGS/GameSession.ts";
import { CGameSession } from "../src/FXGS/GameSession.ts";
import { CGameSessionTable } from "../src/FXGS/GameSessionTable.ts";
import { CMainSystem } from "../src/FXGS/MainSystem.ts";
import { CClientSocket } from "../src/FXGS/ClientSocket.ts";
import { CUser } from "../src/FXGS/User.ts";
import { FunctionalItem, ItemCategory } from "../src/common/Item.ts";

let now: number;
let session: CGameSession;
let socket: CClientSocket;
let user: CUser;
let canStartResult: number;
let broadcastPackets: Buffer[];
let directPackets: Buffer[];
let destroyedSockets: CClientSocket[];
let restoreClock: () => void;
let restoreGlobals: () => void;

function wire(packet: CSendPacket): Buffer {
  return Buffer.from(packet.m_pBlock.subarray(0, packet.m_uOffset));
}

function decodeNeedStartGame(packet: Buffer): { id: number; stage: number; seconds: number } {
  expect(packet.length).toBe(4);
  return {
    id: packet[0]! ^ 0x5a,
    stage: packet[1]! ^ 0x5a,
    seconds: packet.readUInt16BE(2) ^ 0xa569,
  };
}

function at(start: number, elapsed: number): void {
  now = (start + elapsed) >>> 0;
}

function equipSuperChief(): void {
  const item = new UserInventory();
  item.Type = ItemCategory.Functional;
  item.strAttr = FunctionalItem.SuperChief;
  user.AddInventory(item);
}

beforeEach(() => {
  const savedMain = CMainSystem.ms_pInstance;
  const savedTable = CGameSessionTable.ms_pInstance;
  const savedSerial = CGameSession.ms_ulSerialNo;
  restoreGlobals = () => {
    CMainSystem.ms_pInstance = savedMain;
    CGameSessionTable.ms_pInstance = savedTable;
    CGameSession.ms_ulSerialNo = savedSerial;
  };

  new CMainSystem(new CServerConfig([]));
  now = 0;
  const clock = spyOn(CGameClock, "Now").mockImplementation(() => now >>> 0);
  restoreClock = () => clock.mockRestore();

  broadcastPackets = [];
  directPackets = [];
  destroyedSockets = [];
  canStartResult = 0;

  session = new CGameSession();
  session.fValid = 1;
  session.m_fPlaying = 0;
  session.m_nGameType = 0;
  session.m_nChiefSlotidx = 0;
  session.m_nMaxPlayerNum = 2;
  session.m_nCurPlayerNum = 2;
  session.CanStartGame = () => canStartResult;
  session.SendPacket = (packet: CSendPacket): void => {
    broadcastPackets.push(wire(packet));
  };

  socket = Object.create(CClientSocket.prototype) as CClientSocket;
  socket.m_apUser = [];
  socket.m_nUserCount = 1;
  socket.m_nPoolType = 2;
  socket.m_nSessionIdx = 0;
  socket.m_nSessionSerialNo = 1;
  socket.m_anBeforeJoinSession = [];
  socket.m_pendingPackets = [];
  socket.m_bConnected = true;
  socket.SendPacket = (packet: CSendPacket) => {
    directPackets.push(wire(packet));
    return enSocket.kioOk;
  };

  user = new CUser(socket);
  user.m_nSlotIdx = 0;
  socket.m_apUser = [user];
  session.m_rgPlayer[0] = user;
  session.m_setSocket.add(socket);

  const table = Object.create(CGameSessionTable.prototype) as CGameSessionTable;
  table.DestroyPlayer = (target: CClientSocket, _fSendReset: number): void => {
    destroyedSockets.push(target);
    // The real CGameSession::DestroyPlayer resets this in-place when the
    // departing socket owns the chief, and CBaseSession::DestroyPlayer puts
    // the socket back on stage 1 before DeferBanChief explicitly parks it at 4.
    session.m_BanChief.Init();
    target.m_nPoolType = 1;
  };
  table.ClearModifiedFlag = (_idx: number): void => {};
  CGameSessionTable.ms_pInstance = table;
});

afterEach(() => {
  restoreClock();
  restoreGlobals();
});

test("CBanChief helpers use the native 1/3 multiplier and unsigned DWORD elapsed time", () => {
  const gate = new CBanChief();
  expect([gate.GetWarningDelay(1), gate.GetWarningDelay(3)]).toEqual([10_000, 30_000]);
  expect([gate.GetOddSlotInManner(1), gate.GetOddSlotInManner(3)]).toEqual([5_000, 15_000]);

  gate.m_dwCanStartTime = 0xffff_fff0;
  at(0xffff_fff0, 10_000);
  expect(gate.IsBanChief(1, 0, 1)).toBeFalse(); // native comparison is strictly greater
  at(0xffff_fff0, 10_001);
  expect(gate.IsBanChief(1, 0, 1)).toBeTrue();

  gate.m_dwCanStartTime = 0;
  now = 0x8000_0001;
  expect(gate.IsBanChief(1, 0, 1)).toBeTrue(); // would be negative under signed i32 arithmetic
});

test("ordinary full-room warning and removal send packet 121 stages 0/2 with 10 seconds", () => {
  // The supplied live packet decodes to the bad value that prompted this
  // regression.  The corrected stage-0 packet below must be 23 5a a5 63.
  expect(decodeNeedStartGame(Buffer.from("235a61dd", "hex"))).toEqual({ id: 121, stage: 0, seconds: 50_356 });

  const start = 0xffff_f000;
  now = start;
  session.m_BanChief.SetCanStart(1);

  at(start, 10_000);
  session.DeferBanChief();
  expect(broadcastPackets).toHaveLength(0);

  at(start, 10_001);
  session.DeferBanChief();
  expect(broadcastPackets.map(decodeNeedStartGame)).toEqual([{ id: 121, stage: 0, seconds: 10 }]);
  expect(broadcastPackets[0]!.toString("hex")).toBe("235aa563");

  const warnedAt = now;
  at(warnedAt, 10_000);
  session.DeferBanChief();
  expect(directPackets).toHaveLength(0);

  at(warnedAt, 10_001);
  session.DeferBanChief();
  expect(directPackets.map(decodeNeedStartGame)).toEqual([{ id: 121, stage: 2, seconds: 10 }]);
  expect(directPackets[0]!.toString("hex")).toBe("2358a563");
  expect(destroyedSockets).toEqual([socket]);
  expect(socket.m_nPoolType).toBe(4);
});

test("a non-full room uses the native 20-second pre-warning gate", () => {
  session.m_nCurPlayerNum = 1;
  const start = 1_000;
  now = start;
  session.m_BanChief.SetCanStart(1);

  at(start, 10_001);
  session.DeferBanChief();
  expect(broadcastPackets).toHaveLength(0);

  at(start, 20_000);
  session.DeferBanChief();
  expect(broadcastPackets).toHaveLength(0);

  at(start, 20_001);
  session.DeferBanChief();
  expect(broadcastPackets.map(decodeNeedStartGame)).toEqual([{ id: 121, stage: 0, seconds: 10 }]);
});

test("SuperChief stretches ordinary stages 0/2 to 30 seconds", () => {
  equipSuperChief();
  const start = 25_000;
  now = start;
  session.m_BanChief.SetCanStart(1);

  at(start, 30_000);
  session.DeferBanChief();
  expect(broadcastPackets).toHaveLength(0);

  at(start, 30_001);
  session.DeferBanChief();
  expect(broadcastPackets.map(decodeNeedStartGame)).toEqual([{ id: 121, stage: 0, seconds: 30 }]);
  expect(broadcastPackets[0]!.toString("hex")).toBe("235aa577");

  const warnedAt = now;
  at(warnedAt, 30_000);
  session.DeferBanChief();
  expect(directPackets).toHaveLength(0);

  at(warnedAt, 30_001);
  session.DeferBanChief();
  expect(directPackets.map(decodeNeedStartGame)).toEqual([{ id: 121, stage: 2, seconds: 30 }]);
  expect(directPackets[0]!.toString("hex")).toBe("2358a577");
  expect(destroyedSockets).toEqual([socket]);
  expect(socket.m_nPoolType).toBe(4);
});

test("odd-slot sub-gate follows the native plain/event capacity rules", () => {
  canStartResult = 1;

  session.m_nGameType = 1;
  session.m_nMaxPlayerNum = 3;
  session.DeferBanChief();
  expect(session.m_BanChief.m_nOddSlot).toBe(1);

  session.m_nMaxPlayerNum = 4;
  session.DeferBanChief();
  expect(session.m_BanChief.m_nOddSlot).toBe(0);

  session.m_nGameType = 0;
  session.m_nMaxPlayerNum = 1;
  session.DeferBanChief();
  expect(session.m_BanChief.m_nOddSlot).toBe(1);

  session.m_nMaxPlayerNum = 2;
  session.DeferBanChief();
  expect(session.m_BanChief.m_nOddSlot).toBe(0);
});

test("ordinary odd-slot grace sends stages 1/3 and resets OddSlot after removal", () => {
  session.m_nMaxPlayerNum = 1;
  session.m_nCurPlayerNum = 1;
  canStartResult = 1; // keep the independent ordinary gate out of this timing test
  const start = 0xffff_f800;
  now = start;

  session.DeferBanChief(); // SetOddSlot(1)
  expect(session.m_BanChief.m_nOddSlot).toBe(1);

  at(start, 5_000);
  session.DeferBanChief();
  expect(broadcastPackets).toHaveLength(0);

  at(start, 5_001);
  session.DeferBanChief();
  expect(broadcastPackets.map(decodeNeedStartGame)).toEqual([{ id: 121, stage: 1, seconds: 10 }]);
  expect(broadcastPackets[0]!.toString("hex")).toBe("235ba563");

  const warnedAt = now;
  at(warnedAt, 10_000);
  session.DeferBanChief();
  expect(directPackets).toHaveLength(0);

  const setOddSlot = spyOn(session.m_BanChief, "SetOddSlot");
  const setCanStart = spyOn(session.m_BanChief, "SetCanStart");
  try {
    at(warnedAt, 10_001);
    session.DeferBanChief();
    expect(directPackets.map(decodeNeedStartGame)).toEqual([{ id: 121, stage: 3, seconds: 10 }]);
    expect(directPackets[0]!.toString("hex")).toBe("2359a563");
    // Fake DestroyPlayer above contributes Init's OddSlot(0), CanStart(0);
    // DeferBanChief must then call OddSlot(0), not CanStart(0), itself.
    expect(setOddSlot.mock.calls).toEqual([[0], [0]]);
    expect(setCanStart.mock.calls).toEqual([[0]]);
    expect(session.m_BanChief.m_nOddSlot).toBe(0);
    expect(destroyedSockets).toEqual([socket]);
    expect(socket.m_nPoolType).toBe(4);
  } finally {
    setOddSlot.mockRestore();
    setCanStart.mockRestore();
  }
});

test("SuperChief stretches odd-slot grace and stages 1/3 to 15/30 seconds", () => {
  equipSuperChief();
  session.m_nMaxPlayerNum = 1;
  session.m_nCurPlayerNum = 1;
  canStartResult = 1;
  const start = 50_000;
  now = start;

  session.DeferBanChief();
  at(start, 15_000);
  session.DeferBanChief();
  expect(broadcastPackets).toHaveLength(0);

  at(start, 15_001);
  session.DeferBanChief();
  expect(broadcastPackets.map(decodeNeedStartGame)).toEqual([{ id: 121, stage: 1, seconds: 30 }]);
  expect(broadcastPackets[0]!.toString("hex")).toBe("235ba577");

  const warnedAt = now;
  at(warnedAt, 30_000);
  session.DeferBanChief();
  expect(directPackets).toHaveLength(0);

  at(warnedAt, 30_001);
  session.DeferBanChief();
  expect(directPackets.map(decodeNeedStartGame)).toEqual([{ id: 121, stage: 3, seconds: 30 }]);
  expect(directPackets[0]!.toString("hex")).toBe("2359a577");
  expect(destroyedSockets).toEqual([socket]);
  expect(socket.m_nPoolType).toBe(4);
});

test("DoStartGame resets the native CBanChief block in place", () => {
  const gate = session.m_BanChief;
  Object.assign(gate, {
    m_nCanStart: 1,
    m_nOddSlot: 1,
    m_nWarnedBan: 1,
    m_nWarnedBanOddSlot: 1,
    m_dwCanStartTime: 2,
    m_dwOddSlotTime: 3,
    m_dwWarnedBanTime: 4,
    m_dwWarnedBanOddSlotTime: 5,
  });
  session.m_nGameMapIdx = -1;
  now = 0x0bad_f00d;

  session.DoStartGame();

  expect(session.m_BanChief).toBe(gate);
  expect([
    gate.m_nCanStart,
    gate.m_nOddSlot,
    gate.m_nWarnedBan,
    gate.m_nWarnedBanOddSlot,
    gate.m_dwCanStartTime,
    gate.m_dwOddSlotTime,
    gate.m_dwWarnedBanTime,
    gate.m_dwWarnedBanOddSlotTime,
  ]).toEqual([0, 0, 0, 0, now, 0, 0, 0]);
});

test("room initialization and chief departure reset the native CBanChief block in place", () => {
  const gate = session.m_BanChief;
  Object.assign(gate, {
    m_nCanStart: 1,
    m_nOddSlot: 1,
    m_nWarnedBan: 1,
    m_nWarnedBanOddSlot: 1,
  });

  now = 0x1234_5678;
  session.Init("room", "", 0);
  expect(session.m_BanChief).toBe(gate);
  expect({
    canStart: gate.m_nCanStart,
    oddSlot: gate.m_nOddSlot,
    warned: gate.m_nWarnedBan,
    warnedOdd: gate.m_nWarnedBanOddSlot,
    canStartTime: gate.m_dwCanStartTime,
  }).toEqual({ canStart: 0, oddSlot: 0, warned: 0, warnedOdd: 0, canStartTime: now });

  session.m_rgPlayer[0] = user;
  session.m_nChiefSlotidx = 0;
  session.m_nCurPlayerNum = 1;
  session.m_nMaxPlayerNum = 2;
  session.m_setSocket.add(socket);
  user.m_nSlotIdx = 0;
  socket.m_nPoolType = 2;
  gate.SetCanStart(1);

  now = 0x1234_6000;
  expect(session.DestroyPlayer(socket, 0)).toBe(1);
  expect(session.m_BanChief).toBe(gate);
  expect(gate.m_nCanStart).toBe(0);
  expect(gate.m_nOddSlot).toBe(0);
  expect(gate.m_dwCanStartTime).toBe(now);
});
