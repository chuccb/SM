import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDBMan, EncodePassword, GetUserHashNo } from "../src/db/DBMan.ts";
import { BillingStore } from "../src/Billing/Store.ts";
import { BillingServer } from "../src/Billing/Server.ts";
import { BillingReader, string8, purchaseReply } from "../src/Billing/Protocol.ts";
import { RESERVATION_MS, AUTHORIZATION_MS, MAX_CASH, type PurchaseRequest } from "../src/Billing/Defs.ts";
import { canUseLocalBilling, registerLocalBilling, usesLocalBilling } from "../src/Billing/Config.ts";
import { CSendPacket as BillingPacket } from "../src/FXSS/Packet.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CCenterProcess, CMainPool, CClientSocket, CLocalUserTable, CBillingProcess, CBillingSocketTw } from "../src/FXSS/Shop.ts";
import { ShopItem } from "../src/FXSS/CItemMan.ts";
import { PacketLog } from "../src/core/PacketLog.ts";

let dir: string, db: CDBMan, store: BillingStore, clock: number;
const cleanup: (() => void)[] = [];
const request: PurchaseRequest = { world: 0, name: "alice", serial: 123, stock: 5000, price: 100 };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-billing-"));
  db = new CDBMan(dir); clock = Date.now(); store = new BillingStore(db, () => clock);
  for (const [name, sn] of [["alice", 11], ["bob", 12]] as const) {
    const shard = db.userInfo[GetUserHashNo(name)];
    shard.query("INSERT INTO FxUserAccount(ID,SN,Password) VALUES(?,?,?)").run(name, sn, EncodePassword("testpw"));
    shard.query("INSERT INTO FxUserDynamic(ID,Money,Exp) VALUES(?,999,0)").run(name);
  }
  db.item.exec(`INSERT INTO FxItem(SN,Category,nAttr1) VALUES(300,1,99),(301,13,10);
    INSERT INTO FxStock(SN,Category,ItemSN,Unit,Price,MoneyType,IsValid) VALUES
    (5000,1,300,2,100,0,1),(5001,13,301,3,80,0,1),(5100,11,0,1,150,0,1);
    INSERT INTO FxPackageMap(PackageSN,StockSN,Units) VALUES(5100,5000,2),(5100,5001,1);`);
});
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  db.Close(); rmSync(dir, { recursive: true, force: true });
});
function fund(amount = 1000) { store.authorize("alice", "testpw", "alice", 0); store.credit("alice", amount, "seed"); }
function owned(item = 300): number {
  return (db.inventory[GetUserHashNo("alice")].query("SELECT Amount FROM FxUserInventory WHERE UserID='alice' AND ItemSN=?").get(item) as { Amount: number } | null)?.Amount ?? 0;
}
function finish(reference: string, result = 0, stock = 5000) { return store.confirm(reference, 0, 123, stock, result); }

