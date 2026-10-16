import { beforeAll, expect, test } from "bun:test";
import { CFastFile } from "../Common/CFastFile.ts";
import { CItemAttr } from "../FXGS/CItemAttr.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import { GameItemType, ItemAttrFormat } from "../Common/OfficialValues.ts";
const files = new CFastFile();
beforeAll(() => files.FastFileInit("FXGS/FxServer"));
const int = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const str = (s: string) =>
  Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
function item(
  name: string,
  weight = 1,
  type = 1,
  parameters = [0, 0, 0, 0, 0],
) {
  return Buffer.concat([
    str(name),
    str("Item/Image"),
    ...[weight, 0, type, ...parameters].map(int),
  ]);
}
const header = () => Buffer.concat([int(60), int(0), int(0)]);
test("native Attr/ItemAttr: exact header, ten ships, 71 rows, preserved signed money-pickup deltas", () => {
  const attr = new CItemAttr();
  attr.Load(files);
  expect(attr.m_aOpaqueHeader).toEqual([60, 0]);
  expect(attr.m_aShipAttr.length).toBe(10);
  expect(attr.GetItemCount()).toBe(71);
  expect(attr.GetItemAttr(0)).toEqual({
    Index: 0,
    Name: "Item/ItemBomb",
    ImageName: "Item/Bomb",
    ProbabilityWeight: 3650,
    Opaque136: 0,
    Type: 1,
    Parameters: [1, 0, 0, 0, 0],
  });
  const negative = attr.GetItemAttr(attr.GetItemidx("LucciPocket1"));
  expect(negative.Type).toBe(GameItemType.Money);
  expect(negative.Parameters).toEqual([-1000, 0, 0, 0, 1]);
  const positive = attr.GetItemAttr(attr.GetItemidx("LucciPocket0"));
  expect(positive.Parameters[0]).toBe(5000);
  // Money pickups are not shop prices, inventory stock or billing definitions.
  expect(Object.hasOwn(negative, "Price")).toBe(false);
  for (const row of attr.m_aShipAttr) {
    expect(row.Name.length).toBeGreaterThan(0);
    expect(row.OpaqueWords.length).toBe(8);
    expect(attr.m_mapShipCode.get(row.Code)).toBeGreaterThanOrEqual(row.Index);
  }
});
test("native probability lookup uses raw weights, not renormalized percentages; unused tail stays ff", () => {
  const attr = new CItemAttr();
  attr.Load(files);
  const table = attr.GetProbabilityTable();
  expect(table.length).toBe(32768);
  let offset = 0;
  for (const row of attr.m_aItemAttr) {
    expect(
      table
        .subarray(offset, offset + row.ProbabilityWeight)
        .every((x) => x === row.Index),
    ).toBe(true);
    offset += row.ProbabilityWeight;
  }
  expect(offset).toBe(12928);
  expect(table.subarray(offset).every((x) => x === 0xff)).toBe(true);
  table[0] = 255;
  expect(attr.GetProbabilityTable()[0]).toBe(0);
});
test("GetItemidx follows case-insensitive Item/Item then Item/ prefixes and first matching row", () => {
  const attr = new CItemAttr();
  attr.Load(files);
  for (const name of ["Item/ItemBomb", "ITEM/ITEMBOMB", "Item/Bomb", "bomb"])
    expect(attr.GetItemidx(name)).toBe(0);
  for (const name of ["Item/ItemFire", "Item/Fire", "FIRE"])
    expect(attr.GetItemidx(name)).toBe(1);
  expect(attr.GetItemidx("does not exist")).toBe(-1);
  expect(attr.GetItemidx("Item/")).toBe(-1);
  expect(() => attr.GetItemAttr(-1)).toThrow("bounds");
  expect(() => attr.GetItemAttr(71)).toThrow("bounds");
  expect(() => attr.GetItemAttr(0.5)).toThrow("bounds");
  expect(Reflect.set(attr.GetItemAttr(0).Parameters, "0", 99)).toBe(false);
  expect(attr.GetItemAttr(0).Parameters[0]).toBe(1);
});
test("item resource reload is atomic on every truncation, invalid count/weight/string and malformed tail", () => {
  const attr = new CItemAttr();
  attr.Load(files);
  const before = attr.m_aItemAttr.slice();
  const valid = Buffer.concat([header(), item("Small", 5)]);
  // Header-only is a valid empty resource; every other non-row-aligned prefix is not.
  for (let length = 0; length < valid.length; length++)
    if (length !== 12) {
      expect(() => attr.LoadData(valid.subarray(0, length))).toThrow();
      expect(attr.m_aItemAttr).toEqual(before);
    }
  const malformed = [
    Buffer.concat([int(60), int(0), int(-1)]),
    Buffer.concat([int(60), int(0), int(4097)]),
    Buffer.concat([header(), item("Negative", -1)]),
    Buffer.concat([header(), item("Oversize", 32768)]),
    Buffer.concat([header(), item("First", 32767), item("Overflow", 1)]),
    Buffer.concat([header(), item("x".repeat(64))]),
    Buffer.concat([header(), item("")]),
    Buffer.concat([valid, Buffer.from([1])]),
  ];
  for (const bytes of malformed) {
    expect(() => attr.LoadData(bytes)).toThrow();
    expect(attr.m_aItemAttr).toEqual(before);
  }
  expect(attr.m_aOpaqueHeader).toEqual([60, 0]);
  expect(attr.m_aShipAttr.length).toBe(10);
  expect(attr.GetProbabilityTable()[0]).toBe(0);
  attr.LoadData(valid);
  expect(attr.GetItemCount()).toBe(1);
  expect(attr.GetItemAttr(0).Name).toBe("Small");
  expect(attr.m_aShipAttr.length).toBe(0);
});
test("item capacity, zero weights, signed opaque fields and duplicate ship-code last-wins follow source", () => {
  const attr = new CItemAttr();
  const rows = Buffer.concat(
    Array.from({ length: 256 }, (_, i) =>
      item(`Item${i}`, 0, -3, [-5, 2, 3, 4, 5]),
    ),
  );
  attr.LoadData(Buffer.concat([header(), rows]));
  expect(attr.GetItemCount()).toBe(256);
  expect(attr.GetProbabilityTable().every((x) => x === 0xff)).toBe(true);
  expect(attr.GetItemAttr(255).Type).toBe(-3);
  expect(() =>
    attr.LoadData(Buffer.concat([header(), rows, item("Extra", 0)])),
  ).toThrow("Too many");
  expect(attr.GetItemCount()).toBe(256);
  const ship = (name: string) =>
    Buffer.concat([int(9), str(name), ...[-1, 2, 3, 4, 5, 6, 7, 8].map(int)]);
  attr.LoadData(
    Buffer.concat([
      int(60),
      int(0),
      int(2),
      ship("ShipA"),
      ship("ShipB"),
      item("Foo", 0),
    ]),
  );
  expect(attr.m_mapShipCode.get(9)).toBe(1);
  expect(attr.m_aShipAttr[0]!.OpaqueWords).toEqual([-1, 2, 3, 4, 5, 6, 7, 8]);
  expect(ItemAttrFormat.MaximumItems).toBe(256);
});
test("real map level limit is native +52, NOT opaque +36; airplane and sync counts retain their own fields", () => {
  const maps = new CGameMapTmplList();
  maps.CreateTmplList(files);
  const bula = maps.GetMapTmpl(0);
  expect(bula.m_nOpaque36).toBe(2);
  expect(maps.GetMapLevelLimit(0)).toBe(1);
  expect(maps.GetMapLevelLimit(12)).toBe(15);
  expect(maps.GetMapTmpl(12).m_nOpaque36).toBe(2);
  expect(bula.m_nSyncGameObjCount).toBe(4);
  expect(maps.GetMapTmpl(12).m_nSyncGameObjCount).toBe(3);
  const village = maps.GetMapTmpl(200);
  expect(village.m_strName).toBe("Village01");
  expect(village.m_nLevelLimit).toBe(1);
  expect(village.m_nAirplaneInitialTime).toBe(60000);
  expect(village.m_nAirplaneFrequency).toBe(22000);
  expect(village.m_nSyncGameObjCount).toBe(0);
  expect(bula.m_aOpaqueHeader[0]).toBe(2);
});

