/**
 * End-to-end exercise of the ported core: center ↔ LS attach, client login,
 * account creation, channel lists — against the real code paths.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { CServerConfig, CXCENTER_STR_KEYS } from "../src/core/Config.ts";
import { CxCenter, CUser as CenterCUser } from "../src/Center/Center.ts";
import { CONNECTION_TIMEOUT_MS, CONNECTING_LIST_BUCKET_COUNT } from "../src/Center/Defs.ts";
import { GetTickCount } from "../src/core/GetTickCount.ts";
import { main as loginMain } from "../src/LS/Login.ts";
import { inet_addr } from "../src/LS/MultiServer.ts";
import {
  CClientSocket,
  CBomberAttr,
  CGuild,
  CGuildDynInfoCalculator,
  CGuildSessionStrategy,
  CGameSession,
  CGameSessionStrategy,
  CMainSystem,
  CUser,
  main as gameMain,
} from "../src/FXGS/GameServer.ts";
import { UpdateCRC32 } from "../src/core/CRC.ts";
import { RAND_MAX } from "../src/core/CRand.ts";
import { CLocalSocket } from "../src/lib/CenterLink.ts";
import { SVRCLASS_UTIL, MC_ReceivedPacket } from "../src/lib/S2S.ts";
import { CReceivedPacket, CSendPacket, CipherDegree } from "../src/core/Packet.ts";
import { GS_ClientSend } from "../src/lib/PacketIDs.ts";
import { CA_CONFIG_SEED_IP } from "../src/db/CAConfigBak.ts";
import { CDBMan, EncodePassword, GetUserHashNo } from "../src/db/DBMan.ts";
import { SimpleStreamEncrypt3, SimpleStreamDecrypt3 } from "../src/core/StreamCipher.ts";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { inflateSync } from "node:zlib";
import { BillingStore } from "../src/Billing/Store.ts";
import { BillingServer } from "../src/Billing/Server.ts";
import { registerLocalBilling } from "../src/Billing/Config.ts";
import { CUserItemMan as GSItemMan } from "../src/FXGS/CUserItemMan.ts";

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
  // Map/room1 and Map/practice1: version 1000 + the 17 template dwords
  // (maxTeam 8, maxPlayer 8, no level/premium gate).  Attr/MapGroup marks
  // only practice1 for CPracticeSession's native random-map override.
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
  const i32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeInt32LE(value);
    return out;
  };
  const idfName = (value: string): Buffer => Buffer.concat([i32(value.length), Buffer.from(value, "latin1")]);
  const mapGroup = Buffer.concat([
    i32(1),
    idfName("PraticeMapGroup"), // the official asset's spelling
    i32(1),
    idfName("practice1"),
  ]);
  // the package: FxServer.idx = [u32 count]{[u32 nameLen][name][u32 off][u32 len]}
  const entries = [
    { name: "Attr/BomberAttr", data: bomber },
    { name: "Attr/ItemAttr", data: itemAttr },
    { name: "Attr/MapGroup", data: mapGroup },
    { name: "Map/room1", data: map },
    { name: "Map/practice1", data: Buffer.from(map) },
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
import { BuildFrame } from "../src/FXGS/MTUDP.ts";
import { UpdateCRC8 } from "../src/FXGS/MTUDP.ts";

let center: CxCenter;

/** The type-77 guild channel boots as its own process (the six original
 *  servers are six processes, and the second FXGS's CMainSystem singletons
 *  must not share this one's). */
let guildGsProc: Bun.Subprocess | null = null;

let loginSN = 0;

beforeAll(async () => {
  rmSync(DB_DIR, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DB_DIR, { recursive: true });
  writeGameDataPackage();
  const cfg = new CServerConfig(CXCENTER_STR_KEYS, true);
  cfg.Init(DIR + "/center.cfg");
  cfg.ParseConfigString("FXAttrShop = 1"); // same as shipped Center cfg: exercise real GS inventory loading
  CServerConfig.ms_pInstance = cfg;
  center = new CxCenter(cfg);
  center.Init();
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
  guildGsProc?.kill();
  guildGsProc = null; // a re-run must not see a dead handle
  if (!process.env.KEEP_DB) rmSync(DB_DIR, { recursive: true, force: true });
});