test("authentication is real, zero-initialized, character-bound, and does not auto-create arbitrary billing accounts", () => {
  expect(() => store.authorize("alice", "wrong", "alice", 0)).toThrow();
  expect(() => store.authorize("alice", "testpw", "bob", 0)).toThrow();
  expect(() => store.authorize("unknown", "testpw", "unknown", 0)).toThrow();
  expect(store.authorize("alice", "testpw", "alice", 0).Balance).toBe(0);
  expect(store.balance("alice", 0)).toBe(0);
  expect(() => store.balance("alice", 1)).toThrow();
  expect(() => store.balance("bob", 0)).toThrow();
  expect((db.prGetUserDynamic("alice") as { Money: number }).Money).toBe(999);
});
test("credits are persistent, idempotent, audited, amount-bound, and cannot overflow", () => {
  expect(store.credit("alice", 500, "admin-1")).toBe(500);
  expect(store.credit("alice", 500, "admin-1")).toBe(500);
  expect(() => store.credit("alice", 501, "admin-1")).toThrow();
  for (const invalid of [0, -1, 0.5, Infinity, NaN, MAX_CASH]) expect(() => store.credit("alice", invalid, "bad")).toThrow();
  const reopened = new CDBMan(dir); cleanup.push(() => reopened.Close());
  const copy = new BillingStore(reopened);
  expect(copy.inspect("alice").balance).toBe(500);
  expect(copy.inspect("alice").ledger).toHaveLength(1);
});
test("request does not debit or grant; confirmation commits money, inventory, ledger, and terminal result once", () => {
  fund();
  const hold = store.reserve(request);
  expect(hold.Reference).toMatch(/^[a-f0-9]{32}$/);
  expect(store.inspect("alice")).toMatchObject({ balance: 1000, available: 900 });
  expect(owned()).toBe(0);
  expect(store.reserve(request).Reference).toBe(hold.Reference);
  expect(finish(hold.Reference).State).toBe("committed");
  expect(owned()).toBe(2); expect(store.balance("alice", 0)).toBe(900);
  for (let i = 0; i < 3; i++) expect(finish(hold.Reference).State).toBe("committed");
  expect(finish(hold.Reference, 2).State).toBe("committed");
  expect(owned()).toBe(2); expect(store.inspect("alice").ledger).toHaveLength(2);
});
test("package confirmation grants every component exactly once in the same shard transaction", () => {
  fund();
  const hold = store.reserve({ ...request, stock: 5100, price: 150 });
  finish(hold.Reference, 0, 5100);
  expect([owned(300), owned(301), store.balance("alice", 0)]).toEqual([4, 3, 850]);
});
test("injected second-item failure rolls back the debit and FIRST item as well", () => {
  fund();
  const hold = store.reserve({ ...request, stock: 5100, price: 150 });
  db.inventory[GetUserHashNo("alice")].exec(`CREATE TRIGGER fail_delivery BEFORE INSERT ON FxUserInventory
    WHEN NEW.ItemSN=301 BEGIN SELECT RAISE(ABORT,'test fault'); END;`);
  expect(finish(hold.Reference, 0, 5100).State).toBe("cancelled");
  expect([owned(300), owned(301), store.balance("alice", 0)]).toEqual([0, 0, 1000]);
  expect(store.inspect("alice").ledger).toHaveLength(1);
  expect(finish(hold.Reference, 0, 5100).State).toBe("cancelled");
});
test("ledger failure also rolls back inventory and money", () => {
  fund(); const hold = store.reserve(request);
  db.inventory[GetUserHashNo("alice")].exec(`CREATE TRIGGER fail_ledger BEFORE INSERT ON LocalBillingLedger
    WHEN NEW.Kind='purchase' BEGIN SELECT RAISE(ABORT,'test fault'); END;`);
  expect(finish(hold.Reference).State).toBe("cancelled");
  expect([owned(), store.balance("alice", 0)]).toEqual([0, 1000]);
});
for (const result of [1, 2]) test(`cancel ${result} releases a hold and cannot later be turned into success`, () => {
  fund(); const hold = store.reserve(request);
  expect(finish(hold.Reference, result).State).toBe("cancelled");
  expect(finish(hold.Reference).State).toBe("cancelled");
  expect([owned(), store.balance("alice", 0)]).toEqual([0, 1000]);
});
test("expired reservation and authorization fail closed, without charging", () => {
  fund(); const hold = store.reserve(request);
  clock += RESERVATION_MS;
  expect(finish(hold.Reference).State).toBe("cancelled");
  expect(store.balance("alice", 0)).toBe(1000);
  clock += AUTHORIZATION_MS;
  expect(() => store.reserve(request)).toThrow();
  expect(() => store.balance("alice", 0)).toThrow();
});
test("confirmation cannot be reassigned to another serial, stock, world, or guessed reference", () => {
  fund(); const hold = store.reserve(request);
  expect(() => store.confirm(hold.Reference, 1, 123, 5000, 0)).toThrow();
  expect(() => store.confirm(hold.Reference, 0, 124, 5000, 0)).toThrow();
  expect(() => finish(hold.Reference, 0, 5001)).toThrow();
  expect(() => finish("0".repeat(32))).toThrow();
  expect(finish(hold.Reference).State).toBe("committed");
});
test("second connection/store cannot overspend or bypass another in-flight purchase", () => {
  fund(150);
  const otherDB = new CDBMan(dir); cleanup.push(() => otherDB.Close());
  const other = new BillingStore(otherDB, () => clock);
  const hold = store.reserve(request);
  expect(other.reserve(request).Reference).toBe(hold.Reference);
  expect(() => other.reserve({ ...request, serial: 124 })).toThrow();
  expect(other.confirm(hold.Reference, 0, 123, 5000, 0).State).toBe("committed");
  expect(() => store.reserve(request)).toThrow();
  expect(owned()).toBe(2); expect(store.balance("alice", 0)).toBe(50);
});
test("process-style reopen resumes both a held and a terminal confirmation, not a fresh charge", () => {
  fund(); const hold = store.reserve(request);
  db.Close(); db = new CDBMan(dir); store = new BillingStore(db, () => clock);
  expect(finish(hold.Reference).State).toBe("committed");
  db.Close(); db = new CDBMan(dir); store = new BillingStore(db, () => clock);
  expect(finish(hold.Reference).State).toBe("committed");
  expect([owned(), store.balance("alice", 0)]).toEqual([2, 900]);
});
test("prices, quantities, catalog validity, timed/premium products are never trusted from the Shop packet", () => {
  fund();
  for (const price of [-1, 0, 99, 101, NaN, MAX_CASH + 1]) expect(() => store.reserve({ ...request, price })).toThrow();
  expect(() => store.reserve({ ...request, stock: 9999 })).toThrow();
  for (const change of ["MoneyType=1", "IsValid=0", "Category=9", "ValidityPeriod=30", "LimitEx=1", "Unit=0"]) {
    db.item.exec(`UPDATE FxStock SET ${change} WHERE SN=5000`);
    expect(() => store.reserve(request)).toThrow();
    db.item.exec("UPDATE FxStock SET MoneyType=0,IsValid=1,Category=1,ValidityPeriod=0,LimitEx=0,Unit=2 WHERE SN=5000");
  }
  db.item.exec("UPDATE FxItem SET Category=9 WHERE SN=300");
  expect(() => store.reserve(request)).toThrow();
  db.item.exec("UPDATE FxItem SET Category=1 WHERE SN=300");
  db.item.exec("UPDATE FxStock SET LimitLevel=100 WHERE SN=5001");
  expect(() => store.reserve({ ...request, stock: 5100, price: 150 })).toThrow();
  expect([owned(), store.balance("alice", 0)]).toEqual([0, 1000]);
});
test("inventory capacity is checked again at commit, with no partial debit", () => {
  fund(); const hold = store.reserve({ ...request, stock: 5001, price: 80 });
  db.inventory[GetUserHashNo("alice")].exec("INSERT INTO FxUserInventory(UserID,ItemSN,Amount) VALUES('alice',301,9)");
  expect(finish(hold.Reference, 0, 5001).State).toBe("cancelled");
  expect([owned(301), store.balance("alice", 0)]).toEqual([9, 1000]);
});
test("local endpoint registration is idempotent and cannot take over external billing", () => {
  const config = { enabled: true, host: "127.0.0.1" as const, port: 19740 };
  expect(canUseLocalBilling(db, config)).toBe(true);
  registerLocalBilling(db, config); registerLocalBilling(db, config);
  expect(usesLocalBilling(db)).toBe(true); expect(db.GetBillingSvrs()).toHaveLength(1);
  db.config.exec("UPDATE BillingSvr SET port=19741");
  expect(usesLocalBilling(db)).toBe(false); expect(canUseLocalBilling(db, config)).toBe(false);
  expect(() => registerLocalBilling(db, config)).toThrow();
  expect(db.GetBillingSvrs()[0].port).toBe(19741);
});

