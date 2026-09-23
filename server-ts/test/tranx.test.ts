/** A12: FxShop's durable TranxLog file and client 225/211 cursor protocol. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import type { CDBMan } from "../src/db/DBMan.ts";
import { CBillingProcess } from "../src/FXSS/BillingProcess.ts";
import type { CClientSocket } from "../src/FXSS/ClientSocket.ts";
import { CItemMan } from "../src/FXSS/ItemMan.ts";
import { CLocalUserTable } from "../src/FXSS/LocalUserTable.ts";
import { CMainPool } from "../src/FXSS/MainPool.ts";
import { PackageMap, ShopItem } from "../src/FXSS/Recordsets.ts";
import { CTranxCtrl, TRANSACTION_PAGE_BYTES } from "../src/FXSS/TranxCtrl.ts";
import { CUser } from "../src/FXSS/User.ts";
import { purchaseReply } from "../src/services/LocalBilling/Protocol.ts";

const directories: string[] = [];
let priorTranx: CTranxCtrl | null;
let priorPool: CMainPool | null;
let priorBilling: CBillingProcess | null;
let priorUsers: CLocalUserTable | null;
let priorItems: CItemMan | null;

beforeEach(() => {
  priorTranx = CTranxCtrl.ms_pInstance;
  priorPool = CMainPool.ms_pInstance;
  priorBilling = CBillingProcess.ms_pInstance;
  priorUsers = CLocalUserTable.ms_pInstance;
  priorItems = CItemMan.ms_pInstance;
});

afterEach(() => {
  CTranxCtrl.ms_pInstance = priorTranx;
  CMainPool.ms_pInstance = priorPool;
  CBillingProcess.ms_pInstance = priorBilling;
  CLocalUserTable.ms_pInstance = priorUsers;
  CItemMan.ms_pInstance = priorItems;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "sm-tranx-"));
  directories.push(path);
  return path;
}

/** Read initialized PE32 data by virtual address without running FxShop. */
function peData(va: number, length: number): Buffer {
  const pe = readFileSync(join(import.meta.dir, "../..", "FXSS", "FxShop.exe"));
  const nt = pe.readUInt32LE(0x3c);
  const optionalHeader = nt + 24;
  const rva = va - pe.readUInt32LE(optionalHeader + 28);
  const sectionCount = pe.readUInt16LE(nt + 6);
  const sectionTable = optionalHeader + pe.readUInt16LE(nt + 20);
  for (let index = 0; index < sectionCount; index++) {
    const section = sectionTable + index * 40;
    const size = pe.readUInt32LE(section + 8);
    const base = pe.readUInt32LE(section + 12);
    if (rva < base || rva + length > base + size) continue;
    const offset = pe.readUInt32LE(section + 20) + rva - base;
    return pe.subarray(offset, offset + length);
  }
  throw new Error(`No FxShop section contains VA ${va.toString(16)}`);
}

function body(write: (packet: CSendPacket) => void): CReceivedPacket {
  const packet = new CSendPacket(0);
  write(packet);
  const received = new CReceivedPacket();
  // Client 225 is decoded on the socket's cipher, not as raw bytes.
  received.SetCipherDegree(packet.m_nCipherDegree);
  const bytes = packet.m_pBlock.slice(1, packet.m_uOffset);
  received.SetRcvPacket(bytes, bytes.length);
  return received;
}

function decode(packet: CSendPacket): CReceivedPacket {
  const received = new CReceivedPacket();
  received.SetCipherDegree(packet.m_nCipherDegree);
  received.SetRcvPacket(packet.m_pBlock.slice(0, packet.m_uOffset), packet.m_uOffset);
  return received;
}

test("the PE fixes the date path, a+ mode, and exact CRLF transaction format", () => {
  expect(peData(0x47f078, 14).toString("latin1")).toBe("Log\\TranxLog_\0");
  expect(peData(0x47f090, 13).toString("latin1")).toBe("%04d%02d%02d\0");
  expect(peData(0x47f0a0, 3).toString("latin1")).toBe("a+\0");
  expect(peData(0x47f0cc, 26).toString("latin1")).toBe("%d:%d:%d,%d,%d,%d,%d,%d\r\n\0");
  // `a+`/`r` use the statically linked MSVC CRT's text mode. `_write`
  // inserts CR before LF and `_read` folds that physical CRLF pair again.
  expect(peData(0x46a55b, 11).toString("hex")).toBe("80fa0a750aff4584c6000d");
  expect(peData(0x469d04, 15).toString("hex")).toBe("8b45104080380a750683451002eb59");
  // GetData writes `(offset + count >= size) ? 0 : offset + count` through int&.
  expect(peData(0x41e897, 29).toString("hex")).toBe(
    "8b4c24548b118b4c245003ca33d23bc88b4424540f9dc2534a23d18910",
  );
});

