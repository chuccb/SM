/** A16: independent hex vectors from FxShop .lst, not a native execution.
 * Codec 00419170..004193AC; socket 00405360..004056C9; dispatch 00404DB0.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CBillingSocketTw } from "../src/FXSS/BillingSocket.ts";
import {
  CSendPacket, DecodePacketTw, EncodePacketTw, GetIncomingPacketLengthTw, GetOutgoingPacketLengthTw,
} from "../src/FXSS/Packet.ts";
import { CipherDegree, CReceivedPacket, CSendPacket as CGameSendPacket, enSocket } from "../src/core/Packet.ts";
import { CPacketSocket } from "../src/core/PacketSocket.ts";
import { PacketLog } from "../src/core/PacketLog.ts";
import { CBillingProcess, CUser, CMainSystem, CClientSocket } from "../src/FXSS/FxShop.ts";
import { ShopItem } from "../src/FXSS/Recordsets.ts";
import {
  BILLING_PACKET_LOG_CONTEXT,
  Shop2Billing_LegacyPacket,
  Shop2Billing_CouponPacket,
  Billing2Shop_TwPacket,
  Shop2Billing_TwPacket,
} from "../src/core/protocol/PacketIDs.ts";
import {
  STANDARD_PACKET_OPCODE_BYTES,
  TAIWAN_BILLING_OPCODE_BYTES,
  WORD_PACKET_OPCODE_BYTES,
} from "../src/core/protocol/PacketNames.ts";
import type { CDBMan } from "../src/db/DBMan.ts";

const RTT = "00000005000000070000015f7b";
const RTT_RESPONSE = "0000000500000007000001607b";
const bytes = (hex: string) => Buffer.from(hex, "hex");
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");
let previousBilling: CBillingProcess | null;
let previousMainSystem: CMainSystem | null;
beforeEach(() => {
  previousBilling = CBillingProcess.ms_pInstance;
  previousMainSystem = CMainSystem.ms_pInstance;
  spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  mock.restore();
  CBillingProcess.ms_pInstance = previousBilling;
  CMainSystem.ms_pInstance = previousMainSystem;
});

function frame(packet: CGameSendPacket): Uint8Array {
  const result = new Uint8Array(GetOutgoingPacketLengthTw(packet));
  expect(EncodePacketTw(packet, result)).toBe(true);
  return result;
}
function rtt(): CSendPacket {
  const p = new CSendPacket(Shop2Billing_TwPacket.TwRequestRTT);
  p.Encode1(123);
  return p;
}
function receiver() {
  const received: { id: number; body: string; offset: number }[] = [];
  const socket = new CBillingSocketTw(false, {
    onPacket: (_s, p) => received.push({ id: p.m_nPacketType, body: hex(p.m_pBlock), offset: p.m_uOffset }),
  });
  socket.m_bConnected = true;
  return { socket, received };
}
function buffered(socket: CBillingSocketTw, hexData: string): void {
  const data = bytes(hexData); socket.m_mbRcvBuffer.set(data); socket.m_nRcvCnt = data.length;
}

class Transport {
  limit = Infinity;
  output: number[] = [];
  ends = 0;
  writes = 0;
  handle = {
    write: (data: Uint8Array) => {
      this.writes++;
      const count = Math.min(this.limit, data.length);
      this.output.push(...data.subarray(0, count));
      return count;
    },
    end: () => { this.ends++; },
  } as unknown as Bun.Socket;
  attach(socket: CPacketSocket) { socket.bunSocket = this.handle; socket.m_bConnected = true; }
}

describe("Tw packet codec and opcode overloads", () => {
  test("351 RTT exact bytes and complete DWORD opcode", () => {
    const packet = rtt();
    expect(packet.m_nCipherDegree).toBe(CipherDegree.kPacketRaw);
    expect(hex(frame(packet))).toBe(RTT);
    const received = new CReceivedPacket();
    expect(GetIncomingPacketLengthTw(received, bytes(RTT), 13)).toBe(13);
    expect(DecodePacketTw(received, bytes(RTT), 13)).toBe(true);
    expect([received.m_uOffset, received.m_uLength, received.m_nPacketType]).toEqual([0, 5, 351]);
    expect([received.Decode4(), received.Decode1()]).toEqual([351, 123]);
  });
  for (const [width, prefix] of [
    [STANDARD_PACKET_OPCODE_BYTES, "78"],
    [WORD_PACKET_OPCODE_BYTES, "5678"],
    [TAIWAN_BILLING_OPCODE_BYTES, "12345678"],
  ] as const) {
    test(`native opcode width ${width}, without changing ordinary game packet semantics`, () => {
      const p = new CSendPacket(0x12345678, width);
      expect(hex(p.m_pBlock.subarray(0, p.m_uOffset))).toBe(prefix);
      expect(p.m_nPacketType).toBe(0x12345678);
      const game = new CGameSendPacket(0x78, CipherDegree.kPacketEncryptedCRC8);
      expect(game.m_nCipherDegree).toBe(CipherDegree.kPacketEncryptedCRC8); expect(game.m_uOffset).toBe(1);
      expect(game.GetOutgoingPacketLength()).toBe(5);
    });
  }
  test("InitPacket width overload appends and forces raw degree; core reset is unchanged", () => {
    const p = new CSendPacket(0x11, STANDARD_PACKET_OPCODE_BYTES);
    p.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8);
    p.InitPacket(0x2233, WORD_PACKET_OPCODE_BYTES);
    p.InitPacket(0x44556677, TAIWAN_BILLING_OPCODE_BYTES);
    expect(p.m_nCipherDegree).toBe(CipherDegree.kPacketRaw);
    expect(hex(p.m_pBlock.subarray(0, p.m_uOffset))).toBe("11223344556677");
    const ordinary = new CGameSendPacket(1); ordinary.Encode4(99); ordinary.InitPacket(2);
    expect(ordinary.m_uOffset).toBe(1);
  });
  test("legacy BNB_TAIWAN enum overloads retain both prefix bytes", () => {
    for (const [packet, prefix] of [
      [CSendPacket.FromBillingPacket(Shop2Billing_LegacyPacket.RequestGift), "0007"],
      [CSendPacket.FromCouponPacket(Shop2Billing_CouponPacket.RequestCheckCoupon), "0100"],
      [CSendPacket.FromCouponPacket(Shop2Billing_CouponPacket.RequestUseCoupon), "0101"],
    ] as const) {
      expect(hex(frame(packet))).toBe(`0000000200000007${prefix}`);
    }
  });
  for (const degree of [CipherDegree.kPacketEncrypted, CipherDegree.kPacketEncryptedCRC8]) {
    test(`Tw disallows nonraw degree ${degree}`, () => {
      const p = rtt(); p.SetCipherDegree(degree);
      expect(GetOutgoingPacketLengthTw(p)).toBe(0);
      expect(EncodePacketTw(p, new Uint8Array(30))).toBe(false);
      const n = new CReceivedPacket(); n.SetCipherDegree(degree);
      expect(GetIncomingPacketLengthTw(n, bytes(RTT), 13)).toBe(0);
      expect(DecodePacketTw(n, bytes(RTT), 13)).toBe(false);
    });
  }
  test("encode into a FIFO suffix does not overwrite prefix or tail", () => {
    const dest = new Uint8Array(20).fill(0xaa);
    expect(EncodePacketTw(rtt(), dest, 3)).toBe(true);
    expect(hex(dest)).toBe(`aaaaaa${RTT}aaaaaaaa`);
    expect(EncodePacketTw(rtt(), dest, 8)).toBe(false);
  });
  test("empty body after opcode is valid; empty payload is not decodable", () => {
    const packet = new CSendPacket(Billing2Shop_TwPacket.OnTwRTT);
    expect(hex(frame(packet))).toBe("000000040000000700000160");
    const n = new CReceivedPacket();
    expect(DecodePacketTw(n, frame(packet), 12)).toBe(true);
    packet.m_uOffset = 0; // native default CSendPacket() has no payload
    expect(hex(frame(packet))).toBe("0000000000000007");
    expect(DecodePacketTw(n, frame(packet), 8)).toBe(false);
    expect(DecodePacketTw(n, bytes(RTT), 14)).toBe(false);
  });
  test("length waits for all eight header bytes, even when the DWORD is present", () => {
    for (let length = 0; length < 8; length++) {
      expect(GetIncomingPacketLengthTw(new CReceivedPacket(), bytes(RTT), length)).toBe(-1);
    }
  });
});

describe("CBillingSocketTw bounded receive pump", () => {
  for (let split = 0; split <= 13; split++) {
    test(`RTT split at byte ${split}, followed by a coalesced opcode-only frame`, () => {
      const { socket, received } = receiver();
      const packet = bytes(RTT_RESPONSE);
      socket.OnReceive(packet.subarray(0, split));
      if (split < packet.length) expect(received).toHaveLength(0);
      socket.OnReceive(Buffer.concat([packet.subarray(split), bytes("000000040000000700000142")]));
      expect(received).toEqual([
        { id: 352, body: "000001607b", offset: 0 },
        { id: 322, body: "00000142", offset: 0 },
      ]);
      expect(socket.m_nRcvCnt).toBe(0); expect(socket.m_bConnected).toBe(true);
    });
  }
  test("one-byte fragmentation does not trip the client-only flood guard", () => {
    const { socket, received } = receiver();
    for (let i = 0; i < 6; i++) for (const b of bytes(RTT_RESPONSE)) socket.OnReceive(Uint8Array.of(b));
    expect(received).toHaveLength(6); expect(socket.m_nRcvStampSeq).toBe(0);
  });
  test("callbacks larger than the buffer are pumped, including a partial final frame", () => {
    const { socket, received } = receiver();
    const whole = Buffer.concat(Array.from({ length: 6000 }, () => bytes(RTT_RESPONSE)));
    socket.OnReceive(whole.subarray(0, whole.length - 1));
    expect(received).toHaveLength(5999); expect(socket.m_nRcvCnt).toBe(12);
    socket.OnReceive(whole.subarray(-1));
    expect(received).toHaveLength(6000); expect(socket.m_nRcvCnt).toBe(0);
    expect(socket.m_bConnected).toBe(true);
  });
  test("maximum frame fits exactly, and the next frame is not discarded", () => {
    const { socket, received } = receiver();
    const p = new CSendPacket(Billing2Shop_TwPacket.OnTwRTT);
    p.EncodeBuffer(new Uint8Array(socket.m_nMaxPacketLen - 12).fill(0x7f));
    const encoded = frame(p);
    expect(encoded.length).toBe(socket.m_mbRcvBuffer.length);
    socket.OnReceive(Buffer.concat([encoded, bytes(RTT_RESPONSE)]));
    expect(received).toHaveLength(2); expect(received[0]!.body.length).toBe((encoded.length - 8) * 2);
    expect(socket.m_bConnected).toBe(true);
  });
  test("header word is ignored; game header/sequence state is never used", () => {
    const { socket, received } = receiver();
    socket.SetHeaderType(9); socket.SetSequence(40, 40, 3, 3);
    socket.SetHeaderCode(189, 96, 231);
    socket.OnReceive(bytes("00000005deadbeef000001607b"));
    expect(received[0]!.id).toBe(352);
    expect(socket.m_nPacketRcvSeq).toBe(40); expect(socket.m_nHeaderType).toBe(9);
    const transport = new Transport(); transport.attach(socket);
    socket.SendPacket(rtt());
    expect(hex(Uint8Array.from(transport.output))).toBe(RTT);
    expect(socket.m_nPacketSndSeq).toBe(40);
  });
  for (const [length, result] of [
    [0, enSocket.kioDecodingError],
    [32761, enSocket.kioTooLongPacket],
    [0x7ffffff8, enSocket.kioDecodingError], // refuse unsafe native allocation/copy
    [0x80000000, enSocket.kioDecodingError],
    [0xfffffff7, enSocket.kioNotReady], // DWORD +8 == native -1 sentinel
    [0xfffffff8, enSocket.kioInvalidPacket], // DWORD +8 == 0
    [0xffffffff, enSocket.kioDecodingError], // DWORD +8 == 7, no payload
  ] as const) {
    test(`payload ${length.toString(16)}: native DWORD result ${result}, without unsafe allocation`, () => {
      const { socket } = receiver(); const n = new CReceivedPacket();
      const header = Buffer.alloc(8); header.writeUInt32BE(length); header.writeUInt32BE(7, 4);
      socket.m_mbRcvBuffer.set(header); socket.m_nRcvCnt = 8;
      expect(socket.GetPacket(n)).toBe(result);
      expect(socket.m_bConnected).toBe(result === enSocket.kioNotReady); expect(n.m_uSize).toBe(0);
    });
  }
  test("nonraw receive is invalid; not-ready and disconnected are distinct", () => {
    const { socket } = receiver(); const n = new CReceivedPacket();
    expect(socket.GetPacket(n)).toBe(enSocket.kioNotReady);
    buffered(socket, RTT); socket.SetCipherDegree(2);
    expect(socket.GetPacket(n)).toBe(enSocket.kioInvalidPacket);
    expect(socket.GetPacket(n)).toBe(enSocket.kioNotConnected);
  });
  test("short nonempty payload is preserved, not a new minimum-opcode-length rejection", () => {
    const { socket, received } = receiver();
    socket.OnReceive(bytes("00000001000000077b"));
    expect(received).toEqual([{ id: 0, body: "7b", offset: 0 }]);
    expect(socket.m_bConnected).toBe(true);
  });
  test("close in a handler stops coalesced delivery", () => {
    const { socket } = receiver(); let calls = 0;
    socket.hooks.onPacket = () => { calls++; socket.Close(); };
    socket.OnReceive(Buffer.concat([bytes(RTT), bytes(RTT)]));
    expect(calls).toBe(1); expect(socket.m_nRcvCnt).toBe(0);
  });
});

describe("Tw send FIFO and native error policy", () => {
  for (const accepted of [0, 1, 7, 8, 12, 13]) {
    test(`write accepts ${accepted}/13 bytes; two frames retain byte order through drain`, () => {
      const { socket } = receiver(); const transport = new Transport(); transport.attach(socket);
      transport.limit = accepted;
      expect(socket.SendPacket(rtt())).toBe(enSocket.kioOk);
      expect(socket.m_nSndCnt).toBe(13 - accepted);
      expect(transport.writes).toBe(1);
      socket.PutPacket(rtt()); transport.limit = Infinity; socket.Flush();
      expect(hex(Uint8Array.from(transport.output))).toBe(RTT + RTT);
      expect(socket.m_nSndCnt).toBe(0);
    });
  }
  test("invalid cipher does not disturb the queued prefix or close a sender", () => {
    const { socket } = receiver(); socket.PutPacket(rtt());
    const p = new CGameSendPacket(1, CipherDegree.kPacketEncryptedCRC8);
    expect(socket.PutPacket(p)).toBe(enSocket.kioInvalidPacket);
    expect(socket.m_nSndCnt).toBe(13); expect(socket.m_bConnected).toBe(true);
    socket.Close(); expect(socket.PutPacket(rtt())).toBe(enSocket.kioNotConnected);
  });
  test("encoding failure cannot advance the FIFO or flush its queued prefix", () => {
    const { socket } = receiver(); socket.PutPacket(rtt());
    const packet = rtt(); packet.m_uOffset = packet.m_pBlock.length + 1; // invalid backing storage
    expect(socket.SendPacket(packet)).toBe(enSocket.kioEncodingError);
    expect(socket.m_nSndCnt).toBe(13);
    expect(hex(socket.m_mbSndBuffer.subarray(0, socket.m_nSndCnt))).toBe(RTT);
    expect(socket.m_bConnected).toBe(true);
  });
  test("exact send bound succeeds; overflow closes once and discards the queue", () => {
    const { socket } = receiver(); const transport = new Transport(); transport.attach(socket);
    socket.m_mbSndBuffer = new Uint8Array(26);
    expect(socket.PutPacket(rtt())).toBe(enSocket.kioOk);
    expect(socket.PutPacket(rtt())).toBe(enSocket.kioOk);
    expect(socket.PutPacket(rtt())).toBe(enSocket.kioSendBufferOverflow);
    expect(socket.m_nSndCnt).toBe(0); expect(transport.output).toEqual([]); expect(transport.ends).toBe(1);
    socket.Close(); expect(transport.ends).toBe(1);
  });
  for (const mode of ["overflow", "empty", "too-long", "receive-overflow", "write-negative", "write-throw", "hello-write"]) {
    test(`fatal socket ${mode} exits zero AFTER closing, in an isolated process`, async () => {
      const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/billing-failure-worker.ts`, mode], {
        stdout: "pipe", stderr: "pipe",
      });
      const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).toBe(0);
      expect(output).toContain(mode === "hello-write" ? "hello-closed" : "closed:0:0");
      expect(output).not.toContain("incorrectly returned");
      expect(errors.length).toBeGreaterThan(0);
    });
  }
});

describe("billing builders and four-byte dispatch integration", () => {
  test("every existing builder uses its native opcode prefix, independently of handler business logic", () => {
    const billing = new CBillingProcess({} as CDBMan);
    const socket = new CBillingSocketTw(false); const transport = new Transport(); transport.attach(socket);
    billing.m_pSocket = socket; billing.m_fConnected = 1; billing.m_nSvrTag = 9;
    const user = new CUser(null); user.SetName("a"); user.SetGlobalSerialNo(0x33);
    user.m_nSID = 0x11; user.m_nBID = 0x22;
    user.m_pSocket = { m_strPeerAddress: "1.2.3.4" } as CClientSocket;
    const item = new ShopItem(); item.SN = 6; item.Price = 7;
    const mainSystem = new CMainSystem();
    mainSystem.m_nFXAttr = 0;
    const cases: [() => void, string][] = [
      [() => billing.TwRequestRTT(), "0000015f7b"],
      [() => billing.RequestRemainCashTw(user), "0000012d0000001100000022000000040000000901610000003307312e322e332e34"],
      // A17's correlation and response semantics remain separate defects.
      [() => billing.RequestPurchaseTw(user, item), "00000137"],
      [() => billing.RequestDigiQAuthorization("a", "b", "c"), "00000155016101620163"],
      [() => billing.RequestGift(user, "b", 6, 7), "0007"],
      [() => billing.RequestCheckCoupon(user), "0100"],
      [() => billing.RequestUseCoupon(user), "0101"],
    ];
    for (const [send, prefix] of cases) {
      transport.output.length = 0; send();
      const raw = Buffer.from(transport.output);
      expect(raw.readUInt32BE()).toBe(raw.length - 8); expect(raw.readUInt32BE(4)).toBe(7);
      expect(hex(raw.subarray(8)).startsWith(prefix)).toBe(true);
      if (prefix.length > 8) expect(hex(raw.subarray(8))).toBe(prefix);
    }
  });
  test("receive dispatch sees full IDs, leaves the body after four bytes, and ignores unknown IDs", () => {
    const billing = new CBillingProcess({} as CDBMan);
    const socket = new CBillingSocketTw(false, { onPacket: (_s, p) => billing.OnPacket(p) });
    socket.m_bConnected = true;
    const observed: number[][] = [];
    for (const [id, method] of [[302, "OnRemainCashTw"], [312, "OnPurchaseOKTw"], [322, "OnPurchaseConfirmTw"], [342, "OnDigiQAuthen"]] as const) {
      spyOn(billing, method).mockImplementation(p => { observed.push([id, p.m_uOffset, p.Decode4()]); });
    }
    const log = spyOn(console, "log").mockImplementation(() => {});
    for (const id of [302, 312, 322, 342, 352, 0x1234012e]) {
      const p = new CSendPacket(id); p.Encode4(0xabcdef01); socket.OnReceive(frame(p));
    }
    expect(observed).toEqual([302, 312, 322, 342].map(id => [id, 4, 0xabcdef01]));
    expect(log).toHaveBeenCalledWith("[Shop] Received RTT Response");
    expect(socket.m_bConnected).toBe(true);
  });
  test("trace metadata is the full opcode and does not consume dispatch bytes", () => {
    spyOn(PacketLog, "ShowsInfra").mockReturnValue(true);
    const log = spyOn(PacketLog, "Packet").mockImplementation(() => {});
    const { socket, received } = receiver();
    socket.PutPacket(rtt()); socket.OnReceive(bytes(RTT_RESPONSE));
    expect(log.mock.calls.map(call => [call[2], call[3], call[4], hex(call[5]!), call[6]]))
      .toEqual([["send", 351, 0, "0000015f7b", BILLING_PACKET_LOG_CONTEXT.Taiwan],
        ["recv", 352, 0, "000001607b", BILLING_PACKET_LOG_CONTEXT.Taiwan]]);
    expect(received[0]!.offset).toBe(0);
  });

  test("trace keeps Taiwan/LocalBilling/Coupon contexts separate and redacts credentials", () => {
    const savedLog = process.env.CA_PACKET_LOG;
    const savedScope = process.env.CA_PACKET_LOG_SCOPE;
    process.env.CA_PACKET_LOG = "1";
    process.env.CA_PACKET_LOG_SCOPE = "all";
    const lines: string[] = [];
    PacketLog.out = (line) => lines.push(line);
    try {
      const socket = new CBillingSocketTw(false);
      socket.m_bConnected = true;
      const authorization = new CSendPacket(Shop2Billing_TwPacket.RequestDigiQAuthorization);
      authorization.EncodeBuffer(Buffer.from("account-password", "latin1"));
      expect(socket.PutPacket(authorization)).toBe(enSocket.kioOk);
      expect(socket.PutPacket(CSendPacket.FromBillingPacket(7))).toBe(enSocket.kioOk);
      expect(socket.PutPacket(CSendPacket.FromCouponPacket(0))).toBe(enSocket.kioOk);

      expect(lines[0]).toContain("RequestDigiQAuthorization(341)");
      expect(lines[0]).toContain("[credentials redacted]");
      expect(lines[0]).not.toContain("61 63 63 6f 75 6e 74");
      expect(lines[1]).toContain("RequestGift(7)");
      expect(lines[1]).toContain("| 00 07");
      expect(lines[2]).toContain("RequestCheckCoupon(0)");
      expect(lines[2]).toContain("[credentials redacted]");
    } finally {
      PacketLog.out = null;
      if (savedLog === undefined) delete process.env.CA_PACKET_LOG;
      else process.env.CA_PACKET_LOG = savedLog;
      if (savedScope === undefined) delete process.env.CA_PACKET_LOG_SCOPE;
      else process.env.CA_PACKET_LOG_SCOPE = savedScope;
    }
  });
});

test("real TCP billing link: exact 331 hello, fragmented 352 reply, 351 request, peer close", async () => {
  const billing = new CBillingProcess({} as CDBMan); billing.m_nSvrTag = 0x12345678;
  const observed: number[] = [];
  const original = billing.OnPacket.bind(billing);
  spyOn(billing, "OnPacket").mockImplementation(p => { observed.push(p.Decode4At(0)); original(p); });
  const gotReply = Promise.withResolvers<void>();
  const gotRTT = Promise.withResolvers<void>();
  const received: number[] = [];
  let peer: Bun.Socket | undefined;
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(socket) { peer = socket; },
      data(_socket, data) {
        received.push(...data);
        if (received.length >= 20 + 13) gotRTT.resolve();
      },
    },
  });
  const log = spyOn(console, "log").mockImplementation(message => {
    if (message === "[Shop] Received RTT Response") gotReply.resolve();
  });
  try {
    billing.m_aBillingSvr = [{ SN: 1, ip: "127.0.0.1", port: server.port }];
    expect(await billing.ConnectToSvr()).toBe(1);
    // Chunk boundaries intentionally cross both DWORDs. The peer's small
    // writes are checked for full acceptance; no fixture-side dropped bytes.
    for (const chunk of [bytes(RTT_RESPONSE).subarray(0, 3), bytes(RTT_RESPONSE).subarray(3, 9), bytes(RTT_RESPONSE).subarray(9)]) {
      expect(peer!.write(chunk)).toBe(chunk.length); await Bun.sleep(2);
    }
    await Promise.race([gotReply.promise, Bun.sleep(2000).then(() => { throw new Error("no Tw reply dispatched"); })]);
    billing.TwRequestRTT();
    await Promise.race([gotRTT.promise, Bun.sleep(2000).then(() => { throw new Error("no Tw request received"); })]);
    expect(hex(Uint8Array.from(received))).toBe("0000000c000000070000014b0000000412345678" + RTT);
    expect(observed).toEqual([352]);
    const closed = Promise.withResolvers<void>();
    const socket = billing.m_pSocket!; const onClose = socket.hooks.onClose;
    socket.hooks.onClose = s => { onClose(s); closed.resolve(); };
    peer!.end();
    await Promise.race([closed.promise, Bun.sleep(2000).then(() => { throw new Error("peer close not handled"); })]);
    expect(billing.m_fConnected).toBe(0); expect(billing.m_pSocket).toBeNull();
  } finally {
    billing.m_pSocket?.Close(); peer?.end(); server.stop(true); log.mockRestore();
  }
});
