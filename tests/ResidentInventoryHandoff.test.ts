import { afterEach, expect, test } from "bun:test";
import type { ConnectionAuthorization } from "../Center/ConnectionAuthorization.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { IntegerRange } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { MemoryClient } from "./helpers/Clients.ts";
import { HandoffFixture } from "./helpers/InventoryHandoff.ts";
import {
  ResidentHandoffVectors,
  ResidentHandoffFixture,
  AttachResident,
  VectorOwned,
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

test("33 fixed PE anchors bind native wire roles/nonempty201/207 order; resident/mixed-mode SOURCE policy is explicitly MODERN, not original SQL initialization", () => {
  const game = new CPeImage(OFFICIAL_SERVICES.FXGS),
    login = new CPeImage(OFFICIAL_SERVICES.LS);
  expect(ResidentHandoffVectors.OfficialPE.SHA256).toBe(game.sha256);
  expect(ResidentHandoffVectors.LevelInput).toEqual({
    LoginSHA256: login.sha256,
    GameSHA256: game.sha256,
    Entries: 450,
  });
  expect(ResidentHandoffVectors.InstructionAnchors).toHaveLength(33);
  for (const a of ResidentHandoffVectors.InstructionAnchors)
    expect(game.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(ResidentHandoffVectors.Cases).toHaveLength(254);
  expect(ResidentHandoffVectors.Model).toContain("MODERN");
  expect(ResidentHandoffVectors.Model).toContain("NOT native initialization");
});

test("ALL254 independent native/mixed wire images drive actual GS handler: native EMPTY/nonempty skips legacy SQL, preserves both live epochs/dirty/presentation and matches210202207201 bytes", () => {
  for (const c of ResidentHandoffVectors.Cases) {
    const e = HandoffFixture({
      Users: c.Users.length,
      GameAttr: c.GameAttr,
      Exp: c.Users.map((u) => u.Exp),
    });
    try {
      c.Users.forEach((v, i) => {
        const u = e.users[i]!;
        e.session.db
          .query(
            "INSERT INTO FxUserInventory(SN,ID,ItemID,Slot,Amount,ExpireDate,Verbose) VALUES(?,?,7,255,?,0,?)",
          )
          .run(100 + i, u.GetName(), 4 + i, `LEGACY owned${i}`);
        if (v.Mode) {
          u.InstallUserInventoryInitialization(
            VectorOwned(v.OwnedRows),
            v.PreRows,
            { FakeLevel: v.Presentation.FakeLevel },
          );
          u.SetLevelIcon(
            v.Presentation.LevelIconEnabled,
            v.Presentation.LevelIconSN,
          );
        } else u.InstallPreInventory(v.PreRows);
      });
      const before = e.users.map((u) => u.CaptureUserInventoryInitialization()),
        dynamic = e.users.map((u) => u.GetDynamicInfoSnapshot()),
        load = e.db.LoadInventory.bind(e.db),
        reads: string[] = [];
      e.db.LoadInventory = (id) => {
        reads.push(id);
        return load(id);
      };
      e.run(c.Initialized);
      expect(
        e.target.packets.map((p) => ({
          Opcode: p.m_nPacketType,
          Hex: p.m_pBlock.toString("hex"),
        })),
      ).toEqual(c.Expected);
      expect(reads.length).toBe(c.LegacyReads);
      expect(reads).toEqual(
        e.users.filter((_, i) => !c.Users[i]!.Mode).map((u) => u.GetName()),
      );
      expect(
        e.users.map((u) => u.CaptureUserInventoryInitialization()),
      ).toEqual(before);
      expect(e.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(dynamic);
      expect(e.users.map((u) => u.GetLevel())).toEqual(
        c.Users.map((u) => u.Level),
      );
      expect(e.source.m_aUser).toEqual([]);
      expect(e.target.m_aUser).toEqual(e.users);
      expect(e.callbacks()).toBe(1);
      expect(
        e.users.every(
          (u) => !u.m_pendingConnection && u.m_pClientSocket === e.target,
        ),
      ).toBe(true);
      for (const [i, v] of c.Users.entries()) {
        if (v.Mode) expect(e.users[i]!.m_aInventory).toEqual([]);
        else expect(e.users[i]!.m_aInventory[0]!.SN).toBe(100 + i);
      }
    } finally {
      e.close();
    }
  }
}, 30000);

test("lease-bound paired DTO is deep-frozen, detached and identity-bound, with exact raw negative-zero/dirty/enable DWORD; it exposes no live user or capability", () => {
  const e = create(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    data = e.gs.CaptureAuthorizedInventory(e.target, lease);
  expect(data).toEqual(
    e.users.map((u, i) => ({
      ...e.ids[i]!,
      ...u.CaptureUserInventoryInitialization(),
    })),
  );
  expect(Object.isFrozen(data)).toBe(true);
  for (const [i, d] of data.entries()) {
    expect(Object.keys(d).sort()).toEqual(
      [
        "ID",
        "GlobalSerialNo",
        "GuildSn",
        "OwnedGeneration",
        "Owned",
        "Pre",
        "Presentation",
      ].sort(),
    );
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.Owned)).toBe(true);
    expect(Object.isFrozen(d.Owned!.Rows)).toBe(true);
    expect(d.Owned!.Rows.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(d.Pre.Rows)).toBe(true);
    expect(d.Pre.Rows.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(d.Presentation)).toBe(true);
    expect(Object.isFrozen(d.OwnedGeneration)).toBe(true);
    expect(d.Owned!.Rows).not.toBe(e.users[i]!.CaptureUserInventory()!.Rows);
    expect(d.Pre.Rows).not.toBe(e.users[i]!.CapturePreInventory().Rows);
    expect(Object.is(d.Owned!.Rows[1]!.DateCreated, -0)).toBe(true);
    expect(d.Owned!.Rows[0]!.Modified).toBe(1);
  }
  expect(data[0]!.Presentation.LevelIconEnabled).toBe(0);
  expect(data[0]!.Presentation.LevelIconSN).toBe(0xfedcba98 | 0);
  expect(data[1]!.Presentation.LevelIconEnabled).toBe(2);
  expect(() =>
    e.gs.CaptureAuthorizedInventory(
      e.target,
      data as unknown as ConnectionAuthorization,
    ),
  ).toThrow("Forged");
  expect(e.gs.ReleaseConnectionAuthorization(e.target, lease)).toBe(true);
  AttachResident(e.users[1]!, [], []);
  expect(data[1]!.Owned!.Rows).toHaveLength(2);
});

test("legacy mode retains a NONZERO prior native epoch without carrying stale native rows or losing pre/presentation; native empty remains distinct from legacy null", () => {
  const e = create([1, 1]);
  e.users[1]!.m_aInventory = [];
  const lease = e.gs.AuthorizeConnection(e.target, e.ids),
    data = e.gs.CaptureAuthorizedInventory(e.target, lease);
  expect(data[0]!.Owned).toEqual({ Revision: 1, Rows: [] });
  expect(data[0]!.OwnedGeneration).toEqual({ Native: true, Revision: 1 });
  expect(data[1]!.Owned).toBeNull();
  expect(data[1]!.OwnedGeneration).toEqual({ Native: false, Revision: 2 });
  expect(data[1]!.Pre.Rows).toHaveLength(1);
});

test("forged/foreign/server-mismatched/released leases fail BEFORE ANY pair getter; no native row/DTO can mint another lease", () => {
  const e = create(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    other = new MemoryClient();
  cleanup.push(() => other.Close());
  let reads = 0;
  const get = e.users[0]!.CaptureUserInventoryInitialization.bind(e.users[0]);
  e.users[0]!.CaptureUserInventoryInitialization = () => {
    reads++;
    return get();
  };
  expect(() =>
    e.gs.CaptureAuthorizedInventory(e.target, {
      ...lease,
    } as ConnectionAuthorization),
  ).toThrow("Forged");
  expect(() => e.gs.CaptureAuthorizedInventory(other, lease)).toThrow(
    "foreign",
  );
  expect(() => e.ls.CaptureAuthorizedInventory(e.target, lease)).toThrow(
    "foreign",
  );
  expect(reads).toBe(0);
  e.gs.CaptureAuthorizedInventory(e.target, lease);
  expect(reads).toBe(1);
  e.gs.ReleaseConnectionAuthorization(e.target, lease);
  expect(() => e.gs.CaptureAuthorizedInventory(e.target, lease)).toThrow(
    "Stale",
  );
  expect(reads).toBe(1);
});

test("paired capture holds exclusive whole-group guard through getters: nested pair/pre capture, release, consume or establishment cannot steal ownership", () => {
  const e = create(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    get = e.users[0]!.CaptureUserInventoryInitialization.bind(e.users[0]);
  let calls = 0;
  e.users[0]!.CaptureUserInventoryInitialization = () => {
    for (const f of [
      () => e.gs.CaptureAuthorizedInventory(e.target, lease),
      () => e.gs.CaptureAuthorizedPreInventory(e.target, lease),
      () => e.gs.ConfirmAuthorizedConnection(e.target, lease),
      () => e.gs.ReleaseConnectionAuthorization(e.target, lease),
    ]) {
      expect(f).toThrow("Reentrant");
      calls++;
    }
    return get();
  };
  e.gs.CaptureAuthorizedInventory(e.target, lease);
  expect(calls).toBe(4);
  e.users[0]!.CaptureUserInventoryInitialization = get;
  expect(e.gs.ConfirmAuthorizedConnection(e.target, lease)).toEqual(e.users);
});

test("SECOND paired getter exception retires preparation only, keeping the original pending/deadline/source for a new lease and same-group retry", () => {
  const e = create(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    get = e.users[1]!.CaptureUserInventoryInitialization.bind(e.users[1]);
  e.users[1]!.CaptureUserInventoryInitialization = () => {
    throw new Error("second pair read");
  };
  expect(() => e.gs.CaptureAuthorizedInventory(e.target, lease)).toThrow(
    "second pair read",
  );
  expect(e.gs.ReleaseConnectionAuthorization(e.target, lease)).toBe(false);
  unmoved(e);
  e.users[1]!.CaptureUserInventoryInitialization = get;
  const next = e.gs.AuthorizeConnection(e.target, e.ids);
  expect(next.Expires).toBe(e.pending.expires);
  expect(e.gs.CaptureAuthorizedInventory(e.target, next)).toHaveLength(2);
});

test("same-value paired/native->legacy->native ABA INSIDE second getter is detected AFTER capture; no mixed-mode snapshot escapes", () => {
  for (const change of [
    (e: ReturnType<typeof create>) => {
      const u = e.users[0]!,
        p = u.CaptureUserInventoryInitialization();
      u.InstallUserInventoryInitialization(p.Owned!.Rows, p.Pre.Rows);
    },
    (e: ReturnType<typeof create>) => {
      const u = e.users[0]!,
        p = u.CaptureUserInventoryInitialization();
      u.m_aInventory = [];
      u.InstallUserInventoryInitialization(p.Owned!.Rows, p.Pre.Rows);
    },
  ]) {
    const e = create(),
      lease = e.gs.AuthorizeConnection(e.target, e.ids),
      get = e.users[1]!.CaptureUserInventoryInitialization.bind(e.users[1]);
    e.users[1]!.CaptureUserInventoryInitialization = () => {
      change(e);
      return get();
    };
    expect(() => e.gs.CaptureAuthorizedInventory(e.target, lease)).toThrow(
      "changed",
    );
    unmoved(e);
  }
});

test("expiry INSIDE paired read refuses DTO without extending TTL or consuming source; expired pending is cancelled rather than revived", () => {
  const e = create(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    get = e.users[1]!.CaptureUserInventoryInitialization.bind(e.users[1]);
  e.users[1]!.CaptureUserInventoryInitialization = () => {
    e.tick(RuntimePolicy.SessionTransferTimeoutMs);
    return get();
  };
  expect(() => e.gs.CaptureAuthorizedInventory(e.target, lease)).toThrow();
  expect(e.users.every((u) => u.m_pendingConnection === undefined)).toBe(true);
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.target.m_aUser).toEqual([]);
});

test("native epoch exhaustion does NOT turn a read-side handoff into an implicit reload/wrap or legacy downgrade", () => {
  const e = create();
  for (const u of e.users) {
    Reflect.set(u, "m_nUserInventoryRevision", IntegerRange.UInt32Maximum);
    Reflect.set(u, "m_nPreInventoryRevision", IntegerRange.UInt32Maximum);
  }
  const before = e.users.map((u) => u.CaptureUserInventoryInitialization());
  e.db.LoadInventory = () => {
    throw new Error("native epoch max MUST NOT call legacy storage");
  };
  e.run();
  expect(e.users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
    before,
  );
  expect(e.target.m_aUser).toEqual(e.users);
  expect(e.target.packets.map((p) => p.m_nPacketType)).toEqual([
    210, 202, 207, 201,
  ]);
});

test("malformed pair mode/revision/capacity/presentation snapshots cannot pass Center data boundary or consume any owner", () => {
  for (const alter of [
    (
      p: ReturnType<
        ReturnType<
          typeof create
        >["users"][number]["CaptureUserInventoryInitialization"]
      >,
    ) => ({ ...p, OwnedGeneration: { Native: false, Revision: 1 } }),
    (
      p: ReturnType<
        ReturnType<
          typeof create
        >["users"][number]["CaptureUserInventoryInitialization"]
      >,
    ) => ({
      ...p,
      Owned: { Revision: 1, Rows: new Array(401).fill(NativeInventory()) },
    }),
    (
      p: ReturnType<
        ReturnType<
          typeof create
        >["users"][number]["CaptureUserInventoryInitialization"]
      >,
    ) => ({ ...p, Presentation: { ...p.Presentation, LevelIconEnabled: NaN } }),
    (
      p: ReturnType<
        ReturnType<
          typeof create
        >["users"][number]["CaptureUserInventoryInitialization"]
      >,
    ) => ({ ...p, Pre: { ...p.Pre, Revision: -1 } }),
  ]) {
    const e = create(),
      lease = e.gs.AuthorizeConnection(e.target, e.ids),
      get = e.users[1]!.CaptureUserInventoryInitialization.bind(e.users[1]);
    e.users[1]!.CaptureUserInventoryInitialization = () => alter(get());
    expect(() => e.gs.CaptureAuthorizedInventory(e.target, lease)).toThrow(
      "snapshot",
    );
    unmoved(e);
  }
});

test("native reader never substitutes a CURRENT catalog's changed category/attrs or reinterprets raw DATE as Unix/permanence; transport is not expiry revalidation", () => {
  const e = create(),
    before = e.users.map((u) => u.CaptureUserInventoryInitialization());
  e.session.db.exec(
    "UPDATE FxItem SET Category=6,strAttr='changed catalog',nAttr1=999",
  );
  e.items.UpdateUserItemTable();
  e.run();
  expect(e.users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
    before,
  );
  expect(e.users[0]!.CaptureUserInventory()!.Rows[0]!.Category).toBe(2);
  expect(e.users[0]!.CaptureUserInventory()!.Rows[0]!.DateCreated).toBe(-1.75);
  expect(e.users[0]!.GetFakeLevel()).toBe(-17);
});

test("resident packet capture is read-only: a prepared201 does not consume amounts, clear dirty/pre, change epochs or grant a financial retry", () => {
  const e = create(),
    before = e.users.map((u) => u.CaptureUserInventoryInitialization());
  e.run();
  for (const [i, u] of e.users.entries()) {
    const p = new CSendPacket(201).Encode1(1);
    u.MakeUserInventoryPacket(p);
    expect(u.CaptureUserInventoryInitialization()).toEqual(before[i]!);
    expect(u.IsInventoryModified(7)).toBe(1);
    expect(u.GetPreInventoryCount()).toBe(1);
  }
  expect(e.users[0]!.GetUserInventory(0xfedcba98)).toBeUndefined();
});
