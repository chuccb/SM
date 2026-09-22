/** A01: native byte-count FIFO semantics (FXGS 0043B530/0042EE9D/0042EFCF),
 * exercised with deterministic short writes and a real slow TCP receiver.
 * These are regression tests, unlike the inventory's diagnostic probes.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
  CPacketSocket,
} from "../src/core/PacketSocket.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, enSocket } from "../src/core/Packet.ts";
import { CLocalSocket } from "../src/common/LocalSocket.ts";
import { CLocalSocket as CCenterLocalSocket, type LocalSocketHost } from "../src/Center/CxCenter.ts";
import { CBillingProcess, CWebSocket } from "../src/FXSS/FxShop.ts";
import type { CDBMan } from "../src/db/DBMan.ts";
import {
  CENTER_VERSION,
  CLIENT_VERSION,
  GAME_VERSION,
  LOCAL_SERVER_IDENTIFICATION_SIZE,
  LOCALSOCKET_HEADER_CODE_MODIFIER,
  LOCALSOCKET_HEADER_CODE_RCV,
  LOCALSOCKET_HEADER_CODE_SND,
  LOCALSOCKET_SEQ,
  LOCALSOCKET_SEQ_DELTA,
  SVRCLASS_GAME,
  SVRIDX_IDENTIFY_XOR,
} from "../src/core/protocol/CenterProtocol.ts";

class TestSocket extends CPacketSocket {}

/** The fake obeys Bun.write's contract: only the returned prefix was sent. */
class Transport {
  limit = Infinity;
  writes = 0;
  ends = 0;
  bytes: number[] = [];
  failure: "negative" | "throw" | null = null;
  handle = {
    localPort: 2828,
    write: (bytes: Uint8Array): number => {
      this.writes++;
      if (this.failure === "throw") throw new Error("closed transport");
      if (this.failure === "negative") return -1;
      const n = Math.min(this.limit, bytes.length);
      this.bytes.push(...bytes.subarray(0, n));
      return n;
    },
    end: () => { this.ends++; },
  } as unknown as Bun.Socket;
  attach(socket: CPacketSocket): void {
    socket.m_bConnected = true;
    socket.bunSocket = this.handle;
  }
}
function pending(socket: CPacketSocket): number[] {
  return Array.from(socket.m_mbSndBuffer.subarray(0, socket.m_nSndCnt));
}
function packet(id: number, degree: number): CSendPacket {
  const p = new CSendPacket(id, degree);
  p.Encode4(0x12345678);
  return p;
}
function configure(socket: CPacketSocket, degree: number): void {
  socket.SetCipherDegree(degree);
  socket.SetHeaderType(5);
  // This fixture is symmetric, so use the official send base in both slots.
  socket.SetHeaderCode(
    CLIENTSOCKET_HEADER_CODE_SND,
    CLIENTSOCKET_HEADER_CODE_SND,
    CLIENTSOCKET_HEADER_CODE_MODIFIER,
  );
  socket.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
}

