import { CProtocolError } from "../Common/CProtocolError.ts";
import { DefaultTextCodec, type CTextCodec } from "../Common/CTextCodec.ts";
import { CDynInfoCalculator } from "../Common/CDynInfoCalculator.ts";
import {
  IntegerRange,
  PreInventoryRule,
  UserDynamicRule,
  UserFieldSize,
} from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import {
  CapturePreInventory,
  CopyPreInventory,
  PreInventoryLong,
  PreInventoryCategory,
  type PreInventory,
} from "../Common/PreInventory.ts";
import type { UserItemSnapshot } from "../Common/UserItem.ts";

/** Observations, NOT effect callbacks. No SQL/premium/Center/flush operation is
 * performed by this module. In particular an observation does NOT prove that
 * an irreversible effect is safe to retry, committed or authorized by a lease. */
export interface PreInventoryObservation {
  readonly Row: Readonly<PreInventory>;
  readonly PremiumTicketResult: boolean;
  readonly ExecResult: number;
  readonly ReturnValue: number;
}
export interface PreInventoryUserState {
  readonly ID: string;
  readonly GlobalSerialNo: number;
  readonly Authencode: number; // FXGS BYTE, NOT Center DWORD or TicketDate
  readonly Exp: number;
  readonly Money: number;
  readonly Level: number;
  readonly DynamicModified: number;
  readonly SimpleInfoModified: number;
  readonly GamesSinceFlush: number;
}
export interface LoadOnUserInventoryCall {
  readonly PreInventorySn: number;
  readonly UserID: string;
  readonly ItemSN: number;
  readonly StockSN: number;
  readonly Slot: number;
  readonly Unit: number;
  readonly ValidityPeriod: number;
  readonly UserLevel: number;
  readonly TruncateOnly: number;
}
export type PreInventoryEvent = Readonly<
  { RowIndex: number } & (
    | { Kind: "SetPremiumTicket"; ValidityPeriod: number; Result: boolean }
    | { Kind: "SendAuthenCode"; GlobalSerialNo: number; Authencode: number }
    | {
        Kind: "IncDecExp";
        Delta: number;
        ExpAfter: number;
        LevelAfter: number;
        Direction: number;
      }
    | { Kind: "SetLevel"; Level: number }
    | { Kind: "IncDecMoney"; Delta: number; MoneyAfter: number }
    | { Kind: "DeferFlushModifiedInfo"; Force: number }
    | { Kind: "WriteUserDynInfo"; Exp: number; Money: number }
    | {
        Kind: "LoadOnUserInventory";
        Call: Readonly<LoadOnUserInventoryCall>;
        ExecResult: number;
        ReturnValue: number;
        Result: boolean;
      }
    | { Kind: "AppendPreInventory"; Index: number }
  )
>;
export interface PreInventoryLoadPlan {
  readonly Opened: boolean;
  readonly CatalogRevision: number;
  readonly Before: Readonly<PreInventoryUserState>;
  readonly After: Readonly<PreInventoryUserState>;
  readonly Rows: readonly Readonly<PreInventory>[];
  readonly Events: readonly PreInventoryEvent[];
  readonly MissingDefinitionRows: readonly number[];
  readonly RowsetReads: number;
  readonly FetchedRows: number;
  readonly SuccessfulRows: number;
}
function copyState(
  input: Readonly<PreInventoryUserState>,
  text: CTextCodec,
): Readonly<PreInventoryUserState> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid pre-inventory user state");
  const {
    ID,
    GlobalSerialNo,
    Authencode,
    Exp,
    Money,
    Level,
    DynamicModified,
    SimpleInfoModified,
    GamesSinceFlush,
  } = input;
  for (const n of [Exp, Money, Level, DynamicModified, SimpleInfoModified])
    if (
      !Number.isInteger(n) ||
      n < IntegerRange.Int32Minimum ||
      n > IntegerRange.Int32Maximum
    )
      throw new CProtocolError("Invalid signed pre-inventory state");
  for (const n of [GlobalSerialNo, GamesSinceFlush])
    if (!Number.isInteger(n) || n < 0 || n > IntegerRange.UInt32Maximum)
      throw new CProtocolError("Invalid pre-inventory DWORD state");
  if (
    !Number.isInteger(Authencode) ||
    Authencode < 0 ||
    Authencode > IntegerRange.UInt8Maximum ||
    typeof ID !== "string"
  )
    throw new CProtocolError("Invalid pre-inventory identity/auth BYTE");
  text.AssertSize(ID, UserFieldSize.ID, "PreInventory user ID", 1);
  return Object.freeze({
    ID,
    GlobalSerialNo,
    Authencode,
    Exp,
    Money,
    Level,
    DynamicModified,
    SimpleInfoModified,
    GamesSinceFlush,
  });
}

/** InitPreInventory0040ACF4: PURE projection of a fresh service-local load.
 * The count30 is SUCCESSES; missing definitions and failed procedures don't
 * count. A 31st row may be fetched but not processed. Every native prefix effect
 * precedes LoadOn and is NOT undone by a negative procedure result. No real
 * effects run here, and there is deliberately NO Apply/Retry-to-live API. */
