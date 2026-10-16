import { afterEach, expect, test } from "bun:test";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { CUserItemMan } from "../FXGS/CUserItemMan.ts";
import { PlanInitUserInventory } from "../FXGS/UserInventory.ts";
import { CBaseSession } from "../FXGS/CBaseSession.ts";
import { CUser } from "../Common/CUser.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CSendPacketBase } from "../Common/CSendPacketBase.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import {
  CopyUserInventoryRecord,
  CopyUserInventory,
  PutSlotAccessoryList,
  PutInventoryList,
  type UserInventory,
  type UserInventoryRecord,
} from "../Common/UserInventory.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import {
  ModelText,
  ModelDefinition,
  ModelRecord,
  ModelResident,
  ModelUser,
  NativeInventory,
  InventoryVectors as vectors,
} from "./helpers/UserInventory.ts";
import { UserInfo } from "./helpers/Accounts.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function db() {
  const s = new CDBSession(":memory:");
  cleanup.push(() => s.Close());
  return new CDBMan(s);
}
function catalog() {
  const d = db();
  d.GetUserItemList = () => [
    {
      SN: 7,
      Category: 2,
      strAttr: "Item/Fixture",
      nAttr1: 1,
      nAttr2: 0,
      nAttr3: -1,
      strName: "NOT owned Verbose",
    },
  ];
  return { d, m: new CUserItemMan(d) };
}
function user() {
  return new CUser(UserInfo("Native"), 17);
}
function full(
  u: CUser,
  text = new CTextCodec(),
  cipher: CipherDegree = CipherDegree.CRC8,
) {
  const p = new CSendPacket(201, cipher, text);
  u.MakeUserInventoryPacket(p);
  return p.GetBuffer();
}
function nativeSN(row: ReturnType<CUser["GetUserInventory"]>) {
  return row && "ItemSn" in row ? row.ItemSn : null;
}

test("72 fixed read-only PE anchors bind native rowset/level/date/count/queries/201/105, and dangerous native SetLocalTime is evidence ONLY, never executed", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(72);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(
    pe.read(vectors.SelectEvidence.VA, vectors.SelectEvidence.Text.length + 1),
  ).toEqual(Buffer.from(vectors.SelectEvidence.Text + "\0"));
  expect(vectors.SelectEvidence.Text).toBe(
    "ItemSn,Slot,Amount,DateCreated,LevelCreated,StockSn,Verbose",
  );
});

test("ALL1768 independent C++ native inventory projections:256 categories, signed16 level thresholds, strict raw DATE, matched-row clocks, missing/expired/counter boundaries, immutable copied metadata and delete ATTEMPTS only", () => {
  expect(vectors.Cases).toHaveLength(1768);
  const d = db();
  let images = 0;
  for (const c of vectors.Cases) {
    const text = ModelText(c),
      reader = new CDBMan(d.session, text);
    reader.GetUserItemList = () =>
      c.Definitions.map((r) => ModelDefinition(r, text));
    const man = new CUserItemMan(reader),
      snapshot = man.CaptureSnapshot();
    let clocks = 0;
    const input = c.Records.map((r) => ModelRecord(r, text)),
      before = JSON.stringify(input);
    const plan = PlanInitUserInventory(
      input,
      snapshot,
      c.Level,
      () => {
        const h = c.ClockHex[Math.min(clocks++, c.ClockHex.length - 1)];
        if (h === undefined) throw new Error("MUST NOT sample clock");
        return Buffer.from(h, "hex").readDoubleLE();
      },
      text,
    );
    expect(plan).toEqual({
      CatalogRevision: 1,
      Rows: c.Expected.Rows.map((r) => ModelResident(r, text)),
      Equipment: c.Expected.Equipment,
      DeleteAttempts: c.Expected.DeleteAttempts,
      MissingDefinitionRows: c.Expected.MissingDefinitionRows,
      RowsetReads: c.Expected.RowsetReads,
      FetchedRows: c.Expected.FetchedRows,
      CountedRows: c.Expected.CountedRows,
      ClockReads: c.Expected.ClockReads,
    });
    expect(clocks).toBe(c.Expected.ClockReads);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.Rows)).toBe(true);
    expect(plan.Rows.every(Object.isFrozen)).toBe(true);
    images++;
  }
  expect(images).toBe(1768);
});

