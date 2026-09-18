/**
 * End-to-end exercise of the ported core: center ↔ LS attach, client login,
 * account creation, channel lists — against the real code paths.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { CServerConfig } from "../src/core/Config.ts";
import { CxCenter } from "../src/center/Center.ts";
import { main as loginMain } from "../src/login/Login.ts";
import { main as gameMain } from "../src/gameserver/GameServer.ts";
import { SimpleStreamEncrypt3, SimpleStreamDecrypt3 } from "../src/core/StreamCipher.ts";
import { mkdirSync, rmSync } from "node:fs";
import { inflateSync } from "node:zlib";

const DIR = import.meta.dir;
const DB_DIR = DIR + "/tmp-db";

/** A minimal game client implementing the CClientSocket wire protocol. */
class TestClient {
  private sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  private rcvBuf = new Uint8Array(0);
  private k = 5; // header type (the client-side counter % 16)
  private fTypeSet = false;
  private sndSeq = 3;
  private rcvSeq = 3; // the client-link sequence starts at 3 and rolls by 40
  private waiters: ((p: { id: number; n: CReceived }) => void)[] = [];

  async connect(port: number): Promise<void> {
    this.sock = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data: (_t, data) => this.onData(new Uint8Array(data as Buffer)),
      },
    });
  }

  private onData(data: Uint8Array): void {
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
        if (code !== expected) throw new Error(`checkcode mismatch: ${code} != ${expected}`);
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
      const w = this.waiters.shift();
      if (w) w({ id, n: { buf: payload, off: 1 } });
      else this.pending.push({ id, n: { buf: payload, off: 1 } });
    }
    this.rcvBuf = all.slice(off);
  }

  private pending: { id: number; n: CReceived }[] = [];

  send(id: number, body: (e: Encoder) => void): void {
    const e: Encoder = { b: [], u16: (v) => e.b.push((v >> 8) & 0xff, v & 0xff), u32be: (v) => e.b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff), str: (s) => { e.u16(s.length); for (const ch of Buffer.from(s, "latin1")) e.b.push(ch); } };
    body(e);
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
    this.sock!.write(out);
  }

  async recv(wantId: number, timeoutMs = 4000): Promise<CReceived> {
    const idx = this.pending.findIndex((p) => p.id === wantId);
    if (idx >= 0) return this.pending.splice(idx, 1)[0]!.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for packet ${wantId}`)), timeoutMs);
      this.waiters.push((p) => {
        clearTimeout(timer);
        if (p.id !== wantId) {
          this.pending.push(p);
          return;
        }
        resolve(p.n);
      });
    });
  }
}

interface CReceived {
  buf: Uint8Array;
  off: number;
}
function r1(n: CReceived) {
  return n.buf[n.off++]!;
}
function r2(n: CReceived) {
  const v = (n.buf[n.off]! << 8) | n.buf[n.off + 1]!;
  n.off += 2;
  return v;
}
function r4(n: CReceived) {
  const v = ((n.buf[n.off]! << 24) | (n.buf[n.off + 1]! << 16) | (n.buf[n.off + 2]! << 8) | n.buf[n.off + 3]!) >>> 0;
  n.off += 4;
  return v;
}
function rstr(n: CReceived) {
  const len = r2(n);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(n.buf[n.off++]!);
  return s;
}
function rencstr(n: CReceived, key: number) {
  const len = r2(n);
  const raw = n.buf.slice(n.off, n.off + len);
  n.off += len;
  const dec = new Uint8Array(len);
  SimpleStreamDecrypt3(raw, 0, dec, 0, len, key);
  let s = "";
  for (const ch of dec) s += String.fromCharCode(ch);
  return s;
}

interface Encoder {
  b: number[];
  u16: (v: number) => void;
  u32be: (v: number) => void;
  str: (s: string) => void;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// gsConvertTable mirror (encode/decode per the first received checkcode-derived type)
import { gsConvertTableEncode, gsConvertTableDecode } from "../src/core/PacketHeaderConverter.ts";
const gsEncode = (k: number, id: number) => gsConvertTableEncode[k & 0xf]![id & 0xff]!;
const gsDecode = (k: number, t: number) => gsConvertTableDecode[k & 0xf]![t & 0xff]!;

let center: CxCenter;

let loginSN = 0;

beforeAll(async () => {
  rmSync(DB_DIR, { recursive: true, force: true });
  mkdirSync(DB_DIR, { recursive: true });
  const cfg = new CServerConfig();
  cfg.Init(DIR + "/center.cfg");
  CServerConfig.ms_pInstance = cfg;
  center = new CxCenter(cfg);
  center.InitServerTable();
  await center.Listen();
  center.StartTimer();
  await loginMain(DIR + "/login.cfg", DB_DIR);
  await Bun.sleep(300); // let the LS attach
  // The production flow attaches game servers right after the login server;
  // their attach re-broadcasts the channel info with the now-derived header
  // type (the first burst after the LS attach converts through the identity
  // row on the center side and is dropped by the LS, exactly like the
  // original).
});

afterAll(() => {
  if (!process.env.KEEP_DB) rmSync(DB_DIR, { recursive: true, force: true });
});

describe("center link", () => {
  test("LS attached and received channel info", () => {
    expect(center.GetSvr(1, 0)?.socket).not.toBeNull();
    expect(center.GetSvr(1, 0)!.socket!.fGreeted).toBe(true);
  });
});

describe("login flow", () => {
  const client = new TestClient();

  test("AskMultiServer returns the full variant first", async () => {
    await client.connect(13838);
    client.send(1, (e) => {
      e.u32be(0);
      e.u32be(0);
    });
    const p = await client.recv(1);
    expect(r1(p)).toBe(1); // full-update flag
    const info = rOS(p); // SmartStream
    // info stream (little-endian fields): E1 mCount(0), E2 lCount(0), E1 current
    let o = 0;
    expect(info[o++]!).toBe(0); // mCount
    const l = info[o++]! | (info[o++]! << 8);
    expect(l).toBe(0);
    expect(info[o++]!).toBe(0); // current
    const flag = r1(p);
    expect(flag).toBe(1); // notice follows
    const notice = rOS(p);
    expect(notice.length).toBe(1); // E1 0
  });

  test("AskFirstInfo returns the nexonclub URLs", async () => {
    client.send(2, (e) => {
      e.u32be(0);
    });
    const p = await client.recv(2);
    expect(rstr(p)).toBe("http://mail.nexonclub.com/clubadmin/confirmuser");
    expect(rstr(p)).toBe("http://id.nexonclub.com/nxidquery.idsocno");
  });

  test("NewUserConfirmId on absent account", async () => {
    client.send(4, (e) => {
      e.str("tester01");
    });
    const p = await client.recv(4);
    expect(r1(p)).toBe(0); // count(*) = 0 → id free
  });

  test("NewUser creates the account", async () => {
    client.send(5, (e) => {
      e.str("tester01"); // s1 = ID
      e.str("tester01"); // s2 = Password (stored as EncodePassword(s2))
      e.str("q"); // s3 PasswordQ
      e.str("a"); // s4 PasswordA
      e.str("123456-1234567"); // s5 IdentityNo (SSN1-SSN2)
      e.str("900101"); // s6 Birthday
      e.str("tester01"); // s7 Name
      e.str("tester01@mail.nexonclub.com"); // s8 Email
      e.u16be ? null : null;
      e.b.push(1); // EmailRcv
      e.b.push(1); // Gender
      e.str("Taipei"); // Address
      e.str("02-12345678"); // Tel
      e.str("profile"); // Profile (13th)
      e.b.push(0); // Reveal
    });
    const p = await client.recv(5);
    expect(r1(p)).toBe(0); // 0 = created
  });

  test("Login with the created account", async () => {
    client.send(3, (e) => {
      e.b.push(1); // user count
      // EncodeEncryptedStr(id, 0x11223344)
      encStrInto(e, "tester01", 0x11223344);
      encStrInto(e, "tester01", 0x44332211); // password = s2 per RegisterNewUser
      e.u32be(0); // m_nDeleteUserSN (none yet)
    });
    const p = await client.recv(3);
    expect(r1(p)).toBe(0); // result ok
    expect(r2(p)).toBe(1); // fAllSimpleInfo
    rstr(p); // strDes (empty: no double login)
    expect(r1(p)).toBe(1); // user count
    const sn = r4(p);
    expect(sn).toBeGreaterThan(0);
    loginSN = sn;
    expect(rstr(p)).toBe("tester01");
    expect(r1(p)).toBe(0); // UA+76
    expect(r2(p)).toBe(0);
    expect(r1(p)).toBe(1);
    expect(r1(p)).toBe(10);
    const level = r2(p);
    expect(level).toBe(1); // exp 0 → level 1
    expect(r4(p)).toBe(0); // money
    expect(r4(p)).toBe(0); // guild sn
    expect(r1(p)).toBe(0);
    expect(rstr(p)).toBe("tester01@mail.nexonclub.com");
    // The login flow never loads SSN1/SSN2 (only prGetUserInfo does), so the
    // official server answers 2,2 ("unknown") for both flags here.
    const adult = r1(p);
    const gender = r1(p);
    expect(adult).toBe(2);
    expect(gender).toBe(2);
    expect(r4(p)).toBe(0); // authencode
    rstr(p); // trailing empty dst
    // Production timing: game servers attach after the first login flushes
    // p0 to the center (which derives the shared conversion row); the attach
    // re-broadcast then populates the LS channel cache.  The real game server
    // (FXGS, game0.cfg) takes the fake's place: same identification bytes
    // (class 10, idx 0, game version 7, client version 3).
    await gameMain(DIR + "/game0.cfg", DB_DIR);
    await Bun.sleep(400);
  });

  test("double login is rejected with packet 3 code 2", async () => {
    const client2 = new TestClient();
    await client2.connect(13838);
    client2.send(3, (e) => {
      e.b.push(1);
      encStrInto(e, "tester01", 0x11223344);
      encStrInto(e, "tester01", 0x44332211);
      e.u32be(0);
    });
    const p = await client2.recv(3);
    expect(r1(p)).toBe(2); // fAllAdded == 0 → single byte 2
    client2.send(60, (e) => {
      e.u32be(0);
    });
  });

  test("RequestEnterChannelStage returns the cached channel packets", async () => {
    // the game-server attach re-broadcast landed in the pending queue; drop
    // the stale copies before asking for a fresh set
    client.pending.length = 0;
    // hash 0 → mismatch → full info variant
    client.send(9, (e) => {
      e.u32be(0);
    });
    const p10 = await client.recv(10);
    expect(r1(p10)).toBe(1);
    const os = rOS(p10);
    let o = 0;
    const n = os[o++]! | (os[o++]! << 8);
    expect(n).toBe(5); // five channels from the cfg
    for (let i = 0; i < n; i++) {
      const len = os[o++]! | (os[o++]! << 8) | (os[o++]! << 16) | (os[o++]! << 24);
      o += len;
      o += 2 + 2 + 1 + 1 + 2 + 1; // chNo, levelLimit, type, attr, community, enterable
    }
    expect(o).toBe(os.length);
    const p13 = await client.recv(13);
    const cnt = r2(p13);
    expect(cnt).toBe(5);
    expect(r2(p13)).toBe(0); // channel 0: the fake GS attached, 0 users
    for (let i = 1; i < cnt; i++) expect(r2(p13)).toBe(65535); // -1: no GS yet
    const p14 = await client.recv(14);
    expect(r1(p14)).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(r1(p14)).toBe(10); // svr class
      expect(r1(p14)).toBe(1); // alive
      expect(r2(p14)).toBe(7); // game version (v7 from the fake GS handshake)
    }
    const p11 = await client.recv(11);
    expect(rstr(p11)).toBe(""); // no advertisement rows
    expect(r2(p11)).toBe(0); // adv p2
    expect(r2(p11)).toBe(0); // adv p3
    expect(r2(p11)).toBe(60);
    expect(r1(p11)).toBe(0); // guild list empty
    expect(r1(p11)).toBe(1); // NDA count (min(1,2))
    expect(r4(p11)).toBe(inet_addr("127.0.0.1"));
    expect(r1(p11)).toBe(1); // relay count
    expect(r4(p11)).toBe(inet_addr("127.0.0.1"));
    expect(r2(p11)).toBe(0); // community servers
    expect(r2(p11)).toBe(0); // *(WORD*)(this+47600)
    expect(r1(p11)).toBe(1); // JUM count
    expect(r4(p11)).toBe(inet_addr("127.0.0.1"));
    expect(r2(p11)).toBe(17360);
  });

  test("ReqConnectToSvr validates and returns the game server address", async () => {
    // p6: [E1 svrType][E4 svrIdx][E2 version] — version 7 matches the fake GS
    client.send(6, (e) => {
      e.b.push(10);
      e.u32be(0);
      e.b.push(0, 7);
    });
    const p = await client.recv(6);
    expect(r1(p)).toBe(1); // CheckEnterGame ok
    expect(r1(p)).toBe(10); // svr type
    expect(r4(p)).toBe(0); // svr idx
    expect(r4(p)).toBe(inet_addr("127.0.0.1")); // ip
    expect(r2(p)).toBe(14848); // port (FXGSPort0)
    // version mismatch path
    client.send(6, (e) => {
      e.b.push(10);
      e.u32be(0);
      e.b.push(0, 8);
    });
    const p2 = await client.recv(6);
    expect(r1(p2)).toBe(4); // version mismatch
    // wrong type path
    client.send(6, (e) => {
      e.b.push(99);
      e.u32be(0);
      e.b.push(0, 7);
    });
    const p3 = await client.recv(6);
    expect(r1(p3)).toBe(5); // not enterable
  });

  test("RequestDestoryService echoes the header type and disconnects nothing", async () => {
    client.send(60, (e) => {
      e.u32be(5); // the client's own header type
    });
    const p = await client.recv(60);
    expect(r4(p)).toBeGreaterThan(0); // local serial
    const grc = r4(p);
    expect(grc).toBeLessThanOrEqual(3); // rand() & 3
  });

  test("EstimateRTT echoes", async () => {
    client.send(20, (e) => {
      e.u32be(0x1234);
    });
    const p = await client.recv(20);
    expect(r4(p)).toBe(0x1234);
    expect(r4(p)).toBeGreaterThan(0);
  });
});

describe("game server entry flow (FXGS)", () => {
  const gs = new TestClient();

  test("connect pushes packet 0 [E2 3][E2 7][E4 headerType]", async () => {
    await gs.connect(14848);
    const p0 = await gs.recv(0);
    expect(r2(p0)).toBe(3); // the center protocol version
    expect(r2(p0)).toBe(7);
    const k = r4(p0);
    expect(k).toBe(0); // the GS's assigned conversion row (first client socket)
  });

  test("ConnEstablished (7) performs the DB entry and answers 210/202/201", async () => {
    gs.send(7, (e) => {
      e.b.push(1); // one user
      e.str("tester01");
      e.u32be(loginSN); // the global serial from the login response
      e.u32be(0); // guild SN
      e.u32be(0x11221122); // x
      e.u32be(0); // y — x^y = the known client hash
      e.b.push(1); // z
    });
    // 210 [E1 attr] — attr = the center's FXAttrShop flag (0 here)
    const p210 = await gs.recv(210);
    expect(r1(p210)).toBe(0);
    // 202 — the whole FxItem table (empty in the test DB)
    const p202 = await gs.recv(202);
    expect(r2(p202)).toBe(0);
    // 201 [E1 n][per-user inventory] — no rows: an empty inventory
    const p201 = await gs.recv(201);
    expect(r1(p201)).toBe(1);
    expect(r2(p201)).toBe(0);
    // the lobby announce + the rank list (packet 15 empty, then 70):
    // the entry leaves the socket at the lobby stage
    const p15 = await gs.recv(15);
    expect(p15.buf.length - p15.off).toBe(0); // empty packet
    const p70 = await gs.recv(70);
    expect(r2(p70)).toBe(0); // page 0
    expect(r1(p70)).toBe(1); // the joiner is already in the rank list
    expect(rstr(p70)).toBe("tester01");
    r1(p70); // gender
    expect(r4(p70)).toBe(1); // look level
    expect(r4(p70)).toBe(0); // premium svr idx
    expect(r4(p70)).toBe(0); // guild sn
    expect(r2(p70)).toBe(0); // guild mark
  });

  test("EnterChannelStage (16) leaves the lobby for the channel stage", async () => {
    await Bun.sleep(1200); // let the center's 0.8 s state broadcast land
    gs.send(16, (e) => {});
    const p13 = await gs.recv(13);
    const cnt = r2(p13);
    expect(cnt).toBe(5);
    expect(r2(p13)).toBe(1); // channel 0 = this game server, 1 user
    for (let i = 1; i < cnt; i++) expect(r2(p13)).toBe(65535);
    const p14 = await gs.recv(14);
    if (process.env.P14_DEBUG) console.error("p14:", Array.from(p14.buf).map((b) => b.toString(16)).join(" "), "off", p14.off);
    expect(r1(p14)).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(r1(p14)).toBe(10); // svr class
      expect(r1(p14)).toBe(1); // alive
      expect(r2(p14)).toBe(7); // game version
      expect(r2(p14)).toBe(3); // client version
    }
  });

  test("ReqChannelsState (15) re-delivers 13+14 on the channel stage", async () => {
    gs.send(15, (e) => {});
    const p13 = await gs.recv(13);
    expect(r2(p13)).toBe(5);
    expect(r2(p13)).toBe(1); // the user still shows on channel 0
    const p14 = await gs.recv(14);
    expect(r1(p14)).toBe(5);
  });

  test("RequestUserInfoDetail (67) answers from the local user table", async () => {
    gs.send(67, (e) => {
      e.str("tester01");
    });
    const p = await gs.recv(71);
    expect(r1(p)).toBe(1); // found
    expect(rstr(p)).toBe("tester01"); // the login id
    expect(rstr(p)).toBe("tester01"); // the account name
    expect(rstr(p)).toBe(""); // no guild
    r1(p); // gender
    expect(r4(p)).toBe(0); // win
    expect(r4(p)).toBe(0); // draw
    expect(r4(p)).toBe(0); // lose
    expect(r4(p)).toBe(0); // exp
    expect(r4(p)).toBe(0x7fffffff); // max exp at the top level
    expect(r2(p)).toBe(1); // level 1
    expect(r4(p)).toBe(0); // money
    expect(r1(p)).toBe(10);
    expect(r4(p)).toBe(0); // ServerIndex
    expect(r2(p)).toBe(65535); // session idx (-1)
    expect(r1(p)).toBe(0); // reveal
    expect(r4(p)).toBe(0); // premium svr idx
    r1(p); // community svr
    expect(r2(p)).toBe(0); // no decorations
    expect(r2(p)).toBe(0); // (slot tail)
    expect(r2(p)).toBe(0); // category-3 items: none
  });

  test("EnterLobbyStage (83) returns to the lobby and creates a room (80)", async () => {
    // from the channel stage back to the lobby
    gs.send(83, (e) => {});
    await gs.recv(15);
    gs.send(80, (e) => {
      e.str("my room"); // title
      e.str(""); // password
      e.b.push(0); // game type
      e.b.push(1); // one player
      e.b.push(0); // select
    });
    const p = await gs.recv(80);
    expect(r1(p)).toBe(0); // created
    expect(r2(p)).toBe(0); // room idx 0
    const serial = r4(p);
    expect(serial).toBeGreaterThan(0);
    expect(r1(p)).toBe(0); // game type
    // the room list the leaver asked for on the way out (PutAllSessionInfo)
    // leaves with the room destroyed (the only member left)
    gs.send(83, (e) => {});
    await gs.recv(15);
  });

  test("EstimateRTT (20) echoes with the anti-cheat hash", async () => {
    gs.send(20, (e) => {
      e.u32be(0x1234);
      e.u32be(0x11221122);
    });
    const p = await gs.recv(20);
    expect(r4(p)).toBe(0x1234);
    expect(r4(p)).toBeGreaterThan(0);
  });
});

/** SmartStream on the wire: [0x18][innerLen LE32][inner: 0x00 raw | 0x01 zlib] */
function rOS(n: CReceived): Uint8Array {
  const magic = r1(n);
  if (magic !== 0x18) throw new Error(`bad smartstream magic ${magic}`);
  const innerLen = n.buf[n.off]! | (n.buf[n.off + 1]! << 8) | (n.buf[n.off + 2]! << 16) | (n.buf[n.off + 3]! << 24);
  n.off += 4;
  const inner = n.buf.slice(n.off, n.off + innerLen);
  n.off += innerLen;
  if (inner[0] === 1) return inflateSync(inner.slice(5)); // [1][rawSize LE32][deflate]
  if (inner[0] !== 0) throw new Error(`bad smart stream form ${inner[0]}`);
  return inner.slice(1);
}

function inet_addr(ip: string): number {
  const p = ip.split(".").map((x) => Number.parseInt(x, 10));
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

/** EncodeEncryptedStr: [u16 len][SimpleStreamEncrypt3(bytes, key)] */
function encStrInto(e: Encoder, s: string, key: number): void {
  const raw = Buffer.from(s, "latin1");
  e.u16(raw.length);
  const dst = new Uint8Array(raw.length);
  SimpleStreamEncrypt3(new Uint8Array(raw), 0, dst, 0, raw.length, key);
  for (const ch of dst) e.b.push(ch);
}
