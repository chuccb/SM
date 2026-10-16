import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CServerApp } from "../CServerApp.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { ServerType } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { TestConfig } from "./helpers/Accounts.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { PreRow } from "./helpers/PreInventory.ts";
import { WireClient, Received } from "./helpers/Clients.ts";
import { greeting, login, transfer } from "./helpers/Network.ts";
import {
  HandoffRequest,
  SeedHandoffDefinitions,
} from "./helpers/InventoryHandoff.ts";
import {
  ResidentHandoffFixture,
  AttachResident,
  ResidentRows,
} from "./helpers/ResidentInventoryHandoff.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(modes: readonly number[] = [2, 2]) {
  const e = ResidentHandoffFixture(modes);
  cleanup.push(e.close);
  return e;
}
function unmoved(e: ReturnType<typeof create>) {
  expect(e.target.m_aUser).toEqual([]);
  expect(e.target.packets).toEqual([]);
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.source.IsConnected()).toBe(true);
  expect(
    e.users.every(
      (u) =>
        u.m_pendingConnection === e.pending && u.m_pClientSocket === e.source,
    ),
  ).toBe(true);
  expect(e.callbacks()).toBe(0);
  expect(e.pool.GetRankList()).toEqual([]);
}
function receipts(e: ReturnType<typeof create>) {
  return [
    "RuntimeGameResult",
    "RuntimeMoneyPickup",
    "RuntimeHouseClaim",
    "RuntimeSpecialItemUse",
  ].map(
    (t) =>
      e.session.db
        .query<{ n: number }, []>(`SELECT count(*) n FROM ${t}`)
        .get()!.n,
  );
}

