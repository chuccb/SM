import { expect, test } from "bun:test";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import {
  CopyPreInventory,
  PutPreInventoryList,
  type PreInventory,
} from "../Common/PreInventory.ts";
import { PlanInitPreInventory } from "../FXGS/PreInventory.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import {
  PreVectors,
  PreText,
  PreRecord,
  PreCatalog,
  PreObservation,
  PreRow,
  PreState,
  type PreInventoryVector,
} from "./helpers/PreInventory.ts";

function project(c: PreInventoryVector) {
  const text = PreText(c);
  return PlanInitPreInventory(
    c.Input.map((o) => ({ ...o, Row: PreRecord(o.Row, text) })),
    PreCatalog(c.Definitions),
    c.Initial,
    c.Opened,
    text,
  );
}
function user() {
  return new CUser(UserInfo("Native", { Exp: 250, Money: 37 }), 0x89abcdef);
}
function packet(u: CUser, category = 2, text = new CTextCodec()) {
  const p = new CSendPacket(207, undefined, text).Encode1(1);
  u.MakePreInventoryPacket(p, PreCatalog([{ SN: 7, Category: category }]));
  return p.GetBuffer();
}

test("54 fixed PE anchors bind ten-column native pre rows, prefix effects, success30 and207; supplied PE/SQL/Windows APIs are NEVER executed", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(PreVectors.OfficialPE.SHA256);
  const login = new CPeImage(OFFICIAL_SERVICES.LS),
    count = pe.read(pe.symbolVA("kLevelTableSize"), 4).readUInt32LE();
  expect(PreVectors.LevelInput).toEqual({
    LoginSHA256: login.sha256,
    GameSHA256: pe.sha256,
    Entries: count,
  });
  expect(login.read(login.symbolVA("kLevelTableSize"), 4).readUInt32LE()).toBe(
    count,
  );
  expect(login.read(login.symbolVA("g_nLevel2ExpTable"), count * 4)).toEqual(
    pe.read(pe.symbolVA("g_nLevel2ExpTable"), count * 4),
  );
  expect(PreVectors.InstructionAnchors).toHaveLength(54);
  for (const a of PreVectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(
    pe.read(
      PreVectors.SelectEvidence.VA,
      PreVectors.SelectEvidence.Text.length + 1,
    ),
  ).toEqual(Buffer.from(PreVectors.SelectEvidence.Text + "\0"));
  expect(PreVectors.SelectEvidence.Text).toBe(
    "SN, Type, ItemSn, StockSn, Slot, Amount, Description, ValidityPeriod, ValidityLevel, strAttr",
  );
});

test("ALL2587 independent C++ projections match ordered effects/parameters/dynamic prefixes/counts, WITHOUT executing callbacks or modifying input", () => {
  expect(PreVectors.Cases).toHaveLength(2587);
  for (const c of PreVectors.Cases) {
    const before = JSON.stringify(c),
      p = project(c),
      e = c.Expected,
      text = PreText(c);
    // Independent JSON event Kind strings intentionally have a separate type.
    expect<unknown>(p).toEqual({
      Opened: c.Opened,
      CatalogRevision: 1,
      Before: c.Initial,
      After: e.After,
      Rows: e.Rows.map((r) => PreRecord(r, text)),
      Events: e.Events,
      MissingDefinitionRows: e.MissingDefinitionRows,
      RowsetReads: e.RowsetReads,
      FetchedRows: e.FetchedRows,
      SuccessfulRows: e.SuccessfulRows,
    });
    expect(JSON.stringify(c)).toBe(before);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.After)).toBe(true);
    expect(Object.isFrozen(p.Events)).toBe(true);
    expect(p.Rows.every(Object.isFrozen)).toBe(true);
    expect(p.Events.every(Object.isFrozen)).toBe(true);
    for (const event of p.Events)
      if (event.Kind === "LoadOnUserInventory")
        expect(Object.isFrozen(event.Call)).toBe(true);
  }
});

