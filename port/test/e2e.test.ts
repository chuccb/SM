/**
 * End-to-end exercise of the ported core: center ↔ LS attach, client login,
 * account creation, channel lists — against the real code paths.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { CServerConfig } from "../src/core/Config.ts";
import { CxCenter } from "../src/center/Center.ts";
import { main as loginMain } from "../src/login/Login.ts";
import { CRC32, main as gameMain } from "../src/gameserver/GameServer.ts";
import { SimpleStreamEncrypt3, SimpleStreamDecrypt3 } from "../src/core/StreamCipher.ts";
import { mkdirSync, rmSync } from "node:fs";
import { inflateSync } from "node:zlib";

const DIR = import.meta.dir;
const DB_DIR = DIR + "/tmp-db";
const DATA_DIR = DIR + "/data";

/**
 * The IDF data package (FxServer.idd/.idx — the files the original loads
 * through CFastFile/CIDFMan).  One bomber + one 8-player map is enough to
 * exercise the room stage end to end.  The layout mirrors the production
 * directory: FxServer.idd/.idx sit next to the .cfg.
 */
function writeGameDataPackage(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  // Attr/BomberAttr: [u32 len]["test"][attr1][attr2][attr3][attr4][speed]
  //                  [attr6][bombCount][attr8][bombPower][attr10]
  const bomber = Buffer.alloc(4 + 4 + 10 * 4);
  let o = 0;
  o = bomber.writeUInt32LE(4, o);
  o += bomber.write("test", o, "latin1");
  o = bomber.writeUInt32LE(0, o); // attr1 (0 = a normal, selectable entry)
  o = bomber.writeUInt32LE(1, o); // attr2
  o = bomber.writeUInt32LE(1, o); // attr3
  o = bomber.writeUInt32LE(1, o); // attr4
  o = bomber.writeUInt32LE(5, o); // def speed (clamped at 10)
  o = bomber.writeUInt32LE(0, o); // attr6
  o = bomber.writeUInt32LE(1, o); // def bomb count
  o = bomber.writeUInt32LE(0, o); // attr8
  o = bomber.writeUInt32LE(1, o); // def bomb power
  o = bomber.writeUInt32LE(0, o); // attr10
  // Attr/ItemAttr: the 8-byte header + an empty id→item map section.
  const itemAttr = Buffer.alloc(12);
  itemAttr.writeUInt32LE(0, 8); // mapCount
  // Map/room1: version 1000 + the 17 template dwords (maxTeam 8,
  // maxPlayer 8, no level/premium gate)
  const map = Buffer.alloc(18 * 4);
  map.writeUInt32LE(1000, 0); // version
  map.writeUInt32LE(8, 4); // max team (+32)
  map.writeUInt32LE(0, 8);
  map.writeUInt32LE(0, 12);
  map.writeUInt32LE(0, 16);
  map.writeUInt32LE(8, 20); // max player (+48)
  map.writeUInt32LE(0, 24); // level limit (+52)
  map.writeUInt32LE(0, 28); // premium only (+56)
  map.writeUInt32LE(0, 32); // +60
  map.writeUInt32LE(0, 36); // +64
  map.writeUInt32LE(0, 40); // +68
  map.writeUInt32LE(1000, 44); // +72
  map.writeUInt32LE(2000, 48); // +76
  map.writeUInt32LE(0, 52); // +108 (mission type)
  map.writeUInt32LE(0, 56); // +112
  map.writeUInt32LE(0, 60); // +116
  map.writeUInt32LE(0, 64); // +120
  map.writeUInt32LE(0, 68); // +84
  // the package: FxServer.idx = [u32 count]{[u32 nameLen][name][u32 off][u32 len]}
  const entries = [
    { name: "Attr/BomberAttr", data: bomber },
    { name: "Attr/ItemAttr", data: itemAttr },
    { name: "Map/room1", data: map },
  ];
  const idxParts: Buffer[] = [Buffer.alloc(4)];
  idxParts[0]!.writeUInt32LE(entries.length, 0);
  const iddParts: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const head = Buffer.alloc(12 + e.name.length);
    head.writeUInt32LE(e.name.length, 0);
    head.write(e.name, 4, "latin1");
    head.writeUInt32LE(offset, 4 + e.name.length);
    head.writeUInt32LE(e.data.length, 8 + e.name.length);
    idxParts.push(head);
    iddParts.push(Buffer.from(e.data));
    offset += e.data.length;
  }
  testMapCrc = CRC32(0, new Uint8Array(map), map.byteLength) >>> 0;
  require("node:fs").writeFileSync(DATA_DIR + "/FxServer.idx", Buffer.concat(idxParts));
  require("node:fs").writeFileSync(DATA_DIR + "/FxServer.idd", Buffer.concat(iddParts));
  // the game server cfg — the package base is dirname(cfg) + "/FxServer"
  require("node:fs").copyFileSync(DIR + "/game0.cfg", DATA_DIR + "/game.cfg");
}

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

  /** A plain client-side disconnect (the server sees OnClose). */
  close(): void {
    this.sock?.end();
    this.sock = null;
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
import { BuildFrame } from "../src/gameserver/MTUDP.ts";
const gsEncode = (k: number, id: number) => gsConvertTableEncode[k & 0xf]![id & 0xff]!;
const gsDecode = (k: number, t: number) => gsConvertTableDecode[k & 0xf]![t & 0xff]!;

let center: CxCenter;

let loginSN = 0;

beforeAll(async () => {
  rmSync(DB_DIR, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DB_DIR, { recursive: true });
  writeGameDataPackage();
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
    await gameMain(DATA_DIR + "/game.cfg", DB_DIR);
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

let entryGsClient: TestClient | null = null;

describe("game server entry flow (FXGS)", () => {
  entryGsClient = new TestClient();
  const gs = entryGsClient;

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


// ==================== room flow (CGameSession 96..116) ====================

/** Register + log in through the LS, then walk the full GS entry path. */
async function enterGame(name: string): Promise<{ ls: TestClient; gs: TestClient; sn: number }> {
  const ls = new TestClient();
  await ls.connect(13838);
  ls.pending.length = 0;
  ls.send(5, (e) => {
    e.str(name); // s1 = ID
    e.str(name); // s2 = Password
    e.str("q");
    e.str("a");
    e.str("123456-1234567");
    e.str("900101");
    e.str(name);
    e.str(name + "@mail.nexonclub.com");
    e.b.push(1); // EmailRcv
    e.b.push(1); // Gender
    e.str("Taipei");
    e.str("02-12345678");
    e.str("profile");
    e.b.push(0); // Reveal
  });
  const created = await ls.recv(5);
  expect(r1(created)).toBe(0);
  ls.send(3, (e) => {
    e.b.push(1);
    encStrInto(e, name, 0x11223344);
    encStrInto(e, name, 0x44332211);
    e.u32be(0);
  });
  const p3 = await ls.recv(3);
  expect(r1(p3)).toBe(0);
  expect(r2(p3)).toBe(1);
  rstr(p3);
  expect(r1(p3)).toBe(1);
  const sn = r4(p3);
  ls.send(6, (e) => {
    e.b.push(10);
    e.u32be(0);
    e.b.push(0, 7);
  });
  const p6 = await ls.recv(6);
  expect(r1(p6)).toBe(1); // result
  expect(r1(p6)).toBe(10); // svr type
  r4(p6); // svr idx
  r4(p6); // ip
  expect(r2(p6)).toBe(14848);
  const gs = new TestClient();
  await gs.connect(14848);
  await gs.recv(0);
  gs.send(7, (e) => {
    e.b.push(1);
    e.str(name);
    e.u32be(sn);
    e.u32be(0); // guild
    e.u32be(0x11221122);
    e.u32be(0);
    e.b.push(1);
  });
  await gs.recv(210);
  await gs.recv(202);
  await gs.recv(201);
  await gs.recv(15);
  await gs.recv(70);
  return { ls, gs, sn };
}

let roomChief: TestClient | null = null;
let roomMember: TestClient | null = null;
let roomLobby: TestClient | null = null; // tester02, parked in the lobby
let roomSerial = 0; // the room's +148 serial (the UDP check echoes it)
let roomMemberSN = 0; // tester03's global serial
let testMapCrc = 0; // the CRC32 the GS computed over the test map blob

describe("game server room flow (FXGS)", () => {
  test("tester02 walks the entry path and sees the empty room list (83)", async () => {
    const { gs } = await enterGame("tester02");
    roomLobby = gs;
    gs.send(83, (e) => {});
    await gs.recv(15);
    // no rooms: PutAllSessionInfo's loop writes no 83 packet at all
    await Bun.sleep(150);
    expect(gs.pending.find((p) => p.id === 83)).toBeUndefined();
    gs.send(20, (e) => {
      e.u32be(0x1234);
      e.u32be(0x11221122);
    });
    await gs.recv(20);
  });

  test("create (80): res + the creator's 105s/107s/112, and the timer's 85", async () => {
    // reuse the still-connected tester01 socket from the entry-flow describe
    const chief = entryGsClient!;
    roomChief = chief;
    chief.send(80, (e) => {
      e.str("e2e room"); // title
      e.str(""); // password
      e.b.push(0); // game type
      e.b.push(1); // one player
      e.b.push(0); // bomber select (valid with the test BomberAttr)
    });
    const res = await chief.recv(80);
    expect(r1(res)).toBe(0);
    expect(r2(res)).toBe(0); // room idx 0
    const serial = r4(res);
    expect(serial).toBeGreaterThan(0);
    roomSerial = serial;
    // SendSessionInfoPacket: 105 (slot 0, self), 107 for the 7 empty slots, 112
    const p105 = await chief.recv(105);
    expect(r1(p105)).toBe(0); // slot 0
    expect(r4(p105)).toBeGreaterThan(0); // the user's global serial
    expect(r1(p105)).toBe(1); // self
    expect(r1(p105)).toBe(0); // community
    expect(r1(p105)).toBe(255); // no category-4 deco → 255
    const state = [r1(p105), r1(p105), r1(p105)];
    expect(state[0]).toBe(0x02); // chief bit, nothing closed/ready
    expect(state[1]).toBe(0); // bomber 0 (the select came through)
    expect(state[2]).toBe(0); // color 0 (first player, slot%8)
    expect(rstr(p105)).toBe("tester01"); // AppendSimpleInfoPacket
    r1(p105); // gender
    expect(r4(p105)).toBe(1); // look level
    expect(r4(p105)).toBe(0); // premium svr idx
    expect(r4(p105)).toBe(0); // guild sn
    expect(r2(p105)).toBe(0); // guild mark revision
    expect(r1(p105)).toBe(0); // slot accessory: no slot decos
    expect(r1(p105)).toBe(0); // no char decos
    expect(r4(p105)).toBe(0); // no category-14 item
    for (let i = 0; i < 7; i++) {
      const p107 = await chief.recv(107);
      expect(r1(p107)).toBe(i + 1); // slot
      expect(p107.buf.length - p107.off).toBe(3); // the raw 3-byte state
    }
    const p112 = await chief.recv(112);
    expect(r2(p112)).toBe(0xffff); // m_nMapIdx = -1
    // the 400 ms timer turns the table's created-flag into an 85 for the lobby
    const p85 = await roomLobby!.recv(85, 3000);
    expect(r2(p85)).toBe(0);
    expect(r4(p85)).toBe(serial);
    expect(rstr(p85)).toBe("e2e room");
    expect(r1(p85)).toBe(0); // no password
    expect(r1(p85)).toBe(0); // game type
    expect(r1(p85)).toBe(1); // cur
    expect(r1(p85)).toBe(8); // max
  });

  test("join (81): the joiner gets the room 105s + 112 + game type", async () => {
    const { gs, sn } = await enterGame("tester03");
    gs.send(83, (e) => {});
    await gs.recv(15);
    const p83 = await gs.recv(83);
    expect(r2(p83)).toBe(0); // room 0
    const serial = r4(p83);
    expect(rstr(p83)).toBe("e2e room");
    expect(r1(p83)).toBe(0); // hasPW
    expect(r1(p83)).toBe(0); // gameType
    expect(r1(p83)).toBe(0); // playing
    expect(r2(p83)).toBe(0xffff); // mapIdx
    expect(r1(p83)).toBe(1); // cur
    expect(r1(p83)).toBe(8); // max
    gs.send(81, (e) => {
      e.u16(0); // idx  (u16 big endian? the packet body uses Encode2 = BE)
      e.u32be(serial);
      e.str("");
      e.b.push(1);
      e.b.push(1); // select: the random bomber idx (== total count)
    });
    const res = await gs.recv(81);
    expect(r1(res)).toBe(0); // joined
    roomMember = gs;
    roomMemberSN = sn;
    // SendSessionInfoPacket — slot 0 (the chief, not self)
    const p105a = await gs.recv(105);
    expect(r1(p105a)).toBe(0); // slot
    r4(p105a); // serial
    expect(r1(p105a)).toBe(0); // not self
    // slot 1 (self)
    const p105b = await gs.recv(105);
    expect(r1(p105b)).toBe(1); // slot
    r4(p105b); // serial
    expect(r1(p105b)).toBe(1); // self
    r1(p105b); // community
    r1(p105b); // the category-4 deco (255)
    const state = [r1(p105b), r1(p105b), r1(p105b)];
    expect(state[0]).toBe(0); // member: no chief bit, not ready
    expect(state[2]).toBe(1); // color 1 (second slot%8)
    // the empty slots ride along as 107s
    for (let i = 0; i < 6; i++) {
      const p107 = await gs.recv(107);
      expect(r1(p107)).toBe(i + 2);
    }
    const p112 = await gs.recv(112);
    expect(r2(p112)).toBe(0xffff);
    // SendJoinPacket — the self 105 again
    const p105c = await gs.recv(105);
    expect(r1(p105c)).toBe(1); // slot
    r4(p105c); // serial
    expect(r1(p105c)).toBe(1); // self
    // SendGameType — normal (93)
    await gs.recv(93);
    // the chief also received the join's 105/107/112 broadcast; drop it
    roomChief!.pending.length = 0;
  });

  test("ready (96) from the member → 107 with the ready bit", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    member.send(96, (e) => {
      e.b.push(1);
    });
    const p107 = await member.recv(107);
    expect(r1(p107)).toBe(1); // the member's slot
    const state = [r1(p107), r1(p107), r1(p107)];
    expect(state[0]).toBe(0x04); // the ready bit only (members hold no crown)
    // …the chief's socket sees the same broadcast
    const p107b = await chief.recv(107);
    expect(r1(p107b)).toBe(1);
    expect(r1(p107b)).toBe(0x04);
  });

  test("select map (97) broadcasts 112 and re-issues the slot states", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    chief.send(97, (e) => {
      e.u16(0); // map 0
    });
    const p112 = await chief.recv(112);
    expect(r2(p112)).toBe(0); // the chosen map
    // case 8: every seated slot's state is re-sent (colors unchanged)
    for (let i = 0; i < 2; i++) {
      const p107 = await chief.recv(107);
      expect(r1(p107)).toBe(i);
    }
    const p112b = await member.recv(112);
    expect(r2(p112b)).toBe(0);
  });

  test("select color (98) → 108, select bomber (99) → 109", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    // the high nibble is the socket-local user index (0: one-user socket)
    member.send(98, (e) => {
      e.b.push(3); // user 0 of the socket, color 3
    });
    const p108 = await chief.recv(108);
    expect(r1(p108)).toBe((1 << 4) | 3); // the reply names the slot
    member.send(99, (e) => {
      e.b.push(0); // bomber 0 (a normal index)
    });
    const p109 = await chief.recv(109);
    expect(r1(p109)).toBe((1 << 4) | 0);
  });

  test("open/close slot (100): chief only, 110 both ways", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    chief.send(100, (e) => {
      e.b.push((7 << 4) | 1); // close slot 7
    });
    const p110 = await chief.recv(110);
    expect(r1(p110)).toBe((7 << 4) | 1);
    chief.send(100, (e) => {
      e.b.push((7 << 4) | 0); // reopen
    });
    const p110b = await chief.recv(110);
    expect(r1(p110b)).toBe((7 << 4) | 0);
    void member;
  });

  test("set game type mod (103) → 92", async () => {
    const chief = roomChief!;
    chief.send(103, (e) => {});
    await chief.recv(92);
    await roomMember!.recv(92);
    chief.send(102, (e) => {});
    await chief.recv(93);
  });

  test("change title (107) → 117 to everyone", async () => {
    const chief = roomChief!;
    chief.send(107, (e) => {
      e.str("renamed room");
    });
    const p117 = await chief.recv(117);
    expect(rstr(p117)).toBe("renamed room");
    const p117b = await roomMember!.recv(117);
    expect(rstr(p117b)).toBe("renamed room");
  });

  test("play emotion (108) → 118 to the others only", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    chief.send(108, (e) => {
      e.b.push(0); // own slot
      e.b.push(1);
      e.b.push(2);
      e.u16(3);
    });
    const p118 = await member.recv(118);
    expect(r1(p118)).toBe(0);
    expect(r1(p118)).toBe(1);
    expect(r1(p118)).toBe(2);
    expect(r2(p118)).toBe(3);
  });

  test("team chat (111) reaches the same-color member as 27", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    // pull the member back to color 0 so both share a team
    member.send(98, (e) => {
      e.b.push(0); // user 0 of the socket, color 0
    });
    await chief.recv(108);
    member.send(111, (e) => {
      e.str("go go");
    });
    const p27 = await chief.recv(27);
    expect(rstr(p27)).toBe("tester03 : go go");
  });

  test("start game (106) → 115 (can) + 116 (launch) with both slots", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    // split the colors again — CanStartGame wants at least two teams
    member.send(98, (e) => {
      e.b.push(1); // color 1
    });
    await chief.recv(108);
    chief.send(106, (e) => {});
    const p115 = await chief.recv(115);
    expect(r1(p115)).toBe(0); // CanStartGame = go
    const p116 = await chief.recv(116);
    r4(p116); // tick
    expect(r4(p116)).toBe(0); // m_nGameMapIdx = 0 (the test map)
    expect(r1(p116)).toBe(2); // GetPlayerNo() (+832) — the current player count
    // slot 0 — the chief
    expect(r1(p116)).toBe(0); // slot
    expect(r1(p116)).toBe(0); // captain (normal game)
    const spawn0 = r1(p116);
    expect(spawn0).toBeLessThan(8);
    r1(p116); // bomber (0, not re-rolled)
    expect(r1(p116)).toBe(0); // color 0
    // slot 1 — the member
    expect(r1(p116)).toBe(1);
    expect(r1(p116)).toBe(0);
    const spawn1 = r1(p116);
    expect(spawn1).toBeLessThan(8);
    r1(p116); // bomber (re-rolled from the random pick)
    expect(r1(p116)).toBe(1); // color 1 — the fold only writes back when maxTeam < 8
    // the member gets the same launch packet (no 115)
    const p116b = await member.recv(116);
    expect(r4(p116b)).toBeGreaterThan(0);
  });

  test("the MTUDP launch handshake: type 1 (mapCRC+attrs) then type 11 (peer info) → 150 + 120", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    chief.pending.length = 0;
    member.pending.length = 0;
    const udp = await Bun.udpSocket({});
    const sendCheck = async (gserial: number, type: number): Promise<void> => {
      // the type-1 body: [type][E4 gserial][E2 idx][E4 serial][2×(E4 ip][E2 port)]
      //                  [E4 x][E4 mapCRC][bomber][bc][bp][speed]
      const payload = new Uint8Array(type === 1 ? 35 : 23);
      const dv = new DataView(payload.buffer);
      const be32 = (at: number, v: number): void => dv.setUint32(at, v >>> 0, false);
      const be16 = (at: number, v: number): void => dv.setUint16(at, v & 0xffff, false);
      payload[0] = type;
      be32(1, gserial);
      be16(5, 0); // session idx
      be32(7, roomSerial);
      be32(11, 0x7f000001); // 127.0.0.1 (network order)
      be16(15, 40001);
      be32(17, 0x7f000001);
      be16(21, 40002);
      if (type === 1) {
        be32(23, 0); // the dword the session ignores
        be32(27, testMapCrc);
        payload[31] = 0; // bomber
        payload[32] = 1; // bomb count
        payload[33] = 1; // bomb power
        payload[34] = 5; // speed
      }
      await udp.send(BuildFrame(payload), 14849, "127.0.0.1");
    };
    await sendCheck(loginSN, 1);
    await sendCheck(roomMemberSN, 1);
    await Bun.sleep(120);
    await sendCheck(loginSN, 11);
    const p120a = await chief.recv(120);
    await sendCheck(roomMemberSN, 11);
    const p120b = await chief.recv(120);
    // each alive-with-a-player slot reads [E1 1][3×(E4 ip][E2 port)][E4 joinTime].
    // host[0] is the OBSERVED source address (the ephemeral send port);
    // hosts[1..2] are the self-reported 40001/40002.  The writer's gate is
    // the slot's player, so the first broadcast still announces slot 1 —
    // with the zero hosts its handshake has not merged yet.
    const readSlot = (p: CReceived, merged: boolean): void => {
      expect(r1(p)).toBe(1); // alive
      if (!merged) {
        expect(r4(p)).toBe(0);
        expect(r2(p)).toBe(0);
        expect(r4(p)).toBe(0);
        expect(r2(p)).toBe(0);
        expect(r4(p)).toBe(0);
        expect(r2(p)).toBe(0);
      } else {
        expect(r4(p)).toBe(0x7f000001); // observed ip
        expect(r2(p)).toBeGreaterThan(0); // observed port (ephemeral)
        expect(r4(p)).toBe(0x7f000001);
        expect(r2(p)).toBe(40001);
        expect(r4(p)).toBe(0x7f000001);
        expect(r2(p)).toBe(40002);
      }
      expect(r4(p)).toBeGreaterThan(0); // the AddUser join time
    };
    readSlot(p120a, true); // slot 0 — merged by tester01's type 11
    readSlot(p120a, false); // slot 1 — announced, hosts not yet merged
    readSlot(p120b, true); // slot 0
    readSlot(p120b, true); // slot 1 — merged by tester03's type 11
    // the second type 11 completed the handshake → DeferStartGame fires the 150
    const p150c = await chief.recv(150);
    await Bun.sleep(300);
    const p150m = member.pending.find((q) => q.id === 150)!.n;
    member.pending.splice(member.pending.findIndex((q) => q.id === 150), 1);
    for (const p150 of [p150c, p150m]) {
      expect(r4(p150)).toBe(0); // the +12736 seed dword (never written)
      const seq = r4(p150);
      expect(seq).toBeGreaterThan(0); // serial ^ version
      expect(r4(p150)).toBe(0); // ghostStart (tmpl+60) × 1000
      expect(r4(p150)).toBe(0); // ghostFreq (tmpl+64) × 1000
    }
    udp.close();
  });

  test("the member leaving drops a 106 and hands the chief crown over", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    member.close();
    await Bun.sleep(100);
    const p106 = await chief.recv(106);
    expect(r1(p106)).toBe(1); // the member's slot
    expect(r4(p106)).toBeGreaterThan(0); // the member's serial
    // SetNewChief(-1) has no one left to crown — no 107s
    // drop tester02's stale lobby broadcasts so the 87 below is the destroy
    roomLobby!.pending.length = 0;
    // the chief leaving destroys the room; the lobby learns via the timer 87
    chief.close();
    const lobby = await enterGame("tester04");
    lobby.gs.send(83, (e) => {});
    await lobby.gs.recv(15);
    // no rooms left: PutAllSessionInfo's loop writes no 83 packet at all
    await Bun.sleep(150);
    expect(lobby.gs.pending.find((p) => p.id === 83)).toBeUndefined();
    // the destroyed-room flag turns into an 87 on the next timer tick,
    // fanned out to the lobby-stage sockets (CChatPool::SendAll(a2, 1))
    const p87 = await roomLobby!.recv(87, 3000);
    expect(r2(p87)).toBe(0);
    expect(r4(p87)).toBeGreaterThan(0);
  });
});


