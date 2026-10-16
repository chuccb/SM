import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { CUserItemMan } from "../FXGS/CUserItemMan.ts";
import { CConnectPool } from "../FXGS/CConnectPool.ts";
import { CServerApp } from "../CServerApp.ts";
import { OpaqueOfficial, ServerType } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import type { ConnectionIdentity } from "../Center/ConnectionAuthorization.ts";
import type { _USERINFO, _USERINVENTORY } from "../Common/DB/Rows.ts";
import { ChannelFixture } from "./helpers/Channel.ts";
import { MemoryClient, Received, WireClient } from "./helpers/Clients.ts";
import { TestConfig, UserInfo } from "./helpers/Accounts.ts";
import { greeting, login, transfer, establish } from "./helpers/Network.ts";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function peer(ip?: string) {
  const p = new MemoryClient(ip);
  cleanup.push(() => p.Close());
  return p;
}
function request(ids: readonly ConnectionIdentity[], initialized = false) {
  const p = new CSendPacket(7).Encode1(ids.length);
  for (const id of ids)
    p.EncodeStr(id.ID).Encode4(id.GlobalSerialNo).Encode4(id.GuildSn);
  return p
    .Encode4(0)
    .Encode4(OpaqueOfficial.FxClientIntegrityXor[0]!)
    .Encode1(initialized ? 0 : 1);
}
function setup() {
  let now = Date.now();
  const c = ChannelFixture(() => now),
    session = new CDBSession(":memory:"),
    db = new CDBMan(session),
    source = peer(),
    target = peer();
  cleanup.push(() => session.Close());
  for (const [i, id] of ["First", "Second"].entries()) {
    session.db
      .query(
        "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES(?,0,'fixture')",
      )
      .run(id);
    session.db
      .query("INSERT INTO FxUserDynamic(ID,Money) VALUES(?,?)")
      .run(id, 37 + i);
  }
  session.db.exec(
    "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES(7,2,'attribute',1,2,3,'catalog sentinel')",
  );
  const rows = [
      db.AddInventory("First", 7, 3, 0, "inventory first"),
      db.AddInventory("Second", 7, 4, 0, "inventory second"),
    ],
    items = new CUserItemMan(db),
    users = c.ls.RegisterConnection(source, [
      db.GetUserInfo("First")!,
      db.GetUserInfo("Second")!,
    ]),
    ids = users.map((u) => ({
      ID: u.GetName(),
      GlobalSerialNo: u.GetGlobalSerialNo(),
      GuildSn: u.m_userInfo.GuildSn,
    }));
  c.pool.AddNewSocket(target);
  expect(c.ls.RequestConnection(source, ServerType.FXGame, 0).result).toBe(1);
  const pending = users[0]!.m_pendingConnection!,
    connect = new CConnectPool(db, c.gs, items, c.sessions, 1, (s) =>
      c.pool.InsertRankList(s),
    );
  return {
    ...c,
    session,
    db,
    items,
    source,
    target,
    users,
    ids,
    rows,
    pending,
    connect,
    tick: (ms: number) => {
      now += ms;
    },
    run: (custom = ids, initialized = false, to = target) =>
      connect.OnPacket(Received(request(custom, initialized)), to),
  };
}
function unmoved(c: ReturnType<typeof setup>) {
  expect(c.target.m_aUser).toEqual([]);
  expect(c.source.m_aUser).toEqual(c.users);
  expect(
    c.users.every(
      (u) =>
        u.m_pClientSocket === c.source && u.m_pendingConnection === c.pending,
    ),
  ).toBe(true);
  expect(c.pool.GetRankList()).toEqual([]);
  expect(c.target.packets).toEqual([]);
}
function spyReads(c: ReturnType<typeof setup>) {
  const counts = { Info: 0, Inventory: 0 },
    info = c.db.GetUserInfo.bind(c.db),
    inventory = c.db.LoadInventory.bind(c.db);
  c.db.GetUserInfo = (id) => {
    counts.Info++;
    return info(id);
  };
  c.db.LoadInventory = (id) => {
    counts.Inventory++;
    return inventory(id);
  };
  return counts;
}