test("BOTH native owners skip legacy storage despite colliding SQL SN/ItemID, and first sent packet observes exact preserved paired epochs/dirty/presentation/rank", () => {
  const e = create(),
    before = e.users.map((u) => u.CaptureUserInventoryInitialization()),
    dynamic = e.users.map((u) => u.GetDynamicInfoSnapshot()),
    stored = e.session.db.query("SELECT * FROM FxUserInventory").all();
  const changes = () =>
      e.session.db.query<{ n: number }, []>("SELECT total_changes() n").get()!
        .n,
    count = changes();
  e.db.LoadInventory = () => {
    throw new Error("native MUST NOT read legacy inventory");
  };
  const send = e.target.SendPacket.bind(e.target);
  let first = true;
  e.target.SendPacket = (packet) => {
    if (first) {
      first = false;
      expect(e.target.m_aUser).toEqual(e.users);
      expect(e.source.m_aUser).toEqual([]);
      expect(
        e.users.map((u) => u.CaptureUserInventoryInitialization()),
      ).toEqual(before);
      expect(e.pool.GetRankList()).toHaveLength(2);
    }
    send(packet);
  };
  e.run();
  expect(first).toBe(false);
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([
    210, 202, 207, 201,
  ]);
  expect(e.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(dynamic);
  expect(e.session.db.query("SELECT * FROM FxUserInventory").all()).toEqual(
    stored,
  );
  expect(changes()).toBe(count);
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("mixed local modes read ONLY the legacy local: native-empty never falls back, source native rowids/dates cannot be manufactured from matching SQLite products", () => {
  for (const modes of [
    [1, 0],
    [0, 2],
  ]) {
    const e = create(modes),
      load = e.db.LoadInventory.bind(e.db),
      calls: string[] = [];
    e.db.LoadInventory = (id) => {
      calls.push(id);
      return load(id);
    };
    e.run();
    expect(calls).toEqual(
      e.users.filter((_, i) => modes[i] === 0).map((u) => u.GetName()),
    );
    expect(e.users.map((u) => u.GetUserInventoryGeneration().Native)).toEqual(
      modes.map(Boolean),
    );
    for (const [i, mode] of modes.entries())
      if (mode) expect(e.users[i]!.GetUserInventory(100 + i)).toBeUndefined();
  }
});

test("SECOND native201 overflow cannot emit ANY210/202/207 or consume first local; trusted source repair uses SAME original pending without SQL fallback", () => {
  const e = create();
  AttachResident(
    e.users[1]!,
    Array.from({ length: 20 }, () =>
      NativeInventory({ Verbose: "X".repeat(4096) }),
    ),
    [PreRow()],
    1,
  );
  const before = e.users.map((u) => u.CaptureUserInventoryInitialization());
  e.db.LoadInventory = () => {
    throw new Error("no legacy fallback");
  };
  expect(() => e.run()).toThrow("too long");
  unmoved(e);
  expect(e.users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
    before,
  );
  AttachResident(
    e.users[1]!,
    [NativeInventory({ Verbose: "repaired owned" })],
    [PreRow()],
    1,
  );
  e.run();
  expect(e.target.m_aUser).toEqual(e.users);
  expect(e.users.every((u) => !u.m_pendingConnection)).toBe(true);
  expect(e.users[1]!.CaptureUserInventory()!.Rows[0]!.Verbose).toBe(
    "repaired owned",
  );
});

test("outgoing native row codepage failure is whole-group preflight, not a fallback to readable legacy SQL; trusted UTF8 data crosses Center with NO accidental Big5 coercion", () => {
  const e = create(),
    utf8 = new CTextCodec("utf8");
  e.users[1]!.InstallUserInventoryInitialization(
    [NativeInventory({ Verbose: "🎮" })],
    [PreRow()],
    {},
    utf8,
  );
  expect(() => e.run()).toThrow("representable");
  unmoved(e);
  Reflect.set(e.target, "text", utf8);
  e.run();
  expect(e.users[1]!.CaptureUserInventory()!.Rows[0]!.Verbose).toBe("🎮");
  expect(e.target.packets.at(-1)!.m_nPacketType).toBe(201);
});

test("native same-value reload INSIDE second candidate codec is caught before consumption; later same-pending request sees a new generation, not a financial retry", () => {
  const e = create(),
    encode = e.target.text.Encode.bind(e.target.text);
  let armed = true;
  e.target.text.Encode = (value) => {
    if (armed && value === "NATIVE owned1-0") {
      armed = false;
      const u = e.users[1]!,
        p = u.CaptureUserInventoryInitialization();
      u.InstallUserInventoryInitialization(p.Owned!.Rows, p.Pre.Rows);
    }
    return encode(value);
  };
  expect(() => e.run()).toThrow("changed");
  unmoved(e);
  e.target.text.Encode = encode;
  e.run();
  expect(e.target.m_aUser).toEqual(e.users);
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("one catalog snapshot binds202 and ALL207 even when native candidate codec reloads it BEFORE202; resident copied attrs/equipment are NOT rebased", () => {
  const e = create(),
    encode = e.target.text.Encode.bind(e.target.text),
    before = e.users.map((u) => u.CaptureUserInventoryInitialization());
  let armed = true;
  e.target.text.Encode = (value) => {
    if (armed && value === "NATIVE owned0-0") {
      armed = false;
      e.session.db.exec("UPDATE FxItem SET Category=6,nAttr1=999");
      e.items.UpdateUserItemTable();
    }
    return encode(value);
  };
  e.run();
  expect(armed).toBe(false);
  e.target.Take(210);
  const catalog = e.target.Take(202);
  expect(catalog.Decode2()).toBe(2);
  expect(catalog.Decode4()).toBe(7);
  expect(catalog.Decode1()).toBe(101);
  expect(e.items.GetUserItem(7)!.Category).toBe(6);
  expect(e.users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
    before,
  );
});

test("native DTO mode mismatch is refused BEFORE account or inventory reads, rather than selecting an unintended legacy/native data source", () => {
  const e = create(),
    capture = e.gs.CaptureAuthorizedInventory.bind(e.gs);
  e.gs.CaptureAuthorizedInventory = (socket, lease) =>
    capture(socket, lease).map((r, i) => (i ? { ...r, Owned: null } : r));
  e.db.GetUserInfo = () => {
    throw new Error("MUST NOT read mismatched-mode account");
  };
  expect(() => e.run()).toThrow("mode mismatch");
  unmoved(e);
});

test("already-initialized/no-pre native owners retain native rows/epochs but obey ORIGINAL210-only cache gate; native data alone does not invent201/ACK", () => {
  const e = create();
  for (const u of e.users) u.InstallPreInventory([]);
  const before = e.users.map((u) => u.CaptureUserInventoryInitialization());
  e.db.LoadInventory = () => {
    throw new Error("native no-pre still NO fallback");
  };
  e.run(true);
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([210]);
  expect(e.users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
    before,
  );
});

test("pending expiry DURING native codec cancels clock-invalid authority but preserves BOTH native owners and emits nothing", () => {
  const e = create(),
    encode = e.target.text.Encode.bind(e.target.text);
  let armed = true;
  e.target.text.Encode = (value) => {
    if (armed && value === "NATIVE owned1-0") {
      armed = false;
      e.tick(RuntimePolicy.SessionTransferTimeoutMs);
    }
    return encode(value);
  };
  expect(() => e.run()).toThrow();
  expect(e.target.packets).toEqual([]);
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.target.m_aUser).toEqual([]);
  expect(e.users.every((u) => !u.m_pendingConnection)).toBe(true);
});

test("source-close callback native/pre reload AFTER Center consumption blocks prebuilt bundle, but ownership is consumed with NO pretend rollback or replay", () => {
  const e = create(),
    close = e.source.Close.bind(e.source);
  let armed = true;
  e.source.Close = () => {
    close();
    if (armed) {
      armed = false;
      const u = e.users[1]!,
        p = u.CaptureUserInventoryInitialization();
      u.InstallUserInventoryInitialization(p.Owned!.Rows, p.Pre.Rows);
    }
  };
  expect(() => e.run()).toThrow("changed after handoff");
  expect(e.target.m_aUser).toEqual(e.users);
  expect(e.source.m_aUser).toEqual([]);
  expect(e.target.packets).toEqual([]);
  expect(e.callbacks()).toBe(0);
  expect(
    e.users.every(
      (u) => !u.m_pendingConnection && u.m_pClientSocket === e.target,
    ),
  ).toBe(true);
  expect(() => e.run()).toThrow("count");
});

test("rank callback native mutation AFTER consumption is rechecked BEFORE first outgoing byte; already-consumed users never become retriable just because no201 was sent", () => {
  const e = create();
  Reflect.set(e.connect, "onUsersAttached", () => {
    AttachResident(
      e.users[1]!,
      [NativeInventory({ Amount: 99 })],
      [PreRow()],
      1,
    );
  });
  expect(() => e.run()).toThrow("changed after handoff");
  expect(e.target.packets).toEqual([]);
  expect(e.target.m_aUser).toEqual(e.users);
  expect(e.source.m_aUser).toEqual([]);
  expect(() => e.run()).toThrow("count");
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("native201 transport failure preserves already-sent210202207 and consumed native owners; no SQL stock decrement, pre clearing, epoch bump or replay", () => {
  const e = create(),
    before = e.users.map((u) => u.CaptureUserInventoryInitialization()),
    send = e.target.SendPacket.bind(e.target);
  e.target.SendPacket = (packet) => {
    if (packet.m_nPacketType === 201)
      throw new Error("native201 transport failure");
    send(packet);
  };
  expect(() => e.run()).toThrow("native201 transport failure");
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([210, 202, 207]);
  expect(e.users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
    before,
  );
  expect(e.target.m_aUser).toEqual(e.users);
  expect(() => e.run()).toThrow("count");
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("native handoff then ACTUAL209 returns the SAME approved nonempty201 image, with no silent downgrade or native/legacy key/date alias", async () => {
  const e = create();
  e.run();
  const expected = e.target.packets.at(-1)!.m_pBlock;
  e.target.Clear();
  await e.pool.OnPacket(Received(new CSendPacket(209)), e.target);
  expect(e.target.Take(201).m_pBlock).toEqual(expected);
  expect(e.target.packets).toEqual([]);
  expect(e.users.every((u) => u.GetUserInventoryGeneration().Native)).toBe(
    true,
  );
});

test("explicit legacy local with NONZERO abandoned-native epoch reloads ONLY legacy SQLite while its native-empty partner keeps the original paired generations", () => {
  const e = create([1, 2]);
  e.users[1]!.m_aInventory = [];
  const before = e.users.map((u) => u.CaptureUserInventoryInitialization()),
    load = e.db.LoadInventory.bind(e.db),
    reads: string[] = [];
  expect(before[1]!.OwnedGeneration).toEqual({ Native: false, Revision: 2 });
  e.db.LoadInventory = (id) => {
    reads.push(id);
    return load(id);
  };
  e.run();
  expect(reads).toEqual([e.users[1]!.GetName()]);
  expect(e.users[1]!.m_aInventory[0]!.SN).toBe(101);
  expect(e.users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
    before,
  );
  expect(e.target.m_aUser).toEqual(e.users);
});

test("resident-only PRESENTATION drift without either row epoch changing is caught after rank, BEFORE210; consumed ownership cannot be used as a money or transfer replay", () => {
  const e = create(),
    before = e.users.map((u) => u.GetUserInventoryGeneration()),
    pre = e.users.map((u) => u.GetPreInventoryGeneration());
  Reflect.set(e.connect, "onUsersAttached", () =>
    e.users[1]!.SetLevelIcon(0, -12345),
  );
  expect(() => e.run()).toThrow("changed after handoff");
  expect(e.users.map((u) => u.GetUserInventoryGeneration())).toEqual(before);
  expect(e.users.map((u) => u.GetPreInventoryGeneration())).toEqual(pre);
  expect(e.target.packets).toEqual([]);
  expect(e.target.m_aUser).toEqual(e.users);
  expect(e.users.every((u) => !u.m_pendingConnection)).toBe(true);
  expect(receipts(e)).toEqual([0, 0, 0, 0]);
});

test("legitimate source disconnect AFTER paired capture retains native modes and same original pending; account read may detach LS but must not free or downgrade the new GS owners", () => {
  const e = create(),
    get = e.db.GetUserInfo.bind(e.db),
    before = e.users.map((u) => u.CaptureUserInventoryInitialization());
  let armed = true;
  e.db.GetUserInfo = (id) => {
    if (armed) {
      armed = false;
      e.source.Close();
      e.ls.UnregisterConnection(e.source);
    }
    return get(id);
  };
  e.db.LoadInventory = () => {
    throw new Error("closed native source still NO legacy fallback");
  };
  e.run();
  expect(e.target.m_aUser).toEqual(e.users);
  expect(e.users.map((u) => u.IsSetFree())).toEqual([0, 0]);
  expect(e.users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
    before,
  );
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([
    210, 202, 207, 201,
  ]);
});

test("REAL TCP: oversized SECOND native201 leaves original two-local pending; trusted repair/new TCP publishes NONEMPTY210202207201 and209 repeats exact201 without SQL grant/fallback", async () => {
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
      ),
      pending = users[0]!.m_pendingConnection!;
    users[0]!.InstallUserInventoryInitialization(ResidentRows(0), []);
    users[1]!.InstallUserInventoryInitialization(
      Array.from({ length: 20 }, () =>
        NativeInventory({ Verbose: "X".repeat(4096) }),
      ),
      [PreRow()],
    );
    // Colliding legacy source exists but must remain unread/unchanged for native.
    db.AddInventory("Alice", 7, 99, 0, "LEGACY must not replace native");
    const changes = () =>
        app.m_dbSession.db
          .query<{ n: number }, []>("SELECT total_changes() n")
          .get()!.n,
      before = changes();
    console.warn = () => {};
    const bad = connect(port);
    await greeting(bad);
    bad.Send(HandoffRequest(group));
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
    expect(changes()).toBe(before);
    users[1]!.InstallUserInventoryInitialization(ResidentRows(1), [PreRow()]);
    const pair = users.map((u) => u.CaptureUserInventoryInitialization()),
      expected = new CSendPacket(201).Encode1(2);
    users.forEach((u) => u.MakeUserInventoryPacket(expected));
    const good = connect(port);
    await greeting(good);
    good.Send(HandoffRequest(group));
    expect((await good.Read()).Decode1()).toBe(210);
    expect((await good.Read()).Decode1()).toBe(202);
    expect((await good.Read()).Decode1()).toBe(207);
    const inventory = await good.Read();
    expect(inventory.Decode1()).toBe(201);
    expect(inventory.m_pBlock).toEqual(expected.GetBuffer());
    expect(users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
      pair,
    );
    expect(
      users.every(
        (u) =>
          !u.m_pendingConnection &&
          u.m_pLocalServer?.GetServerType() === ServerType.FXGame,
      ),
    ).toBe(true);
    good.Send(new CSendPacket(209));
    expect((await good.Read()).m_pBlock).toEqual(expected.GetBuffer());
    expect(changes()).toBe(before);
    expect(gs.m_channelPool.GetRankList()).toHaveLength(2);
    for (const table of [
      "RuntimeGameResult",
      "RuntimeMoneyPickup",
      "RuntimeHouseClaim",
      "RuntimeSpecialItemUse",
    ])
      expect(
        app.m_dbSession.db.query(`SELECT count(*) n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
    expect(app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(app.GetStatus().officialClientVerified).toBe(false);
  } finally {
    console.warn = warn;
    for (const p of peers) p.Close();
    await app.CleanUp();
  }
}, 15000);
