/**
 * CxUtil (FXUS) e2e — the admin-tool relay against a live center.
 *
 * Covered (all decompile-anchored, CxUtil.exe.c / CxCenter.exe.c):
 *  - the accept hello [E2 3][E2 5][E4 headerType][EStr url] — note the 5,
 *    unlike the game/login servers' 7 (CMainSystem::OnConnEstablished)
 *  - CM 12 at attach: every class gets SendInitialAttr (register vtbl+20)
 *  - CUserPool::OnEstimateRTT (20 → 20, [E4] echoed)
 *  - CMainPool::OnConnEstablished (7): the [E1 n][n×(EStr, E4)] tool login,
 *    the CLocalUserTable duplicate-name rollback and the disconnect
 *  - the relays 25/26/31/32/64/66 and the center-side answers
 *    (CM 8 / CM 13 / CM 14 / CM 1→11 / CM 7→10→64)
 */
import { CONNECTION_TIMEOUT_MS, CONNECTING_LIST_BUCKET_COUNT } from "../src/Center/Defs.ts";
import { GetTickCount } from "../src/core/GetTickCount.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCxCenterApp, CLocalServerMan, CUser } from "../src/Center/CxCenter.ts";
import { CServerConfig, CXCENTER_STR_KEYS, CXLOGIN_STR_KEYS } from "../src/core/ServerConfig.ts";
import { CSendPacket } from "../src/core/Packet.ts";
import { CDBMan } from "../src/db/DBMan.ts";
import { CLocalSocket } from "../src/common/LocalSocket.ts";
import { SVRCLASS_GAME, SVRCLASS_UTIL } from "../src/core/protocol/CenterProtocol.ts";
import {
  CCenterProcess,
  CClientSocket as LsClientSocket,
  CLoginPool,
} from "../src/LS/CxLogin.ts";
import { S2C_LoginNoticePacket } from "../src/core/protocol/PacketIDs.ts";
import { CMultiServer } from "../src/LS/MultiServer.ts";
import {
  CClientSocket,
  CLocalUserTable,
  CMainPool,
  CMainSystem,
  main as utilMain,
} from "../src/FXUS/CxUtil.ts";
import type { CReceivedPacket } from "../src/core/Packet.ts";
import { TestClient, r1, r2, r4, rstr } from "./TestClient.ts";

const DIR = join(tmpdir(), "util-test-");
const TOOL_PORT = 8128; // CListenThread::Proc's literal 0x1FC0

let centerApp: CCxCenterApp;
let center: CLocalServerMan;
let utilApp: Awaited<ReturnType<typeof utilMain>> | null = null;
/** every CM packet the fake game-server link receives. */
const linkInbox: { id: number; n: CReceivedPacket }[] = [];
let fakeGs: CLocalSocket | null = null;

async function waitLink(wantId: number, timeoutMs = 4000): Promise<CReceivedPacket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const idx = linkInbox.findIndex((p) => p.id === wantId);
    if (idx >= 0) return linkInbox.splice(idx, 1)[0]!.n;
    if (Date.now() > deadline) throw new Error(`timeout waiting for CM ${wantId}`);
    await Bun.sleep(5);
  }
}