describe("CPacketSocket send FIFO", () => {
  test("native cipher-degree setters reject values outside integral enum 0..2", () => {
    const socket = new TestSocket();
    const sent = new CSendPacket(1, CipherDegree.kPacketEncrypted);
    const received = new CReceivedPacket();
    received.SetCipherDegree(CipherDegree.kPacketEncrypted);
    socket.SetCipherDegree(CipherDegree.kPacketEncrypted);
    for (const invalid of [-1, 3, 1.5, NaN, Infinity]) {
      sent.SetCipherDegree(invalid);
      received.SetCipherDegree(invalid);
      socket.SetCipherDegree(invalid);
      expect([
        sent.m_nCipherDegree,
        received.m_nCipherDegree,
        socket.m_nCipherDegree,
      ]).toEqual([
        CipherDegree.kPacketEncrypted,
        CipherDegree.kPacketEncrypted,
        CipherDegree.kPacketEncrypted,
      ]);
    }
    expect(new CSendPacket(1, -1).m_nCipherDegree).toBe(CipherDegree.kPacketRaw);
  });

  for (let accepted = 0; accepted <= 8; accepted++) {
    test(`write accepts ${accepted}/8 bytes; a later drain sends exactly the suffix`, () => {
      const socket = new TestSocket();
      const transport = new Transport(); transport.attach(socket); transport.limit = accepted;
      const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
      expect(socket.SendBuffer(bytes)).toBe(enSocket.kioOk);
      expect(transport.writes).toBe(1); // no busy retry loop, including write(0)
      expect(pending(socket)).toEqual(Array.from(bytes.subarray(accepted)));
      transport.limit = Infinity;
      socket.Flush(); // the drain adapter
      expect(socket.m_nSndCnt).toBe(0);
      expect(transport.bytes).toEqual(Array.from(bytes));
      const writes = transport.writes;
      socket.Flush();
      expect(transport.writes).toBe(writes);
      socket.Close();
    });
  }

  for (const degree of Object.values(CipherDegree)) {
    test(`raw + two degree-${degree} frames: short writes never re-encode or reorder`, () => {
      const expected = new TestSocket(); expected.m_bConnected = true; configure(expected, degree);
      const socket = new TestSocket(); configure(socket, degree);
      const transport = new Transport(); transport.attach(socket); transport.limit = 1;
      const greeting = Uint8Array.of(9, 8, 7);
      expected.PutBuffer(greeting, greeting.length);
      socket.SendBuffer(greeting);
      for (const id of [20, 21]) {
        expected.PutPacket(packet(id, degree));
        socket.SendPacket(packet(id, degree));
      }
      const bytes = pending(expected);
      expect(socket.m_nPacketSndSeq).toBe(46);
      while (socket.m_nSndCnt > 0) socket.Flush();
      expect(transport.bytes).toEqual(bytes);
      expect(socket.m_nPacketSndSeq).toBe(46);
      // Decode both frames, not just a same-encoder byte comparison.
      const received: number[][] = [];
      const receiver = new TestSocket(undefined, undefined, {
        onPacket: (_s, p) => received.push([p.Decode1(), p.Decode4()]),
      });
      receiver.m_bConnected = true; configure(receiver, degree);
      for (const byte of transport.bytes.slice(greeting.length)) receiver.OnReceive(Uint8Array.of(byte));
      expect(received).toEqual([[20, 0x12345678], [21, 0x12345678]]);
      expect(receiver.m_nPacketRcvSeq).toBe(46);
      socket.Close(); receiver.Close(); expected.Close();
    });
  }

  test("queued raw bytes are owned copies; new bytes append after a partial suffix", () => {
    const socket = new TestSocket(); const transport = new Transport(); transport.attach(socket);
    transport.limit = 2;
    const source = Uint8Array.of(1, 2, 3, 4);
    socket.SendBuffer(source); source.fill(99);
    transport.limit = 0;
    socket.SendBuffer(Uint8Array.of(5, 6));
    expect(pending(socket)).toEqual([3, 4, 5, 6]);
    socket.Flush(); socket.Flush();
    expect(pending(socket)).toEqual([3, 4, 5, 6]);
    transport.limit = Infinity; socket.Flush();
    expect(transport.bytes).toEqual([1, 2, 3, 4, 5, 6]);
    socket.Close();
  });

  for (const failure of ["negative", "throw"] as const) {
    test(`write ${failure}: detach before cleanup; no recursion, stale drain or double close`, () => {
      let closes = 0;
      class CleanupSocket extends TestSocket {
        protected override OnClose(): void {
          closes++;
          expect(this.bunSocket).toBeNull();
          expect(this.m_nSndCnt).toBe(0);
          expect(this.SendPacket(packet(20, 0))).toBe(enSocket.kioNotConnected);
          this.Close(); // duplicate/reentrant cleanup is harmless
          super.OnClose();
        }
      }
      const socket = new CleanupSocket(); const transport = new Transport(); transport.attach(socket);
      transport.failure = failure;
      socket.SendBuffer(Uint8Array.of(1, 2, 3));
      socket.Flush(); socket.Close(); socket.PostClosePacket();
      expect(transport.writes).toBe(1);
      expect(transport.ends).toBe(1);
      expect(closes).toBe(1);
      expect(socket.m_bConnected).toBe(false);
      // Even if this object is attached again, no previous bytes remain.
      const next = new Transport(); next.attach(socket); socket.Flush();
      expect(next.bytes).toEqual([]);
      socket.Close();
    });
  }

  test("explicit close drops pending data, even if end throws", () => {
    let closes = 0;
    const socket = new TestSocket(undefined, undefined, { onClose: () => { closes++; } });
    const transport = new Transport(); transport.attach(socket); transport.limit = 0;
    transport.handle.end = () => { throw new Error("already closed"); };
    socket.SendBuffer(Uint8Array.of(1, 2));
    socket.m_nRcvCnt = 3;
    socket.Close(); socket.Flush(); socket.Close();
    expect(socket.m_nSndCnt).toBe(0); expect(socket.m_nRcvCnt).toBe(0);
    expect(transport.bytes).toEqual([]); expect(closes).toBe(1);
  });

  test("capacity stays bounded for raw and framed sends; no sequence advance on overflow", () => {
    for (const framed of [false, true]) {
      const socket = new TestSocket(16, 8); const transport = new Transport(); transport.attach(socket);
      configure(socket, 0); transport.limit = 0;
      socket.SendBuffer(new Uint8Array(7));
      const result = framed ? socket.SendPacket(packet(20, 0)) : socket.SendBuffer(new Uint8Array(2));
      expect(result).toBe(enSocket.kioSendBufferOverflow);
      expect(socket.m_bConnected).toBe(false);
      expect(socket.m_nSndCnt).toBe(0);
      expect(socket.m_nPacketSndSeq).toBe(40);
    }
  });

  test("invalid raw lengths cannot introduce bytes outside the source", () => {
    const socket = new TestSocket(); socket.m_bConnected = true;
    for (const len of [0, -1, 0.5, 3, NaN, Infinity]) {
      expect(socket.PutBuffer(Uint8Array.of(1, 2), len)).toBe(enSocket.kioInvalidPacket);
      expect(socket.m_nSndCnt).toBe(0);
    }
    socket.Close();
  });

  test("Center greeting and Shop raw verification use the same FIFO", () => {
    const center = new CCenterLocalSocket({ OnDisconnect: () => {} } as unknown as LocalSocketHost);
    const transport = new Transport(); transport.attach(center); transport.limit = 1;
    center.SendGreeting(); center.SendGreeting(); // exactly one greeting queued
    transport.limit = Infinity; center.Flush();
    expect(transport.bytes).toEqual([
      0, CENTER_VERSION,
      (center.m_nHeaderType >>> 8) & 0xff, center.m_nHeaderType & 0xff,
    ]);
    center.Close();
    const web = new CWebSocket(); const webTransport = new Transport(); webTransport.attach(web);
    webTransport.limit = 1;
    web.SendBuffer(Int32Array.of(-3).buffer);
    webTransport.limit = Infinity; web.Flush();
    expect(webTransport.bytes).toEqual([253, 255, 255, 255]);
    const sn = web.m_nLocalSerialNo;
    web.Close(); web.Close();
    expect(CWebSocket.ms_tblSerialNo2Socket.has(sn)).toBe(false);
  });
});