test("ALL1768 images also consume REAL CUser native first-match/functional/loaded/decoration queries and exact201, WORD inventory list, accessory body and self/nonself105; not just a planner self-comparison", () => {
  let full105 = 0;
  for (const c of vectors.Cases) {
    const text = ModelText(c),
      u = ModelUser(c),
      rows = c.Expected.Rows.map((r) => ModelResident(r, text));
    u.InstallUserInventory(rows, c.Expected.Equipment, text);
    expect(nativeSN(u.GetUserInventory(c.SNProbe))).toBe(c.Expected.FirstSN);
    expect(
      u.GetUserInventoryFromAll(text.Decode(Buffer.from(c.AttributeHex, "hex")))
        ?.ItemSn ?? null,
    ).toBe(c.Expected.FromAllSN);
    expect(
      u.HasFunctionalItem(text.Decode(Buffer.from(c.AttributeHex, "hex"))),
    ).toBe(c.Expected.Functional);
    expect(u.GetInventoryLoaded(c.CategoryProbe)?.ItemSn ?? null).toBe(
      c.Expected.LoadedSN,
    );
    expect(u.GetSlotDecorationLoaded(c.PositionProbe)?.ItemSn ?? null).toBe(
      c.Expected.SlotDecoSN,
    );
    expect(u.GetCharDecoLoaded(c.PositionProbe)?.ItemSn ?? null).toBe(
      c.Expected.CharDecoSN,
    );
    expect(full(u, text).toString("hex")).toBe(c.Expected.InventoryHex);
    expect(full(u, text, CipherDegree.None).toString("hex")).toBe(
      c.Expected.PlainInventoryHex,
    );
    const category = new CSendPacketBase(undefined, CipherDegree.CRC8, text);
    u.MakeInventoryPacket(category, c.CategoryProbe);
    expect(category.GetBuffer().toString("hex")).toBe(c.Expected.FilteredHex);
    const body = new CSendPacketBase(undefined, CipherDegree.CRC8, text);
    PutSlotAccessoryList(body, u.CaptureUserInventory()!.Rows, 3);
    expect(body.GetBuffer().toString("hex")).toBe(c.Expected.AccessoryHex);
    const dynamic = u.GetDynamicInfoSnapshot();
    expect([
      dynamic.FakeLevel,
      dynamic.LevelIconEnabled,
      dynamic.LevelIconSN,
    ]).toEqual([
      c.Expected.FakeLevelAfter,
      c.Expected.IconEnabledAfter,
      c.Expected.IconSNAfter,
    ]);
    expect([dynamic.DynamicModified, dynamic.SimpleInfoModified]).toEqual([
      0, 0,
    ]);
    if (c.Expected.Self105Hex !== null) {
      expect(c.Expected.Other105Hex).not.toBeNull();
      expect(u.GetLevel()).toBe(c.Level);
      expect(u.GetLookLevel()).toBe(c.Expected.LookLevelAfter);
      const room = new CBaseSession(0, 1, text);
      room.m_rgPlayer[3] = u;
      room.m_rgSlotInfo[3]!.set([1, 2, 3]);
      expect(
        room.MakeSetPlayerPacket(3, true).GetBuffer().toString("hex"),
      ).toBe(c.Expected.Self105Hex);
      expect(
        room.MakeSetPlayerPacket(3, false).GetBuffer().toString("hex"),
      ).toBe(c.Expected.Other105Hex!);
      full105++;
    }
  }
  expect(full105).toBeGreaterThan(1600);
});