beforeAll(async () => {
  const dir = mkdtempSync(DIR);
  writeFileSync(
    join(dir, "util-center.cfg"),
    [
      "MultiServerIDX = 0",
      "CenterPort = 23828",
      "FXAttrShop = 0",
      "FXAttrCommunity = 0",
      "WebLog = C:\\userlog.html",
      "TextLog = C:\\userlog.txt",
      "CommunityLog = C:\\communitylog.txt",
      "AuthenIP = 127.0.0.1",
      "AuthenPort = 3773",
      "GameDomain = 0",
      "LSNumber = 0",
      "FXGSNumber = 1",
      "FXGSIP0   = 127.0.0.1",
      "FXGSPort0 = 15848",
      "FXGSName0 = UtilTestGS",
      "FXGSMaxUser0 = 400",
      "FXGSType0 = 0",
      "FXGSCommunity0 = 0",
      "FXGSEnterableType0 = 0",
      "FXSSNumber = 0",
      "FXUSNumber = 1",
      "FXUSIP0   = 127.0.0.1",
      "FXUSPort0 = 18128",
      "",
    ].join("\n"),
    "latin1",
  );
  writeFileSync(
    join(dir, "util0.cfg"),
    [
      "ServerIndex     = 0",
      "ServerName\t= UtilServerTest",
      "ServerIP\t= 127.0.0.1",
      "ServerPort      = 18128",
      "",
      "CenterIP\t= 127.0.0.1",
      "CenterPort\t= 23828",
      "",
    ].join("\n"),
    "latin1",
  );

  const ccfg = new CServerConfig(CXCENTER_STR_KEYS, true);
  ccfg.Init(join(dir, "util-center.cfg"));
  CServerConfig.ms_pInstance = ccfg;
  centerApp = new CCxCenterApp(ccfg);
  center = centerApp.localServerMan;
  center.Init();
  centerApp.listenThread.Start();

  utilApp = await utilMain(join(dir, "util0.cfg"));
  for (let i = 0; i < 200 && !center.GetSvr(SVRCLASS_UTIL, 0)?.socket; i++) await Bun.sleep(5);
  expect(center.GetSvr(SVRCLASS_UTIL, 0)?.socket).toBeTruthy();
  // the register's vtbl+20 SendInitialAttr flips CMainSystem+4 from -1 to 0
  for (let i = 0; i < 200 && CMainSystem.ms_pInstance!.m_nFXAttr === -1; i++) await Bun.sleep(5);
  expect(CMainSystem.ms_pInstance!.m_nFXAttr).toBe(0);

  // a fake game server link for the broadcast/directed-message assertions
  fakeGs = new CLocalSocket({
    onPacket: (_sock, packet) => linkInbox.push({ id: packet.Decode1(), n: packet }),
  });
  await fakeGs.ConnectToCenter("127.0.0.1", 23828, SVRCLASS_GAME, 0, 1, 1);
  for (let i = 0; i < 200 && !center.GetSvr(SVRCLASS_GAME, 0)?.socket; i++) await Bun.sleep(5);
  expect(center.GetSvr(SVRCLASS_GAME, 0)?.socket).toBeTruthy();
});

afterAll(() => {
  fakeGs?.Close();
  fakeGs = null;
  utilApp?.CleanUp();
  utilApp = null;
  centerApp.CleanUp();
});

/** A tool that already consumed its accept hello. */
async function connectTool(): Promise<TestClient> {
  const c = new TestClient();
  await c.connect(TOOL_PORT);
  await c.recv(0); // the accept hello is pending; consume it
  return c;
}

