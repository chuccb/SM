import { CProtocolError } from "./CProtocolError.ts";
import { CSendPacketBase } from "./CSendPacketBase.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";
import {
  IntegerRange,
  UserInventoryFormat,
  UserInventoryRule,
} from "./OfficialValues.ts";
import { RuntimePolicy } from "./RuntimePolicy.ts";

/** A NATIVE read-side boundary AFTER CRSUserInventory/CTime::GetVariantTime.
 * DateCreated here is a finite raw OLE DATE observation, NOT SQL DBTIMESTAMP,
 * Unix seconds, a timezone conversion, or a permanent-item sentinel.
 * No adapter from existing SQLite _USERINVENTORY is implied by this type. */
export interface UserInventoryRecord {
  readonly ItemSn: number;
  readonly Slot: number;
  readonly Amount: number;
  readonly DateCreated: number;
  readonly LevelCreated: number;
  readonly StockSn: number;
  readonly Verbose: string;
}
/** Native 84-byte UserInventory roles (not an in-memory Win32 layout).
 * Category/strAttr/nAttr1..3 are COPIES of the matching UserItem definition;
 * strName is deliberately absent: it is NOT the owned row's Verbose.
 * Read-side rows are immutable; trusted amount mutation replaces the row. */
export interface UserInventory extends UserInventoryRecord {
  readonly Category: number;
  readonly strAttr: string;
  readonly nAttr1: number;
  readonly nAttr2: number;
  readonly nAttr3: number;
  readonly Modified: number;
}
export interface UserInventoryEquipment {
  readonly FakeLevel?: number;
  readonly LevelIconSN?: number;
}
export function UserInventoryKey(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < IntegerRange.Int32Minimum ||
    value > IntegerRange.UInt32Maximum
  )
    throw new CProtocolError("Invalid native inventory key");
  return value >>> 0;
}
function scalar(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new CProtocolError(`Invalid native inventory ${name}`);
  return value;
}
/** Latch every primitive before ANY codec callout; these are detached data
 * captures, not SQL/identity authority or a defense against arbitrary JS. */