function decode(p: CSendPacket) {
  const n = new CReceivedPacket(); n.SetCipherDegree(p.m_nCipherDegree);
  n.SetRcvPacket(p.m_pBlock.subarray(0, p.m_uOffset), p.m_uOffset); return n;
}
function shopFixture() {
  const saved = [CMainPool.ms_pInstance, CLocalUserTable.ms_pInstance, CCenterProcess.ms_pInstance, CBillingProcess.ms_pInstance] as const;
  const table = new CLocalUserTable(), pool = new CMainPool(db), billing = new CBillingProcess(db), center = new CCenterProcess(db);
  pool.billingProcess = billing;
  const socket = new CClientSocket(); socket.AddNewUsers(1);
  const user = socket.GetUser(0)!; user.SetName("alice"); user.SetGlobalSerialNo(123); table.Insert(user);
  const sent: CSendPacket[] = [], forwarded: CSendPacket[] = [];
  const send = spyOn(socket, "SendPacket").mockImplementation(p => { sent.push(p); return enSocket.kioOk; });
  const billingSend = spyOn(billing, "Send").mockImplementation(p => { forwarded.push(p); });
  cleanup.push(() => {
    send.mockRestore(); billingSend.mockRestore(); CClientSocket.ms_tblSN2Obj.delete(socket.m_nLocalSerialNo);
    [CMainPool.ms_pInstance, CLocalUserTable.ms_pInstance, CCenterProcess.ms_pInstance, CBillingProcess.ms_pInstance] = saved;
  });
  return { table, pool, billing, center, socket, user, sent, forwarded };
}
test("packet 7 uses three DISTINCT DWORDs: serial/SID/BID, never cash; Center sees the SID", () => {
  const f = shopFixture(); f.table.Remove(f.user);
  const forwarded: CSendPacket[] = [];
  const send = spyOn(f.center, "SendPacket").mockImplementation(p => { forwarded.push(p); }); cleanup.push(() => send.mockRestore());
  const p = new CSendPacket(7, 2); p.Encode1(1); p.EncodeStr("alice");
  p.Encode4(123); p.Encode4(0x11223344); p.Encode4(0x55667788); p.Encode1(0);
  f.pool.OnPacket(decode(p), f.socket);
  const user = f.socket.GetUser(0)!;
  expect([user.m_nGlobalSerialNo, user.m_nSID, user.m_nBID, user.m_nBillingCash])
    .toEqual([123, 0x11223344, 0x55667788, 0]);
  expect(forwarded).toHaveLength(1);
  const n = decode(forwarded[0]);
  expect([n.Decode1(), n.Decode1(), n.DecodeStr(), n.Decode4(), n.Decode4()])
    .toEqual([3, 1, "alice", 123, 0x11223344]);
});