test("a captured CUserItemMan generation remains old across successful reload in a native matched-row CLOCK callback; no mixed metadata or SQL requery mid-load", () => {
  const { d, m } = catalog(),
    old = m.CaptureSnapshot();
  let sampled = 0;
  const plan = PlanInitUserInventory(
    [NativeInventory(), NativeInventory()],
    old,
    1,
    () => {
      if (sampled++ === 0) {
        d.GetUserItemList = () => [
          {
            SN: 7,
            Category: 6,
            strAttr: "changed",
            nAttr1: 99,
            nAttr2: 2,
            nAttr3: 3,
            strName: "new",
          },
        ];
        m.UpdateUserItemTable();
      }
      return 1;
    },
  );
  expect(sampled).toBe(2);
  expect(plan.Rows.map((r) => [r.Category, r.strAttr, r.nAttr1])).toEqual([
    [2, "Item/Fixture", 1],
    [2, "Item/Fixture", 1],
  ]);
  expect(plan.CatalogRevision).toBe(1);
  expect(m.GetState().Revision).toBe(2);
  expect(old.GetUserItem(7)!.Category).toBe(2);
  expect(m.CaptureSnapshot().GetUserItem(7)!.Category).toBe(6);
  expect(Object.isFrozen(old)).toBe(true);
  d.GetUserItemList = () => {
    throw new Error("MUST NOT QUERY");
  };
  expect(old.GetUserItem(7)).toBeDefined();
  for (const key of [NaN, Infinity, -2147483649, 4294967296, 1.5])
    expect(() => old.GetUserItem(key)).toThrow();
});

test("400 counts missing+accepted, NOT deleted; GetNextRow is attempted BEFORE the bound and even known level expiry must still sample current DATE", () => {
  const { m } = catalog();
  let calls = 0;
  const rows = [
    ...Array.from({ length: 1000 }, () => NativeInventory({ DateCreated: 0 })),
    ...Array.from({ length: 401 }, () => NativeInventory()),
  ];
  const p = PlanInitUserInventory(rows, m.CaptureSnapshot(), 1, () => {
    calls++;
    return 1;
  });
  expect([
    p.Rows.length,
    p.DeleteAttempts.length,
    p.CountedRows,
    p.FetchedRows,
    p.RowsetReads,
    calls,
  ]).toEqual([400, 1000, 400, 1401, 1401, 1400]);
  expect(p.DeleteAttempts.every((d) => d.ItemSn === 7)).toBe(true);
  let clock = 0;
  const expired = PlanInitUserInventory(
    [NativeInventory({ LevelCreated: 65535 })],
    m.CaptureSnapshot(),
    1,
    () => {
      clock++;
      return 1;
    },
  );
  expect(clock).toBe(1);
  expect(expired.DeleteAttempts).toEqual([
    { RowIndex: 0, ItemSn: 7, LevelExpired: true, DateExpired: false },
  ]);
  expect(() =>
    PlanInitUserInventory(
      [NativeInventory({ LevelCreated: 0 })],
      m.CaptureSnapshot(),
      1,
      () => {
        throw new Error("clock required");
      },
    ),
  ).toThrow("clock required");
});

test("raw f64 DATE is not Unix time/permanent zero: equality survives, strictly later expires, signed zero bits survive201, no post-residency expiry/amount filtering", () => {
  const { m } = catalog(),
    r = NativeInventory({ DateCreated: 0 });
  expect(
    PlanInitUserInventory([r], m.CaptureSnapshot(), 1, () => 0).Rows,
  ).toHaveLength(1);
  expect(
    PlanInitUserInventory([r], m.CaptureSnapshot(), 1, () => Number.MIN_VALUE)
      .Rows,
  ).toHaveLength(0);
  const u = user();
  u.InstallUserInventory([
    NativeInventory({ DateCreated: -0, Amount: 0, Slot: 255 }),
  ]);
  expect(u.HasFunctionalItem("Item/Fixture")).toBe(true);
  expect(u.GetUserInventory(7)!.Amount).toBe(0);
  expect(full(u).subarray(-8).toString("hex")).toBe("0000000000000080");
  expect(u.GetInventoryLoaded(2)).toBeUndefined();
});

