/**
 * End-to-end exercise of the item shop (FXSS): center ↔ shop attach (CM 6
 * OnShopServerInfo), client 7 → MC 3 → CM 2 → client 18, the cached CItemMan
 * table packets (200/205/213/202), the purchase path (206 → 204, the DB
 * writes) and the misc handlers (214/226/20) — against the real code paths.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { CServerConfig, CXCENTER_STR_KEYS, FXSHOP_STR_KEYS } from "../src/core/Config.ts";
import { CDBMan } from "../src/db/DBMan.ts";
import { CxCenter, CUser } from "../src/Center/Center.ts";
import { CxShop } from "../src/FXSS/Shop.ts";
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
          VALUES (300, 1, 'attr', 10, 0, 0, 'item300', 0)`);
  db.run(`INSERT INTO FxStock (SN, Category, Name, ItemSN, Unit, DataFile, Price, FixedPrice,
             LimitLevel, LimitEx, ValidityPeriod, ValidityLevel, StringDesc, StringUsage,
             CardNo, MoneyType, zorder, IsValid)
          VALUES (5000, 1, 'stock5000', 300, 1, '', 100, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1)`);
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
  const cu = new CUser("tester", SVRCLASS_SHOP, 0, 7);
  center.userTable.set("tester", cu);
  center.serialTable.set(7, cu);
  cu.SetConnectingToSvr(SVRCLASS_SHOP, 0, center);
});

/** A shop client with the connection handshake folded in. */
async function connectShopUser(name: string, serial: number, consume18 = true): Promise<TestClient> {
  // re-arm the center user's "connecting to the shop" state — the real flow
  // gets it from the LS's ReqConnectToSvr on every shop entry
  const cu = center.userTable.get(name)!;
  cu.nConnectingType = SVRCLASS_SHOP;
  cu.nConnectingIdx = 0;
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
    e.u32be(0xffffffff); // +3104 — write-only in the original
    e.u32be(0xffffffff); // +3108 — the billing SID (none registered → flag 0)
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
    expect(s.Decode1()).toBe(1); // Category
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
    expect(r1(p202)).toBe(1); // Category
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