describe("util server (CxUtil)", () => {
  test("accept hello is [E2 3][E2 5][E4 headerType][EStr url]", async () => {
    const c = new TestClient();
    await c.connect(TOOL_PORT);
    const p0 = await c.recv(0);
    expect(r2(p0)).toBe(3);
    expect(r2(p0)).toBe(5); // the util's own hello value (GS/LS send 7)
    p0.off += 4; // header type
    expect(rstr(p0)).toBe("ftp://patch.nexon.co.kr/ca");
  });

  test("RTT echo (20 → 20, [E4] round-trips)", async () => {
    const c = await connectTool();
    c.send(20, (e) => e.u32be(0x11223344));
    const p = await c.recv(20);
    expect(r4(p)).toBe(0x11223344);
  });

  test("packet 7 tool login, then 64 → center MC 7 → CM 10 → tool 64", async () => {
    // the center-side user the lookup resolves against (as the LS flow
    // would have registered it: on game server 0, session 4242)
    const cu = new CUser("op1", SVRCLASS_GAME, 0, 5001, 0, 0, center);
    cu.nSessionIdx = 4242;
    center.globalUserTable.userTable.set("op1", cu);
    center.globalUserTable.serialTable.set(5001, cu);

    const t = await connectTool();
    t.send(7, (e) => {
      e.u8(2); // two identities
      e.str("op1");
      e.u32be(5001);
      e.str("op2");
      e.u32be(5002);
    });
    await Bun.sleep(30);
    // the pool now holds the socket and the table both identities
    expect(CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(5001)!.GetName()).toBe("op1");
    expect(CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(5002)!.GetName()).toBe("op2");
    // the pool holds only sockets that completed a packet-7 login
    expect(CMainPool.ms_pInstance!.m_setSocket.size).toBe(1);

    // 64 → center MC 7 (util-private, never rebroadcast) → CM 10 → tool 64
    t.send(64, (e) => e.str("op1"));
    const res = await t.recv(64);
    expect(r1(res)).toBe(SVRCLASS_GAME); // the user's server class
    expect(r4(res)).toBe(4242); // the session idx
  });

  test("25 → CM 8 [EStr] to the login/game/shop lists", async () => {
    const t = await connectTool();
    t.send(25, (e) => e.str("maintenance soon"));
    const cm8 = await waitLink(8);
    expect(cm8.DecodeStr()).toBe("maintenance soon");
  });

  test("26 → CM 8 [EStr] to the requested server type", async () => {
    const t = await connectTool();
    t.send(26, (e) => {
      e.u8(SVRCLASS_GAME);
      e.str("hello gs");
    });
    const cm8 = await waitLink(8);
    expect(cm8.DecodeStr()).toBe("hello gs");
  });

  test("31 → CM 13 [EStr]", async () => {
    const t = await connectTool();
    t.send(31, (e) => e.str("system message"));
    const cm13 = await waitLink(13);
    expect(cm13.DecodeStr()).toBe("system message");
  });

  test("32 → CM 1 name-keyed → CM 11 [E4 SN] to the user's server", async () => {
    const cu = new CUser("op2", SVRCLASS_GAME, 0, 5002, 0, 0, center);
    center.globalUserTable.userTable.set("op2", cu);
    center.globalUserTable.serialTable.set(5002, cu);

    const t = await connectTool();
    t.send(32, (e) => e.str("op2"));
    const cm11 = await waitLink(11);
    expect(cm11.Decode4()).toBe(5002);
    // the util's delete has no residency check — the user is gone
    expect(center.globalUserTable.userTable.has("op2")).toBe(false);
  });

  test("66 → empty CM 14 to the game + shop lists", async () => {
    const t = await connectTool();
    t.send(66, (e) => e.u8(11));
    const cm14 = await waitLink(14);
    // CLocalServerMan::OnSystemCmd sends CSendPacket(14) with no payload
    expect(cm14.m_uLength).toBe(cm14.m_uOffset);
  });

  test("duplicate tool name rolls the batch back and drops the socket", async () => {
    const t = await connectTool();
    t.send(7, (e) => {
      e.u8(2);
      e.str("fresh1");
      e.u32be(6001);
      e.str("op1"); // already resident → Insert fails on the second row
      e.u32be(5001);
    });
    await Bun.sleep(30);
    expect(t.closed).toBe(true); // the socket is dropped
    // the rolled-back row is gone, the resident one untouched
    expect(CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(6001)).toBeNull();
    expect(CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(5001)!.GetName()).toBe("op1");
  });

  test("unknown tool packets only answer the RTT slot (CUserPool::OnPacket)", async () => {
    const t = await connectTool();
    t.send(99, (e) => e.u8(1)); // not 20 → CUserPool::OnPacket ignores it
    t.send(20, (e) => e.u32be(7));
    const p = await t.recv(20);
    expect(r4(p)).toBe(7);
  });

  test("accept-time users get counter serials and join the table", async () => {
    // the 4 tools above: CMainSystem+32 counted every accept
    expect(CMainSystem.ms_pInstance!.m_nConnNo).toBeGreaterThanOrEqual(5);
    expect(CClientSocket.ms_nLocalSerialNo).toBeGreaterThanOrEqual(6);
  });
});