export function PlanInitPreInventory(
  source: readonly Readonly<PreInventoryObservation>[],
  catalog: UserItemSnapshot,
  initial: Readonly<PreInventoryUserState>,
  rowsetOpened = true,
  text: CTextCodec = DefaultTextCodec,
): Readonly<PreInventoryLoadPlan> {
  if (
    !Array.isArray(source) ||
    source.length > RuntimePolicy.MaxNativePreInventoryLoadRows ||
    typeof rowsetOpened !== "boolean"
  )
    throw new CProtocolError("Invalid pre-inventory projection input");
  // Latch state/ALL row/outcome primitives before codec/catalog callbacks.
  // Whole-input validation (even an unused tail) is modern hardening.
  const stateInput = { ...initial },
    captured = [...source].map((input) => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new CProtocolError("Invalid pre-inventory observation");
      const { Row, PremiumTicketResult, ExecResult, ReturnValue } = input;
      return {
        Row: CapturePreInventory(Row),
        PremiumTicketResult,
        ExecResult,
        ReturnValue,
      };
    }),
    revision = catalog.Revision,
    before = copyState(stateInput, text),
    rows = captured.map((o) => {
      if (typeof o.PremiumTicketResult !== "boolean")
        throw new CProtocolError("Invalid premium-ticket observation");
      return Object.freeze({
        Row: CopyPreInventory(o.Row, text),
        PremiumTicketResult: o.PremiumTicketResult,
        ExecResult: PreInventoryLong(o.ExecResult),
        ReturnValue: PreInventoryLong(o.ReturnValue),
      });
    });
  if (
    !Number.isInteger(revision) ||
    revision < 1 ||
    revision > IntegerRange.UInt32Maximum
  )
    throw new CProtocolError("Invalid pre-inventory catalog revision");
  const after = { ...before },
    resident: Readonly<PreInventory>[] = [],
    events: PreInventoryEvent[] = [],
    missing: number[] = [];
  let reads = 0,
    fetched = 0,
    next = 0;
  if (rowsetOpened)
    while (true) {
      reads++;
      const observation = rows[next++];
      if (!observation) break;
      fetched++;
      if (resident.length >= PreInventoryRule.SuccessfulLoadLimit) break;
      const index = next - 1,
        row = observation.Row,
        raw = catalog.GetUserItem(row.ItemSn);
      if (!raw) {
        missing.push(index);
        continue;
      }
      const category = PreInventoryCategory(raw, row.ItemSn);
      const push = (event: PreInventoryEvent) =>
        events.push(Object.freeze(event));
      let truncate = 0;
      if (category === PreInventoryRule.PremiumTicketCategory) {
        push({
          Kind: "SetPremiumTicket",
          RowIndex: index,
          ValidityPeriod: row.ValidityPeriod,
          Result: observation.PremiumTicketResult,
        });
        if (
          observation.PremiumTicketResult &&
          after.Authencode !== PreInventoryRule.PremiumAuthencode
        )
          push({
            Kind: "SendAuthenCode",
            RowIndex: index,
            GlobalSerialNo: after.GlobalSerialNo,
            Authencode: PreInventoryRule.PremiumAuthencode,
          });
        // SendAuthenCode is a request. Native does NOT assign the local auth BYTE.
        truncate = 1; // even when SetPremiumTicket failed
      }
      if (category === PreInventoryRule.ExperienceCategory) {
        const oldLevel = after.Level;
        after.Exp = Math.max(0, (after.Exp + row.Amount) | 0);
        after.DynamicModified = 1;
        after.Level = CDynInfoCalculator.GetLevel(after.Exp);
        const direction = Math.sign(after.Level - oldLevel);
        if (direction) after.SimpleInfoModified = 1;
        push({
          Kind: "IncDecExp",
          RowIndex: index,
          Delta: row.Amount,
          ExpAfter: after.Exp,
          LevelAfter: after.Level,
          Direction: direction,
        });
        push({ Kind: "SetLevel", RowIndex: index, Level: after.Level });
        truncate = 1;
      }
      if (category === PreInventoryRule.MoneyCategory) {
        after.Money = Math.min(
          UserDynamicRule.MaximumMoney,
          Math.max(0, (after.Money + row.Amount) | 0),
        );
        after.DynamicModified = 1;
        push({
          Kind: "IncDecMoney",
          RowIndex: index,
          Delta: row.Amount,
          MoneyAfter: after.Money,
        });
        truncate = 1;
      }
      if (
        category === PreInventoryRule.MoneyCategory ||
        category === PreInventoryRule.ExperienceCategory
      ) {
        push({ Kind: "DeferFlushModifiedInfo", RowIndex: index, Force: 1 });
        //00417603: force resets games/dirty flags, then schedules writer. A trace
        // of WriteUserDynInfo is NOT an SQL acknowledgement or durable receipt.
        after.GamesSinceFlush = 0;
        after.DynamicModified = 0;
        after.SimpleInfoModified = 0;
        push({
          Kind: "WriteUserDynInfo",
          RowIndex: index,
          Exp: after.Exp,
          Money: after.Money,
        });
      }
      const call = Object.freeze({
        PreInventorySn: row.SN | 0,
        UserID: after.ID,
        ItemSN: row.ItemSn | 0,
        StockSN: row.StockSn | 0,
        Slot: row.Slot,
        Unit: row.Amount,
        ValidityPeriod: row.ValidityPeriod,
        UserLevel: (row.ValidityLevel + after.Level) | 0,
        TruncateOnly: truncate,
      });
      const success =
        observation.ExecResult >= 0 && observation.ReturnValue >= 0;
      push({
        Kind: "LoadOnUserInventory",
        RowIndex: index,
        Call: call,
        ExecResult: observation.ExecResult,
        ReturnValue: observation.ReturnValue,
        Result: success,
      });
      if (success) {
        push({
          Kind: "AppendPreInventory",
          RowIndex: index,
          Index: resident.length,
        });
        resident.push(row);
      }
    }
  return Object.freeze({
    Opened: rowsetOpened,
    CatalogRevision: revision,
    Before: before,
    After: Object.freeze(after),
    Rows: Object.freeze(resident),
    Events: Object.freeze(events),
    MissingDefinitionRows: Object.freeze(missing),
    RowsetReads: reads,
    FetchedRows: fetched,
    SuccessfulRows: resident.length,
  });
}
