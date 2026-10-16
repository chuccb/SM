import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import type { ConnectionAuthorization } from "../Center/ConnectionAuthorization.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { MemoryClient } from "./helpers/Clients.ts";
import { PreRow } from "./helpers/PreInventory.ts";
import { HandoffFixture } from "./helpers/InventoryHandoff.ts";
import vectors from "./fixtures/inventory-handoff-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function create(options: Parameters<typeof HandoffFixture>[0] = {}) {
  const e = HandoffFixture(options);
  cleanup.push(e.close);
  return e;
}

test("24 fixed native handoff anchors bind FIRST init / ANY pre -> ALL locals / forced201; LS-GS450 table inputs agree, NO native executable runs", () => {
  const game = new CPeImage(OFFICIAL_SERVICES.FXGS),
    login = new CPeImage(OFFICIAL_SERVICES.LS);
  expect(game.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.LevelInput).toEqual({
    LoginSHA256: login.sha256,
    GameSHA256: game.sha256,
    Entries: 450,
  });
  expect(vectors.InstructionAnchors).toHaveLength(24);
  for (const a of vectors.InstructionAnchors)
    expect(game.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(login.read(login.symbolVA("g_nLevel2ExpTable"), 450 * 4)).toEqual(
    game.read(game.symbolVA("g_nLevel2ExpTable"), 450 * 4),
  );
});

test("ALL288 independent C++ handoff images drive ACTUAL GS handler, including empty first/second locals, first-only cache gate,30 rows, native207 and EMPTY201", () => {
  expect(vectors.Cases).toHaveLength(288);
  for (const c of vectors.Cases) {
    const e = HandoffFixture({
      Users: c.Users.length,
      GameAttr: c.GameAttr,
      Exp: c.Users.map((u) => u.Exp),
    });
    try {
      c.Users.forEach((r, i) => {
        e.users[i]!.InstallPreInventory(r.Rows);
        e.users[i]!.m_bClientInitialized = r.Initialized;
      });
      const before = e.users.map((u) => u.GetDynamicInfoSnapshot()),
        pre = e.users.map((u) => u.CapturePreInventory());
      e.run(c.Users[0]!.Initialized);
      expect(
        e.target.packets.map((p) => ({
          Opcode: p.m_nPacketType,
          Hex: p.m_pBlock.toString("hex"),
        })),
      ).toEqual(c.Expected);
      expect(e.users.map((u) => u.GetLevel())).toEqual(
        c.Users.map((u) => u.Level),
      );
      expect(e.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
      expect(e.users.map((u) => u.CapturePreInventory())).toEqual(pre);
      expect(e.users.map((u) => u.m_aInventory)).toEqual(c.Users.map(() => []));
      expect(e.target.m_aUser).toEqual(e.users);
      expect(e.source.m_aUser).toEqual([]);
      expect(
        e.users.every(
          (u) => !u.m_pendingConnection && u.m_pClientSocket === e.target,
        ),
      ).toBe(true);
      expect(e.callbacks()).toBe(1);
      expect(e.users.at(-1)!.m_bClientInitialized).toBe(
        c.Users.at(-1)!.Initialized,
      );
    } finally {
      e.close();
    }
  }
}, 30000);

test("catalog enumeration/Get lookup/202 are the SAME frozen generation even after a later committed SQL reload", () => {
  const e = create(),
    old = e.items.CaptureSnapshot(),
    expected = new CSendPacket(202);
  e.items.PutUserItemList(expected, old);
  expect(Object.isFrozen(old.Rows)).toBe(true);
  expect(old.Rows.every(Object.isFrozen)).toBe(true);
  expect(old.Count).toBe(old.Rows.length);
  expect(old.Rows.every((r) => old.GetUserItem(r.SN) === r)).toBe(true);
  e.session.db.exec(
    "UPDATE FxItem SET Category=2,strName='changed',nAttr1=999",
  );
  e.items.UpdateUserItemTable();
  const actual = new CSendPacket(202);
  e.items.PutUserItemList(actual, old);
  expect(actual.GetBuffer()).toEqual(expected.GetBuffer());
  expect(e.items.CaptureSnapshot().Revision).toBe(old.Revision + 1);
  expect(e.items.CaptureSnapshot().GetUserItem(7)!.Category).toBe(2);
  expect(old.GetUserItem(7)!.Category).toBe(101);
});

test("authorized pre capture returns only deeply frozen identity/revision/row DTOs; no CUser, socket, issuer or mutable input alias escapes", () => {
  const e = create();
  e.users[1]!.InstallPreInventory([PreRow()]);
  const lease = e.gs.AuthorizeConnection(e.target, e.ids),
    data = e.gs.CaptureAuthorizedPreInventory(e.target, lease);
  expect(data).toEqual(
    e.ids.map((id, i) => ({ ...id, Revision: i, Rows: i ? [PreRow()] : [] })),
  );
  expect(Object.isFrozen(data)).toBe(true);
  for (const local of data) {
    expect(Object.isFrozen(local)).toBe(true);
    expect(Object.isFrozen(local.Rows)).toBe(true);
    expect(local.Rows.every(Object.isFrozen)).toBe(true);
    expect(Object.keys(local).sort()).toEqual(
      ["GuildSn", "GlobalSerialNo", "ID", "Revision", "Rows"].sort(),
    );
  }
  expect(data[1]!.Rows).not.toBe(e.users[1]!.CapturePreInventory().Rows);
  e.gs.CheckConnectionAuthorization(e.target, lease);
  expect(e.target.m_aUser).toEqual([]);
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.gs.ReleaseConnectionAuthorization(e.target, lease)).toBe(true);
});

test("forged/foreign/released leases fail BEFORE ANY pre getter; a detached DTO isn't another authorization capability", () => {
  const e = create(),
    other = new MemoryClient();
  cleanup.push(() => other.Close());
  const lease = e.gs.AuthorizeConnection(e.target, e.ids);
  let reads = 0;
  const get = e.users[0]!.CapturePreInventory.bind(e.users[0]);
  e.users[0]!.CapturePreInventory = () => {
    reads++;
    return get();
  };
  expect(() =>
    e.gs.CaptureAuthorizedPreInventory(
      e.target,
      Object.freeze({ ...lease }) as ConnectionAuthorization,
    ),
  ).toThrow("Forged");
  expect(() => e.gs.CaptureAuthorizedPreInventory(other, lease)).toThrow(
    "foreign",
  );
  expect(() => e.ls.CaptureAuthorizedPreInventory(e.target, lease)).toThrow(
    "foreign",
  );
  expect(reads).toBe(0);
  const rows = e.gs.CaptureAuthorizedPreInventory(e.target, lease);
  expect(reads).toBe(1);
  expect(() =>
    e.gs.CaptureAuthorizedPreInventory(
      e.target,
      rows as unknown as ConnectionAuthorization,
    ),
  ).toThrow("Forged");
  e.gs.ReleaseConnectionAuthorization(e.target, lease);
  expect(() => e.gs.CaptureAuthorizedPreInventory(e.target, lease)).toThrow(
    "Stale",
  );
  expect(reads).toBe(1);
});

test("whole-group pre capture HOLDS the existing lease reentrancy guard through getters: nested capture/consume/release cannot steal the group", () => {
  const e = create(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    get = e.users[0]!.CapturePreInventory.bind(e.users[0]);
  let calls = 0;
  e.users[0]!.CapturePreInventory = () => {
    for (const nested of [
      () => e.gs.CaptureAuthorizedPreInventory(e.target, lease),
      () => e.gs.ConfirmAuthorizedConnection(e.target, lease),
      () => e.gs.ReleaseConnectionAuthorization(e.target, lease),
    ]) {
      expect(nested).toThrow("Reentrant");
      calls++;
    }
    return get();
  };
  e.gs.CaptureAuthorizedPreInventory(e.target, lease);
  expect(calls).toBe(3);
  e.users[0]!.CapturePreInventory = get;
  expect(e.gs.ConfirmAuthorizedConnection(e.target, lease)).toEqual(e.users);
});

test("a SECOND pre getter exception retires preparation but preserves source/issued pending/deadline for a NEW read-side lease", () => {
  const e = create(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    get = e.users[1]!.CapturePreInventory.bind(e.users[1]);
  e.users[1]!.CapturePreInventory = () => {
    throw new Error("injected second pre capture");
  };
  expect(() => e.gs.CaptureAuthorizedPreInventory(e.target, lease)).toThrow(
    "second pre",
  );
  expect(e.gs.ReleaseConnectionAuthorization(e.target, lease)).toBe(false);
  expect(e.target.m_aUser).toEqual([]);
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.users.every((u) => u.m_pendingConnection === e.pending)).toBe(true);
  e.users[1]!.CapturePreInventory = get;
  const next = e.gs.AuthorizeConnection(e.target, e.ids);
  expect(next.Expires).toBe(e.pending.expires);
  expect(e.gs.CaptureAuthorizedPreInventory(e.target, next)).toHaveLength(2);
});

test("source pre-only ABA INSIDE second getter is caught AFTER capture without handing out a mixed-generation DTO", () => {
  const e = create();
  e.users[0]!.InstallPreInventory([PreRow()]);
  const lease = e.gs.AuthorizeConnection(e.target, e.ids),
    get = e.users[1]!.CapturePreInventory.bind(e.users[1]);
  e.users[1]!.CapturePreInventory = () => {
    const rows = e.users[0]!.CapturePreInventory().Rows;
    e.users[0]!.InstallPreInventory([]);
    e.users[0]!.InstallPreInventory(rows);
    return get();
  };
  expect(() => e.gs.CaptureAuthorizedPreInventory(e.target, lease)).toThrow(
    "changed",
  );
  expect(e.gs.ReleaseConnectionAuthorization(e.target, lease)).toBe(false);
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.target.m_aUser).toEqual([]);
});

test("expiry INSIDE a pre getter is rechecked against the ORIGINAL TTL and cannot return valid-looking read data", () => {
  const e = create(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    get = e.users[1]!.CapturePreInventory.bind(e.users[1]);
  e.users[1]!.CapturePreInventory = () => {
    e.tick(RuntimePolicy.SessionTransferTimeoutMs);
    return get();
  };
  expect(() => e.gs.CaptureAuthorizedPreInventory(e.target, lease)).toThrow();
  expect(
    e.users.every(
      (u) => !u.m_pendingConnection && u.m_pClientSocket === e.source,
    ),
  ).toBe(true);
  expect(e.target.m_aUser).toEqual([]);
  expect(lease.Expires).toBe(e.pending.expires);
});

test("Center DTO capture imposes NO Big5 codec on valid trusted UTF8 pre strings; receiver codepage is checked at packet preflight instead", () => {
  const e = create();
  e.users[1]!.InstallPreInventory(
    [PreRow({ strAttr: "🎮", Description: "中🎮" })],
    new CTextCodec("utf8"),
  );
  const lease = e.gs.AuthorizeConnection(e.target, e.ids),
    rows = e.gs.CaptureAuthorizedPreInventory(e.target, lease);
  expect(rows[1]!.Rows[0]!.Description).toBe("中🎮");
  expect(rows[1]!.Rows[0]!.strAttr).toBe("🎮");
  expect(e.gs.ReleaseConnectionAuthorization(e.target, lease)).toBe(true);
});

test("malformed capture revisions / oversized resident rows never leave a successful authorized read DTO", () => {
  for (const mode of ["revision", "size"] as const) {
    const e = create(),
      lease = e.gs.AuthorizeConnection(e.target, e.ids);
    e.users[1]!.CapturePreInventory = () => ({
      Revision: mode === "revision" ? 1 : 0,
      Rows: mode === "size" ? Array(31).fill(PreRow()) : [],
    });
    expect(() => e.gs.CaptureAuthorizedPreInventory(e.target, lease)).toThrow(
      "snapshot",
    );
    expect(e.target.m_aUser).toEqual([]);
    expect(e.source.m_aUser).toEqual(e.users);
  }
});

test("GS rebinds authorized paired DTO identities and rejects an accidentally wrong SECOND owner BEFORE account reads", () => {
  const e = create(),
    capture = e.gs.CaptureAuthorizedInventory.bind(e.gs);
  let reads = 0;
  e.gs.CaptureAuthorizedInventory = (socket, lease) =>
    capture(socket, lease).map((r, i) => (i ? { ...r, ID: "WrongOwner" } : r));
  e.db.GetUserInfo = () => {
    reads++;
    throw new Error("MUST NOT read after resident owner mismatch");
  };
  expect(() => e.run()).toThrow("owner mismatch");
  expect(reads).toBe(0);
  expect(e.target.packets).toEqual([]);
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.target.m_aUser).toEqual([]);
});

test("ACTUAL GS invalid group authorization precedes ALL pre getters, account/inventory reads and any outgoing encoding", () => {
  const e = create();
  let pre = 0,
    account = 0,
    inventory = 0,
    encodes = 0;
  for (const u of e.users) {
    const capture = u.CapturePreInventory.bind(u);
    u.CapturePreInventory = () => {
      pre++;
      return capture();
    };
  }
  e.db.GetUserInfo = () => {
    account++;
    throw new Error("no account read");
  };
  e.db.LoadInventory = () => {
    inventory++;
    throw new Error("no inventory read");
  };
  e.target.text.Encode = () => {
    encodes++;
    throw new Error("no encoding");
  };
  expect(() =>
    e.run(
      false,
      e.target,
      e.ids.map((id, i) => (i ? { ...id, GuildSn: 999 } : id)),
    ),
  ).toThrow("transfer");
  expect([pre, account, inventory, encodes]).toEqual([0, 0, 0, 0]);
  expect(e.target.packets).toEqual([]);
  expect(e.target.m_aUser).toEqual([]);
  expect(e.source.m_aUser).toEqual(e.users);
});