test("record copying preserves unsigned ItemSn/StockSn and signed DWORD/SHORT bits without fabricating quantity/stock/template/date defaults", () => {
  const raw = NativeInventory({
      ItemSn: 0xffffffff,
      StockSn: 0x80000000,
      Amount: 0xffffffff,
      LevelCreated: 65535,
      nAttr1: 0xffffffff,
      nAttr2: 0x80000000,
      strAttr: "",
      Verbose: "",
    }),
    copy = CopyUserInventory(raw);
  expect([
    copy.ItemSn,
    copy.StockSn,
    copy.Amount,
    copy.LevelCreated,
    copy.nAttr1,
    copy.nAttr2,
  ]).toEqual([4294967295, 2147483648, -1, -1, -1, -2147483648]);
  expect(raw.Amount).toBe(4294967295);
  expect(Object.isFrozen(copy)).toBe(true);
  for (const patch of [
    { ItemSn: -1 },
    { ItemSn: 4294967296 },
    { StockSn: NaN },
    { Slot: 256 },
    { Amount: -2147483649 },
    { Amount: 4294967296 },
    { LevelCreated: -32769 },
    { LevelCreated: 65536 },
    { DateCreated: NaN },
    { DateCreated: Infinity },
    { Verbose: "a\0b" },
    { Verbose: "A".repeat(4097) },
    { Category: 256 },
    { nAttr1: 4294967296 },
    { strAttr: "a\0b" },
    { strAttr: "A".repeat(4097) },
    { Modified: 2 },
  ])
    expect(() => CopyUserInventory({ ...raw, ...patch })).toThrow();
  for (const raw of [undefined, null, [], "row", 17])
    expect(() => CopyUserInventoryRecord(raw)).toThrow();
});

test("modern whole-input validation rejects a bad UNUSED tail BEFORE clocks, catalog-identity mismatch/nonfinite clock rejects whole plan, and trusted work bound is explicit not native400", () => {
  const { m } = catalog();
  let reads = 0;
  const source = Array.from({ length: 401 }, () =>
    NativeInventory(),
  ) as UserInventoryRecord[];
  source[400] = { ...source[400]!, Verbose: "invalid\0tail" };
  expect(() =>
    PlanInitUserInventory(source, m.CaptureSnapshot(), 1, () => {
      reads++;
      return 1;
    }),
  ).toThrow();
  expect(reads).toBe(0);
  expect(() =>
    PlanInitUserInventory(
      Array<UserInventoryRecord>(
        RuntimePolicy.MaxNativeInventoryLoadRows + 1,
      ).fill(NativeInventory()),
      m.CaptureSnapshot(),
      1,
      () => 1,
    ),
  ).toThrow("input limit");
  const max = PlanInitUserInventory(
    Array<UserInventoryRecord>(RuntimePolicy.MaxNativeInventoryLoadRows).fill(
      NativeInventory(),
    ),
    m.CaptureSnapshot(),
    1,
    () => 1,
  );
  expect([max.Rows.length, max.FetchedRows]).toEqual([400, 401]);
  for (const n of [NaN, Infinity, -Infinity])
    expect(() =>
      PlanInitUserInventory(
        [NativeInventory()],
        m.CaptureSnapshot(),
        1,
        () => n,
      ),
    ).toThrow("current VariantTime");
  for (const n of [NaN, Infinity, 1.5, -2147483649, 2147483648])
    expect(() =>
      PlanInitUserInventory([], m.CaptureSnapshot(), n, () => 1),
    ).toThrow("cached level");
  expect(() =>
    PlanInitUserInventory(
      [NativeInventory()],
      {
        Revision: 1,
        Count: 1,
        GetUserItem: () => ({
          SN: 8,
          Category: 2,
          strAttr: "x",
          nAttr1: 0,
          nAttr2: 0,
          nAttr3: 0,
          strName: "x",
        }),
      },
      1,
      () => 1,
    ),
  ).toThrow("identity");
});

