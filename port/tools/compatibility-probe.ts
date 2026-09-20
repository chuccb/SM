/** Read-only compatibility inventory probes, NOT regression tests that bless bugs.
 * Run in a fresh process: bun tools/compatibility-probe.ts
 * Uses a temporary DB, no listeners/external services; removes it on exit.
 * Expected values come from the native evidence in docs/remaining-work-audit.md.
 * Does not execute the Windows binaries. A GAP is an outstanding discrepancy;
 * a MATCH is only this fixture, not certification. Throws on harness errors.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CPacketSocket } from "../src/core/CPacketSocket.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, enSocket } from "../src/core/Packet.ts";
import { CServerConfig } from "../src/core/Config.ts";
import { CDBMan, EncodePassword } from "../src/db/DBMan.ts";
import { CUser as CenterUser, type CxCenter } from "../src/Center/Center.ts";
import {
  CUser as ShopUser, CClientSocket as ShopSocket, CWebSocket,
  CMainPool, CLocalUserTable, CBillingProcess, CxShop, type USERACCOUNT,
} from "../src/FXSS/Shop.ts";
import { CItemMan, ShopItem } from "../src/FXSS/CItemMan.ts";
import { CMainSystem, CCenterProcess } from "../src/FXGS/System.ts";
import { CChannelPool } from "../src/FXGS/Chat.ts";
import { CUser as GameUser, CClientSocket as GameSocket } from "../src/FXGS/User.ts";
import { CGuildTable } from "../src/FXGS/Tables.ts";
import { CDynInfoCalculator_GetMaxExpInLevel, kLevelTableSize } from "../src/lib/LevelTable.ts";

function body(write: (p: CSendPacket) => void): CReceivedPacket {
  const p = new CSendPacket(0, CipherDegree.kPacketRaw);
  write(p);
  const n = new CReceivedPacket();
  const bytes = p.m_pBlock.subarray(1, p.m_uOffset);
  n.SetRcvPacket(bytes, bytes.length);
  return n;
}
function decode(p: CSendPacket): CReceivedPacket {
  const n = new CReceivedPacket();
  n.SetRcvPacket(p.m_pBlock.slice(0, p.m_uOffset), p.m_uOffset);
  n.SetCipherDegree(p.m_nCipherDegree);
  n.m_nPacketType = n.Decode1();
  return n;
}

function main(): void {
  let gaps = 0;
  let probes = 0;
  function report(id: string, actual: unknown, expected: unknown): void {
    probes++;
    const matches = JSON.stringify(actual) === JSON.stringify(expected);
    if (!matches) gaps++;
    console.log(JSON.stringify({ id, status: matches ? "MATCH" : "GAP", actual, expected }));
  }

  // Short writes are legal in Bun.Socket.write. The unwritten suffix must survive.
  class ProbeSocket extends CPacketSocket {}
  const socket = new ProbeSocket();
  socket.m_bConnected = true;
  socket.bunSocket = { write: () => 2 } as unknown as Bun.Socket;
  socket.PutBuffer(Uint8Array.of(10, 11, 12, 13, 14), 5);
  socket.Flush();
  report("A01.partial-write-pending", socket.m_nSndCnt, 3);

  const dir = mkdtempSync(join(tmpdir(), "sm-compatibility-probe-"));
  let db: CDBMan | undefined;
  try {
    db = new CDBMan(dir);
    const accountId = "auditunknown";
    const auth = db.prCAAuthUser(accountId, EncodePassword("probe-only"));
    // User-requested extension: unknown-account login MUST auto-register.
    report("A02.accepted-requirement-auto-register", { result: auth.retval, exists: db.prConfirmUnregisteredId(accountId) },
      { result: 0, exists: 1 });

    // Force the second INSERT to fail; an official BEGIN TRAN/ROLLBACK must
    // leave no first INSERT behind. This is not a production database.
    const failedId = "auditrollback";
    db.userInfo[db.GetUserHashNo(failedId)]!.query("INSERT INTO FxUserDynamic (ID) VALUES (?)").run(failedId);
    const rc = db.prCreateUser(failedId, failedId, "probe-only", "", 0, 0, "", "", 0, "", "", "", "", "");
    report("A03.failed-create-rollback", { result: rc, exists: db.prConfirmUnregisteredId(failedId) },
      { result: -1, exists: 0 });

    // Exactly 20 seconds elapse across bit 31 of the monotonic DWORD clock.
    const user = new CenterUser("audit", 0, 0, 1, 1, 0);
    user.m_fConnecting = 1;
    user.nConnectStamp = 0x7fffffff - 1000;
    const now = performance.now;
    try {
      performance.now = () => 0x80000000 + 18999;
      report("A04.center-timeout-wrap", user.DeferDisconnectTimeout({ GetSvr: () => undefined } as unknown as CxCenter), true);
    } finally { performance.now = now; }

    const shopUser = new ShopUser(null);
    shopUser.SetName("audit");
    shopUser.SetGlobalSerialNo(123);
    report("A05.charge-key-positive", shopUser.m_nChargeKey > 0, true);
    const account: USERACCOUNT = {
      SN: 7, Name: "audit", Password: "", Email: "audit@nexonclub.com", EmailRcv: 0,
      Gender: 0, Address: "", Tel: "", Reveal: 0, Profile: "", TotalConn: 0,
      LastConn: null, Permission: 0, money: 0, win: 0, draw: 0, lose: 0,
      ShopCardNo: 1, CommunitySvr: 1,
    };
    shopUser.SetNexonClubId(account);
    report("A06.nexonclub-id", shopUser.m_strNexonClubId, "audit");
    shopUser.m_strCoupon = "old-coupon";
    shopUser.m_strCouponId = "old-id";
    shopUser.ResetTranxInfo();
    report("A07.reset-coupon-state", [shopUser.m_strCoupon, shopUser.m_strCouponId], ["", ""]);

    const pool = new CMainPool(db);
    const replies: CReceivedPacket[] = [];
    const client = {
      m_nSelectedUserIdx: 0,
      GetUser: () => shopUser,
      SendPacket: (p: CSendPacket) => { replies.push(decode(p)); return enSocket.kioOk; },
    } as unknown as ShopSocket;
    shopUser.m_pSocket = client;
    shopUser.m_nCash = 9000;
    shopUser.m_nChargeKey = 321;
    CxShop.ms_pInstance = Object.assign(Object.create(CxShop.prototype) as CxShop, { m_nFXAttr: 0 });
    pool.OnRequestCharge(body(() => {}), client);
    const charge = replies.pop()!;
    charge.Decode1(); charge.Decode4();
    report("A05.charge-response-last-dword", charge.Decode4(), 321);

    const table = new CLocalUserTable();
    table.Insert(shopUser);
    const verify: number[] = [];
    const web = { SendBuffer: (buf: ArrayBuffer) => { verify.push(new DataView(buf).getInt32(0, true)); } } as CWebSocket;
    for (let i = 0; i < 2; i++) pool.OnVerifyKey(body((p) => { p.Encode4(123); p.Encode4(321); }), web);
    report("A05.repeated-web-verify", verify, [1, 1]);

    const billing = new CBillingProcess(db);
    let lookedUp = -1;
    const find = table.FindUserFromGlobalSerialNo;
    table.FindUserFromGlobalSerialNo = (serial) => { lookedUp = serial; return null; };
    try {
      billing.OnPurchaseOKTw(body((p) => {
        p.Encode4(0); p.Encode4(0); p.Encode4(0);
        p.Encode1(4); p.EncodeBuffer(Uint8Array.of(65, 66, 67, 68));
        p.Encode4(123); p.Encode4(0); p.Encode4(0); p.Encode1(0);
      }));
      report("A08.billing-312-account-prefix", lookedUp, 123);
    } finally { table.FindUserFromGlobalSerialNo = find; }

    // Record traversal only: do not actually buy anything or contact billing.
    const items = new CItemMan();
    CItemMan.ms_pInstance = items;
    for (const sn of [10, 20]) {
      const item = new ShopItem(); item.SN = sn; item.MoneyType = 1;
      items.m_mapShopItem.set(sn, item);
    }
    const purchases: number[] = [];
    pool.OnReqPurchaseStockItem = (_user, sn) => { purchases.push(sn); };
    shopUser.m_nCartCount = 0;
    pool.OnReqPurchaseCartList(body((p) => {
      p.Encode1(2); p.Encode2(10); p.Encode1(1); p.Encode2(20); p.Encode1(1);
    }), client);
    report("A09.cart-two-single-items", purchases, [20, 10]);

    const cfg = new CServerConfig([["ServerIndex", ""]]);
    cfg.ParseConfigString("ServerIndex 1");
    CServerConfig.ms_pInstance = cfg;
    const game = new CMainSystem(cfg);
    const center = new CCenterProcess(db); // no Init, no socket connection
    const other = new CServerConfig([["ServerIndex", ""]]);
    other.ParseConfigString("ServerIndex 0");
    CServerConfig.ms_pInstance = other; // equivalent to another suite service's boot
    center.OnLocalServerInfo(body((p) => {
      p.Encode4(2);
      for (const type of [0, 77]) {
        p.EncodeStr("channel"); p.Encode4(100); p.Encode1(type);
        p.Encode1(10); p.Encode2(4848); p.Encode1(1);
      }
    }));
    report("A10.service-config-isolation", game.m_nChannelType, 77);

    CServerConfig.ms_pInstance = cfg;
    new CGuildTable(db);
    const channel = new CChannelPool(db);
    const gameSocket = { SendPacket: (p: CSendPacket) => { replies.push(decode(p)); return enSocket.kioOk; } } as unknown as GameSocket;
    const player = new GameUser(gameSocket);
    player.m_nLevel = 1;
    channel.SendUserDetailInfo(gameSocket, player);
    const detail = replies.pop()!;
    detail.Decode1(); detail.DecodeStr(); detail.DecodeStr(); detail.DecodeStr(); detail.Decode1();
    detail.Decode4(); detail.Decode4(); detail.Decode4(); detail.Decode4();
    report("A11.level-one-detail-max-exp", detail.Decode4(), 3000);
    report("A11.out-of-range-max-exp", CDynInfoCalculator_GetMaxExpInLevel(kLevelTableSize), 0x7fffffff);

    console.log(JSON.stringify({ probes, gaps, note: "Diagnostic observations, not a native-server differential run or passing compatibility tests." }));
  } finally {
    if (db) for (const connection of [...db.userInfo, ...db.inventory, db.config, db.item, db.guild]) connection.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