export function CaptureUserInventoryRecord(
  input: unknown,
): Readonly<UserInventoryRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid native inventory row");
  const { ItemSn, Slot, Amount, DateCreated, LevelCreated, StockSn, Verbose } =
    input as UserInventoryRecord;
  return Object.freeze({
    ItemSn,
    Slot,
    Amount,
    DateCreated,
    LevelCreated,
    StockSn,
    Verbose,
  });
}
export function CaptureUserInventory(input: unknown): Readonly<UserInventory> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid native inventory row");
  const {
    ItemSn,
    Slot,
    Amount,
    DateCreated,
    LevelCreated,
    StockSn,
    Verbose,
    Category,
    strAttr,
    nAttr1,
    nAttr2,
    nAttr3,
    Modified,
  } = input as UserInventory;
  return Object.freeze({
    ItemSn,
    Slot,
    Amount,
    DateCreated,
    LevelCreated,
    StockSn,
    Verbose,
    Category,
    strAttr,
    nAttr1,
    nAttr2,
    nAttr3,
    Modified,
  });
}
export function CopyUserInventoryRecord(
  input: unknown,
  text: CTextCodec = DefaultTextCodec,
): Readonly<UserInventoryRecord> {
  const r = CaptureUserInventoryRecord(input);
  const ItemSn =
    scalar(r.ItemSn, 0, IntegerRange.UInt32Maximum, "ItemSn") >>> 0;
  const StockSn =
    scalar(r.StockSn, 0, IntegerRange.UInt32Maximum, "StockSn") >>> 0;
  const Slot = scalar(r.Slot, 0, IntegerRange.UInt8Maximum, "Slot") | 0;
  const Amount =
    scalar(
      r.Amount,
      IntegerRange.Int32Minimum,
      IntegerRange.UInt32Maximum,
      "Amount",
    ) | 0;
  // Native rowset reads a SHORT then MOVSX compares it; accept either valid
  // signed16 spelling or the equivalent unsigned16 bits at this boundary.
  const LevelCreated =
    (scalar(
      r.LevelCreated,
      IntegerRange.Int16Minimum,
      IntegerRange.UInt16Maximum,
      "LevelCreated",
    ) <<
      16) >>
    16;
  if (typeof r.DateCreated !== "number" || !Number.isFinite(r.DateCreated))
    throw new CProtocolError("Invalid native inventory VariantTime");
  if (typeof r.Verbose !== "string")
    throw new CProtocolError("Invalid native inventory Verbose");
  text.AssertSize(
    r.Verbose,
    RuntimePolicy.MaxInventoryVerboseBytes,
    "Native inventory Verbose",
  );
  return Object.freeze({
    ItemSn,
    StockSn,
    Slot,
    Amount,
    DateCreated: r.DateCreated,
    LevelCreated,
    Verbose: r.Verbose,
  });
}
export function CopyUserInventory(
  input: unknown,
  text: CTextCodec = DefaultTextCodec,
): Readonly<UserInventory> {
  const r = CaptureUserInventory(input),
    row = CopyUserInventoryRecord(r, text);
  const Category =
    scalar(r.Category, 0, IntegerRange.UInt8Maximum, "Category") | 0;
  const nAttr1 =
    scalar(
      r.nAttr1,
      IntegerRange.Int32Minimum,
      IntegerRange.UInt32Maximum,
      "nAttr1",
    ) | 0;
  const nAttr2 =
    scalar(
      r.nAttr2,
      IntegerRange.Int32Minimum,
      IntegerRange.UInt32Maximum,
      "nAttr2",
    ) | 0;
  const nAttr3 =
    scalar(
      r.nAttr3,
      IntegerRange.Int32Minimum,
      IntegerRange.UInt32Maximum,
      "nAttr3",
    ) | 0;
  const Modified = scalar(r.Modified, 0, 1, "Modified") | 0;
  if (typeof r.strAttr !== "string")
    throw new CProtocolError("Invalid native inventory strAttr");
  text.AssertSize(
    r.strAttr,
    RuntimePolicy.MaxUserItemAttributeBytes,
    "Native inventory strAttr",
  );
  return Object.freeze({
    ...row,
    Category,
    strAttr: r.strAttr,
    nAttr1,
    nAttr2,
    nAttr3,
    Modified,
  });
}
export function IsUserInventory(row: object): row is UserInventory {
  return "ItemSn" in row;
}
/** All native resident queries are FIRST match in vector order. NO implicit
 * Amount/DATE/StockSn predicate, Unicode normalization, case folding or SQL. */
export function FindUserInventory(
  rows: readonly Readonly<UserInventory>[],
  sn: number,
): Readonly<UserInventory> | undefined {
  const key = UserInventoryKey(sn);
  return rows.find((r) => r.ItemSn === key);
}
export function FindInventoryLoaded(
  rows: readonly Readonly<UserInventory>[],
  category: number,
): Readonly<UserInventory> | undefined {
  return rows.find(
    (r) =>
      r.Category === category && r.Slot !== UserInventoryRule.UnequippedSlot,
  );
}
export function FindSlotDecorationLoaded(
  rows: readonly Readonly<UserInventory>[],
  position: number,
): Readonly<UserInventory> | undefined {
  return rows.find(
    (r) =>
      r.Category === UserInventoryRule.SlotDecorationCategory &&
      r.nAttr2 === position &&
      r.Slot !== UserInventoryRule.UnequippedSlot,
  );
}
export function FindCharDecoLoaded(
  rows: readonly Readonly<UserInventory>[],
  position: number,
): Readonly<UserInventory> | undefined {
  return rows.find(
    (r) =>
      r.Category === UserInventoryRule.CharDecorationCategory &&
      r.nAttr2 === position &&
      r.Slot !== UserInventoryRule.UnequippedSlot,
  );
}
export function FindUserInventoryFromAll(
  rows: readonly Readonly<UserInventory>[],
  attribute: string,
  text: CTextCodec = DefaultTextCodec,
): Readonly<UserInventory> | undefined {
  const key = text.Encode(attribute);
  return rows.find((r) => text.Encode(r.strAttr).equals(key));
}
export function HasFunctionalItem(
  rows: readonly Readonly<UserInventory>[],
  attribute: string,
  text: CTextCodec = DefaultTextCodec,
): boolean {
  const key = text.Encode(attribute);
  return rows.some(
    (r) =>
      r.Category === UserInventoryRule.FunctionalCategory &&
      text.Encode(r.strAttr).equals(key),
  );
}
function detached(packet: CSendPacketBase): CSendPacketBase {
  return new CSendPacketBase(undefined, packet.GetCipherDegree(), packet.text);
}
/**00416C0C: DWORD count/ItemSn, BYTE Slot, DWORD Amount, Verbose, raw f64 LE.
 * Capture one immutable vector; append ONLY after full encoding succeeds. */