test("resident install is all-or-nothing/frozen/detached; later source edits, late bad row or invalid equipment cannot partially change rows, icon/fake-level or revision", () => {
  const u = user(),
    source = [NativeInventory()];
  u.InstallUserInventory(source, { FakeLevel: 4, LevelIconSN: 0xffffffff });
  const old = u.CaptureUserInventory()!,
    state = u.GetDynamicInfoSnapshot(),
    frame = full(u);
  Object.assign(source[0]!, { Amount: 99 });
  source.push(NativeInventory({ ItemSn: 8 }));
  expect(full(u)).toEqual(frame);
  expect(() => Object.assign(old.Rows[0]!, { Amount: 8 })).toThrow();
  expect(Object.isFrozen(old.Rows)).toBe(true);
  for (const install of [
    () =>
      u.InstallUserInventory([
        NativeInventory(),
        NativeInventory({ Category: 256 }),
      ]),
    () =>
      u.InstallUserInventory([NativeInventory()], { FakeLevel: 2147483648 }),
    () =>
      u.InstallUserInventory([NativeInventory()], { LevelIconSN: 4294967296 }),
    () =>
      u.InstallUserInventory(Array<UserInventory>(401).fill(NativeInventory())),
  ]) {
    expect(install).toThrow();
    expect(u.CaptureUserInventory()).toEqual(old);
    expect(u.GetDynamicInfoSnapshot()).toEqual(state);
    expect(full(u)).toEqual(frame);
  }
});

test("native mode never silently replaces nonempty legacy inventory; authoritative legacy reload abandons native fields WITHOUT reinterpreting matching ItemID or granting equipment", () => {
  const u = user(),
    legacy = {
      SN: 7,
      ID: "Native",
      ItemID: 7,
      Slot: 0,
      Amount: 9,
      ExpireDate: 0,
      Verbose: "Item/Fixture",
      CreatedAt: 0,
    };
  u.m_aInventory = [legacy];
  expect(() =>
    u.InstallUserInventory([NativeInventory()], {
      FakeLevel: 7,
      LevelIconSN: 7,
    }),
  ).toThrow("mix");
  expect(u.GetUserInventory(7)).toBe(legacy);
  expect(u.HasFunctionalItem("Item/Fixture")).toBe(false);
  expect(u.GetInventoryLoaded(2)).toBeUndefined();
  u.m_aInventory = [];
  u.InstallUserInventory([NativeInventory()], {
    FakeLevel: 7,
    LevelIconSN: 0xffffffff,
  });
  const generation = u.GetUserInventoryGeneration().Revision;
  u.m_aInventory = [legacy];
  expect(u.GetUserInventoryGeneration()).toEqual({
    Native: false,
    Revision: generation + 1,
  });
  expect(u.GetUserInventory(7)).toBe(legacy);
  expect(u.GetDynamicInfoSnapshot()).toMatchObject({
    FakeLevel: 0,
    LevelIconEnabled: 0,
    LevelIconSN: 0,
  });
  expect(u.CaptureUserInventory()).toBeUndefined();
});