test("actual GS rejects forged guild/serial/name/order/count/IP before ANY account/inventory read or catalog encoding", () => {
  const c = setup(),
    counts = spyReads(c),
    encode = c.target.text.Encode.bind(c.target.text);
  let encodes = 0;
  c.target.text.Encode = (s) => {
    encodes++;
    return encode(s);
  };
  const cases = [
    c.ids.map((id, i) => ({ ...id, GuildSn: i === 1 ? 1 : id.GuildSn })),
    c.ids.map((id, i) => ({
      ...id,
      GlobalSerialNo: i === 1 ? 0 : id.GlobalSerialNo,
    })),
    c.ids.map((id, i) => ({ ...id, ID: i === 1 ? "NotKnown" : id.ID })),
    [...c.ids].reverse(),
    c.ids.slice(0, 1),
  ];
  for (const ids of cases) {
    expect(() => c.run(ids)).toThrow();
    unmoved(c);
  }
  expect(() => c.run(c.ids, false, peer("127.0.0.2"))).toThrow();
  expect(counts).toEqual({ Info: 0, Inventory: 0 });
  expect(encodes).toBe(0);
  c.run();
  expect(counts).toEqual({ Info: 2, Inventory: 2 });
  expect(c.target.packets.map((p) => p.m_nPacketType)).toEqual([210, 202, 201]);
});

test("DB read failure releases preparation only and permits SAME pending/target retry, with no 210/202 or first-user attachment", () => {
  const c = setup(),
    load = c.db.LoadInventory.bind(c.db);
  c.db.LoadInventory = (id) => {
    if (id === "Second") throw Error("injected read failure");
    return load(id);
  };
  expect(() => c.run()).toThrow("read failure");
  unmoved(c);
  expect(c.center.GetConnNo(c.gs.server, true)).toBe(2);
  c.db.LoadInventory = load;
  c.run();
  expect(
    c.users.every(
      (u) => u.m_pClientSocket === c.target && !u.m_pendingConnection,
    ),
  ).toBe(true);
  expect(c.target.packets.map((p) => p.m_nPacketType)).toEqual([210, 202, 201]);
});

