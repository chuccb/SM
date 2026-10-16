import { afterEach, expect, test } from "bun:test";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CDBClock } from "../Common/DB/CDBClock.ts";
import { CipherDegree, IntegerRange } from "../Common/OfficialValues.ts";
import {
  CaptureUserInventory,
  CopyUserInventory,
  CopyUserInventoryRecord,
} from "../Common/UserInventory.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { PreObservation, PreRow, PreState } from "./helpers/PreInventory.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { DBTime } from "./helpers/Calendar.ts";
import {
  InitializationVectors,
  InitializationInput,
  InitializationFixture,
  InitializationCodec,
} from "./helpers/InventoryInitialization.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(negative = false) {
  const e = InitializationFixture(negative);
  cleanup.push(e.close);
  return e;
}
function user() {
  return new CUser(UserInfo("Native"), 0x89abcdef);
}
function total(e: ReturnType<typeof create>) {
  return e.session.db
    .query<{ n: number }, []>("SELECT total_changes() n")
    .get()!.n;
}

test("24 fixed PE anchors + LS/GS level inputs prove pre-before-owned, AFTER-prefix cached level and independent30/400 counters; no supplied executable runs", () => {
  const image = new CPeImage(OFFICIAL_SERVICES.FXGS),
    login = new CPeImage(OFFICIAL_SERVICES.LS);
  expect(InitializationVectors.OfficialPE).toEqual({
    Service: "FXGS",
    SHA256: image.sha256,
  });
  expect(InitializationVectors.LevelInput).toEqual({
    LoginSHA256: login.sha256,
    GameSHA256: image.sha256,
    Entries: 450,
  });
  expect(InitializationVectors.InstructionAnchors).toHaveLength(24);
  for (const a of InitializationVectors.InstructionAnchors)
    expect(image.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(InitializationVectors.Cases).toHaveLength(131);
  expect(InitializationVectors.Model).toContain("NOT SQL/financial");
});

test("ALL131 independent observed composite cases drive REAL CDBMan/CDBClock/catalog and match stage/After/trace/rows/counters/equipment; NO SQL mutations or implicit After install", () => {
  for (const c of InitializationVectors.Cases) {
    const e = create(c.Negative),
      input = InitializationInput(c),
      before = total(e);
    e.step(c.Step);
    const result = e.db.PlanInitUserInventory(input, e.items, e.clock),
      x = c.Expected;
    expect<unknown>(result.Stage).toBe(x.Stage);
    expect(result.CatalogRevision).toBe(e.items.GetState().Revision);
    expect(result.Pre.CatalogRevision).toBe(result.CatalogRevision);
    expect(result.Pre.After).toEqual(x.After);
    expect(result.Pre.Rows).toEqual(
      x.PreRows.map((i) => input.PreRows[i]!.Row),
    );
    expect(result.Pre.MissingDefinitionRows).toEqual(x.PreMissing);
    expect([
      result.Pre.RowsetReads,
      result.Pre.FetchedRows,
      result.Pre.SuccessfulRows,
    ]).toEqual([x.PreReads, x.PreFetched, x.PreRows.length]);
    expect<unknown>(result.Pre.Events.map((v) => v.Kind)).toEqual(x.Events);
    expect(
      result.Pre.Events.flatMap((v) =>
        v.Kind === "LoadOnUserInventory" ? [v.Call.UserLevel] : [],
      ),
    ).toEqual(x.UserLevels);
    if (result.Stage === "complete") {
      expect(result.ClockRevision).toBe(1);
      expect(result.Owned.CatalogRevision).toBe(result.CatalogRevision);
      expect(
        result.Owned.Rows.map((v) => ({
          ItemSn: v.ItemSn,
          Slot: v.Slot,
          Amount: v.Amount,
          DateCreated: v.DateCreated,
          LevelCreated: v.LevelCreated,
          StockSn: v.StockSn,
          Verbose: v.Verbose,
        })),
      ).toEqual(x.Rows.map((i) => input.OwnedRows[i]!));
      expect(result.Owned.MissingDefinitionRows).toEqual(x.Missing);
      expect(
        result.Owned.DeleteAttempts.map((d) => [
          d.RowIndex,
          +d.LevelExpired,
          +d.DateExpired,
        ]),
      ).toEqual(x.Deletes);
      expect([
        result.Owned.RowsetReads,
        result.Owned.FetchedRows,
        result.Owned.CountedRows,
        result.Owned.ClockReads,
      ]).toEqual([x.Reads, x.Fetched, x.Counted, x.Clocks]);
      expect(result.Owned.Equipment).toEqual(x.Equipment);
      expect(Object.isFrozen(result.Owned.Rows)).toBe(true);
    } else {
      expect(result.Owned).toBeNull();
      expect(result.ClockRevision).toBeNull();
    }
    expect(e.reads()).toBe(1 + x.Clocks);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.Pre.After)).toBe(true);
    expect(total(e)).toBe(before);
    e.close();
    cleanup.pop();
  }
});

