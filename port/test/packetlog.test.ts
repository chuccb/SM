/** PacketLog — env-gated packet tracing (CA_PACKET_LOG). */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { CPacketSocket } from "../src/core/CPacketSocket.ts";
import { timeGetTime } from "../src/core/timeGetTime.ts";
import { PacketLog } from "../src/core/PacketLog.ts";
import { UpdateCRC32, UpdateCRC8 } from "../src/core/CRC.ts";
import { CSendPacket, CipherDegree, enSocket } from "../src/core/Packet.ts";

/** minimal concrete socket — deg0, static header code, no rolling seq */
class LogTestSocket extends CPacketSocket {}

function makeSocket(tableKey: string | null = null, clientLink = true): LogTestSocket {
  const s = new LogTestSocket();
  s.m_bConnected = true;
  s.m_szLogTable = tableKey;
  s.m_fClientLink = clientLink;
  s.SetHeaderCode(102, 102, 0);
  s.SetSequence(0, 0, 0, 0);
  s.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8);
  return s;
}

/** move a's completed send frame through b's receive path */
function pump(from: CPacketSocket, to: CPacketSocket): void {
  const frame = from.m_mbSndBuffer.subarray(0, from.m_nSndCnt);
  from.m_nSndCnt = 0;
  to.OnReceive(frame);
}

