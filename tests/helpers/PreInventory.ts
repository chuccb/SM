import { CTextCodec, type LegacyEncoding } from "../../Common/CTextCodec.ts";
import type { PreInventory } from "../../Common/PreInventory.ts";
import type { UserItemSnapshot } from "../../Common/UserItem.ts";
import type { PreInventoryUserState } from "../../FXGS/PreInventory.ts";
import vectors from "../fixtures/pre-inventory-vectors.json";

interface RowVector {
  SN: number;
  Type: number;
  ItemSn: number;
  StockSn: number;
  Slot: number;
  Amount: number;
  ValidityPeriod: number;
  ValidityLevel: number;
  DescriptionHex: string;
  AttrHex: string;
}
export interface PreInventoryVector {
  Name: string;
  Encoding: string;
  Opened: boolean;
  Initial: PreInventoryUserState;
  Definitions: { SN: number; Category: number }[];
  PacketDefinitions: { SN: number; Category: number }[];
  Input: {
    Row: RowVector;
    PremiumTicketResult: boolean;
    ExecResult: number;
    ReturnValue: number;
  }[];
  Expected: {
    After: PreInventoryUserState;
    Rows: RowVector[];
    // JSON import widens Kind literals. The fixture is an independent model;
    // deep equality below checks ALL event fields against the typed producer.
    Events: { RowIndex: number; Kind: string }[];
    MissingDefinitionRows: number[];
    RowsetReads: number;
    FetchedRows: number;
    SuccessfulRows: number;
    PacketMalformed: boolean;
    PacketHex: string;
    PlainPacketHex: string;
  };
}
// Explicit contract avoids giant JSON literal type inference; no any callbacks.
export const PreVectors: {
  Model: string;
  Cases: PreInventoryVector[];
  OfficialPE: { Service: string; SHA256: string };
  LevelInput: { LoginSHA256: string; GameSHA256: string; Entries: number };
  SelectEvidence: { VA: number; Text: string };
  InstructionAnchors: { VA: number; Bytes: string; Meaning: string }[];
} = vectors;
export function PreText(c: PreInventoryVector): CTextCodec {
  return new CTextCodec(c.Encoding as LegacyEncoding);
}
export function PreRecord(row: RowVector, text: CTextCodec): PreInventory {
  const { DescriptionHex, AttrHex, ...fields } = row;
  return {
    ...fields,
    Description: text.Decode(Buffer.from(DescriptionHex, "hex")),
    strAttr: text.Decode(Buffer.from(AttrHex, "hex")),
  };
}
export function PreCatalog(
  definitions: readonly { SN: number; Category: number }[],
  revision = 1,
): UserItemSnapshot {
  const map = new Map(
    definitions.map((r) => [
      r.SN,
      Object.freeze({
        ...r,
        strAttr: "catalog NOT pre attribute",
        nAttr1: 1,
        nAttr2: -1,
        nAttr3: 2,
        strName: "catalog NOT pre description",
      }),
    ]),
  );
  return Object.freeze({
    Revision: revision,
    Count: map.size,
    GetUserItem: (sn: number) => map.get(sn >>> 0),
  });
}
export function PreRow(extra: Partial<PreInventory> = {}): PreInventory {
  return {
    SN: 31,
    Type: 23,
    ItemSn: 7,
    StockSn: 9999,
    Slot: 255,
    Amount: 3,
    Description: "PRE description",
    ValidityPeriod: 99999,
    ValidityLevel: 32768,
    strAttr: "PRE attribute",
    ...extra,
  };
}
export function PreState(
  extra: Partial<PreInventoryUserState> = {},
): PreInventoryUserState {
  return {
    ID: "Native",
    GlobalSerialNo: 0x89abcdef,
    Authencode: 0,
    Exp: 250,
    Money: 37,
    Level: 2,
    DynamicModified: 2,
    SimpleInfoModified: 3,
    GamesSinceFlush: 0xffffffff,
    ...extra,
  };
}
export function PreObservation(extra: Partial<PreInventory> = {}) {
  return {
    Row: PreRow(extra),
    PremiumTicketResult: true,
    ExecResult: 0,
    ReturnValue: 0,
  };
}