test("recreated character identity cannot inherit old authorization or debit the old wallet", () => {
  fund(); const hold = store.reserve(request);
  db.userInfo[GetUserHashNo("alice")].exec("UPDATE FxUserAccount SET SN=99 WHERE ID='alice'");
  expect(() => store.reserve(request)).toThrow();
  expect(() => store.authorize("alice", "testpw", "alice", 0)).toThrow();
  expect(finish(hold.Reference).State).toBe("cancelled");
  expect(owned()).toBe(0); expect(store.inspect("alice").balance).toBe(1000);
});
test("Shop 311 uses serial not BID; duplicate 312/322 produce no second client success or grant", () => {
  const f = shopFixture(); f.billing.m_fLocalBilling = true; f.billing.m_fConnected = 1;
  f.user.m_nSID = 111; f.user.m_nBID = 222;
  const item = new ShopItem(); item.SN = 5000; item.Price = 100;
  f.billing.RequestPurchaseTw(f.user, item);
  const n = new BillingReader(f.forwarded[0].m_pBlock.subarray(0, f.forwarded[0].m_uOffset));
  expect([n.u32(), n.u32(), n.u32(), n.u32(), n.u32(), n.string(), n.u32(), n.u32(), n.u32(), n.u32(), n.u32(), n.string()])
    .toEqual([311, 111, 222, 4, 0, "alice", 100, 1, 123, 5000, 1, ""]);
  n.end();
  const reference = "a".repeat(32);
  for (let i = 0; i < 2; i++) f.billing.OnPacket(decode(purchaseReply(312, reference, 123, "", 5000)));
  expect(f.sent).toHaveLength(0);
  expect(f.forwarded.slice(1).map(p => p.m_nPacketType)).toEqual([321, 321]);
  expect(f.forwarded[1].m_pBlock.subarray(0, f.forwarded[1].m_uOffset))
    .toEqual(f.forwarded[2].m_pBlock.subarray(0, f.forwarded[2].m_uOffset));
  for (let i = 0; i < 2; i++) f.billing.OnPacket(decode(purchaseReply(322, reference, 123)));
  expect(f.sent).toHaveLength(1);
  const answer = decode(f.sent[0]); expect([answer.Decode1(), answer.Decode1()]).toEqual([204, 0]);
  expect(f.sent[0].m_uOffset).toBe(10); // opcode, result, variant time
  expect(f.user.m_pPurchaseTranx).toBeNull();
});
test("lost confirmation retries 321 with exactly the same reference, not a fresh 311", () => {
  const f = shopFixture(); f.billing.m_fLocalBilling = true; f.billing.m_fConnected = 1;
  const item = new ShopItem(); item.SN = 5000; item.Price = 100;
  f.billing.RequestPurchaseTw(f.user, item);
  f.billing.OnPacket(decode(purchaseReply(312, "b".repeat(32), 123, "", 5000)));
  const now = Date.now(); const time = spyOn(Date, "now").mockReturnValue(now + 3000); cleanup.push(() => time.mockRestore());
  f.billing.RetryLocalPurchases();
  expect(f.forwarded.map(p => p.m_nPacketType)).toEqual([311, 321, 321]);
  expect(f.forwarded[1].m_pBlock.subarray(0, f.forwarded[1].m_uOffset))
    .toEqual(f.forwarded[2].m_pBlock.subarray(0, f.forwarded[2].m_uOffset));
});
test("lost 312 retries only its existing request, expires without debit, and rejects overlapping purchases", () => {
  const f = shopFixture(); f.billing.m_fLocalBilling = true; f.billing.m_fConnected = 1;
  const item = new ShopItem(); item.SN = 5000; item.Price = 100;
  f.billing.RequestPurchaseTw(f.user, item); f.billing.RequestPurchaseTw(f.user, item);
  expect(f.forwarded).toHaveLength(1); expect(f.sent).toHaveLength(1);
  const now = Date.now(); const time = spyOn(Date, "now").mockReturnValue(now + 3000); cleanup.push(() => time.mockRestore());
  f.billing.RetryLocalPurchases(); expect(f.forwarded.map(p => p.m_nPacketType)).toEqual([311, 311]);
  time.mockReturnValue(now + RESERVATION_MS + 1); f.billing.RetryLocalPurchases();
  expect(f.user.m_pPurchaseTranx).toBeNull(); expect(f.sent).toHaveLength(2);
});
test("disconnected or absent user cancels a 312, and a stale reference cannot complete another purchase", () => {
  const f = shopFixture(); f.billing.m_fLocalBilling = true; f.billing.m_fConnected = 1;
  const item = new ShopItem(); item.SN = 5000; item.Price = 100;
  f.billing.RequestPurchaseTw(f.user, item); f.user.m_pSocket = null;
  f.billing.OnPacket(decode(purchaseReply(312, "c".repeat(32), 123, "", 5000)));
  const confirm = new BillingReader(f.forwarded[1].m_pBlock.subarray(0, f.forwarded[1].m_uOffset));
  expect([confirm.u32(), confirm.string(), confirm.u32(), confirm.u32(), confirm.u32()])
    .toEqual([321, "c".repeat(32), 123, 5000, 2]);
  f.billing.OnPacket(decode(purchaseReply(322, "d".repeat(32), 123)));
  expect(f.user.m_pPurchaseTranx).not.toBeNull(); expect(f.sent).toHaveLength(0);
});
test("packet logs keep names/IDs but redact DigiQ credentials on both links", () => {
  const previous = process.env.CA_PACKET_LOG, output = PacketLog.out;
  process.env.CA_PACKET_LOG = "1";
  const lines: string[] = []; PacketLog.out = line => { lines.push(line); };
  cleanup.push(() => { PacketLog.out = output; if (previous === undefined) delete process.env.CA_PACKET_LOG; else process.env.CA_PACKET_LOG = previous; });
  const secret = Buffer.from("test-password");
  PacketLog.Packet("client", "Shop", "recv", 224, 2, secret);
  PacketLog.Packet("billing", "Shop", "send", 341, 0, secret, "BILL");
  PacketLog.Packet("shop", "Billing", "recv", 341, 0, secret, "LOCALBILL");
  expect(lines).toHaveLength(3);
  for (const line of lines) { expect(line).toContain("credentials redacted"); expect(line).not.toContain("74 65 73 74"); }
});