describe("PacketLog", () => {
  const saved = {
    log: process.env.CA_PACKET_LOG,
    hex: process.env.CA_PACKET_LOG_HEX,
    scope: process.env.CA_PACKET_LOG_SCOPE,
  };

  afterEach(() => {
    if (saved.log === undefined) delete process.env.CA_PACKET_LOG;
    else process.env.CA_PACKET_LOG = saved.log;
    if (saved.hex === undefined) delete process.env.CA_PACKET_LOG_HEX;
    else process.env.CA_PACKET_LOG_HEX = saved.hex;
    if (saved.scope === undefined) delete process.env.CA_PACKET_LOG_SCOPE;
    else process.env.CA_PACKET_LOG_SCOPE = saved.scope;
    PacketLog.out = null;
  });

  test("off by default — a full send/recv roundtrip emits nothing", () => {
    delete process.env.CA_PACKET_LOG;
    const lines: string[] = [];
    PacketLog.out = (l) => lines.push(l);
    const a = makeSocket();
    const b = makeSocket();
    const p = new CSendPacket(9, CipherDegree.kPacketRaw);
    p.Encode1(0xab);
    a.PutPacket(p);
    pump(a, b);
    expect(lines).toEqual([]);
  });

  test("enabled — send and recv lines carry peer, direction, name, degree, hex", () => {
    process.env.CA_PACKET_LOG = "1";
    PacketLog.Register("T", "send", { OnBar: 9 });
    PacketLog.Register("T", "recv", { OnFoo: 9 });
    const lines: string[] = [];
    PacketLog.out = (l) => lines.push(l);
    PacketLog.Configure("T");
    const a = makeSocket("T");
    const b = makeSocket("T");
    const p = new CSendPacket(9, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(0xab);
    p.Encode4(0x11223344);
    expect(a.PutPacket(p)).toBe(enSocket.kioOk);
    pump(a, b);
    expect(lines.length).toBe(2);
    // send: payload = type byte + 1 + 4 = 6. The hex is the payload body
    // image — fields are still width-masked (Decode1/4 unmask at field-read
    // time), so both directions show 53 f1 (= 09 ^ 5a, ab ^ 5a) …
    expect(lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[T\] LogTestSocket -> OnBar\(9\) deg2 len=6 \| 53 f1 87 e8 60 d1$/);
    expect(lines[1]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[T\] LogTestSocket <- OnFoo\(9\) deg2 len=6 \| 53 f1 87 e8 60 d1$/);
  });

  test("unregistered ids fall back to p<N>", () => {
    process.env.CA_PACKET_LOG = "1";
    const lines: string[] = [];
    PacketLog.out = (l) => lines.push(l);
    PacketLog.Configure("Zzz");
    const a = makeSocket();
    a.PutPacket(new CSendPacket(77, CipherDegree.kPacketRaw));
    expect(lines[0]).toContain("p77(77) deg0");
  });

  test("CA_PACKET_LOG_HEX caps the dump", () => {
    process.env.CA_PACKET_LOG = "1";
    process.env.CA_PACKET_LOG_HEX = "4";
    const lines: string[] = [];
    PacketLog.out = (l) => lines.push(l);
    const a = makeSocket();
    const p = new CSendPacket(5, CipherDegree.kPacketRaw);
    for (let i = 0; i < 20; i++) p.Encode1(i);
    a.PutPacket(p);
    expect(lines[0]).toContain("len=21");
    expect(lines[0]).toContain("…(+17B)");
  });

  test("Datagram logs raw UDP both ways", () => {
    process.env.CA_PACKET_LOG = "1";
    const lines: string[] = [];
    PacketLog.out = (l) => lines.push(l);
    PacketLog.Configure("LS");
    PacketLog.Datagram("recv", Uint8Array.of(0, 0, 0, 0, 7));
    PacketLog.Datagram("send", Uint8Array.of(2));
    expect(lines[0]).toMatch(/\[LS\] udp <- len=5 \| 00 00 00 00 07$/);
    expect(lines[1]).toMatch(/\[LS\] udp -> len=1 \| 02$/);
  });

  test("default scope traces client links and silences infra links", () => {
    process.env.CA_PACKET_LOG = "1";
    delete process.env.CA_PACKET_LOG_SCOPE;
    const lines: string[] = [];
    PacketLog.out = (l) => lines.push(l);
    PacketLog.Configure("LS");
    const client = makeSocket();
    client.PutPacket(new CSendPacket(3, CipherDegree.kPacketRaw));
    expect(lines.length).toBe(1);
    const infra = makeSocket(null, false);
    infra.PutPacket(new CSendPacket(3, CipherDegree.kPacketRaw));
    expect(lines.length).toBe(1); // unchanged: the infra link stays silent
  });

  test("CA_PACKET_LOG_SCOPE=all traces infra links too", () => {
    process.env.CA_PACKET_LOG = "1";
    process.env.CA_PACKET_LOG_SCOPE = "all";
    const lines: string[] = [];
    PacketLog.out = (l) => lines.push(l);
    PacketLog.Configure("LS");
    makeSocket(null, false).PutPacket(new CSendPacket(3, CipherDegree.kPacketRaw));
    expect(lines.length).toBe(1);
  });

  test("a path value appends lines to the file", () => {
    const path = "test/tmp-packetlog/pkt.log";
    rmSync("test/tmp-packetlog", { recursive: true, force: true });
    process.env.CA_PACKET_LOG = path;
    PacketLog.Configure("LS");
    PacketLog.Datagram("send", Uint8Array.of(2, 2, 0x24));
    const text = await_file(path);
    expect(text).toContain("[LS] udp -> len=3 | 02 02 24");
    rmSync("test/tmp-packetlog", { recursive: true, force: true });
  });
});

/** CCRC32/CCRC8 check vectors — FxServer.exe.c GenCRCTable/UpdateCRC (58017). */
describe("CCRC32/CCRC8 check vectors", () => {
  const v = new TextEncoder().encode("123456789");
  test("CCRC32 is the MSB-first poly 0x04C11DB7 family", () => {
    // init 0xFFFFFFFF lands on the published CRC-32/MPEG-2 check value
    expect(UpdateCRC32(0xffffffff, v, 0, v.length)).toBe(0x0376e6e7);
    // init 0 — the form CGameMapTmpl::LoadMap (+88) feeds packet 109's compare
    expect(UpdateCRC32(0, v, 0, v.length)).toBe(0x89a1897f);
  });
  test("CCRC8 is poly 0x07 (CRC-8 check value)", () => {
    expect(UpdateCRC8(0, v)).toBe(0xf4);
  });
});

/** sync read helper (appendFileSync is synchronous, so the file is complete) */
import { readFileSync } from "node:fs";
function await_file(path: string): string {
  return readFileSync(path, "utf8");
}

describe("receive-flood guard", () => {
  test("the 50-stamp ring closes only when a full ring lands inside 0x3E8 ms", () => {
    const s = new LogTestSocket();
    s.m_bConnected = true;
    s.m_fReceiveFloodGuard = true;
    let closed = 0;
    s.hooks.onClose = () => closed++;
    const stamps = s.m_adwRcvStamp;
    // Arm with an explicitly stale slot 0. Relying on its zero-initial value
    // made this fixture depend on the Bun process already being >1 s old.
    stamps[0] = (timeGetTime() - 5000) >>> 0;
    for (let i = 0; i < 0x31; i++) (s as any).CheckReceiveFlood();
    expect(s.m_bConnected).toBe(true);
    expect(closed).toBe(0);
    // spread the ring beyond the window: the 50th receipt stays quiet
    stamps.fill(timeGetTime() - 5000);
    (s as any).CheckReceiveFlood();
    expect(s.m_bConnected).toBe(true);
    // a full ring inside one second: report + close
    stamps.fill(timeGetTime());
    (s as any).CheckReceiveFlood();
    expect(s.m_bConnected).toBe(false);
    expect(closed).toBe(1);
  });

  test("the official strings: client links report, FXUS stays silent, infra names its link", () => {
    class QuietSocket extends CPacketSocket {}
    const quiet = new QuietSocket();
    quiet.m_bConnected = true;
    // ReportReceiveOverflow is a silent no-op by default (the FXUS build)
    expect((quiet as any).ReportReceiveOverflow()).toBeUndefined();
  });
});