test("ALL35 complete model candidates use the paired TRUSTED CUser install and actual nonempty201/207 consumers in plain AND scalar modes without applying projected money/XP/auth/flush", () => {
  let complete = 0;
  for (const c of InitializationVectors.Cases) {
    if (c.Expected.Stage !== "complete") continue;
    const e = create(c.Negative);
    e.step(c.Step);
    const result = e.db.PlanInitUserInventory(
      InitializationInput(c),
      e.items,
      e.clock,
    );
    if (result.Stage !== "complete") throw new Error("model stage");
    // Explicit trusted existing account observation for packet cached level,
    // NOT application of plan.After or a money/XP grant by this initializer.
    const u = new CUser(
        UserInfo("Native", { Exp: c.Expected.After.Exp }),
        0x89abcdef,
      ),
      before = u.GetDynamicInfoSnapshot();
    u.InstallUserInventoryInitialization(
      result.Owned.Rows,
      result.Pre.Rows,
      result.Owned.Equipment,
      e.text,
    );
    expect(u.GetDynamicInfoSnapshot().Dynamic).toEqual(before.Dynamic);
    expect(u.GetLevel()).toBe(before.Level);
    expect(u.GetDynamicInfoSnapshot().DynamicModified).toBe(
      before.DynamicModified,
    );
    expect(u.GetDynamicInfoSnapshot().GamesSinceFlush).toBe(
      before.GamesSinceFlush,
    );
    expect(u.CaptureUserInventoryInitialization().Owned!.Revision).toBe(1);
    expect(u.CaptureUserInventoryInitialization().Pre.Revision).toBe(1);
    for (const degree of [CipherDegree.None, CipherDegree.CRC8]) {
      const owned = new CSendPacket(201, degree, e.text).Encode1(1),
        pre = new CSendPacket(207, degree, e.text).Encode1(1);
      u.MakeUserInventoryPacket(owned);
      u.MakePreInventoryPacket(pre, e.items.CaptureSnapshot());
      expect<unknown>(owned.GetBuffer().toString("hex")).toBe(
        degree === CipherDegree.None
          ? c.Expected.OwnedPlainHex
          : c.Expected.OwnedScalarHex,
      );
      expect<unknown>(pre.GetBuffer().toString("hex")).toBe(
        degree === CipherDegree.None
          ? c.Expected.PrePlainHex
          : c.Expected.PreScalarHex,
      );
    }
    e.close();
    cleanup.pop();
    complete++;
  }
  expect(complete).toBe(35);
});

