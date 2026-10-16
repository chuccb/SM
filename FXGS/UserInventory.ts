import { CProtocolError } from "../Common/CProtocolError.ts";
import { DefaultTextCodec, type CTextCodec } from "../Common/CTextCodec.ts";
import { IntegerRange, UserInventoryRule } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { CopyUserItem, type UserItemSnapshot } from "../Common/UserItem.ts";
import {
  CopyUserInventory,
  CopyUserInventoryRecord,
  type UserInventory,
  type UserInventoryEquipment,
  type UserInventoryRecord,
} from "../Common/UserInventory.ts";

/** Detached factoring of InitUserInventory0040AF55 AFTER InitPreInventory.
 * Rows/clock must already be native GetVariantTime observations. NOT an adapter
 * from SQLite SN/ItemID/Unix expiry; NOT SQL deletion, pre-inventory billing,
 * CTime/Win32 API emulation, transfer authorization or durable publication. */
export interface UserInventoryDeleteAttempt {
  readonly RowIndex: number;
  readonly ItemSn: number; // DeleteInventory0040A10E keys UserID + ItemSN
  readonly LevelExpired: boolean;
  readonly DateExpired: boolean;
}
export interface UserInventoryLoadPlan {
  readonly CatalogRevision: number;
  readonly Rows: readonly Readonly<UserInventory>[];
  readonly Equipment: Readonly<UserInventoryEquipment>;
  readonly DeleteAttempts: readonly Readonly<UserInventoryDeleteAttempt>[];
  readonly MissingDefinitionRows: readonly number[];
  readonly RowsetReads: number; // GetNextRow calls, including EOF or extra bound read
  readonly FetchedRows: number; // includes the unprocessed401st row when present
  readonly CountedRows: number; // missing definition + accepted, NOT expired/deleted
  readonly ClockReads: number;
}
export function PlanInitUserInventory(
  source: readonly Readonly<UserInventoryRecord>[],
  catalog: UserItemSnapshot,
  cachedLevel: number,
  currentVariantTime: () => number,
  text: CTextCodec = DefaultTextCodec,
): UserInventoryLoadPlan {
  if (
    !Array.isArray(source) ||
    source.length > RuntimePolicy.MaxNativeInventoryLoadRows
  )
    throw new CProtocolError("Native inventory projection input limit");
  if (
    !Number.isInteger(cachedLevel) ||
    cachedLevel < IntegerRange.Int32Minimum ||
    cachedLevel > IntegerRange.Int32Maximum
  )
    throw new CProtocolError("Invalid native inventory cached level");
  // Modern whole-input validation before callbacks; invalid unused tail rows
  // are rejected too. Do not silently install a partial/truncated projection.
  const records = [...source].map((r) => CopyUserInventoryRecord(r, text));
  const rows: Readonly<UserInventory>[] = [],
    deletes: Readonly<UserInventoryDeleteAttempt>[] = [],
    missing: number[] = [];
  const equipment: { FakeLevel?: number; LevelIconSN?: number } = {};
  let counted = 0,
    reads = 0,
    fetched = 0,
    clockReads = 0,
    i = 0;
  while (true) {
    reads++;
    const row = records[i++];
    if (!row) break;
    fetched++;
    if (counted >= UserInventoryRule.LoadCountLimit) break;
    const definition = catalog.GetUserItem(row.ItemSn);
    if (!definition) {
      missing.push(i - 1);
      counted++;
      continue;
    }
    const item = CopyUserItem(definition, text);
    if (item.SN !== row.ItemSn)
      throw new CProtocolError("Native inventory catalog identity mismatch");
    // MOVSX short -> CMP signed level. Native samples time EVEN IF level has
    // expired; a missing definition does NOT sample time or delete the row.
    const levelExpired = cachedLevel >= row.LevelCreated;
    const now = currentVariantTime();
    clockReads++;
    if (!Number.isFinite(now))
      throw new CProtocolError("Invalid native inventory current VariantTime");
    const dateExpired = now > row.DateCreated;
    if (levelExpired || dateExpired) {
      deletes.push(
        Object.freeze({
          RowIndex: i - 1,
          ItemSn: item.SN,
          LevelExpired: levelExpired,
          DateExpired: dateExpired,
        }),
      );
      continue; // native ignores DeleteInventory return value; NOT a confirmed deletion
    }
    rows.push(
      CopyUserInventory(
        {
          ...row,
          Category: item.Category,
          strAttr: item.strAttr,
          nAttr1: item.nAttr1,
          nAttr2: item.nAttr2,
          nAttr3: item.nAttr3,
          Modified: 0,
        },
        text,
      ),
    );
    if (row.Slot !== UserInventoryRule.UnequippedSlot) {
      if (item.Category === UserInventoryRule.LevelIconCategory)
        equipment.LevelIconSN = item.SN;
      if (item.Category === UserInventoryRule.FakeLevelCategory)
        equipment.FakeLevel = item.nAttr1;
    }
    counted++;
  }
  return Object.freeze({
    CatalogRevision: catalog.Revision,
    Rows: Object.freeze(rows),
    Equipment: Object.freeze(equipment),
    DeleteAttempts: Object.freeze(deletes),
    MissingDefinitionRows: Object.freeze(missing),
    RowsetReads: reads,
    FetchedRows: fetched,
    CountedRows: counted,
    ClockReads: clockReads,
  });
}
