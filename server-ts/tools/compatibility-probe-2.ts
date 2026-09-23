/** Second inventory round, A16–A23. No production behavior is changed.
 * Run in a fresh process: bun tools/compatibility-probe-2.ts
 * Uses disposable SQLite + capture sockets, no listeners/external billing.
 * GAP means a known discrepancy, not a passing test. Expected results are
 * independently derived from native evidence in remaining-work-audit-2.md.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CipherDegree, CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CDBMan, GetLegacyPortUserHashNo, GetUserHashNo } from "../src/db/DBMan.ts";
import { CServerConfig } from "../src/core/ServerConfig.ts";
import {
  CBillingProcess, CBillingSocketTw, CLocalUserTable,
  CMainPool, CUser as ShopUser, type CClientSocket as ShopSocket,
} from "../src/FXSS/FxShop.ts";
import { CItemMan } from "../src/FXSS/ItemMan.ts";
import { PackageMap, ShopItem, UserItem } from "../src/FXSS/Recordsets.ts";
import { CUser as GameUser } from "../src/FXGS/User.ts";
import type { CClientSocket as GameSocket } from "../src/FXGS/ClientSocket.ts";
import { CUserItemMan } from "../src/FXGS/ItemMan.ts";
import { CConnectPool } from "../src/FXGS/ConnectPool.ts";
import { CMainSystem } from "../src/FXGS/MainSystem.ts";
import { CCenterProcess } from "../src/FXGS/CenterProcess.ts";

function body(write: (p: CSendPacket) => void): CReceivedPacket {
  // Billing 302's payload, after the Tw frame, is raw. Cipher 2 would XOR the
  // serial before this handler's raw Decode4 and make a correct lookup look missed.
  const p = new CSendPacket(0, CipherDegree.kPacketRaw);
  write(p);
  const n = new CReceivedPacket();
  const bytes = p.m_pBlock.slice(1, p.m_uOffset);
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
  let probes = 0, gaps = 0;
  function report(id: string, actual: unknown, expected: unknown): void {
    probes++;
    const matches = JSON.stringify(actual) === JSON.stringify(expected);
    if (!matches) gaps++;
    console.log(JSON.stringify({ id, status: matches ? "MATCH" : "GAP", actual, expected }));
  }
  const dir = mkdtempSync(join(tmpdir(), "sm-compatibility-probe2-"));
  let db: CDBMan | undefined;
  try {
    db = new CDBMan(dir);
    function register(id: string): void {
      const rc = db!.prCreateUser(id, id, "probe-only", "", 0, 0, "", "", 0, "", "", "", "", "");
      if (rc !== 0) throw new Error(`Fixture account creation failed: ${id}`);
    }
    const billing = new CBillingProcess(db);
    const frames: string[] = [];
    const wire = new CBillingSocketTw();
    wire.m_bConnected = true;
    wire.bunSocket = { write: (bytes: Uint8Array) => { frames.push(Buffer.from(bytes).toString("hex")); return bytes.length; } } as unknown as Bun.Socket;
    billing.m_pSocket = wire;
    billing.TwRequestRTT();
    // Native: E4 payload length, E4 7, E4 packet ID 351, E1 123.
    const nativeRTT = "00000005000000070000015f7b";
    report("A16.billing-Tw-RTT-wire", frames, [nativeRTT]);
    const incoming = Buffer.from(nativeRTT, "hex");
    const receiver = new CBillingSocketTw();
    receiver.m_bConnected = true;
    receiver.m_mbRcvBuffer.set(incoming);
    receiver.m_nRcvCnt = incoming.length;
    const received = new CReceivedPacket();
    const error = receiver.GetPacket(received);
    report("A16.billing-Tw-frame-parse", error, enSocket.kioOk);

    const table = new CLocalUserTable();
    let lookup = -1;
    const finder = table.FindUserFromGlobalSerialNo;
    table.FindUserFromGlobalSerialNo = (sn) => { lookup = sn; return null; };
    try {
      billing.OnRemainCashTw(body((p) => {
        p.Encode4(0); p.Encode1(3); p.EncodeBuffer(Buffer.from("abc"));
        p.Encode4(123); p.Encode4(500); p.Encode4(0);
      }));
      report("A17.billing-302-serial", lookup, 123);
    } finally { table.FindUserFromGlobalSerialNo = finder; }

    const requests: CSendPacket[] = [];
    billing.Send = (p) => { requests.push(p); };
    const shopUser = new ShopUser(null);
    shopUser.SetName("audit"); shopUser.SetGlobalSerialNo(333);
    shopUser.m_nSID = 111; shopUser.m_nBID = 222;
    shopUser.m_pSocket = { m_strPeerAddress: "127.0.0.1" } as ShopSocket;
    const stock = new ShopItem(); stock.SN = 50; stock.Price = 20;
    billing.RequestPurchaseTw(shopUser, stock);
    const request = requests.pop()!;
    const requestBody = decode(request);
    // Anchor at the tail so the independent ID-width problem cannot mask this field.
    requestBody.m_uOffset = request.m_uOffset - (12 + 1 + "127.0.0.1".length);
    report("A17.billing-311-correlation-serial", requestBody.Decode4(), 333);

    const items = new CItemMan(); CItemMan.ms_pInstance = items;
    const pool = new CMainPool(db); pool.billingProcess = billing;
    function addItem(sn: number, category: number, limit: number): void {
      const item = new UserItem(); item.SN = sn; item.Category = category; item.nAttr1 = limit;
      items.m_mapUserItem.set(sn, item);
    }
    function addStock(sn: number, itemSN: number, category: number, unit = 1): ShopItem {
      const item = new ShopItem();
      Object.assign(item, { SN: sn, ItemSN: itemSN, Category: category, Unit: unit,
        MoneyType: 1, Price: 10, ValidityPeriod: 30, ValidityLevel: 6 });
      items.m_mapShopItem.set(sn, item);
      return item;
    }
    function customer(id: string): { user: ShopUser; replies: CReceivedPacket[] } {
      register(id);
      db!.prResetMoney(id, 1000);
      const replies: CReceivedPacket[] = [];
      const user = new ShopUser(null); user.SetName(id); user.m_nCash = 1000; user.m_nLevel = 10;
      user.m_pSocket = { SendPacket: (p: CSendPacket) => { replies.push(decode(p)); return enSocket.kioOk; } } as unknown as ShopSocket;
      return { user, replies };
    }
    addItem(100, 1, 0); addStock(1000, 100, 1);
    const normal = customer("auditnormal");
    pool.OnReqPurchaseStockItem(normal.user, 1000);
    report("A18.category-one-not-limited-by-attr1", normal.replies.map((p) => p.Decode1()), [0]);

    addItem(201, 1, 100); addStock(2001, 201, 1, 3);
    addItem(202, 1, 100); addStock(2002, 202, 1, 5);
    addItem(200, 11, 100); addStock(2000, 200, 11);
    for (const [sn, units] of [[2001, 2], [2002, 1]]) {
      const part = new PackageMap();
      Object.assign(part, { PackageSN: 2000, StockSN: sn, Units: units });
      items.m_ltPackageMap.push(part);
    }
    const bundle = customer("auditbundle");
    pool.OnReqPurchaseStockItem(bundle.user, 2000);
    const bundleRows = db.GetUserInventoryRows(bundle.user.GetName()).map((r) => [r.ItemSN, r.Amount]).sort((a, b) => a[0]! - b[0]!);
    report("A18.package-contents", bundleRows, [[201, 6], [202, 5]]);

    addItem(211, 13, 1); addStock(2101, 211, 13);
    addItem(210, 11, 100); addStock(2100, 210, 11);
    const limitedPart = new PackageMap();
    Object.assign(limitedPart, { PackageSN: 2100, StockSN: 2101, Units: 1 });
    items.m_ltPackageMap.push(limitedPart);
    const limited = customer("auditlimit");
    db.prAddInventoryShop(limited.user.GetName(), 211, 2101, 1, 30, 2000, true);
    pool.OnReqPurchaseStockItem(limited.user, 2100);
    report("A18.package-category13-limit", limited.replies.map((p) => p.Decode1()), [11]);

    addItem(301, 1, 100); addStock(3001, 301, 1);
    const lifetime = customer("auditlifetime");
    pool.OnReqPurchaseStockItem(lifetime.user, 3001);
    const owned = db.GetUserInventoryRows(lifetime.user.GetName())[0];
    if (!owned) throw new Error("Lifetime fixture purchase did not insert inventory");
    const date = owned.DateCreated!;
    const expiration = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(date) ? date : date + "Z");
    report("A19.shop-item-expiration-days", Math.round((expiration - Date.now()) / 86400_000), 30);
    report("A19.shop-item-expiration-level", owned.LevelCreated, 16);

    const cfg = new CServerConfig([]); new CMainSystem(cfg);
    const center = new CCenterProcess(db, cfg);
    const authCodes: number[] = [];
    center.SendAuthenCode = (_sn, code) => { authCodes.push(code); };
    const gameItems = new CUserItemMan();
    const connect = new CConnectPool(db);
    // TS-private only: exercise the exact current loader, not a rewritten reference.
    const loader = connect as unknown as {
      InitUserInventory(user: GameUser): boolean;
      InitPreInventory(user: GameUser): boolean;
    };
    function gameUser(id: string): GameUser {
      const user = new GameUser({} as GameSocket);
      user.SetName(id); user.dyn.strID = id; user.m_nLevel = 10;
      return user;
    }
    function gameItem(sn: number, type = 1, attr2 = 0): void {
      gameItems.m_vtUserItem.set(sn, { Type: type, strAttr: `item${sn}`, strName: `item${sn}`,
        nAttr1: 100, nAttr2: attr2, nAttr3: 0 });
    }
    gameItem(301);
    const newOwner = gameUser(lifetime.user.GetName());
    loader.InitUserInventory(newOwner);
    report("A19.purchase-survives-game-entry", db.GetUserInventoryRows(lifetime.user.GetName()).length, 1);

    register("auditclaim"); gameItem(401);
    db.prAddPreInventory("auditclaim", 0, 401, 4001, 1, 30, 6);
    const claim = gameUser("auditclaim");
    loader.InitPreInventory(claim);
    report("A19.claim-expiration-level", db.GetUserInventoryRows("auditclaim")[0]?.LevelCreated, 16);
    loader.InitUserInventory(claim);
    report("A19.claim-survives-inventory-load", db.GetUserInventoryRows("auditclaim").length, 1);

    register("auditticket"); gameItem(402, 9);
    db.prAddPreInventory("auditticket", 0, 402, 4002, 1, 30, 6);
    const setTicket = db.prSetPremiumTicket;
    db.prSetPremiumTicket = () => 0; // failure injection, not a successful premium grant
    try { loader.InitPreInventory(gameUser("auditticket")); }
    finally { db.prSetPremiumTicket = setTicket; }
    report("A19.failed-ticket-no-auth-upgrade", authCodes, []);

    function insertInventory(id: string, sn: number, slot = 255): void {
      db!.inventory[db!.GetUserHashNo(id)]!.query(
        "INSERT INTO FxUserInventory (UserID,ItemSN,Amount,Slot,DateCreated,LevelCreated) VALUES (?,?,1,?,'2099-01-01T00:00:00.000Z',2000)",
      ).run(id, sn, slot);
    }
    register("auditmissing"); gameItem(502);
    insertInventory("auditmissing", 501); insertInventory("auditmissing", 502);
    const missing = gameUser("auditmissing");
    report("A20.unknown-item-skip-and-continue", { ok: loader.InitUserInventory(missing), loaded: missing.m_vtInventory.map((r) => r.ItemSN) },
      { ok: true, loaded: [502] });

    register("auditcapacity");
    for (let i = 0; i < 401; i++) { gameItem(10000 + i); insertInventory("auditcapacity", 10000 + i); }
    const capacity = gameUser("auditcapacity"); loader.InitUserInventory(capacity);
    report("A20.inventory-load-cap", capacity.m_vtInventory.length, 400);

    register("auditdecoration"); gameItem(601, 10, 2); gameItem(602, 12, 3);
    insertInventory("auditdecoration", 601, 0); insertInventory("auditdecoration", 602, 0);
    const decorated = gameUser("auditdecoration"); loader.InitUserInventory(decorated);
    report("A20.loaded-decoration-slot-alias", [decorated.GetSlotDecorationLoaded(2)?.ItemSN ?? null,
      decorated.GetCharDecoLoaded(3)?.ItemSN ?? null], [601, 602]);

    register("auditstats");
    const stats = gameUser("auditstats");
    stats.dyn.win = 4; stats.dyn.draw = 5; stats.dyn.lose = 6;
    stats.IncWin(); stats.IncDraw(); stats.IncLose(); stats.DeferFlushModifiedInfo(db, 1);
    const dynamic = db.prGetUserDynamic("auditstats") as { Win: number; Draw: number; Lose: number };
    report("A21.win-draw-lose-persistence", [dynamic.Win, dynamic.Draw, dynamic.Lose], [5, 6, 7]);
    const idle = gameUser("auditstats");
    idle.DeferFlushModifiedInfo(db, 0);
    report("A21.nonforced-poll-does-not-count-game", idle.GetGame(), 0);
    const exp = gameUser("auditstats"); exp.dyn.exp = 0x7fffffff;
    exp.IncDecExp(1);
    report("A21.signed-exp-add-wrap", exp.dyn.exp, 0);

    db.item.query("INSERT INTO FxBonusMap (Price,StockSN) VALUES (200,10),(100,20)").run();
    items.UpdateBonusMapTable(db);
    const cart = { m_anCart: [] as { stockSN: number; cnt: number }[] };
    items.AddBonusCartItem(250, cart, 0);
    report("A22.highest-price-bonus", cart.m_anCart[0]?.stockSN, 10);
    const bonusPacket = new CSendPacket(0); items.MakeBonusMap(bonusPacket);
    const bonusBody = decode(bonusPacket); const bonusCount = bonusBody.Decode2();
    const prices = Array.from({ length: bonusCount }, () => { const price = bonusBody.Decode4(); bonusBody.Decode4(); return price; });
    report("A22.bonus-wire-price-order", prices, [100, 200]);
    // Fix row order to remove SQL's unspecified ordering from the duplicate-key probe.
    const bonusRows = db.GetFxBonusMapRows;
    db.GetFxBonusMapRows = () => [{ Price: 100, StockSN: 20 }, { Price: 100, StockSN: 30 }];
    try { items.UpdateBonusMapTable(db); }
    finally { db.GetFxBonusMapRows = bonusRows; }
    report(
      "A22.duplicate-price-insert-unique",
      [...items.m_mapBonusMap.values()].map((row) => [row.Price, row.StockSN]),
      [[100, 20]],
    );

    const differingBytes: number[] = [];
    for (let b = 1; b <= 255; b++) {
      const expected = (b >= 0x41 && b <= 0x5a ? b + 32 : b) % 6;
      if (GetUserHashNo(String.fromCharCode(b) + "user") !== expected) differingBytes.push(b);
    }
    report("A23.first-byte-shard-mismatches", differingBytes, []);
    const legacyMismatchBytes = Array.from({ length: 255 }, (_, index) => index + 1)
      .filter(byte => {
        const id = String.fromCharCode(byte) + "user";
        return GetLegacyPortUserHashNo(id) !== GetUserHashNo(id);
      });
    report("A23.legacy-migration-byte-scope", legacyMismatchBytes, [
      ...Array.from({ length: 0xd6 - 0xc0 + 1 }, (_, index) => 0xc0 + index),
      ...Array.from({ length: 0xde - 0xd8 + 1 }, (_, index) => 0xd8 + index),
    ]);
    report("A23.ascii-shard-control", [GetUserHashNo("Alpha"), GetUserHashNo("alpha")], [97 % 6, 97 % 6]);
    console.log(JSON.stringify({ probes, gaps, matches: probes - gaps,
      note: "Static-native expectations versus isolated TS observations; no Windows binary execution." }));
  } finally {
    if (db) for (const connection of [...db.userInfo, ...db.inventory, db.config, db.item, db.guild]) connection.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
if (import.meta.main) main();