describe("CLocalSocket raw identification ordering", () => {
  const centerHeaderType = 4;
  const serverIndex = 2;
  const greeting = Buffer.from([0, CENTER_VERSION, 0, centerHeaderType]);
  const gameVersion = GAME_VERSION[SVRCLASS_GAME];
  const clientVersion = CLIENT_VERSION[SVRCLASS_GAME];
  const identification = [
    SVRCLASS_GAME,
    serverIndex ^ SVRIDX_IDENTIFY_XOR, 0, 0, 0,
    gameVersion & 0xff, (gameVersion >>> 8) & 0xff,
    clientVersion & 0xff, (clientVersion >>> 8) & 0xff,
  ];

  test("early fragmented greeting + coalesced frame, short identification and drain", async () => {
    const transport = new Transport(); transport.limit = 2;
    let handlers!: Bun.SocketHandler;
    const incoming = new TestSocket(); incoming.m_bConnected = true;
    incoming.SetHeaderType(centerHeaderType);
    incoming.SetHeaderCode(
      LOCALSOCKET_HEADER_CODE_SND,
      LOCALSOCKET_HEADER_CODE_RCV,
      LOCALSOCKET_HEADER_CODE_MODIFIER,
    );
    incoming.SetSequence(LOCALSOCKET_SEQ, LOCALSOCKET_SEQ, LOCALSOCKET_SEQ_DELTA, LOCALSOCKET_SEQ_DELTA);
    incoming.PutPacket(packet(42, 0));
    const frame = Buffer.from(pending(incoming));
    const received: number[] = [];
    const local = new CLocalSocket({ onPacket: (_s, p) => {
      received.push(p.Decode1()); local.SendToCenter(packet(43, 0));
    } });
    const connectMock = spyOn(Bun, "connect").mockImplementation(((options: { socket: Bun.SocketHandler }) => {
      handlers = options.socket;
      handlers.open!(transport.handle);
      handlers.data!(transport.handle, greeting.subarray(0, 1));
      handlers.data!(transport.handle, Buffer.concat([greeting.subarray(1), frame]));
      return Promise.resolve(transport.handle);
    }) as typeof Bun.connect);
    try {
      await local.ConnectToCenter("fixture", 1, SVRCLASS_GAME, serverIndex);
      expect(received).toEqual([42]);
      expect(local.centerVersion).toBe(CENTER_VERSION);
      expect(local.centerHeaderType).toBe(centerHeaderType);
      expect(local.m_nSndCnt).toBeGreaterThan(0);
      transport.limit = Infinity;
      handlers.drain!(transport.handle);
      expect(local.m_nSndCnt).toBe(0);
      expect(transport.bytes.slice(0, LOCAL_SERVER_IDENTIFICATION_SIZE)).toEqual(identification);
      expect(transport.bytes.length).toBe(LOCAL_SERVER_IDENTIFICATION_SIZE + 8);
    } finally { connectMock.mockRestore(); local.Close(); incoming.Close(); }
  });

  for (const failure of ["early-close", "identify-write-failed"] as const) {
    test(`${failure}: retry without leaking the old greeting or send suffix`, async () => {
      const first = new Transport(), second = new Transport();
      if (failure === "identify-write-failed") first.failure = "negative";
      let attempts = 0, closes = 0;
      const local = new CLocalSocket({ onClose: () => { closes++; } });
      const connectMock = spyOn(Bun, "connect").mockImplementation(((options: { socket: Bun.SocketHandler }) => {
        const transport = ++attempts === 1 ? first : second;
        if (attempts > 2) throw new Error("unexpected retry");
        options.socket.open!(transport.handle);
        if (attempts === 1 && failure === "early-close") {
          options.socket.data!(transport.handle, greeting.subarray(0, 1));
          options.socket.close!(transport.handle);
        } else options.socket.data!(transport.handle, greeting);
        return Promise.resolve(transport.handle);
      }) as typeof Bun.connect);
      try {
        await local.ConnectToCenter("fixture", 1, SVRCLASS_GAME, serverIndex);
        expect(attempts).toBe(2); expect(closes).toBe(0);
        expect(first.bytes).toEqual([]); expect(second.bytes).toEqual(identification);
        expect(first.ends).toBe(1); expect(local.m_nSndCnt).toBe(0);
        local.Close(); expect(closes).toBe(1);
      } finally { connectMock.mockRestore(); local.Close(); }
    });
  }

  test("drop while greeting retries; old close/data/drain cannot affect the next connection", async () => {
    let establishedCloses = 0;
    const local = new CLocalSocket({ onClose: () => { establishedCloses++; } });
    const first = new Transport(), second = new Transport();
    let attempts = 0;
    let old!: Bun.SocketHandler, current!: Bun.SocketHandler;
    const connectMock = spyOn(Bun, "connect").mockImplementation(((options: { socket: Bun.SocketHandler }) => {
      attempts++;
      if (attempts === 1) {
        old = options.socket;
        old.open!(first.handle);
        old.data!(first.handle, greeting.subarray(0, 2));
        // Let connect resolve first so the greeting waiter is armed.
        return Promise.resolve(first.handle);
      }
      if (attempts > 2) throw new Error("unexpected retry");
      current = options.socket;
      current.open!(second.handle);
      current.data!(second.handle, greeting);
      return Promise.resolve(second.handle);
    }) as typeof Bun.connect);
    try {
      const connecting = local.ConnectToCenter("fixture", 1, SVRCLASS_GAME, serverIndex);
      await Promise.resolve();
      old.close!(first.handle);
      await connecting;
      expect(attempts).toBe(2); expect(establishedCloses).toBe(0);
      second.limit = 0; local.SendBuffer(Uint8Array.of(55));
      const writes = second.writes;
      old.close!(first.handle); old.data!(first.handle, Buffer.from([99])); old.drain!(first.handle);
      expect(local.bunSocket).toBe(second.handle);
      expect(local.m_nRcvCnt).toBe(0); expect(pending(local)).toEqual([55]);
      expect(second.writes).toBe(writes);
      second.limit = Infinity; current.drain!(second.handle);
      expect(second.bytes).toEqual([...identification, 55]);
      current.close!(second.handle); current.close!(second.handle);
      expect(establishedCloses).toBe(1);
    } finally { connectMock.mockRestore(); local.Close(); }
  });
});

