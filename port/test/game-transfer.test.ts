/** Regression for the reported GS -> Shop reply. Native FxServer 004036E6
 * pushes opcode 6; constructor 00411DDE selects cipher degree 2, not id 2.
 * Assert literal protocol bytes rather than deriving the oracle from PacketIDs.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CChannelPool } from "../src/FXGS/ChannelPool.ts";
import { CClientSocket } from "../src/FXGS/ClientSocket.ts";
import { CLocalUserTable } from "../src/FXGS/LocalUserTable.ts";
import { CCenterProcess } from "../src/FXGS/CenterProcess.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CServerConfig } from "../src/core/ServerConfig.ts";
import type { CDBMan } from "../src/db/DBMan.ts";
import {
  CMainPool as CShopMainPool, CClientSocket as CShopClientSocket,
  CCenterProcess as CShopCenterProcess, CLocalUserTable as CShopLocalUserTable,
} from "../src/FXSS/FxShop.ts";

let previousTable: CLocalUserTable | null;
let previousCenter: CCenterProcess | null;
let table: CLocalUserTable;
let shopTable: CShopLocalUserTable;
let previousShopTable: CShopLocalUserTable | null;
let previousShopCenter: CShopCenterProcess | null;
const shopSockets: CShopClientSocket[] = [];
const shopPool = Object.create(CShopMainPool.prototype) as CShopMainPool;
const sockets: CClientSocket[] = [];
const restorers: (() => void)[] = [];
// These handlers do not use the pool's DB/premium-reward constructor state.
const pool = Object.create(CChannelPool.prototype) as CChannelPool;

beforeEach(() => {
  previousTable = CLocalUserTable.ms_pInstance;
  previousCenter = CCenterProcess.ms_pInstance;
  table = new CLocalUserTable();
  previousShopTable = CShopLocalUserTable.ms_pInstance;
  previousShopCenter = CShopCenterProcess.ms_pInstance;
  shopTable = new CShopLocalUserTable();
});
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const s of sockets.splice(0)) CClientSocket.ms_tblSN2Obj.delete(s.m_nLocalSerialNo);
  CLocalUserTable.ms_pInstance = previousTable;
  CCenterProcess.ms_pInstance = previousCenter;
  for (const s of shopSockets.splice(0)) CShopClientSocket.ms_tblSN2Obj.delete(s.m_nLocalSerialNo);
  CShopLocalUserTable.ms_pInstance = previousShopTable;
  CShopCenterProcess.ms_pInstance = previousShopCenter;
});

function client(serials = [123]) {
  const socket = new CClientSocket(); sockets.push(socket);
  socket.AddNewUsers(serials.length);
  socket.m_nPoolType = 1;
  for (const [i, serial] of serials.entries()) {
    const user = socket.GetUser(i)!;
    user.SetName(`player${serial}`); user.SetGlobalSerialNo(serial);
    expect(table.Insert(user)).toBe(1);
  }
  const sent: CSendPacket[] = [];
  const send = spyOn(socket, "SendPacket").mockImplementation(p => { sent.push(p); return enSocket.kioOk; });
  restorers.push(() => send.mockRestore());
  return { socket, sent };
}
function body(p: CSendPacket): CReceivedPacket {
  const n = new CReceivedPacket(); n.SetCipherDegree(p.m_nCipherDegree);
  n.SetRcvPacket(p.m_pBlock.subarray(0, p.m_uOffset), p.m_uOffset);
  n.Decode1(); // dispatch consumes the packet id
  return n;
}
function response(serials: number[], result: number, type = 11): CReceivedPacket {
  const p = new CSendPacket(1); p.Encode1(serials.length);
  for (const sn of serials) p.Encode4(sn);
  p.Encode1(result);
  if (result === 1) { p.Encode1(type); p.Encode4(0); p.Encode4(0x7f000001); p.Encode2(9801); }
  return body(p);
}

for (const type of [10, 11]) {
  test(`Center success to class ${type} is client packet 6, never packet 2`, () => {
    const { sent } = client();
    pool.OnCenterResConnectToSvr(response([123], 1, type));
    expect(sent).toHaveLength(1);
    const p = sent[0]!;
    expect(p.m_nPacketType).toBe(6); expect(p.m_nCipherDegree).toBe(2);
    const n = body(p);
    expect([n.Decode1(), n.Decode1(), n.Decode4(), n.Decode4(), n.Decode2()])
      .toEqual([1, type, 0, 0x7f000001, 9801]);
    expect(n.m_uOffset).toBe(n.m_uLength);
    if (type === 11) expect(Buffer.from(p.m_pBlock.subarray(0, p.m_uOffset)).toString("hex"))
      .toBe("5c5b5196ca5395e9ca53948320"); // user's log, corrected opcode only
  });
}
for (const result of [0, 2]) {
  test(`Center result ${result} uses the same packet 6 without an address tail`, () => {
    const { sent } = client(); pool.OnCenterResConnectToSvr(response([123], result));
    expect(sent).toHaveLength(1); expect(sent[0]!.m_nPacketType).toBe(6);
    expect(sent[0]!.m_uOffset).toBe(2); expect(body(sent[0]!).Decode1()).toBe(result);
  });
}

test("both serials resolve; native sends once to the last resolved user's socket", () => {
  const first = client([123]), second = client([456]);
  pool.OnCenterResConnectToSvr(response([123, 456], 1));
  expect(first.sent).toHaveLength(0); expect(second.sent).toHaveLength(1);
  expect(second.sent[0]!.m_nPacketType).toBe(6);
});
test("two users sharing a socket receive one reply, not two", () => {
  const { sent } = client([123, 456]);
  pool.OnCenterResConnectToSvr(response([123, 456], 1));
  expect(sent).toHaveLength(1); expect(sent[0]!.m_nPacketType).toBe(6);
});
for (const serials of [[999, 123], [123, 999], []]) {
  test(`missing/empty serial group ${JSON.stringify(serials)} sends nothing`, () => {
    const { sent } = client(); const n = response(serials, 1);
    pool.OnCenterResConnectToSvr(n);
    expect(sent).toHaveLength(0);
    // Abort at the missing serial, without consuming the result or later users.
    expect(n.m_uOffset).toBe(serials.length === 0 ? 2 : 2 + 4 * (serials.indexOf(999) + 1));
  });
}

test("the user's exact Shop request is forwarded without a version word or front-stage check", () => {
  const { socket, sent } = client();
  const center = new CCenterProcess({} as CDBMan, new CServerConfig([]));
  const forwarded: CSendPacket[] = [];
  const send = spyOn(center, "SendPacket").mockImplementation(p => { forwarded.push(p); });
  const check = spyOn(center, "CheckEnterGame");
  restorers.push(() => { send.mockRestore(); check.mockRestore(); });
  const n = new CReceivedPacket(); n.SetCipherDegree(2);
  n.SetRcvPacket(Buffer.from("5c5196ca5395", "hex"), 6);
  expect(n.Decode1()).toBe(6); pool.OnReqConnectToSvr(n, socket);
  expect(check).not.toHaveBeenCalled(); expect(sent).toHaveLength(0);
  expect(forwarded).toHaveLength(1);
  const p = forwarded[0]!; expect(p.m_nPacketType).toBe(2); // Center request, not client response
  const payload = body(p);
  expect([payload.Decode1(), payload.Decode4(), payload.Decode1(), payload.Decode4()]).toEqual([1, 123, 11, 0]);
  expect(payload.m_uOffset).toBe(payload.m_uLength);
});

test("local CheckEnterGame refusal also uses client packet 6", () => {
  const { socket, sent } = client(); socket.m_nPoolType = 3;
  const center = new CCenterProcess({} as CDBMan, new CServerConfig([]));
  const check = spyOn(center, "CheckEnterGame").mockReturnValue(4);
  const send = spyOn(center, "SendPacket");
  restorers.push(() => { check.mockRestore(); send.mockRestore(); });
  const p = new CSendPacket(6, 2); p.Encode1(10); p.Encode4(0); p.Encode2(7);
  pool.OnReqConnectToSvr(body(p), socket);
  expect(check).toHaveBeenCalledWith(10, 0, 7); expect(send).not.toHaveBeenCalled();
  expect(sent).toHaveLength(1); expect(sent[0]!.m_nPacketType).toBe(6);
  expect(body(sent[0]!).Decode1()).toBe(4);
});

function shopClient(serials = [123]) {
  const socket = new CShopClientSocket(); shopSockets.push(socket);
  socket.AddNewUsers(serials.length);
  for (const [i, serial] of serials.entries()) {
    const user = socket.GetUser(i)!;
    user.SetName(`player${serial}`); user.SetGlobalSerialNo(serial);
    expect(shopTable.Insert(user)).toBe(1);
  }
  const sent: CSendPacket[] = [];
  const send = spyOn(socket, "SendPacket").mockImplementation(p => { sent.push(p); return enSocket.kioOk; });
  restorers.push(() => send.mockRestore());
  return { socket, sent };
}
for (const serials of [[], [123], [123, 456]]) {
  test(`Shop return request uses E1 type + E4 index, forwards all ${serials.length} users without a selection gate`, () => {
    const { socket } = shopClient(serials); socket.m_nSelectedUserIdx = 99;
    const center = new CShopCenterProcess({} as CDBMan);
    const forwarded: CSendPacket[] = [];
    const send = spyOn(center, "SendPacket").mockImplementation(p => { forwarded.push(p); });
    restorers.push(() => send.mockRestore());
    const n = new CReceivedPacket(); n.SetCipherDegree(2);
    n.SetRcvPacket(Buffer.from("5c5096ca5395", "hex"), 6);
    expect(n.Decode1()).toBe(6); shopPool.OnReqConnectToSvr(n, socket);
    expect(n.m_uOffset).toBe(n.m_uLength);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.m_nPacketType).toBe(2);
    const payload = body(forwarded[0]!);
    expect(payload.Decode1()).toBe(serials.length);
    for (const serial of serials) expect(payload.Decode4()).toBe(serial);
    expect([payload.Decode1(), payload.Decode4()]).toEqual([10, 0]);
    expect(payload.m_uOffset).toBe(payload.m_uLength);
  });
}
for (const result of [0, 1, 2]) {
  test(`Shop Center result ${result} resolves ALL users then replies once to the LAST socket`, () => {
    const first = shopClient([123]), last = shopClient([456]);
    shopPool.OnCenterResConnectToSvr(response([123, 456], result, 10));
    expect(first.sent).toHaveLength(0); expect(last.sent).toHaveLength(1);
    const p = last.sent[0]!;
    expect(p.m_nPacketType).toBe(6); expect(p.m_nCipherDegree).toBe(2);
    const n = body(p); expect(n.Decode1()).toBe(result);
    if (result === 1) expect([n.Decode1(), n.Decode4(), n.Decode4(), n.Decode2()])
      .toEqual([10, 0, 0x7f000001, 9801]);
    expect(n.m_uOffset).toBe(n.m_uLength);
  });
}
for (const serials of [[999, 123], [123, 999], []]) {
  test(`Shop drops response for missing/empty serial group ${JSON.stringify(serials)}`, () => {
    const { sent } = shopClient(); const n = response(serials, 1, 10);
    shopPool.OnCenterResConnectToSvr(n);
    expect(sent).toHaveLength(0);
    expect(n.m_uOffset).toBe(serials.length === 0 ? 2 : 2 + 4 * (serials.indexOf(999) + 1));
  });
}
for (const busy of [0, 1]) {
  test(`Shop refuses transfer if user ${busy} has a billing transaction in progress`, () => {
    const { socket, sent } = shopClient([123, 456]);
    socket.GetUser(busy)!.m_fTranxInProgress = 1;
    const n = response([123, 456], 1, 10); shopPool.OnCenterResConnectToSvr(n);
    expect(sent).toHaveLength(0); expect(n.m_uOffset).toBe(2 + 4 * (busy + 1));
  });
}
test("Shop replies once for two idle users sharing a socket", () => {
  const { sent } = shopClient([123, 456]);
  shopPool.OnCenterResConnectToSvr(response([123, 456], 1, 10));
  expect(sent).toHaveLength(1); expect(sent[0]!.m_nPacketType).toBe(6);
});