describe("center timer machinery (CTimerThread)", () => {
  test("the %2 tick broadcasts CM 4 [E4 gsCount][E4 connNo] to the LS+GS links", async () => {
    centerApp.timerThread.Start();
    // drain whatever the periodic broadcast already pushed
    const before = linkInbox.filter((p) => p.id === 4).length;
    linkInbox.length = 0;
    void before;
    // the ctor's SetSvrIdx carries the conn counters (CUser 00415640)
    const svr = center.GetSvr(SVRCLASS_GAME, 0)!;
    const connBefore = svr.nConnNo;
    const cu = new CUser("timerop", SVRCLASS_GAME, 0, 7003, 0, 0, center);
    center.globalUserTable.userTable.set("timerop", cu);
    center.globalUserTable.serialTable.set(7003, cu);
    expect(svr.nConnNo).toBe(connBefore + 1); // the ctor's IncConn
    cu.m_fConnecting = 1; // fixture: successful check arms flag before the move
    cu.SetConnectingToSvr(SVRCLASS_GAME, 0, center);
    expect(svr.nConnNo).toBe(connBefore + 1); // the same-server move nets zero
    const cm4 = await waitLink(4, 2500);
    expect(cm4.Decode4()).toBe(1); // FXGSNumber
    expect(cm4.Decode4()).toBe(svr.nConnNo); // the live conn count
  });

  test("the timeout sweep processes one serial %6 bucket per call (0x445C stamp)", async () => {
    const cu = center.globalUserTable.userTable.get("timerop")!;
    const connBefore = center.GetSvr(SVRCLASS_GAME, 0)!.nConnNo;
    cu.nConnectStamp = (GetTickCount() - CONNECTION_TIMEOUT_MS - 1) >>> 0; // strictly overdue
    // six calls cover every shard exactly once
    for (let i = 0; i < CONNECTING_LIST_BUCKET_COUNT; i++) center.globalUserTable.DeleteConnectionTimeoutUser();
    expect(center.globalUserTable.userTable.has("timerop")).toBe(false);
    expect(center.globalUserTable.serialTable.has(7003)).toBe(false);
    // SetFree's DecConn undoes exactly the ctor's IncConn
    expect(center.GetSvr(SVRCLASS_GAME, 0)!.nConnNo).toBe(connBefore - 1);
    // Connecting-list placement is by serial, NOT the account name/DB hash.
    expect(cu.fFree).toBe(1);
  });
});

/**
 * CxLogin data-plane units — the client-11 extra-info sources and the
 * timeout sweep (CxLogin.exe.c).
 *
 *  - CCenterProcess::UpdateFxMessage (7961) — FxMessage MessageUse = 1,
 *    wire [E2 n][n×(E1 0, E1 attr, EStr message)]
 *  - CCenterProcess::UpdatePremiumChannelMapSelReward (5328) — FxUserOptions
 *    "PRECHMAPREWARD", WORD on the wire
 *  - CCenterProcess::UpdateAdvertisement (7742) — the hour-window selection
 *    (wrap past midnight when end < start), Param4 repeats, the aFull gate
 *    and the dword_49F61C rotation over the SELECTED pool
 *  - CUserPool::DisconnectTimeoutSocket (23685) — 0x7530 ms since the last
 *    client-20 stamp
 */