test("catalog encoding exception likewise releases exclusive lease, but never renews pending TTL or resets source state", () => {
  const c = setup(),
    put = c.items.PutUserItemList.bind(c.items),
    before = c.users.map((u) => u.GetDynamicInfoSnapshot());
  c.items.PutUserItemList = () => {
    throw Error("catalog encoding failed");
  };
  expect(() => c.run()).toThrow("catalog encoding failed");
  unmoved(c);
  expect(c.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
  c.tick(7);
  c.items.PutUserItemList = put;
  expect(c.users[0]!.m_pendingConnection!.expires).toBe(c.pending.expires);
  c.run();
  expect(c.target.m_aUser).toEqual(c.users);
});

test("unavailable/banned account is checked AFTER authorization but BEFORE inventory and leaves transfer unconsumed/retryable", () => {
  for (const missing of [false, true]) {
    const c = setup(),
      read = c.db.GetUserInfo.bind(c.db),
      counts = spyReads(c);
    c.db.GetUserInfo = (id) =>
      id === "Second"
        ? missing
          ? undefined
          : { ...read(id)!, BannedUntil: -1 }
        : read(id);
    expect(() => c.run()).toThrow("Account not available");
    expect(counts.Inventory).toBe(0);
    unmoved(c);
    c.db.GetUserInfo = read;
    c.run();
    expect(c.target.GetUserCount()).toBe(2);
  }
});

test("live source state drift in FIRST reader aborts before SECOND reader, never overwrites the changed source value with stale loaded data", () => {
  const c = setup(),
    read = c.db.GetUserInfo.bind(c.db);
  let reads = 0;
  c.db.GetUserInfo = (id) => {
    reads++;
    const result = read(id);
    c.users[1]!.IncDecMoney(10);
    return result;
  };
  expect(() => c.run()).toThrow("source changed");
  expect(reads).toBe(1);
  unmoved(c);
  expect(c.users[1]!.m_userInfo.Money).toBe(48);
  expect(c.users[0]!.m_userInfo.Money).toBe(37);
});

test("expiry in a read callback is checked BEFORE encoding or commit; live source may request a genuinely new pending after expiry", () => {
  const c = setup(),
    read = c.db.LoadInventory.bind(c.db);
  c.db.LoadInventory = (id) => {
    const result = read(id);
    if (id === "Second") c.tick(RuntimePolicy.SessionTransferTimeoutMs);
    return result;
  };
  expect(() => c.run()).toThrow();
  expect(
    c.users.every(
      (u) => !u.m_pendingConnection && u.m_pClientSocket === c.source,
    ),
  ).toBe(true);
  expect(c.target.packets).toEqual([]);
  expect(c.source.IsConnected()).toBe(true);
  c.db.LoadInventory = read;
  expect(c.ls.RequestConnection(c.source, ServerType.FXGame, 0).result).toBe(1);
  expect(c.users[0]!.m_pendingConnection).not.toBe(c.pending);
  c.run();
  expect(c.target.GetUserCount()).toBe(2);
});

test("competing old one-step confirmation inside202 cannot steal the held pending; reentrant same-target OnPacket is refused before DB", () => {
  const c = setup(),
    put = c.items.PutUserItemList.bind(c.items),
    counts = spyReads(c),
    other = peer();
  let blocked = 0;
  c.items.PutUserItemList = (p) => {
    expect(() => c.gs.ConfirmConnection(other, c.ids)).toThrow("active");
    blocked++;
    expect(() => c.run()).toThrow("active");
    blocked++;
    expect(counts).toEqual({ Info: 2, Inventory: 2 });
    put(p);
  };
  c.run();
  expect(blocked).toBe(2);
  expect(other.m_aUser).toEqual([]);
  expect(c.target.m_aUser).toEqual(c.users);
  expect(c.users.every((u) => u.m_pClientSocket === c.target)).toBe(true);
});

test("whole-group post-codec guard catches a FIRST user's change while SECOND201 encodes, with no partial target publication or refund fiction", () => {
  const c = setup(),
    encode = c.target.text.Encode.bind(c.target.text);
  let armed = true;
  c.target.text.Encode = (s) => {
    if (armed && s === "inventory second") {
      armed = false;
      c.users[0]!.IncDecMoney(1);
    }
    return encode(s);
  };
  expect(() => c.run()).toThrow("source changed");
  unmoved(c);
  expect(c.users[0]!.m_userInfo.Money).toBe(38);
  expect(c.users[1]!.m_userInfo.Money).toBe(38);
});

test("captured DB account and inventory values cannot be swapped by later codec callbacks; published live copies remain mutable and do not alias adapter rows", () => {
  const c = setup(),
    readInfo = c.db.GetUserInfo.bind(c.db),
    readInventory = c.db.LoadInventory.bind(c.db),
    infos: _USERINFO[] = [],
    inventories: _USERINVENTORY[][] = [],
    encode = c.target.text.Encode.bind(c.target.text);
  c.db.GetUserInfo = (id) => {
    const raw = readInfo(id)!;
    infos.push(raw);
    return raw;
  };
  c.db.LoadInventory = (id) => {
    const raw = readInventory(id);
    inventories.push(raw);
    return raw;
  };
  let armed = true;
  c.target.text.Encode = (s) => {
    if (armed && s === "inventory second") {
      armed = false;
      infos[0]!.ID = "Swapped";
      infos[0]!.Money = 999;
      inventories[0]![0]!.Amount = 999;
      inventories[0]![0]!.Verbose = "swapped body";
      inventories[1]![0]!.Amount = 888;
    }
    return encode(s);
  };
  c.run();
  expect(c.users.map((u) => [u.GetName(), u.m_userInfo.Money])).toEqual([
    ["First", 37],
    ["Second", 38],
  ]);
  expect(c.users.map((u) => u.m_aInventory[0]!.Amount)).toEqual([3, 4]);
  expect(c.users[0]!.m_aInventory[0]!.Verbose).toBe("inventory first");
  expect(c.users[0]!.m_aInventory[0]).not.toBe(inventories[0]![0]);
  expect(c.users[0]!.m_userInfo).not.toBe(infos[0]);
  const p = c.target.packets.find((p) => p.m_nPacketType === 201)!;
  expect([p.Decode1(), p.Decode1()]).toEqual([201, 2]);
  for (const [i, row] of c.rows.entries()) {
    expect(p.Decode4()).toBe(1);
    expect(p.Decode4()).toBe(row.SN);
    expect(p.Decode1()).toBe(row.Slot);
    expect(p.Decode4()).toBe(i + 3);
    expect(p.DecodeStr()).toBe(
      i === 0 ? "inventory first" : "inventory second",
    );
    p.DecodeBuffer(8);
  }
  p.AssertEnd();
  c.users[0]!.IncDecMoney(1);
  c.users[0]!.ConsumeUserInventory(c.rows[0]!.SN, 1);
  expect([
    c.users[0]!.m_userInfo.Money,
    c.users[0]!.m_aInventory[0]!.Amount,
  ]).toEqual([38, 2]);
});

test("source TCP disconnect/detach during reader is legitimate and can finish via existing authenticated pending, with no false SetFree of target users", () => {
  const c = setup(),
    read = c.db.GetUserInfo.bind(c.db);
  let once = true;
  c.db.GetUserInfo = (id) => {
    if (once) {
      once = false;
      c.source.Close();
      c.ls.UnregisterConnection(c.source);
    }
    return read(id);
  };
  c.run();
  expect(c.target.m_aUser).toEqual(c.users);
  expect(c.users.map((u) => u.IsSetFree())).toEqual([0, 0]);
  expect(
    c.users.every(
      (u) => u.m_pClientSocket === c.target && !u.m_pendingConnection,
    ),
  ).toBe(true);
});

test("destination close or source/target service restart during encoding invalidates lease instead of treating the same fields as new authority", () => {
  for (const kind of ["destination", "source-service", "target-service"]) {
    const c = setup(),
      put = c.items.PutUserItemList.bind(c.items);
    c.items.PutUserItemList = (p) => {
      put(p);
      if (kind === "destination") {
        c.target.Close();
        c.gs.UnregisterConnection(c.target);
      } else {
        const server = kind === "source-service" ? c.ls.server : c.gs.server;
        server.m_bConnected = false;
        server.m_bConnected = true;
      }
    };
    expect(() => c.run()).toThrow();
    unmoved(c);
    expect(c.users.map((u) => u.IsSetFree())).toEqual([0, 0]);
  }
});

test("initialized request still authenticates before reads, performs no unnecessary catalog/201 encoding and consumes the lease only once", () => {
  const c = setup(),
    counts = spyReads(c);
  c.items.PutUserItemList = () => {
    throw Error("unrequested202 must not encode");
  };
  const encode = c.target.text.Encode.bind(c.target.text);
  c.target.text.Encode = (s) => {
    if (s.startsWith("inventory"))
      throw Error("unrequested201 must not encode");
    return encode(s);
  };
  c.run(c.ids, true);
  expect(counts).toEqual({ Info: 2, Inventory: 2 });
  expect(c.target.packets.map((p) => p.m_nPacketType)).toEqual([210]);
  expect(c.users[0]!.m_bClientInitialized).toBe(true);
  expect(() => c.run(c.ids, true, peer())).toThrow("transfer");
  expect(counts).toEqual({ Info: 2, Inventory: 2 });
});

test("post-consumption rank/transport callback failures are NOT rolled back or replayed as a fresh authorization", () => {
  const c = setup(),
    broken = new CConnectPool(c.db, c.gs, c.items, c.sessions, 1, () => {
      throw Error("post-commit rank failure");
    });
  expect(() => broken.OnPacket(Received(request(c.ids)), c.target)).toThrow(
    "post-commit",
  );
  expect(
    c.users.every(
      (u) => u.m_pClientSocket === c.target && !u.m_pendingConnection,
    ),
  ).toBe(true);
  expect(c.source.GetUserCount()).toBe(0);
  expect(c.target.GetUserCount()).toBe(2);
  expect(c.target.packets).toEqual([]);
  expect(() => c.run(c.ids, false, peer())).toThrow("transfer");
});

test("REAL TCP: forged GS establishment causes zero DB reads and preserves original LS/pending, then a NEW valid TCP consumes once and receives exact legacy210202201", async () => {
  const config = TestConfig(),
    app = new CServerApp(config),
    peers: WireClient[] = [],
    warn = console.warn,
    warnings: string[] = [];
  const connect = (port: number) => {
    const p = new WireClient(port);
    peers.push(p);
    return p;
  };
  try {
    const db = new CDBMan(app.m_dbSession);
    for (const ID of ["Alice", "Partner"])
      await db.RegisterNewUser({
        ID,
        Password: "test-password",
        Gender: ID === "Alice" ? 1 : 0,
      });
    await app.SetUp();
    const source = connect(app.m_loginServer.m_listenSocket.port);
    await greeting(source);
    const ids = await login(source, ["Alice", "Partner"]),
      port = await transfer(source),
      game = app.m_gameServers[0]!,
      gsDB = game.m_userItemMan.db as CDBMan,
      get = gsDB.GetUserInfo.bind(gsDB),
      load = gsDB.LoadInventory.bind(gsDB);
    let reads = 0,
      loads = 0;
    gsDB.GetUserInfo = (id) => {
      reads++;
      return get(id);
    };
    gsDB.LoadInventory = (id) => {
      loads++;
      return load(id);
    };
    const users = ids.map(
        (id) => app.m_center.m_globalUserTable.GetUser(id.GlobalSerialNo)!,
      ),
      pending = users[0]!.m_pendingConnection,
      bad = connect(port);
    await greeting(bad);
    console.warn = (...a: unknown[]) => {
      warnings.push(a.join(" "));
    };
    bad.Send(
      request(
        ids.map((id, i) => ({ ...id, GuildSn: i === 1 ? 1 : id.GuildSn })),
      ),
    );
    await expect(bad.Read()).rejects.toThrow("closed");
    expect([reads, loads]).toEqual([0, 0]);
    expect(
      users.every(
        (u) =>
          u.m_pendingConnection === pending &&
          u.m_pClientSocket?.GetUserCount() === 2,
      ),
    ).toBe(true);
    expect(game.m_channelPool.GetRankList()).toEqual([]);
    expect(warnings.some((w) => w.includes("client-packet-rejected"))).toBe(
      true,
    );
    expect(warnings.join(" ")).not.toContain("Partner");
    const good = connect(port);
    await establish(good, ids);
    expect([reads, loads]).toEqual([2, 2]);
    expect(
      users.every(
        (u) =>
          !u.m_pendingConnection && u.m_pClientSocket?.GetUserCount() === 2,
      ),
    ).toBe(true);
    expect(
      users.every(
        (u) =>
          !u.m_pendingConnection &&
          u.m_pLocalServer?.GetServerType() === ServerType.FXGame,
      ),
    ).toBe(true);
    expect(game.m_channelPool.GetRankList()).toHaveLength(2);
    expect(app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(app.GetStatus().officialClientVerified).toBe(false);
  } finally {
    console.warn = warn;
    for (const p of peers) p.Close();
    await app.CleanUp();
  }
}, 15000);

test("actual maintenance callback isolates bad-clock failure, cancels outstanding authority and reports diagnostics rather than uncaught process exit (explicit callback, not timer timing oracle)", async () => {
  const app = new CServerApp(TestConfig()),
    source = peer(),
    target = peer(),
    warn = console.warn,
    messages: string[] = [];
  const originalClock = app.m_center.clock;
  try {
    await app.SetUp();
    const ls = app.m_center.m_localServerMan.GetSvr(ServerType.Login, 0)!,
      gs = app.m_center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!,
      users = app.m_center.OnAddNewUser(source, ls, [UserInfo("ClockOwner")]);
    expect(
      app.m_center.OnReqConnectToSvr(source, ServerType.FXGame, 0).result,
    ).toBe(1);
    const lease = app.m_center.AuthorizeConnection(
      target,
      gs,
      users.map((u) => ({
        ID: u.GetName(),
        GlobalSerialNo: u.GetGlobalSerialNo(),
        GuildSn: u.m_userInfo.GuildSn,
      })),
    );
    Object.defineProperty(app.m_center, "clock", { value: () => NaN });
    console.warn = (...a: unknown[]) => {
      messages.push(a.join(" "));
    };
    expect(() =>
      (app as unknown as { MaintainCenter(): void }).MaintainCenter(),
    ).not.toThrow();
    expect(app.GetStatus().centerMaintenanceFailures).toBe(1);
    expect(messages).toEqual(['{"event":"center-maintenance-rejected"}']);
    expect(
      users.every(
        (u) =>
          !u.m_pendingConnection &&
          u.m_pClientSocket === source &&
          u.IsSetFree() === 0,
      ),
    ).toBe(true);
    expect(source.m_aUser).toEqual(users);
    expect(target.m_aUser).toEqual([]);
    expect(() =>
      app.m_center.ConfirmAuthorizedConnection(target, gs, lease),
    ).toThrow("Stale");
  } finally {
    console.warn = warn;
    Object.defineProperty(app.m_center, "clock", { value: originalClock });
    await app.CleanUp();
  }
});

test("loaded account/inventory must rebind to the authorized ID, not a different row accidentally returned by a trusted adapter; rejection leaves original pending retriable", () => {
  for (const phase of ["account", "inventory"]) {
    const c = setup(),
      info = c.db.GetUserInfo.bind(c.db),
      inventory = c.db.LoadInventory.bind(c.db);
    if (phase === "account")
      c.db.GetUserInfo = (id) => ({ ...info(id)!, ID: "Unrelated" });
    else
      c.db.LoadInventory = (id) =>
        inventory(id).map((r) => ({ ...r, ID: "Unrelated" }));
    expect(() => c.run()).toThrow(
      phase === "account" ? "Account not available" : "owner mismatch",
    );
    unmoved(c);
    c.db.GetUserInfo = info;
    c.db.LoadInventory = inventory;
    c.run();
    expect(c.target.m_aUser).toEqual(c.users);
    expect(c.users.map((u) => u.GetName())).toEqual(["First", "Second"]);
  }
});
