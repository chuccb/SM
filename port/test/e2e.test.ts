/**
 * End-to-end exercise of the ported core: center ↔ LS attach, client login,
 * account creation, channel lists — against the real code paths.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { CServerConfig } from "../src/core/Config.ts";
import { CxCenter } from "../src/center/Center.ts";
import { main as loginMain } from "../src/login/Login.ts";
import { inet_addr } from "../src/login/MultiServer.ts";
import { CClientSocket, CBomberAttr, main as gameMain } from "../src/gameserver/GameServer.ts";
import { UpdateCRC32 } from "../src/core/CRC.ts";
import { CLocalSocket } from "../src/lib/CenterLink.ts";
import { SVRCLASS_UTIL, MC_ReceivedPacket } from "../src/lib/S2S.ts";
import { CSendPacket, CipherDegree } from "../src/core/Packet.ts";
import { CA_CONFIG_SEED_IP } from "../src/db/CAConfigBak.ts";
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
  // Attr/BomberAttr: [u32 len]["test"] + the ten payload dwords (+256..+292)
  // in record order: nAttr1 (hidden flag), nCurrentSpeed, nAttr3, nBombCount,
  // nAttr5Clamped (the load-time <=10 clamp), nBombPower, nAttr7..nAttr10.
  const bomber = Buffer.alloc(4 + 4 + 10 * 4);
  let o = 0;
  o = bomber.writeUInt32LE(4, o);
  o += bomber.write("test", o, "latin1");
  o = bomber.writeUInt32LE(0, o); // nAttr1 (0 = a normal, selectable entry)
  o = bomber.writeUInt32LE(1, o); // nCurrentSpeed
  o = bomber.writeUInt32LE(1, o); // nAttr3
  o = bomber.writeUInt32LE(1, o); // nBombCount
  o = bomber.writeUInt32LE(5, o); // nAttr5Clamped (the <=10 clamp target)
  o = bomber.writeUInt32LE(0, o); // nBombPower
  o = bomber.writeUInt32LE(1, o); // nAttr7
  o = bomber.writeUInt32LE(0, o); // nAttr8
  o = bomber.writeUInt32LE(1, o); // nAttr9
  o = bomber.writeUInt32LE(0, o); // nAttr10
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
  testMapCrc = UpdateCRC32(0, new Uint8Array(map), 0, map.byteLength) >>> 0;
  require("node:fs").writeFileSync(DATA_DIR + "/FxServer.idx", Buffer.concat(idxParts));
  require("node:fs").writeFileSync(DATA_DIR + "/FxServer.idd", Buffer.concat(iddParts));
  // the game server cfg — the package base is dirname(cfg) + "/FxServer"
  require("node:fs").copyFileSync(DIR + "/game0.cfg", DATA_DIR + "/game.cfg");
}
import {
  TestClient,
  r1,
  r2,
  r4,
  rstr,
  rbuf,
  rencstr,
  concat,
  gsEncode,
  gsDecode,
  type CReceived,
  type Encoder,
} from "./TestClient.ts";
import { BuildFrame } from "../src/gameserver/MTUDP.ts";
import { UpdateCRC8 } from "../src/gameserver/MTUDP.ts";

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
    await client.connect(13838, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
    client.send(1, (e) => {
      e.u32be(0);
      e.u32be(0);
    });
    const p = await client.recv(1);
    expect(r1(p)).toBe(1); // full-update flag
    const info = rOS(p); // SmartStream
    // info stream (little-endian fields), with the CAConfig.bak seed rows:
    // E1 mCount, m×(EStr name, EStr ip, E4 param), E2 lCount,
    // l×(E4 inet_addr, E2 port, E1 flag), E1 current
    let o = 0;
    const r1s = () => info[o++]!;
    const r2s = () => info[o++]! | (info[o++]! << 8);
    const r4s = () => (info[o++]! | (info[o++]! << 8) | (info[o++]! << 16) | (info[o++]! << 24)) >>> 0;
    const rstrs = () => {
      const len = r4s();
      let t = "";
      for (let i = 0; i < len; i++) t += String.fromCharCode(info[o++]!);
      return t;
    };
    expect(r1s()).toBe(1); // mCount — the .bak's operator row
    expect(rstrs()).toBe("world name");
    expect(rstrs()).toBe(CA_CONFIG_SEED_IP);
    expect(r4s()).toBe(0); // param
    expect(r2s()).toBe(2); // lCount
    for (const port of [3838, 3838]) {
      expect(r4s()).toBe(0x0100007f); // inet_addr("127.0.0.1") — network-order
      // packed, so the LE Encode4 emits 7F 00 00 01 like the original server
      expect(r2s()).toBe(port);
      expect(r1s()).toBe(1); // flag
    }
    expect(r1s()).toBe(1); // current — Current = 1 in the seeded row
    expect(o).toBe(info.length);
    const flag = r1(p);
    expect(flag).toBe(1); // notice follows
    const notice = rOS(p);
    // E1 count(1), n×(E1 type, EStr value, EStr strAttr) — the .bak's
    // CAString row (CxLogin.exe.c:29957 "type = 0 or type = 1")
    expect(notice[0]!).toBe(1); // count
    expect(notice[1]!).toBe(0); // type
    const nstr = () => {
      const len = notice[o2!]! | (notice[o2! + 1]! << 8) | (notice[o2! + 2]! << 16) | (notice[o2! + 3]! << 24);
      o2! += 4;
      let t = "";
      for (let i = 0; i < len; i++) t += String.fromCharCode(notice[o2++!]!);
      return t;
    };
    let o2 = 2;
    expect(nstr()).toBe("ChargeUrl");
    expect(nstr()).toBe("http://www.digicell.com.tw/opencard/money.aspx");
    expect(o2).toBe(notice.length);
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
      e.u8(1); // EmailRcv
      e.u8(1); // Gender
      e.str("Taipei"); // Address
      e.str("02-12345678"); // Tel
      e.str("profile"); // Profile (13th)
      e.u8(0); // Reveal
    });
    const p = await client.recv(5);
    expect(r1(p)).toBe(0); // 0 = created
  });

  test("Login with the created account", async () => {
    client.send(3, (e) => {
      e.u8(1); // user count
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
    await client2.connect(13838, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
    client2.send(3, (e) => {
      e.u8(1);
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
      expect(r2(p14)).toBe(3); // client version (the fake GS handshake [7][3])
    }
    const p11 = await client.recv(11);
    expect(rstr(p11)).toBe(""); // no advertisement rows
    expect(r2(p11)).toBe(0); // adv Param1
    expect(r2(p11)).toBe(0); // adv Param2
    expect(r2(p11)).toBe(60);
    expect(r1(p11)).toBe(0); // guild list empty
    expect(r1(p11)).toBe(1); // NDA count (min(1,2))
    expect(r4(p11)).toBe(inet_addr("127.0.0.1"));
    expect(r1(p11)).toBe(1); // relay count
    expect(r4(p11)).toBe(inet_addr("127.0.0.1"));
    expect(r2(p11)).toBe(0); // fx messages (FxMessage MessageUse = 1)
    expect(r2(p11)).toBe(1); // PRECHMAPREWARD (FxUserOptions, seeded 1.0f → long 1)
    expect(r1(p11)).toBe(1); // JUM count
    expect(r4(p11)).toBe(inet_addr("127.0.0.1"));
    expect(r2(p11)).toBe(17360);
  });

  test("ReqConnectToSvr validates and returns the game server address", async () => {
    // p6: [E1 svrType][E4 svrIdx][E2 version] — version 7 matches the fake GS
    client.send(6, (e) => {
      e.u8(10);
      e.u32be(0);
      e.u16(7);
    });
    const p = await client.recv(6);
    expect(r1(p)).toBe(1); // CheckEnterGame ok
    expect(r1(p)).toBe(10); // svr type
    expect(r4(p)).toBe(0); // svr idx
    // the center sends its stored host-order dword (ntohl(inet_addr(cfgIP)),
    // CxCenter.exe.c:10791 + :10283) — NOT the raw inet_addr value used by
    // the p11 NDA/Relay/JUMS fields above
    expect(r4(p)).toBe(0x7f000001); // ntohl(inet_addr("127.0.0.1"))
    expect(r2(p)).toBe(14848); // port (FXGSPort0)
    // version mismatch path
    client.send(6, (e) => {
      e.u8(10);
      e.u32be(0);
      e.u16(8);
    });
    const p2 = await client.recv(6);
    expect(r1(p2)).toBe(4); // version mismatch
    // wrong type path
    client.send(6, (e) => {
      e.u8(99);
      e.u32be(0);
      e.u16(7);
    });
    const p3 = await client.recv(6);
    expect(r1(p3)).toBe(5); // not enterable
  });

  test("RequestDestoryService echoes the header type and disconnects nothing", async () => {
    client.send(60, (e) => {
      e.u32be(client.k); // the header type adopted from the accept packet 0
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

  test("check udp comm: [E1 0][E4 gsn] on ServerPort+1 answers [E1 2]", async () => {
    // MTUDPServer::StartupBase binds ServerPort+MTUDP_UDP_PORT_OFFSET
    // (CxLogin.exe.c:28168) — the UDP peer of the TCP 13838 listener. The
    // client learns its serial from OnLoginRes (loginSN above) and probes
    // once; every handled datagram destroys the host afterwards.
    let last: Uint8Array | null = null;
    // (the handler rides creation — Bun's UDP reload does not deliver data)
    const udp = await Bun.udpSocket({
      socket: {
        data: (_s, d) => {
          last = new Uint8Array(d as Buffer);
        },
      },
    });
    const probe = (gsn: number): Uint8Array =>
      BuildFrame(Uint8Array.of(0, (gsn >>> 24) & 0xff, (gsn >>> 16) & 0xff, (gsn >>> 8) & 0xff, gsn & 0xff));

    // an unregistered serial: the host is created then destroyed, no reply
    udp.send(probe(0xdeadbeef), 13839, "127.0.0.1");
    await Bun.sleep(350);
    expect(last).toBeNull();

    // the logged-in user's serial: one frame [len][E1 2][crc8] comes back
    udp.send(probe(loginSN), 13839, "127.0.0.1");
    for (let waited = 0; last === null && waited < 2000; waited += 50) await Bun.sleep(50);
    expect(last).not.toBeNull();
    expect(last![0]).toBe(2); // total len
    expect(last![1]).toBe(2); // [E1 2]
    expect(UpdateCRC8(0, last!, last!.length)).toBe(0); // the residual-zero CRC
  });
});

let entryGsClient: TestClient | null = null;

describe("game server entry flow (FXGS)", () => {
  entryGsClient = new TestClient();
  const gs = entryGsClient;

  test("connect pushes packet 0 [E2 3][E2 7][E4 headerType]", async () => {
    // the GS arms degree 2 in its accept path (FxServer.exe.c:18965) before the
    // first receive, so the client's own frames are SES3+CRC8 from the start
    await gs.connect(14848, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
    const p0 = await gs.recv(0);
    expect(r2(p0)).toBe(3); // the center protocol version
    expect(r2(p0)).toBe(7);
    const k = r4(p0);
    expect(k).toBe(0); // the GS's assigned conversion row (first client socket)
  });

  test("ConnEstablished (7) performs the DB entry and answers 210/202/201", async () => {
    gs.send(7, (e) => {
      e.u8(1); // one user
      e.str("tester01");
      e.u32be(loginSN); // the global serial from the login response
      e.u32be(0); // guild SN
      e.u32be(0x11221122); // x
      e.u32be(0); // y — x^y = the known client hash
      e.u8(1); // z
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
    expect(r2(p70)).toBe(1); // look level (Encode2 — FxServer.exe.c:27149 vtbl+24)
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
      e.u8(0); // game type
      e.u8(1); // one player
      e.u8(0); // select
    });
    const p = await gs.recv(80);
    expect(r1(p)).toBe(0); // created
    expect(r2(p)).toBe(0); // room idx 0
    const serial = r4(p);
    expect(serial).toBeGreaterThan(0);
    expect(r1(p)).toBe(0); // game type
    // the creator's roster burst (SendSessionInfoPacket): 105 + 107×7 + 112×2
    await gs.recv(105);
    for (let i = 0; i < 7; i++) await gs.recv(107);
    await gs.recv(112);
    await gs.recv(112);
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
  // The COSmartStream wire image is [0x18 magic][u32 LE innerLen][inner…].
  // EncodeOSStreamAt writes it raw at degree 0 and as E4(masked size)+raw
  // stream at degree ≥ 1 — either way the stream header follows.
  let stream: Uint8Array;
  if (n.deg >= 1) {
    // EncodeOSStreamAt's ciphered branch: E4 (masked) size + the raw stream.
    const size = r4(n);
    stream = n.buf.slice(n.off, n.off + size);
    n.off += size;
    if (stream[0] !== 0x18) throw new Error(`bad smartstream magic ${stream[0]}`);
  } else {
    const magic = r1(n);
    if (magic !== 0x18) throw new Error(`bad smartstream magic ${magic}`);
    const innerLen = n.buf[n.off]! | (n.buf[n.off + 1]! << 8) | (n.buf[n.off + 2]! << 16) | (n.buf[n.off + 3]! << 24);
    stream = n.buf.slice(n.off - 5, n.off + innerLen);
    n.off += innerLen;
  }
  const innerLen = stream[1]! | (stream[2]! << 8) | (stream[3]! << 16) | (stream[4]! << 24);
  const inner = stream.slice(5, 5 + innerLen);
  if (inner[0] === 1) return inflateSync(inner.slice(5)); // [1][rawSize LE32][deflate]
  if (inner[0] !== 0) throw new Error(`bad smart stream form ${inner[0]}`);
  return inner.slice(1);
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
  await ls.connect(13838, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
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
    e.u8(1); // EmailRcv
    e.u8(1); // Gender
    e.str("Taipei");
    e.str("02-12345678");
    e.str("profile");
    e.u8(0); // Reveal
  });
  const created = await ls.recv(5);
  expect(r1(created)).toBe(0);
  ls.send(3, (e) => {
    e.u8(1);
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
    e.u8(10);
    e.u32be(0);
    e.u16(7);
  });
  const p6 = await ls.recv(6);
  expect(r1(p6)).toBe(1); // result
  expect(r1(p6)).toBe(10); // svr type
  r4(p6); // svr idx
  r4(p6); // ip
  expect(r2(p6)).toBe(14848);
  const gs = new TestClient();
  // the GS arms degree 2 in its accept path (FxServer.exe.c:18965) before the
    // first receive, so the client's own frames are SES3+CRC8 from the start
    await gs.connect(14848, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
  await gs.recv(0);
  gs.send(7, (e) => {
    e.u8(1);
    e.str(name);
    e.u32be(sn);
    e.u32be(0); // guild
    e.u32be(0x11221122);
    e.u32be(0);
    e.u8(1);
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
    chief.name = "chief";
    roomChief = chief;
    chief.send(80, (e) => {
      e.str("e2e room"); // title
      e.str(""); // password
      e.u8(0); // game type
      e.u8(1); // one player
      e.u8(0); // bomber select (valid with the test BomberAttr)
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
    const state = rbuf(p105, 3);
    expect(state[0]).toBe(0x02); // chief bit, nothing closed/ready
    expect(state[1]).toBe(0); // bomber 0 (the select came through)
    expect(state[2]).toBe(0); // color 0 (first player, slot%8)
    expect(rstr(p105)).toBe("tester01"); // AppendSimpleInfoPacket
    r1(p105); // gender
    expect(r2(p105)).toBe(1); // look level (Encode2 — FxServer.exe.c:27149 vtbl+24)
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
    // SendSessionInfoPacket PutPackets the buffer twice (the base strategy's
    // SendSessionInfo is a no-op retn 4) — the original sends 112 twice
    const p112dup = await chief.recv(112);
    expect(r2(p112dup)).toBe(0xffff);
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
      e.u8(1);
      e.u8(1); // select: the random bomber idx (== total count)
    });
    const res = await gs.recv(81);
    expect(r1(res)).toBe(0); // joined
    gs.name = "member";
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
    const state = rbuf(p105b, 3);
    expect(state[0]).toBe(0); // member: no chief bit, not ready
    expect(state[2]).toBe(1); // color 1 (second slot%8)
    // the empty slots ride along as 107s
    for (let i = 0; i < 6; i++) {
      const p107 = await gs.recv(107);
      expect(r1(p107)).toBe(i + 2);
    }
    const p112 = await gs.recv(112);
    expect(r2(p112)).toBe(0xffff);
    const p112dup = await gs.recv(112); // the double PutPacket, same as create
    expect(r2(p112dup)).toBe(0xffff);
    // SendGameType — normal (93).  No second self 105: SendJoinPacket is an
    // exclude-the-joiner broadcast (CBaseSession::PutPacket skips a3)
    await gs.recv(93);
    // …and the chief is exactly who receives it: the joiner's 105 (fSelf=1)
    const p105c = await roomChief!.recv(105);
    expect(r1(p105c)).toBe(1); // the joiner's slot
    expect(r4(p105c)).toBe(sn); // the joiner's global serial
    expect(r1(p105c)).toBe(1); // fSelf=1 in the broadcast variant
    r1(p105c); // community
    r1(p105c); // the category-4 deco (fSelf=1 → present)
    rbuf(p105c, 3); // slot state
    expect(rstr(p105c)).toBe("tester03");
  });

  test("ready (96) from the member → 107 with the ready bit", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    member.send(96, (e) => {
      e.u8(1);
    });
    const p107 = await member.recv(107);
    expect(r1(p107)).toBe(1); // the member's slot
    const state = rbuf(p107, 3);
    expect(state[0]).toBe(0x04); // the ready bit only (members hold no crown)
    // …the chief's socket sees the same broadcast
    const p107b = await chief.recv(107);
    expect(r1(p107b)).toBe(1);
    expect(rbuf(p107b, 3)[0]).toBe(0x04);
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
      e.u8(3); // user 0 of the socket, color 3
    });
    const p108 = await chief.recv(108);
    expect(r1(p108)).toBe((1 << 4) | 3); // the reply names the slot
    member.send(99, (e) => {
      e.u8(0); // bomber 0 (a normal index)
    });
    const p109 = await chief.recv(109);
    expect(r1(p109)).toBe((1 << 4) | 0);
  });

  test("open/close slot (100): chief only, 110 both ways", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    chief.send(100, (e) => {
      e.u8((7 << 4) | 1); // close slot 7
    });
    const p110 = await chief.recv(110);
    expect(r1(p110)).toBe((7 << 4) | 1);
    chief.send(100, (e) => {
      e.u8((7 << 4) | 0); // reopen
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
      e.u8(0); // own slot
      e.u8(1);
      e.u8(2);
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
      e.u8(0); // user 0 of the socket, color 0
    });
    await chief.recv(108);
    member.send(111, (e) => {
      e.str("go go");
    });
    const p27 = await chief.recv(27);
    expect(rstr(p27)).toBe("tester03 : go go");
  });

describe("admin broadcast chain (util tool → center → GS client)", () => {
  // CChatPool::SendAll fans over the CChannelPool — the entry-flow client
  // below is its live member.
  const util = new CLocalSocket({ onPacket: () => {} });

  test("the fake util attaches as server class 99", async () => {
    // versions come from the S2S per-class defaults (CxUtil handshake = 5/3)
    await util.ConnectToCenter("127.0.0.1", 12828, SVRCLASS_UTIL, 0);
    for (let i = 0; i < 200 && !center.GetSvr(SVRCLASS_UTIL, 0)?.socket; i++) await Bun.sleep(5);
    expect(center.GetSvr(SVRCLASS_UTIL, 0)?.socket).toBeTruthy();
  });

  test("tool 25 (MC 4) → CM 8 → the GS client sees 26 [EStr]", async () => {
    const p = new CSendPacket(MC_ReceivedPacket.OnAdminNotifyMsg);
    p.EncodeStr("admin says hi");
    util.SendToCenter(p);
    const got = await entryGsClient!.recv(26);
    expect(rstr(got)).toBe("admin says hi");
  });

  test("tool 31 (MC 10) → CM 13 → the GS client sees 30 [EStr]", async () => {
    const p = new CSendPacket(MC_ReceivedPacket.OnSystemMsg);
    p.EncodeStr("system says");
    util.SendToCenter(p);
    const got = await entryGsClient!.recv(30);
    expect(rstr(got)).toBe("system says");
  });

  test("tool 26 (MC 5, type 10) → CM 8 → the GS client sees 26", async () => {
    const p = new CSendPacket(MC_ReceivedPacket.OnAdminNotifyGameServerMsg);
    p.Encode1(10);
    p.EncodeStr("gs-only says");
    util.SendToCenter(p);
    const got = await entryGsClient!.recv(26);
    expect(rstr(got)).toBe("gs-only says");
  });
});

  test("start game (106) → 115 (can) + 116 (launch) with both slots", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    // split the colors again — CanStartGame wants at least two teams
    member.send(98, (e) => {
      e.u8(1); // color 1
    });
    await chief.recv(108);
    chief.send(106, (e) => {});
    const p115 = await chief.recv(115);
    expect(r1(p115)).toBe(0); // CanStartGame = go
    const p116 = await chief.recv(116);
    r4(p116); // tick
    expect(r2(p116)).toBe(0); // m_nGameMapIdx (Encode2 — FxServer.exe.c:37289)
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
    // per alive slot: [E1 1][3 × (E4 ip)(E2 port)][E4 joinTime]; empty: [E1 0]
    // slot0 (chief): the recvfrom host + the two claimed hosts, 0x7f000001 each
    for (const p120 of [p120a, p120b]) {
      expect(r1(p120)).toBe(1); // slot 0 alive
      expect(r4(p120)).toBe(0x7f000001); // the recvfrom address
      r2(p120); // the ephemeral source port
      expect(r4(p120)).toBe(0x7f000001);
      expect(r2(p120)).toBe(40001);
      expect(r4(p120)).toBe(0x7f000001);
      expect(r2(p120)).toBe(40002);
      expect(r4(p120)).toBeGreaterThan(0); // the AddUser join time
      expect(r1(p120)).toBe(1); // slot 1 alive
      if (p120 === p120a) {
        // the member has not handshoken yet — his host list is still empty
        expect(r4(p120)).toBe(0);
        r2(p120);
        expect(r4(p120)).toBe(0);
        r2(p120);
        expect(r4(p120)).toBe(0);
        r2(p120);
      } else {
        expect(r4(p120)).toBe(0x7f000001);
        r2(p120);
        expect(r4(p120)).toBe(0x7f000001);
        expect(r2(p120)).toBe(40001);
        expect(r4(p120)).toBe(0x7f000001);
        expect(r2(p120)).toBe(40002);
      }
      expect(r4(p120)).toBeGreaterThan(0);
      for (let i = 2; i < 8; i++) expect(r1(p120)).toBe(0); // the 6 empty slots
    }
    // the second type 11 completed the handshake → DeferStartGame fires the 150
    const p150c = await chief.recv(150);
    const p150m = await member.recv(150);
    for (const p150 of [p150c, p150m]) {
      expect(r4(p150)).toBe(0); // the +12736 seed dword (never written)
      const seq = r4(p150);
      expect(seq).toBeGreaterThan(0); // serial ^ version
      expect(r4(p150)).toBe(0); // ghostStart (tmpl+60, RAW seconds on the wire)
      expect(r4(p150)).toBe(0); // ghostFreq (tmpl+64, RAW seconds on the wire)
    }
    (udp as unknown as { close?: () => void }).close?.();
  });

  test("session detail (68): the room answers 84 with the per-slot blocks", async () => {
    const chief = roomChief!;
    chief.send(68, (e) => {
      e.u16(0); // the room idx
      e.u32be(roomSerial);
    });
    const res = await chief.recv(84);
    expect(r1(res)).toBe(1); // the room exists
    for (let i = 0; i < 8; i++) {
      expect(r1(res)).toBe(i <= 1 ? 1 : 0); // the chief + the member are seated
      if (i === 0) {
        expect(r1(res)).toBe(0); // user+104 — never written in FXGS
        expect(rstr(res)).toBe("tester01"); // the chief client (roomChief labels it "chief" locally only)
        expect(r2(res)).toBe(1); // look level
        expect(r1(res)).toBe(1); // parked in the room (not playing) → 1
        expect(r1(res)).toBe(1); // the chief bit
      } else if (i === 1) {
        expect(r1(res)).toBe(0); // user+104
        expect(rstr(res)).toBe("tester03");
        expect(r2(res)).toBe(1); // look level
        expect(r1(res)).toBe(1); // parked in the room
        expect(r1(res)).toBe(0); // not the chief
      }
    }
    // mid-game (the launch test ran): the tail is 3 minutes minus the play
    // time, so a just-started game reads a hair under 180000
    const tail = r4(res);
    expect(tail).toBeGreaterThan(170000);
    expect(tail).toBeLessThanOrEqual(180000);
    // a wrong serial hits the failure branch: a bare [E1 0]
    chief.send(68, (e) => {
      e.u16(0);
      e.u32be(0xdeadbeef);
    });
    const miss = await chief.recv(84);
    expect(r1(miss)).toBe(0);
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

describe("audit regression: 82 auto-join, before-join ring, BomberAttr map", () => {
  test("auto join (82): a matching request always answers [E1 2] — the +1316 candidate list is never filled", async () => {
    const { gs } = await enterGame("tester05");
    gs.send(82, (e) => {
      e.u8(1); // count == GetUserCount
      e.u8(0); // one discarded select byte (Decode1 % (total + 1))
    });
    const res = await gs.recv(82);
    expect(r1(res)).toBe(2);
  });

  test("AddBeforeJoinSession keeps the original 5-deep shift ring (+476/+496)", () => {
    const socket = Object.create(CClientSocket.prototype) as CClientSocket;
    socket.m_anBeforeJoinSession = [];
    socket.AddBeforeJoinSession(1);
    socket.AddBeforeJoinSession(2);
    socket.AddBeforeJoinSession(3);
    socket.AddBeforeJoinSession(2); // the duplicate is ignored
    expect(socket.m_anBeforeJoinSession).toEqual([1, 2, 3]);
    socket.AddBeforeJoinSession(4);
    socket.AddBeforeJoinSession(5);
    socket.AddBeforeJoinSession(6); // full — entry 0 falls off
    expect(socket.m_anBeforeJoinSession).toEqual([2, 3, 4, 5, 6]);
  });

  test("BomberAttr: the 109 compares read dwords 1/3/5; hidden counts nAttr1 != 0", () => {
    const attr = CBomberAttr.ms_pInstance!;
    expect(attr.GetTotalCount()).toBe(1);
    expect(attr.GetNormalCount()).toBe(1); // nAttr1 == 0 → not hidden
    expect(attr.GetCurrentSpeed(0)).toBe(1); // +260 dword1
    expect(attr.GetBombCount(0)).toBe(1); // +268 dword3
    expect(attr.GetBombPower(0)).toBe(0); // +276 dword5
    expect(attr.IsValidSelectIdx(0)).toBe(true);
    expect(attr.IsValidSelectIdx(1)).toBe(true); // the random index (== total)
  });
});