test("AddInventory clears ONLY new native dirty flag, GetUserInventory(-1) finds first unsigned ItemSn not StockSn, consume keeps exhausted0 resident and preserves old snapshot", () => {
  const u = user(),
    row = NativeInventory({ ItemSn: 0xffffffff, StockSn: 17, Modified: 1 });
  u.AddInventory(row);
  u.AddInventory({ ...row, Amount: 99 });
  const old = u.CaptureUserInventory()!,
    first = u.GetUserInventory(-1)!;
  expect(first.Amount).toBe(3);
  expect(u.IsInventoryModified(-1)).toBe(0);
  expect(row.Modified).toBe(1);
  expect(u.GetUserInventory(17)).toBeUndefined();
  u.ConsumeUserInventory(-1, 3);
  expect(u.GetUserInventory(-1)!.Amount).toBe(0);
  expect(u.IsInventoryModified(-1)).toBe(1);
  expect(u.CaptureUserInventory()!.Rows[1]!.Amount).toBe(99);
  expect(old.Rows[0]!.Amount).toBe(3);
  expect(u.HasFunctionalItem("Item/Fixture")).toBe(true);
  expect(u.GetUserInventoryFromAll("Item/Fixture")!.Amount).toBe(0);
  const after = u.CaptureUserInventory();
  for (const quantity of [0, -1, 0.5, 256, NaN])
    expect(() => u.ConsumeUserInventory(-1, quantity)).toThrow();
  expect(u.CaptureUserInventory()).toEqual(after);
  for (const sn of [NaN, Infinity, -2147483649, 4294967296, 0.5])
    expect(() => u.GetUserInventory(sn)).toThrow();
});

test("resident reload/consume/legacy replacement reentry from a trusted codec is rejected; revision exhaustion occurs BEFORE codec calls or any publication", () => {
  for (const kind of ["native", "legacy", "consume"]) {
    const u = user();
    u.InstallUserInventory([NativeInventory()]);
    const before = u.CaptureUserInventory(),
      text = new CTextCodec(),
      encode = text.Encode.bind(text);
    text.Encode = (value) => {
      if (kind === "native") u.InstallUserInventory([]);
      else if (kind === "legacy") u.m_aInventory = [];
      else u.ConsumeUserInventory(7, 1);
      return encode(value);
    };
    expect(() =>
      u.InstallUserInventory([NativeInventory({ ItemSn: 8 })], {}, text),
    ).toThrow("Reentrant");
    expect(u.CaptureUserInventory()).toEqual(before);
    u.InstallUserInventory([NativeInventory({ ItemSn: 9 })]);
    expect(u.GetUserInventory(9)).toBeDefined();
  }
  const u = user();
  u.InstallUserInventory([NativeInventory()]);
  Reflect.set(u, "m_nUserInventoryRevision", 0xffffffff);
  const text = new CTextCodec();
  text.Encode = () => {
    throw new Error("MUST NOT ENCODE");
  };
  expect(() => u.InstallUserInventory([], {}, text)).toThrow("exhausted");
  expect(() => u.ConsumeUserInventory(7, 1)).toThrow("exhausted");
  expect(u.GetUserInventory(7)!.Amount).toBe(3);
});

test("native serializers preserve caller cipher/codepage and prefix on unrepresentable/full-body/caller-prefix errors; detached buffers never corrupt later201", () => {
  const u = user(),
    utf8 = new CTextCodec("utf8");
  u.InstallUserInventory([NativeInventory({ Verbose: "🎮" })], {}, utf8);
  const p = new CSendPacket(201).Encode1(17),
    before = p.GetBuffer();
  expect(() => u.MakeUserInventoryPacket(p)).toThrow("representable");
  expect(p.GetBuffer()).toEqual(before);
  u.InstallUserInventory(
    Array.from({ length: 20 }, (_, i) =>
      NativeInventory({ ItemSn: i, Verbose: "A".repeat(4096) }),
    ),
  );
  expect(() => u.MakeUserInventoryPacket(p)).toThrow("too long");
  expect(p.GetBuffer()).toEqual(before);
  u.InstallUserInventory([NativeInventory()]);
  const original = full(u),
    corrupt = full(u);
  corrupt.fill(0);
  expect(full(u)).toEqual(original);
  expect(full(u, new CTextCodec(), CipherDegree.CRC32)).toEqual(original);
  for (const append of [
    (p: CSendPacketBase) => u.MakeUserInventoryPacket(p),
    (p: CSendPacketBase) =>
      PutInventoryList(p, u.CaptureUserInventory()!.Rows, 2),
    (p: CSendPacketBase) =>
      PutSlotAccessoryList(p, u.CaptureUserInventory()!.Rows, 3),
  ]) {
    const p = new CSendPacketBase(undefined, CipherDegree.CRC8).EncodeBuffer(
        Buffer.alloc(65535),
      ),
      before = p.GetBuffer();
    expect(() => append(p)).toThrow();
    expect(p.GetBuffer()).toEqual(before);
  }
});