test("ALL2587 projection outputs feed actual CUser207 scalar/plain builders; native missing-definition malformed count is explicitly refused", () => {
  let malformed = 0;
  for (const c of PreVectors.Cases) {
    const text = PreText(c),
      p = project(c),
      u = new CUser(
        UserInfo("Native", { Exp: p.After.Exp, Money: p.After.Money }),
        p.After.GlobalSerialNo,
      );
    // Raw cached-level fixtures are intentional, NOT network-reachable proof.
    Reflect.set(u, "m_nLevel", p.After.Level);
    const dynamic = u.GetDynamicInfoSnapshot(),
      owned = u.GetInventoryStateSnapshot();
    u.InstallPreInventory(p.Rows, text);
    expect(u.GetPreInventoryCount()).toBe(c.Expected.SuccessfulRows);
    expect(u.GetDynamicInfoSnapshot()).toEqual(dynamic);
    expect(u.GetInventoryStateSnapshot()).toEqual(owned);
    for (const degree of [CipherDegree.CRC8, CipherDegree.None]) {
      const packet = new CSendPacket(207, degree, text).Encode1(1),
        before = packet.GetBuffer(),
        catalog = PreCatalog(c.PacketDefinitions);
      if (c.Expected.PacketMalformed) {
        expect(() => u.MakePreInventoryPacket(packet, catalog)).toThrow(
          "missing definition",
        );
        expect(packet.GetBuffer()).toEqual(before);
      } else {
        u.MakePreInventoryPacket(packet, catalog);
        expect(packet.GetBuffer().toString("hex")).toBe(
          degree === CipherDegree.None
            ? c.Expected.PlainPacketHex
            : c.Expected.PacketHex,
        );
      }
    }
    if (c.Expected.PacketMalformed) malformed++;
  }
  expect(malformed).toBe(1);
});

test("row copy preserves THREE distinct unsigned keys, signed DWORD bits and BYTE fields; period/level aren't truncated to SQL SHORT", () => {
  const r = CopyPreInventory(
    PreRow({
      SN: 0xffffffff,
      ItemSn: 0x80000000,
      StockSn: 0x7fffffff,
      Type: 255,
      Slot: 254,
      Amount: 0xffffffff,
      ValidityPeriod: 0x80000000,
      ValidityLevel: 65535,
    }),
  );
  expect(r).toEqual({
    ...PreRow(),
    SN: 0xffffffff,
    ItemSn: 0x80000000,
    StockSn: 0x7fffffff,
    Type: 255,
    Slot: 254,
    Amount: -1,
    ValidityPeriod: -2147483648,
    ValidityLevel: 65535,
  });
  expect(Object.isFrozen(r)).toBe(true);
});

test("invalid rows/string/codepage values reject before native install changes any revision or existing row", () => {
  const u = user();
  u.InstallPreInventory([PreRow()]);
  const old = u.CapturePreInventory();
  const invalid: unknown[] = [
    null,
    [],
    {},
    PreRow({ SN: -1 }),
    PreRow({ ItemSn: 4294967296 }),
    PreRow({ StockSn: NaN }),
    PreRow({ Type: 256 }),
    PreRow({ Slot: -1 }),
    PreRow({ Amount: 1.5 }),
    PreRow({ ValidityPeriod: Infinity }),
    PreRow({ ValidityLevel: -2147483649 }),
    PreRow({ Description: "bad\0text" }),
    PreRow({ strAttr: "🎮" }),
    PreRow({ Description: "X".repeat(4097) }),
  ];
  for (const r of invalid) {
    expect(() => u.InstallPreInventory([r as PreInventory])).toThrow();
    expect(u.CapturePreInventory()).toEqual(old);
  }
});

test("all fields / ALL rows are captured before codecs can mutate adapter references", () => {
  const u = user(),
    first = PreRow(),
    second = PreRow({ SN: 32, Amount: 12 }),
    text = new CTextCodec(),
    encode = text.Encode.bind(text);
  text.Encode = (s) => {
    Object.assign(second, { Amount: 777, Description: "changed" });
    return encode(s);
  };
  const source = [first, second];
  u.InstallPreInventory(source, text);
  expect(u.CapturePreInventory().Rows[1]!.Amount).toBe(12);
  expect(u.CapturePreInventory().Rows[1]!.Description).toBe("PRE description");
  expect(second.Amount).toBe(777);
  source.splice(0);
  expect(u.GetPreInventoryCount()).toBe(2);
});