/** Independent test-side raw framing, not the production Tw decoder. */
async function connectBilling(server: { port: number }) {
  let buffered = Buffer.alloc(0);
  const queue: Buffer[] = [];
  const waiters: { id: number; resolve: (p: Buffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  const connection = await Bun.connect({ hostname: "127.0.0.1", port: server.port, socket: {
    data(_s, chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 8) {
        const size = buffered.readUInt32BE(); if (buffered.length < size + 8) break;
        const body = Buffer.from(buffered.subarray(8, size + 8)); buffered = buffered.subarray(size + 8);
        const at = waiters.findIndex(w => w.id === body.readUInt32BE());
        if (at < 0) queue.push(body);
        else { const w = waiters.splice(at, 1)[0]; clearTimeout(w.timer); w.resolve(body); }
      }
    },
    close() { for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error("closed")); } },
  }});
  cleanup.push(() => connection.terminate());
  return {
    connection,
    send(p: CSendPacket, split = false) {
      const bytes = Buffer.alloc(8 + p.m_uOffset); bytes.writeUInt32BE(p.m_uOffset); bytes.writeUInt32BE(7, 4);
      bytes.set(p.m_pBlock.subarray(0, p.m_uOffset), 8);
      if (split) { connection.write(bytes.subarray(0, 5)); connection.write(bytes.subarray(5)); }
      else connection.write(bytes);
    },
    recv(id: number): Promise<Buffer> {
      const at = queue.findIndex(p => p.readUInt32BE() === id);
      if (at >= 0) return Promise.resolve(queue.splice(at, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { const i = waiters.findIndex(w => w.timer === timer); if (i >= 0) waiters.splice(i, 1); reject(new Error(`billing ${id} timeout`)); }, 1500);
        waiters.push({ id, resolve, reject, timer });
      });
    },
  };
}
function hello() { const p = new BillingPacket(331); p.Encode4(4); p.Encode4(0); return p; }
function authRequest(password = "testpw") {
  const p = new BillingPacket(341); string8(p, "alice"); string8(p, password); string8(p, "alice"); return p;
}
function buyRequest() {
  const p = new BillingPacket(311);
  for (const n of [0xffffffff, 0xffffffff, 4, 0]) p.Encode4(n);
  string8(p, "alice"); for (const n of [100, 1, 123, 5000, 1]) p.Encode4(n);
  string8(p, "127.0.0.1"); return p;
}
function confirmRequest(reference: string) {
  const p = new BillingPacket(321); string8(p, reference); p.Encode4(123); p.Encode4(5000); p.Encode4(0); return p;
}
function network() { const server = new BillingServer(store); server.listen(); cleanup.push(() => server.close()); return server; }

