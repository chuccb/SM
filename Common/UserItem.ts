import type { UserItem } from "./DB/Rows.ts";
import { CProtocolError } from "./CProtocolError.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";
import { IntegerRange } from "./OfficialValues.ts";
import { RuntimePolicy } from "./RuntimePolicy.ts";

/** SQL FxItem definition, not ShopItem, inventory or CItemAttr resource data.
 * nAttr DWORDs retain their exact 32 bits and expose signed-int interpretation;
 * their CATEGORY-DEPENDENT meaning is not guessed as prices/durations/bonuses. */
export function CopyUserItem(
  input: unknown,
  text: CTextCodec = DefaultTextCodec,
): Readonly<UserItem> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid UserItem row");
  const r = input as Record<string, unknown>;
  for (const key of ["SN", "Category", "nAttr1", "nAttr2", "nAttr3"] as const) {
    const n = r[key],
      minimum = key.startsWith("nAttr") ? IntegerRange.Int32Minimum : 0,
      maximum =
        key === "Category"
          ? IntegerRange.UInt8Maximum
          : IntegerRange.UInt32Maximum;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < minimum ||
      n > maximum
    )
      throw new CProtocolError(`Invalid UserItem ${key}`);
  }
  if (typeof r.strAttr !== "string" || typeof r.strName !== "string")
    throw new CProtocolError("Invalid UserItem strings");
  text.AssertSize(
    r.strAttr,
    RuntimePolicy.MaxUserItemAttributeBytes,
    "UserItem.strAttr",
  );
  text.AssertSize(
    r.strName,
    RuntimePolicy.MaxUserItemNameBytes,
    "UserItem.strName",
  );
  return Object.freeze({
    SN: (r.SN as number) >>> 0,
    Category: (r.Category as number) | 0,
    strAttr: r.strAttr,
    nAttr1: (r.nAttr1 as number) | 0,
    nAttr2: (r.nAttr2 as number) | 0,
    nAttr3: (r.nAttr3 as number) | 0,
    strName: r.strName,
  });
}

/** Explicit adapter for the OLD modern export format. These aliases were never
 * native column names: especially TmplName -> strAttr and Verbose -> strName. */
export function UpgradeLegacyUserItem(
  input: unknown,
  text: CTextCodec = DefaultTextCodec,
): Readonly<UserItem> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid legacy FxItem row");
  const r = input as Record<string, unknown>;
  if (typeof r.TmplName !== "string" || typeof r.Verbose !== "string")
    throw new CProtocolError("Invalid legacy FxItem fields");
  text.AssertSize(
    r.TmplName,
    RuntimePolicy.LegacyUserItemTemplateBytes,
    "legacy template name",
    1,
  );
  return CopyUserItem(
    {
      SN: r.ItemID,
      Category: r.Type,
      strAttr: r.TmplName,
      nAttr1: r.OpaqueColumn3,
      nAttr2: r.OpaqueColumn4,
      nAttr3: r.OpaqueColumn5,
      strName: r.Verbose,
    },
    text,
  );
}

/** Modern bounded logical interchange, NOT the native database schema version. */
export function DecodeUserItemExport(
  input: unknown,
  text: CTextCodec = DefaultTextCodec,
): readonly Readonly<UserItem>[] {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Expected explicit FxItem logical export");
  const doc = input as Record<string, unknown>;
  if (
    (doc.schemaVersion !== 1 && doc.schemaVersion !== 2) ||
    doc.kind !== "FxItem" ||
    !Array.isArray(doc.rows) ||
    doc.rows.length > RuntimePolicy.MaxUserItemDefinitions
  )
    throw new CProtocolError("Expected FxItem logical export version1 or2");
  const expected =
      doc.schemaVersion === 1
        ? [
            "ItemID",
            "Type",
            "TmplName",
            "OpaqueColumn3",
            "OpaqueColumn4",
            "OpaqueColumn5",
            "Verbose",
          ]
        : [
            "SN",
            "Category",
            "strAttr",
            "nAttr1",
            "nAttr2",
            "nAttr3",
            "strName",
          ],
    keys = new Set(expected),
    seen = new Set<number>();
  return Object.freeze(
    doc.rows.map((r: unknown) => {
      if (
        !r ||
        typeof r !== "object" ||
        Array.isArray(r) ||
        Object.keys(r).length !== expected.length ||
        Object.keys(r).some((k) => !keys.has(k))
      )
        throw new CProtocolError("Unexpected or missing FxItem export columns");
      const item =
        doc.schemaVersion === 1
          ? UpgradeLegacyUserItem(r, text)
          : CopyUserItem(r, text);
      if (seen.has(item.SN)) throw new CProtocolError("Duplicate FxItem SN");
      seen.add(item.SN);
      return item;
    }),
  );
}

/** Immutable catalog generation captured across native inventory clock/codec
 * callbacks. No exposed Map, SQL handle or implicit live-reload lookup. */
export interface UserItemSnapshot {
  readonly Revision: number;
  readonly Count: number;
  readonly GetUserItem: (sn: number) => Readonly<UserItem> | undefined;
}
/** Enumeration of the SAME immutable generation for joint202/207 preflight.
 * Rows are already detached/frozen by CUserItemMan; not a mutable Map or loader. */
export interface UserItemPacketSnapshot extends UserItemSnapshot {
  readonly Rows: readonly Readonly<UserItem>[];
}
export function UserItemKey(sn: number): number {
  if (
    !Number.isInteger(sn) ||
    sn < IntegerRange.Int32Minimum ||
    sn > IntegerRange.UInt32Maximum
  )
    throw new CProtocolError("Invalid UserItem key");
  return sn >>> 0;
}