test("whole observation capture precedes codec mutations; unsigned negative procedure spellings don't become successful ACKs", () => {
  const observations = [PreObservation(), PreObservation({ Amount: 100 })],
    initial = PreState(),
    text = new CTextCodec(),
    encode = text.Encode.bind(text);
  observations[1]!.ExecResult = 0xffffffff;
  text.Encode = (s) => {
    observations[1]!.ExecResult = 0;
    Object.assign(observations[1]!.Row, { Amount: 999 });
    Object.assign(initial, { Money: 999 });
    return encode(s);
  };
  const p = PlanInitPreInventory(
    observations,
    PreCatalog([{ SN: 7, Category: 100 }]),
    initial,
    true,
    text,
  );
  expect(p.Before.Money).toBe(37);
  expect(p.After.Money).toBe(140); //37+3+100, despite SECOND LoadOn failure
  expect(p.Rows).toHaveLength(1);
  const last = p.Events.filter((e) => e.Kind === "LoadOnUserInventory").at(-1)!;
  expect(last.ExecResult).toBe(-1);
  expect(last.Result).toBe(false);
});

test("success30 allows arbitrarily many observed failed/missing rows within modern work bound and still fetches one extra row", () => {
  const source = [
    ...Array.from({ length: 70 }, () => ({
      ...PreObservation(),
      ReturnValue: -1,
    })),
    ...Array.from({ length: 80 }, () => PreObservation({ ItemSn: 999 })),
    ...Array.from({ length: 31 }, () => PreObservation()),
  ];
  const p = PlanInitPreInventory(
    source,
    PreCatalog([{ SN: 7, Category: 2 }]),
    PreState(),
  );
  expect([p.SuccessfulRows, p.FetchedRows, p.RowsetReads]).toEqual([
    30, 181, 181,
  ]);
  expect(p.MissingDefinitionRows).toHaveLength(80);
  expect(p.Events.filter((e) => e.Kind === "LoadOnUserInventory")).toHaveLength(
    100,
  );
});

test("invalid UNUSED tail/state/outcomes/catalog identity reject rather than silently accepting a partial native prefix", () => {
  let reads = 0;
  const base = PreCatalog([{ SN: 7, Category: 2 }]),
    catalog = {
      ...base,
      GetUserItem(sn: number) {
        reads++;
        return base.GetUserItem(sn);
      },
    };
  expect(() =>
    PlanInitPreInventory(
      [
        ...Array.from({ length: 30 }, () => PreObservation()),
        PreObservation({ Description: "bad\0tail" }),
      ],
      catalog,
      PreState(),
    ),
  ).toThrow();
  expect(reads).toBe(0);
  for (const state of [
    PreState({ Exp: NaN }),
    PreState({ Level: 1.5 }),
    PreState({ Authencode: 256 }),
    PreState({ GlobalSerialNo: -1 }),
    PreState({ GamesSinceFlush: -1 }),
    PreState({ ID: "too-long-user-identifier" }),
  ])
    expect(() => PlanInitPreInventory([], catalog, state)).toThrow();
  expect(() =>
    PlanInitPreInventory(
      [{ ...PreObservation(), PremiumTicketResult: 1 } as never],
      catalog,
      PreState(),
    ),
  ).toThrow();
  expect(() =>
    PlanInitPreInventory(
      [{ ...PreObservation(), ExecResult: NaN }],
      catalog,
      PreState(),
    ),
  ).toThrow();
  expect(() =>
    PlanInitPreInventory(
      [PreObservation()],
      { ...base, Revision: 0 },
      PreState(),
    ),
  ).toThrow();
  expect(() =>
    PlanInitPreInventory(
      [PreObservation()],
      { ...base, GetUserItem: () => ({ ...base.GetUserItem(7)!, SN: 8 }) },
      PreState(),
    ),
  ).toThrow("identity mismatch");
});

test("modern work/resident bounds are distinct and reject BEFORE catalog/codec work", () => {
  let reads = 0;
  const catalog = {
    Revision: 1,
    Count: 0,
    GetUserItem: () => {
      reads++;
      return undefined;
    },
  };
  expect(() =>
    PlanInitPreInventory(
      Array(RuntimePolicy.MaxNativePreInventoryLoadRows + 1).fill(
        PreObservation(),
      ),
      catalog,
      PreState(),
    ),
  ).toThrow("projection input");
  const u = user();
  expect(() => u.InstallPreInventory(Array(31).fill(PreRow()))).toThrow(
    "resident count",
  );
  expect(u.GetPreInventoryGeneration()).toBe(0);
  expect(reads).toBe(0);
});

