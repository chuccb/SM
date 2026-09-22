/** Reported stock 6034 plus the native 00415EA0 category matrix and cash
 * grants. These are not claims of a fully restored SQL Server backend. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CDBMan } from "../src/db/DBMan.ts";
import { EnsureCAItemCatalog } from "../src/db/CAItemImport.ts";
import { CItemMan } from "../src/FXSS/ItemMan.ts";
import { PackageMap, ShopItem, UserItem } from "../src/FXSS/Recordsets.ts";
import { CMainPool, CUser, CClientSocket, CBillingProcess, CCenterProcess } from "../src/FXSS/FxShop.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, enSocket } from "../src/core/Packet.ts";

let dir: string, db: CDBMan, pool: CMainPool, billing: CBillingProcess, items: CItemMan, user: CUser;
let prior: readonly [CMainPool | null, CBillingProcess | null, CItemMan | null, CCenterProcess | null];
let packets: Buffer[], errors: ReturnType<typeof spyOn<typeof console, "error">>;
const ID = "purchase";
beforeEach(() => {
  prior = [CMainPool.ms_pInstance, CBillingProcess.ms_pInstance, CItemMan.ms_pInstance, CCenterProcess.ms_pInstance];
  dir = mkdtempSync(join(tmpdir(), "sm-purchase-")); db = new CDBMan(dir);
  errors = spyOn(console, "error").mockImplementation(() => {});
  db.prCreateUser(ID, ID, "fixture", "", 0, 0, "", "", 0, "", "", "", "", ""); db.prResetMoney(ID, 200000);
  pool = new CMainPool(db); billing = new CBillingProcess(db); pool.billingProcess = billing; items = new CItemMan(); CItemMan.ms_pInstance = items;
  packets = []; user = new CUser(null); user.SetName(ID); user.m_nCash = 200000; user.m_nLevel = 10;
  user.m_pSocket = { GetUser: () => user, m_nSelectedUserIdx: 0, SendPacket: (p: CSendPacket) => {
    packets.push(Buffer.from(p.m_pBlock.subarray(0, p.m_uOffset))); return enSocket.kioOk;
  } } as unknown as CClientSocket;
});
afterEach(() => {
  errors.mockRestore(); db.Close(); rmSync(dir, { recursive: true, force: true });
  [CMainPool.ms_pInstance, CBillingProcess.ms_pInstance, CItemMan.ms_pInstance, CCenterProcess.ms_pInstance] = prior;
});
function stock(category: number, attr = -1, sn = 5000, itemSN = 100) {
  items.m_mapUserItem.set(itemSN, Object.assign(new UserItem(), { SN: itemSN, Category: category, nAttr1: attr }));
  const s = Object.assign(new ShopItem(), { SN: sn, ItemSN: itemSN, Category: category, Unit: 1, MoneyType: 1, Price: 100 });
  items.m_mapShopItem.set(sn, s); return s;
}
function own(itemSN: number, amount = 1) {
  db.inventory[db.GetUserHashNo(ID)].query("INSERT INTO FxUserInventory(UserID,ItemSN,Amount,DateCreated,LevelCreated) VALUES(?,?,?,'2099-01-01T00:00:00Z',2000)").run(ID, itemSN, amount);
}
function pre(itemSN: number, amount = 1) { db.prAddPreInventory(ID, 200, itemSN, 0, amount, 30, 0); }
function result() {
  expect(packets).toHaveLength(1); const p = packets[0]; expect(p[0] ^ 0x5a).toBe(204);
  const code = p[1] ^ 0x5a;
  if (code === 0) { expect(p.length).toBe(10); return { code, message: "" }; }
  const length = p.readUInt16BE(2) ^ 0xa569; expect(p.length).toBe(4 + length);
  return { code, message: new TextDecoder("big5").decode(p.subarray(4)) };
}
const money = () => (db.prGetUserDynamic(ID) as { Money: number }).Money;
const rows = () => db.GetUserInventoryRows(ID);
function purchase(sn = 5000) { pool.OnReqPurchaseStockItem(user, sn); return result(); }
function bundle(firstCategory = 1, secondCategory = 1) {
  const parent = stock(11), a = stock(firstCategory, 10, 5001, 101), b = stock(secondCategory, 10, 5002, 102);
  a.Unit = 3; b.Unit = 5; a.ValidityPeriod = 1; b.ValidityLevel = 99;
  parent.ValidityPeriod = 30; parent.ValidityLevel = 6;
  items.m_ltPackageMap = [[a.SN, 2], [b.SN, 1]].map(([StockSN, Units]) => Object.assign(new PackageMap(), { PackageSN: parent.SN, StockSN, Units }));
  return { parent, a, b };
}

test("exact reported 94 b2 fb buys original 6034 with category12/nAttr1=-1, preserving prices and attributes", () => {
  EnsureCAItemCatalog(dir); items.Init(db); billing.m_fLocalBilling = true;
  const item = items.GetUserItem(678)!, product = items.GetShopItem(6034)!;
  expect([product.Category, product.MoneyType, product.Price, item.nAttr1]).toEqual([12, 1, 130000, -1]);
  const n = new CReceivedPacket(); n.SetCipherDegree(2); n.SetRcvPacket(Buffer.from("94b2fb", "hex"), 3);
  expect(n.Decode1()).toBe(206); pool.OnReqPurchase(n, user.m_pSocket!);
  expect(result().code).toBe(0); expect([money(), user.m_nCash]).toEqual([70000, 70000]);
  expect(rows()[0]).toMatchObject({ ItemSN: 678, StockSN: 6034, Slot: 255, Amount: 1, LevelCreated: 2000 });
  expect(Math.round((Date.parse(rows()[0].DateCreated!) - Date.now()) / 86400000)).toBe(100000);
  expect(item.nAttr1).toBe(-1); expect(product.Price).toBe(130000);
});
for (const category of [1, 15]) for (const attr of [-1, 0, 1]) test(`category ${category} ignores nAttr1=${attr} even when owned`, () => {
  stock(category, attr); own(100, 5); pre(100, 7);
  expect(purchase().code).toBe(0); expect(rows()[0].Amount).toBe(6); expect(money()).toBe(199900);
});
for (const category of [2, 3, 4, 5, 6, 10, 12, 14]) test(`category ${category} with nAttr1=-1 is purchasable when absent, then duplicate code4`, () => {
  stock(category); expect(purchase().code).toBe(0); packets.length = 0;
  expect(purchase().code).toBe(4); expect(money()).toBe(199900); expect(rows()[0].Amount).toBe(1);
});
test("pending gift blocks a decoration before any money or live inventory changes", () => {
  stock(12); pre(100); expect(purchase().code).toBe(4); expect(rows()).toEqual([]); expect(money()).toBe(200000);
});
for (const limit of [-1, 0, 2]) test(`only category13 uses the formatted owned limit ${limit}, counting pre inventory`, () => {
  stock(13, limit); if (limit > 0) { own(100); pre(100); }
  const r = purchase(); expect(r.code).toBe(11);
  expect(r.message).toBe(`已持有或收到此道具${limit}個以上，無法再購入`); expect(money()).toBe(200000);
});
test("native category13 check is current owned, not projected units; local billing's stricter policy is separate", () => {
  const s = stock(13, 2); s.Unit = 3; own(100);
  expect(purchase().code).toBe(0); expect(rows()[0].Amount).toBe(4);
});
test("category13 missing definition gives code1, not a fabricated limit", () => {
  stock(13); items.m_mapUserItem.clear(); expect(purchase().code).toBe(1); expect(rows()).toEqual([]); expect(money()).toBe(200000);
});
test("non-package with stray map rows ignores the map; stackability comes from FxItem, not FxStock", () => {
  stock(1); items.m_mapUserItem.get(100)!.Category = 12;
  items.m_ltPackageMap = [Object.assign(new PackageMap(), { PackageSN: 5000, StockSN: 65530, Units: 1 })];
  expect(purchase().code).toBe(0); packets.length = 0;
  expect(purchase().code).toBe(1); expect(rows()[0].Amount).toBe(1); expect(money()).toBe(199900);
});
test("cash package grants children times map units, uses parent stock and parent validity, charges once", () => {
  bundle(); expect(purchase().code).toBe(0);
  expect(rows().map(r => [r.ItemSN, r.Amount, r.StockSN, r.LevelCreated, r.Slot])).toEqual([[101, 6, 5000, 16, 255], [102, 5, 5000, 16, 255]]);
  for (const r of rows()) expect(Math.round((Date.parse(r.DateCreated!) - Date.now()) / 86400000)).toBe(30);
  expect(money()).toBe(199900);
});
test("package children use only category13 limit: decorative nAttr1=-1 is not a maximum", () => {
  bundle(12, 10); items.m_mapUserItem.get(101)!.nAttr1 = -1;
  expect(purchase().code).toBe(0); expect(rows()).toHaveLength(2);
});
test("missing package child stock rejects the whole validation before grants", () => {
  bundle(); items.m_mapShopItem.delete(5002);
  expect(purchase().code).toBe(5); expect(rows()).toEqual([]); expect(money()).toBe(200000);
});
test("owned category15 child is NOT exempt in native package branch", () => {
  bundle(15); own(101); expect(purchase().code).toBe(4); expect(rows()).toHaveLength(1); expect(money()).toBe(200000);
});
test("limited package child at cap returns11 with native generic message, never falls through to grant", () => {
  bundle(13); own(101, 10); expect(purchase()).toEqual({ code: 11, message: "購買商品時發生錯誤" }); expect(money()).toBe(200000);
});
test("native empty package does not grant parent inventory; legacy cash branch still charges (not local billing policy)", () => {
  stock(11); expect(purchase().code).toBe(0); expect(rows()).toEqual([]); expect(money()).toBe(199900);
});
for (const failSN of [101, 102]) test(`native cash package keeps partial grants and uses the last grant result: failure at ${failSN}`, () => {
  bundle(); db.inventory[db.GetUserHashNo(ID)].exec(`CREATE TRIGGER fail_grant BEFORE INSERT ON FxUserInventory WHEN NEW.ItemSN=${failSN} BEGIN SELECT RAISE(ABORT,'injected'); END`);
  expect(purchase().code).toBe(failSN === 102 ? 1 : 0);
  expect(rows().map(r => r.ItemSN)).toEqual([failSN === 101 ? 102 : 101]);
  expect(money()).toBe(failSN === 102 ? 200000 : 199900);
});
for (const [period, level, days, expiry] of [[0, 0, 100000, 2000], [30, 6, 30, 16], [0, 6, 100000, 16], [30, 0, 30, 2000]]) test(`validity ${period}/${level} resolves to ${days} days / expiry level ${expiry}`, () => {
  Object.assign(stock(12), { ValidityPeriod: period, ValidityLevel: level }); expect(purchase().code).toBe(0);
  expect(rows()[0].LevelCreated).toBe(expiry); expect(Math.round((Date.parse(rows()[0].DateCreated!) - Date.now()) / 86400000)).toBe(days);
});
test("insufficient game Money cannot be replaced with billing authorization or points", () => {
  stock(12); user.m_nCash = 99; billing.m_fLocalBilling = true;
  expect(purchase().code).toBe(1); expect(rows()).toEqual([]); expect(money()).toBe(200000);
});
test("failed single grant returns1, charges nothing, and allows retry after the DB error is removed", () => {
  stock(12); const shard = db.inventory[db.GetUserHashNo(ID)];
  shard.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON FxUserInventory BEGIN SELECT RAISE(ABORT,'injected'); END");
  expect(purchase().code).toBe(1); expect(rows()).toEqual([]); expect([money(), user.m_nCash]).toEqual([200000, 200000]);
  shard.exec("DROP TRIGGER fail_grant"); packets.length = 0; expect(purchase().code).toBe(0);
});
test("low-level stack return2 preserves old expiry, stock and equipment; nonaddable cannot overwrite it", () => {
  expect(db.prAddInventoryShop(ID, 100, 5000, 1, 30, 16, true)).toBe(1);
  db.prUpdateInventorySlot(ID, 100, 2); const before = rows()[0];
  expect(db.prAddInventoryShop(ID, 100, 5001, 3, 100000, 2000, true)).toBe(2);
  expect(rows()[0]).toEqual({ ...before, Amount: 4 });
  expect(db.prAddInventoryShop(ID, 100, 5001, 1, 100000, 2000, false)).toBe(0);
  expect(rows()[0]).toEqual({ ...before, Amount: 4 });
});
test("nonaddable insert rechecks pending row existence even if its amount is zero", () => {
  stock(12); pre(100, 0); expect(purchase().code).toBe(1); expect(rows()).toEqual([]); expect(money()).toBe(200000);
});
test("external billing runs the category matrix; local points route still delegates to the atomic store", () => {
  const s = stock(12); s.MoneyType = 0;
  const request = spyOn(billing, "RequestPurchaseTw").mockImplementation(() => {});
  try {
    pool.OnReqPurchaseStockItem(user, 5000); expect(request).toHaveBeenCalledTimes(1); expect(packets).toEqual([]);
    own(100); pool.OnReqPurchaseStockItem(user, 5000); expect(result().code).toBe(4); expect(request).toHaveBeenCalledTimes(1);
    packets.length = 0; billing.m_fLocalBilling = true; pool.OnReqPurchaseStockItem(user, 5000);
    expect(request).toHaveBeenCalledTimes(2); expect(packets).toEqual([]); expect(money()).toBe(200000);
  } finally { request.mockRestore(); }
});
test("native in-progress guard is silent; a pending local purchase prevents an overlapping cash purchase", () => {
  stock(12); user.m_fTranxInProgress = 1; pool.OnReqPurchaseStockItem(user, 5000); expect(packets).toEqual([]);
  user.m_fTranxInProgress = 0; user.m_pPurchaseTranx = {}; expect(purchase().code).toBe(1); expect(rows()).toEqual([]);
});
for (const ticketResult of [0, 1]) test(`single premium stock uses ticket helper and gates auth/debit on result ${ticketResult}`, () => {
  stock(9).ValidityPeriod = 30;
  const ticket = spyOn(db, "prSetPremiumTicket").mockReturnValue(ticketResult);
  const center = new CCenterProcess(db), auth = spyOn(center, "SendAuthenCode").mockImplementation(() => {});
  try {
    expect(purchase().code).toBe(ticketResult === 1 ? 0 : 1);
    expect(ticket).toHaveBeenCalledWith(ID, 30); expect(auth).toHaveBeenCalledTimes(ticketResult);
    expect(rows()).toEqual([]); expect(money()).toBe(ticketResult ? 199900 : 200000);
  } finally { ticket.mockRestore(); auth.mockRestore(); }
});
test("package child category9 is an ordinary grant: native selects ticket handling by parent category", () => {
  bundle(9); const ticket = spyOn(db, "prSetPremiumTicket");
  try { expect(purchase().code).toBe(0); expect(ticket).not.toHaveBeenCalled(); expect(rows()).toHaveLength(2); }
  finally { ticket.mockRestore(); }
});
for (const cash of [99, 200000]) test(`cash completion resets modeled transaction strings, leaves cart guard intact, suppresses cart subreceipt: cash=${cash}`, () => {
  stock(12); user.m_nCash = cash; user.m_fCartProcessing = 1;
  user.m_strCoupon = "coupon"; user.m_strCouponId = "target"; user.m_strTranxInfo = "transaction";
  pool.OnReqPurchaseStockItem(user, 5000);
  expect(packets).toEqual([]); expect(user.m_fCartProcessing).toBe(1);
  expect([user.m_strCoupon, user.m_strCouponId, user.m_strTranxInfo]).toEqual(["", "", ""]);
  expect(rows()).toHaveLength(cash === 99 ? 0 : 1);
});
test("native cash path ignores a negative debit return; grants are not rolled back (explicit non-atomic boundary)", () => {
  stock(12); const debit = spyOn(db, "prSetMoney").mockReturnValue(-1);
  try {
    expect(purchase().code).toBe(0); expect(rows()).toHaveLength(1);
    expect([money(), user.m_nCash]).toEqual([200000, 199900]);
  } finally { debit.mockRestore(); }
});

test("gift purchase: unregistered recipient returns opcode 204 error 3", () => {
  stock(12);
  billing.m_fConnected = 1;
  const p = new CSendPacket(undefined, CipherDegree.kPacketRaw);
  p.Encode2(5000);
  p.EncodeStr("nonexistent_user");
  const recv = new CReceivedPacket();
  recv.SetCipherDegree(CipherDegree.kPacketRaw);
  recv.SetRcvPacket(p.m_pBlock.subarray(0, p.m_uOffset), p.m_uOffset);
  pool.OnRequestPresent(recv, user.m_pSocket as any);
  const res = result();
  expect(res.code).toBe(3);
  expect(res.message).toBe("未登錄的玩家");
});

test("gift purchase: already owned non-stackable item returns opcode 204 error 4", () => {
  const targetId = "target_user";
  db.prCreateUser(targetId, targetId, "fixture", "", 0, 0, "", "", 0, "", "", "", "", "");
  db.inventory[db.GetUserHashNo(targetId)].query("INSERT INTO FxUserInventory(UserID,ItemSN,Amount,DateCreated,LevelCreated) VALUES(?,?,?,'2099-01-01T00:00:00Z',2000)").run(targetId, 100, 1);
  stock(12);
  billing.m_fConnected = 1;
  const p = new CSendPacket(undefined, CipherDegree.kPacketRaw);
  p.Encode2(5000);
  p.EncodeStr(targetId);
  const recv = new CReceivedPacket();
  recv.SetCipherDegree(CipherDegree.kPacketRaw);
  recv.SetRcvPacket(p.m_pBlock.subarray(0, p.m_uOffset), p.m_uOffset);
  pool.OnRequestPresent(recv, user.m_pSocket as any);
  const res = result();
  expect(res.code).toBe(4);
  expect(res.message).toBe("對方已經持有的物品");
});

test("gift purchase: valid gift request dispatches RequestPurchaseTw when MoneyType==0", () => {
  const targetId = "target_user2";
  db.prCreateUser(targetId, targetId, "fixture", "", 0, 0, "", "", 0, "", "", "", "", "");
  const s = stock(12);
  s.MoneyType = 0;
  billing.m_fConnected = 1;
  const request = spyOn(billing, "RequestPurchaseTw").mockImplementation(() => {});
  try {
    const p = new CSendPacket(undefined, CipherDegree.kPacketRaw);
    p.Encode2(5000);
    p.EncodeStr(targetId);
    const recv = new CReceivedPacket();
    recv.SetCipherDegree(CipherDegree.kPacketRaw);
    recv.SetRcvPacket(p.m_pBlock.subarray(0, p.m_uOffset), p.m_uOffset);
    pool.OnRequestPresent(recv, user.m_pSocket as any);
    expect(request).toHaveBeenCalledTimes(1);
    expect(user.m_strTranxInfo).toBe(targetId);
    expect(user.m_nTranxStockSN).toBe(5000);
    expect(packets).toEqual([]);
  } finally {
    request.mockRestore();
  }
});