test("pre-open failure never touches PRE rows, owned-open/rows, or ANY clock port; owned-open failure preserves prior XP prefix observations without reading owned rows/clock", () => {
  const e = create(),
    forbid = () => {
      throw new Error("unreached observation");
    },
    initial = PreState({ Exp: 0, Level: 1 });
  const closed = {
    Initial: initial,
    PreOpened: false,
    get PreRows() {
      return forbid();
    },
    get OwnedOpened() {
      return forbid();
    },
    get OwnedRows() {
      return forbid();
    },
  };
  const clock = new Proxy(e.clock, {
    get() {
      return forbid();
    },
  });
  expect(e.db.PlanInitUserInventory(closed, e.items, clock).Stage).toBe(
    "pre-open-failed",
  );
  const failed = e.db.PlanInitUserInventory(
    {
      Initial: initial,
      PreOpened: true,
      PreRows: [PreObservation({ ItemSn: 8, Amount: 1000000 })],
      OwnedOpened: false,
      get OwnedRows() {
        return forbid();
      },
    },
    e.items,
    clock,
  );
  expect(failed.Stage).toBe("owned-open-failed");
  expect(failed.Pre.After.Exp).toBe(1000000);
  expect(failed.Pre.Events.some((v) => v.Kind === "WriteUserDynInfo")).toBe(
    true,
  );
  expect(e.reads()).toBe(1);
});

test("failed LoadOn XP STILL expires owned rows using updated cached level, NOT initial level; closed owned stage is NOT pre-effect rollback", () => {
  const e = create(),
    input = InitializationInput(
      InitializationVectors.Cases.find(
        (c) =>
          c.PreScenario === 3 &&
          c.OwnedScenario === 1 &&
          c.PreOpened &&
          c.OwnedOpened,
      )!,
    );
  const plan = e.db.PlanInitUserInventory(input, e.items, e.clock);
  expect(input.Initial.Level).toBe(1);
  expect(plan.Pre.After.Level).toBe(6);
  expect(plan.Pre.Rows).toEqual([]);
  if (plan.Stage !== "complete") throw new Error("expected complete");
  expect(plan.Owned.DeleteAttempts[0]).toEqual({
    RowIndex: 0,
    ItemSn: 7,
    LevelExpired: true,
    DateExpired: false,
  });
  expect(plan.Owned.Rows.map((r) => r.ItemSn)).toEqual([11, 12]);
  expect(input.Initial.Exp).toBe(0);
});

test("empty/missing-definition owned rows need NO synchronized clock; first known row requires it even if already level-expired", () => {
  const e = create(),
    clock = new CDBClock(() => {
      throw new Error("MUST NOT sample unsynchronized clock");
    }),
    base = InitializationInput();
  const empty = e.db.PlanInitUserInventory(
    { ...base, OwnedRows: [] },
    e.items,
    clock,
  );
  expect(empty.Stage).toBe("complete");
  expect(empty.ClockRevision).toBe(0);
  const missing = e.db.PlanInitUserInventory(
    { ...base, OwnedRows: [NativeInventory({ ItemSn: 999 })] },
    e.items,
    clock,
  );
  expect(missing.Stage).toBe("complete");
  expect(() =>
    e.db.PlanInitUserInventory(
      { ...base, OwnedRows: [NativeInventory({ LevelCreated: 1 })] },
      e.items,
      clock,
    ),
  ).toThrow("not synchronized");
});

test("same-value catalog reload during pre codec invalidates the ENTIRE composite before owned clock reads; repaired fresh observation works", () => {
  const e = create();
  let armed = true;
  e.text.hook = (value) => {
    if (armed && value === "PRE description") {
      armed = false;
      e.items.UpdateUserItemTable();
    }
  };
  expect(() =>
    e.db.PlanInitUserInventory(InitializationInput(), e.items, e.clock),
  ).toThrow("catalog generation");
  expect(e.reads()).toBe(1);
  e.text.hook = undefined;
  expect(
    e.db.PlanInitUserInventory(InitializationInput(), e.items, e.clock).Stage,
  ).toBe("complete");
});

test("late owned definition codec catalog ABA cannot return a mixed-generation candidate or partially install either vector", () => {
  const e = create();
  let armed = true;
  e.text.hook = (value) => {
    if (armed && value === "CATALOG") {
      armed = false;
      e.items.UpdateUserItemTable();
    }
  };
  expect(() =>
    e.db.PlanInitUserInventory(InitializationInput(), e.items, e.clock),
  ).toThrow("catalog generation");
  expect(e.reads()).toBe(1);
});

