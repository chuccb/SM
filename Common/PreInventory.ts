import { CProtocolError } from "./CProtocolError.ts";
import { CSendPacketBase } from "./CSendPacketBase.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";
import { IntegerRange, PreInventoryRule } from "./OfficialValues.ts";
import { RuntimePolicy } from "./RuntimePolicy.ts";
import type { UserItemSnapshot } from "./UserItem.ts";
import type { UserItem } from "./DB/Rows.ts";

/** CRSPreInventory00412108 /56-byte PreInventory0040AC9F. Rowset observations,
 * NOT an adapter from the legacy SQLite FxPreInventory or shop purchases.
 * SN identifies the PRE row; ItemSn identifies FxItem; StockSn is independent.
 * LONGs expose signed bits; keys expose unsigned bits; Type/Slot are BYTEs. */
export interface PreInventory {
  readonly SN: number;
  readonly Type: number;
  readonly ItemSn: number;
  readonly StockSn: number;
  readonly Slot: number;
  readonly Amount: number;
  readonly Description: string;
  readonly ValidityPeriod: number;
  readonly ValidityLevel: number;
  readonly strAttr: string;
}
/** Latch ALL primitives before ANY codec callback. This is a data copy, not
 * user identity authority or a defense against arbitrary hostile JS getters. */
export function CapturePreInventory(input: unknown): Readonly<PreInventory> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid native pre-inventory row");
  const {
    SN,
    Type,
    ItemSn,
    StockSn,
    Slot,
    Amount,
    Description,
    ValidityPeriod,
    ValidityLevel,
    strAttr,
  } = input as PreInventory;
  return Object.freeze({
    SN,
    Type,
    ItemSn,
    StockSn,
    Slot,
    Amount,
    Description,
    ValidityPeriod,
    ValidityLevel,
    strAttr,
  });
}
export function PreInventoryLong(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < IntegerRange.Int32Minimum ||
    value > IntegerRange.UInt32Maximum
  )
    throw new CProtocolError("Invalid native pre-inventory LONG");
  return value | 0;
}
export function CopyPreInventory(
  input: unknown,
  text: CTextCodec = DefaultTextCodec,
): Readonly<PreInventory> {
  const r = CapturePreInventory(input);
  for (const key of ["SN", "ItemSn", "StockSn", "Type", "Slot"] as const) {
    const value = r[key],
      max =
        key === "Type" || key === "Slot"
          ? IntegerRange.UInt8Maximum
          : IntegerRange.UInt32Maximum;
    if (!Number.isInteger(value) || value < 0 || value > max)
      throw new CProtocolError(`Invalid native pre-inventory ${key}`);
  }
  const Amount = PreInventoryLong(r.Amount),
    ValidityPeriod = PreInventoryLong(r.ValidityPeriod),
    ValidityLevel = PreInventoryLong(r.ValidityLevel);
  if (typeof r.Description !== "string" || typeof r.strAttr !== "string")
    throw new CProtocolError("Invalid native pre-inventory strings");
  text.AssertSize(
    r.Description,
    RuntimePolicy.MaxPreInventoryDescriptionBytes,
    "PreInventory.Description",
  );
  text.AssertSize(
    r.strAttr,
    RuntimePolicy.MaxPreInventoryAttributeBytes,
    "PreInventory.strAttr",
  );
  return Object.freeze({ ...r, Amount, ValidityPeriod, ValidityLevel });
}
/** Modern bounded resident replacement. Native30 is a loader SUCCESS counter;
 * it must not be used as SELECT LIMIT30 or as a financial authorization. */
export function CopyPreInventoryRows(
  source: readonly Readonly<PreInventory>[],
  text: CTextCodec = DefaultTextCodec,
): readonly Readonly<PreInventory>[] {
  if (
    !Array.isArray(source) ||
    source.length > PreInventoryRule.SuccessfulLoadLimit
  )
    throw new CProtocolError("Invalid native pre-inventory resident count");
  const captured = [...source].map(CapturePreInventory);
  return Object.freeze(captured.map((r) => CopyPreInventory(r, text)));
}

/** Only SN/Category are consulted by InitPreInventory/207. Catalog text and
 * nAttr are NOT emitted here, so don't reject an unrelated catalog name just
 * because it cannot be encoded in this packet's codepage. The real snapshot
 * manager already validates its complete definitions at reload time. */
export function PreInventoryCategory(
  input: Readonly<UserItem>,
  itemSn: number,
): number {
  const { SN, Category } = input;
  if (SN !== itemSn)
    throw new CProtocolError("Pre-inventory catalog identity mismatch");
  if (
    !Number.isInteger(Category) ||
    Category < 0 ||
    Category > IntegerRange.UInt8Maximum
  )
    throw new CProtocolError("Invalid pre-inventory definition Category");
  return Category;
}

/** MakePreInventoryPacket00416CA9 USER BODY, no opcode/local-user prefix.
 * Native count includes missing definitions even though it skips their body.
 * Modern preflight REFUSES that malformed image, before appending ANY bytes.
 * One immutable catalog generation / captured level is required from caller. */
export function PutPreInventoryList(
  packet: CSendPacketBase,
  source: readonly Readonly<PreInventory>[],
  catalog: UserItemSnapshot,
  cachedLevel: number,
): void {
  if (
    !Number.isInteger(cachedLevel) ||
    cachedLevel < IntegerRange.Int32Minimum ||
    cachedLevel > IntegerRange.Int32Maximum
  )
    throw new CProtocolError("Invalid pre-inventory cached level");
  const rows = CopyPreInventoryRows(source, packet.text),
    definitions = rows.map((row) => {
      const raw = catalog.GetUserItem(row.ItemSn);
      if (!raw)
        throw new CProtocolError("Pre-inventory packet missing definition");
      return PreInventoryCategory(raw, row.ItemSn);
    }),
    out = new CSendPacketBase(undefined, packet.GetCipherDegree(), packet.text);
  out.Encode1(rows.length);
  for (const [i, row] of rows.entries()) {
    const category = definitions[i]!;
    out
      .Encode1(row.Type)
      .Encode4(row.ItemSn)
      .Encode2(row.Amount)
      .Encode2(
        category === PreInventoryRule.ExperienceCategory ? cachedLevel : 0,
      )
      .Encode2(
        row.ValidityPeriod < PreInventoryRule.HiddenValidityPeriodThreshold
          ? row.ValidityPeriod
          : 0,
      )
      .EncodeStr(row.strAttr)
      .EncodeStr(row.Description);
  }
  packet.EncodeBuffer(out.GetBuffer());
}
