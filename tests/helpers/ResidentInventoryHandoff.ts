import type { CUser } from "../../Common/CUser.ts";
import type { PreInventory } from "../../Common/PreInventory.ts";
import type {
  UserInventory,
  UserInventoryPresentation,
} from "../../Common/UserInventory.ts";
import { HandoffFixture } from "./InventoryHandoff.ts";
import { PreRow } from "./PreInventory.ts";
import { NativeInventory } from "./UserInventory.ts";
import data from "../fixtures/resident-inventory-handoff-vectors.json";

interface ResidentLocalVector {
  Mode: number;
  Exp: number;
  Level: number;
  Presentation: UserInventoryPresentation;
  OwnedRows: (Omit<UserInventory, "DateCreated"> & { DateHex: string })[];
  PreRows: PreInventory[];
}
export const ResidentHandoffVectors: {
  Model: string;
  Cases: {
    GameAttr: number;
    Initialized: boolean;
    Users: ResidentLocalVector[];
    LegacyReads: number;
    Expected: { Opcode: number; Hex: string }[];
  }[];
  OfficialPE: { SHA256: string };
  LevelInput: { LoginSHA256: string; GameSHA256: string; Entries: number };
  InstructionAnchors: { VA: number; Bytes: string; Meaning: string }[];
} = data;
export function ResidentRows(who = 0): UserInventory[] {
  return [0, 1].map((i) =>
    NativeInventory({
      ItemSn: i ? 0x80000000 : 7,
      StockSn: 0xfedcba98 - i,
      Slot: i ? 255 : 0,
      Amount: i ? 3 : -1,
      DateCreated: i ? -0 : -1.75,
      LevelCreated: -32768,
      Verbose: `NATIVE owned${who}-${i}`,
      Category: 2,
      strAttr: "resident attribute",
      nAttr1: -17,
      nAttr2: -2147483648,
      nAttr3: 2147483647,
      Modified: i ? 0 : 1,
    }),
  );
}
export function AttachResident(
  u: CUser,
  rows = ResidentRows(),
  pre = [PreRow()],
  who = 0,
) {
  u.InstallUserInventoryInitialization(rows, pre, {
    FakeLevel: -17 + who * 23,
  });
  u.SetLevelIcon(who ? 2 : 0, 0xfedcba98 | 0);
}
/** Explicit trusted read-side states; synthetic SQL stock is seeded EVEN for
 * native locals to prove it is NOT a fallback or an authorization source. */
export function ResidentHandoffFixture(modes: readonly number[] = [2, 2]) {
  const e = HandoffFixture({ Users: modes.length });
  e.users.forEach((u, i) => {
    e.session.db
      .query(
        "INSERT INTO FxUserInventory(SN,ID,ItemID,Slot,Amount,ExpireDate,Verbose) VALUES(?,?,7,255,?,0,?)",
      )
      .run(100 + i, u.GetName(), 4 + i, `LEGACY owned${i}`);
    if (modes[i])
      AttachResident(
        u,
        modes[i] === 1 ? [] : ResidentRows(i),
        [PreRow({ ItemSn: i ? 0x80000000 : 7 })],
        i,
      );
    else u.InstallPreInventory([PreRow({ ItemSn: i ? 0x80000000 : 7 })]);
  });
  return e;
}
export function VectorOwned(
  rows: ResidentLocalVector["OwnedRows"],
): UserInventory[] {
  return rows.map((r) => {
    const { DateHex, ...fields } = r;
    return {
      ...fields,
      DateCreated: Buffer.from(DateHex, "hex").readDoubleLE(),
    };
  });
}