test("same-value DB resync from PRE or last-owned codec invalidates pinned clock generation even though no wallet/SQL effects run", () => {
  for (const when of ["PRE description", "CATALOG"]) {
    const e = create();
    let armed = true;
    e.text.hook = (value) => {
      if (armed && value === when) {
        armed = false;
        e.clock.SyncLocalTimeFromDB(
          0,
          DBTime({ hour: 0, minute: 0, second: 0 }),
        );
      }
    };
    expect(() =>
      e.db.PlanInitUserInventory(InitializationInput(), e.items, e.clock),
    ).toThrow("clock generation");
    expect(e.clock.GetState()).toEqual({ Synchronized: true, Revision: 2 });
    e.close();
    cleanup.pop();
  }
});

test("per-row clock fault retires anchor and exposes NO completed plan; recovery needs explicit sync and cannot retry pre financial effects", () => {
  const e = create(),
    input = {
      ...InitializationInput(),
      OwnedRows: [NativeInventory(), NativeInventory()],
    };
  e.sampleHook(() => {
    if (e.reads() === 3) throw new Error("late monotonic failure");
  });
  expect(() => e.db.PlanInitUserInventory(input, e.items, e.clock)).toThrow(
    "late monotonic failure",
  );
  expect(e.clock.GetState()).toEqual({ Synchronized: false, Revision: 2 });
  e.sampleHook();
  e.clock.SyncLocalTimeFromDB(0, DBTime());
  expect(e.db.PlanInitUserInventory(input, e.items, e.clock).Stage).toBe(
    "complete",
  );
});

test("CDBMan instance guard covers input getters AND codecs; a rejected nested projection does not consume/replay anything and guard resets on errors", () => {
  const e = create(),
    base = InitializationInput();
  let attempts = 0;
  const input = {
    ...base,
    get PreOpened() {
      attempts++;
      expect(() => e.db.PlanInitUserInventory(base, e.items, e.clock)).toThrow(
        "Reentrant",
      );
      return true;
    },
  };
  e.text.hook = (value) => {
    if (value === "PRE description")
      expect(() => e.db.PlanInitUserInventory(base, e.items, e.clock)).toThrow(
        "Reentrant",
      );
  };
  expect(e.db.PlanInitUserInventory(input, e.items, e.clock).Stage).toBe(
    "complete",
  );
  expect(attempts).toBe(1);
  e.text.hook = () => {
    throw new Error("injected codec failure");
  };
  expect(() => e.db.PlanInitUserInventory(base, e.items, e.clock)).toThrow(
    "codec failure",
  );
  e.text.hook = undefined;
  expect(e.db.PlanInitUserInventory(base, e.items, e.clock).Stage).toBe(
    "complete",
  );
});

test("BOTH source stages/outcome/state primitives are latched BEFORE first codec callback; caller array/row mutation cannot rebase this observation", () => {
  const e = create(),
    pre = PreObservation(),
    owned = NativeInventory({ Verbose: "OWNED" }),
    input = { ...InitializationInput(), PreRows: [pre], OwnedRows: [owned] };
  let armed = true;
  e.text.hook = () => {
    if (armed) {
      armed = false;
      Reflect.set(pre.Row, "Amount", 999);
      Reflect.set(owned, "DateCreated", 0);
      Reflect.set(input.Initial, "Level", 450);
      input.OwnedRows.length = 0;
    }
  };
  const plan = e.db.PlanInitUserInventory(input, e.items, e.clock);
  expect(plan.Pre.Before.Level).toBe(1);
  expect(plan.Pre.Rows[0]!.Amount).toBe(3);
  if (plan.Stage !== "complete") throw new Error("complete");
  expect(plan.Owned.Rows[0]!.DateCreated).toBe(50000.5);
  expect(plan.Owned.FetchedRows).toBe(1);
});