test("native201 and self/nonself105 each capture ONE generation across a caller string-codec reload, including self BYTE, fake-level/icon and accessory footer", () => {
  const u = user(),
    text = new CTextCodec();
  u.InstallUserInventory(
    [
      NativeInventory({ Category: 4, nAttr1: 17 }),
      NativeInventory({ ItemSn: 9, Category: 14, nAttr3: -1 }),
    ],
    { FakeLevel: 3, LevelIconSN: 0xffffffff },
  );
  const room = new CBaseSession(0, 1, text);
  room.m_rgPlayer[3] = u;
  const old105 = room.MakeSetPlayerPacket(3, true).GetBuffer(),
    old201 = full(u, text),
    encode = text.Encode.bind(text);
  let fired = false;
  text.Encode = (value) => {
    if (!fired) {
      fired = true;
      u.InstallUserInventory(
        [
          NativeInventory({ Category: 4, nAttr1: 99 }),
          NativeInventory({ ItemSn: 9, Category: 14, nAttr3: 123 }),
        ],
        { FakeLevel: 8, LevelIconSN: 9 },
      );
    }
    return encode(value);
  };
  expect(room.MakeSetPlayerPacket(3, true).GetBuffer()).toEqual(old105);
  expect(u.GetFakeLevel()).toBe(8);
  expect(room.MakeSetPlayerPacket(3, true).GetBuffer()).not.toEqual(old105);
  fired = false;
  const current = full(u, text);
  fired = false;
  text.Encode = (value) => {
    if (!fired) {
      fired = true;
      u.InstallUserInventory([]);
    }
    return encode(value);
  };
  expect(full(u, text)).toEqual(current);
  expect(full(u, text)).not.toEqual(old201);
  const vacant = new CSendPacket(105);
  room.MakeSlotAccessoryPacket(7, vacant);
  expect(vacant.GetBuffer()).toEqual(new CSendPacket(105).GetBuffer());
  expect(() => PutSlotAccessoryList(vacant, [], 256)).toThrow();
});

// Public legacy array compatibility must not allow a shadow layout in native mode.
test("native mode seals/detaches its empty legacy view against accidental push/splice; only explicit authoritative legacy replacement changes mode", () => {
  const u = user(),
    old = u.m_aInventory;
  u.InstallUserInventory([NativeInventory()]);
  const generation = u.GetUserInventoryGeneration(),
    native = u.CaptureUserInventory()!.Rows;
  const row = {
    SN: 1,
    ID: "native",
    ItemID: 7,
    Slot: 0,
    Amount: 3,
    ExpireDate: 0,
    Verbose: "legacy",
    CreatedAt: 0,
  };
  old.push(row);
  expect(u.m_aInventory).toEqual([]);
  expect(Object.isFrozen(u.m_aInventory)).toBe(true);
  expect(() => u.m_aInventory.push(row)).toThrow();
  expect(() => u.m_aInventory.splice(0, 0, row)).toThrow();
  expect(u.CaptureUserInventory()!.Rows).toBe(native);
  expect(u.GetUserInventoryGeneration()).toEqual(generation);
  u.m_aInventory = [row];
  expect(u.GetUserInventoryGeneration().Native).toBe(false);
  expect(u.GetUserInventory(1)).toBe(row);
  expect(Object.isFrozen(u.m_aInventory)).toBe(false);
});
