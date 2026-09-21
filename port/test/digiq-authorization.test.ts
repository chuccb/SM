/** Native FxShop 00416B80 -> 00401DF0 -> 004044C0 -> 00402690 -> 004039F0.
 * Literal IDs/result codes are independent of the production PacketIDs table.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CBillingProcess, CClientSocket, CLocalUserTable, CMainPool } from "../src/FXSS/FxShop.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CSendPacket as BillingPacket } from "../src/FXSS/Packet.ts";
import type { CDBMan } from "../src/db/DBMan.ts";

let previousBilling: CBillingProcess | null;
let previousTable: CLocalUserTable | null;
let billing: CBillingProcess;
let table: CLocalUserTable;
const sockets: CClientSocket[] = [];
const restore: (() => void)[] = [];
const pool = Object.create(CMainPool.prototype) as CMainPool;

beforeEach(() => {
  previousBilling = CBillingProcess.ms_pInstance;
  previousTable = CLocalUserTable.ms_pInstance;
  billing = new CBillingProcess({} as CDBMan);
  table = new CLocalUserTable();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  restore.push(() => warning.mockRestore());
});
afterEach(() => {
  for (const fn of restore.splice(0)) fn();
  for (const socket of sockets.splice(0)) CClientSocket.ms_tblSN2Obj.delete(socket.m_nLocalSerialNo);
  CBillingProcess.ms_pInstance = previousBilling;
  CLocalUserTable.ms_pInstance = previousTable;
});
function client(name = "tester", serial = 123) {
  const socket = new CClientSocket();
  sockets.push(socket);
  socket.AddNewUsers(1);
  socket.m_strPeerAddress = "127.0.0.1";
  const user = socket.GetUser(0)!;
  user.SetName(name); user.SetGlobalSerialNo(serial);
  user.m_nSID = 100; user.m_nBID = 200;
  expect(table.Insert(user)).toBe(1);
  const sent: CSendPacket[] = [];
  const send = spyOn(socket, "SendPacket").mockImplementation(p => { sent.push(p); return enSocket.kioOk; });
  restore.push(() => send.mockRestore());
  return { socket, user, sent };
}
function received(p: CSendPacket): CReceivedPacket {
  const n = new CReceivedPacket();
  n.SetCipherDegree(p.m_nCipherDegree);
  n.SetRcvPacket(p.m_pBlock.subarray(0, p.m_uOffset), p.m_uOffset);
  return n;
}
function string8(p: CSendPacket, value: string) {
  p.Encode1(value.length); p.EncodeBuffer(Buffer.from(value, "latin1"));
}
function auth(result = 0, name = "tester", message = "denied") {
  const p = new BillingPacket(342);
  p.Encode4(0x11223344); p.Encode4(0xaabbccdd);
  string8(p, name); p.Encode4(result);
  if (result !== 0) string8(p, message);
  return received(p);
}
function balance(result = 0, serial = 123, cash = 500, message = "unavailable") {
  const p = new BillingPacket(302);
  p.Encode4(100); string8(p, "tester"); p.Encode4(serial); p.Encode4(cash); p.Encode4(result);
  if (result === 1) string8(p, message);
  return received(p);
}
function observeBilling(onSend: () => void = () => {}) {
  const sent: CSendPacket[] = [];
  const send = spyOn(billing, "Send").mockImplementation(p => { onSend(); sent.push(p); });
  restore.push(() => send.mockRestore());
  return sent;
}
function assertReply(p: CSendPacket, id: number) {
  expect(p.m_nCipherDegree).toBe(2);
  const n = received(p); expect(n.Decode1()).toBe(id);
  return n;
}

test("redacted 21-byte 224 fixture becomes billing 341 with the selected user's name, no immediate client reply", () => {
  const { socket, sent } = client();
  const forwarded = observeBilling();
  const n = new CReceivedPacket(); n.SetCipherDegree(2);
  n.SetRcvPacket(Buffer.from("baa5617465737475736572a5617465737470617373", "hex"), 21);
  expect(n.Decode1()).toBe(224);
  pool.OnReqDigiQAuthorization(n, socket);
  expect(sent).toHaveLength(0); expect(forwarded).toHaveLength(1);
  const p = forwarded[0]!;
  expect(Buffer.from(p.m_pBlock.subarray(0, p.m_uOffset)).toString("hex"))
    .toBe("0000015508746573747573657208746573747061737306746573746572");
});
for (const missing of [false, true]) {
  test(`224 checks user+20/selection before decoding strings; missing=${missing}`, () => {
    const { socket, user, sent } = client();
    if (missing) socket.m_nSelectedUserIdx = 1;
    else user.m_fTranxInProgress = 1;
    const forwarded = observeBilling();
    const p = new CSendPacket(224, 2); p.EncodeStr("a"); p.EncodeStr("b");
    const n = received(p); n.Decode1();
    pool.OnReqDigiQAuthorization(n, socket);
    expect(n.m_uOffset).toBe(1);
    expect(sent).toHaveLength(0); expect(forwarded).toHaveLength(0);
  });
}
test("342 result zero sends exact 209/12 first, then 301 with existing SID/BID, not returned values", () => {
  const { user, sent } = client();
  billing.m_fConnected = 1;
  const forwarded = observeBilling(() => { expect(sent).toHaveLength(1); });
  const n = auth(); billing.OnPacket(n);
  expect(n.m_uOffset).toBe(n.m_uLength);
  expect(sent).toHaveLength(1);
  const p = sent[0]!;
  expect(Buffer.from(p.m_pBlock.subarray(0, p.m_uOffset)).toString("hex"))
    .toBe("8b5687e860d13c719f48");
  const response = assertReply(p, 209);
  expect([response.Decode1(), response.Decode4(), response.Decode4()]).toEqual([12, 0x11223344, 0xaabbccdd]);
  expect([user.m_nSID, user.m_nBID]).toEqual([100, 200]);
  expect(forwarded).toHaveLength(1);
  const request = received(forwarded[0]!);
  expect([request.Decode4(), request.Decode4(), request.Decode4(), request.Decode4(), request.Decode4()])
    .toEqual([301, 100, 200, 4, 0]);
});
for (const result of [1, 2, 0xffffffff]) {
  test(`342 nonzero result ${result} sends 209/13 with byte-exact error, no balance query`, () => {
    const { sent } = client(); const forwarded = observeBilling();
    const n = auth(result, "TeStEr", "\xa4\xa4\0\xe5"); billing.OnPacket(n);
    expect(n.m_uOffset).toBe(n.m_uLength);
    expect(sent).toHaveLength(1);
    const response = assertReply(sent[0]!, 209);
    expect(response.Decode1()).toBe(13); expect(response.DecodeStr()).toBe("\xa4\xa4\0\xe5");
    expect(response.m_uOffset).toBe(response.m_uLength); expect(forwarded).toHaveLength(0);
  });
}
for (const kind of ["missing", "busy"] as const) {
  test(`342 ignores ${kind} user, no cash query`, () => {
    const { user, sent } = client();
    if (kind === "busy") user.m_fTranxInProgress = 1;
    const forwarded = observeBilling();
    billing.OnPacket(auth(0, kind === "missing" ? "other" : "tester"));
    expect(sent).toHaveLength(0); expect(forwarded).toHaveLength(0);
  });
}
test("unavailable billing reports no credentials and does not invent authorization", () => {
  const { socket, sent } = client();
  const p = new CSendPacket(224, 2); p.EncodeStr("private-id"); p.EncodeStr("secret-pass");
  const n = received(p); n.Decode1(); pool.OnReqDigiQAuthorization(n, socket);
  expect(sent).toHaveLength(0);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("billing link is unavailable"));
  expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("secret-pass"));
});
for (const result of [0, 2, 0xffffffff]) {
  test(`302 result ${result} is success: exact serial lookup, 203/1 and a separate billing cash cache`, () => {
    const { user, sent } = client(); user.m_nCash = 1234;
    const n = balance(result); billing.OnPacket(n);
    expect(n.m_uOffset).toBe(n.m_uLength); expect(sent).toHaveLength(1);
    const response = assertReply(sent[0]!, 203);
    expect([response.Decode1(), response.Decode4()]).toEqual([1, 500]);
    expect(user.m_nBillingCash).toBe(500); expect(user.m_nCash).toBe(1234);
  });
}
test("302 result one is failure: 203/0 + raw error, no cache update", () => {
  const { user, sent } = client(); user.m_nBillingCash = 99;
  const n = balance(1, 123, 500, "\xff\xa4\0denied"); billing.OnPacket(n);
  expect(n.m_uOffset).toBe(n.m_uLength); expect(sent).toHaveLength(1);
  const response = assertReply(sent[0]!, 203);
  expect(response.Decode1()).toBe(0); expect(response.DecodeStr()).toBe("\xff\xa4\0denied");
  expect(user.m_nBillingCash).toBe(99);
});
for (const kind of ["missing", "busy"] as const) {
  test(`302 ignores ${kind} user without changing cash`, () => {
    const { user, sent } = client(); user.m_nBillingCash = 99;
    if (kind === "busy") user.m_fTranxInProgress = 1;
    billing.OnPacket(balance(0, kind === "missing" ? 124 : 123));
    expect(sent).toHaveLength(0); expect(user.m_nBillingCash).toBe(99);
  });
}
for (const packet of [auth(0), auth(1), balance(0), balance(1)]) {
  test(`every truncated prefix of ${packet.Decode4At(0)}/${packet.m_uLength} is dropped, never a fabricated success`, () => {
    const { user, sent } = client(); user.m_nBillingCash = 99;
    const forwarded = observeBilling(); billing.m_fConnected = 1;
    for (let length = 4; length < packet.m_uLength; length++) {
      const n = new CReceivedPacket(); n.SetRcvPacket(packet.m_pBlock.subarray(0, length), length);
      billing.OnPacket(n);
      expect(sent).toHaveLength(0); expect(forwarded).toHaveLength(0);
      expect(user.m_nBillingCash).toBe(99);
    }
  });
}

test("only the character name uses C-string truncation; credential fields preserve NUL and high bytes", () => {
  const { socket } = client("te\0ster");
  const forwarded = observeBilling();
  const p = new CSendPacket(224, 2); p.EncodeStr("a\0b"); p.EncodeStr("\xff");
  const n = received(p); n.Decode1(); pool.OnReqDigiQAuthorization(n, socket);
  const request = forwarded[0]!;
  expect(Buffer.from(request.m_pBlock.subarray(0, request.m_uOffset)).toString("hex"))
    .toBe("000001550361006201ff027465");
});
test("342 empty error string remains an empty EStr, not a success/default message", () => {
  const { sent } = client();
  billing.OnPacket(auth(1, "tester", ""));
  const n = assertReply(sent[0]!, 209);
  expect(n.Decode1()).toBe(13); expect(n.DecodeStr()).toBe("");
  expect(n.m_uOffset).toBe(n.m_uLength);
});
test("302 accepts the full byte-length message and does not consume following fields as text", () => {
  const { sent } = client();
  const message = "\xff".repeat(255);
  billing.OnPacket(balance(1, 123, 500, message));
  const n = assertReply(sent[0]!, 203);
  expect(n.Decode1()).toBe(0); expect(n.DecodeStr()).toBe(message);
  expect(n.m_uOffset).toBe(n.m_uLength);
});
test("billing cash preserves a signed DWORD cache and its unsigned wire representation", () => {
  const { user, sent } = client();
  billing.OnPacket(balance(0, 123, 0xffffffff));
  expect(user.m_nBillingCash).toBe(-1);
  const n = assertReply(sent[0]!, 203);
  expect([n.Decode1(), n.Decode4()]).toEqual([1, 0xffffffff]);
});
test("authorization success after billing disconnect still replies 209 but cannot send 301", () => {
  const { sent } = client();
  const forwarded = observeBilling();
  billing.OnPacket(auth());
  expect(sent).toHaveLength(1); expect(forwarded).toHaveLength(0);
  expect(assertReply(sent[0]!, 209).Decode1()).toBe(12);
});
