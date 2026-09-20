/**
 * End-to-end exercise of the item shop (FXSS): center ↔ shop attach (CM 6
 * OnShopServerInfo), client 7 → MC 3 → CM 2 → client 18, the cached CItemMan
 * table packets (200/205/213/202), the purchase path (206 → 204, the DB
 * writes) and the misc handlers (214/226/20) — against the real code paths.
 */
import { GetTickCount } from "../src/core/GetTickCount.ts";
import { describe, test, expect, beforeAll, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { CServerConfig, CXCENTER_STR_KEYS, FXSHOP_STR_KEYS } from "../src/core/Config.ts";
import { CDBMan } from "../src/db/DBMan.ts";
import { CxCenter, CUser } from "../src/Center/Center.ts";
import { CxShop, CLocalUserTable, CUser as ShopUser, UserInventory as ShopUserInventory } from "../src/FXSS/Shop.ts";
import { CReceivedPacket, CSendPacket } from "../src/core/Packet.ts";
import { CItemMan } from "../src/FXSS/CItemMan.ts";
import { SVRCLASS_SHOP } from "../src/lib/S2S.ts";
import { GetUserHashNo } from "../src/db/DBMan.ts";
import { CISmartStream } from "../src/core/SmartStream.ts";
import { TestClient, r1, r2, r4, rstr, gsEncode, gsDecode, type CReceived } from "./TestClient.ts";

const DIR = import.meta.dir;
const DB_DIR = DIR + "/tmp-db-shop";
const SHOP_PORT = 19801;

let center: CxCenter;
let shop: CxShop;

beforeAll(async () => {
  rmSync(DB_DIR, { recursive: true, force: true });
  mkdirSync(DB_DIR, { recursive: true });

  // ---- seed the DB files the shop will open (CAItem / CAConfig / UserInfo) ----
  new CDBMan(DB_DIR); // create the schema files
  const db = new Database(DB_DIR + "/CAItem.db");
  db.run(`INSERT INTO FxItem (SN, Category, strAttr, nAttr1, nAttr2, nAttr3, strName, nLevel)
          VALUES (300, 13, 'attr', 10, 0, 0, 'item300', 0)`);
  db.run(`INSERT INTO FxStock (SN, Category, Name, ItemSN, Unit, DataFile, Price, FixedPrice,
             LimitLevel, LimitEx, ValidityPeriod, ValidityLevel, StringDesc, StringUsage,
             CardNo, MoneyType, zorder, IsValid)
          VALUES (5000, 13, 'stock5000', 300, 1, '', 100, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1)`);
  db.run("INSERT INTO FxString (SN, String) VALUES (1, 'HelloWorld')");
  db.close();
  const cfg = new Database(DB_DIR + "/CAConfig.db");
  cfg.run("INSERT INTO BillingConfig (AttrID, strVal) VALUES ('ChargeUrl', 'http://charge/url')");
  cfg.run("INSERT INTO BillingConfig (AttrID, strVal) VALUES ('AuthUrl', 'http://auth/url')");
  cfg.close();
  const user = new Database(`${DB_DIR}/UserInfo${String(GetUserHashNo("tester")).padStart(2, "0")}.db`);
  user.run(
    `INSERT INTO FxUserAccount (ID, SN, Name, Password, Permission, ShopCardNo)
     VALUES ('tester', 7, 'tester', 'pw', 0, 1)`,
  );
  user.run("INSERT INTO FxUserDynamic (ID, Money, Exp) VALUES ('tester', 1000, 50)");
  user.close();

  // ---- boot the center + the shop ----
  const ccfg = new CServerConfig(CXCENTER_STR_KEYS, true);
  ccfg.Init(DIR + "/shop-center.cfg");
  CServerConfig.ms_pInstance = ccfg;
  center = new CxCenter(ccfg);
  center.Init();
  await center.Listen();

  const scfg = new CServerConfig(FXSHOP_STR_KEYS);
  scfg.Init(DIR + "/shop0.cfg");
  CServerConfig.ms_pInstance = scfg;
  shop = new CxShop(scfg, DB_DIR);
  await shop.Init(); // Bun.listen inside Init is synchronous — both ports are live

  // the shop's center-link greet is processed asynchronously, and the center
  // wipes the (re-)registered server's users on it (DeleteAllUserOnSvr) —
  // inject the test user only after the shop link finished registering
  for (let i = 0; i < 200 && !center.GetSvr(SVRCLASS_SHOP, 0)?.socket; i++) await Bun.sleep(5);

  // the login flow would have registered "tester" on the center with a
  // pending shop connection; inject it directly (the LS's ReqConnectToSvr
  // would have left the user in the "connecting to shop idx 0" state)
  const cu = new CUser("tester", SVRCLASS_SHOP, 0, 7, 0, 0, center);
  center.userTable.set("tester", cu);
  center.serialTable.set(7, cu);
  cu.m_fConnecting = 1; // fixture: the successful check already ran
  cu.SetConnectingToSvr(SVRCLASS_SHOP, 0, center);
});

/** A shop client with the connection handshake folded in. */
async function connectShopUser(name: string, serial: number, consume18 = true): Promise<TestClient> {
  // re-arm the center user's "connecting to the shop" state — the real flow
  // gets it from the LS's ReqConnectToSvr on every shop entry
  const cu = center.userTable.get(name)!;
  cu.m_fConnecting = 1;
  cu.nConnectStamp = GetTickCount();
  center.InsertConnectingList(serial);
  const c = new TestClient();
  await c.connect(SHOP_PORT, { sndDeg: 2, rcvDeg: 2 });
  // the accept packet 0 ([E2 3][E2 7][E4 headerType][EStr patch url]) is
  // parsed by the client to learn the header type; keep a sanity check on it
  const p0 = await c.recv(0);
  expect(r2(p0)).toBe(3);
  expect(r2(p0)).toBe(7);
  p0.off += 4; // header type
  expect(rstr(p0)).toBe("ftp://patch.nexon.co.kr/ca");
  c.send(7, (e) => {
    e.u8(1); // count
    e.str(name);
    e.u32be(serial); // +3096 — the global serial
    e.u32be(0xffffffff); // +3108 — SID
    e.u32be(0xffffffff); // +3112 — BID
    e.u8(0); // selected user idx
  });
  // the game client waits for the initial info before anything else
  if (consume18) await c.recv(18);
  return c;
}

function deStream(n: CReceived): CISmartStream {
  const size = r4(n);
  const s = new CISmartStream();
  s.SetBuffer(n.buf.subarray(n.off, n.off + size), 0);
  n.off += size;
  return s;
}

describe("shop flow", () => {
  test("shop-side packet 201 uses the same native E4 per-user inventory count", () => {
    const user = new ShopUser(null);
    user.m_vecUserInventory.push(Object.assign(new ShopUserInventory(), {
      SN: 123, Slot: 0xf0, ItemSN: 300, Verbose: "", dateAcquired: new Date("2099-01-01T00:00:00.000Z"),
    }));
    const packet = new CSendPacket(201, 2);
    shop.mainPool.MakeUserInventoryPacket(user, packet);
    expect(packet.m_uOffset).toBe(24); // type + E4 count + one 19-byte row
    const decoded = new CReceivedPacket();
    decoded.SetCipherDegree(2);
    decoded.SetRcvPacket(packet.m_pBlock, packet.m_uOffset);
    expect([decoded.Decode1(), decoded.Decode4(), decoded.Decode4(), decoded.Decode1(), decoded.Decode4(), decoded.DecodeStr()])
      .toEqual([201, 1, 123, 0xf0, 300, ""]);
    expect(decoded.DecodeRest().length).toBe(8);
    expect(decoded.m_uOffset).toBe(decoded.m_uLength);
  });

  test("client 7 → center CM 2 → client 18 initial info", async () => {
    const c = await connectShopUser("tester", 7, false);

    const p18 = await c.recv(18);
    const auth = r1(p18);
    expect(auth).toBe(0); // not a premium account
    const hashShopItem = r4(p18);
    const hashString = r4(p18);
    const hashPackageMap = r4(p18);
    const chargeUrl = rstr(p18);
    const authUrl = rstr(p18);
    expect(r1(p18)).toBe(1);
    expect(r1(p18)).toBe(0);
    expect(r1(p18)).toBe(1);
    expect(r1(p18)).toBe(0); // billing flag
    const bonusCount = r2(p18);
    expect(bonusCount).toBe(0);
    // the hashes ride from the CItemMan caches, the URLs from CAConfig
    const itemMan = CItemMan.ms_pInstance!;
    expect(hashShopItem).toBe(itemMan.m_nShopItemHash);
    expect(hashString).toBe(itemMan.m_nStringHash);
    expect(hashPackageMap).toBe(itemMan.m_nPackageMapHash);
    expect(chargeUrl).toBe("http://charge/url");
    expect(authUrl).toBe("http://auth/url");
    expect(hashShopItem).not.toBe(0);
    expect(hashString).not.toBe(0);
    c.close();
  });

  test("213 → 200 the cached shop item packet", async () => {
    const c = await connectShopUser("tester", 7);
    c.send(213, () => {});
    const p200 = await c.recv(200);
    const s = deStream(p200);
    expect(s.Decode2()).toBe(1); // one FxStock row
    expect(s.Decode4()).toBe(5000); // SN
    expect(s.Decode1()).toBe(13); // Category — dedicated limited-item fixture
    expect(s.DecodeStr()).toBe("stock5000");
    expect(s.Decode2()).toBe(0); // StringDesc
    expect(s.Decode2()).toBe(0); // StringUsage
    expect(s.Decode4()).toBe(300); // ItemSN
    expect(s.Decode4()).toBe(1); // Unit
    expect(s.DecodeStr()).toBe(""); // DataFile
    expect(s.Decode4()).toBe(100); // Price
    expect(s.Decode4()).toBe(0); // FixedPrice
    expect(s.Decode2()).toBe(0); // LimitLevel
    expect(s.Decode2()).toBe(0); // LimitEx
    expect(s.Decode2()).toBe(0); // ValidityPeriod
    expect(s.Decode2()).toBe(0); // ValidityLevel
    expect(s.Decode4()).toBe(0); // zorder
    expect(s.Decode1()).toBe(0); // CardNo
    expect(s.Decode1()).toBe(1); // MoneyType
    expect(s.IsEOS()).toBe(true);
    c.close();
  });

  test("215 → 205 the cached string packet", async () => {
    const c = await connectShopUser("tester", 7);
    c.send(215, () => {});
    const p205 = await c.recv(205);
    const s = deStream(p205);
    expect(s.Decode2()).toBe(1);
    expect(s.Decode4()).toBe(1);
    expect(s.DecodeStr()).toBe("HelloWorld");
    expect(s.IsEOS()).toBe(true);
    c.close();
  });

  test("220 → 213 the cached package map packet", async () => {
    const c = await connectShopUser("tester", 7);
    c.send(220, () => {});
    const p213 = await c.recv(213);
    const s = deStream(p213);
    expect(s.Decode2()).toBe(0); // no FxPackageMap rows
    expect(s.IsEOS()).toBe(true);
    c.close();
  });

  test("217 → 202 the user item table", async () => {
    const c = await connectShopUser("tester", 7);
    c.send(217, () => {});
    const p202 = await c.recv(202);
    expect(r2(p202)).toBe(1);
    expect(r4(p202)).toBe(300); // SN
    expect(r1(p202)).toBe(13); // Category
    expect(rstr(p202)).toBe("attr"); // strAttr
    expect(r4(p202)).toBe(10); // nAttr1 — the purchase limit
    expect(r4(p202)).toBe(0);
    expect(r4(p202)).toBe(0);
    expect(rstr(p202)).toBe("item300");
    c.close();
  });

  test("206 purchase → 204 ok, the DB rows move", async () => {
    const c = await connectShopUser("tester", 7);
    c.send(206, (e) => {
      e.u16(5000);
    });
    const p204 = await c.recv(204);
    expect(r1(p204)).toBe(0);
    const pv = new DataView(p204.buf.buffer, p204.off, 8);
    p204.off += 8;
    const days = pv.getFloat64(0, true);
    expect(days).toBeGreaterThan(40000); // a plausible variant time
    // the DB: +1 owned item, -100 cash
    const inv = new Database(`${DB_DIR}/UserInventory${String(GetUserHashNo("tester")).padStart(2, "0")}.db`);
    const owned = inv.query("SELECT Amount FROM FxUserInventory WHERE UserID = 'tester' AND ItemSN = 300").get() as
      | { Amount: number }
      | undefined;
    inv.close();
    expect(owned?.Amount).toBe(1);
    const u = new Database(`${DB_DIR}/UserInfo${String(GetUserHashNo("tester")).padStart(2, "0")}.db`);
    const money = u.query("SELECT Money FROM FxUserDynamic WHERE ID = 'tester'").get() as { Money: number };
    u.close();
    expect(money.Money).toBe(900);
    c.close();
  });

  test("206 purchase → 204 code 11 past the nAttr1 limit, with the Big5 message", async () => {
    const c = await connectShopUser("tester", 7);
    // 9 more purchases hit the limit of 10 (1 already owned)
    for (let i = 0; i < 9; i++) {
      c.send(206, (e) => {
        e.u16(5000);
      });
      const ok = await c.recv(204);
      expect(r1(ok)).toBe(0);
      ok.off += 8;
    }
    c.send(206, (e) => {
      e.u16(5000);
    });
    const p204 = await c.recv(204);
    expect(r1(p204)).toBe(11);
    // the wire carries the original Big5 ANSI bytes
    expect(new TextDecoder("big5").decode(Buffer.from(rstr(p204), "latin1"))).toBe(
      "已持有或收到此道具10個以上，無法再購入",
    );
    c.close();
  });

  test("206 with an unknown stock sn is silently ignored", async () => {
    const c = await connectShopUser("tester", 7);
    c.send(206, (e) => {
      e.u16(65535);
    });
    const p204 = await c.recv(204, 300).catch(() => null);
    expect(p204).toBeNull();
    c.close();
  });

  test("214 → 206 the charge info echo", async () => {
    const c = await connectShopUser("tester", 7);
    c.send(214, () => {});
    const p206 = await c.recv(206);
    expect(r1(p206)).toBe(0); // the FX attr (CMainSystem+4)
    expect(r4(p206)).toBe(7); // the global serial
    // the cached cash mirrors the DB after every successful purchase so far
    const u0 = new Database(`${DB_DIR}/UserInfo${String(GetUserHashNo("tester")).padStart(2, "0")}.db`);
    const cash = (u0.query("SELECT Money FROM FxUserDynamic WHERE ID = 'tester'").get() as { Money: number }).Money;
    u0.close();
    expect(r4(p206)).toBe(cash);
    c.close();
  });

  test("226 → 212 the shop server info list", async () => {
    const c = await connectShopUser("tester", 7);
    c.send(226, () => {});
    const p212 = await c.recv(212);
    const count = r4(p212);
    // the FXSS table only (CM 6's own scope)
    expect(count).toBe(1);
    let sawShop = false;
    for (let i = 0; i < count; i++) {
      const ip = r4(p212);
      const port = r4(p212); // MakeShopInfoPacket encodes the port as an E4
      if (port === SHOP_PORT) sawShop = true;
      void ip;
    }
    expect(sawShop).toBe(true);
    c.close();
  });

  test("20 → 20 the RTT echo", async () => {
    const c = await connectShopUser("tester", 7);
    c.send(20, (e) => {
      e.u32be(0x1234);
      e.u32be(0);
    });
    const p20 = await c.recv(20);
    expect(r4(p20)).toBe(0x1234);
    expect(r4(p20)).toBeGreaterThan(0);
    c.close();
  });

  test("an unknown user's 7 gets no client 18 and the socket closes", async () => {
    const c = new TestClient();
    await c.connect(SHOP_PORT, { sndDeg: 2, rcvDeg: 2 });
    c.send(7, (e) => {
      e.u8(1);
      e.str("ghost");
      e.u32be(99999);
      e.u8(0);
    });
    // the shop closes the connection after the failed CM 2 — the socket dies
    let closed = false;
    try {
      await c.recv(18, 500);
    } catch (e) {
      closed = String((e as Error).message).includes("closed") || c.closed;
    }
    expect(closed).toBe(true);
    c.close();
  });
});

// keep the tree-shaker honest about the imports used only in type positions
void gsEncode;
void gsDecode;


// A06: actual SQLite account -> encrypted Shop login -> client coupon request.
// Capture the billing send boundary; no external billing/payment is contacted.
test("Shop login derives the club ID from DB email and carries it into coupon billing", async () => {
  using info = new Database(`${DB_DIR}/UserInfo${String(GetUserHashNo("tester")).padStart(2, "0")}.db`);
  const original = info.query<{ Email: string }, []>("SELECT Email FROM FxUserAccount WHERE ID='tester'").get()!;
  try {
    for (const [email, clubId] of [["mailowner@nexonclub.com", "mailowner"], ["mailowner@example.com", ""]]) {
      info.query("UPDATE FxUserAccount SET Email=? WHERE ID='tester'").run(email!);
      const client = await connectShopUser("tester", 7);
      const sent = Promise.withResolvers<CSendPacket>();
      const capture = spyOn(shop.billing, "Send").mockImplementation(packet => { sent.resolve(packet); });
      const timeout = setTimeout(() => sent.reject(new Error("coupon request did not reach billing")), 2000);
      try {
        expect(CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(7)!.GetNexonClubId()).toBe(clubId);
        client.send(219, e => { e.str("fixture-coupon"); e.str(""); });
        const packet = await sent.promise;
        const decoded = new CReceivedPacket(); decoded.SetRcvPacket(packet.m_pBlock, packet.m_uOffset);
        expect([decoded.Decode1(), decoded.Decode1(), decoded.Decode4()]).toEqual([1, 0, 7]);
        expect(decoded.DecodeStr()).toBe("fixture-coupon");
        expect(decoded.DecodeStr()).toBe(clubId);
        expect(decoded.DecodeStr()).toBe("tester");
      } finally {
        clearTimeout(timeout); capture.mockRestore(); client.close();
      }
    }
  } finally {
    info.query("UPDATE FxUserAccount SET Email=? WHERE ID='tester'").run(original.Email);
  }
});

// Local test peer only, NOT an offline-authorization mode for production.
for (const [authResult, cashResult] of [[0, 0], [5, 0], [0, 1]] as const) {
  test(`DigiQ TCP 224 -> 341/342 -> 209 -> 301/302 -> 203; auth=${authResult}, cash=${cashResult}`, async () => {
    const { CSendPacket: BillingPacket } = await import("../src/FXSS/Packet.ts");
    const peers = new Set<Bun.Socket<Uint8Array>>();
    const errors = Promise.withResolvers<never>();
    void errors.promise.catch(() => {});
    const ids: number[] = [];
    const message = "\xa4\xa4 authorization denied";
    function string8(p: CSendPacket, value: string) {
      p.Encode1(value.length); p.EncodeBuffer(Buffer.from(value, "latin1"));
    }
    function readString8(n: CReceivedPacket) {
      const length = n.Decode1();
      const start = n.m_uOffset; n.m_uOffset += length;
      return Buffer.from(n.m_pBlock.subarray(start, n.m_uOffset)).toString("latin1");
    }
    function respond(peer: Bun.Socket<Uint8Array>, p: CSendPacket) {
      // Independent Tw framing: BE DWORD length, marker 7, raw payload.
      const frame = Buffer.alloc(8 + p.m_uOffset);
      frame.writeUInt32BE(p.m_uOffset); frame.writeUInt32BE(7, 4);
      frame.set(p.m_pBlock.subarray(0, p.m_uOffset), 8);
      peer.write(frame);
    }
    const server = Bun.listen<Uint8Array>({
      hostname: "127.0.0.1", port: 0,
      socket: {
        open(peer) { peers.add(peer); peer.data = new Uint8Array(); },
        close(peer) { peers.delete(peer); },
        data(peer, chunk) {
          try {
            peer.data = Buffer.concat([peer.data, chunk]);
            while (peer.data.length >= 8) {
              const frame = Buffer.from(peer.data);
              const length = frame.readUInt32BE();
              expect(frame.readUInt32BE(4)).toBe(7);
              if (frame.length < length + 8) break;
              const n = new CReceivedPacket(); n.SetRcvPacket(frame.subarray(8, length + 8), length);
              peer.data = frame.subarray(length + 8);
              const id = n.Decode4(); ids.push(id);
              if (id === 331) {
                expect([n.Decode4(), n.Decode4()]).toEqual([4, 0]);
              } else if (id === 341) {
                expect([readString8(n), readString8(n), readString8(n)])
                  .toEqual(["fixture-id", "fixture-pw", "tester"]);
                const p = new BillingPacket(342);
                p.Encode4(0x11223344); p.Encode4(0xaabbccdd);
                string8(p, "tester"); p.Encode4(authResult);
                if (authResult !== 0) string8(p, message);
                respond(peer, p);
              } else if (id === 301) {
                expect(authResult).toBe(0);
                expect([n.Decode4(), n.Decode4(), n.Decode4(), n.Decode4()])
                  .toEqual([0xffffffff, 0xffffffff, 4, 0]);
                expect(readString8(n)).toBe("tester");
                expect(n.Decode4()).toBe(7); expect(readString8(n)).toBe("127.0.0.1");
                const p = new BillingPacket(302);
                p.Encode4(0); string8(p, "tester");
                p.Encode4(7); p.Encode4(750); p.Encode4(cashResult);
                if (cashResult === 1) string8(p, message);
                respond(peer, p);
              } else {
                throw new Error(`Unexpected billing opcode ${id}`);
              }
              expect(n.m_uOffset).toBe(n.m_uLength);
            }
          } catch (error) { errors.reject(error); }
        },
      },
    });
    const billing = shop.billing;
    const previous = { servers: billing.m_aBillingSvr, socket: billing.m_pSocket, connected: billing.m_fConnected };
    let client: TestClient | undefined;
    try {
      billing.m_aBillingSvr = [{ SN: 0, ip: "127.0.0.1", port: server.port }];
      await Promise.race([errors.promise, (async () => {
        expect(await billing.ConnectToSvr()).toBe(1);
        client = await connectShopUser("tester", 7);
        const user = shop.userTable.FindUser("tester")!;
        const currency = user.m_nCash;
        expect(user.m_nBillingCash).toBe(0); // packet 7 supplies SID/BID, not cash
        client.send(224, e => { e.str("fixture-id"); e.str("fixture-pw"); });
        const response = await client.recv(209);
        if (authResult !== 0) {
          expect(r1(response)).toBe(13); expect(rstr(response)).toBe(message);
          expect(ids).toEqual([331, 341]);
          expect(client.hasPending(203)).toBe(false);
        } else {
          expect([r1(response), r4(response), r4(response)]).toEqual([12, 0x11223344, 0xaabbccdd]);
          const cash = await client.recv(203);
          if (cashResult === 1) {
            expect(r1(cash)).toBe(0); expect(rstr(cash)).toBe(message);
            expect(user.m_nBillingCash).toBe(0);
          } else {
            expect([r1(cash), r4(cash)]).toEqual([1, 750]);
            expect(user.m_nBillingCash).toBe(750);
          }
          expect(cash.off).toBe(cash.buf.length);
          expect(ids).toEqual([331, 341, 301]);
        }
        expect(response.off).toBe(response.buf.length);
        expect(user.m_nCash).toBe(currency);
      })()]);
    } finally {
      client?.close();
      billing.m_pSocket?.Close();
      billing.m_pSocket = previous.socket;
      billing.m_fConnected = previous.connected;
      billing.m_aBillingSvr = previous.servers;
      for (const peer of peers) peer.end();
      server.stop(true);
    }
  });
}