test("real TCP server implements hello, failed/successful auth, balance, purchase, confirm, RTT and replay", async () => {
  const server = network(); const peer = await connectBilling(server);
  peer.send(hello(), true); peer.send(authRequest("wrong"));
  const denied = new BillingReader(await peer.recv(342));
  expect([denied.u32(), denied.u32(), denied.u32(), denied.string(), denied.u32()]).toEqual([342, 0, 0, "alice", 1]);
  expect(denied.string()).toContain("authorize"); denied.end();
  peer.send(authRequest()); const auth = new BillingReader(await peer.recv(342));
  expect(auth.u32()).toBe(342); expect(auth.u32()).toBe(11); expect(auth.u32()).toBeGreaterThan(0);
  expect([auth.string(), auth.u32()]).toEqual(["alice", 0]); auth.end();
  store.credit("alice", 500, "tcp-credit");
  const balance = new BillingPacket(301);
  for (const n of [0xffffffff, 0xffffffff, 4, 0]) balance.Encode4(n);
  string8(balance, "alice"); balance.Encode4(123); string8(balance, "127.0.0.1");
  peer.send(balance); const cash = new BillingReader(await peer.recv(302));
  expect([cash.u32(), cash.u32(), cash.string(), cash.u32(), cash.u32(), cash.u32()])
    .toEqual([302, 0xffffffff, "alice", 123, 500, 0]); cash.end();
  peer.send(buyRequest()); const approved = new BillingReader(await peer.recv(312));
  expect([approved.u32(), approved.u32(), approved.u32(), approved.u32()]).toEqual([312, 0, 0, 0]);
  const reference = approved.string(); expect(reference).toHaveLength(32);
  expect([approved.u32(), approved.u32(), approved.u32()]).toEqual([123, 5000, 0]); approved.end();
  peer.send(confirmRequest(reference)); const confirmed = await peer.recv(322);
  const receipt = new BillingReader(confirmed);
  expect([receipt.u32(), receipt.string(), receipt.u32(), receipt.u32()]).toEqual([322, reference, 123, 0]); receipt.end();
  peer.send(confirmRequest(reference)); expect(await peer.recv(322)).toEqual(confirmed);
  expect([owned(), store.balance("alice", 0)]).toEqual([2, 400]);
  const rtt = new BillingPacket(351); rtt.Encode1(123); peer.send(rtt);
  expect((await peer.recv(352)).toString("hex")).toBe("000001607b");
});
test("real TCP reconnect replays a committed reference, without a second debit", async () => {
  fund(); const hold = store.reserve(request);
  const server = network(); const firstPeer = await connectBilling(server);
  const original = CBillingSocketTw.prototype.SendPacket;
  const dropped = spyOn(CBillingSocketTw.prototype, "SendPacket").mockImplementation(function (this: CBillingSocketTw, packet) {
    if (packet.m_nPacketType === 322) { this.Close(); return enSocket.kioOk; }
    return original.call(this, packet);
  });
  cleanup.push(() => dropped.mockRestore());
  const closed = firstPeer.recv(322);
  firstPeer.send(hello()); firstPeer.send(confirmRequest(hold.Reference));
  await expect(closed).rejects.toThrow("closed");
  expect([owned(), store.balance("alice", 0)]).toEqual([2, 900]); // commit survived the lost response
  dropped.mockRestore();
  const peer = await connectBilling(server);
  peer.send(hello()); peer.send(confirmRequest(hold.Reference));
  const answer = new BillingReader(await peer.recv(322));
  expect([answer.u32(), answer.string(), answer.u32(), answer.u32()]).toEqual([322, hold.Reference, 123, 0]);
  expect([owned(), store.balance("alice", 0)]).toEqual([2, 900]);
});
test("unauthorized native purchase gets a refusal, never free items or funds", async () => {
  const peer = await connectBilling(network()); peer.send(hello()); peer.send(buyRequest());
  const n = new BillingReader(await peer.recv(312));
  n.u32(); n.u32(); n.u32(); n.u32(); n.string(); n.u32(); n.u32();
  expect(n.u32()).toBe(1); expect(n.string().length).toBeGreaterThan(0);
  expect(owned()).toBe(0);
});
for (const mode of ["no-hello", "truncated", "tail", "wrong-game", "unknown", "oversize"]) {
  test(`malformed TCP ${mode} closes only that peer, and another peer still works`, async () => {
    const server = network(); const peer = await connectBilling(server);
    const closed = peer.recv(342).catch((error: Error) => error.message);
    if (mode !== "no-hello") peer.send(hello());
    if (mode === "no-hello") peer.send(authRequest());
    if (mode === "truncated") { const p = new BillingPacket(341); p.Encode1(10); p.Encode1(1); peer.send(p); }
    if (mode === "tail") { const p = authRequest(); p.Encode1(0); peer.send(p); }
    if (mode === "wrong-game") peer.send(hello()); // second hello forbidden
    if (mode === "unknown") peer.send(new BillingPacket(999));
    if (mode === "oversize") peer.connection.write(Buffer.from("0000200000000007", "hex"));
    expect(await closed).toBe("closed");
    const healthy = await connectBilling(server); healthy.send(hello()); healthy.send(authRequest());
    expect((await healthy.recv(342)).readUInt32BE()).toBe(342);
  });
}

