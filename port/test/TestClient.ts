/**
 * The shared test-side client — a minimal CClientSocket wire-protocol peer
 * (check-code + BE length framing, gsConvertTable type mapping).
 */
import { SimpleStreamDecrypt3, SimpleStreamEncrypt3 } from "../src/core/StreamCipher.ts";
import { UpdateCRC8 } from "../src/core/CRC.ts";
import { gsConvertTableEncode, gsConvertTableDecode } from "../src/core/PacketHeaderConverter.ts";

/** A minimal game client implementing the CClientSocket wire protocol. */
export class TestClient {
  name = "?";
  private sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  private rcvBuf = new Uint8Array(0);
  k = 5; // header type — adopted from the accept packet 0's E4 field
  private fClosed = false;

  get closed(): boolean {
    return this.fClosed;
  }
  private fTypeSet = false;
  private sndSeq = 3;
  private rcvSeq = 3; // the client-link sequence starts at 3 and rolls by 40
  private waiters: { wantId: number; resolve: (n: CReceived) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  /**
   * Cipher degrees of the link AFTER the accept packet 0 (the hello is always
   * CSendPacket(0, 0) — plain — on every server).  The framing is
   * [code][(len^a569)][SimpleStreamEncrypt3(seq)][crc8].
   *  - the shop (FXSS) and the login server (FXLS) arm CClientSocket
   *    SetCipherDegree(2) on accept → both directions are cipher 2;
   *  - the game server (FXGS) leaves the socket at 0 (client frames plain)
   *    but builds every client-bound packet with the degree-2 CSendPacket
   *    ctor → plain out, cipher 2 in.
   */
  sndDeg = 0;
  rcvDeg = 0;
  private fHelloDone = false;
  /** CClientSocket::Read — every server sends the accept packet 0 on accept;
   *  the client adopts the header type from its E4 field before sending. */
  private hello: Promise<void> = Promise.resolve();
  private helloResolve: (() => void) | null = null;
  private helloSeen = false;

  async connect(port: number, opts?: { sndDeg?: 0 | 2; rcvDeg?: 0 | 2 }): Promise<void> {
    this.sndDeg = opts?.sndDeg ?? 0;
    this.rcvDeg = opts?.rcvDeg ?? 0;
    this.hello = new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      setTimeout(() => reject(new Error("timeout waiting for the accept packet 0")), 4000);
    });
    this.sock = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data: (_t, data) => this.onData(new Uint8Array(data as Buffer)),
        close: () => {
          this.fClosed = true;
          for (const w of this.waiters.splice(0)) w.reject(new Error("socket closed by peer"));
        },
        error: (_t, err) => {
          this.fClosed = true;
          for (const w of this.waiters.splice(0)) w.reject(new Error(`socket error: ${err}`));
        },
      },
    });
    // bun: a write issued right after the accept packet 0 can sit in the
    // socket's send path until the next write() — turn Nagle off and yield a
    // timer tick so the first real send always flushes.
    (this.sock as any).setNoDelay?.(true);
    await this.hello;
    await Bun.sleep(1);
  }

  /** A plain client-side disconnect (the server sees OnClose). */
  close(): void {
    this.sock?.end();
    this.sock = null;
  }

  private onData(data: Uint8Array): void {
    if (this.rcvDeg === 2 && this.fHelloDone) return this.onData2(data);
    const all = concat(this.rcvBuf, data);
    let off = 0;
    for (;;) {
      if (all.length - off < 3) break;
      const code = all[off]!;
      // server → client frames roll on the server's SND base (102); the
      // client's own frames use its SND base (192) — CClientSocket ctor.
      if (!this.fTypeSet) {
        this.k = (code ^ ((102 + this.rcvSeq) & 0xff)) - 231;
        if (this.k < 0) this.k += 256;
        this.fTypeSet = true;
      } else {
        const expected = ((this.k + 231) ^ ((102 + this.rcvSeq) & 0xff)) & 0xff;
        if (code !== expected) {
        console.error(`[TC] cipher2 code mismatch got=${code} exp=${expected} k=${this.k} rcvSeq=${this.rcvSeq} head=${Array.from(all.slice(off, off + 12)).map((x) => x.toString(16).padStart(2, "0")).join(" ")}`);
        throw new Error(`checkcode mismatch: ${code} != ${expected}`);
      }
      }
      const lenField = (all[off + 1]! << 8) | all[off + 2]!;
      const len = lenField + 3; // the field is the payload count; +3 = the frame total
      if (all.length - off < len) break;
      const payload = all.slice(off + 3, off + len);
      // gsConvertTableDecode on the packet-type byte (d=0, seq ≠ 0)
      const t = payload[0]!;
      const id = gsDecode(this.k, t);
      // payload of d=0 carries no cipher
      this.rcvSeq = (this.rcvSeq + 40) & 0xffffffff;
      off += len;
      if (!this.helloSeen) {
        // the first server frame must be the accept packet 0 (CSendPacket(0,0)
        // — plain on every server); its E4 field carries the server's header
        // type — adopt it (CClientSocket::Read).
        if (id !== 0) throw new Error(`expected the accept packet 0 first, got ${id}`);
        const kFromHello = payload[8]! & 0xff; // the E4 is big-endian: [00 00 00 k]
        if (kFromHello !== (this.k & 0xff)) {
          throw new Error(`hello header type ${kFromHello} != code-derived ${this.k & 0xff}`);
        }
        this.helloSeen = true;
        this.helloResolve?.();
        this.helloResolve = null;
        // the hello is always a plain (degree-0) packet — CSendPacket(0, 0)
        this.dispatch(id, payload, 1, 0);
      } else {
        this.dispatch(id, payload, 1, this.rcvDeg);
      }
      // cipher-2 links: the hello was plain; the following frames switch to
      // the cipher-2 parser.
      if (this.rcvDeg === 2) this.fHelloDone = true;
    }
    this.rcvBuf = all.slice(off);
  }

  private pending: { id: number; n: CReceived }[] = [];

  private dispatch(id: number, payload: Uint8Array, off: number, deg = 0): void {
    const item = { id, n: { buf: payload, off, deg } as CReceived };
    const wi = this.waiters.findIndex((w) => w.wantId === id);
    if (wi >= 0) {
      const w = this.waiters.splice(wi, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(item.n);
    } else {
      this.pending.push(item);
    }
  }

  /** the cipher-2 receive path — mirrors CReceivedPacketBase::DecodePacket's
   *  degree-2 branch (SimpleStream key = the rolling seq, type ^ 0x5a).
   *  Only reached after the plain accept packet 0 (fHelloDone). */
  private onData2(data: Uint8Array): void {
    const all = concat(this.rcvBuf, data);
    let off = 0;
    for (;;) {
      if (all.length - off < 4) break;
      const code = all[off]!;
      const expected = (((this.k + 231) & 0xff) ^ ((102 + this.rcvSeq) & 0xff)) & 0xff;
      if (code !== expected) {
        console.error(`[TC] cipher2 code mismatch got=${code} exp=${expected} k=${this.k} rcvSeq=${this.rcvSeq} head=${Array.from(all.slice(off, off + 12)).map((x) => x.toString(16).padStart(2, "0")).join(" ")}`);
        throw new Error(`checkcode mismatch: ${code} != ${expected}`);
      }
      const lenField = (all[off + 1]! << 8) | all[off + 2]!;
      const payloadLen = (lenField ^ 0xa569) & 0xffff;
      const len = payloadLen + 4;
      if (all.length - off < len) break;
      const payload = new Uint8Array(payloadLen);
      SimpleStreamDecrypt3(all, off + 3, payload, 0, payloadLen, this.rcvSeq);
      const crc = UpdateCRC8(this.rcvSeq & 0xff, payload, 0, payloadLen);
      if (crc !== all[off + len - 1]!) throw new Error(`crc8 mismatch: ${crc} != ${all[off + len - 1]}`);
      const id = payload[0]! ^ 0x5a;
      this.rcvSeq = (this.rcvSeq + 40) & 0xffffffff;
      off += len;
      this.dispatch(id, payload, 1, 2);
    }
    this.rcvBuf = all.slice(off);
  }

  /** the cipher-2 send path — CSendPacketBase::EncodePacket's degree-2 branch. */
  private send2(id: number, payloadBytes: number[]): void {
    const payload = new Uint8Array(payloadBytes.length + 1);
    payload[0] = id ^ 0x5a;
    payload.set(payloadBytes, 1);
    const total = payload.length + 4;
    const out = new Uint8Array(total);
    out[0] = (((this.k + 231) & 0xff) ^ ((192 + this.sndSeq) & 0xff)) & 0xff;
    const lenField = (payload.length ^ 0xa569) & 0xffff;
    out[1] = (lenField >> 8) & 0xff;
    out[2] = lenField & 0xff;
    SimpleStreamEncrypt3(payload, 0, out, 3, payload.length, this.sndSeq);
    out[total - 1] = UpdateCRC8(this.sndSeq & 0xff, payload, 0, payload.length);
    this.sndSeq = (this.sndSeq + 40) & 0xffffffff;
    if (process.env.TC_DEBUG) console.error(`[TCDBG] client send2 id=${id} total=${total} code=${out[0]!.toString(16)} k=${this.k} sndSeq=${this.sndSeq}`);
    let wn = -1;
    try {
      wn = this.sock!.write(out);
    } catch (e) {
      console.error(`[TCDBG] client write THREW`, e);
    }
    if (process.env.TC_DEBUG) console.error(`[TCDBG] client write returned ${wn}`);
  }

  send(id: number, body: (e: Encoder) => void): void {
    // CSendPacket's field primitives mask every field by its width when the
    // packet's cipher degree is ≥ 1 (CBufferManipulator::Encrypt1/2/4); the
    // string BYTES stay raw and only the length is masked.
    const enc = this.sndDeg === 2;
    const e: Encoder = {
      b: [],
      u8: (...vs) => {
        for (const v of vs) e.b.push(enc ? (v ^ 0x5a) & 0xff : v & 0xff);
      },
      u16: (v) => {
        const m = enc ? (v ^ 0xa569) & 0xffff : v & 0xffff;
        e.b.push((m >> 8) & 0xff, m & 0xff);
      },
      u32be: (v) => {
        const m = enc ? (v ^ 0x96ca5395) >>> 0 : v >>> 0;
        e.b.push((m >>> 24) & 0xff, (m >>> 16) & 0xff, (m >>> 8) & 0xff, m & 0xff);
      },
      str: (s) => {
        e.u16(s.length);
        for (const ch of Buffer.from(s, "latin1")) e.b.push(ch);
      },
    };
    body(e);
    if (this.sndDeg === 2) {
      this.send2(id, e.b);
      return;
    }
    const typeByte = gsEncode(this.k, id);
    const payload = [typeByte, ...e.b];
    const total = payload.length + 3;
    const code = ((this.k + 231) ^ ((192 + this.sndSeq) & 0xff)) & 0xff;
    this.sndSeq = (this.sndSeq + 40) & 0xffffffff;
    const out = new Uint8Array(total);
    out[0] = code;
    out[1] = (payload.length >> 8) & 0xff; // length field = the payload count
    out[2] = payload.length & 0xff;
    out.set(payload, 3);
    if (process.env.TC_DEBUG) console.error(`[TCDBG] client plain-send id=${id} total=${total}`);
    this.sock!.write(out);
  }

  async recv(wantId: number, timeoutMs = 4000): Promise<CReceived> {
    if (this.fClosed) throw new Error("socket closed by peer");
    const idx = this.pending.findIndex((p) => p.id === wantId);
    if (idx >= 0) return this.pending.splice(idx, 1)[0]!.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const wi = this.waiters.findIndex((w) => w.wantId === wantId);
        if (wi >= 0) this.waiters.splice(wi, 1);
        reject(new Error(`timeout waiting for packet ${wantId}`));
      }, timeoutMs);
      this.waiters.push({ wantId, resolve: (n) => resolve(n), timer });
    });
  }
}