test("record/full-row captures read DATE/derived getters ONCE and latch them before codepage callbacks; failed validation cannot leak a new unvalidated DATE/attribute", () => {
  const text = new InitializationCodec(),
    raw = NativeInventory();
  let dateReads = 0,
    attrReads = 0;
  Object.defineProperty(raw, "DateCreated", {
    get() {
      dateReads++;
      return dateReads === 1 ? 123.25 : NaN;
    },
  });
  Object.defineProperty(raw, "strAttr", {
    get() {
      attrReads++;
      return attrReads === 1 ? "VALID" : "bad\0attribute";
    },
  });
  const copied = CopyUserInventory(raw, text);
  expect(copied.DateCreated).toBe(123.25);
  expect(copied.strAttr).toBe("VALID");
  expect([dateReads, attrReads]).toEqual([1, 1]);
  const mutable = NativeInventory();
  text.hook = () => {
    Reflect.set(mutable, "DateCreated", NaN);
    Reflect.set(mutable, "nAttr1", "bad");
  };
  const stable = CopyUserInventory(mutable, text);
  expect(stable.DateCreated).toBe(50000.5);
  expect(stable.nAttr1).toBe(1);
  expect(Object.isFrozen(CaptureUserInventory(stable))).toBe(true);
  text.hook = undefined;
  expect(() => CopyUserInventoryRecord(mutable, text)).toThrow("VariantTime");
});

test("malformed opened observations/bounds reject rather than truncate or sample; closed rowsets are not interpreted as malformed data", () => {
  const e = create(),
    base = InitializationInput(),
    bad = [
      { ...base, PreOpened: 1 },
      { ...base, OwnedOpened: null },
      { ...base, PreRows: {} },
      { ...base, PreRows: new Array(65537) },
      { ...base, OwnedRows: new Array(65537) },
      { ...base, OwnedRows: [NativeInventory({ DateCreated: NaN })] },
    ];
  for (const input of bad)
    expect(() =>
      e.db.PlanInitUserInventory(
        input as unknown as typeof base,
        e.items,
        e.clock,
      ),
    ).toThrow();
  expect(e.reads()).toBe(1);
});

test("paired resident publication handles empty/same-value ABA as TWO new generations; frozen atomic DTOs remain detached, presentation metadata is read-side only", () => {
  const u = user(),
    before = u.GetDynamicInfoSnapshot(),
    old = u.CaptureUserInventoryInitialization();
  expect(old.Owned).toBeNull();
  expect(old.Pre.Revision).toBe(0);
  u.InstallUserInventoryInitialization([NativeInventory()], [PreRow()], {
    FakeLevel: -17,
    LevelIconSN: 0xfedcba98,
  });
  const first = u.CaptureUserInventoryInitialization();
  expect([first.Owned!.Revision, first.Pre.Revision]).toEqual([1, 1]);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.Owned)).toBe(true);
  expect(Object.isFrozen(first.Pre.Rows[0])).toBe(true);
  expect(u.GetFakeLevel()).toBe(-17);
  expect(u.GetLevelIconSn()).toBe(0xfedcba98 | 0);
  expect(u.GetDynamicInfoSnapshot().Dynamic).toEqual(before.Dynamic);
  u.InstallUserInventoryInitialization(first.Owned!.Rows, first.Pre.Rows);
  expect([
    u.GetUserInventoryGeneration().Revision,
    u.GetPreInventoryGeneration(),
  ]).toEqual([2, 2]);
  u.InstallUserInventoryInitialization([], []);
  expect([
    u.GetUserInventoryGeneration().Revision,
    u.GetPreInventoryGeneration(),
  ]).toEqual([3, 3]);
  expect(first.Owned!.Rows).toHaveLength(1);
  expect(first.Pre.Rows).toHaveLength(1);
  expect(old.Owned).toBeNull();
  expect(u.CaptureUserInventoryInitialization().Owned!.Rows).toEqual([]);
});