test("AddTranx appends, flushes, rotates by native day check, and survives restart", () => {
  const root = directory();
  let now = new Date(2026, 8, 21, 5, 6, 7);
  const ctrl = new CTranxCtrl(root, () => now);
  expect(ctrl.Init()).toBe(1);
  const first = { kind: 0, stockSN: 5000, itemSN: 300, amount: 2, price: 100 };
  expect(ctrl.AddTranx(first)).toBe(1);
  expect(ctrl.AddTranx({ kind: 1, stockSN: -1, itemSN: 2, amount: 3, price: 4 })).toBe(1);
  expect(readFileSync(join(root, "TranxLog_20260921.txt"), "ascii"))
    .toBe("5:6:7,0,5000,300,2,100\r\r\n5:6:7,1,-1,2,3,4\r\r\n");

  now = new Date(2026, 8, 22, 0, 0, 1);
  ctrl.AddTranx(first);
  const nextPath = join(root, "TranxLog_20260922.txt");
  expect(readFileSync(nextPath, "ascii")).toBe("0:0:1,0,5000,300,2,100\r\r\n");

  const reopened = new CTranxCtrl(root, () => now);
  reopened.Init();
  reopened.AddTranx(first);
  // Native stores and compares only SYSTEMTIME.wDay: the same day number in
  // a later month deliberately stays on the already-open September file.
  now = new Date(2026, 9, 22, 2, 3, 4);
  reopened.AddTranx(first);
  expect(existsSync(join(root, "TranxLog_20261022.txt"))).toBe(false);
  expect(readFileSync(nextPath, "ascii")).toBe(
    "0:0:1,0,5000,300,2,100\r\r\n0:0:1,0,5000,300,2,100\r\r\n2:3:4,0,5000,300,2,100\r\r\n",
  );
  const page = new Uint8Array(TRANSACTION_PAGE_BYTES);
  const result = reopened.GetData(2026, 9, 22, page, 0);
  expect(result).toEqual({ length: 72, nextOffset: 0 });
  expect(Buffer.from(page.subarray(0, result.length)).toString("ascii")).toBe(
    "0:0:1,0,5000,300,2,100\r\n0:0:1,0,5000,300,2,100\r\n2:3:4,0,5000,300,2,100\r\n",
  );
});

test("GetData pages CRT text bytes by offset; EOF resets and missing dates preserve the cursor", () => {
  const root = directory();
  const bytes = Buffer.from(`${"x".repeat(510)}\r\n${"y".repeat(525)}`, "ascii");
  const diskBytes = Buffer.from(bytes.toString("ascii").replaceAll("\n", "\r\n"), "ascii");
  writeFileSync(join(root, "TranxLog_20260920.txt"), diskBytes);
  const ctrl = new CTranxCtrl(root, () => new Date(2026, 8, 21));
  ctrl.Init();
  const destination = new Uint8Array(TRANSACTION_PAGE_BYTES);

  const first = ctrl.GetData(2026, 9, 20, destination, 0);
  expect(first).toEqual({ length: 500, nextOffset: 500 });
  expect(destination).toEqual(bytes.subarray(0, 500));
  const second = ctrl.GetData(2026, 9, 20, destination, first.nextOffset);
  expect(second).toEqual({ length: 500, nextOffset: 1000 });
  expect(destination).toEqual(bytes.subarray(500, 1000));
  const last = ctrl.GetData(2026, 9, 20, destination, second.nextOffset);
  expect(last).toEqual({ length: 37, nextOffset: 0 });
  expect(destination.subarray(0, last.length)).toEqual(bytes.subarray(1000));
  expect(ctrl.GetData(2026, 9, 20, destination, bytes.length)).toEqual({ length: 0, nextOffset: 0 });
  expect(ctrl.GetData(2026, 9, 19, destination, 123)).toEqual({ length: 0, nextOffset: 123 });
  expect(ctrl.GetData(2026, 9, 21, destination, 0)).toEqual({ length: 0, nextOffset: 0 });
  expect(ctrl.GetData(2026, 9, 20, destination, 0xffff_ffff)).toEqual({ length: 0, nextOffset: 0 });
});