test("operator CLI credits once across processes and reports actual persisted balance", async () => {
  for (let i = 0; i < 2; i++) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../tools/billing.ts"), "credit", "--db", dir,
      "--account", "alice", "--amount", "250", "--reference", "cli-credit"], { stdout: "pipe", stderr: "pipe" });
    const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(errors).toBe(""); expect(exit).toBe(0);
    expect(JSON.parse(output).balance).toBe(250);
  }
  expect(store.inspect("alice").balance).toBe(250); expect(store.inspect("alice").ledger).toHaveLength(1);
});
test("unsupported local gift/coupon/cart paths reject before any billing or currency mutation", () => {
  const f = shopFixture(); f.billing.m_fLocalBilling = true;
  for (const id of [218, 219, 223]) {
    const p = new CSendPacket(id, 2);
    if (id === 218) { p.Encode2(5000); p.EncodeStr("bob"); }
    if (id === 219) { p.EncodeStr("test-coupon"); p.EncodeStr("alice"); }
    if (id === 223) { p.Encode1(1); p.Encode2(5000); p.Encode1(1); }
    f.pool.OnPacket(decode(p), f.socket);
  }
  expect(f.forwarded).toHaveLength(0); expect(f.sent).toHaveLength(3);
  expect(f.sent.map(p => { const n = decode(p); return [n.Decode1(), n.Decode1()]; })).toEqual([[204, 1], [208, 7], [204, 1]]);
  expect(owned()).toBe(0);
});
test("per-account failed-auth budget does not lock out ten successful users or allow unlimited failures", async () => {
  const peer = await connectBilling(network()); peer.send(hello());
  for (let i = 0; i < 12; i++) {
    peer.send(authRequest()); const n = new BillingReader(await peer.recv(342));
    n.u32(); n.u32(); n.u32(); n.string(); expect(n.u32()).toBe(0);
  }
  for (let i = 0; i < 10; i++) { peer.send(authRequest("wrong")); await peer.recv(342); }
  peer.send(authRequest()); const denied = new BillingReader(await peer.recv(342));
  denied.u32(); denied.u32(); denied.u32(); denied.string(); expect(denied.u32()).toBe(1);
});
test("service refuses non-loopback binding rather than exposing unauthenticated Tw infrastructure", () => {
  const server = new BillingServer(store);
  expect(() => server.listen("0.0.0.0", 0)).toThrow("loopback");
});

test("two real processes race a 150-point wallet: exactly one 100-point purchase can commit", async () => {
  fund(150);
  const workers = [123, 124].map(serial => {
    const ready = Promise.withResolvers<void>();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/local-billing-worker.ts"), dir, String(serial)], {
      stdout: "pipe", stderr: "pipe", ipc: message => { if (message === "ready") ready.resolve(); },
    });
    const timer = setTimeout(() => ready.reject(new Error("worker startup timeout")), 3000);
    void child.exited.then(code => { if (code !== null) ready.reject(new Error(`worker exited ${code}`)); });
    return { child, ready, timer };
  });
  try {
    await Promise.all(workers.map(w => w.ready.promise));
    for (const w of workers) w.child.send("settle");
    const results = await Promise.all(workers.map(async w => {
      const [code, output, errors] = await Promise.all([w.child.exited, new Response(w.child.stdout).text(), new Response(w.child.stderr).text()]);
      expect(code).toBe(0); expect(errors).toBe(""); return JSON.parse(output) as { state: string };
    }));
    expect(results.map(r => r.state).sort()).toEqual(["committed", "refused"]);
    expect([owned(), store.balance("alice", 0)]).toEqual([2, 50]);
  } finally {
    for (const w of workers) { clearTimeout(w.timer); w.child.kill(); }
    await Promise.all(workers.map(w => w.child.exited));
  }
});
test("main --only billing starts the real service and registers only its own endpoint", async () => {
  const temporary = network(), port = temporary.port; temporary.close();
  const config = join(dir, "billing.json"); writeFileSync(config, JSON.stringify({ enabled: true, host: "127.0.0.1", port }));
  const ready = Promise.withResolvers<void>();
  const child = Bun.spawn([process.execPath, "--eval", "await import('./src/main.ts'); process.send?.('ready');",
    "--", "--only", "billing", "--db", dir, "--billing-config", config], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    ipc: message => { if (message === "ready") ready.resolve(); },
  });
  const timer = setTimeout(() => ready.reject(new Error("main startup timeout")), 3000);
  void child.exited.then(code => ready.reject(new Error(`main exited ${code}`)));
  try {
    await ready.promise;
    expect(usesLocalBilling(db)).toBe(true);
    expect(db.GetBillingSvrs()).toEqual([{ SN: 0, ip: "127.0.0.1", port }]);
    const peer = await connectBilling({ port });
    peer.send(hello()); peer.send(authRequest());
    const n = new BillingReader(await peer.recv(342));
    n.u32(); n.u32(); n.u32(); n.string(); expect(n.u32()).toBe(0);
  } finally {
    clearTimeout(timer); child.kill(); await child.exited;
    const error = await new Response(child.stderr).text(); expect(error).toBe("");
  }
});
test("bind failure cannot leave a fake BillingSvr configuration", async () => {
  const occupied = network();
  const config = join(dir, "billing.json"); writeFileSync(config, JSON.stringify({ enabled: true, host: "127.0.0.1", port: occupied.port }));
  const child = Bun.spawn([process.execPath, "src/main.ts", "--only", "billing", "--db", dir, "--billing-config", config], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).not.toBe(0); expect(error).toContain("EADDRINUSE");
  expect(db.GetBillingSvrs()).toHaveLength(0); expect(usesLocalBilling(db)).toBe(false);
});

