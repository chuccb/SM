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
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CxCenter, CUser } from "../src/center/Center.ts";
import { CServerConfig } from "../src/core/Config.ts";
import { CLocalSocket } from "../src/lib/CenterLink.ts";
import { SVRCLASS_GAME, SVRCLASS_UTIL } from "../src/lib/S2S.ts";
import {
  CClientSocket,
  CLocalUserTable,
  CMainPool,
  CMainSystem,
  main as utilMain,
} from "../src/utilserver/UtilServer.ts";
import type { CReceivedPacket } from "../src/core/Packet.ts";
import { TestClient, r1, r2, r4, rstr } from "./TestClient.ts";

const DIR = join(tmpdir(), "util-test-");
const TOOL_PORT = 8128; // CListenThread::Proc's literal 0x1FC0

let center: CxCenter;
/** every CM packet the fake game-server link receives. */
const linkInbox: { id: number; n: CReceived }[] = [];
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
      "MonitorPort = 23829",
      "GameDomain = 0",
      "LSNumber = 0",
      "FXGSNumber = 1",
      "FXGSIP0   = 127.0.0.1",
      "FXGSPort0 = 15848",
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

  const ccfg = new CServerConfig();
  ccfg.Init(join(dir, "util-center.cfg"));
  CServerConfig.ms_pInstance = ccfg;
  center = new CxCenter(ccfg);
  center.InitServerTable();
  await center.Listen();

  await utilMain(join(dir, "util0.cfg"));
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
    const cu = new CUser("op1", SVRCLASS_GAME, 0, 5001);
    cu.nSessionIdx = 4242;
    center.userTable.set("op1", cu);
    center.serialTable.set(5001, cu);

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
    const cu = new CUser("op2", SVRCLASS_GAME, 0, 5002);
    center.userTable.set("op2", cu);
    center.serialTable.set(5002, cu);

    const t = await connectTool();
    t.send(32, (e) => e.str("op2"));
    const cm11 = await waitLink(11);
    expect(cm11.Decode4()).toBe(5002);
    // the util's delete has no residency check — the user is gone
    expect(center.userTable.has("op2")).toBe(false);
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