describe("billing TCP adapter (Tw codec has its own regression suite)", () => {
  test("hello drains then reconnects without stale-close interference", async () => {
    const previous = CBillingProcess.ms_pInstance;
    const billing = new CBillingProcess({} as CDBMan);
    billing.m_aBillingSvr = [{ SN: 1, ip: "fixture", port: 1 }];
    const transports: Transport[] = [], handlers: Bun.SocketHandler[] = [];
    const connectMock = spyOn(Bun, "connect").mockImplementation(((options: { socket: Bun.SocketHandler }) => {
      const transport = new Transport(); transport.limit = 0;
      transports.push(transport); handlers.push(options.socket);
      options.socket.open!(transport.handle);
      return Promise.resolve(transport.handle);
    }) as typeof Bun.connect);
    try {
      expect(await billing.ConnectToSvr()).toBe(1);
      const hello = pending(billing.m_pSocket!);
      expect(Buffer.from(hello).toString("hex")).toBe("0000000c000000070000014b0000000400000000");
      transports[0]!.limit = Infinity; handlers[0]!.drain!(transports[0]!.handle);
      expect(transports[0]!.bytes).toEqual(hello);
      billing.m_pSocket!.Close();
      expect(billing.m_fConnected).toBe(0); expect(billing.m_pSocket).toBeNull();
      expect(await billing.ConnectToSvr()).toBe(1);
      const current = billing.m_pSocket;
      handlers[0]!.close!(transports[0]!.handle);
      handlers[0]!.drain!(transports[0]!.handle);
      expect(billing.m_pSocket).toBe(current); expect(billing.m_fConnected).toBe(1);
    } finally { connectMock.mockRestore(); billing.m_pSocket?.Close(); CBillingProcess.ms_pInstance = previous; }
  });
});