describe("login server (CxLogin)", () => {
  let db: CDBMan;
  let center: CCenterProcess;
  let pool: CLoginPool;
  const dir = mkdtempSync(join(tmpdir(), "ls-test-"));

  beforeAll(() => {
    const cfg = new CServerConfig(CXLOGIN_STR_KEYS);
    cfg.Init(join(import.meta.dir, "login.cfg"));
    CServerConfig.ms_pInstance = cfg;
    db = new CDBMan(dir, 1);
    const multiServer = new CMultiServer();
    center = new CCenterProcess(null as unknown as CLoginPool, multiServer, db);
    center.m_cfg = cfg;
    pool = new CLoginPool(center, db, multiServer);
    center.AttachPool(pool);
  });

  afterAll(() => {
    center.Stop();
    db.Close();
    CLoginPool.ms_pInstance = null;
  });

  test("client 11 carries the fx messages and the premium reward", () => {
    db.config.run(
      "INSERT INTO FxMessage (Message, MessageAttr, MessageUse) VALUES ('welcome', 7, 1), ('hidden', 9, 0)",
    );
    db.config.run("UPDATE FxUserOptions SET VALUE = 0x1234 WHERE NAME = 'PRECHMAPREWARD'");
    center.UpdateFxMessage();
    center.UpdatePremiumChannelMapSelReward();
    const p = new CSendPacket(S2C_LoginNoticePacket.OnChannelsExtraInfo, 0);
    center.MakeChannelsExtraInfoPacket(p);
    const b = p.m_pBlock;
    let o = 1; // the ctor's type byte
    const r2 = (): number => (b[o++]! << 8) | b[o++]!; // Encode2 is big-endian
    const rstr = (): string => {
      const n = r2();
      const s = new TextDecoder("latin1").decode(b.subarray(o, o + n));
      o += n;
      return s;
    };
    expect(rstr()).toBe(""); // no advertisement rows seeded yet
    expect(r2()).toBe(0); // adv Param1
    expect(r2()).toBe(0); // adv Param2
    expect(r2()).toBe(60);
    expect(o).toBe(9); // type + EStr("") + 3×E2
    o += 1; // guild list count 0
    o += 1 + 4; // NDA count 1 + ip (login.cfg NDANumber = 1)
    o += 1 + 4; // relay count 1 + ip (login.cfg RelayNumber = 1)
    const fxCount = r2();
    expect(fxCount).toBe(1); // MessageUse = 0 excluded
    expect(b[o++]).toBe(0); // the literal 0
    expect(b[o++]).toBe(7); // MessageAttr
    expect(rstr()).toBe("welcome");
    expect(r2()).toBe(0x1234); // PRECHMAPREWARD (WORD)
    expect(b[o++]).toBe(1); // JUMSvrNumber
    o += 4; // JUMSvrIP0
    expect(r2()).toBe(17360);
    expect(o).toBe(p.m_uOffset);
  });

  test("UpdateAdvertisement: hour window, midnight wrap, repeats and rotation", () => {
    db.config.run(
      `INSERT INTO FxAdvertisement (strImage, Param1, Param2, Param3, Param4, Param5) VALUES
       ('a.png', 0x1122, 0x3344, 2, 0, 23),
       ('b.png', 1, 2, 1, 22, 6),
       ('c.png', 3, 4, 0, 0, 23)`,
    );
    center.UpdateAdvertisement(1, 12); // noon: a (×2) visible, b (22..6) not, c repeats 0
    expect(center.m_vtSelAdvertisement.map((a) => a.strImage)).toEqual(["a.png", "a.png"]);
    const adv = center.GetAdvertisement();
    expect(adv.strImage).toBe("a.png");
    expect(adv.Param1).toBe(0x1122);
    expect(adv.Param2).toBe(0x3344);
    expect(center.GetAdvertisement().strImage).toBe("a.png"); // the repeat
    center.UpdateAdvertisement(1, 2); // 2 a.m.: the wrapped window opens
    expect(center.m_vtSelAdvertisement.map((a) => a.strImage)).toEqual(["a.png", "a.png", "b.png"]);
    // the dword_49F61C cursor survives the rebuild: 2 % 3 lands on b
    expect(center.GetAdvertisement().strImage).toBe("b.png");
    expect(center.GetAdvertisement().strImage).toBe("a.png");
    expect(center.GetAdvertisement().strImage).toBe("a.png");
    // and wraps back to the pool start
    expect(center.GetAdvertisement().strImage).toBe("b.png");
  });

  test("UpdateAdvertisement(aFull = 0) re-selects the existing pool only", () => {
    db.config.run(
      `INSERT INTO FxAdvertisement (strImage, Param1, Param2, Param3, Param4, Param5) VALUES
       ('d.png', 5, 6, 1, 0, 23)`,
    );
    center.UpdateAdvertisement(0, 12); // no reload → d.png not picked up
    expect(center.m_vtSelAdvertisement.map((a) => a.strImage)).not.toContain("d.png");
    center.UpdateAdvertisement(1, 12); // full reload
    expect(center.m_vtSelAdvertisement.map((a) => a.strImage)).toContain("d.png");
  });

  test("DisconnectTimeoutSocket drops the stale-RTT sockets only", () => {
    const stale = new LsClientSocket();
    const fresh = new LsClientSocket();
    stale.m_bConnected = true;
    fresh.m_bConnected = true;
    pool.AddSocket(stale);
    pool.AddSocket(fresh);
    stale.m_dwLastRTT = (GetTickCount() - 30_001) >>> 0; // just past 0x7530
    pool.DisconnectTimeoutSocket();
    expect(stale.m_bConnected).toBe(false);
    expect(fresh.m_bConnected).toBe(true);
    expect(pool.m_setSocket.has(stale)).toBe(false);
    expect(pool.m_setSocket.has(fresh)).toBe(true);
  });
});