export function PutUserInventoryList(
  packet: CSendPacketBase,
  rows: readonly Readonly<UserInventory>[],
): void {
  const out = detached(packet).Encode4(rows.length);
  for (const row of rows) {
    const date = Buffer.alloc(UserInventoryFormat.VariantTimeBytes);
    date.writeDoubleLE(row.DateCreated);
    out
      .Encode4(row.ItemSn)
      .Encode1(row.Slot)
      .Encode4(row.Amount)
      .EncodeStr(row.Verbose)
      .EncodeBuffer(date);
  }
  packet.EncodeBuffer(out.GetBuffer());
}
/**00416B4B: category-filtered WORD count and LOW WORD of ItemSn.
 * This truncation is native evidence, NOT StockSn or a resource index. */
export function PutInventoryList(
  packet: CSendPacketBase,
  rows: readonly Readonly<UserInventory>[],
  category: number,
): void {
  const selected = rows.filter((r) => r.Category === category),
    out = detached(packet).Encode2(selected.length);
  for (const row of selected)
    out.Encode2(row.ItemSn & IntegerRange.UInt16Maximum);
  packet.EncodeBuffer(out.GetBuffer());
}
/**00419597: slot decoration domains0..8, char domains0..4, and category14 tail.
 * First matching equipped row wins per POSITION; count is not vector length.
 * nAttr1's LOW WORD is the slot-deco value; char rows emit all THREE DWORDs. */
export function PutSlotAccessoryList(
  packet: CSendPacketBase,
  rows: readonly Readonly<UserInventory>[],
  slot: number,
): void {
  if (!Number.isInteger(slot) || slot < 0 || slot > IntegerRange.UInt8Maximum)
    throw new CProtocolError("Invalid accessory player slot");
  const slots = Array.from(
    { length: UserInventoryRule.SlotDecorationPositions },
    (_, i) => ({ Position: i, Row: FindSlotDecorationLoaded(rows, i) }),
  ).filter((v) => v.Row);
  const chars = Array.from(
    { length: UserInventoryRule.CharDecorationPositions },
    (_, i) => FindCharDecoLoaded(rows, i),
  ).filter((v) => v !== undefined);
  const out = detached(packet).Encode1(slots.length);
  if (slots.length) {
    out.Encode1(slot);
    for (const entry of slots)
      out
        .Encode1(entry.Position)
        .Encode2(entry.Row!.nAttr1 & IntegerRange.UInt16Maximum);
  }
  out.Encode1(chars.length);
  if (chars.length) {
    out.Encode1(slot);
    for (const row of chars)
      out.Encode4(row.nAttr1).Encode4(row.nAttr2).Encode4(row.nAttr3);
  }
  out.Encode4(
    FindInventoryLoaded(rows, UserInventoryRule.AccessoryTailCategory)
      ?.nAttr3 ?? 0,
  );
  packet.EncodeBuffer(out.GetBuffer());
}