test("either exhausted generation refuses paired replacement BEFORE codecs with neither vector/revision/equipment modified; no wrap or half install", () => {
  for (const field of ["m_nUserInventoryRevision", "m_nPreInventoryRevision"]) {
    const u = user();
    u.InstallUserInventoryInitialization([NativeInventory()], [PreRow()]);
    Reflect.set(u, field, IntegerRange.UInt32Maximum);
    const before = u.CaptureUserInventoryInitialization(),
      dynamic = u.GetDynamicInfoSnapshot(),
      text = new InitializationCodec();
    text.hook = () => {
      throw new Error("MUST NOT encode exhausted generation");
    };
    expect(() =>
      u.InstallUserInventoryInitialization([], [], { FakeLevel: 55 }, text),
    ).toThrow("exhausted");
    expect(u.CaptureUserInventoryInitialization()).toEqual(before);
    expect(u.GetDynamicInfoSnapshot()).toEqual(dynamic);
  }
});

test("preflight of invalid SECOND list is atomic: no owned vector/revision/presentation change, even after owned rows encoded successfully", () => {
  const u = user();
  u.InstallUserInventoryInitialization([NativeInventory()], [PreRow()]);
  const pair = u.CaptureUserInventoryInitialization(),
    before = u.GetDynamicInfoSnapshot(),
    codec = new InitializationCodec();
  let ownedEncoded = 0;
  codec.hook = (v) => {
    if (v === "new owned") ownedEncoded++;
  };
  expect(() =>
    u.InstallUserInventoryInitialization(
      [NativeInventory({ Verbose: "new owned" })],
      [PreRow({ Description: "bad\0description" })],
      { FakeLevel: 55 },
      codec,
    ),
  ).toThrow("NUL");
  expect(ownedEncoded).toBeGreaterThan(0);
  expect(u.CaptureUserInventoryInitialization()).toEqual(pair);
  expect(u.GetDynamicInfoSnapshot()).toEqual(before);
});

test("paired preflight rejects nonempty legacy or over30/400 lists before callbacks; no SN/ItemID reinterpretation and old empty legacy references are detached", () => {
  const u = user(),
    old = u.m_aInventory,
    codec = new InitializationCodec();
  codec.hook = () => {
    throw new Error("MUST NOT encode");
  };
  expect(() =>
    u.InstallUserInventoryInitialization(new Array(401), [], {}, codec),
  ).toThrow("capacity");
  expect(() =>
    u.InstallUserInventoryInitialization([], new Array(31), {}, codec),
  ).toThrow("capacity");
  u.m_aInventory.push({
    SN: 1,
    ID: "Native",
    CreatedAt: 0,
    ItemID: 7,
    Slot: 255,
    Amount: 1,
    ExpireDate: 0,
    Verbose: "legacy",
  });
  expect(() => u.InstallUserInventoryInitialization([], [], {}, codec)).toThrow(
    "native/legacy",
  );
  expect(u.CaptureUserInventoryInitialization().Owned).toBeNull();
  expect(u.GetPreInventoryGeneration()).toBe(0);
  u.m_aInventory = [];
  const empty = u.m_aInventory;
  u.InstallUserInventoryInitialization([], []);
  empty.push({ ...old[0]! });
  expect(u.m_aInventory).toEqual([]);
  expect(Object.isFrozen(u.m_aInventory)).toBe(true);
});