test("real TCP backpressure: paused receiver, actual drain, byte-exact 32 MiB stream", async () => {
  const chunk = Uint8Array.from({ length: 64 * 1024 }, (_, i) => i % 251);
  const chunkCount = 512;
  const expected = createHash("sha256");
  for (let i = 0; i < chunkCount; i++) expected.update(chunk);
  const received = createHash("sha256");
  const blocked = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let total = 0, sentChunks = 0, drains = 0;
  let sender: TestSocket | undefined;
  const server = Bun.listen({
    hostname: "0.0.0.0", port: 0,
    socket: {
      open(t) {
        sender = new TestSocket(); sender.m_bConnected = true; sender.bunSocket = t;
        produce();
      },
      drain() { drains++; sender!.Flush(); produce(); },
      data() {},
      close() { sender?.Close(); },
      error(_t, error) { finished.reject(error); blocked.reject(error); },
    },
  });
  function produce(): void {
    while (sender!.m_nSndCnt === 0 && sentChunks < chunkCount) {
      sentChunks++;
      sender!.SendBuffer(chunk);
    }
    if (sender!.m_nSndCnt > 0) blocked.resolve();
    else if (sentChunks === chunkCount) sender!.Close();
  }
  const client = connect({ host: "127.0.0.1", port: server.port });
  client.pause();
  client.on("data", (bytes) => { total += bytes.length; received.update(bytes); });
  client.on("end", () => finished.resolve());
  client.on("error", (error) => { finished.reject(error); blocked.reject(error); });
  const timeout = setTimeout(() => {
    const error = new Error("TCP backpressure test timed out");
    blocked.reject(error); finished.reject(error);
  }, 8000);
  // Attach observers immediately: either socket can fail before the first await.
  void blocked.promise.catch(() => {}); void finished.promise.catch(() => {});
  try {
    await blocked.promise;
    expect(sender!.m_nSndCnt).toBeGreaterThan(0);
    expect(sender!.m_nSndCnt).toBeLessThanOrEqual(CPacketSocket.dwSndBufferSize);
    client.resume();
    await finished.promise;
    expect(drains).toBeGreaterThan(0);
    expect(total).toBe(chunk.length * chunkCount);
    expect(received.digest("hex")).toBe(expected.digest("hex"));
    expect(sender!.m_nSndCnt).toBe(0);
  } finally {
    clearTimeout(timeout); client.destroy(); sender?.Close(); server.stop(true);
  }
}, 10000);
