import { afterEach, expect, test } from "bun:test";
import { CCenterServer } from "../Center/CCenterServer.ts";
import { CCenterProcess } from "../Common/CCenterProcess.ts";
import { CLocalServer } from "../Center/CLocalServer.ts";
import {
  CaptureConnectionIdentities,
  type ConnectionAuthorization,
  type ConnectionIdentity,
} from "../Center/ConnectionAuthorization.ts";
import { ServerType } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { MemoryClient } from "./helpers/Clients.ts";
import { UserInfo, TestConfig } from "./helpers/Accounts.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
const sockets: MemoryClient[] = [];
afterEach(() => {
  for (const p of sockets.splice(0).reverse()) p.Close();
});
function peer(ip?: string) {
  const p = new MemoryClient(ip);
  sockets.push(p);
  return p;
}
function setup(n = 2) {
  const config = TestConfig();
  let time = 1800000000000,
    clockHook: (() => void) | undefined,
    reads = 0;
  const center = new CCenterServer(config, () => {
    reads++;
    clockHook?.();
    return time;
  });
  for (const s of center.m_localServerMan.m_aLocalServer) s.m_bConnected = true;
  const ls = new CCenterProcess(
      center,
      center.m_localServerMan.GetSvr(ServerType.Login, 0)!,
    ),
    gs = new CCenterProcess(
      center,
      center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!,
    ),
    source = peer(),
    target = peer();
  const users = ls.RegisterConnection(
      source,
      Array.from({ length: n }, (_, i) =>
        UserInfo(`User${i}`, { Money: 37 + i, GuildSn: i + 7 }),
      ),
    ),
    ids = users.map((u) => ({
      ID: u.GetName(),
      GlobalSerialNo: u.GetGlobalSerialNo(),
      GuildSn: u.m_userInfo.GuildSn,
    }));
  expect(ls.RequestConnection(source, ServerType.FXGame, 0).result).toBe(1);
  return {
    center,
    ls,
    gs,
    source,
    target,
    users,
    ids,
    pending: users[0]!.m_pendingConnection!,
    tick: (n: number) => {
      time += n;
    },
    setTime: (n: number) => {
      time = n;
    },
    time: () => time,
    clockHook: (h: (() => void) | undefined) => {
      clockHook = h;
    },
    reads: () => reads,
    authorize: () => gs.AuthorizeConnection(target, ids),
  };
}
function unmoved(c: ReturnType<typeof setup>) {
  expect(c.source.m_aUser).toEqual(c.users);
  expect(c.target.m_aUser).toEqual([]);
  expect(
    c.users.every(
      (u) =>
        u.m_pClientSocket === c.source && u.m_pendingConnection === c.pending,
    ),
  ).toBe(true);
}

