/** External billing 312/322 grant, receipt, and rollback. Local billing stays off. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { INVENTORY_SLOT_NONE } from "../src/common/Item.ts";
import { CDBMan, GetUserHashNo } from "../src/db/DBMan.ts";
import { CBillingProcess } from "../src/FXSS/BillingProcess.ts";
import { CCenterProcess } from "../src/FXSS/CenterProcess.ts";
import type { CClientSocket } from "../src/FXSS/ClientSocket.ts";
import {
  BILLING_ORPHAN_STOCK,
  GIFT_LIMIT_RESULT,
  GIFT_PREINVENTORY_LIMIT,
  PRESENT_PREINVENTORY_TYPE,
  PURCHASE_CONFIRM,
  PURCHASE_RESULT,
  SHOP_PERMANENT_EXPIRY_LEVEL,
} from "../src/FXSS/Defs.ts";
import { CItemMan } from "../src/FXSS/ItemMan.ts";
import { CLocalUserTable } from "../src/FXSS/LocalUserTable.ts";
import { CTranxCtrl } from "../src/FXSS/TranxCtrl.ts";
import { CUser } from "../src/FXSS/User.ts";
import { BillingReader, purchaseReply, string8 } from "../src/services/LocalBilling/Protocol.ts";
import { CSendPacket as BillingPacket } from "../src/FXSS/Packet.ts";

const SERIAL = 77;
const REFERENCE = "e".repeat(32);
const BUYER = "alice";
const GIFT_TARGET = "bob";
const ACCOUNT_SN = 11;

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
  tranx: null as CTranxCtrl | null,
  center: null as CCenterProcess | null,
};

beforeEach(() => {
  prior.billing = CBillingProcess.ms_pInstance;
  prior.users = CLocalUserTable.ms_pInstance;
  prior.items = CItemMan.ms_pInstance;
  prior.tranx = CTranxCtrl.ms_pInstance;
  prior.center = CCenterProcess.ms_pInstance;

  dir = mkdtempSync(join(tmpdir(), "sm-external-billing-"));
  db = new CDBMan(dir);
  for (const [name, sn] of [[BUYER, ACCOUNT_SN], [GIFT_TARGET, 12]] as const) {
    const shard = db.userInfo[GetUserHashNo(name)]!;
    shard.query("INSERT INTO FxUserAccount(ID,SN,Password) VALUES(?,?,?)").run(name, sn, "x");
    shard.query("INSERT INTO FxUserDynamic(ID,Money) VALUES(?,999)").run(name);
  }
  db.item.exec(`
    INSERT INTO FxItem(SN,Category) VALUES (300,1),(301,15),(302,2),(309,9),(310,1),(312,1);
    INSERT INTO FxStock(SN,Category,ItemSN,Unit,Price,ValidityPeriod,ValidityLevel,IsValid) VALUES
      (5000,1,300,2,100,0,0,1),
      (5001,1,300,4,80,30,5,1),
      (5002,9,309,1,200,30,0,1),
      (5100,11,0,1,150,0,0,1),
      (5200,1,310,3,10,0,0,1),
      (5201,15,301,2,10,0,0,1),
      (5202,1,312,4,10,0,0,1),
      (5300,11,0,1,150,0,0,1),
      (5400,2,302,1,40,0,0,1),
      (5500,11,0,1,50,0,0,1),
      (5600,1,999,1,10,0,0,1),
      (5700,11,0,1,50,0,0,1);
    INSERT INTO FxPackageMap(PackageSN,StockSN,Units) VALUES
      (5300,5200,2),(5300,5202,1),(5500,5999,1),(5700,5201,1);
  `);
  items = new CItemMan();
  items.Init(db);
  CItemMan.ms_pInstance = items;
  new CTranxCtrl(dir, () => new Date(2026, 8, 21, 5, 6, 7)).Init();
  new CLocalUserTable();
  authen = [];
  CCenterProcess.ms_pInstance = {
    SendAuthenCode(serial: number, code: number) { authen.push([serial, code]); },
  } as CCenterProcess;

  sent = [];
  const socket = {
    m_strPeerAddress: "127.0.0.1",
    SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; },
  } as unknown as CClientSocket;
  user = new CUser(socket);
  user.SetName(BUYER);
  user.SetGlobalSerialNo(SERIAL);
  user.m_nLevel = 12;
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
  CTranxCtrl.ms_pInstance = prior.tranx;
  CCenterProcess.ms_pInstance = prior.center;
});

function decode(packet: { m_nCipherDegree: number; m_pBlock: Uint8Array; m_uOffset: number }): CReceivedPacket {
  const received = new CReceivedPacket();
  received.SetCipherDegree(packet.m_nCipherDegree);
  received.SetRcvPacket(packet.m_pBlock.slice(0, packet.m_uOffset), packet.m_uOffset);
  return received;
}

function prepare(stockSN: number, gift = ""): void {
  const stock = items.GetShopItem(stockSN)!;
  user.ResetTranxInfo();
  user.m_nTranxStockSN = stock.SN;
  user.m_nTranxItemSN = stock.ItemSN;
  user.m_nTranxAmount = stock.Unit;
  user.m_strTranxInfo = gift;
  user.m_fTranxInProgress = 0;
  sent.length = 0;
  forwarded.length = 0;
}

function approve(): void {
  billing.OnPacket(decode(purchaseReply(312, REFERENCE, SERIAL)));
}

function settle(error = ""): void {
  billing.OnPacket(decode(purchaseReply(322, REFERENCE, SERIAL, error)));
}

function refuse(message: string, result = 1): void {
  const packet = new BillingPacket(312);
  packet.Encode4(0); packet.Encode4(0); packet.Encode4(0);
  string8(packet, REFERENCE);
  packet.Encode4(SERIAL);
  packet.Encode4(0);
  packet.Encode4(result);
  if (result === 1) string8(packet, message);
  billing.OnPacket(decode(packet));
}

function expectConfirm(stock: number, result: number): void {
  expect(forwarded).toHaveLength(1);
  const reader = new BillingReader(forwarded[0]!.m_pBlock.subarray(0, forwarded[0]!.m_uOffset));
  expect([reader.u32(), reader.string(), reader.u32(), reader.u32(), reader.u32()])
    .toEqual([321, REFERENCE, SERIAL, stock, result]);
  reader.end();
}

function client(packet: CSendPacket): { opcode: number; code: number; message: string; extra?: number } {
  const received = decode(packet);
  const opcode = received.Decode1();
  const code = received.Decode1();
  if (code === PURCHASE_RESULT.Success) return { opcode, code, message: "" };
  const message = received.DecodeStr();
  if (received.m_uOffset >= received.m_uLength) return { opcode, code, message };
  return { opcode, code, message, extra: received.Decode1() };
}

function rows(id: string): { UserSN: number; ItemSN: number; StockSN: number; Slot: number; Amount: number; LevelCreated: number }[] {
  return db.inventory[GetUserHashNo(id)]!.query(
    "SELECT UserSN, ItemSN, StockSN, Slot, Amount, LevelCreated FROM FxUserInventory WHERE UserID = ? ORDER BY ItemSN",
  ).all(id) as { UserSN: number; ItemSN: number; StockSN: number; Slot: number; Amount: number; LevelCreated: number }[];
}

function logText(): string {
  return readFileSync(join(dir, "TranxLog_20260921.txt"), "ascii");
}

test("external 312 grants without a client receipt; 322 logs the granted fields and does not resume a cart", () => {
  expect(billing.m_fLocalBilling).toBe(false);
  user.m_fCartProcessing = 1;
  user.m_nCartCount = 3;
  prepare(5000);
  approve();

  expectConfirm(5000, PURCHASE_CONFIRM.Charge);
  expect(sent).toHaveLength(0);
  expect(user.m_nTranxState).toBe(1);
  expect(user.m_nTranxResult).toBe(1);
  expect(rows(BUYER)).toEqual([{
    UserSN: ACCOUNT_SN, ItemSN: 300, StockSN: 5000, Slot: INVENTORY_SLOT_NONE, Amount: 2, LevelCreated: SHOP_PERMANENT_EXPIRY_LEVEL,
  }]);
  expect((db.prGetUserDynamic(BUYER) as { Money: number }).Money).toBe(999);

  settle();
  expect(sent).toHaveLength(1);
  expect(client(sent[0]!)).toEqual({ opcode: 204, code: PURCHASE_RESULT.Success, message: "" });
  expect(sent[0]!.m_uOffset).toBe(10);
  expect(logText()).toBe("5:6:7,0,5000,300,2,100\r\r\n");
  expect(user.m_nTranxStockSN).toBe(0);
  expect(user.m_fCartProcessing).toBe(1);
  expect(user.m_nCartCount).toBe(3);
  expect(sent.some((packet) => client(packet).opcode === 215)).toBe(false);
});

test("322 failure deletes a new row, decrements a stack, drops a gift, and does not revoke a future ticket", () => {
  prepare(5001);
  approve();
  expect(rows(BUYER)).toEqual([{
    UserSN: ACCOUNT_SN, ItemSN: 300, StockSN: 5001, Slot: INVENTORY_SLOT_NONE, Amount: 4, LevelCreated: user.m_nLevel + 5,
  }]);
  settle("declined");
  expect(rows(BUYER)).toEqual([]);

  prepare(5400);
  approve();
  expect(rows(BUYER)).toEqual([{
    UserSN: ACCOUNT_SN, ItemSN: 302, StockSN: 5400, Slot: INVENTORY_SLOT_NONE, Amount: 1, LevelCreated: SHOP_PERMANENT_EXPIRY_LEVEL,
  }]);
  user.m_pSocket = null;
  settle("declined");
  expect(rows(BUYER)).toEqual([]);
  expect(sent).toHaveLength(0);
  expect(user.m_nTranxState).toBe(0);
  user.m_pSocket = { SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; } } as CClientSocket;

  db.inventory[GetUserHashNo(BUYER)]!.query(
    "INSERT INTO FxUserInventory(UserID,ItemSN,StockSN,Slot,Amount,LevelCreated) VALUES(?,?,?,?,?,?)",
  ).run(BUYER, 300, 1, 1, 5, 9);
  prepare(5000);
  approve();
  expect(user.m_listTranxInfo).toEqual([{ ItemSN: 300, PreInventorySN: 0, IsNew: 1, Amount: 2 }]);
  expect(rows(BUYER).find((row) => row.ItemSN === 300)).toMatchObject({ Amount: 7, StockSN: 1, Slot: 1, LevelCreated: 9 });
  settle("declined");
  expect(rows(BUYER).find((row) => row.ItemSN === 300)).toMatchObject({ Amount: 5, StockSN: 1 });
  expect(client(sent.at(-1)!)).toEqual({ opcode: 204, code: PURCHASE_RESULT.GenericFailure, message: "declined" });

  prepare(5002);
  approve();
  const ticket = (db.prGetUserDynamic(BUYER) as { TicketDate: string }).TicketDate;
  expect(Date.parse(ticket)).toBeGreaterThan(Date.now());
  expect(authen).toEqual([[SERIAL, 1]]);
  expect(rows(BUYER).some((row) => row.ItemSN === 309)).toBe(false);
  user.m_nGlobalSerialNo = 88;
  settle("declined");
  expect(authen).toEqual([[SERIAL, 1], [88, 0]]);
  expect((db.prGetUserDynamic(BUYER) as { TicketDate: string }).TicketDate).toBe(ticket);
  user.m_nGlobalSerialNo = SERIAL;

  prepare(5002, GIFT_TARGET);
  approve();
  const premiumGift = db.GetPreInventoryRows(GIFT_TARGET)[0]!;
  expect(premiumGift).toMatchObject({
    Type: PRESENT_PREINVENTORY_TYPE,
    ItemSN: 309,
    StockSN: 5002,
    Amount: 1,
    ValidityPeriod: 30,
    ValidityLevel: SHOP_PERMANENT_EXPIRY_LEVEL,
    strAttr: BUYER,
    Description: "",
  });
  expect(user.m_listTranxInfo).toEqual([{ ItemSN: 0, PreInventorySN: premiumGift.SN, IsNew: 0, Amount: 30 }]);
  settle("declined");
  expect(db.GetPreInventoryRows(GIFT_TARGET)).toEqual([]);

  prepare(5001, GIFT_TARGET);
  approve();
  const gift = db.GetPreInventoryRows(GIFT_TARGET);
  expect(gift).toHaveLength(1);
  expect(gift[0]).toMatchObject({
    Type: PRESENT_PREINVENTORY_TYPE,
    ItemSN: 300,
    StockSN: 5001,
    Slot: INVENTORY_SLOT_NONE,
    Amount: 4,
    ValidityPeriod: 30,
    ValidityLevel: 5,
    strAttr: BUYER,
    Description: "",
  });
  expect(user.m_listTranxInfo).toEqual([{ ItemSN: 0, PreInventorySN: gift[0]!.SN, IsNew: 0, Amount: 0 }]);
  settle("declined");
  expect(db.GetPreInventoryRows(GIFT_TARGET)).toEqual([]);
  expect(rows(GIFT_TARGET)).toEqual([]);
  expect(client(sent.at(-1)!)).toEqual({ opcode: 204, code: PURCHASE_RESULT.GiftFailure, message: "declined" });
});

test("packages grant children under the parent stock, and a failed later child is not undone by 322", () => {
  prepare(5300);
  approve();
  expectConfirm(5300, PURCHASE_CONFIRM.Charge);
  expect(rows(BUYER)).toEqual([
    { UserSN: ACCOUNT_SN, ItemSN: 310, StockSN: 5300, Slot: INVENTORY_SLOT_NONE, Amount: 6, LevelCreated: SHOP_PERMANENT_EXPIRY_LEVEL },
    { UserSN: ACCOUNT_SN, ItemSN: 312, StockSN: 5300, Slot: INVENTORY_SLOT_NONE, Amount: 4, LevelCreated: SHOP_PERMANENT_EXPIRY_LEVEL },
  ]);
  items.m_mapShopItem.delete(5300);
  items.m_ltPackageMap = items.m_ltPackageMap.filter((mapping) => mapping.PackageSN !== 5300);
  settle();
  expect(logText()).toBe("5:6:7,0,5300,312,4,-1\r\r\n");

  prepare(5100);
  approve();
  expectConfirm(5100, PURCHASE_CONFIRM.Charge);
  expect(rows(BUYER)).toHaveLength(2);

  prepare(5500);
  approve();
  expectConfirm(5500, PURCHASE_CONFIRM.Refuse);
  expect(user.m_nTranxState).toBe(0);
  expect(sent).toHaveLength(0);

  db.inventory[GetUserHashNo(BUYER)]!.query(
    "INSERT INTO FxUserInventory(UserID,ItemSN,Amount) VALUES(?,?,?)",
  ).run(BUYER, 301, 1);
  prepare(5700);
  approve();
  expectConfirm(5700, PURCHASE_CONFIRM.Refuse);
  expect(rows(BUYER).find((row) => row.ItemSN === 301)?.Amount).toBe(1);

  prepare(5600);
  approve();
  expectConfirm(5600, PURCHASE_CONFIRM.Refuse);
  expect(rows(BUYER).some((row) => row.ItemSN === 999)).toBe(false);

  db.inventory[GetUserHashNo(BUYER)]!.exec("DELETE FROM FxUserInventory");
  items.UpdateShopItemTable(db);
  items.UpdatePackageMapTable(db);
  db.inventory[GetUserHashNo(BUYER)]!.query(
    "INSERT INTO FxUserInventory(UserID,ItemSN,Amount) VALUES(?,?,?)",
  ).run(BUYER, 310, 1);
  prepare(5300);
  approve();
  expectConfirm(5300, PURCHASE_CONFIRM.Charge);
  expect(rows(BUYER).find((row) => row.ItemSN === 310)?.Amount).toBe(7);

  db.inventory[GetUserHashNo(BUYER)]!.exec("DELETE FROM FxUserInventory");
  const original = db.prAddInventoryShop.bind(db);
  let calls = 0;
  db.prAddInventoryShop = (...args) => {
    calls += 1;
    return calls === 2 ? 0 : original(...args);
  };
  prepare(5300);
  approve();
  expectConfirm(5300, PURCHASE_CONFIRM.Refuse);
  expect(user.m_nTranxState).toBe(0);
  expect(rows(BUYER).find((row) => row.ItemSN === 310)?.Amount).toBe(6);
  settle("declined");
  expect(rows(BUYER).find((row) => row.ItemSN === 310)?.Amount).toBe(6);
  expect(rows(BUYER).some((row) => row.ItemSN === 312 && row.StockSN === 5300)).toBe(false);
});

test("a refused 312 tells the client, and a gift cap is reported only by the later refusal", () => {
  prepare(5000);
  refuse("busy");
  expect(sent).toHaveLength(1);
  expect(client(sent[0]!)).toEqual({ opcode: 204, code: PURCHASE_RESULT.GenericFailure, message: "busy" });
  expect(user.m_nTranxStockSN).toBe(0);
  expect(rows(BUYER)).toEqual([]);

  prepare(5000, GIFT_TARGET);
  refuse("nope");
  expect(client(sent.at(-1)!)).toEqual({ opcode: 204, code: PURCHASE_RESULT.GiftFailure, message: "nope" });

  prepare(5000);
  refuse("", 2);
  expect(client(sent.at(-1)!)).toEqual({ opcode: 204, code: PURCHASE_RESULT.GenericFailure, message: "" });

  user.m_pSocket = null;
  prepare(5000);
  refuse("gone");
  expect(sent).toHaveLength(0);
  expect(user.m_nTranxStockSN).toBe(0);
  user.m_pSocket = { SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; } } as CClientSocket;

  prepare(5000);
  user.m_fTranxInProgress = 1;
  approve();
  expectConfirm(BILLING_ORPHAN_STOCK, PURCHASE_CONFIRM.Absent);
  expect(rows(BUYER)).toEqual([]);
  forwarded.length = 0;
  refuse("late");
  expect(sent).toHaveLength(0);
  expect(user.m_nTranxStockSN).toBe(5000);
  user.m_fTranxInProgress = 0;

  billing.OnPacket(decode(purchaseReply(312, REFERENCE, 999)));
  const absent = new BillingReader(forwarded.at(-1)!.m_pBlock.subarray(0, forwarded.at(-1)!.m_uOffset));
  expect([absent.u32(), absent.string(), absent.u32(), absent.u32(), absent.u32()])
    .toEqual([321, REFERENCE, 999, BILLING_ORPHAN_STOCK, PURCHASE_CONFIRM.Absent]);

  const shard = db.inventory[GetUserHashNo(GIFT_TARGET)]!;
  shard.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ${GIFT_PREINVENTORY_LIMIT})
    INSERT INTO FxPreInventory(UserID,ItemSN,Amount) SELECT '${GIFT_TARGET}', 1, 1 FROM n`);
  prepare(5000, GIFT_TARGET);
  approve();
  expectConfirm(5000, PURCHASE_CONFIRM.Refuse);
  expect(user.m_nTranxResult).toBe(GIFT_LIMIT_RESULT);
  expect(user.m_nTranxState).toBe(0);
  expect(sent).toHaveLength(0);
  expect(db.GetPreInventoryRows(GIFT_TARGET)).toHaveLength(GIFT_PREINVENTORY_LIMIT);

  refuse("capped");
  expect(client(sent.at(-1)!)).toEqual({
    opcode: 204, code: PURCHASE_RESULT.GiftLimitOver, message: "capped", extra: 1,
  });
  expect(user.m_nTranxResult).toBe(0);

  prepare(5400, GIFT_TARGET);
  user.m_nTranxResult = GIFT_LIMIT_RESULT;
  refuse("owned");
  expect(client(sent.at(-1)!)).toEqual({ opcode: 204, code: PURCHASE_RESULT.AlreadyOwned, message: "owned" });

  prepare(5000, GIFT_TARGET);
  user.m_nTranxStockSN = 9999;
  user.m_nTranxResult = GIFT_LIMIT_RESULT;
  refuse("missing");
  expect(client(sent.at(-1)!)).toEqual({ opcode: 204, code: PURCHASE_RESULT.AlreadyOwned, message: "missing" });
});