test("native iteminfo.txt keeps the two byte-weight sections separate, without percentage normalization", () => {
  const attr = new CItemAttr();
  attr.Load(files);
  attr.LoadAirplaneItemInfo("FXGS/iteminfo.txt");
  expect(attr.GetAirplaneItemProbability(0)).toEqual([
    { ItemIndex: 0, Weight: 50 },
    { ItemIndex: 1, Weight: 40 },
    { ItemIndex: 2, Weight: 5 },
    { ItemIndex: 5, Weight: 5 },
  ]);
  expect(attr.GetAirplaneItemProbability(1)).toEqual([
    { ItemIndex: 24, Weight: 60 },
    { ItemIndex: 69, Weight: 10 },
    { ItemIndex: 70, Weight: 10 },
    { ItemIndex: 54, Weight: 10 },
    { ItemIndex: 0, Weight: 5 },
    { ItemIndex: 1, Weight: 3 },
    { ItemIndex: 2, Weight: 1 },
    { ItemIndex: 5, Weight: 1 },
  ]);
  expect(attr.GetAirplaneItemProbability(2)).toBe(
    attr.GetAirplaneItemProbability(0),
  );
  attr.LoadAirplaneItemInfoData("2 Bomb 255 UnknownNativeItem 0 0");
  expect(attr.GetAirplaneItemProbability(0)).toEqual([
    { ItemIndex: 0, Weight: 255 },
    { ItemIndex: -1, Weight: 0 },
  ]);
  expect(attr.GetAirplaneItemProbability(1)).toEqual([]);
});
test("airplane probability input validates all sections atomically; no partial config or shared mutable arrays", () => {
  const attr = new CItemAttr();
  attr.Load(files);
  attr.LoadAirplaneItemInfoData("1 Bomb 3 1 Fire 7");
  const before = structuredClone([
    attr.GetAirplaneItemProbability(0),
    attr.GetAirplaneItemProbability(1),
  ]);
  for (const bad of [
    "",
    "-1 0",
    "101 0",
    "1 Bomb",
    "1 Bomb -1 0",
    "1 Bomb 256 0",
    "1 Bomb 1 1 Fire",
    "0 0 trailing",
    "0 1 Fire 1.5",
    "NaN 0",
  ]) {
    expect(() => attr.LoadAirplaneItemInfoData(bad)).toThrow();
    expect([
      attr.GetAirplaneItemProbability(0),
      attr.GetAirplaneItemProbability(1),
    ]).toEqual(before);
  }
  expect(Object.isFrozen(attr.GetAirplaneItemProbability(0))).toBe(true);
  expect(Object.isFrozen(attr.GetAirplaneItemProbability(0)![0])).toBe(true);
});
test("missing iteminfo means absent173 rather than a fabricated empty probability packet; item resource reload invalidates its binding", () => {
  const attr = new CItemAttr();
  attr.Load(files);
  expect(attr.GetAirplaneItemProbability(0)).toBeUndefined();
  attr.LoadAirplaneItemInfoData("0 0");
  expect(attr.GetAirplaneItemProbability(0)).toEqual([]);
  attr.LoadAirplaneItemInfo(".analysis/definitely-missing-iteminfo.txt");
  expect(attr.GetAirplaneItemProbability(0)).toBeUndefined();
  expect(attr.GetAirplaneItemProbability(1)).toBeUndefined();
  attr.LoadAirplaneItemInfoData("1 Bomb 1 0");
  attr.Load(files);
  expect(attr.GetAirplaneItemProbability(0)).toBeUndefined();
});