test("premium failure still truncates, send-auth does NOT change local BYTE, and duplicate rows can request auth twice", () => {
  const source = [
    PreObservation(),
    { ...PreObservation(), PremiumTicketResult: false },
    PreObservation(),
  ];
  const p = PlanInitPreInventory(
    source,
    PreCatalog([{ SN: 7, Category: 9 }]),
    PreState({ Authencode: 255 }),
  );
  expect(p.Events.filter((e) => e.Kind === "SendAuthenCode")).toHaveLength(2);
  expect(p.After.Authencode).toBe(255);
  expect(
    p.Events.filter((e) => e.Kind === "LoadOnUserInventory").map(
      (e) => e.Call.TruncateOnly,
    ),
  ).toEqual([1, 1, 1]);
  expect(p.Events.filter((e) => e.Kind === "WriteUserDynInfo")).toEqual([]);
});

test("failed money/XP procedures retain their native prefix in the ISOLATED projection; no Apply/Retry financial API exists", () => {
  for (const category of [100, 101]) {
    const p = PlanInitPreInventory(
      [{ ...PreObservation({ Amount: 100000 }), ReturnValue: -1 }],
      PreCatalog([{ SN: 7, Category: category }]),
      PreState(),
    );
    expect(p.Rows).toEqual([]);
    expect(p.After[category === 100 ? "Money" : "Exp"]).toBe(
      category === 100 ? 100037 : 100250,
    );
    expect([
      p.After.DynamicModified,
      p.After.SimpleInfoModified,
      p.After.GamesSinceFlush,
    ]).toEqual([0, 0, 0]);
    const kinds = p.Events.map((e) => e.Kind);
    expect(kinds.indexOf("WriteUserDynInfo")).toBeLessThan(
      kinds.indexOf("LoadOnUserInventory"),
    );
  }
});

test("resident snapshots are immutable, empty install advances generation and never changes dynamic/owned/legacy data", () => {
  const u = user(),
    before = u.GetDynamicInfoSnapshot(),
    owned = u.GetInventoryStateSnapshot();
  expect(u.CapturePreInventory()).toEqual({ Revision: 0, Rows: [] });
  u.InstallPreInventory([PreRow()]);
  const old = u.CapturePreInventory();
  expect(Object.isFrozen(old)).toBe(true);
  expect(Object.isFrozen(old.Rows)).toBe(true);
  expect(old.Rows.every(Object.isFrozen)).toBe(true);
  u.InstallPreInventory(old.Rows);
  expect(u.GetPreInventoryGeneration()).toBe(2);
  expect(u.CapturePreInventory().Rows).not.toBe(old.Rows);
  expect(old.Revision).toBe(1);
  u.InstallPreInventory([]);
  expect(u.GetPreInventoryCount()).toBe(0);
  expect(u.GetPreInventoryGeneration()).toBe(3);
  expect(u.GetDynamicInfoSnapshot()).toEqual(before);
  expect(u.GetInventoryStateSnapshot()).toEqual(owned);
});

test("install guard rejects reentry, failed attempts keep previous snapshot and revision exhaustion precedes codecs", () => {
  const u = user();
  u.InstallPreInventory([PreRow()]);
  const old = u.CapturePreInventory(),
    text = new CTextCodec();
  text.Encode = () => {
    u.InstallPreInventory([]);
    return Buffer.alloc(0);
  };
  expect(() => u.InstallPreInventory([PreRow()], text)).toThrow("Reentrant");
  expect(u.CapturePreInventory()).toEqual(old);
  Reflect.set(u, "m_nPreInventoryRevision", 0xffffffff);
  let encodes = 0;
  text.Encode = () => {
    encodes++;
    return Buffer.alloc(0);
  };
  expect(() => u.InstallPreInventory([], text)).toThrow("revision exhausted");
  expect(encodes).toBe(0);
});