test("every truncated 312/322 body is ignored; busy owner is not sent a late purchase reply", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {}); cleanup.push(() => warn.mockRestore());
  const f = shopFixture(); f.billing.m_fLocalBilling = true; f.billing.m_fConnected = 1;
  const item = new ShopItem(); item.SN = 5000; item.Price = 100;
  f.billing.RequestPurchaseTw(f.user, item);
  const reference = "e".repeat(32);
  for (const id of [312, 322] as const) {
    const full = purchaseReply(id, reference, 123, "", 5000);
    for (let size = 4; size < full.m_uOffset; size++) {
      const short = decode(full); short.m_uLength = size;
      f.billing.OnPacket(short);
      expect(f.sent).toHaveLength(0); expect(f.user.m_pPurchaseTranx).not.toBeNull();
    }
    f.user.m_fTranxInProgress = id === 322 ? 1 : 0;
    f.billing.OnPacket(decode(full));
  }
  expect(f.sent).toHaveLength(0); expect(f.user.m_pPurchaseTranx).toBeNull();
  expect(f.forwarded.map(p => p.m_nPacketType)).toEqual([311, 321]);
});

test("permanent expiry matches native defaults; stacking preserves valid metadata and refuses expired/timed stacks", () => {
  fund(); const hold = store.reserve(request); finish(hold.Reference);
  const shard = db.inventory[GetUserHashNo("alice")];
  const first = db.GetUserInventoryRows("alice")[0];
  expect(first.LevelCreated).toBe(2000);
  expect(Date.parse(first.DateCreated!) - clock).toBe(100000 * 86400000); // independent native constants
  const next = store.reserve(request); finish(next.Reference);
  expect(owned()).toBe(4);
  expect(db.GetUserInventoryRows("alice")[0].DateCreated).toBe(first.DateCreated);
  shard.exec("UPDATE FxUserInventory SET DateCreated='2000-01-01T00:00:00Z' WHERE UserID='alice'");
  expect(() => store.reserve(request)).toThrow();
  shard.query("UPDATE FxUserInventory SET DateCreated=? WHERE UserID='alice'").run(first.DateCreated);
  db.item.exec("UPDATE FxStock SET ValidityPeriod=1 WHERE SN=5000");
  db.item.exec("INSERT INTO FxStock(SN,Category,ItemSN,Unit,Price,MoneyType,IsValid) VALUES(5002,1,300,1,100,0,1)");
  expect(() => store.reserve({ ...request, stock: 5002 })).toThrow();
  expect(store.balance("alice", 0)).toBe(800);
});

test("inventory row capacity is checked for whole packages, and again after reservation", () => {
  fund(); const shard = db.inventory[GetUserHashNo("alice")];
  shard.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<399)
    INSERT INTO FxUserInventory(UserID,ItemSN,Amount) SELECT 'alice',10000+x,1 FROM n`);
  expect(() => store.reserve({ ...request, stock: 5100, price: 150 })).toThrow(); // needs two new rows
  const hold = store.reserve(request); // one free row, still no debit
  shard.exec("INSERT INTO FxUserInventory(UserID,ItemSN,Amount) VALUES('alice',20000,1)");
  expect(finish(hold.Reference).State).toBe("cancelled");
  expect([owned(), store.balance("alice", 0)]).toEqual([0, 1000]);
});
