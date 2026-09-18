/**
 * CxRelay e2e — the MTUDP forwarder over a real socket pair (Relay_000.cfg
 * topology, ephemeral port).  Builds the exact wire frames the original
 * clients send and checks the relay's observable behaviour: host
 * registration, the 9-byte addressing strip, the per-datagram miss on an
 * unknown target, multi-frame datagrams, and re-homing on address change.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateCRC8 } from "../src/gameserver/MTUDP.ts";
import { main as relayMain, MTUDPServer } from "../src/relay/Relay.ts";

/** The client-side MTUDP frame: [totalLen][E4 srcSn][E4 dstSn][body][crc8]. */
function BuildClientFrame(srcSn: number, dstSn: number, body: string | Uint8Array): Uint8Array {
  const payload = typeof body === "string" ? Buffer.from(body, "latin1") : body;
  const totalLen = 9 + payload.byteLength;
  const buf = new Uint8Array(totalLen + 1);
  const dv = new DataView(buf.buffer);
  buf[0] = totalLen;
  dv.setUint32(1, srcSn, false);
  dv.setUint32(5, dstSn, false);
  buf.set(payload, 9);
  buf[totalLen] = UpdateCRC8(0, buf, totalLen);
  return buf;
}

/** The relay-side forward frame: [totalLen][body][crc8]. */
function BuildServerFrame(body: Uint8Array): Uint8Array {
  const buf = new Uint8Array(body.byteLength + 2);
  buf[0] = body.byteLength + 1;
  buf.set(body, 1);
  buf[buf.byteLength - 1] = UpdateCRC8(0, buf, buf.byteLength - 1);
  return buf;
}

const SN_A = 0x11111111;
const SN_B = 0x22222222;

describe("game relay (CxRelay)", () => {
  test("registers hosts, strips the addressing prefix, forwards both ways", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    const cfgFile = join(dir, "relay.cfg");
    writeFileSync(cfgFile, `ServerName\t= RelayTest\nServerIP\t= 127.0.0.1\nServerPort \t= 0\n`, "latin1");

    await relayMain(cfgFile);
    const server = MTUDPServer.ms_pInstance!;
    const relayPort = server.m_wPort;
    expect(relayPort).toBeGreaterThan(0);

    const inboxA: Uint8Array[] = [];
    const inboxB: Uint8Array[] = [];
    const a = await Bun.udpSocket({
      hostname: "127.0.0.1",
      socket: { data(_s, d) { inboxA.push(new Uint8Array(d as Buffer)); } },
    });
    const b = await Bun.udpSocket({
      hostname: "127.0.0.1",
      socket: { data(_s, d) { inboxB.push(new Uint8Array(d as Buffer)); } },
    });

    // 1) A → unknown target: A is registered, nothing is forwarded
    a.send(BuildClientFrame(SN_A, SN_B, "hello"), relayPort, "127.0.0.1");
    await Bun.sleep(60);
    expect(server.m_mapHost.get(SN_A)!.port).toBe(a.port);
    expect(server.m_mapHost.get(SN_A)!.recv).toBe(1);
    expect(server.m_mapHost.get(SN_A)!.miss).toBe(1);
    expect(inboxB.length).toBe(0);

    // 2) B → A: B is registered and "ping" reaches A without the sn header
    // (the send counter sits on the TARGET host)
    b.send(BuildClientFrame(SN_B, SN_A, "ping"), relayPort, "127.0.0.1");
    await Bun.sleep(60);
    expect(server.m_mapHost.get(SN_B)!.port).toBe(b.port);
    expect(server.m_mapHost.get(SN_B)!.recv).toBe(1);
    expect(server.m_mapHost.get(SN_A)!.send).toBe(1);
    expect(inboxA.length).toBe(1);
    expect(Buffer.from(inboxA[0]!)).toEqual(Buffer.from(BuildServerFrame(Buffer.from("ping", "latin1"))));

    // 3) two frames in one datagram — forwarded as two datagrams
    const f1 = BuildClientFrame(SN_A, SN_B, "aaaa");
    const two = new Uint8Array(2 * f1.byteLength);
    two.set(f1, 0);
    two.set(BuildClientFrame(SN_A, SN_B, "bbbb"), f1.byteLength);
    a.send(two, relayPort, "127.0.0.1");
    await Bun.sleep(60);
    expect(server.m_mapHost.get(SN_B)!.send).toBe(2);
    expect(server.m_mapHost.get(SN_A)!.recv).toBe(3); // hello + both forwarded frames
    expect(inboxB.length).toBe(2);
    expect(Buffer.from(inboxB[0]!)).toEqual(Buffer.from(BuildServerFrame(Buffer.from("aaaa", "latin1"))));
    expect(Buffer.from(inboxB[1]!)).toEqual(Buffer.from(BuildServerFrame(Buffer.from("bbbb", "latin1"))));

    // 4) a corrupt frame discards the remainder of the datagram
    const bad = BuildClientFrame(SN_A, SN_B, "cc");
    bad[bad.byteLength - 1] ^= 0xff;
    a.send(bad, relayPort, "127.0.0.1");
    await Bun.sleep(60);
    expect(inboxB.length).toBe(2);

    // 5) A moves to a new socket — the relay re-homes the sn
    const inboxA2: Uint8Array[] = [];
    const a2 = await Bun.udpSocket({
      hostname: "127.0.0.1",
      socket: { data(_s, d) { inboxA2.push(new Uint8Array(d as Buffer)); } },
    });
    a2.send(BuildClientFrame(SN_A, SN_B, "moved"), relayPort, "127.0.0.1");
    await Bun.sleep(60);
    expect(server.m_mapHost.get(SN_A)!.port).toBe(a2.port);
    expect(server.m_mapHost.get(SN_A)!.recv).toBe(1); // HostCreate rebuilt the record
    expect(inboxB.length).toBe(3);
    expect(Buffer.from(inboxB[2]!)).toEqual(Buffer.from(BuildServerFrame(Buffer.from("moved", "latin1"))));

    a.close();
    a2.close();
    b.close();
  }, 8000);
});
