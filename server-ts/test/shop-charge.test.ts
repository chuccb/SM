/** A05 charge-key generation, client 206, and web verification. Native
 * evidence: FxShop 004200E8, 0041EE90, 00415520, and 004158E0. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { RAND_MAX } from "../src/core/CRand.ts";
import { CipherDegree, CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import type { CDBMan } from "../src/db/DBMan.ts";
import { CClientSocket } from "../src/FXSS/ClientSocket.ts";
import { CLocalUserTable } from "../src/FXSS/LocalUserTable.ts";
import { CMainPool } from "../src/FXSS/MainPool.ts";
import { CMainSystem } from "../src/FXSS/MainSystem.ts";
import { CUser } from "../src/FXSS/User.ts";
import { CWebSocket } from "../src/FXSS/WebSocket.ts";

let previousMain: CMainSystem | null;
let previousPool: CMainPool | null;
let previousUsers: CLocalUserTable | null;
let logs: ReturnType<typeof spyOn<typeof console, "log">>;

beforeEach(() => {
  previousMain = CMainSystem.ms_pInstance;
  previousPool = CMainPool.ms_pInstance;
  previousUsers = CLocalUserTable.ms_pInstance;
  logs = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logs.mockRestore();
  CMainSystem.ms_pInstance = previousMain;
  CMainPool.ms_pInstance = previousPool;
  CLocalUserTable.ms_pInstance = previousUsers;
});

function body(write: (packet: CSendPacket) => void): CReceivedPacket {
  const packet = new CSendPacket(0);
  write(packet);
  const received = new CReceivedPacket();
  const bytes = packet.m_pBlock.slice(1, packet.m_uOffset);
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

test("constructor and SetChargeKey consume the persistent FxShop CRT worker stream", () => {
  const main = new CMainSystem();
  main.m_WorkerRandom.srand(1);

  const user = new CUser(null);
  expect(user.m_nChargeKey).toBe(42); // first CRT draw is 41
  user.SetChargeKey();
  expect(user.m_nChargeKey).toBe(18_468); // second draw is 18467
  expect(user.m_nChargeKey).toBeGreaterThanOrEqual(1);
  expect(user.m_nChargeKey).toBeLessThanOrEqual(RAND_MAX + 1);
});

test("client 214 receives FX attr, global serial, and charge key—not either cash field", () => {
  const main = new CMainSystem();
  main.m_nFXAttr = 7;
  const pool = new CMainPool({} as CDBMan);
  const user = new CUser(null);
  user.SetGlobalSerialNo(0x12345678);
  user.m_nChargeKey = 32_001;
  user.m_nCash = 9_000;
  user.m_nBillingCash = 8_000;

  let sent: CSendPacket | null = null;
  const socket = {
    m_nSelectedUserIdx: 0,
    GetUser: () => user,
    SendPacket: (packet: CSendPacket) => { sent = packet; return enSocket.kioOk; },
  } as unknown as CClientSocket;
  pool.OnRequestCharge(body(() => {}), socket);

  expect(sent).not.toBeNull();
  const reply = decode(sent!);
  expect(reply.m_nPacketType).toBe(206);
  expect([reply.Decode1(), reply.Decode4(), reply.Decode4()]).toEqual([7, 0x12345678, 32_001]);
  expect(reply.m_uOffset).toBe(reply.m_uLength);
  expect(user.m_fRemainCashRequested).toBe(1);
});

test("CWebSocket dispatches every complete packet instead of a one-shot verified gate", () => {
  const pool = new CMainPool({} as CDBMan);
  const verify = spyOn(pool, "OnVerifyKey").mockImplementation(() => {});
  const web = new CWebSocket();
  try {
    const packet = body(packet => { packet.Encode4(1); packet.Encode4(2); });
    web.hooks.onPacket(web, packet);
    web.hooks.onPacket(web, packet);
    expect(verify).toHaveBeenCalledTimes(2);
  } finally {
    verify.mockRestore();
    web.m_bConnected = true;
    web.Close();
  }
});

test("web verification is reusable, little-endian, and gated only by user+20", () => {
  new CMainSystem();
  const pool = new CMainPool({} as CDBMan);
  const users = new CLocalUserTable();
  const user = new CUser(null);
  user.SetName("charge");
  user.SetGlobalSerialNo(123);
  user.m_nChargeKey = 321;
  expect(users.Insert(user)).toBe(1);

  const results: number[] = [];
  const web = {
    SendBuffer: (buffer: ArrayBuffer | Uint8Array) => {
      const bytes = buffer instanceof Uint8Array
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer);
      results.push(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true));
      return enSocket.kioOk;
    },
  } as CWebSocket;
  // Web accept does not raise the cipher. OnVerifyKey starts at the serial, with no type byte.
  const verify = (serial: number, key: number) => {
    const packet = new CSendPacket(undefined, CipherDegree.kPacketRaw);
    packet.Encode4(serial);
    packet.Encode4(key);
    const received = new CReceivedPacket();
    received.SetCipherDegree(CipherDegree.kPacketRaw);
    received.SetRcvPacket(packet.m_pBlock.subarray(0, packet.m_uOffset), packet.m_uOffset);
    pool.OnVerifyKey(received, web);
  };

  verify(123, 321);
  verify(123, 321);
  verify(123, 999);
  user.m_fTranxInProgress = 1;
  verify(123, 321);
  verify(999, 321);
  expect(results).toEqual([1, 1, -3, -4, -4]);
});
