/** A14: CxLogin's destroy-service room code uses its persistent CRT stream. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CRand } from "../src/core/CRand.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import type { CDBMan } from "../src/db/DBMan.ts";
import type { CCenterProcess } from "../src/LS/CenterProcess.ts";
import type { CClientSocket } from "../src/LS/ClientSocket.ts";
import { CLoginPool } from "../src/LS/LoginPool.ts";
import type { CMultiServer } from "../src/LS/MultiServer.ts";

let previousPool: CLoginPool | null;

beforeEach(() => {
  previousPool = CLoginPool.ms_pInstance;
});

afterEach(() => {
  CLoginPool.ms_pInstance = previousPool;
});

function body(headerType: number): CReceivedPacket {
  const packet = new CSendPacket(0);
  packet.Encode4(headerType);
  const bytes = packet.m_pBlock.slice(1, packet.m_uOffset);
  const received = new CReceivedPacket();
  received.SetRcvPacket(bytes, bytes.length);
  return received;
}

function decode(packet: CSendPacket): CReceivedPacket {
  const received = new CReceivedPacket();
  received.SetRcvPacket(packet.m_pBlock.slice(0, packet.m_uOffset), packet.m_uOffset);
  received.SetCipherDegree(packet.m_nCipherDegree);
  received.m_nPacketType = received.Decode1();
  return received;
}

test("valid requests consume exactly one CxLogin rand draw; rejected headers consume none", () => {
  const pool = new CLoginPool(
    {} as CCenterProcess,
    {} as CDBMan,
    {} as CMultiServer,
    new CRand(1),
  );
  const sent: CSendPacket[] = [];
  let roomCode = -1;
  let closes = 0;
  const socket = {
    m_nHeaderType: 0x1234,
    GetLocalSerialNo: () => 77,
    SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; },
    SetGameRoomCode: (code: number) => { roomCode = code; },
    Close: () => { closes++; },
  } as unknown as CClientSocket;

  pool.OnRequestDestoryService(body(0x9999), socket);
  for (let i = 0; i < 3; i++) pool.OnRequestDestoryService(body(0x1234), socket);

  expect(closes).toBe(1);
  expect(sent).toHaveLength(3);
  const replies = sent.map((packet) => {
    const response = decode(packet);
    expect(response.m_nPacketType).toBe(60);
    const fields = [response.Decode4(), response.Decode4()];
    expect(response.m_uOffset).toBe(response.m_uLength);
    return fields;
  });
  // CxLogin's first seed-1 draws are 41, 18467, 6334; native masks with 3.
  expect(replies).toEqual([[77, 1], [77, 3], [77, 2]]);
  expect(roomCode).toBe(2);
});

test("the production Login stream is seeded once in C time(nullptr) epoch seconds", () => {
  const now = spyOn(Date, "now").mockReturnValue(123_999);
  try {
    const pool = new CLoginPool({} as CCenterProcess, {} as CDBMan, {} as CMultiServer);
    const expected = new CRand(123).rand() & 3;
    let roomCode = -1;
    const socket = {
      m_nHeaderType: 5,
      GetLocalSerialNo: () => 1,
      SendPacket: () => enSocket.kioOk,
      SetGameRoomCode: (code: number) => { roomCode = code; },
      Close: () => undefined,
    } as unknown as CClientSocket;

    pool.OnRequestDestoryService(body(5), socket);
    expect(roomCode).toBe(expected);
  } finally {
    now.mockRestore();
  }
});
