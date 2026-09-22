/** CxLogin packet 7 and per-user teardown regressions. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Decrypt4, Encode4 } from "../src/core/BufferManipulator.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, enSocket } from "../src/core/Packet.ts";
import { CISmartStream, COSmartStream } from "../src/core/SmartStream.ts";
import type { CDBMan } from "../src/db/DBMan.ts";
import { CConfigDyn, CONFIG_DYN_NOTICE_UPDATE_TICKS } from "../src/LS/ConfigDyn.ts";
import {
  CCenterProcess,
  CClientSocket,
  CLoginPool,
} from "../src/LS/CxLogin.ts";
import type { CMultiServer } from "../src/LS/MultiServer.ts";
import { S2C_LoginNoticePacket, S2C_LoginResponsePacket } from "../src/core/protocol/PacketIDs.ts";

let priorPool: CLoginPool | null;
let priorCenter: CCenterProcess | null;
let priorConfigDyn: CConfigDyn | null;
let priorSockets: Map<number, CClientSocket>;
let priorLocalSerial: number;
let priorHeaderCounter: number;

beforeEach(() => {
  priorPool = CLoginPool.ms_pInstance;
  priorCenter = CCenterProcess.ms_pInstance;
  priorConfigDyn = CConfigDyn.ms_pInstance;
  priorSockets = CClientSocket.ms_tblSN2Obj;
  priorLocalSerial = CClientSocket.ms_nLocalSerialNo;
  priorHeaderCounter = CClientSocket.ms_nHeaderTypeCounter;
  CClientSocket.ms_tblSN2Obj = new Map();
});

afterEach(() => {
  CLoginPool.ms_pInstance = priorPool;
  CCenterProcess.ms_pInstance = priorCenter;
  CConfigDyn.ms_pInstance = priorConfigDyn;
  CClientSocket.ms_tblSN2Obj = priorSockets;
  CClientSocket.ms_nLocalSerialNo = priorLocalSerial;
  CClientSocket.ms_nHeaderTypeCounter = priorHeaderCounter;
});

function decodeNotice(packet: CSendPacket): string {
  expect(packet.m_nPacketType).toBe(S2C_LoginNoticePacket.OnNotice);
  expect(packet.m_nCipherDegree).toBe(CipherDegree.kPacketEncryptedCRC8);
  expect(packet.m_pBlock[0]! ^ 0x5a).toBe(S2C_LoginNoticePacket.OnNotice);
  const streamSize = Decrypt4(packet.m_pBlock, 1);
  expect(packet.m_uOffset).toBe(5 + streamSize);
  const stream = new CISmartStream();
  expect(stream.SetBuffer(packet.m_pBlock.subarray(5, 5 + streamSize))).toBe(streamSize);
  const notice = stream.DecodeStr();
  expect(stream.IsEOS()).toBe(true);
  return notice;
}

function centerAddResult(localSerial: number, globalSerial: number, authencode = 0): CReceivedPacket {
  // CCenterProcess already consumed CM id 0 before CLoginPool sees this body.
  const body = new Uint8Array(14);
  Encode4(body, 0, localSerial);
  Encode4(body, 4, 1); // fAllAdded
  body[8] = 1;
  Encode4(body, 9, globalSerial);
  body[13] = authencode;
  const packet = new CReceivedPacket();
  packet.SetRcvPacket(body, body.length);
  return packet;
}

function makePool(center: CCenterProcess): CLoginPool {
  return new CLoginPool(center, {} as CDBMan, {} as CMultiServer);
}

describe("CConfigDyn packet 7", () => {
  test("encodes exactly one type-2 notice value and hashes that smart stream", () => {
    const db = { GetNotice: () => ({ sn: 3, type: 2, value: "maintenance at 10" }) } as unknown as CDBMan;
    const config = new CConfigDyn(db);
    config.UpdateNotice();

    const expected = new COSmartStream();
    expected.EncodeStr("maintenance at 10");
    expect(config.GetNoticeHash()).toBe(expected.GetHashValue());
    expect(config.GetNotice()).toBe("maintenance at 10");
    expect(decodeNotice(config.GetNoticePacket())).toBe("maintenance at 10");
  });

  test("before the first DB row, the native default packet remains unsendable", () => {
    const config = new CConfigDyn({ GetNotice: () => null } as unknown as CDBMan);
    config.UpdateNotice();
    expect(config.GetNoticeHash()).toBe(0);
    expect(config.GetNotice()).toBe("");
    expect(config.GetNoticePacket().m_uOffset).toBe(0);
    expect(config.GetNoticePacket().GetOutgoingPacketLength()).toBe(0);
  });

  test("a missing row retains the prior atomic hash/packet cache", () => {
    let row: { sn: number; type: number; value: string } | null = { sn: 1, type: 2, value: "first" };
    const config = new CConfigDyn({ GetNotice: () => row } as unknown as CDBMan);
    config.UpdateNotice();
    const packet = config.GetNoticePacket();
    const hash = config.GetNoticeHash();
    row = null;
    config.UpdateNotice();
    expect(config.GetNoticePacket()).toBe(packet);
    expect(config.GetNoticeHash()).toBe(hash);
    expect(config.GetNotice()).toBe("first");
  });

  test("timer refreshes on tick zero and each 0x1194 ticks only", () => {
    let calls = 0;
    const config = new CConfigDyn({
      GetNotice: () => { calls++; return { sn: calls, type: 2, value: `n${calls}` }; },
    } as unknown as CDBMan);
    for (let tick = 0; tick <= CONFIG_DYN_NOTICE_UPDATE_TICKS; tick++) config.OnTimer();
    expect(calls).toBe(2);
    expect(config.GetNotice()).toBe("n2");
  });

  test("successful CM 0 sends login packet 3 then packet 7 only on hash mismatch", () => {
    const unregister = mock((_serial: number) => {});
    const center = { UnregisterConnection: unregister } as unknown as CCenterProcess;
    const pool = makePool(center);
    const config = new CConfigDyn({
      GetNotice: () => ({ sn: 1, type: 2, value: "server notice" }),
    } as unknown as CDBMan);
    config.UpdateNotice();

    const socket = new CClientSocket();
    socket.AddNewUsers(1);
    const user = socket.GetUser(0)!;
    user.strId = "alice";
    user.strEmail = "a@example.test";
    const sent: CSendPacket[] = [];
    socket.SendPacket = (packet) => { sent.push(packet); return enSocket.kioOk; };

    socket.m_nNoticeHash = 0;
    pool.OnCenterResAddNewUser(centerAddResult(socket.GetLocalSerialNo(), 0x11223344));
    expect(sent.map((packet) => packet.m_nPacketType)).toEqual([S2C_LoginResponsePacket.OnLoginRes, S2C_LoginNoticePacket.OnNotice]);
    expect(sent[1]).toBe(config.GetNoticePacket());

    sent.length = 0;
    socket.m_nNoticeHash = config.GetNoticeHash();
    pool.OnCenterResAddNewUser(centerAddResult(socket.GetLocalSerialNo(), 0x11223344));
    expect(sent.map((packet) => packet.m_nPacketType)).toEqual([S2C_LoginResponsePacket.OnLoginRes]);
    expect(unregister).not.toHaveBeenCalled();
  });
});

describe("CClientSocket login flood gate", () => {
  test("constructor timestamps make the first through ninth rapid attempts pass and the tenth fail", () => {
    const socket = new CClientSocket();
    expect(Array.from({ length: 9 }, () => socket.CheckLoginFlush())).toEqual(Array(9).fill(true));
    expect(socket.CheckLoginFlush()).toBe(false);
    expect(socket.m_nLoginCount).toBe(10);
    expect(socket.m_nFlushCount).toBe(10);
  });
});

describe("CClientSocket per-user cleanup", () => {
  test("unregisters each user's global serial, never the notice hash", () => {
    const unregister = mock((_serial: number) => {});
    const center = { UnregisterConnection: unregister } as unknown as CCenterProcess;
    CCenterProcess.ms_pInstance = center;
    const pool = makePool(center);
    const socket = new CClientSocket();
    const localSerial = socket.GetLocalSerialNo();
    socket.AddNewUsers(2);
    socket.m_nNoticeHash = 0xfeedbeef;
    const first = socket.GetUser(0)!;
    const second = socket.GetUser(1)!;
    first.strId = "first"; first.SetGlobalSerialNo(101);
    second.strId = "second"; second.SetGlobalSerialNo(202);
    pool.m_localUserTable.Insert(first);
    pool.m_localUserTable.Insert(second);
    pool.AddSocket(socket);
    socket.m_bConnected = true;

    socket.Close();

    expect(unregister.mock.calls.map(([serial]) => serial)).toEqual([101, 202]);
    expect(unregister.mock.calls.flat()).not.toContain(0xfeedbeef);
    expect(pool.m_localUserTable.FindUserFromGlobalSerialNo(101)).toBeNull();
    expect(pool.m_localUserTable.FindUserFromGlobalSerialNo(202)).toBeNull();
    expect(pool.m_setUser.size).toBe(0);
    expect(pool.m_setSocket.has(socket)).toBe(false);
    expect(CClientSocket.ms_tblSN2Obj.has(localSerial)).toBe(false);
  });
});
