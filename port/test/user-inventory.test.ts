/** A20: native row-budget/field offsets → SQLite → GS loader → client bodies.
 * No Windows execution claimed. The packet reader below is independent of
 * CReceivedPacket and checks native field widths and exact end-of-body. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CDBMan } from "../src/db/DBMan.ts";
import { CServerConfig } from "../src/core/Config.ts";
import { CSendPacket, CReceivedPacket, enSocket } from "../src/core/Packet.ts";
import { CUser, CClientSocket, SendGameSlotInfo } from "../src/FXGS/User.ts";
import { CUserItemMan, UserInventory, type UserItem } from "../src/FXGS/CUserItemMan.ts";
import { CConnectPool } from "../src/FXGS/Pools.ts";
import { CMainSystem, CCenterProcess } from "../src/FXGS/System.ts";
import { CChannelPool } from "../src/FXGS/Chat.ts";
import { CGuildTable, CLocalUserTable } from "../src/FXGS/Tables.ts";
import { CGameSession } from "../src/FXGS/Session.ts";
import { CGameSessionTable } from "../src/FXGS/SessionTable.ts";
import { LoadCAItemBak } from "../src/db/CAItemBak.ts";
import { SESSION_IDX_MAX } from "../src/FXGS/Defs.ts";
import { USER_INVENTORY_LOAD_LIMIT } from "../src/lib/Item.ts";
import { MAX_LOCAL_INVENTORY_ROWS } from "../src/Billing/Defs.ts";

function snapshot() {
  return { cfg: CServerConfig.ms_pInstance, main: CMainSystem.ms_pInstance, items: CUserItemMan.ms_pInstance,
    pool: CConnectPool.ms_pInstance, channel: CChannelPool.ms_pInstance, center: CCenterProcess.ms_pInstance,
    users: CLocalUserTable.ms_pInstance, guilds: CGuildTable.ms_pInstance, sessions: CGameSessionTable.ms_pInstance,
    sockets: CClientSocket.ms_tblSN2Obj, header: CClientSocket.ms_nHeaderTypeCounter };
}
let prior: ReturnType<typeof snapshot>, db: CDBMan, dir: string, pool: CConnectPool, items: CUserItemMan;
let user: CUser, socket: CClientSocket, errors: ReturnType<typeof spyOn<typeof console, "error">>;
const NOW = Date.parse("2026-09-21T04:00:00Z"), FUTURE = "2099-01-01T00:00:00.000Z";
beforeEach(() => {
  prior = snapshot(); dir = mkdtempSync(join(tmpdir(), "sm-inventory-")); db = new CDBMan(dir);
  errors = spyOn(console, "error").mockImplementation(() => {});
  const cfg = new CServerConfig([["ServerIndex", ""]]); cfg.ParseConfigString("ServerIndex 2");
  CServerConfig.ms_pInstance = cfg;
  const main = new CMainSystem(cfg); main.m_fInventoryDB = 1;
  pool = new CConnectPool(db); items = new CUserItemMan(); new CLocalUserTable(); new CGuildTable(db);
  new CChannelPool(db); const center = new CCenterProcess(db); center.SendPacket = () => enSocket.kioOk;
  CGameSessionTable.ms_pInstance = Object.assign(Object.create(CGameSessionTable.prototype), {
    m_apGameSession: [], m_apPracticeSession: [], m_acTableFlags: new Uint8Array(SESSION_IDX_MAX),
  });
  CClientSocket.ms_tblSN2Obj = new Map();
  socket = new CClientSocket(); socket.m_bConnected = true; socket.AddNewUsers(1);
  user = socket.GetUser(0)!; user.SetName("inventory"); user.SetGlobalSerialNo(123); user.m_nLevel = 10;
});
afterEach(() => {
  errors.mockRestore(); db.Close(); rmSync(dir, { recursive: true, force: true });
  CServerConfig.ms_pInstance = prior.cfg; CMainSystem.ms_pInstance = prior.main; CUserItemMan.ms_pInstance = prior.items;
  CConnectPool.ms_pInstance = prior.pool; CChannelPool.ms_pInstance = prior.channel; CCenterProcess.ms_pInstance = prior.center;
  CLocalUserTable.ms_pInstance = prior.users; CGuildTable.ms_pInstance = prior.guilds; CGameSessionTable.ms_pInstance = prior.sessions;
  CClientSocket.ms_tblSN2Obj = prior.sockets; CClientSocket.ms_nHeaderTypeCounter = prior.header;
});
function item(sn: number, fields: Partial<UserItem> = {}) {
  items.m_vtUserItem.set(sn, { Type: 1, strName: `display-${sn}`, strAttr: `Item/${sn}`, nAttr1: 0, nAttr2: 0, nAttr3: 0, ...fields });
}
function own(sn: number, slot = 255, date: string | null = FUTURE, level = 2000) {
  db.inventory[db.GetUserHashNo(user.GetName())].query(`INSERT INTO FxUserInventory
    (UserID,ItemSN,StockSN,Slot,Amount,Verbose,DateCreated,LevelCreated) VALUES(?,?,?, ?,7,'raw-byte-carrier',?,?)`)
    .run(user.GetName(), sn, sn + 10000, slot, date, level);
}
const load = () => pool["InitUserInventory"](user);
const loaded = () => user.m_vtInventory.map(r => r.ItemSN);
const rows = () => db.GetUserInventoryRows(user.GetName()).map(r => r.ItemSN);
function reader(p: CSendPacket) {
  const bytes = Buffer.from(p.m_pBlock.subarray(0, p.m_uOffset)); let off = 1;
  const e1 = () => bytes[off++] ^ 0x5a;
  const e2 = () => { const n = bytes.readUInt16BE(off) ^ 0xa569; off += 2; return n; };
  const e4 = () => { const n = (bytes.readUInt32BE(off) ^ 0x96ca5395) >>> 0; off += 4; return n; };
  const str = () => { const size = e2(), s = bytes.subarray(off, off + size).toString("latin1"); off += size; return s; };
  const raw = (n: number) => { const b = bytes.subarray(off, off + n); off += n; return b; };
  return { e1, e2, e4, str, raw, end: () => expect(off).toBe(bytes.length), bytes };
}
function body(write: (p: CSendPacket) => void): CReceivedPacket {
  const p = new CSendPacket(0); write(p); const n = new CReceivedPacket();
  n.SetRcvPacket(p.m_pBlock.slice(0, p.m_uOffset), p.m_uOffset); n.m_nPacketType = n.Decode1(); return n;
}
function enter(auth: number) {
  expect(db.prCreateUser(user.GetName(), user.GetName(), "fixture", "", 0, 0, "", "", 0, "", "", "", "", "")).toBe(0);
  CLocalUserTable.ms_pInstance!.Insert(user); pool.AddNewSocket(socket);
  const packets: CSendPacket[] = [];
  socket.SendPacket = p => { packets.push(p); return enSocket.kioOk; };
  let closed = false; socket.PostClosePacket = () => { closed = true; };
  pool.OnCenterResConnEstablished(body(p => { p.Encode1(1); p.Encode4(123); p.Encode1(auth); p.Encode1(1); }));
  return { packets, closed };
}

test("empty inventory succeeds; shared 400 is a loader budget, not a SQL LIMIT", () => {
  expect(load()).toBe(true); expect(loaded()).toEqual([]);
  expect(USER_INVENTORY_LOAD_LIMIT).toBe(400); expect(MAX_LOCAL_INVENTORY_ROWS).toBe(400);
});
test("unknown definition is logged and retained even if expired; later known rows still load", () => {
  own(1, 255, "2000-01-01T00:00:00Z", 0); item(2); own(2);
  expect(load()).toBe(true); expect(loaded()).toEqual([2]); expect(rows()).toEqual([1, 2]);
  expect(errors).toHaveBeenCalledWith("[GS] Mismatch: Shop Item Data");
});
for (const count of [399, 400, 401]) test(`${count} valid rows: exactly the first min(count,400) load, no overflow row is deleted`, () => {
  for (let i = 1; i <= count; i++) { item(i); own(i); }
  expect(load()).toBe(true); expect(loaded()).toEqual(Array.from({ length: Math.min(count, 400) }, (_, i) => i + 1));
  expect(rows()).toHaveLength(count);
});
test("mixed boundary: unknown counts, expired does not; rows after the 400th counted row are untouched", () => {
  for (let i = 1; i <= 405; i++) {
    if (i !== 1) item(i);
    own(i, 255, i <= 4 || i === 404 ? "2000-01-01T00:00:00Z" : FUTURE);
  }
  expect(load()).toBe(true);
  expect(loaded()).toEqual(Array.from({ length: 399 }, (_, i) => i + 5));
  expect(rows()).toEqual([1, ...loaded(), 404, 405]);
});
test("400 unknowns exhaust the budget before a known item; no premature expiration or deletion", () => {
  for (let i = 1; i <= 401; i++) own(i);
  item(401); expect(load()).toBe(true); expect(loaded()).toEqual([]);
  expect(errors).toHaveBeenCalledTimes(400); expect(rows()).toHaveLength(401);
});
test("the budget counts this rowset, not preexisting vector length; native does not clear the vector", () => {
  user.AddInventory(Object.assign(new UserInventory(), { ItemSN: 9000 }));
  for (let i = 1; i <= 401; i++) { item(i); own(i); }
  expect(load()).toBe(true); expect(loaded()).toEqual([9000, ...Array.from({ length: 400 }, (_, i) => i + 1)]);
});
test("expiry uses >= for level and > for time; valid ISO timestamps and signed-short level bounds", () => {
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  try {
    for (let i = 1; i <= 8; i++) item(i);
    own(1, 255, new Date(NOW).toISOString(), 11);
    own(2, 255, new Date(NOW - 1000).toISOString(), 11);
    own(3, 255, FUTURE, 10); own(4, 255, FUTURE, 9);
    own(5, 255, FUTURE, 0x1000b); own(6, 255, FUTURE, 0x8000);
    own(7, 255, null); own(8, 255, "invalid"); // retained existing fail-closed policy for malformed SQLite data
    expect(load()).toBe(true); expect(loaded()).toEqual([1, 5]); expect(rows()).toEqual([1, 5]);
    expect(user.m_vtInventory[1].LevelCreated).toBe(11);
  } finally { clock.mockRestore(); }
});
test("expiration clock is sampled per known row, not once at the start of a long load", () => {
  for (let i = 1; i <= 2; i++) { item(i); own(i, 255, new Date(NOW).toISOString()); }
  const clock = spyOn(Date, "now").mockReturnValueOnce(NOW).mockReturnValue(NOW + 1000);
  try { expect(load()).toBe(true); expect(loaded()).toEqual([1]); expect(rows()).toEqual([1]); }
  finally { clock.mockRestore(); }
});
test("SQL rowset-open failure refuses GS entry instead of emitting a successful empty inventory", () => {
  db.inventory[db.GetUserHashNo(user.GetName())].exec("DROP TABLE FxUserInventory");
  const { closed, packets } = enter(0);
  expect(closed).toBe(true); expect(packets).toEqual([]); expect(loaded()).toEqual([]);
});
for (const failure of ["return", "throw"] as const) test(`expired-row deletion ${failure} is ignored by native loader; later valid rows still load`, () => {
  item(1); item(2); own(1, 255, "2000-01-01T00:00:00Z"); own(2);
  if (failure === "throw") db.inventory[db.GetUserHashNo(user.GetName())].exec("CREATE TRIGGER deny_delete BEFORE DELETE ON FxUserInventory BEGIN SELECT RAISE(ABORT,'injected'); END");
  const fail = failure === "return" ? spyOn(db, "prDeleteInventory").mockReturnValue(-1) : null;
  try { expect(load()).toBe(true); expect(loaded()).toEqual([2]); expect(rows()).toEqual([1, 2]); }
  finally { fail?.mockRestore(); }
});
for (const auth of [0, 1, 255]) test(`center auth byte ${auth} remains separate from level icon and bonus-level state`, () => {
  item(1, { Type: 5 }); own(1, 0);
  item(2, { Type: 6, nAttr1: 15 }); own(2, 0);
  const { closed, packets } = enter(auth);
  expect(closed).toBe(false); expect(packets.some(p => p.m_nPacketType === 201)).toBe(true);
  expect([user.GetAuthencode(), user.GetLevelIconSn(), user.GetFakeLevel()]).toEqual([auth, 1, 15]);
  expect(user.GetLookLevel()).toBe(16);
});
test("unequipped/expired cosmetics do not change auth, icon or bonus; BYTE slot and last equipped native overwrite", () => {
  for (const [sn, type, attr, slot] of [[1, 5, 0, 0], [2, 5, 0, 0], [3, 5, 0, 511], [4, 6, 15, 0], [5, 6, -15, 0], [6, 6, 30, -1], [7, 6, 45, 0]]) {
    item(sn, { Type: type, nAttr1: attr }); own(sn, slot, sn === 7 ? "2000-01-01T00:00:00Z" : FUTURE);
  }
  user.m_fPremiumTicket = 1; expect(load()).toBe(true);
  expect([user.GetAuthencode(), user.GetLevelIconSn(), user.GetFakeLevel()]).toEqual([1, 2, -15]);
  expect(user.GetLookLevel()).toBe(1); expect(user.GetUserInventory(3)?.SlotByte).toBe(255);
});
test("original catalog functional names are strAttr, not localized strName; matching is case-sensitive, ownership need not be equipped", () => {
  for (const r of LoadCAItemBak().tables.FxItem.filter(r => [1, 72, 73, 10005].includes(Number(r.SN)))) {
    item(Number(r.SN), { Type: Number(r.Category), strName: r.strName as string, strAttr: r.strAttr as string }); own(Number(r.SN));
  }
  expect(load()).toBe(true);
  expect(user.HasFunctionalItem("Item/SuperChief")).toBe(true);
  expect(user.HasFunctionalItem("Item/BanReflex")).toBe(true);
  expect(user.HasFunctionalItem("Item/RoomTicket")).toBe(true);
  expect(user.HasFunctionalItem("item/SuperChief")).toBe(false);
  expect(user.HasFunctionalItem(items.GetUserItem(72)!.strName)).toBe(false);
  expect(user.GetUserInventoryFromAll("Item/ItemNiddle")?.ItemSN).toBe(1);
  expect(user.HasFunctionalItem("Item/ItemNiddle")).toBe(false);
});
test("all nine/five decoration kinds use nAttr2, not DB Slot; first equipped match wins, out-of-range kinds stay off the wire", () => {
  for (let i = 0; i < 9; i++) { item(100 + i, { Type: 10, nAttr1: 0x10000 + 50 + i, nAttr2: i }); own(100 + i, 0); }
  for (let i = 0; i < 5; i++) { item(200 + i, { Type: 12, nAttr1: -1, nAttr2: i, nAttr3: 30 + i }); own(200 + i, 1); }
  item(1, { Type: 10, nAttr1: 999, nAttr2: 0 }); own(1); // unequipped does not hide the later match
  item(300, { Type: 10, nAttr1: 999, nAttr2: 0 }); own(300, 0);
  item(301, { Type: 10, nAttr2: 9 }); own(301, 0);
  item(302, { Type: 12, nAttr2: 5 }); own(302, 0);
  item(400, { Type: 14, nAttr3: 0x12345678 }); own(400, 0);
  item(500, { Type: 3 }); own(500); // category-3 tail includes unequipped items
  user.SetFakeLevel(-15);
  expect(load()).toBe(true);
  for (let i = 0; i < 9; i++) expect(user.GetSlotDecorationLoaded(i)?.ItemSN).toBe(100 + i);
  for (let i = 0; i < 5; i++) expect(user.GetCharDecoLoaded(i)?.ItemSN).toBe(200 + i);
  expect(user.GetSlotDecorationLoaded(9)?.ItemSN).toBe(301); // lookup itself is not range-clamped
  const p = new CSendPacket(71, 2); SendGameSlotInfo(p, user); const r = reader(p);
  expect(r.e1()).toBe(9);
  for (let i = 0; i < 9; i++) expect([r.e1(), r.e2()]).toEqual([i, 50 + i]);
  expect([r.e2(), r.e2(), r.e2()]).toEqual([65521, 1, 500]); r.end();
  const session = new CGameSession(); session.m_rgPlayer[3] = user;
  const accessory = new CSendPacket(105, 2); session.MakeSlotAccessoryPacket(3, accessory); const a = reader(accessory);
  expect([a.e1(), a.e1()]).toEqual([9, 3]);
  for (let i = 0; i < 9; i++) expect([a.e1(), a.e2()]).toEqual([i, 50 + i]);
  expect([a.e1(), a.e1()]).toEqual([5, 3]);
  for (let i = 0; i < 5; i++) expect([a.e4(), a.e4(), a.e4()]).toEqual([0xffffffff, i, 30 + i]);
  expect(a.e4()).toBe(0x12345678); a.end();
});
test("empty local/remote detail tails are exactly E1/E2/E2; empty room player emits nothing", () => {
  for (const target of [user, null]) {
    const p = new CSendPacket(71, 2); SendGameSlotInfo(p, target);
    expect(reader(p).bytes.subarray(1).toString("hex")).toBe("5aa569a569");
  }
  const p = new CSendPacket(105, 2); new CGameSession().MakeSlotAccessoryPacket(0, p); expect(p.m_uOffset).toBe(1);
});
test("DB-loaded live inventory preserves fields and packet 201 order/width; fresh-user reentry repeats the same snapshot", () => {
  item(1, { Type: 10, nAttr1: 91, nAttr2: 2, nAttr3: 3 }); own(1, 4);
  expect(load()).toBe(true);
  expect(user.m_vtInventory[0]).toMatchObject({ ItemSN: 1, StockSn: 10001, Type: 10, strAttr: "Item/1", nAttr1: 91, nAttr2: 2, nAttr3: 3,
    SlotByte: 4, Amount: 7, Verbose: "raw-byte-carrier", LevelCreated: 2000, fModified: 0 });
  const packet = new CSendPacket(201, 2); user.MakeUserInventoryPacket(packet); const r = reader(packet);
  expect([r.e2(), r.e4(), r.e1(), r.e4(), r.str()]).toEqual([1, 1, 4, 7, "raw-byte-carrier"]);
  expect(r.raw(8).length).toBe(8); // date value/timezone belongs to the still-open A13 audit
  r.end();
  user = new CUser(socket); user.SetName("inventory"); user.m_nLevel = 10; expect(load()).toBe(true);
  const again = new CSendPacket(201, 2); user.MakeUserInventoryPacket(again);
  expect(reader(again).bytes).toEqual(reader(packet).bytes);
});

test("functional lookup has native NUL-terminated byte equality, not Unicode case folding", () => {
  item(1, { Type: 2, strAttr: "Item/RoomTicket\0ignored" }); own(1);
  item(2, { strAttr: "Item/ItemSpeaker" }); own(2);
  expect(load()).toBe(true);
  expect(user.HasFunctionalItem("Item/RoomTicket")).toBe(true);
  expect(user.HasFunctionalItem("Item/RoomTicket\0other")).toBe(true);
  expect(user.HasFunctionalItem("item/RoomTicket")).toBe(false);
  expect(user.GetUserInventoryFromAll("Item/ItemSpeaker\0tail")?.ItemSN).toBe(2);
});
test("native cosmetic/auth accessors retain int32/BYTE semantics and disabled icon SN is not an authorization flag", () => {
  user.SetFakeLevel(0x10000000f); expect(user.GetFakeLevel()).toBe(15);
  user.SetAuthenCode(257); expect(user.GetAuthencode()).toBe(1);
  for (const enabled of [0, 1, -1]) {
    user.SetLevelIcon(enabled, 0x100000063); expect(user.GetLevelIconSn()).toBe(99);
    const p = new CSendPacket(70, 2); user.AppendSimpleInfoPacket(p); const r = reader(p);
    expect([r.str(), r.e1(), r.e2(), r.e4(), r.e4(), r.e2()]).toEqual(["inventory", 0, 25, enabled ? 99 : 0, 0, 0]); r.end();
    expect(user.GetAuthencode()).toBe(1);
  }
});

for (const slot of [255, 0]) test(`DB-loaded category-4 entry effect at Slot ${slot}: only self packet 105 carries its low BYTE`, () => {
  item(1, { Type: 4, nAttr1: 0x1234 }); own(1, slot); expect(load()).toBe(true);
  const session = new CGameSession(); session.m_rgPlayer[2] = user;
  for (const self of [0, 1]) {
    const p = new CSendPacket(0, 2); session.MakeSetPlayerPacket(2, self, p); const r = reader(p);
    expect(p.m_nPacketType).toBe(105);
    expect([r.e1(), r.e4(), r.e1(), r.e1()]).toEqual([2, 123, self, 0]);
    if (self) expect(r.e1()).toBe(slot === 255 ? 255 : 0x34);
    expect([...r.raw(3)]).toEqual([0, 0, 0]);
    expect([r.str(), r.e1(), r.e2(), r.e4(), r.e4(), r.e2()]).toEqual(["inventory", 0, 10, 0, 0, 0]);
    expect([r.e1(), r.e1(), r.e4()]).toEqual([0, 0, 0]); r.end();
  }
});

test("two-player center response keeps auth bytes and owned-item snapshots assigned to their respective users", () => {
  socket.AddNewUsers(2); user = socket.GetUser(0)!;
  const players = [user, socket.GetUser(1)!];
  for (let i = 0; i < players.length; i++) {
    const player = players[i], id = `inventory${i}`;
    player.SetName(id); player.SetGlobalSerialNo(123 + i);
    expect(db.prCreateUser(id, id, "fixture", "", 0, 0, "", "", 0, "", "", "", "", "")).toBe(0);
    CLocalUserTable.ms_pInstance!.Insert(player);
  }
  item(1, { Type: 5 }); own(1, 0);
  pool.AddNewSocket(socket);
  const packets: CSendPacket[] = [];
  socket.SendPacket = p => { packets.push(p); return enSocket.kioOk; };
  pool.OnCenterResConnEstablished(body(p => {
    p.Encode1(2); p.Encode4(123); p.Encode4(124); p.Encode1(0); p.Encode1(1); p.Encode1(1);
  }));
  expect(players.map(p => [p.GetAuthencode(), p.GetLevelIconSn(), p.m_vtInventory.length])).toEqual([[0, 1, 1], [1, 0, 0]]);
  const inventory = packets.find(p => p.m_nPacketType === 201)!; expect(inventory).toBeDefined();
  const r = reader(inventory); expect([r.e1(), r.e2(), r.e4(), r.e1(), r.e4(), r.str()]).toEqual([2, 1, 1, 0, 7, "raw-byte-carrier"]);
  r.raw(8); expect(r.e2()).toBe(0); r.end();
});