describe("center link", () => {
  test("LS attached and received channel info", () => {
    expect(center.GetSvr(1, 0)?.socket).not.toBeNull();
    expect(Reflect.get(center.GetSvr(1, 0)!.socket!, "fGreeted")).toBe(true);
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
    const noticeView = new DataView(notice.buffer, notice.byteOffset, notice.byteLength);
    let noticeOffset = 2;
    const readNoticeString = () => {
      const length = noticeView.getUint32(noticeOffset, true);
      noticeOffset += 4;
      const value = Buffer.from(notice.subarray(noticeOffset, noticeOffset + length)).toString("latin1");
      noticeOffset += length;
      return value;
    };
    expect(readNoticeString()).toBe("ChargeUrl");
    expect(readNoticeString()).toBe("http://www.digicell.com.tw/opencard/money.aspx");
    expect(noticeOffset).toBe(notice.length);
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
    // ...and the type-77 guild channel (game3.cfg → FXGSPort3 17888) as a
    // real second process, so the guild strategy runs against the same
    // center, LS and DB the other describes use.
    copyFileSync(DIR + "/game3.cfg", DATA_DIR + "/game77.cfg");
    guildGsProc = Bun.spawn(
      [process.execPath, "run", "src/main.ts", "--only", "game", "--no-caitem-import", "--cfg", DATA_DIR + "/game77.cfg", "--db", DB_DIR],
      { cwd: DIR + "/..", stdout: "ignore", stderr: "ignore" },
    );
    for (let t = 0; t < 100 && !center.GetSvr(10, 3)?.socket; t++) await Bun.sleep(100);
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
    client.discardPending();
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
    for (let i = 1; i < cnt; i++) expect(r2(p13)).toBe(i === 3 ? 0 : 65535); // 3 = T77 attached, empty; the rest -1: no GS
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
    // out-of-range index: CheckConnectingToSvr's "unregistered" gate (the
    // configured FXGSNumber is 5, so idx 99 misses the table)
    client.send(6, (e) => {
      e.u8(10);
      e.u32be(99);
      e.u16(7);
    });
    const p4 = await client.recv(6);
    expect(r1(p4)).toBe(0); // refused
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
    // 210 [E1 attr] — attr = the center's FXAttrShop flag (enabled)
    const p210 = await gs.recv(210);
    expect(r1(p210)).toBe(1);
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
    expect(r4(p70)).toBe(0); // level-icon SN
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
    for (let i = 1; i < cnt; i++) expect(r2(p13)).toBe(i === 3 ? 0 : 65535); // channel 3 = T77, empty
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
    expect(r4(p)).toBe(3000); // native table: upper threshold for level 1
    expect(r2(p)).toBe(1); // level 1
    expect(r4(p)).toBe(0); // money
    expect(r1(p)).toBe(10);
    expect(r4(p)).toBe(0); // ServerIndex
    expect(r2(p)).toBe(65535); // session idx (-1)
    expect(r1(p)).toBe(0); // reveal
    expect(r4(p)).toBe(0); // level-icon SN
    r1(p); // community svr
    expect(r1(p)).toBe(0); // native SendGameSlotInfo E1 count
    expect(r2(p)).toBe(0); // fake-level tail
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

/** Register + log in through the LS, then walk the full GS entry path.
 *  opts.gsIdx/gsPort pick the game server (the packet-6 E4 is the
 *  small-loaded index the center routes by), guildSn is the guild serial the
 *  GS entry reads, mid runs between the LS login and the GS connect;
 *  existingAccount skips registration when exercising a real re-login. */
async function enterGame(
  name: string,
  opts: { gsIdx?: number; gsPort?: number; guildSn?: number; existingAccount?: boolean; onInventory?: (p: CReceived) => void; mid?: () => void | Promise<void> } = {},
): Promise<{ ls: TestClient; gs: TestClient; sn: number }> {
  const ls = new TestClient();
  await ls.connect(13838, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
  ls.discardPending();
  if (!opts.existingAccount) {
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
  }
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
  await opts.mid?.();
  ls.send(6, (e) => {
    e.u8(10);
    e.u32be(opts.gsIdx ?? 0);
    e.u16(7);
  });
  const p6 = await ls.recv(6);
  expect(r1(p6)).toBe(1); // result
  expect(r1(p6)).toBe(10); // svr type
  r4(p6); // svr idx
  r4(p6); // ip
  expect(r2(p6)).toBe(opts.gsPort ?? 14848);
  const gs = new TestClient();
  // the GS arms degree 2 in its accept path (FxServer.exe.c:18965) before the
    // first receive, so the client's own frames are SES3+CRC8 from the start
    await gs.connect(opts.gsPort ?? 14848, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
  await gs.recv(0);
  gs.send(7, (e) => {
    e.u8(1);
    e.str(name);
    e.u32be(sn);
    e.u32be(opts.guildSn ?? 0); // guild
    e.u32be(0x11221122);
    e.u32be(0);
    e.u8(1);
  });
  await gs.recv(210);
  await gs.recv(202);
  const inventory = await gs.recv(201);
  opts.onInventory?.(inventory);
  await gs.recv(15);
  await gs.recv(70);
  return { ls, gs, sn };
}

let roomChief: TestClient | null = null;
let roomMember: TestClient | null = null;
let roomLobby: TestClient | null = null; // tester02, parked in the lobby
let roomSerial = 0; // the room's +148 serial (the UDP check echoes it)
let roomGameVersion = -1; // CRT rand value recovered from the first kickoff
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
    expect(gs.hasPending(83)).toBe(false);
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
    expect(r4(p105)).toBe(0); // level-icon SN
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

  test("select map (97): random, theme and explicit choices broadcast 112 + 107 to both clients", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    // Map 0 is the ordinary 8-team map in theme 0. Negative selections must
    // reach the same colour fold as map 0, not unsigned map 65535/65534.
    for (const selection of [0xffff, 0xfffe, 0]) {
      chief.send(97, (e) => e.u16(selection));
      for (const client of [chief, member]) {
        expect(r2(await client.recv(112))).toBe(selection);
        for (let slot = 0; slot < 2; slot++) {
          const packet = await client.recv(107);
          expect(r1(packet)).toBe(slot);
          expect(Array.from(rbuf(packet, 3))).toEqual(slot === 0 ? [2, 0, 0] : [4, 1, 1]);
        }
      }
    }
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
    // the airplane-item probabilities (173) close the launch; the test map
    // is no mission map (+108 = 0), so list one of iteminfo.txt flies, and
    // the test package's ItemAttr is empty → every name resolves to -1
    const p173 = await chief.recv(173);
    expect(r4(p173)).toBe(1000); // +12776 ← tmpl+72
    expect(r4(p173)).toBe(2000); // +12780 ← tmpl+76
    expect(r1(p173)).toBe(4); // list one: ItemBomb 50, ItemFire 40, Roller 5, MaxPower 5
    for (const prob of [50, 40, 5, 5]) {
      expect(r1(p173)).toBe(0xff); // CItemAttr::GetItemidx → -1
      expect(r1(p173)).toBe(prob);
    }
  });

  test("the MTUDP launch handshake: type 1 (mapCRC+attrs) then type 11 (peer info) → 150 + 120", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    chief.discardPending();
    member.discardPending();
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
      // dword 3184 — CGameClock.m_dwStartTime, read right after StartGame
      // (FxServer.exe.c:32901); the two sockets launched in the same tick can
      // share it, so only pin non-zero
      expect(r4(p150)).toBeGreaterThan(0);
      const seq = r4(p150);
      const version = (seq ^ roomSerial) >>> 0;
      expect(version).toBeLessThanOrEqual(RAND_MAX); // CRT rand is 15-bit; XOR may legitimately be zero
      if (roomGameVersion === -1) roomGameVersion = version;
      expect(version).toBe(roomGameVersion);
      expect(r4(p150)).toBe(0); // ghostStart (tmpl+60, RAW seconds on the wire)
      expect(r4(p150)).toBe(0); // ghostFreq (tmpl+64, RAW seconds on the wire)
    }
    // in play the 185 gate (fPlaying && gamePhase 1) is open: the chief
    // blames the member's seat and the member is told to relay — 54 [E1 0],
    // the chief's seat (CGameSession::OnNotifyUDPLoss, FxServer.exe.c:34093)
    chief.send(185, (e) => {
      e.u8(1); // the target seat — the member at slot 1
    });
    const p54 = await member.recv(54);
    expect(r1(p54)).toBe(0); // the asker's (the chief's) m_nSlotIdx
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

  test("practice room (86): the AI seats, the 100→110 close-with-level and the 110→111 level moves", async () => {
    const { gs } = await enterGame("tester06");
    gs.send(83, (e) => {});
    await gs.recv(15);
    gs.send(86, (e) => {
      e.u8(1); // one player
      e.u8(0); // select
    });
    const created = await gs.recv(89);
    expect(r1(created)).toBe(0); // created
    expect(r2(created)).toBe(0); // practice idx 0
    expect(r4(created)).toBeGreaterThan(0); // the practice session serial
    // the roster burst: 105 (slot 0, the human) + 107 with the AI tail
    // (slot 1) + six closed 107s
    await gs.recv(105);
    const ai = await gs.recv(107);
    expect(r1(ai)).toBe(1); // slot 1
    const aiState = rbuf(ai, 3); // EncodeBuffer rides raw at every degree
    expect((aiState[0]! & 1) !== 0).toBe(false); // open — only seats past 2×users close
    expect(aiState[1]).toBe(5); // bomber 5
    expect(aiState[2]).toBe(7); // colour 7
    expect(r1(ai)).toBe(1); // the AI tail: owned
    expect(r2(ai)).toBe(1); // the band level of a level-1 tester
    for (let i = 2; i < 8; i++) {
      const closed = await gs.recv(107);
      expect(r1(closed)).toBe(i);
      const state = rbuf(closed, 3);
      expect((state[0]! & 1) !== 0).toBe(true); // the closed bit
      expect(r1(closed)).toBe(0); // no AI owner
    }
    // close slot 2 → the AI owner binds and the 110 carries the level
    gs.send(100, (e) => {
      e.u8(0x20); // slot 2, low nibble 0 = close
    });
    const closed = await gs.recv(110);
    expect(r1(closed)).toBe(0x20);
    expect(r2(closed)).toBe(1); // the seat's AI level
    // raise slot 2's AI level: 1 + 15 = 16
    gs.send(110, (e) => {
      e.u8(2);
      e.u8(1);
    });
    const lvl = await gs.recv(111);
    expect(r1(lvl)).toBe(2);
    expect(r2(lvl)).toBe(16);
    // chat (25) in practice is swallowed: the chat paths send through the
    // table singleton's SendPacket, whose +4.. table is the GAME half —
    // the practice seat's serial never matches a game room
    gs.send(25, (e) => {
      e.str("anyone there?");
    });
    await expect(gs.recv(25, 600)).rejects.toThrow("timeout");
    // asking again while seated → 89 [E1 3] and the disconnect
    gs.send(86, (e) => {
      e.u8(1);
      e.u8(0);
    });
    const dup = await gs.recv(89);
    expect(r1(dup)).toBe(3);
  });

  test("the reused practice room starts immediately without TCP109 or UDP and remains connected", async () => {
    const { gs } = await enterGame("tester08");
    gs.send(86, (e) => {
      e.u8(1);
      e.u8(0);
    });
    const created = await gs.recv(89);
    expect(r1(created)).toBe(0);
    expect(r2(created)).toBe(0); // slot 0 again — the dup-86 disconnect freed it
    r4(created); // practice session serial
    await gs.recv(105); // the human seat
    for (let slot = 1; slot < 8; slot++) await gs.recv(107); // AI + six closed seats

    // The native CPracticeSession::LaunchGameStageEx calls DeferStartGame
    // immediately after 116.  Unlike an ordinary room, neither TCP109 nor
    // either MTUDP check is a prerequisite for packet 150.
    gs.send(106, (e) => {});
    const can = await gs.recv(115);
    expect(r1(can)).toBe(0);
    const launch = await gs.recv(116);
    expect(r4(launch)).toBeGreaterThan(0); // launch timeGetTime
    expect(r2(launch)).toBe(1); // Map/practice1, selected by PraticeMapGroup
    expect(r1(launch)).toBe(2); // one human + its AI seat
    for (const [slot, color] of [[0, 0], [1, 7]]) {
      expect(r1(launch)).toBe(slot);
      expect(r1(launch)).toBe(0); // no captain in normal game type
      expect(r1(launch)).toBeLessThan(8); // spawn
      r1(launch); // bomber
      expect(r1(launch)).toBe(color);
    }
    expect(launch.off).toBe(launch.buf.length);
    await gs.recv(173); // airplane item probabilities close LaunchGameStage
    const kickoff = await gs.recv(150);
    expect(r4(kickoff)).toBeGreaterThan(0); // CGameClock start time
    r4(kickoff); // gameSerial ^ gameVersion
    expect(r4(kickoff)).toBe(0); // ghost start (raw seconds)
    expect(r4(kickoff)).toBe(0); // ghost frequency (raw seconds)
    expect(kickoff.off).toBe(kickoff.buf.length);

    // Reproduce the user's late TCP109 shape exactly at field level. Practice
    // ignores it, stays in phase 1, and must never enter the phase-0 UDP-loss
    // sweep that emitted packet 195 in the broken implementation.
    gs.send(109, (e) => {
      e.u32be(0x028aa605);
      e.u8(5, 1, 1, 5);
      e.u32be(0xffffffff);
    });
    await expect(gs.recv(195, 900)).rejects.toThrow("timeout");
    expect(gs.closed).toBe(false);
    gs.close();
  });

  test("kill + finish → 163 GameResult faithful, and 164 waits the full 8 s", async () => {
    const chief = roomChief!;
    const member = roomMember!;
    chief.discardPending();
    member.discardPending();
    // slot0 (the chief) reports being killed by slot 1: event 4 —
    // [E1 slotcode][E2 x][E2 y][E1 killer][E1 drops]
    chief.send(146, (e) => {
      e.u8(0x40); // slot 0 (low nibble), event 4 (high nibble)
      e.u16(280);
      e.u16(39);
      e.u8(1); // the killer seat
      e.u8(0); // no item drops
    });
    const killRelayChief = await chief.recv(159);
    expect(r1(killRelayChief)).toBe(0x40); // the raw slotcode relays
    expect(r2(killRelayChief)).toBe(280);
    expect(r2(killRelayChief)).toBe(39);
    expect(r1(killRelayChief)).toBe(1); // the killer
    expect(r1(killRelayChief)).toBe(0); // the drop count
    const killRelayMember = await member.recv(159);
    expect(r1(killRelayMember)).toBe(0x40);
    // slot 1 (the member) finishes: event 6 — [E1 slotcode][E2 x][E2 y]
    member.send(146, (e) => {
      e.u8(0x61); // slot 1 (low nibble), event 6 (high nibble)
      e.u16(280);
      e.u16(54);
    });
    const finishRelay = await chief.recv(159); // SendPacketExclude — the chief only
    expect(r1(finishRelay)).toBe(0x61);
    expect(r2(finishRelay)).toBe(280);
    expect(r2(finishRelay)).toBe(54);
    // the next Proc tick ends the game and broadcasts the result
    const results = await Promise.all([chief.recv(163), member.recv(163)]);
    for (const res of results) {
      expect(r1(res)).toBe(0); // the 5/6/7-state flag
      expect(r1(res)).toBe(1); // winTeam — the finisher's colour; the launch re-seats
      // through GetColorForNewComer, which deals 0 to the chief and 1 to the member
      expect(r1(res)).toBe(0); // strategy vtbl+44 view type (a normal room)
      expect(r1(res)).toBe(0); // session vtbl+156 ladder
      expect(r1(res)).toBe(0); // the diff-team used-item flag
      const serials: number[] = [];
      for (let slot = 0; slot < 8; slot++) {
        if (r1(res) === 0) continue; // the empty-slot marker
        serials.push(r4(res));
        const result = r1(res);
        if (slot === 0) expect(result).toBe(2); // the killed chief lost
        if (slot === 1) expect(result).toBe(0); // the finisher won
        expect(r1(res)).toBe(slot === 1 ? 1 : 0); // GetKillCount (+12048): slot 1 killed slot 0
        expect(r1(res)).toBe(0); // GetSaveCount (+12016)
        const pctOld = r2(res);
        const pctNew = r2(res);
        expect(pctOld).toBe(pctNew); // the sub-15 s time factor zeroes the reward
        expect(r2(res)).toBeGreaterThan(0); // the look level
        expect(r1(res)).toBe(0); // got-exp (only a level-up sets it)
        expect(r1(res)).toBe(0); // the detail mark
      }
      expect(serials.length).toBe(2);
      expect(serials[0]).not.toBe(serials[1]);
      expect(res.off).toBe(res.buf.length); // nothing trailing
    }
    // The same mutated _USERDYNINFO must be visible on the live encrypted
    // detail path, even though fewer than 25 games have been completed.
    member.send(67, (e) => e.str("tester03"));
    const detail = await member.recv(71);
    expect(r1(detail)).toBe(1);
    expect(rstr(detail)).toBe("tester03"); rstr(detail); rstr(detail); r1(detail);
    expect([r4(detail), r4(detail), r4(detail)]).toEqual([1, 0, 0]);
    expect(r4(detail)).toBe(0); expect(r4(detail)).toBe(3000); expect(r2(detail)).toBe(1);
    // the 164 return-to-stage must NOT ride an early tick: the official
    // gate is timeGetTime() - m_dwEndTime > 0x1F40 (8 s) in the u32 stamp
    // domain — a result screen cut short after one tick crashed clients
    let early = false;
    try {
      await chief.recv(164, 1500);
      early = true;
    } catch {
      /* the expected timeout */
    }
    try {
      await member.recv(164, 1500);
      early = true;
    } catch {
      /* the expected timeout */
    }
    expect(early).toBe(false);
    // …and it does arrive once the gate opens
    const back = await chief.recv(164, 10000);
    expect(r1(back)).toBe(0);
    const backMember = await member.recv(164, 4000);
    expect(r1(backMember)).toBe(0);

    // ── round 2: the room is back at the prepare stage — start again.
    // This is the path a crash-free client finally reaches; replay the
    // whole launch (106 → 115/116 → the UDP type-1 re-arms the launch-ok
    // bits → the kickoff 150) and prove the round is live once more.
    chief.discardPending();
    member.discardPending();
    member.send(96, (e) => {
      e.u8(1); // re-ready — DoReturnPrepareStage wiped the group codes
    });
    await chief.recv(107); // OnSetSlotState — the ready flip broadcasts 107
    member.send(98, (e) => {
      e.u8(1); // color 1 again — CanStartGame wants two teams
    });
    await chief.recv(108);
    chief.send(106, (e) => {});
    const can2 = await chief.recv(115);
    expect(r1(can2)).toBe(0); // CanStartGame = go
    await chief.recv(116);
    await member.recv(116);
    await chief.recv(173);
    const udp2 = await Bun.udpSocket({});
    const sendCheck2 = async (gserial: number): Promise<void> => {
      const payload = new Uint8Array(35);
      const dv = new DataView(payload.buffer);
      payload[0] = 1; // MTUDP type-1 (mapCRC + attrs)
      dv.setUint32(1, gserial >>> 0, false);
      dv.setUint16(5, 0, false); // session idx
      dv.setUint32(7, roomSerial, false);
      dv.setUint32(11, 0x7f000001, false);
      dv.setUint16(15, 40001, false);
      dv.setUint32(17, 0x7f000001, false);
      dv.setUint16(21, 40002, false);
      dv.setUint32(23, 0);
      dv.setUint32(27, testMapCrc);
      payload[31] = 0; // bomber
      payload[32] = 1; // bomb count
      payload[33] = 1; // bomb power
      payload[34] = 5; // speed
      await udp2.send(BuildFrame(payload), 14849, "127.0.0.1");
    };
    await sendCheck2(loginSN);
    await sendCheck2(roomMemberSN);
    // the kickoff 150s — DoStartGame on the round-2 launch
    const p150c2 = await chief.recv(150, 4000);
    expect(r4(p150c2)).toBeGreaterThan(0);
    expect((r4(p150c2) ^ ((roomSerial + 1) >>> 0)) >>> 0).toBe(roomGameVersion);
    const p150m2 = await member.recv(150, 4000);
    expect(r4(p150m2)).toBeGreaterThan(0);
    expect((r4(p150m2) ^ ((roomSerial + 1) >>> 0)) >>> 0).toBe(roomGameVersion);
    // the round is live: a kill relays again
    chief.send(146, (e) => {
      e.u8(0x40);
      e.u16(1);
      e.u16(2);
      e.u8(1);
      e.u8(0);
    });
    const relay2 = await member.recv(159, 4000);
    expect(r1(relay2)).toBe(0x40);
    (udp2 as unknown as { close?: () => void }).close?.();
  }, 20000);

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
    roomLobby!.discardPending();
    // the chief leaving destroys the room; the lobby learns via the timer 87
    chief.close();
    const lobby = await enterGame("tester04");
    lobby.gs.send(83, (e) => {});
    await lobby.gs.recv(15);
    // no rooms left: PutAllSessionInfo's loop writes no 83 packet at all
    await Bun.sleep(150);
    expect(lobby.gs.hasPending(83)).toBe(false);
    // the destroyed-room flag turns into an 87 on the next timer tick,
    // fanned out to the lobby-stage sockets (CChatPool::SendAll(a2, 1))
    const p87 = await roomLobby!.recv(87, 3000);
    expect(r2(p87)).toBe(0);
    expect(r4(p87)).toBeGreaterThan(0);
  });

  test("game win and active-game leave survive actual LS/GS re-login", async () => {
    // tester03 won round one, then left the active second round. The
    // socket teardown force-flushes one win and one loss, even at exp=0.
    const stored = new Database(DB_DIR + "/UserInfo02.db", { readonly: true });
    try {
      expect(stored.query("SELECT WIN, DRAW, LOSE, EXP FROM FxUserDynamic WHERE ID='tester03'").get())
        .toEqual({ Win: 1, Draw: 0, Lose: 1, Exp: 0 });
    } finally { stored.close(); }
    const again = await enterGame("tester03", { existingAccount: true });
    try {
      again.gs.send(67, (e) => e.str("tester03"));
      const p = await again.gs.recv(71);
      expect(r1(p)).toBe(1); expect(rstr(p)).toBe("tester03");
      rstr(p); rstr(p); r1(p);
      expect([r4(p), r4(p), r4(p)]).toEqual([1, 0, 1]);
      expect(r4(p)).toBe(0); expect(r4(p)).toBe(3000); expect(r2(p)).toBe(1);
    } finally { again.gs.close(); again.ls.close(); }
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

  test("CUser::CheckConnectingToSvr (4153B0): the freed/twice/same/unregistered/shutdown/premium table", () => {
    // three configured game servers: a normal one, a socket-less one and a
    // type-41 premium one (the center.cfg T41 entry)
    const svrs = [
      { socket: {} as object, nType: 10 },
      { socket: null, nType: 10 },
      { socket: {} as object, nType: 41 },
    ];
    const man = {
      GetSvrNo: (t: number) => (t === 10 ? 3 : 1),
      GetSvr: (t: number, i: number) => (t === 10 ? (svrs[i] ?? null) : null),
    } as unknown as CxCenter;
    const mk = () => new CenterCUser("tester", 10, -0x80000000, 1, 1, 0x7f000001); // sentinel = not seated yet
    expect(mk().CheckConnectingToSvr(man, 10, 0)).toBe(1); // the happy move
    const freed = mk();
    freed.fFree = 1;
    expect(freed.CheckConnectingToSvr(man, 10, 0)).toBe(0); // Set-freed
    const twice = mk();
    twice.m_fConnecting = 1;
    expect(twice.CheckConnectingToSvr(man, 10, 0)).toBe(0); // still connecting
    const same = mk();
    same.nSvrIdx = 0;
    same.nChannel = 10;
    expect(same.CheckConnectingToSvr(man, 10, 0)).toBe(0); // the current server again
    expect(mk().CheckConnectingToSvr(man, 10, 9)).toBe(0); // unregistered (idx >= count)
    expect(mk().CheckConnectingToSvr(man, 10, 1)).toBe(0); // the socket-less server
    expect(mk().CheckConnectingToSvr(man, 1, 0)).toBe(0); // GetSvr miss → shutdown
    expect(mk().CheckConnectingToSvr(man, 10, 2)).toBe(2); // type-41 premium without the ticket
    const ticketed = mk();
    ticketed.nAuthencode = 1;
    expect(ticketed.CheckConnectingToSvr(man, 10, 2)).toBe(1); // the ticket admits
  });

  test("CheckConnectionEstablished (415570): match/mismatch/not-connecting", () => {
    const u = new CenterCUser("tester", 10, -0x80000000, 1, 1, 0x7f000001);
    expect(u.CheckConnectionEstablished(10, 0)).toBe(0); // not connecting → report
    u.m_fConnecting = 1;
    u.nChannel = 10;
    u.nSvrIdx = 0;
    expect(u.CheckConnectionEstablished(10, 0)).toBe(1); // the match
    expect(u.CheckConnectionEstablished(10, 1)).toBe(0); // idx mismatch → report
    u.fFree = 1;
    expect(u.CheckConnectionEstablished(10, 0)).toBe(0); // Set-Freed
  });

  test("OnNotifyUDPLoss (185): the live :34093 relay — live target + seated asker → 54 [E1 seat]", () => {
    const session = Object.create(CGameSession.prototype) as CGameSession;
    session.m_rgPlayer = new Array(8).fill(null);
    const targetSocket = Object.create(CClientSocket.prototype) as CClientSocket;
    const askerSocket = Object.create(CClientSocket.prototype) as CClientSocket;
    const target = new CUser(targetSocket);
    const asker = new CUser(askerSocket);
    asker.m_nSlotIdx = 3;
    session.m_rgPlayer[1] = target;
    askerSocket.m_apUser = [asker];
    let relay: CSendPacket | null = null;
    (targetSocket as unknown as { SendPacket: (p: CSendPacket) => void }).SendPacket = (p) => {
      relay = p;
    };
    const n = new CReceivedPacket();
    n.Alloc(1);
    n.m_uLength = 1;
    n.m_pBlock[0] = 1; // the blamed seat — raw degree
    // the happy path: 54 [E1 askerSeat] to the target's socket
    session.OnNotifyUDPLoss(n, askerSocket);
    expect(relay).not.toBeNull();
    expect(relay!.m_nPacketType).toBe(GS_ClientSend.OnRequestUDPRelayRes);
    expect(relay!.m_pBlock[1]! ^ 0x5a).toBe(3); // the asker's seat (kPacketEncryptedCRC8)
    // a dead target (m_nFree) stays silent
    relay = null;
    target.m_nFree = 1;
    n.m_uOffset = 0;
    session.OnNotifyUDPLoss(n, askerSocket);
    expect(relay).toBeNull();
    // an unseated asker stays silent
    target.m_nFree = 0;
    asker.m_nSlotIdx = 8;
    n.m_uOffset = 0;
    session.OnNotifyUDPLoss(n, askerSocket);
    expect(relay).toBeNull();
  });
});

describe("guild strategy (type 77)", () => {
  /** a bare roster socket: no link, just the user list the strategy reads */
  function fakeSocket(users: CUser[]): CClientSocket {
    const socket = Object.create(CClientSocket.prototype) as CClientSocket;
    (socket as unknown as { m_apUser: (CUser | null)[] }).m_apUser = users;
    (socket as unknown as { m_nUserCount: number }).m_nUserCount = users.length;
    return socket;
  }
  function fakeUser(guildSn: number): CUser {
    const user = Object.create(CUser.prototype) as CUser;
    user.m_nGuildSN = guildSn;
    return user;
  }

  test("CreateSessionStrategy binds the guild variant only on MainSystem+8 == 77", () => {
    const main = CMainSystem.ms_pInstance!;
    const saved = main.m_nChannelType;
    try {
      main.m_nChannelType = 0;
      const plain = new CGameSession();
      expect(plain.m_pStrategy).toBeInstanceOf(CGameSessionStrategy);
      expect(plain.m_pStrategy.GetResultViewType()).toBe(0);
      main.m_nChannelType = 77;
      const guild = new CGameSession();
      expect(guild.m_pStrategy).toBeInstanceOf(CGuildSessionStrategy);
      expect(guild.m_pStrategy.GetResultViewType()).toBe(1); // the 163 view byte
    } finally {
      main.m_nChannelType = saved;
    }
  });

  test("the roster keys on the guild serial; the 88 and the team summary encode; the colour drags", () => {
    const main = CMainSystem.ms_pInstance!;
    const saved = main.m_nChannelType;
    main.m_nChannelType = 77;
    const session = new CGameSession();
    main.m_nChannelType = saved;
    const strategy = session.m_pStrategy as CGuildSessionStrategy;

    const userA = fakeUser(100);
    const userB = fakeUser(100);
    const userC = fakeUser(200);
    session.m_rgPlayer[0] = userA;
    session.m_rgPlayer[1] = userB;
    session.m_rgPlayer[2] = userC;
    session.SetColor(0, 0);
    session.SetColor(1, 0);
    session.SetColor(2, 3);
    const socketAB = fakeSocket([userA, userB]);
    const socketC = fakeSocket([userC]);

    strategy.AddPlayer(socketAB); // guild 100: two seats
    expect(strategy.m_nGuildCount).toBe(1);
    expect(strategy.m_argSerialNo[0]).toBe(100);
    expect(strategy.m_anPlayerCount[0]).toBe(2);
    strategy.AddPlayer(socketC); // guild 200: one seat
    expect(strategy.m_nGuildCount).toBe(2);
    expect(strategy.m_anPlayerCount[1]).toBe(1);

    // the 88: [E4 count][per guild: serial, playerCount, winCount]
    const p88 = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    strategy.EncodeGuildSessionInfo(p88);
    const view = { buf: p88.m_pBlock, off: 0, deg: p88.GetCipherDegree() } as CReceived;
    expect(r1(view)).toBe(88);
    expect(r4(view)).toBe(2);
    expect(r4(view)).toBe(100);
    expect(r4(view)).toBe(2);
    expect(r4(view)).toBe(0);
    expect(r4(view)).toBe(200);
    expect(r4(view)).toBe(1);
    expect(r4(view)).toBe(0);

    // SendSessionInfo rewrites the buffer as 88 and broadcasts it
    const sent: CSendPacket[] = [];
    session.SendPacket = (p: CSendPacket) => {
      sent.push(p);
    };
    const p2 = new CSendPacket(112, CipherDegree.kPacketEncryptedCRC8); // the map-idx packet the caller built
    strategy.SendSessionInfo(p2);
    expect(sent.length).toBe(1);
    expect(sent[0]!.m_nPacketType).toBe(88);

    // the appended team summary on an 83: two distinct seated colours
    // (0 for the guild-100 pair, 3 for guild 200)
    const p83 = new CSendPacket(83, CipherDegree.kPacketEncryptedCRC8);
    p83.Encode1(0); // stand-in for the real 83 body — the tail appends from byte 2
    strategy.MakeSimpleInfoPacket(p83);
    const tail = { buf: p83.m_pBlock, off: 2, deg: p83.GetCipherDegree() } as CReceived;
    expect(r4(tail)).toBe(2); // distinct seated colours {0, 3}
    expect(r4(tail)).toBe(1); // the colour-0 group holds one guild
    expect(r4(tail)).toBe(100);
    expect(r4(tail)).toBe(1); // the colour-3 group
    expect(r4(tail)).toBe(200);

    // OnSelectColor drags the same-guild seatmates, nobody else
    session.SetColor(1, 5); // the hook fires inside SetColor — slot 0 follows
    expect(session.GetColor(0)).toBe(5); // userA shares guild 100
    expect(session.GetColor(2)).toBe(3); // userC (guild 200) untouched

    // DestroyPlayer counts down per user and compacts the emptied guild
    strategy.DestroyPlayer(socketAB); // both seats of guild 100 leave at once
    expect(strategy.m_nGuildCount).toBe(1); // guild 100 gone, 200 shifted
    expect(strategy.m_argSerialNo[0]).toBe(200);
    strategy.DestroyPlayer(socketC);
    expect(strategy.m_nGuildCount).toBe(0);
  });

  test("the calculator books the rows; CGuild flushes through prUpdateGuildDynamic", () => {
    const calc = new CGuildDynInfoCalculator();
    calc.AddPlayer(0, 100);
    calc.AddPlayerExp(0, 250);
    calc.MarkPlayerResult(0, 0); // win
    calc.AddPlayer(1, 200);
    calc.AddPlayerExp(1, 45);
    calc.MarkPlayerResult(1, 2); // lose
    expect(calc.m_nGuildCount).toBe(2);
    expect(calc.IsWinGuild(100)).toBe(true);
    expect(calc.IsWinGuild(200)).toBe(false);

    const calls: number[][] = [];
    const guild = new CGuild({
      prUpdateGuildDynamic: (...args: number[]) => {
        calls.push([...args]);
        return 0;
      },
    } as unknown as ConstructorParameters<typeof CGuild>[0]) as CGuild;
    guild.m_nGuildSN = 7;
    guild.IncExp(45);
    guild.IncWin();
    guild.DeferFlushModifiedInfo(0); // dirty but only 1 game — held back
    expect(calls.length).toBe(0);
    guild.DeferFlushModifiedInfo(1); // forced
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([7, 45, 1, 0, 0]); // sn, exp, win, draw, lose
    expect(guild.m_fModified).toBe(0); // ResetDynamicInfo ran
    expect(guild.m_nGames).toBe(0);
  });
});

// ==================== guild channel end to end (T77, game3.cfg) ====================

describe("guild channel end to end (T77, the game3.cfg subprocess)", () => {
  test("the guild login fills the roster 105 and the room burst ends in the double 88", async () => {
    // the guild row the account portal would have created
    const guildDb = new Database(DB_DIR + "/Guild.db");
    guildDb.run("INSERT OR IGNORE INTO FxGuildAccount (sn, Name, MasterID, MarkRevision) VALUES (7777, 'e2eGuild', 'tester77', 3)");
    guildDb.run("INSERT OR IGNORE INTO FxGuildDynamic (SN, Exp, Win, Draw, Lose) VALUES (7777, 0, 0, 0, 0)");
    guildDb.close();

    // tester78 (guild-less) parks in the T77 lobby to watch the timer's 85
    const { gs: lobby } = await enterGame("tester78", { gsIdx: 3, gsPort: 17888 });
    lobby.send(83, (e) => {});
    await lobby.recv(15);

    // tester77 carries the guild: the account row is stamped between the LS
    // login and the GS entry (the GS reads GuildSn once, in packet 7's
    // prGetUserInfo, and CGuildTable::Insert loads the row from Guild.db).
    const { gs } = await enterGame("tester77", {
      gsIdx: 3,
      gsPort: 17888,
      guildSn: 7777,
      mid: () => {
        // 't' shards to GetUserHashNo('t')%6 = 2 → UserInfo02.db
        const info = new Database(DB_DIR + "/UserInfo02.db");
        info.run("UPDATE FxUserAccount SET GuildSn = 7777 WHERE ID = 'tester77'");
        info.close();
      },
    });

    // the guild strategy is bound (MainSystem+8 == 77), so the room create's
    // roster burst is 105 + 107×7 + 112 + the strategy's 88 + the tail re-send
    gs.send(80, (e) => {
      e.str("guild room"); // title
      e.str(""); // password
      e.u8(0); // game type
      e.u8(1); // one player
      e.u8(0); // bomber select
    });
    const res = await gs.recv(80);
    expect(r1(res)).toBe(0); // created
    expect(r2(res)).toBe(0); // room idx 0
    expect(r4(res)).toBeGreaterThan(0);
    const p105 = await gs.recv(105);
    expect(r1(p105)).toBe(0); // slot 0
    expect(r4(p105)).toBeGreaterThan(0); // the global serial
    expect(r1(p105)).toBe(1); // self
    expect(r1(p105)).toBe(0); // community
    expect(r1(p105)).toBe(255); // no category-4 deco
    const state = rbuf(p105, 3);
    expect(state[0]).toBe(0x02); // chief bit
    expect(state[1]).toBe(0); // bomber 0
    expect(state[2]).toBe(0); // color 0
    expect(rstr(p105)).toBe("tester77");
    r1(p105); // gender
    r2(p105); // look level
    r4(p105); // level-icon SN
    expect(r4(p105)).toBe(7777); // guild sn (prGetUserInfo read the stamped row)
    expect(r2(p105)).toBe(3); // the seeded mark revision
    for (let i = 0; i < 7; i++) await gs.recv(107);
    await gs.recv(112); // the Make's buffer first goes out as the plain 112
    const p88a = await gs.recv(88);
    expect(r4(p88a)).toBe(1); // one guild seated
    expect(r4(p88a)).toBe(7777); // its serial
    expect(r4(p88a)).toBe(1); // players
    expect(r4(p88a)).toBe(0); // wins
    const p88b = await gs.recv(88); // the tail PutPacket resends the rewritten buffer
    expect(r4(p88b)).toBe(1);
    expect(r4(p88b)).toBe(7777);
    expect(r4(p88b)).toBe(1);
    expect(r4(p88b)).toBe(0);

    // the lobby watcher gets the timer's 85 with the guild colour-group append
    const p85 = await lobby.recv(85, 3000);
    expect(r2(p85)).toBe(0); // room idx
    r4(p85); // the room serial
    expect(rstr(p85)).toBe("guild room");
    r1(p85); // hasPW
    r1(p85); // game type
    r1(p85); // cur
    r1(p85); // max
    // EncodeGuildSessionSimpleInfo: [E4 colours][per colour [E4 size][size×E4 serial]]
    expect(r4(p85)).toBe(1); // one distinct seated colour
    expect(r4(p85)).toBe(1); // the colour-0 group holds one guild
    expect(r4(p85)).toBe(7777); // the guild serial

    gs.close();
    lobby.close();
  });
});


// A03: real LS protocol, with a DB fault visible to the server's connection.
describe("atomic registration over the encrypted LS connection", () => {
  function sendRegistration(client: TestClient, id: string) {
    client.send(5, (e) => {
      e.str(id);
      e.str("fixture-pw");
      e.str("question");
      e.str("answer");
      e.str("identity");
      e.str("2000-01-01");
      e.str("display");
      e.str("mail");
      e.u8(1);
      e.u8(1);
      e.str("address");
      e.str("tel");
      e.str("profile");
      e.u8(1);
    });
  }
  function sendLogin(client: TestClient, id: string, password = "fixture-pw") {
    client.send(3, (e) => {
      e.u8(1);
      encStrInto(e, id, 0x11223344);
      encStrInto(e, password, 0x44332211);
      e.u32be(0);
    });
  }
  function rows(db: Database, id: string) {
    return ["FxUserAccount", "FxUserDynamic", "TxUserDynamic"].map((table) =>
      db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE ID=?`).get(id)!.n,
    );
  }
  for (const autoRegister of [false, true]) {
    test(`creation failure, clean retry and credential preservation; auto=${autoRegister}`, async () => {
      const id = autoRegister ? "atomiclogin" : "atomicnew";
      const file = `UserInfo${String(GetUserHashNo(id)).padStart(2, "0")}.db`;
      const info = new Database(`${DB_DIR}/${file}`);
      const client = new TestClient();
      const opcode = autoRegister ? 3 : 5;
      const send = () => autoRegister ? sendLogin(client, id) : sendRegistration(client, id);
      try {
        await client.connect(13838, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
        // Last companion INSERT fails AFTER making its row. All prior writes
        // must roll back too. This trigger is persistent so LS sees it.
        info.exec(`CREATE TRIGGER wire_registration_fault AFTER INSERT ON TxUserDynamic
          WHEN NEW.ID='${id}' BEGIN SELECT RAISE(FAIL,'registration fixture'); END`);
        send();
        const failure = await client.recv(opcode);
        expect(r1(failure)).toBe(1); // registration failure, or invalid-login result
        if (autoRegister) expect(r1(failure)).toBe(0); // failing user index
        expect(failure.off).toBe(failure.buf.length);
        expect(rows(info, id)).toEqual([0, 0, 0]);
        info.exec("DROP TRIGGER wire_registration_fault");

        send();
        const success = await client.recv(opcode);
        expect(r1(success)).toBe(0);
        expect(rows(info, id)).toEqual([1, 1, 1]);
        expect(info.query("SELECT Password,TotalConn FROM FxUserAccount WHERE ID=?").get(id))
          .toEqual({ Password: EncodePassword("fixture-pw"), TotalConn: autoRegister ? 1 : 0 });

        if (autoRegister) {
          sendLogin(client, id, "wrong-pw");
          const denied = await client.recv(3);
          expect([r1(denied), r1(denied)]).toEqual([1, 0]);
          expect(denied.off).toBe(denied.buf.length);
        } else {
          sendRegistration(client, id);
          const duplicate = await client.recv(5);
          expect(r1(duplicate)).toBe(1);
          expect(duplicate.off).toBe(duplicate.buf.length);
        }
        expect(rows(info, id)).toEqual([1, 1, 1]);
        expect(info.query("SELECT Password,TotalConn FROM FxUserAccount WHERE ID=?").get(id))
          .toEqual({ Password: EncodePassword("fixture-pw"), TotalConn: autoRegister ? 1 : 0 });
      } finally {
        info.exec("DROP TRIGGER IF EXISTS wire_registration_fault");
        client.close();
        info.close();
      }
    });
  }
});


// A04: real encrypted LS -> Center transfer, then an overdue real GS report.
// Backdate only this user's deadline; do not wait 18 seconds or change the
// global clock while the rest of the live suite is running.
test("expired transfer rejects a late GS establishment without resurrecting the Center user", async () => {
  const name = "tdeadline";
  const ls = new TestClient();
  const gs = new TestClient();
  try {
    await ls.connect(13838, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
    ls.send(3, e => {
      e.u8(1);
      encStrInto(e, name, 0x11223344);
      encStrInto(e, name, 0x44332211);
      e.u32be(0);
    });
    const login = await ls.recv(3);
    expect(r1(login)).toBe(0); // retained auto-registration requirement
    expect(r2(login)).toBe(1); rstr(login); expect(r1(login)).toBe(1);
    const serial = r4(login);
    ls.send(6, e => { e.u8(10); e.u32be(0); e.u16(7); });
    const transfer = await ls.recv(6);
    expect([r1(transfer), r1(transfer), r4(transfer), r4(transfer), r2(transfer)])
      .toEqual([1, 10, 0, 0x7f000001, 14848]);
    const user = center.serialTable.get(serial)!;
    expect(user.m_strName).toBe(name);
    expect([user.m_fConnecting, user.nChannel, user.nSvrIdx]).toEqual([1, 10, 0]);
    const target = center.GetSvr(10, 0)!;
    const before = target.nConnNo;
    user.nConnectStamp = (GetTickCount() - CONNECTION_TIMEOUT_MS - 1) >>> 0;
    for (let i = 0; i < CONNECTING_LIST_BUCKET_COUNT; i++) center.DeleteConnectionTimeoutUser();
    expect([user.fFree, target.nConnNo]).toEqual([1, before - 1]);
    expect(center.serialTable.has(serial)).toBe(false);
    expect(center.userTable.has(name)).toBe(false);

    await gs.connect(14848, { sndDeg: CipherDegree.kPacketEncryptedCRC8, rcvDeg: CipherDegree.kPacketEncryptedCRC8 });
    await gs.recv(0);
    const admission = gs.recv(210, 3000).then(() => null, (error: unknown) => error);
    gs.send(7, e => {
      e.u8(1); e.str(name); e.u32be(serial); e.u32be(0);
      e.u32be(0x11221122); e.u32be(0); e.u8(1);
    });
    const failure = await admission;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("socket closed by peer");
    expect(gs.closed).toBe(true);
    expect(center.serialTable.has(serial)).toBe(false);
    expect(center.userTable.has(name)).toBe(false);
    expect(target.nConnNo).toBe(before - 1);
  } finally {
    ls.close(); gs.close();
  }
});

// Unlike shop.test.ts's isolated fixtures, do NOT inject Center users or arm
// their connecting state here: LS -> GS -> Shop must establish it on the wire.
test("GS -> Shop -> original CAItem, points + afro game-Money purchase -> GS and relogin", async () => {
  const billingDB = new CDBMan(DB_DIR);
  const billingStore = new BillingStore(billingDB);
  const billingServer = new BillingServer(billingStore);
  billingServer.listen();
  registerLocalBilling(billingDB, { enabled: true, host: "127.0.0.1", port: billingServer.port });
  const ready = Promise.withResolvers<void>();
  const shopProc = Bun.spawn([
    process.execPath, "--eval",
    `await import('./src/main.ts'); process.send?.('ready');`,
    "--", "--only", "shop", "--cfg", DIR + "/shop-transfer.cfg", "--db", DB_DIR,
  ], {
    cwd: DIR + "/..", stdout: "ignore", stderr: "inherit",
    env: { ...process.env, TC_NOWEB: "1" },
    ipc: message => { if (message === "ready") ready.resolve(); },
  });
  const deadline = setTimeout(() => ready.reject(new Error("Shop startup timeout")), 4000);
  void shopProc.exited.then(code => ready.reject(new Error(`Shop exited: ${code}`)));
  const shopClient = new TestClient();
  const returnedGS = new TestClient();
  let entered: Awaited<ReturnType<typeof enterGame>> | undefined;
  try {
    await ready.promise;
    // Production main, not this fixture, imported the original CAItem backup.
    expect(billingDB.item.query("SELECT COUNT(*) AS n FROM FxStock WHERE IsValid>0").get()).toEqual({ n: 549 });
    expect(billingDB.item.query("SELECT BackupSet FROM CAItemImport").get()).toEqual({ BackupSet: 1 });
    GSItemMan.ms_pInstance!.Init(billingDB); // existing GS refreshes the shared catalog as on restart/CM14
    for (let i = 0; i < 100 && !center.GetSvr(11, 0)?.socket; i++) await Bun.sleep(10);
    expect(center.GetSvr(11, 0)?.socket).toBeTruthy();
    const name = "shopwalk";
    entered = await enterGame(name, { mid: () => { billingDB.prResetMoney(name, 200000); } });
    const { ls, gs, sn } = entered;
    const user = center.serialTable.get(sn)!;
    expect([user.m_fConnecting, user.nChannel, user.nSvrIdx]).toEqual([0, 10, 0]);
    ls.close(); // leaving LS must not remove the now-established GS user
    gs.send(6, e => { e.u8(11); e.u32be(0); }); // no version word for Shop
    const redirect = await gs.recv(6); // literal native id; fails with the old id 2
    expect(r1(redirect)).toBe(1); expect(r1(redirect)).toBe(11);
    expect(r4(redirect)).toBe(0); expect(r4(redirect)).toBe(0x7f000001);
    const shopPort = r2(redirect);
    expect(shopPort).toBe(19811);
    expect(redirect.off).toBe(redirect.buf.length);
    expect(gs.hasPending(2)).toBe(false);
    expect([user.m_fConnecting, user.nChannel, user.nSvrIdx]).toEqual([1, 11, 0]);
    gs.close(); // real source disconnect, not just a parallel Shop login
    await shopClient.connect(shopPort, { sndDeg: 2, rcvDeg: 2 });
    await shopClient.recv(0);
    shopClient.send(7, e => {
      e.u8(1); e.str(name); e.u32be(sn);
      e.u32be(0xffffffff); e.u32be(0xffffffff); e.u8(0);
    });
    const info = await shopClient.recv(18);
    expect(r1(info)).toBe(0); // initial-info premium flag: ordinary account
    expect(center.serialTable.get(sn)).toBe(user);
    expect([user.m_fConnecting, user.nChannel, user.nSvrIdx]).toEqual([0, 11, 0]);
    expect(shopClient.closed).toBe(false);
    for (const [request, response, count] of [[213, 200, 549], [215, 205, 112], [220, 213, 988]]) {
      shopClient.send(request, () => {});
      const p = await shopClient.recv(response);
      const wrapped = rbuf(p, r4(p));
      expect(wrapped[0]).toBe(0x18);
      const raw = wrapped[5] === 1 ? inflateSync(wrapped.subarray(10)) : Buffer.from(wrapped.subarray(6));
      expect(raw.readUInt16LE()).toBe(count);
      expect(p.off).toBe(p.buf.length);
    }

    // No fake billing replies: use the actual independently listening service.
    shopClient.send(224, e => { e.str(name); e.str("wrong-password"); });
    const denied = await shopClient.recv(209);
    expect(r1(denied)).toBe(13);
    billingStore.credit(name, 100, "e2e-starting-credit");
    shopClient.send(224, e => { e.str(name); e.str(name); });
    const authorized = await shopClient.recv(209);
    expect(r1(authorized)).toBe(12); expect(r4(authorized)).toBeGreaterThan(0); expect(r4(authorized)).toBeGreaterThan(0);
    const initialCash = await shopClient.recv(203);
    expect([r1(initialCash), r4(initialCash)]).toEqual([1, 100]);
    shopClient.send(206, e => { e.u16(1102); });
    const purchase = await shopClient.recv(204);
    expect(r1(purchase)).toBe(0); expect(purchase.buf.length - purchase.off).toBe(8);
    shopClient.send(205, () => {});
    const remaining = await shopClient.recv(203);
    expect([r1(remaining), r4(remaining)]).toEqual([1, 71]);
    expect(billingStore.inspect(name).balance).toBe(71);
    expect(billingDB.inventory[GetUserHashNo(name)].query("SELECT Amount FROM FxUserInventory WHERE UserID=? AND ItemSN=1").get(name))
      .toEqual({ Amount: 15 });

    // Reported wire 94 b2 fb: E2 0xb2fb ^ 0xa569 = original stock 6034.
    // Category-12 afro costs GAME Money, not the local billing wallet.
    shopClient.send(206, e => e.u16(6034));
    const afro = await shopClient.recv(204);
    expect(r1(afro)).toBe(0); expect(afro.buf.length - afro.off).toBe(8);
    expect((billingDB.prGetUserDynamic(name) as { Money: number }).Money).toBe(70000);
    expect(billingStore.inspect(name).balance).toBe(71);
    const ownedAfro = billingDB.GetUserInventoryRows(name).find(r => r.ItemSN === 678)!;
    expect([ownedAfro.Amount, ownedAfro.Slot, ownedAfro.LevelCreated]).toEqual([1, 255, 2000]);
    expect(Math.round((Date.parse(ownedAfro.DateCreated!) - Date.now()) / 86400000)).toBe(100000);
    shopClient.send(206, e => e.u16(6034));
    expect(r1(await shopClient.recv(204))).toBe(4); // already owned, not the bogus "-1" limit
    expect((billingDB.prGetUserDynamic(name) as { Money: number }).Money).toBe(70000);

    // Follow the reciprocal redirect instead of leaving a pending transfer.
    shopClient.send(6, e => { e.u8(10); e.u32be(0); }); // Shop has no version word
    const back = await shopClient.recv(6);
    expect([r1(back), r1(back), r4(back), r4(back), r2(back)])
      .toEqual([1, 10, 0, 0x7f000001, 14848]);
    expect(back.off).toBe(back.buf.length);
    expect([user.m_fConnecting, user.nChannel, user.nSvrIdx]).toEqual([1, 10, 0]);
    shopClient.close();
    await returnedGS.connect(14848, { sndDeg: 2, rcvDeg: 2 });
    await returnedGS.recv(0);
    returnedGS.send(7, e => {
      e.u8(1); e.str(name); e.u32be(sn); e.u32be(0);
      e.u32be(0x11221122); e.u32be(0); e.u8(1);
    });
    expect(r1(await returnedGS.recv(210))).toBe(1); // CM12 enabled the actual inventory loader
    await returnedGS.recv(202);
    const delivered = await returnedGS.recv(201);
    expect([r1(delivered), r2(delivered)]).toEqual([1, 2]); // needle + original afro
    expect([r4(delivered), r1(delivered), r4(delivered), rstr(delivered)]).toEqual([1, 255, 15, ""]);
    rbuf(delivered, 8); // needle's native variant date
    expect([r4(delivered), r1(delivered), r4(delivered), rstr(delivered)]).toEqual([678, 255, 1, ""]);
    expect(delivered.buf.length - delivered.off).toBe(8); // afro's native variant date
    expect(billingDB.GetUserInventoryRows(name).find(r => r.ItemSN === 678)?.Amount).toBe(1);
    expect(billingDB.inventory[GetUserHashNo(name)].query("SELECT Amount FROM FxUserInventory WHERE UserID=? AND ItemSN=1").get(name))
      .toEqual({ Amount: 15 }); // GS loading must not expire/delete a newly bought permanent item
    expect(center.serialTable.get(sn)).toBe(user);
    expect([user.m_fConnecting, user.nChannel, user.nSvrIdx]).toEqual([0, 10, 0]);

    // Full fresh login too: no reseeding, price edits, expiry bypass or cached
    // Shop inventory. Both purchases must survive a second GS DB load.
    returnedGS.close(); ls.close();
    for (let i = 0; i < 100 && center.serialTable.has(sn); i++) await Bun.sleep(10);
    expect(center.serialTable.has(sn)).toBe(false);
    entered = await enterGame(name, { existingAccount: true, onInventory: p => {
      expect([r1(p), r2(p)]).toEqual([1, 2]);
      for (const [item, amount] of [[1, 15], [678, 1]]) {
        expect([r4(p), r1(p), r4(p), rstr(p)]).toEqual([item, 255, amount, ""]);
        rbuf(p, 8);
      }
      expect(p.off).toBe(p.buf.length);
    } });
    expect((billingDB.prGetUserDynamic(name) as { Money: number }).Money).toBe(70000);
    expect(billingStore.inspect(name).balance).toBe(71);
    expect(billingDB.GetUserInventoryRows(name).map(r => [r.ItemSN, r.Amount])).toEqual([[1, 15], [678, 1]]);
  } finally {
    clearTimeout(deadline);
    entered?.ls.close(); entered?.gs.close(); shopClient.close(); returnedGS.close();
    shopProc.kill(); await shopProc.exited;
    billingServer.close(); billingDB.Close();
  }
}, 10000);

test("original owned cosmetics survive GS reentry and reach native 201, 71 and room 105 fields", async () => {
  // The preceding production Shop startup imported the real original catalog.
  // Seed owned rows only, not fake catalog definitions or a billing purchase.
  const db = new CDBMan(DB_DIR), name = "decolook";
  const itemSNs = [3, 16, 95, 169, 549, 20001]; // emotion, icon, fake level, slot deco, char deco, bomb
  const inventoryDB = db.inventory[GetUserHashNo(name)];
  const readInventory = (p: CReceived) => {
    expect([r1(p), r2(p)]).toEqual([1, 6]);
    for (const item of itemSNs) {
      expect([r4(p), r1(p), r4(p), rstr(p)]).toEqual([item, item === 3 ? 255 : 0, 1, ""]);
      expect(rbuf(p, 8).length).toBe(8); // A13 date value/timezone is separate
    }
    expect(p.off).toBe(p.buf.length);
  };
  let entered: Awaited<ReturnType<typeof enterGame>> | undefined;
  try {
    for (let round = 0; round < 2; round++) {
      entered = await enterGame(name, {
        existingAccount: round > 0, onInventory: readInventory,
        mid: round === 0 ? () => {
          for (const sn of [...itemSNs, 170]) {
            const stock = db.item.query<{ SN: number }, [number]>("SELECT SN FROM FxStock WHERE ItemSN=? ORDER BY SN LIMIT 1").get(sn);
            // Original bomb 20001 has a definition but no remaining stock row.
            // Native GS still accepts already-owned items without a store listing.
            if (sn === 20001) expect(stock).toBeNull(); else expect(stock).not.toBeNull();
            inventoryDB.query(`INSERT INTO FxUserInventory(UserID,ItemSN,StockSN,Slot,Amount,DateCreated,LevelCreated)
              VALUES(?,?,?,?,1,?,2000)`).run(name, sn, stock?.SN ?? 0, sn === 3 ? 255 : 0,
                sn === 170 ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z");
          }
          inventoryDB.query("INSERT INTO FxUserInventory(UserID,ItemSN,Amount,DateCreated,LevelCreated) VALUES(?,999999,1,'2000-01-01',0)").run(name);
        } : undefined,
      });
      const { gs, ls, sn } = entered;
      gs.send(67, e => e.str(name)); const detail = await gs.recv(71);
      expect([r1(detail), rstr(detail), rstr(detail), rstr(detail), r1(detail)]).toEqual([1, name, name, "", 1]);
      expect([r4(detail), r4(detail), r4(detail), r4(detail), r4(detail), r2(detail), r4(detail)])
        .toEqual([0, 0, round, 0, 3000, 1, 0]); // native phase-0 room exit adds a loss (A21)
      expect([r1(detail), r4(detail), r2(detail), r1(detail), r4(detail), r1(detail)])
        .toEqual([10, 0, 65535, 0, 16, 0]);
      // Literal native SendGameSlotInfo: E1 count, E1 kind, E2 picture, E2 fake level, E2 category-3 count/IDs.
      expect([r1(detail), r1(detail), r2(detail), r2(detail), r2(detail), r2(detail)]).toEqual([1, 1, 1, 65521, 1, 3]);
      expect(detail.off).toBe(detail.buf.length);

      gs.send(80, e => { e.str("original decorations"); e.str(""); e.u8(0); e.u8(1); e.u8(0); });
      const created = await gs.recv(80); expect(r1(created)).toBe(0);
      const player = await gs.recv(105);
      expect([r1(player), r4(player), r1(player), r1(player), r1(player)]).toEqual([0, sn, 1, 0, 255]);
      rbuf(player, 3);
      expect([rstr(player), r1(player), r2(player), r4(player), r4(player), r2(player)])
        .toEqual([name, 1, 1, 16, 0, 0]);
      expect([r1(player), r1(player), r1(player), r2(player)]).toEqual([1, 0, 1, 1]);
      expect([r1(player), r1(player), r4(player), r4(player), r4(player), r4(player)])
        .toEqual([1, 0, 0xffffffff, 1, 1, 1]);
      expect(player.off).toBe(player.buf.length);
      expect(db.GetUserInventoryRows(name).map(r => r.ItemSN)).toEqual([...itemSNs, 999999]);
      gs.close(); ls.close();
      for (let i = 0; i < 100 && center.serialTable.has(sn); i++) await Bun.sleep(10);
      expect(center.serialTable.has(sn)).toBe(false);
    }
  } finally { entered?.gs.close(); entered?.ls.close(); db.Close(); }
}, 10000);
