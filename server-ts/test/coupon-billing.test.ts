/** Coupon check/use against FxShop 00402E10, 00403150, and 00403440. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { ItemCategory } from "../src/common/Item.ts";
import { CDBMan, GetUserHashNo } from "../src/db/DBMan.ts";
import { CBillingProcess } from "../src/FXSS/BillingProcess.ts";
import { CCenterProcess } from "../src/FXSS/CenterProcess.ts";
import type { CClientSocket } from "../src/FXSS/ClientSocket.ts";
import {
  COUPON_RESULT,
  COUPON_STOCK_SN,
  PRESENT_PREINVENTORY_TYPE,
  SHOP_PERMANENT_EXPIRY_LEVEL,
  SHOP_PERMANENT_VALIDITY_DAYS,
} from "../src/FXSS/Defs.ts";
import { CItemMan } from "../src/FXSS/ItemMan.ts";
import { CMainSystem } from "../src/FXSS/MainSystem.ts";
import { CLocalUserTable } from "../src/FXSS/LocalUserTable.ts";
import { CMainPool } from "../src/FXSS/MainPool.ts";
import { CouponMap, UserItem } from "../src/FXSS/Recordsets.ts";
import { CUser } from "../src/FXSS/User.ts";
import { S2C_ShopPacket } from "../src/core/protocol/PacketIDs.ts";

const SERIAL = 77;
const BUYER = "alice";
const GIFT_TARGET = "bob";

let dir = "";
let db: CDBMan;
let items: CItemMan;
let user: CUser;
let billing: CBillingProcess;
let sent: CSendPacket[] = [];
let forwarded: CSendPacket[] = [];
let authen: [number, number][] = [];
const prior = {
  billing: null as CBillingProcess | null,
  users: null as CLocalUserTable | null,
  items: null as CItemMan | null,
  center: null as CCenterProcess | null,
  pool: null as CMainPool | null,
  main: null as CMainSystem | null,
};

beforeEach(() => {
  prior.billing = CBillingProcess.ms_pInstance;
  prior.users = CLocalUserTable.ms_pInstance;
  prior.items = CItemMan.ms_pInstance;
  prior.center = CCenterProcess.ms_pInstance;
  prior.pool = CMainPool.ms_pInstance;
  prior.main = CMainSystem.ms_pInstance;

  dir = mkdtempSync(join(tmpdir(), "sm-coupon-"));
  db = new CDBMan(dir);
  for (const [name, sn] of [[BUYER, 11], [GIFT_TARGET, 12]] as const) {
    const shard = db.userInfo[GetUserHashNo(name)]!;
    shard.query("INSERT INTO FxUserAccount(ID,SN,Password) VALUES(?,?,?)").run(name, sn, "x");
    shard.query("INSERT INTO FxUserDynamic(ID,Money,Exp) VALUES(?,999,1000)").run(name);
  }
  items = new CItemMan();
  items.Init(db);
  CItemMan.ms_pInstance = items;
  const main = new CMainSystem();
  main.m_nFXAttr = 3;
  new CLocalUserTable();
  authen = [];
  CCenterProcess.ms_pInstance = {
    SendAuthenCode(serial: number, code: number) { authen.push([serial, code]); },
  } as CCenterProcess;

  sent = [];
  const socket = {
    m_strPeerAddress: "127.0.0.1",
    SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; },
    GetUser: () => user,
    m_nSelectedUserIdx: 0,
  } as unknown as CClientSocket;
  user = new CUser(socket);
  user.SetName(BUYER);
  user.SetGlobalSerialNo(SERIAL);
  user.m_nLevel = 12;
  user.m_nExp = 1000;
  user.m_strCoupon = "coupon";
  CLocalUserTable.ms_pInstance!.Insert(user);
  billing = new CBillingProcess(db);
  forwarded = [];
  billing.Send = (packet) => { forwarded.push(packet); };
});

afterEach(() => {
  billing.Stop();
  db.Close();
  rmSync(dir, { recursive: true, force: true });
  CBillingProcess.ms_pInstance = prior.billing;
  CLocalUserTable.ms_pInstance = prior.users;
  CItemMan.ms_pInstance = prior.items;
  CCenterProcess.ms_pInstance = prior.center;
  CMainPool.ms_pInstance = prior.pool;
});

function rawPacket(): CSendPacket {
  const packet = new CSendPacket();
  packet.SetCipherDegree(0);
  return packet;
}

function body(serial: number, result: number, couponSN: number): CReceivedPacket {
  const packet = rawPacket();
  packet.Encode4(serial);
  packet.Encode1(result);
  packet.Encode4(couponSN);
  const received = new CReceivedPacket();
  received.SetCipherDegree(0);
  received.SetRcvPacket(packet.m_pBlock.slice(0, packet.m_uOffset), packet.m_uOffset);
  return received;
}

function check(result = 0, couponSN = 42): void {
  sent.length = 0;
  forwarded.length = 0;
  billing.OnCheckCoupon(body(SERIAL, result, couponSN));
}

function item(sn: number, category: number): void {
  items.m_mapUserItem.set(sn, Object.assign(new UserItem(), { SN: sn, Category: category }));
}

function map(couponSN: number, itemSN: number, units: number, period: number, level: number): void {
  items.m_ltCouponMap.push(Object.assign(new CouponMap(), {
    CouponSN: couponSN, ItemSN: itemSN, Units: units, ValidityPeriod: period, Validitylevel: level,
  }));
}

function clientCode(): number {
  expect(sent).toHaveLength(1);
  const received = new CReceivedPacket();
  received.SetCipherDegree(sent[0]!.m_nCipherDegree);
  received.SetRcvPacket(sent[0]!.m_pBlock.slice(0, sent[0]!.m_uOffset), sent[0]!.m_uOffset);
  expect(received.Decode1()).toBe(S2C_ShopPacket.OnUseCouponRes);
  return received.Decode1();
}

function inventoryCount(id = BUYER): number {
  const row = db.inventory[GetUserHashNo(id)]!.query(
    "SELECT COUNT(*) AS c FROM FxUserInventory WHERE UserID = ?",
  ).get(id) as { c: number };
  return row.c;
}

function dynamic(id = BUYER): { Money: number; Exp: number; TicketDate: string | null } {
  return db.userInfo[GetUserHashNo(id)]!.query(
    "SELECT Money, Exp, TicketDate FROM FxUserDynamic WHERE ID = ?",
  ).get(id) as { Money: number; Exp: number; TicketDate: string | null };
}

test("a bad result or an empty coupon string sends that result and does not grant", () => {
  item(300, ItemCategory.Consumable);
  map(42, 300, 2, 0, 0);
  check(4);
  expect(clientCode()).toBe(4);
  expect(forwarded).toHaveLength(0);
  expect(user.m_strCoupon).toBe("");
  expect(user.m_nCouponID).toBe(0);

  user.m_strCoupon = "";
  user.m_nCouponID = 9;
  check(0);
  expect(clientCode()).toBe(0);
  expect(user.m_nCouponID).toBe(0);
  expect(inventoryCount()).toBe(0);
});

test("an empty appended list sends 208 code 8", () => {
  check(0, 42);
  expect(clientCode()).toBe(COUPON_RESULT.BillingFailure);
  expect(forwarded).toHaveLength(0);
});

test("a busy user is ignored and a check request is not sent", () => {
  user.m_fTranxInProgress = 1;
  user.m_nCouponID = 9;
  check(0);
  expect(sent).toHaveLength(0);
  expect(user.m_nCouponID).toBe(9);
  expect(user.m_strCoupon).toBe("coupon");
  expect(billing.RequestCheckCoupon(user)).toBe(0);
  expect(billing.RequestUseCoupon(user)).toBe(0);
  expect(forwarded).toHaveLength(0);
});

test("inventory grant uses stock 10, permanent defaults, and chains use without 208", () => {
  item(300, ItemCategory.Consumable);
  map(42, 300, 2, 0, 0);
  check(3, 42);
  expect(sent).toHaveLength(0);
  expect(forwarded).toHaveLength(1);
  const row = db.inventory[GetUserHashNo(BUYER)]!.query(
    "SELECT ItemSN, StockSN, Amount, LevelCreated, DateCreated FROM FxUserInventory WHERE UserID = ?",
  ).get(BUYER) as { ItemSN: number; StockSN: number; Amount: number; LevelCreated: number; DateCreated: string };
  expect(row).toMatchObject({ ItemSN: 300, StockSN: COUPON_STOCK_SN, Amount: 2, LevelCreated: SHOP_PERMANENT_EXPIRY_LEVEL });
  expect(Math.round((Date.parse(row.DateCreated) - Date.now()) / 86_400_000)).toBe(SHOP_PERMANENT_VALIDITY_DAYS);
  expect(user.m_nCouponID).toBe(42);
  expect(user.m_listCouponMap).toHaveLength(1);
});

test("use reply counts missing items but encodes only rows with a UserItem", () => {
  item(300, ItemCategory.Consumable);
  item(401, ItemCategory.Experience);
  map(42, 300, 2, 30, 5);
  map(42, 999, 7, 1, 2);
  map(42, 401, 3000, 9, 4);
  user.m_nCouponID = 42;
  user.m_nLevel = 12;
  user.m_listCouponMap = items.GetCouponMapList(42).map((entry) => Object.assign(new CouponMap(), entry));
  billing.OnUseCoupon(body(SERIAL, 0, 0));
  expect(sent).toHaveLength(1);
  const received = new CReceivedPacket();
  received.SetCipherDegree(sent[0]!.m_nCipherDegree);
  received.SetRcvPacket(sent[0]!.m_pBlock.slice(0, sent[0]!.m_uOffset), sent[0]!.m_uOffset);
  expect([received.Decode1(), received.Decode1(), received.Decode4()]).toEqual([S2C_ShopPacket.OnUseCouponRes, 0, 3]);
  expect([received.Decode4(), received.Decode4(), received.Decode4(), received.Decode4()]).toEqual([300, 2, 30, 5]);
  expect([received.Decode4(), received.Decode4(), received.Decode4(), received.Decode4()]).toEqual([401, 3000, 9, 12]);
  expect(received.m_uOffset).toBe(received.m_uLength);
  expect(user.m_listCouponMap).toHaveLength(0);
  expect(user.m_nCouponID).toBe(0);
});

test("experience is applied and does not chain RequestUseCoupon", () => {
  item(401, ItemCategory.Experience);
  map(42, 401, 2000, 0, 0);
  check(0);
  expect(clientCode()).toBe(COUPON_RESULT.BillingFailure);
  expect(forwarded).toHaveLength(0);
  expect(dynamic().Exp).toBe(3000);
  expect(user.m_nExp).toBe(3000);
  expect(user.m_nLevel).toBe(2);
  expect(user.m_strCoupon).toBe("");
});

test("money success chains use; a missing dynamic row does not", () => {
  item(500, ItemCategory.Money);
  map(42, 500, 25, 0, 0);
  check(0);
  expect(sent).toHaveLength(0);
  expect(forwarded).toHaveLength(1);
  expect(dynamic().Money).toBe(1024);
  user.ResetTranxInfo();
  user.m_strCoupon = "coupon";
  user.SetName("missing");
  forwarded.length = 0;
  check(0);
  expect(clientCode()).toBe(COUPON_RESULT.BillingFailure);
  expect(forwarded).toHaveLength(0);
});

test("premium ticket uses the raw validity level and skips authencode 1", () => {
  item(309, ItemCategory.PremiumTicket);
  map(42, 309, 1, 99, 14);
  check(0);
  expect(sent).toHaveLength(0);
  expect(authen).toEqual([[SERIAL, 1]]);
  expect(dynamic().TicketDate).not.toBeNull();
  expect(forwarded).toHaveLength(1);

  user.ResetTranxInfo();
  user.m_strCoupon = "coupon";
  user.m_nAuthenCode = 1;
  authen.length = 0;
  forwarded.length = 0;
  map(43, 309, 1, 0, 3);
  check(0, 43);
  expect(authen).toHaveLength(0);
  expect(forwarded).toHaveLength(1);
});

test("a gift coupon writes pre-inventory and a non-positive insert does not chain use", () => {
  item(300, ItemCategory.Consumable);
  map(42, 300, 2, 30, 5);
  user.m_strCouponId = GIFT_TARGET;
  check(0);
  expect(sent).toHaveLength(0);
  const row = db.inventory[GetUserHashNo(GIFT_TARGET)]!.query(
    "SELECT Type, ItemSN, StockSN, Amount, ValidityPeriod, ValidityLevel, strAttr, Description FROM FxPreInventory WHERE UserID = ?",
  ).get(GIFT_TARGET) as { Type: number; ItemSN: number; StockSN: number; Amount: number; ValidityPeriod: number; ValidityLevel: number; strAttr: string; Description: string };
  expect(row).toEqual({
    Type: PRESENT_PREINVENTORY_TYPE,
    ItemSN: 300,
    StockSN: COUPON_STOCK_SN,
    Amount: 2,
    ValidityPeriod: 30,
    ValidityLevel: 17,
    strAttr: BUYER,
    Description: "",
  });

  user.ResetTranxInfo();
  user.m_strCoupon = "coupon";
  user.m_strCouponId = GIFT_TARGET;
  db.prAddPreInventory = () => 0;
  forwarded.length = 0;
  check(0);
  expect(clientCode()).toBe(COUPON_RESULT.BillingFailure);
  expect(forwarded).toHaveLength(0);
});

test("a second check appends to the stored list and grants the earlier entry again", () => {
  item(300, ItemCategory.Consumable);
  map(7, 300, 1, 1, 0);
  user.m_listCouponMap.push(Object.assign(new CouponMap(), { CouponSN: 7, ItemSN: 300, Units: 1, ValidityPeriod: 1, Validitylevel: 0 }));
  check(0, 99);
  expect(sent).toHaveLength(0);
  expect(user.m_listCouponMap).toHaveLength(1);
  expect(inventoryCount()).toBe(1);
  expect(forwarded).toHaveLength(1);
});

test("an in-progress client coupon request does not store the strings or ask billing", () => {
  const pool = new CMainPool(db);
  pool.billingProcess = billing;
  user.m_fTranxInProgress = 1;
  const packet = rawPacket();
  packet.EncodeStr("next-coupon");
  packet.EncodeStr(GIFT_TARGET);
  const received = new CReceivedPacket();
  received.SetCipherDegree(0);
  received.SetRcvPacket(packet.m_pBlock.slice(0, packet.m_uOffset), packet.m_uOffset);
  pool.OnRequestUseCoupon(received, user.m_pSocket!);
  expect(user.m_strCoupon).toBe("coupon");
  expect(user.m_strCouponId).toBe("");
  expect(forwarded).toHaveLength(0);
  expect(sent).toHaveLength(0);
});
