import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CServerApp } from "../CServerApp.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { ServerType } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { PreRow } from "./helpers/PreInventory.ts";
import { MemoryClient, WireClient } from "./helpers/Clients.ts";
import { TestConfig } from "./helpers/Accounts.ts";
import { greeting, login, transfer } from "./helpers/Network.ts";
import {
  HandoffFixture,
  HandoffRequest,
  SeedHandoffDefinitions,
  type HandoffEnvironment,
} from "./helpers/InventoryHandoff.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function create() {
  const e = HandoffFixture();
  cleanup.push(e.close);
  e.users[0]!.InstallPreInventory([PreRow({ Description: "PRE first" })]);
  e.users[1]!.InstallPreInventory([
    PreRow({ ItemSn: 0x80000000, Description: "PRE second" }),
  ]);
  return e;
}
function unmoved(e: HandoffEnvironment) {
  expect(e.target.m_aUser).toEqual([]);
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.target.packets).toEqual([]);
  expect(e.source.IsConnected()).toBe(true);
  expect(
    e.users.every(
      (u) =>
        u.m_pendingConnection === e.pending && u.m_pClientSocket === e.source,
    ),
  ).toBe(true);
  expect(e.pool.GetRankList()).toEqual([]);
  expect(e.callbacks()).toBe(0);
}
function receipts(e: HandoffEnvironment) {
  return [
    "RuntimeGameResult",
    "RuntimeMoneyPickup",
    "RuntimeHouseClaim",
    "RuntimeSpecialItemUse",
  ].map(
    (name) =>
      e.session.db
        .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${name}`)
        .get()!.n,
  );
}

test("initialized clients with SECOND-only pre still receive210207201 including EMPTY first local; pre isn't legacy owned stock or a wallet/XP/auth grant", () => {
  const e = create();
  e.users[0]!.InstallPreInventory([]);
  const row = e.db.AddInventory("First", 0xabcdef01, 3, 0, "LEGACY owned only"),
    before = e.users.map((u) => u.GetDynamicInfoSnapshot()),
    pre = e.users.map((u) => u.CapturePreInventory());
  let first = true;
  const send = e.target.SendPacket.bind(e.target);
  e.target.SendPacket = (p) => {
    if (first) {
      first = false;
      expect(e.target.m_aUser).toEqual(e.users);
      expect(e.source.IsConnected()).toBe(false);
      expect(e.pool.GetRankList()).toHaveLength(2);
      expect(e.users[0]!.m_aInventory).toEqual([row]);
    }
    send(p);
  };
  e.run(true);
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([210, 207, 201]);
  e.target.Take(210);
  const p = e.target.Take(207);
  expect([p.Decode1(), p.Decode1(), p.Decode1()]).toEqual([2, 0, 1]);
  expect([
    p.Decode1(),
    p.Decode4(),
    p.Decode2(),
    p.Decode2(),
    p.Decode2(),
  ]).toEqual([23, 0x80000000, 3, 0, 99999 & 0xffff]);
  expect([p.DecodeStr(), p.DecodeStr()]).toEqual([
    "PRE attribute",
    "PRE second",
  ]);
  p.AssertEnd();
  const owned = e.target.Take(201);
  expect(owned.Decode1()).toBe(2);
  expect(owned.Decode4()).toBe(1);
  expect(owned.Decode4()).toBe(row.SN);
  expect(e.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
  expect(e.users.map((u) => u.CapturePreInventory())).toEqual(pre);
  expect(e.users[1]!.m_aInventory).toEqual([]);
  expect(e.users[1]!.GetUserInventory(0x80000000)).toBeUndefined();
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("a missing definition on SECOND207 cannot emit210/202/first-local pre or attach anyone; catalog repair permits SAME original pending", () => {
  const e = create();
  e.users[1]!.InstallPreInventory([PreRow({ ItemSn: 999 })]);
  const before = e.users.map((u) => u.GetDynamicInfoSnapshot());
  expect(() => e.run()).toThrow("missing definition");
  unmoved(e);
  expect(e.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
  e.session.db.exec(
    "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES(999,2,'new catalog',0,0,0,'repaired')",
  );
  e.items.UpdateUserItemTable();
  e.run();
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([
    210, 202, 207, 201,
  ]);
  expect(e.target.m_aUser).toEqual(e.users);
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("TWO individually valid207 bodies can overflow their whole-group packet; NO210/202 or consumed first local, and read-side repair retries original TTL", () => {
  const e = create(),
    large = Array.from({ length: 5 }, () =>
      PreRow({ strAttr: "A".repeat(4096), Description: "B".repeat(4096) }),
    );
  e.users.forEach((u) => u.InstallPreInventory(large));
  for (const u of e.users) {
    const single = new CSendPacket(207);
    u.MakePreInventoryPacket(single, e.items.CaptureSnapshot());
    expect(single.GetBuffer().length).toBeLessThan(65535);
  }
  expect(() => e.run()).toThrow("too long");
  unmoved(e);
  e.tick(1);
  expect(e.users[0]!.m_pendingConnection!.expires).toBe(e.pending.expires);
  e.users[1]!.InstallPreInventory([PreRow()]);
  e.run();
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([
    210, 202, 207, 201,
  ]);
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("SECOND legacy201 overflow is caught AFTER207 preparation but BEFORE any transport, rank callback or transfer consumption", () => {
  const e = create(),
    stock = e.db.AddInventory("Second", 7, 3, 0, "stored"),
    stored = e.db.GetInventoryRecord(stock.SN),
    load = e.db.LoadInventory.bind(e.db);
  e.db.LoadInventory = (ID) =>
    ID === "Second"
      ? Array.from({ length: 20 }, (_, i) => ({
          ...stock,
          SN: i + 1,
          Verbose: "X".repeat(4096),
        }))
      : load(ID);
  expect(() => e.run(true)).toThrow("too long");
  unmoved(e);
  expect(e.db.GetInventoryRecord(stock.SN)).toEqual(stored);
  e.db.LoadInventory = load;
  e.run(true);
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([210, 207, 201]);
  expect(e.users[1]!.m_aInventory).toEqual([stock]);
});

test("wrong outgoing pre codepage refuses the WHOLE group before consumption; trusted UTF8 rows cross Center without accidental Big5 validation", () => {
  const e = create();
  e.users[1]!.InstallPreInventory(
    [PreRow({ Description: "🎮" })],
    new CTextCodec("utf8"),
  );
  expect(() => e.run()).toThrow("representable");
  unmoved(e);
  Reflect.set(e.target, "text", new CTextCodec("utf8"));
  e.run();
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([
    210, 202, 207, 201,
  ]);
  e.target.Take(210);
  e.target.Take(202);
  const p = e.target.Take(207);
  expect(p.Decode1()).toBe(2);
  const descriptions: string[] = [];
  for (let i = 0; i < 2; i++) {
    expect(p.Decode1()).toBe(1);
    p.Decode1();
    p.Decode4();
    p.Decode2();
    p.Decode2();
    p.Decode2();
    p.DecodeStr();
    descriptions.push(p.DecodeStr());
  }
  expect(descriptions).toEqual(["PRE first", "🎮"]);
  p.AssertEnd();
});

test("ONE catalog capture binds202 and BOTH207 locals when a codec reloads definitions AFTER first207 was encoded", () => {
  const e = create();
  e.users[1]!.InstallPreInventory([PreRow({ Description: "PRE second" })]);
  const capture = e.items.CaptureSnapshot.bind(e.items),
    encode = e.target.text.Encode.bind(e.target.text);
  let captures = 0,
    seen = 0;
  e.items.CaptureSnapshot = () => {
    captures++;
    return capture();
  };
  e.target.text.Encode = (s) => {
    if (s === "PRE first" && ++seen === 3) {
      e.session.db.exec(
        "UPDATE FxItem SET Category=2,strAttr='changed' WHERE SN=7",
      );
      e.items.UpdateUserItemTable();
    }
    return encode(s);
  };
  e.run();
  expect(captures).toBe(1);
  expect(seen).toBe(3);
  expect(capture().GetUserItem(7)!.Category).toBe(2);
  e.target.Take(210);
  const catalog = e.target.Take(202);
  expect(catalog.Decode2()).toBe(2);
  expect(catalog.Decode4()).toBe(7);
  expect(catalog.Decode1()).toBe(101);
  const pre = e.target.Take(207);
  expect(pre.Decode1()).toBe(2);
  for (const u of e.users) {
    expect(pre.Decode1()).toBe(1);
    pre.Decode1();
    expect(pre.Decode4()).toBe(7);
    pre.Decode2();
    expect(pre.Decode2()).toBe(u.GetLevel());
    pre.Decode2();
    pre.DecodeStr();
    pre.DecodeStr();
  }
  pre.AssertEnd();
});

test("207 cached level belongs to the detached LOADED account, not stale source cache, fake/look-level, ValidityLevel or a pre-generated money/XP After", () => {
  const e = create(),
    old = e.users[0]!.GetLevel();
  e.users[0]!.SetFakeLevel(1000);
  e.session.db.exec("UPDATE FxUserDynamic SET Exp=0 WHERE ID='First'");
  e.run(true);
  e.target.Take(210);
  const pre = e.target.Take(207);
  expect(pre.Decode1()).toBe(2);
  expect(pre.Decode1()).toBe(1);
  pre.Decode1();
  expect(pre.Decode4()).toBe(7);
  pre.Decode2();
  expect(pre.Decode2()).toBe(e.users[0]!.GetLevel());
  expect(e.users[0]!.GetLevel()).not.toBe(old);
  expect(e.users[0]!.GetLevel()).toBe(1);
  expect(e.users[0]!.GetLookLevel()).not.toBe(1);
  expect(e.db.GetUserInfo("First")!.Exp).toBe(0);
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("pre-only identical reload / empty-pre ABA INSIDE SECOND207 rechecks ENTIRE source group, and release permits a fresh same-pending attempt without effects", () => {
  for (const aba of [false, true]) {
    const e = create(),
      encode = e.target.text.Encode.bind(e.target.text);
    let seen = 0;
    e.target.text.Encode = (s) => {
      if (s === "PRE second" && ++seen === 3) {
        const rows = e.users[0]!.CapturePreInventory().Rows;
        if (aba) e.users[0]!.InstallPreInventory([]);
        e.users[0]!.InstallPreInventory(rows);
      }
      return encode(s);
    };
    expect(() => e.run()).toThrow("changed");
    expect(seen).toBe(3);
    unmoved(e);
    expect(receipts(e)).toEqual([0, 0, 0, 0]);
    e.target.text.Encode = encode;
    e.run();
    expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([
      210, 202, 207, 201,
    ]);
  }
});

test("nested GS establishment / old one-step confirm INSIDE207 cannot consume the exclusive lease or perform another DB read", () => {
  const e = create(),
    other = new MemoryClient();
  cleanup.push(() => other.Close());
  const encode = e.target.text.Encode.bind(e.target.text),
    get = e.db.GetUserInfo.bind(e.db),
    load = e.db.LoadInventory.bind(e.db);
  let infos = 0,
    inventories = 0,
    seen = 0;
  e.db.GetUserInfo = (id) => {
    infos++;
    return get(id);
  };
  e.db.LoadInventory = (id) => {
    inventories++;
    return load(id);
  };
  e.target.text.Encode = (s) => {
    if (s === "PRE second" && ++seen === 3) {
      expect(() => e.run()).toThrow("active");
      expect(() => e.gs.ConfirmConnection(other, e.ids)).toThrow("active");
      expect([infos, inventories]).toEqual([2, 2]);
    }
    return encode(s);
  };
  e.run();
  expect(seen).toBe(3);
  expect([infos, inventories]).toEqual([2, 2]);
  expect(other.m_aUser).toEqual([]);
  expect(e.target.m_aUser).toEqual(e.users);
});

test("expiry DURING207 cannot renew authority or publish any prepared packet; pending expires with source still owning users", () => {
  const e = create(),
    encode = e.target.text.Encode.bind(e.target.text);
  let seen = 0;
  e.target.text.Encode = (s) => {
    if (s === "PRE second" && ++seen === 3)
      e.tick(RuntimePolicy.SessionTransferTimeoutMs);
    return encode(s);
  };
  expect(() => e.run()).toThrow();
  expect(seen).toBe(3);
  expect(e.target.packets).toEqual([]);
  expect(e.target.m_aUser).toEqual([]);
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.users.every((u) => !u.m_pendingConnection)).toBe(true);
  expect(e.callbacks()).toBe(0);
});

test("post-consume rank callback failure does NOT roll back ownership or authorize a replay just because no207 was sent", () => {
  const e = create();
  Reflect.set(e.connect, "onUsersAttached", () => {
    throw new Error("post-consume callback");
  });
  expect(() => e.run()).toThrow("post-consume");
  expect(e.target.m_aUser).toEqual(e.users);
  expect(e.source.m_aUser).toEqual([]);
  expect(
    e.users.every(
      (u) => !u.m_pendingConnection && u.m_pClientSocket === e.target,
    ),
  ).toBe(true);
  expect(e.target.packets).toEqual([]);
  expect(() => e.run()).toThrow("count");
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("transport failure at207 preserves consumed ownership and already sent210/202; no exactly-once TCP or pretend financial rollback", () => {
  const e = create(),
    send = e.target.SendPacket.bind(e.target);
  e.target.SendPacket = (p) => {
    if (p.m_nPacketType === 207) throw new Error("207 transport failed");
    send(p);
  };
  expect(() => e.run()).toThrow("207 transport");
  expect(e.target.m_aUser).toEqual(e.users);
  expect(e.source.m_aUser).toEqual([]);
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([210, 202]);
  expect(e.callbacks()).toBe(1);
  expect(() => e.run()).toThrow("count");
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("REAL TCP: SECOND207 overflow sends NO210 and preserves original two-local pending; trusted repair/new TCP sends210207201 with empty first, no native SQL/financial grant", async () => {
  const config = TestConfig(),
    app = new CServerApp(config),
    peers: WireClient[] = [],
    warn = console.warn;
  const connect = (port: number) => {
    const p = new WireClient(port);
    peers.push(p);
    return p;
  };
  try {
    SeedHandoffDefinitions(app.m_dbSession);
    const gs = app.m_gameServers[0]!;
    gs.m_userItemMan.UpdateUserItemTable();
    const db = new CDBMan(app.m_dbSession);
    for (const ID of ["Alice", "Partner"])
      await db.RegisterNewUser({
        ID,
        Password: "test-password",
        Gender: ID === "Alice" ? 1 : 0,
      });
    await app.SetUp();
    const ls = connect(app.m_loginServer.m_listenSocket.port);
    await greeting(ls);
    const group = await login(ls, ["Alice", "Partner"]),
      port = await transfer(ls),
      users = group.map(
        (id) => app.m_center.m_globalUserTable.GetUser(id.GlobalSerialNo)!,
      );
    const pending = users[0]!.m_pendingConnection!;
    // EXPLICIT trusted read-side fixture, not a SQL row / billing success.
    users[1]!.InstallPreInventory(
      Array.from({ length: 30 }, () =>
        PreRow({ strAttr: "A".repeat(4096), Description: "B".repeat(4096) }),
      ),
    );
    const before = users.map((u) => u.GetDynamicInfoSnapshot()),
      sql = () =>
        app.m_dbSession.db
          .query<{ n: number }, []>("SELECT total_changes() AS n")
          .get()!.n,
      changes = sql();
    console.warn = () => {};
    const bad = connect(port);
    await greeting(bad);
    bad.Send(HandoffRequest(group, true));
    await expect(bad.Read()).rejects.toThrow("closed");
    expect(
      users.every(
        (u) =>
          u.m_pendingConnection === pending &&
          u.m_pLocalServer?.GetServerType() === ServerType.Login,
      ),
    ).toBe(true);
    expect(users[0]!.m_pClientSocket?.GetUserCount()).toBe(2);
    expect(gs.m_channelPool.GetRankList()).toEqual([]);
    expect(users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
    expect(sql()).toBe(changes);
    users[1]!.InstallPreInventory([PreRow()]);
    const good = connect(port);
    await greeting(good);
    good.Send(HandoffRequest(group, true));
    const info = await good.Read();
    expect(info.Decode1()).toBe(210);
    expect(info.Decode1()).toBe(1);
    info.AssertEnd();
    const pre = await good.Read();
    expect(pre.Decode1()).toBe(207);
    expect([pre.Decode1(), pre.Decode1(), pre.Decode1()]).toEqual([2, 0, 1]);
    expect([
      pre.Decode1(),
      pre.Decode4(),
      pre.Decode2(),
      pre.Decode2(),
      pre.Decode2(),
    ]).toEqual([23, 7, 3, users[1]!.GetLevel(), 99999 & 0xffff]);
    expect([pre.DecodeStr(), pre.DecodeStr()]).toEqual([
      "PRE attribute",
      "PRE description",
    ]);
    pre.AssertEnd();
    const inventory = await good.Read();
    expect(inventory.Decode1()).toBe(201);
    expect([
      inventory.Decode1(),
      inventory.Decode4(),
      inventory.Decode4(),
    ]).toEqual([2, 0, 0]);
    inventory.AssertEnd();
    expect(
      users.every(
        (u) =>
          !u.m_pendingConnection &&
          u.m_pLocalServer?.GetServerType() === ServerType.FXGame,
      ),
    ).toBe(true);
    expect(users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
    expect(users.map((u) => u.m_aInventory)).toEqual([[], []]);
    expect(sql()).toBe(changes);
    expect(gs.m_channelPool.GetRankList()).toHaveLength(2);
    expect(app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(app.GetStatus().officialClientVerified).toBe(false);
    for (const table of [
      "RuntimeGameResult",
      "RuntimeMoneyPickup",
      "RuntimeHouseClaim",
      "RuntimeSpecialItemUse",
    ])
      expect(
        app.m_dbSession.db
          .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
          .get()!.n,
      ).toBe(0);
  } finally {
    console.warn = warn;
    for (const p of peers) p.Close();
    await app.CleanUp();
  }
}, 15000);

test("legacy FxPreInventory is NEVER an implicit native207 source or an award procedure: initialized zero trusted pre sends ONLY210 and leaves SQL unchanged", () => {
  const e = HandoffFixture();
  cleanup.push(e.close);
  e.session.db.exec(
    "INSERT INTO FxPreInventory(SN,ID,ItemID,Amount,ValidityPeriod,Verbose) VALUES(31,'Second',7,99999,100000,'legacy NOT native Description')",
  );
  const stored = e.session.db.query("SELECT * FROM FxPreInventory").all(),
    before = e.users.map((u) => u.GetDynamicInfoSnapshot()),
    changes = () =>
      e.session.db
        .query<{ n: number }, []>("SELECT total_changes() AS n")
        .get()!.n,
    initial = changes();
  e.run(true);
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([210]);
  expect(e.users.map((u) => u.GetPreInventoryCount())).toEqual([0, 0]);
  expect(e.users.map((u) => u.m_aInventory)).toEqual([[], []]);
  expect(e.session.db.query("SELECT * FROM FxPreInventory").all()).toEqual(
    stored,
  );
  expect(e.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
  expect(changes()).toBe(initial);
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("catalog reload DURING pre-candidate validation BEFORE202 cannot make202 newer than the definitions bound for207", () => {
  const e = create(),
    encode = e.target.text.Encode.bind(e.target.text);
  let seen = 0;
  e.target.text.Encode = (s) => {
    if (s === "PRE second" && ++seen === 1) {
      e.session.db.exec(
        "UPDATE FxItem SET Category=2,strName='new name' WHERE SN=7",
      );
      e.items.UpdateUserItemTable();
    }
    return encode(s);
  };
  e.run();
  expect(seen).toBe(3);
  expect(e.items.GetUserItem(7)!.Category).toBe(2);
  e.target.Take(210);
  const catalog = e.target.Take(202);
  expect(catalog.Decode2()).toBe(2);
  expect(catalog.Decode4()).toBe(7);
  expect(catalog.Decode1()).toBe(101);
  expect(catalog.DecodeStr()).toBe("catalog-attribute0");
  catalog.Decode4();
  catalog.Decode4();
  catalog.Decode4();
  expect(catalog.DecodeStr()).toBe("catalog-name0");
  const pre = e.target.Take(207);
  expect(pre.Decode1()).toBe(2);
  expect(pre.Decode1()).toBe(1);
  pre.Decode1();
  expect(pre.Decode4()).toBe(7);
  pre.Decode2();
  expect(pre.Decode2()).toBe(e.users[0]!.GetLevel());
});
