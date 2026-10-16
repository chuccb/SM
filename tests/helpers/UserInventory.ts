import { CUser } from "../../Common/CUser.ts";
import type { UserItem } from "../../Common/DB/Rows.ts";
import { CTextCodec, type LegacyEncoding } from "../../Common/CTextCodec.ts";
import type {
  UserInventory,
  UserInventoryRecord,
} from "../../Common/UserInventory.ts";
import { g_nLevel2ExpTable } from "../../Common/Protocol/OfficialTables.ts";
import { UserInfo } from "./Accounts.ts";
import vectors from "../fixtures/user-inventory-vectors.json";

// The large frozen JSON exceeds TS's automatic JSON-array inference budget.
// Keep an explicit fixture contract, not implicit-any callbacks or production
// codec/parser reuse inside the independent C++ model.
interface DefinitionVector {
  SN: number;
  Category: number;
  AttrHex: string;
  nAttr1: number;
  nAttr2: number;
  nAttr3: number;
}
interface RecordVector {
  ItemSn: number;
  StockSn: number;
  Slot: number;
  Amount: number;
  DateHex: string;
  LevelCreated: number;
  VerboseHex: string;
}
interface ResidentVector {
  Record: RecordVector;
  Definition: DefinitionVector;
  Modified: number;
}
export interface InventoryVector {
  Name: string;
  Encoding: string;
  Level: number;
  InitialFakeLevel: number;
  InitialIconEnabled: number;
  InitialIconSN: number;
  CategoryProbe: number;
  PositionProbe: number;
  SNProbe: number;
  AttributeHex: string;
  Definitions: DefinitionVector[];
  Records: RecordVector[];
  ClockHex: string[];
  Expected: {
    Rows: ResidentVector[];
    RowsetReads: number;
    FetchedRows: number;
    CountedRows: number;
    ClockReads: number;
    MissingDefinitionRows: number[];
    DeleteAttempts: {
      RowIndex: number;
      ItemSn: number;
      LevelExpired: boolean;
      DateExpired: boolean;
    }[];
    Equipment: { FakeLevel?: number; LevelIconSN?: number };
    FakeLevelAfter: number;
    IconEnabledAfter: number;
    IconSNAfter: number;
    LookLevelAfter: number;
    FirstSN: number | null;
    FromAllSN: number | null;
    LoadedSN: number | null;
    SlotDecoSN: number | null;
    CharDecoSN: number | null;
    Functional: boolean;
    InventoryHex: string;
    PlainInventoryHex: string;
    FilteredHex: string;
    AccessoryHex: string;
    Self105Hex: string | null;
    Other105Hex: string | null;
  };
}
export const InventoryVectors: {
  Model: string;
  Cases: InventoryVector[];
  OfficialPE: { Service: string; SHA256: string };
  SelectEvidence: { VA: number; Text: string };
  InstructionAnchors: { VA: number; Bytes: string; Meaning: string }[];
} = vectors;
export function ModelText(c: InventoryVector): CTextCodec {
  return new CTextCodec(c.Encoding as LegacyEncoding);
}
export function ModelDefinition(
  row: InventoryVector["Definitions"][number],
  text: CTextCodec,
): UserItem {
  return {
    SN: row.SN,
    Category: row.Category,
    strAttr: text.Decode(Buffer.from(row.AttrHex, "hex")),
    nAttr1: row.nAttr1,
    nAttr2: row.nAttr2,
    nAttr3: row.nAttr3,
    strName: "SYNTHETIC definition name, NOT Verbose",
  };
}
export function ModelRecord(
  row: InventoryVector["Records"][number],
  text: CTextCodec,
): UserInventoryRecord {
  return {
    ItemSn: row.ItemSn,
    StockSn: row.StockSn,
    Slot: row.Slot,
    Amount: row.Amount,
    DateCreated: Buffer.from(row.DateHex, "hex").readDoubleLE(),
    LevelCreated: row.LevelCreated,
    Verbose: text.Decode(Buffer.from(row.VerboseHex, "hex")),
  };
}
export function ModelResident(
  row: InventoryVector["Expected"]["Rows"][number],
  text: CTextCodec,
): UserInventory {
  const d = ModelDefinition(row.Definition, text);
  return {
    ...ModelRecord(row.Record, text),
    Category: d.Category,
    strAttr: d.strAttr,
    nAttr1: d.nAttr1,
    nAttr2: d.nAttr2,
    nAttr3: d.nAttr3,
    Modified: row.Modified,
  };
}
export function ModelUser(c: InventoryVector): CUser {
  const level = c.Level >= 1 && c.Level <= 450 ? c.Level : 1;
  const u = new CUser(
    UserInfo("Native", {
      Exp: g_nLevel2ExpTable[level - 1]!,
      Gender: 1,
      CommunitySvr: 0x12f1,
      GuildSn: 0xfedcba98,
    }),
    0x89abcdef,
  );
  u.SetFakeLevel(c.InitialFakeLevel);
  u.SetLevelIcon(c.InitialIconEnabled, c.InitialIconSN | 0);
  return u;
}
/** Synthetic TRUSTED native read-side row, NOT product/SQL/permanent defaults. */
export function NativeInventory(
  extra: Partial<UserInventory> = {},
): UserInventory {
  return {
    ItemSn: 7,
    StockSn: 0xfedcba98,
    Slot: 0,
    Amount: 3,
    DateCreated: 50000.5,
    LevelCreated: 32767,
    Verbose: "SYNTHETIC owned row",
    Category: 2,
    strAttr: "Item/Fixture",
    nAttr1: 1,
    nAttr2: 0,
    nAttr3: -1,
    Modified: 0,
    ...extra,
  };
}