test("paired copy guard covers array length getters, codecs and all supported inventory mutators; no reentrant half-pair, guard releases after failure", () => {
  const u = user();
  u.InstallUserInventoryInitialization([NativeInventory()], [PreRow()]);
  const before = u.CaptureUserInventoryInitialization(),
    codec = new InitializationCodec();
  let blocked = 0;
  const mutations = [
    () => u.InstallUserInventory([], {}),
    () => u.InstallPreInventory([]),
    () => u.InstallUserInventoryInitialization([], []),
    () => u.ConsumeUserInventory(7, 1),
    () => {
      u.m_aInventory = [];
    },
  ];
  const verify = () => {
    for (const f of mutations) {
      try {
        f();
      } catch (e) {
        if (e instanceof Error && e.message.includes("Reentrant")) blocked++;
        else throw e;
      }
    }
  };
  const rows = new Proxy([NativeInventory()], {
    get(target, key, receiver) {
      if (key === "length") verify();
      return Reflect.get(target, key, receiver);
    },
  });
  codec.hook = () => {
    verify();
    expect(u.CaptureUserInventoryInitialization()).toEqual(before);
  };
  u.InstallUserInventoryInitialization(rows, [PreRow()], {}, codec);
  expect(blocked).toBeGreaterThanOrEqual(5);
  codec.hook = () => {
    throw new Error("fail both lists");
  };
  const after = u.CaptureUserInventoryInitialization();
  expect(() =>
    u.InstallUserInventoryInitialization([], [PreRow()], {}, codec),
  ).toThrow("fail both lists");
  expect(u.CaptureUserInventoryInitialization()).toEqual(after);
  u.InstallPreInventory([]);
  u.InstallUserInventory([]);
  expect(u.CaptureUserInventoryInitialization().Owned!.Rows).toEqual([]);
});

test("ALL owned/pre row primitives are captured before first paired codec callback; no same-value mutable input aliases survive", () => {
  const u = user(),
    owned = [NativeInventory(), NativeInventory({ Verbose: "second" })],
    pre = [PreRow()],
    codec = new InitializationCodec();
  let armed = true;
  codec.hook = () => {
    if (armed) {
      armed = false;
      Reflect.set(owned[1]!, "DateCreated", NaN);
      Reflect.set(pre[0]!, "Description", "changed");
    }
  };
  u.InstallUserInventoryInitialization(owned, pre, {}, codec);
  const pair = u.CaptureUserInventoryInitialization();
  expect(pair.Owned!.Rows[1]!.DateCreated).toBe(50000.5);
  expect(pair.Pre.Rows[0]!.Description).toBe("PRE description");
  expect(Object.isFrozen(pair.Owned!.Rows)).toBe(true);
  expect(Object.isFrozen(pair.Pre.Rows)).toBe(true);
});

test("CDBMan rejects another DB manager's catalog BEFORE any input/clock observation; read-side snapshots are not cross-server/provider capabilities", () => {
  const first = create(),
    second = create();
  const input = new Proxy(InitializationInput(), {
    get() {
      throw new Error("MUST NOT read wrong-owner input");
    },
  });
  const clock = new Proxy(first.clock, {
    get() {
      throw new Error("MUST NOT access wrong-owner clock");
    },
  });
  expect(() =>
    first.db.PlanInitUserInventory(input, second.items, clock),
  ).toThrow("catalog owner mismatch");
  expect(first.reads()).toBe(1);
  expect(
    first.db.PlanInitUserInventory(
      InitializationInput(),
      first.items,
      first.clock,
    ).Stage,
  ).toBe("complete");
});

test("returned plan is a detached observation, NOT an installer/capability: later catalog/clock generations do not mutate it or any live user's dynamic/pair state", () => {
  const e = create(),
    u = user(),
    before = u.CaptureUserInventoryInitialization(),
    dynamic = u.GetDynamicInfoSnapshot();
  const plan = e.db.PlanInitUserInventory(
      InitializationInput(),
      e.items,
      e.clock,
    ),
    encoded = JSON.stringify(plan);
  e.items.UpdateUserItemTable();
  e.clock.SyncLocalTimeFromDB(0, DBTime());
  expect(JSON.stringify(plan)).toBe(encoded);
  expect(u.CaptureUserInventoryInitialization()).toEqual(before);
  expect(u.GetDynamicInfoSnapshot()).toEqual(dynamic);
  expect("Apply" in plan).toBe(false);
  expect("Retry" in plan).toBe(false);
});