test("207 has atomic codepage/whole-body/prefix overflow failures; no first entry or count is partially appended", () => {
  for (const scenario of ["codepage", "body", "prefix"] as const) {
    const u = user(),
      text = new CTextCodec("utf8");
    u.InstallPreInventory(
      scenario === "body"
        ? Array.from({ length: 30 }, () =>
            PreRow({
              strAttr: "X".repeat(4096),
              Description: "Y".repeat(4096),
            }),
          )
        : [
            PreRow({
              strAttr: scenario === "codepage" ? "🎮" : "X".repeat(4096),
            }),
          ],
      text,
    );
    const p = new CSendPacket(207).Encode1(1);
    if (scenario === "prefix") p.EncodeBuffer(Buffer.alloc(65000));
    const before = p.GetBuffer(),
      snapshot = u.CapturePreInventory();
    expect(() =>
      u.MakePreInventoryPacket(p, PreCatalog([{ SN: 7, Category: 2 }])),
    ).toThrow();
    expect(p.GetBuffer()).toEqual(before);
    expect(u.CapturePreInventory()).toEqual(snapshot);
  }
});

test("207 captures ONE vector, cached level and catalog generation before codec-triggered reloads", () => {
  const u = user();
  u.InstallPreInventory([PreRow()]);
  const expected = packet(u, 101),
    text = new CTextCodec(),
    encode = text.Encode.bind(text);
  let called = false;
  text.Encode = (s) => {
    if (!called) {
      called = true;
      u.m_userInfo.Exp = 2000000;
      u.SetLevel();
      u.InstallPreInventory([PreRow({ Type: 99, Amount: 77 })]);
    }
    return encode(s);
  };
  const actual = packet(u, 101, text);
  expect(called).toBe(true);
  expect(actual).toEqual(expected);
  expect(u.CapturePreInventory().Rows[0]!.Amount).toBe(77);
  expect(u.GetLevel()).toBeGreaterThan(2);
});

test("missing/mismatched packet definitions are fail-closed, not native malformed count or a legacy ItemID/name fallback", () => {
  const p = new CSendPacket(207).Encode1(1),
    before = p.GetBuffer(),
    row = PreRow();
  expect(() => PutPreInventoryList(p, [row], PreCatalog([]), 2)).toThrow(
    "missing definition",
  );
  expect(p.GetBuffer()).toEqual(before);
  const catalog = PreCatalog([{ SN: 7, Category: 101 }]);
  expect(() =>
    PutPreInventoryList(
      p,
      [row],
      {
        ...catalog,
        GetUserItem: () => ({ ...catalog.GetUserItem(7)!, SN: 8 }),
      },
      2,
    ),
  ).toThrow("identity mismatch");
  expect(p.GetBuffer()).toEqual(before);
});

test("207/projection consult ONLY catalog SN/Category, never encode an unrelated UTF8-only catalog name or nAttr", () => {
  const catalog = PreCatalog([{ SN: 7, Category: 101 }]),
    special = {
      ...catalog,
      GetUserItem: () => ({
        ...catalog.GetUserItem(7)!,
        strAttr: "🎮",
        strName: "🎮",
      }),
    },
    u = user();
  u.InstallPreInventory([PreRow()]);
  const expected = new CSendPacket(207).Encode1(1),
    actual = new CSendPacket(207).Encode1(1);
  u.MakePreInventoryPacket(expected, catalog);
  u.MakePreInventoryPacket(actual, special);
  expect(actual.GetBuffer()).toEqual(expected.GetBuffer());
  expect(PlanInitPreInventory([PreObservation()], special, PreState())).toEqual(
    PlanInitPreInventory([PreObservation()], catalog, PreState()),
  );
});

test("unused catalog metadata doesn't authorize an invalid dispatch Category or an invalid definition identity", () => {
  const base = PreCatalog([{ SN: 7, Category: 2 }]),
    u = user();
  u.InstallPreInventory([PreRow()]);
  for (const Category of [-1, 256, NaN, 1.5]) {
    const catalog = {
      ...base,
      GetUserItem: () => ({ ...base.GetUserItem(7)!, Category }),
    };
    expect(() =>
      PlanInitPreInventory([PreObservation()], catalog, PreState()),
    ).toThrow("Category");
    const p = new CSendPacket(207).Encode1(1),
      before = p.GetBuffer();
    expect(() => u.MakePreInventoryPacket(p, catalog)).toThrow("Category");
    expect(p.GetBuffer()).toEqual(before);
  }
});