test("client 225 receives page bytes and the updated cursor, not its request cursor", () => {
  const root = directory();
  const bytes = Buffer.alloc(620, 0x5a);
  writeFileSync(join(root, "TranxLog_20260921.txt"), bytes);
  new CTranxCtrl(root, () => new Date(2026, 8, 21)).Init();
  const pool = new CMainPool({} as CDBMan);
  const sent: CSendPacket[] = [];
  const socket = {
    m_nSelectedUserIdx: 0,
    GetUser: () => ({}),
    SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; },
  } as unknown as CClientSocket;

  pool.OnRequestTranxData(body((packet) => {
    packet.Encode2(2026); packet.Encode2(9); packet.Encode2(21); packet.Encode4(0);
  }), socket);

  expect(sent).toHaveLength(1);
  const response = decode(sent[0]!);
  expect(response.Decode1()).toBe(211);
  expect(response.Decode2()).toBe(500);
  const page = new Uint8Array(500);
  expect(response.DecodeBufferAt(response.m_uOffset, page, page.length)).toBe(page.length);
  response.m_uOffset += page.length;
  expect(page).toEqual(bytes.subarray(0, 500));
  expect(response.Decode4()).toBe(500);
  expect(response.m_uOffset).toBe(response.m_uLength);
});

test("client 225 answers the request socket when no user is selected, and a missing date keeps the cursor", () => {
  const root = directory();
  new CTranxCtrl(root, () => new Date(2026, 8, 21)).Init();
  const pool = new CMainPool({} as CDBMan);
  const sent: CSendPacket[] = [];
  const socket = {
    GetUser: () => null,
    SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; },
  } as unknown as CClientSocket;

  pool.OnRequestTranxData(body((packet) => {
    packet.Encode2(2026); packet.Encode2(9); packet.Encode2(19); packet.Encode4(40);
  }), socket);

  expect(sent).toHaveLength(1);
  const response = decode(sent[0]!);
  expect(response.Decode1()).toBe(211);
  expect(response.Decode2()).toBe(0);
  expect(response.Decode4()).toBe(40);
  expect(response.m_uOffset).toBe(response.m_uLength);
});

test("a successful package 322 logs parent stock/price and the last child fields before reset", () => {
  const root = directory();
  new CTranxCtrl(root, () => new Date(2026, 8, 21, 5, 6, 7)).Init();
  const items = new CItemMan();
  CItemMan.ms_pInstance = items;
  const stock = new ShopItem();
  Object.assign(stock, { SN: 5000, Category: 11, ItemSN: 0, Unit: 1, Price: 150 });
  items.m_mapShopItem.set(stock.SN, stock);
  for (const [stockSN, itemSN, unit, units] of [[5001, 300, 2, 3], [5002, 301, 5, 2]] as const) {
    const child = new ShopItem();
    Object.assign(child, { SN: stockSN, Category: 1, ItemSN: itemSN, Unit: unit });
    items.m_mapShopItem.set(stockSN, child);
    const mapping = new PackageMap();
    Object.assign(mapping, { PackageSN: stock.SN, StockSN: stockSN, Units: units });
    items.m_ltPackageMap.push(mapping);
  }
  const users = new CLocalUserTable();
  const sent: CSendPacket[] = [];
  const socket = {
    m_strPeerAddress: "127.0.0.1",
    SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; },
  } as unknown as CClientSocket;
  const user = new CUser(socket);
  user.SetName("buyer"); user.SetGlobalSerialNo(77); user.m_nSID = 11; user.m_nBID = 22;
  users.Insert(user);
  const billing = new CBillingProcess({} as CDBMan);
  billing.m_fLocalBilling = true; billing.m_fConnected = 1;
  const forwarded: CSendPacket[] = [];
  billing.Send = (packet) => { forwarded.push(packet); };

  billing.RequestPurchaseTw(user, stock);
  billing.OnPacket(decode(purchaseReply(312, "a".repeat(32), 77, "", 5000)));
  billing.OnPacket(decode(purchaseReply(322, "a".repeat(32), 77)));

  expect(forwarded.map((packet) => packet.m_nPacketType)).toEqual([311, 321]);
  expect(sent).toHaveLength(1);
  expect(readFileSync(join(root, "TranxLog_20260921.txt"), "ascii"))
    .toBe("5:6:7,0,5000,301,10,150\r\r\n");
  expect(user.m_strTranxInfo).toBe("");
});