export interface CReceived {
  buf: Uint8Array;
  off: number;
  /** the packet's cipher degree — field reads unmask when >= 1. */
  deg: number;
}
export function r1(n: CReceived) {
  const v = n.buf[n.off++]!;
  return n.deg >= 1 ? (v ^ 0x5a) & 0xff : v;
}
export function r2(n: CReceived) {
  const v = ((n.buf[n.off]! << 8) | n.buf[n.off + 1]!) & 0xffff;
  n.off += 2;
  return n.deg >= 1 ? (v ^ 0xa569) & 0xffff : v;
}
export function r4(n: CReceived) {
  const v = ((n.buf[n.off]! << 24) | (n.buf[n.off + 1]! << 16) | (n.buf[n.off + 2]! << 8) | n.buf[n.off + 3]!) >>> 0;
  n.off += 4;
  return n.deg >= 1 ? (v ^ 0x96ca5395) >>> 0 : v;
}
export function r8le(n: CReceived) {
  // an 8-byte value encoded as two E4s (lo, hi) — each masked under cipher
  const lo = r4(n);
  const hi = r4(n);
  return ((hi * 0x100000000) + lo) / 1;
}
export function rbuf(n: CReceived, len: number): Uint8Array {
  // EncodeBuffer bytes are raw on the wire at every cipher degree.
  const out = n.buf.slice(n.off, n.off + len);
  n.off += len;
  return out;
}
export function rstr(n: CReceived) {
  const len = r2(n);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(n.buf[n.off++]!);
  return s;
}
export function rencstr(n: CReceived, key: number) {
  const len = r2(n);
  const raw = n.buf.slice(n.off, n.off + len);
  n.off += len;
  const dec = new Uint8Array(len);
  SimpleStreamDecrypt3(raw, 0, dec, 0, len, key);
  let s = "";
  for (const ch of dec) s += String.fromCharCode(ch);
  return s;
}

export interface Encoder {
  b: number[];
  u8: (...vs: number[]) => void;
  u16: (v: number) => void;
  u32be: (v: number) => void;
  str: (s: string) => void;
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// gsConvertTable mirror (encode/decode per the first received checkcode-derived type)

// gsConvertTable mirror (encode/decode per the first received checkcode-derived type)
export const gsEncode = (k: number, id: number) => gsConvertTableEncode[k & 0xf]![id & 0xff]!;
export const gsDecode = (k: number, t: number) => gsConvertTableDecode[k & 0xf]![t & 0xff]!;
