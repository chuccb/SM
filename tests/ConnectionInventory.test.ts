import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { CConnectPool } from "../FXGS/CConnectPool.ts";
import { CUserItemMan } from "../FXGS/CUserItemMan.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import type { CUser } from "../Common/CUser.ts";
import type { UserItem } from "../Common/DB/Rows.ts";
import { OpaqueOfficial, ServerType } from "../Common/OfficialValues.ts";
import { CServerApp } from "../CServerApp.ts";
import { ChannelFixture } from "./helpers/Channel.ts";
import { MemoryClient, Received, WireClient } from "./helpers/Clients.ts";
import { TestConfig } from "./helpers/Accounts.ts";
import { greeting, login, transfer, establish } from "./helpers/Network.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function def(extra: Partial<UserItem> = {}): UserItem {
  return {
    SN: 7,
    Category: 6,
    strAttr: "Item/Fixture",
    nAttr1: -7,
    nAttr2: -1,
    nAttr3: 2147483647,
    strName: "SYNTHETIC catalog only",
    ...extra,
  };
}
function seed(s: CDBSession, rows: readonly UserItem[]) {
  const q = s.db.query(
    "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES(?,?,?,?,?,?,?)",
  );
  for (const r of rows)
    q.run(r.SN, r.Category, r.strAttr, r.nAttr1, r.nAttr2, r.nAttr3, r.strName);
}
function packet(users: readonly CUser[], initialized = false) {
  const p = new CSendPacket(7).Encode1(users.length);
  for (const u of users)
    p.EncodeStr(u.GetName())
      .Encode4(u.GetGlobalSerialNo())
      .Encode4(u.m_userInfo.GuildSn);
  return p
    .Encode4(0)
    .Encode4(OpaqueOfficial.FxClientIntegrityXor[0]!)
    .Encode1(initialized ? 0 : 1);
}
function setup(rows: readonly UserItem[] = [def()]) {
  const c = ChannelFixture(),
    s = new CDBSession(":memory:"),
    db = new CDBMan(s),
    source = new MemoryClient(),
    target = new MemoryClient();
  cleanup.push(
    () => s.Close(),
    () => source.Close(),
    () => target.Close(),
  );
  for (const id of ["First", "Second"]) {
    s.db
      .query(
        "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES(?,0,'fixture')",
      )
      .run(id);
    s.db.query("INSERT INTO FxUserDynamic(ID,Exp) VALUES(?,0)").run(id);
  }
  seed(s, rows);
  const items = new CUserItemMan(db),
    users = c.ls.RegisterConnection(source, [
      db.GetUserInfo("First")!,
      db.GetUserInfo("Second")!,
    ]);
  c.pool.AddNewSocket(target);
  let callbacks = 0;
  const connect = new CConnectPool(db, c.gs, items, c.sessions, 1, (peer) => {
    callbacks++;
    c.pool.InsertRankList(peer);
  });
  expect(c.ls.RequestConnection(source, ServerType.FXGame, 0).result).toBe(1);
  return {
    ...c,
    s,
    db,
    source,
    target,
    items,
    users,
    connect,
    callbacks: () => callbacks,
  };
}
function unchanged(
  c: ReturnType<typeof setup>,
  pending: unknown,
  before: ReturnType<CUser["GetDynamicInfoSnapshot"]>[],
) {
  expect(c.target.m_aUser).toEqual([]);
  expect(c.target.packets).toEqual([]);
  expect(c.target.m_nPoolType).toBe("Connecting");
  expect(c.source.IsConnected()).toBe(true);
  expect(c.source.m_aUser).toEqual(c.users);
  expect(c.pool.GetRankList()).toEqual([]);
  expect(c.callbacks()).toBe(0);
  expect(
    c.users.every(
      (u) =>
        u.m_pClientSocket === c.source &&
        u.m_pendingConnection === pending &&
        u.IsSetFree() === 0,
    ),
  ).toBe(true);
  expect(c.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
}

test("nonempty202/201 are fully prepared before two-local ownership handoff; first publication sees complete group/rank and EXACT native order, without inventing native equipment from legacy ItemID", () => {
  const c = setup([
    def({ SN: 0xffffffff }),
    def({ SN: 0 }),
    def({ SN: 0x80000000 }),
  ]);
  const stock = c.db.AddInventory(
    "First",
    0xffffffff,
    3,
    0,
    "opaque legacy inventory",
  );
  let observed = false;
  const send = c.target.SendPacket.bind(c.target);
  c.target.SendPacket = (p) => {
    if (!observed) {
      observed = true;
      expect(c.target.m_aUser).toEqual(c.users);
      expect(c.source.m_aUser).toEqual([]);
      expect(c.source.IsConnected()).toBe(false);
      expect(c.pool.GetRankList()).toHaveLength(2);
      expect(c.users[0]!.m_aInventory).toEqual([stock]);
    }
    send(p);
  };
  c.connect.OnPacket(Received(packet(c.users)), c.target);
  expect(observed).toBe(true);
  expect(c.callbacks()).toBe(1);
  expect(c.target.packets.map((p) => p.m_nPacketType)).toEqual([210, 202, 201]);
  expect(c.users[0]!.GetFakeLevel()).toBe(0);
  expect(c.users[0]!.GetLevelIconSn()).toBe(0);
  const info = c.target.Take(210);
  expect(info.Decode1()).toBe(1);
  info.AssertEnd();
  const catalog = c.target.Take(202);
  expect(catalog.Decode2()).toBe(3);
  for (const sn of [0, 0x80000000, 0xffffffff]) {
    expect(catalog.Decode4()).toBe(sn);
    expect(catalog.Decode1()).toBe(6);
    expect(catalog.DecodeStr()).toBe("Item/Fixture");
    expect(catalog.Decode4()).toBe(-7 >>> 0);
    expect(catalog.Decode4()).toBe(0xffffffff);
    expect(catalog.Decode4()).toBe(2147483647);
    expect(catalog.DecodeStr()).toBe("SYNTHETIC catalog only");
  }
  catalog.AssertEnd();
  const inv = c.target.Take(201);
  expect(inv.Decode1()).toBe(2);
  expect(inv.Decode4()).toBe(1);
  expect(inv.Decode4()).toBe(stock.SN);
  expect(inv.Decode1()).toBe(0);
  expect(inv.Decode4()).toBe(3);
  expect(inv.DecodeStr()).toBe(stock.Verbose);
  expect(inv.DecodeBuffer(8).readDoubleLE()).toBe(0);
  expect(inv.Decode4()).toBe(0);
  inv.AssertEnd();
});

test("oversized catalog is rejected BEFORE any user/level/inventory/rank/pending transfer is consumed; fixing the catalog permits the SAME request without a new handoff", () => {
  const c = setup(
      Array.from({ length: 20 }, (_, i) =>
        def({ SN: i, strAttr: "A".repeat(4096), strName: "B".repeat(4096) }),
      ),
    ),
    pending = c.users[0]!.m_pendingConnection,
    before = c.users.map((u) => u.GetDynamicInfoSnapshot());
  expect(() => c.connect.OnPacket(Received(packet(c.users)), c.target)).toThrow(
    "too long",
  );
  unchanged(c, pending, before);
  c.s.db.exec("DELETE FROM FxItem");
  seed(c.s, [def()]);
  c.items.UpdateUserItemTable();
  c.connect.OnPacket(Received(packet(c.users)), c.target);
  expect(c.target.m_aUser).toEqual(c.users);
  expect(c.users.every((u) => u.m_pendingConnection === undefined)).toBe(true);
  expect(c.callbacks()).toBe(1);
});

test("invalid SECOND-user inventory string encoding cannot attach the first user or emit210/202; explicit data repair preserves the original group token", () => {
  const c = setup(),
    pending = c.users[0]!.m_pendingConnection,
    before = c.users.map((u) => u.GetDynamicInfoSnapshot());
  c.db.AddInventory("First", 7, 3);
  c.s.db.exec(
    "INSERT INTO FxUserInventory(ID,ItemID,Amount,Verbose) VALUES('Second',9,2,'🎮')",
  );
  expect(() => c.connect.OnPacket(Received(packet(c.users)), c.target)).toThrow(
    "representable",
  );
  unchanged(c, pending, before);
  expect(c.users.map((u) => u.m_aInventory)).toEqual([[], []]);
  c.s.db.exec(
    "UPDATE FxUserInventory SET Verbose='repaired' WHERE ID='Second'",
  );
  c.connect.OnPacket(Received(packet(c.users)), c.target);
  expect(c.users.map((u) => u.m_aInventory.length)).toEqual([1, 1]);
  expect(c.callbacks()).toBe(1);
});

test("SECOND-user201 string/whole packet overflow is likewise pre-handoff; no successful catalog alone may consume a token", () => {
  for (const mode of ["string", "packet"]) {
    const c = setup(),
      pending = c.users[0]!.m_pendingConnection,
      before = c.users.map((u) => u.GetDynamicInfoSnapshot());
    if (mode === "string")
      c.s.db
        .query(
          "INSERT INTO FxUserInventory(ID,ItemID,Amount,Verbose) VALUES('Second',9,2,?)",
        )
        .run("X".repeat(32768));
    else {
      const insert = c.s.db.query(
        "INSERT INTO FxUserInventory(ID,ItemID,Amount,Verbose) VALUES('Second',9,2,?)",
      );
      for (let i = 0; i < 20; i++) insert.run("X".repeat(4096));
    }
    expect(() =>
      c.connect.OnPacket(Received(packet(c.users)), c.target),
    ).toThrow();
    unchanged(c, pending, before);
  }
});

test("already-initialized native flag suppresses202/201 rather than preflighting unsent bodies; modern inventory reads still happen BEFORE handoff", () => {
  const c = setup(
    Array.from({ length: 20 }, (_, i) =>
      def({ SN: i, strAttr: "A".repeat(4096), strName: "B".repeat(4096) }),
    ),
  );
  c.s.db.exec(
    "INSERT INTO FxUserInventory(ID,ItemID,Amount,Verbose) VALUES('Second',9,2,'🎮')",
  );
  c.connect.OnPacket(Received(packet(c.users, true)), c.target);
  expect(c.target.packets.map((p) => p.m_nPacketType)).toEqual([210]);
  expect(c.users[0]!.m_bClientInitialized).toBe(true);
  expect(c.users[1]!.m_aInventory[0]!.Verbose).toBe("🎮");
});

test("successful catalog encoding is NOT transfer authorization: wrong guild/serial is still atomically rejected before publication", () => {
  const c = setup(),
    pending = c.users[0]!.m_pendingConnection,
    before = c.users.map((u) => u.GetDynamicInfoSnapshot()),
    p = new CSendPacket(7).Encode1(2);
  for (const [i, u] of c.users.entries())
    p.EncodeStr(u.GetName())
      .Encode4(u.GetGlobalSerialNo())
      .Encode4(i === 1 ? 99 : 0);
  p.Encode4(0).Encode4(OpaqueOfficial.FxClientIntegrityXor[0]!).Encode1(1);
  expect(() => c.connect.OnPacket(Received(p), c.target)).toThrow("transfer");
  unchanged(c, pending, before);
});

test("handshake uses a detached preflight generation if trusted rank-attachment callback reloads the catalog AFTER the group handoff; next connection gets the new generation", () => {
  const c = setup(),
    p = new CConnectPool(c.db, c.gs, c.items, c.sessions, 1, () => {
      c.s.db.exec("UPDATE FxItem SET strName='next generation'");
      c.items.UpdateUserItemTable();
    });
  p.OnPacket(Received(packet(c.users)), c.target);
  const catalog = c.target.Take(210);
  catalog.Decode1();
  catalog.AssertEnd();
  const old = c.target.Take(202);
  expect(old.Decode2()).toBe(1);
  old.Decode4();
  old.Decode1();
  old.DecodeStr();
  old.Decode4();
  old.Decode4();
  old.Decode4();
  expect(old.DecodeStr()).toBe("SYNTHETIC catalog only");
  old.AssertEnd();
  expect(c.items.GetUserItem(7)!.strName).toBe("next generation");
});

test("REAL TCP: double-local LS transfer survives a failed oversized202 GS attempt, then trusted reload+NEW TCP uses the SAME single-use token and receives nonempty native-named202 plus loaded201", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-catalog-wire-")),
    config = TestConfig();
  config.Runtime.Database = join(dir, "game.sqlite");
  const peers: WireClient[] = [],
    warnings: string[] = [],
    warn = console.warn;
  let app: CServerApp | undefined;
  const connect = (port: number) => {
    const p = new WireClient(port);
    peers.push(p);
    return p;
  };
  try {
    const pre = new CDBSession(config.Runtime.Database);
    try {
      seed(
        pre,
        Array.from({ length: 20 }, (_, i) =>
          def({ SN: i, strAttr: "A".repeat(4096), strName: "B".repeat(4096) }),
        ),
      );
    } finally {
      pre.Close();
    }
    app = new CServerApp(config);
    const db = new CDBMan(app.m_dbSession);
    for (const ID of ["Alice", "Partner"])
      await db.RegisterNewUser({
        ID,
        Password: "test-password",
        Gender: ID === "Alice" ? 1 : 0,
      });
    const stock = db.AddInventory(
      "Partner",
      0xfedcba98,
      2,
      0,
      "legacy inventory bridge, NOT native ItemSn",
    );
    await app.SetUp();
    const first = connect(app.m_loginServer.m_listenSocket.port);
    await greeting(first);
    const group = await login(first, ["Alice", "Partner"]),
      gsPort = await transfer(first),
      gs = app.m_gameServers[0]!,
      bad = connect(gsPort);
    await greeting(bad);
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    const request = new CSendPacket(7).Encode1(2);
    for (const u of group)
      request.EncodeStr(u.ID).Encode4(u.GlobalSerialNo).Encode4(u.GuildSn);
    request
      .Encode4(0)
      .Encode4(OpaqueOfficial.FxClientIntegrityXor[0]!)
      .Encode1(1);
    bad.Send(request);
    await expect(bad.Read()).rejects.toThrow("closed");
    const users = group.map(
      (u) => app!.m_center.m_globalUserTable.GetUser(u.GlobalSerialNo)!,
    );
    expect(users).toHaveLength(2);
    expect(
      users.every(
        (u) =>
          u.m_pendingConnection &&
          u.m_pLocalServer?.m_nServerType === ServerType.Login,
      ),
    ).toBe(true);
    expect(users[0]!.m_pClientSocket).toBe(users[1]!.m_pClientSocket);
    expect(users[0]!.m_pClientSocket!.GetUserCount()).toBe(2);
    expect(gs.m_channelPool.GetRankList()).toEqual([]);
    expect(users.map((u) => u.m_aInventory)).toEqual([[], []]);
    expect(
      warnings.some((w) => w.includes('"event":"client-packet-rejected"')),
    ).toBe(true);
    expect(warnings.join("\n")).not.toContain("AAAA");
    const rows = [
      def({ SN: 0, Category: 5, nAttr1: -2147483648 }),
      def({ SN: 0x80000000, Category: 255, strAttr: "", strName: "" }),
      def({ SN: 0xffffffff, Category: 6 }),
    ];
    app.m_dbSession.db.exec("DELETE FROM FxItem");
    seed(app.m_dbSession, rows);
    expect(gs.m_userItemMan.UpdateUserItemTable()).toBe(true);
    const good = connect(gsPort);
    await establish(good, group, [[], [stock]], rows);
    expect(
      users.every(
        (u) =>
          !u.m_pendingConnection &&
          u.m_pLocalServer?.m_nServerType === ServerType.FXGame &&
          u.m_pClientSocket?.GetUserCount() === 2,
      ),
    ).toBe(true);
    expect(gs.m_channelPool.GetRankList()).toHaveLength(2);
    expect(users[1]!.m_aInventory).toEqual([stock]);
    expect(app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(app.GetStatus().officialClientVerified).toBe(false);
  } finally {
    console.warn = warn;
    for (const p of peers) p.Close();
    await app?.CleanUp();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
