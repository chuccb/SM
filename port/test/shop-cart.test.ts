/** A09 cart cursor/count consumption and A22 Price-keyed bonus-map regressions. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CDBMan } from "../src/db/DBMan.ts";
import { CBillingProcess } from "../src/FXSS/BillingProcess.ts";
import { CClientSocket } from "../src/FXSS/ClientSocket.ts";
import { CItemMan } from "../src/FXSS/ItemMan.ts";
import { CMainPool } from "../src/FXSS/MainPool.ts";
import { CMainSystem } from "../src/FXSS/MainSystem.ts";
import { BonusMap, ShopItem } from "../src/FXSS/Recordsets.ts";
import { CUser } from "../src/FXSS/User.ts";

let dir: string;
let db: CDBMan;
let pool: CMainPool;
let billing: CBillingProcess;
let items: CItemMan;
let user: CUser;
let socket: CClientSocket;
let sent: CSendPacket[];
let previousPool: CMainPool | null;
let previousBilling: CBillingProcess | null;
let previousItems: CItemMan | null;
let previousMain: CMainSystem | null;

beforeEach(() => {
  previousPool = CMainPool.ms_pInstance;
  previousBilling = CBillingProcess.ms_pInstance;
  previousItems = CItemMan.ms_pInstance;
  previousMain = CMainSystem.ms_pInstance;
  dir = mkdtempSync(join(tmpdir(), "sm-cart-"));
  db = new CDBMan(dir);
  pool = new CMainPool(db);
  billing = new CBillingProcess(db);
  pool.billingProcess = billing;
  items = new CItemMan();
  CItemMan.ms_pInstance = items;
  new CMainSystem();
  user = new CUser(null);
  sent = [];
  socket = {
    m_nSelectedUserIdx: 0,
    GetUser: () => user,
    SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; },
  } as unknown as CClientSocket;
  user.m_pSocket = socket;
});

afterEach(() => {
  db.Close();
  rmSync(dir, { recursive: true, force: true });
  CMainPool.ms_pInstance = previousPool;
  CBillingProcess.ms_pInstance = previousBilling;
  CItemMan.ms_pInstance = previousItems;
  CMainSystem.ms_pInstance = previousMain;
});

function body(write: (packet: CSendPacket) => void): CReceivedPacket {
  const packet = new CSendPacket(0);
  write(packet);
  const received = new CReceivedPacket();
  const bytes = packet.m_pBlock.slice(1, packet.m_uOffset);
  received.SetRcvPacket(bytes, bytes.length);
  return received;
}

function decode(packet: CSendPacket): CReceivedPacket {
  const received = new CReceivedPacket();
  received.SetRcvPacket(packet.m_pBlock.slice(0, packet.m_uOffset), packet.m_uOffset);
  received.SetCipherDegree(packet.m_nCipherDegree);
  received.m_nPacketType = received.Decode1();
  return received;
}

function stock(sn: number, moneyType = 1, price = 0): void {
  items.m_mapShopItem.set(sn, Object.assign(new ShopItem(), { SN: sn, MoneyType: moneyType, Price: price }));
}

function requestCart(entries: readonly (readonly [stockSN: number, count: number])[]): void {
  pool.OnReqPurchaseCartList(body((packet) => {
    packet.Encode1(entries.length);
    for (const [stockSN, count] of entries) {
      packet.Encode2(stockSN);
      packet.Encode1(count);
    }
  }), socket);
}

test("no-bonus cart starts at the last row, consumes every count, clears +0xBF0, then emits 215", () => {
  stock(10);
  stock(20);
  const purchases: number[] = [];
  const purchase = spyOn(pool, "OnReqPurchaseStockItem").mockImplementation((_user, stockSN) => {
    purchases.push(stockSN);
  });
  try {
    requestCart([[10, 2], [20, 3]]);
  } finally {
    purchase.mockRestore();
  }

  expect(purchases).toEqual([20, 20, 20, 10, 10]);
  expect(user.m_anCart).toEqual([{ stockSN: 10, cnt: 0 }, { stockSN: 20, cnt: 0 }]);
  expect(user.m_nCartCount).toBe(-1);
  expect(user.m_fCartProcessing).toBe(0);
  expect(sent).toHaveLength(1);
  const receipt = decode(sent[0]!);
  expect(receipt.m_nPacketType).toBe(215);
  expect([receipt.Decode1(), receipt.Decode1()]).toEqual([9, 0]);
  expect(receipt.m_uLength - receipt.m_uOffset).toBe(8);
});

test("a completed cart clears its state and accepts the next cart request", () => {
  stock(10);
  const purchases: number[] = [];
  const purchase = spyOn(pool, "OnReqPurchaseStockItem").mockImplementation((_user, stockSN) => {
    purchases.push(stockSN);
  });
  try {
    requestCart([[10, 1]]);
    requestCart([[10, 1]]);
  } finally {
    purchase.mockRestore();
  }
  expect(purchases).toEqual([10, 10]);
  expect(sent.map((packet) => decode(packet).m_nPacketType)).toEqual([215, 215]);
  expect(user.m_nCartCount).toBe(-1);
  expect(user.m_fCartProcessing).toBe(0);
});

test("a zero-row malformed cart is rejected without preserving a stuck cart-busy flag", () => {
  const purchase = spyOn(pool, "OnReqPurchaseStockItem").mockImplementation(() => {});
  try {
    requestCart([]);
    expect(purchase).not.toHaveBeenCalled();
  } finally {
    purchase.mockRestore();
  }
  expect(user.m_nCartCount).toBe(-1);
  expect(user.m_fCartProcessing).toBe(0);
  expect(sent).toEqual([]);
});

test("an unknown cart stock is safely rejected before any purchase side effect", () => {
  const purchase = spyOn(pool, "OnReqPurchaseStockItem").mockImplementation(() => {});
  try {
    requestCart([[0xffff, 1]]);
    expect(purchase).not.toHaveBeenCalled();
  } finally {
    purchase.mockRestore();
  }
  expect(user.m_fCartProcessing).toBe(0);
  expect(sent).toEqual([]);
});

test("a failed game-money row is still consumed before the native cart completion receipt", () => {
  stock(10, 1, 100);
  user.m_nCash = 0;
  requestCart([[10, 1]]);

  expect(user.m_nCash).toBe(0);
  expect(user.m_nCartCount).toBe(-1);
  expect(user.m_fCartProcessing).toBe(0);
  expect(sent).toHaveLength(1);
  const receipt = decode(sent[0]!);
  expect(receipt.m_nPacketType).toBe(215);
  expect([receipt.Decode1(), receipt.Decode1()]).toEqual([9, 0]);
});

test("bonus occupies the next-empty slot; after it, a billing row pauses the native walk", () => {
  stock(10, 0, 100);
  stock(30, 1, 0);
  items.m_mapBonusMap.set(100, Object.assign(new BonusMap(), { Price: 100, StockSN: 30 }));
  const purchases: number[] = [];
  const purchase = spyOn(pool, "OnReqPurchaseStockItem").mockImplementation((_user, stockSN) => {
    purchases.push(stockSN);
  });
  try {
    requestCart([[10, 1]]);
  } finally {
    purchase.mockRestore();
  }

  expect(purchases).toEqual([30, 10]);
  expect(user.m_anCart).toEqual([{ stockSN: 10, cnt: 0 }, { stockSN: 30, cnt: 0 }]);
  expect(user.m_nCartCount).toBe(0);
  expect(user.m_fCartProcessing).toBe(1);
  expect(sent).toEqual([]);
});

test("billing total adds each cart row's price once, not price multiplied by its count", () => {
  stock(10, 0, 100);
  stock(30, 1, 0);
  items.m_mapBonusMap.set(200, Object.assign(new BonusMap(), { Price: 200, StockSN: 30 }));
  const purchases: number[] = [];
  const purchase = spyOn(pool, "OnReqPurchaseStockItem").mockImplementation((_user, stockSN) => {
    purchases.push(stockSN);
  });
  try {
    requestCart([[10, 3]]);
  } finally {
    purchase.mockRestore();
  }

  expect(purchases).toEqual([10]);
  expect(user.m_anCart).toEqual([{ stockSN: 10, cnt: 2 }]);
  expect(user.m_nCartCount).toBe(0);
  expect(user.m_fCartProcessing).toBe(1);
  expect(sent).toEqual([]);
});

test("the SQLite rowset has no StockSN ordering before duplicate Price insertion", () => {
  db.item.exec(`INSERT INTO FxBonusMap (Price, StockSN) VALUES (100, 30), (100, 20), (200, 10)`);
  expect(items.UpdateBonusMapTable(db)).toBe(1);
  expect([...items.m_mapBonusMap.values()].map((bonus) => [bonus.Price, bonus.StockSN]))
    .toEqual([[100, 30], [200, 10]]);
});

test("BonusMap is unsigned-Price ordered, insert-unique, and picks the highest eligible threshold", () => {
  const rows = spyOn(db, "GetFxBonusMapRows").mockReturnValue([
    { Price: 200, StockSN: 10 },
    { Price: 100, StockSN: 20 },
    { Price: 100, StockSN: 30 },
  ]);
  try {
    expect(items.UpdateBonusMapTable(db)).toBe(1);
  } finally {
    rows.mockRestore();
  }

  expect([...items.m_mapBonusMap].map(([price, bonus]) => [price, bonus.Price, bonus.StockSN]))
    .toEqual([[100, 100, 20], [200, 200, 10]]);
  for (const [total, expected] of [[99, undefined], [100, 20], [199, 20], [200, 10], [250, 10]] as const) {
    const cart = { m_anCart: [] as { stockSN: number; cnt: number }[] };
    expect(items.AddBonusCartItem(total, cart, 0)).toBe(expected === undefined ? 0 : 1);
    if (expected === undefined) expect(cart.m_anCart).toEqual([]);
    else expect(cart.m_anCart[0]?.stockSN).toBe(expected);
  }

  const packet = new CSendPacket(0);
  items.MakeBonusMap(packet);
  const payload = decode(packet);
  expect(payload.Decode2()).toBe(2);
  expect([payload.Decode4(), payload.Decode4(), payload.Decode4(), payload.Decode4()])
    .toEqual([100, 20, 200, 10]);
  expect(payload.m_uOffset).toBe(payload.m_uLength);
});

test("BonusMap rowset-open failure returns zero and keeps the published snapshot", () => {
  items.m_mapBonusMap.set(50, Object.assign(new BonusMap(), { Price: 50, StockSN: 5 }));
  const rows = spyOn(db, "GetFxBonusMapRows").mockImplementation(() => { throw new Error("injected open failure"); });
  try {
    expect(items.UpdateBonusMapTable(db)).toBe(0);
  } finally {
    rows.mockRestore();
  }
  expect([...items.m_mapBonusMap.values()].map((bonus) => [bonus.Price, bonus.StockSN]))
    .toEqual([[50, 5]]);
});

test("BonusMap key ordering is uint32 while the eligibility cmp remains signed", () => {
  const rows = spyOn(db, "GetFxBonusMapRows").mockReturnValue([
    { Price: -1, StockSN: 9 },
    { Price: 1, StockSN: 0xffff_ffff },
    { Price: 0, StockSN: 0 },
    { Price: 0xffff_ffff, StockSN: 99 }, // duplicate uint key of -1: ignored
  ]);
  try {
    items.UpdateBonusMapTable(db);
  } finally {
    rows.mockRestore();
  }

  expect([...items.m_mapBonusMap.keys()]).toEqual([0, 1, 0xffff_ffff]);
  expect([...items.m_mapBonusMap.values()].map((bonus) => [bonus.Price, bonus.StockSN]))
    .toEqual([[0, 0], [1, 0xffff_ffff], [-1, 9]]);
  const cart = { m_anCart: [] as { stockSN: number; cnt: number }[] };
  expect(items.AddBonusCartItem(-1, cart, 0)).toBe(1);
  expect(cart.m_anCart[0]).toEqual({ stockSN: 9, cnt: 1 });
});