test("non-consuming lease preserves exact owners/reservation/deadline; explicit commit transfers whole group once before source-close callback", () => {
  const c = setup(),
    lease = c.authorize(),
    before = c.users.map((u) => u.GetDynamicInfoSnapshot());
  expect(Object.isFrozen(lease)).toBe(true);
  expect(lease.UserCount).toBe(2);
  expect(lease.Expires).toBe(c.pending.expires);
  expect(Object.keys(lease)).toEqual(["UserCount", "Expires"]);
  unmoved(c);
  expect(c.center.GetConnNo(c.gs.server, true)).toBe(2);
  expect(c.center.GetConnNo(c.gs.server)).toBe(0);
  c.gs.CheckConnectionAuthorization(c.target, lease);
  let closed = 0;
  c.source.Close = () => {
    closed++;
    expect(
      c.users.every(
        (u) => u.m_pClientSocket === c.target && !u.m_pendingConnection,
      ),
    ).toBe(true);
    expect(c.target.m_aUser).toEqual(c.users);
    expect(c.source.m_aUser).toEqual([]);
    MemoryClient.prototype.Close.call(c.source);
  };
  expect(c.gs.ConfirmAuthorizedConnection(c.target, lease)).toEqual(c.users);
  expect(closed).toBe(1);
  expect(c.center.GetConnNo(c.gs.server, true)).toBe(2);
  expect(c.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
  expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow(
    "Stale",
  );
  expect(c.gs.ReleaseConnectionAuthorization(c.target, lease)).toBe(false);
  expect(c.target.packets).toEqual([]);
});

test("release is idempotent, does not consume or renew pending, and allows a different target to retry the same authenticated transfer", () => {
  const c = setup(),
    lease = c.authorize();
  c.tick(99);
  expect(c.gs.ReleaseConnectionAuthorization(c.target, lease)).toBe(true);
  expect(c.gs.ReleaseConnectionAuthorization(c.target, lease)).toBe(false);
  expect(() => c.gs.CheckConnectionAuthorization(c.target, lease)).toThrow(
    "Stale",
  );
  unmoved(c);
  const other = peer(),
    next = c.gs.AuthorizeConnection(other, c.ids);
  expect(next.Expires).toBe(lease.Expires);
  expect(next).not.toBe(lease);
  expect(c.gs.ConfirmAuthorizedConnection(other, next)).toEqual(c.users);
});

test("exclusive per-pending/per-destination preparation blocks competing old confirm and same-socket reentry, without consuming either attempt", () => {
  const c = setup(),
    lease = c.authorize(),
    other = peer();
  expect(() => c.gs.AuthorizeConnection(c.target, c.ids)).toThrow("active");
  expect(() => c.gs.AuthorizeConnection(other, c.ids)).toThrow("active");
  expect(() => c.gs.ConfirmConnection(other, c.ids)).toThrow("active");
  unmoved(c);
  c.gs.CheckConnectionAuthorization(c.target, lease);
  expect(c.gs.ConfirmAuthorizedConnection(c.target, lease)).toEqual(c.users);
});

test("opaque leases are bound to issuer Center/server/socket; clone, JSON, foreign facade and forged shapes cannot check/commit/release them", () => {
  const c = setup(),
    d = setup(),
    lease = c.authorize(),
    other = peer(),
    reads = c.reads();
  for (const forged of [
    { ...lease },
    JSON.parse(JSON.stringify(lease)),
    {},
    null,
    undefined,
    1,
  ])
    for (const method of [
      c.gs.CheckConnectionAuthorization,
      c.gs.ConfirmAuthorizedConnection,
      c.gs.ReleaseConnectionAuthorization,
    ])
      expect(() =>
        method.call(c.gs, c.target, forged as ConnectionAuthorization),
      ).toThrow("Forged");
  expect(() => c.gs.ConfirmAuthorizedConnection(other, lease)).toThrow(
    "foreign",
  );
  expect(() => c.ls.ConfirmAuthorizedConnection(c.target, lease)).toThrow(
    "foreign",
  );
  expect(() => d.gs.CheckConnectionAuthorization(c.target, lease)).toThrow(
    "Forged",
  );
  expect(c.reads()).toBe(reads);
  unmoved(c);
  expect(c.gs.ConfirmAuthorizedConnection(c.target, lease)).toEqual(c.users);
});

test("all count/order/serial/guild/name/IP failures are whole-group and do not reserve a lease or block later valid preparation", () => {
  for (const count of [1, 2]) {
    const c = setup(count);
    const invalid: ConnectionIdentity[][] = [
      [],
      [...c.ids, c.ids[0]!],
      c.ids.map((id, i) => ({
        ...id,
        GuildSn: id.GuildSn + (i === count - 1 ? 1 : 0),
      })),
      c.ids.map((id, i) => ({
        ...id,
        ID: i === count - 1 ? "Unknown" : id.ID,
      })),
      c.ids.map((id, i) => ({
        ...id,
        GlobalSerialNo: i === count - 1 ? 0 : id.GlobalSerialNo,
      })),
    ];
    if (count === 2) invalid.push([...c.ids].reverse(), c.ids.slice(0, 1));
    for (const ids of invalid) {
      expect(() => c.gs.AuthorizeConnection(c.target, ids)).toThrow();
      unmoved(c);
    }
    expect(() => c.gs.AuthorizeConnection(peer("127.0.0.2"), c.ids)).toThrow(
      "transfer",
    );
    expect(c.gs.ConfirmAuthorizedConnection(c.target, c.authorize())).toEqual(
      c.users,
    );
  }
});

test("expiry is original deadline <= now, not a renewed lease TTL; live source stays authenticated and can request a new pending", () => {
  const c = setup(),
    lease = c.authorize();
  c.tick(RuntimePolicy.SessionTransferTimeoutMs - 1);
  c.gs.CheckConnectionAuthorization(c.target, lease);
  c.tick(1);
  expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow();
  expect(
    c.users.every(
      (u) => !u.m_pendingConnection && u.m_pClientSocket === c.source,
    ),
  ).toBe(true);
  expect(c.source.IsConnected()).toBe(true);
  expect(c.center.GetConnNo(c.gs.server, true)).toBe(0);
  expect(c.ls.RequestConnection(c.source, ServerType.FXGame, 0).result).toBe(1);
  const fresh = c.authorize();
  expect(fresh.Expires).toBeGreaterThan(lease.Expires);
  expect(c.gs.ConfirmAuthorizedConnection(c.target, fresh)).toEqual(c.users);
});

test("source TCP may close/detach during preparation; pending users are retained and can complete, unlike source service restart", () => {
  const c = setup(),
    lease = c.authorize();
  c.source.Close();
  c.ls.UnregisterConnection(c.source);
  expect(c.source.m_aUser).toEqual([]);
  expect(c.users.map((u) => u.IsSetFree())).toEqual([0, 0]);
  c.gs.CheckConnectionAuthorization(c.target, lease);
  expect(c.gs.ConfirmAuthorizedConnection(c.target, lease)).toEqual(c.users);
  c.ls.UnregisterConnection(c.source);
  expect(c.center.m_globalUserTable.GetUserCount()).toBe(2);
});

test("closed-source expiry frees all users and invalidates lease with no target attachment", () => {
  const c = setup(),
    lease = c.authorize();
  c.source.Close();
  c.ls.UnregisterConnection(c.source);
  c.tick(RuntimePolicy.SessionTransferTimeoutMs);
  c.center.ExpireConnections();
  expect(c.center.m_globalUserTable.GetUserCount()).toBe(0);
  expect(c.users.map((u) => u.IsSetFree())).toEqual([1, 1]);
  expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow();
  expect(c.target.m_aUser).toEqual([]);
  expect(c.gs.ReleaseConnectionAuthorization(c.target, lease)).toBe(false);
});

test("target disconnect/rejection releases exclusive preparation without cancelling the original pending reservation", () => {
  const c = setup(),
    lease = c.authorize();
  c.target.Close();
  c.gs.UnregisterConnection(c.target);
  expect(() => c.gs.CheckConnectionAuthorization(c.target, lease)).toThrow(
    "Stale",
  );
  expect(c.gs.ReleaseConnectionAuthorization(c.target, lease)).toBe(false);
  expect(c.users.every((u) => u.m_pendingConnection === c.pending)).toBe(true);
  const fresh = peer(),
    next = c.gs.AuthorizeConnection(fresh, c.ids);
  expect(c.gs.ConfirmAuthorizedConnection(fresh, next)).toEqual(c.users);
});

test("source/target server offline-online ABA and duplicate server objects cannot authorize an old pending", () => {
  for (const which of ["source", "target"]) {
    const c = setup(),
      lease = c.authorize(),
      server = which === "source" ? c.ls.server : c.gs.server,
      before = server.GetConnectionGeneration();
    server.m_bConnected = false;
    server.m_bConnected = true;
    expect(server.GetConnectionGeneration()).not.toBe(before);
    expect(() => c.gs.CheckConnectionAuthorization(c.target, lease)).toThrow(
      "transfer",
    );
    expect(() => c.gs.AuthorizeConnection(peer(), c.ids)).toThrow("transfer");
    unmoved(c);
  }
  const c = setup(),
    alias = new CLocalServer(ServerType.FXGame, 0, "alias", 0, 8);
  alias.m_bConnected = true;
  expect(() => c.center.AuthorizeConnection(c.target, alias, c.ids)).toThrow();
  unmoved(c);
});

test("same pending re-publication/clear-restore/server owner ABA is tracked, while readonly pending DTO and users array cannot be edited", () => {
  for (const mode of [0, 1, 2]) {
    const c = setup(),
      lease = c.authorize(),
      user = c.users[1]!;
    if (mode === 0) user.m_pendingConnection = c.pending;
    if (mode === 1) {
      user.m_pendingConnection = undefined;
      user.m_pendingConnection = c.pending;
    }
    if (mode === 2) {
      user.m_pLocalServer = c.gs.server;
      user.m_pLocalServer = c.ls.server;
    }
    expect(() => c.gs.CheckConnectionAuthorization(c.target, lease)).toThrow(
      "transfer",
    );
    expect(() => c.gs.CheckConnectionAuthorization(c.target, lease)).toThrow(
      "Stale",
    );
    unmoved(c);
  }
  const c = setup();
  expect(Object.isFrozen(c.pending)).toBe(true);
  expect(Object.isFrozen(c.pending.users)).toBe(true);
  expect(() => {
    (c.pending as { expires: number }).expires++;
  }).toThrow();
  expect(() => {
    (c.pending.users as unknown[]).reverse();
  }).toThrow();
  expect(c.gs.ConfirmAuthorizedConnection(c.target, c.authorize())).toEqual(
    c.users,
  );
});

test("any member's live info reference/dynamic/auth/session/slot/native generation or legacy row identity drift invalidates the ENTIRE lease before consumption", () => {
  const changes = [
    (u: ReturnType<typeof setup>["users"][number]) => {
      u.m_userInfo = { ...u.m_userInfo };
    },
    (u: ReturnType<typeof setup>["users"][number]) => u.IncDecMoney(1),
    (u: ReturnType<typeof setup>["users"][number]) => u.SetAuthenCode(1),
    (u: ReturnType<typeof setup>["users"][number]) => u.SetFakeLevel(2),
    (u: ReturnType<typeof setup>["users"][number]) => {
      u.m_nSessionIdx = 0;
    },
    (u: ReturnType<typeof setup>["users"][number]) => {
      u.m_nSlotIdx = 0;
    },
    (u: ReturnType<typeof setup>["users"][number]) => {
      u.InstallUserInventory([]);
      u.m_aInventory = [];
    },
    (u: ReturnType<typeof setup>["users"][number]) => {
      u.m_aInventory = [];
    },
  ];
  for (const change of changes) {
    const c = setup(),
      lease = c.authorize();
    change(c.users[1]!);
    expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow();
    expect(c.target.m_aUser).toEqual([]);
    expect(
      c.users.every(
        (u) =>
          u.m_pendingConnection === c.pending && u.m_pClientSocket === c.source,
      ),
    ).toBe(true);
    expect(c.users[0]!.m_userInfo.Money).toBe(37);
  }
  const c = setup();
  c.users[1]!.InstallUserInventory([NativeInventory()]);
  const lease = c.authorize();
  c.users[1]!.InstallUserInventory(c.users[1]!.CaptureUserInventory()!.Rows);
  expect(() => c.gs.CheckConnectionAuthorization(c.target, lease)).toThrow(
    "source changed",
  );
});

test("legacy row replacement with identical values is stale, and a source roster may not disappear while its TCP is still live", () => {
  const c = setup();
  c.users[1]!.m_aInventory = [
    {
      SN: 7,
      ID: "User1",
      ItemID: 99,
      Slot: 255,
      Amount: 2,
      CreatedAt: 0,
      ExpireDate: 0,
      Verbose: "fixture",
    },
  ];
  const lease = c.authorize();
  c.users[1]!.m_aInventory[0] = { ...c.users[1]!.m_aInventory[0]! };
  expect(() => c.gs.CheckConnectionAuthorization(c.target, lease)).toThrow(
    "source changed",
  );
  unmoved(c);
  const d = setup(),
    a = d.authorize();
  d.source.ClearAttachedUsers();
  expect(() => d.gs.CheckConnectionAuthorization(d.target, a)).toThrow(
    "source group",
  );
  expect(d.target.m_aUser).toEqual([]);
});

test("marked-free/global deletion/socket ownership drift at either member blocks lease and leaves partner pending", () => {
  for (const mode of ["free", "delete", "owner", "serial"]) {
    const c = setup(),
      lease = c.authorize(),
      u = c.users[1]!;
    if (mode === "free") u.SetFree();
    if (mode === "delete") c.center.m_globalUserTable.DeleteUser(u);
    if (mode === "owner") u.m_pClientSocket = peer();
    if (mode === "serial")
      Object.defineProperty(u, "m_nGlobalSerialNo", { value: 0 });
    expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow(
      "transfer",
    );
    expect(c.target.m_aUser).toEqual([]);
    expect(c.users[0]!.m_pendingConnection).toBe(c.pending);
    expect(c.users[0]!.IsSetFree()).toBe(0);
  }
});

test("invalid/backwards clocks fail closed and never extend authority; clock callbacks cannot reenter commit/release during validation", () => {
  for (const delta of [-1, Infinity, NaN]) {
    const c = setup(),
      lease = c.authorize();
    c.setTime(c.time() + delta);
    expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow(
      "clock",
    );
    expect(c.target.m_aUser).toEqual([]);
    expect(c.users.every((u) => u.m_pendingConnection === undefined)).toBe(
      true,
    );
  }
  const c = setup(),
    lease = c.authorize();
  let blocked = 0;
  c.clockHook(() => {
    expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow(
      "Reentrant",
    );
    blocked++;
    expect(() => c.gs.ReleaseConnectionAuthorization(c.target, lease)).toThrow(
      "Reentrant",
    );
    blocked++;
  });
  c.gs.CheckConnectionAuthorization(c.target, lease);
  expect(blocked).toBe(2);
  c.clockHook(undefined);
  expect(c.gs.ConfirmAuthorizedConnection(c.target, lease)).toEqual(c.users);
});

test("clock reentry before authorization and identity getters cannot steal the same destination's preparing lease", () => {
  const c = setup();
  let blocked = 0;
  c.clockHook(() => {
    expect(() => c.gs.AuthorizeConnection(c.target, c.ids)).toThrow(
      "Reentrant",
    );
    blocked++;
  });
  const lease = c.authorize();
  expect(blocked).toBe(1);
  c.clockHook(undefined);
  c.gs.ReleaseConnectionAuthorization(c.target, lease);
  const id = c.ids[0]!,
    calls = { ID: 0, GlobalSerialNo: 0, GuildSn: 0 };
  const raw = {
    get ID() {
      calls.ID++;
      expect(() => c.gs.ConfirmConnection(c.target, c.ids)).toThrow(
        "Reentrant",
      );
      return id.ID;
    },
    get GlobalSerialNo() {
      calls.GlobalSerialNo++;
      return id.GlobalSerialNo;
    },
    get GuildSn() {
      calls.GuildSn++;
      return id.GuildSn;
    },
  };
  const next = c.gs.AuthorizeConnection(c.target, [raw, c.ids[1]!]);
  expect(calls).toEqual({ ID: 1, GlobalSerialNo: 1, GuildSn: 1 });
  expect(c.gs.ConfirmAuthorizedConnection(c.target, next)).toEqual(c.users);
});

test("an invalid nested pending acquisition cannot accidentally release the outer per-pending capture guard", () => {
  const c = setup();
  const original = c.users[0]!.GetDynamicInfoSnapshot.bind(c.users[0]);
  let calls = 0;
  c.users[0]!.GetDynamicInfoSnapshot = () => {
    if (calls++ === 0)
      for (let i = 0; i < 2; i++)
        expect(() => c.gs.ConfirmConnection(peer(), c.ids)).toThrow("active");
    return original();
  };
  expect(c.gs.ConfirmAuthorizedConnection(c.target, c.authorize())).toEqual(
    c.users,
  );
  expect(calls).toBeGreaterThan(1);
});

test("different pending groups may prepare simultaneously without extra capacity, but one destination cannot prepare both groups", () => {
  const c = setup(1),
    source = peer(),
    users = c.ls.RegisterConnection(source, [UserInfo("Other")]);
  expect(c.ls.RequestConnection(source, ServerType.FXGame, 0).result).toBe(1);
  const ids = users.map((u) => ({
    ID: u.GetName(),
    GlobalSerialNo: u.GetGlobalSerialNo(),
    GuildSn: u.m_userInfo.GuildSn,
  }));
  const a = c.authorize();
  expect(() => c.gs.AuthorizeConnection(c.target, ids)).toThrow("active");
  const target = peer(),
    b = c.gs.AuthorizeConnection(target, ids);
  expect(c.center.GetConnNo(c.gs.server, true)).toBe(2);
  expect(c.gs.ConfirmAuthorizedConnection(target, b)).toEqual(users);
  expect(c.gs.ConfirmAuthorizedConnection(c.target, a)).toEqual(c.users);
});

test("immutable/frozen target/source attached arrays are refused BEFORE authoritative owner mutation; consuming cannot partially attach one local", () => {
  for (const which of ["target", "source", "element"]) {
    const c = setup();
    const lease = c.authorize();
    if (which === "target") Object.freeze(c.target.m_aUser);
    if (which === "source") Object.freeze(c.source.m_aUser);
    if (which === "element")
      Object.defineProperty(c.source.m_aUser, "0", { configurable: false });
    expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow();
    expect(c.target.m_aUser).toEqual([]);
    expect(
      c.users.every(
        (u) =>
          u.m_pClientSocket === c.source && u.m_pendingConnection === c.pending,
      ),
    ).toBe(true);
  }
});

test("source transport-close exception is after single-use ownership commit, is reported generically and cannot make the transfer replayable", () => {
  const c = setup(),
    lease = c.authorize(),
    warn = console.warn,
    messages: string[] = [];
  c.source.Close = () => {
    throw Error("secret transport details");
  };
  console.warn = (...a: unknown[]) => {
    messages.push(a.join(" "));
  };
  try {
    expect(c.gs.ConfirmAuthorizedConnection(c.target, lease)).toEqual(c.users);
  } finally {
    console.warn = warn;
    c.source.Close = () => MemoryClient.prototype.Close.call(c.source);
  }
  expect(messages).toEqual(['{"event":"source-transfer-close-failed"}']);
  expect(() => c.gs.ConfirmConnection(peer(), c.ids)).toThrow("transfer");
  expect(
    c.users.every(
      (u) => u.m_pClientSocket === c.target && !u.m_pendingConnection,
    ),
  ).toBe(true);
});

test("identity capture validates direct API shapes/scalars and uses ASCII case only, without mutating stored input", () => {
  for (const ids of [
    [],
    [{}, {}],
    [{ ID: "A", GlobalSerialNo: -1, GuildSn: 0 }],
    [{ ID: "A", GlobalSerialNo: 1, GuildSn: Infinity }],
    [{ ID: "A\0", GlobalSerialNo: 1, GuildSn: 0 }],
    [{ ID: "A".repeat(17), GlobalSerialNo: 1, GuildSn: 0 }],
    [
      { ID: "A", GlobalSerialNo: 1, GuildSn: 0 },
      { ID: "a", GlobalSerialNo: 2, GuildSn: 0 },
    ],
    [
      { ID: "A", GlobalSerialNo: 1, GuildSn: 0 },
      { ID: "B", GlobalSerialNo: 1, GuildSn: 0 },
    ],
  ])
    expect(() =>
      CaptureConnectionIdentities(ids as ConnectionIdentity[]),
    ).toThrow();
  const c = setup(),
    input = c.ids.map((id) => ({ ...id, ID: id.ID.toUpperCase() }));
  const lease = c.gs.AuthorizeConnection(c.target, input);
  input[0]!.ID = "different";
  expect(c.gs.ConfirmAuthorizedConnection(c.target, lease)).toEqual(c.users);
});

test("pending DTO shapes are not authority: only this Center's privately issued object and unchanged per-user epochs may acquire a lease", () => {
  const c = setup(),
    forged = Object.freeze({
      ...c.pending,
      users: Object.freeze([...c.users]),
    });
  for (const u of c.users) u.m_pendingConnection = forged;
  expect(() => c.authorize()).toThrow("transfer");
  for (const u of c.users) u.m_pendingConnection = c.pending;
  expect(() => c.authorize()).toThrow("transfer");
  for (const u of c.users) u.m_pendingConnection = undefined;
  expect(c.ls.RequestConnection(c.source, ServerType.FXGame, 0).result).toBe(1);
  expect(c.users[0]!.m_pendingConnection).not.toBe(c.pending);
  expect(c.gs.ConfirmAuthorizedConnection(c.target, c.authorize())).toEqual(
    c.users,
  );
});

test("active destination cannot be repurposed as another login, and an old CONSUMED pending cannot be restored to mint new authority", () => {
  const c = setup(),
    lease = c.authorize();
  expect(() =>
    c.ls.RegisterConnection(c.target, [UserInfo("Replacement")]),
  ).toThrow("login group");
  expect(
    c.center.m_globalUserTable.FindUserFromId("Replacement"),
  ).toBeUndefined();
  expect(c.gs.ConfirmAuthorizedConnection(c.target, lease)).toEqual(c.users);
  const next = peer();
  for (const u of c.users) {
    u.m_pendingConnection = c.pending;
    u.m_pClientSocket = c.source;
    u.m_pLocalServer = c.ls.server;
  }
  expect(() => c.gs.AuthorizeConnection(next, c.ids)).toThrow("transfer");
  expect(next.m_aUser).toEqual([]);
});
