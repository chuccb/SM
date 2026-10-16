import { CProtocolError } from "../Common/CProtocolError.ts";
import { CTime, StrictCalendarEnvironment } from "../Common/CTime.ts";
import { DefaultTextCodec, type CTextCodec } from "../Common/CTextCodec.ts";
import type { CDBClock } from "../Common/DB/CDBClock.ts";
import { CapturePreInventory } from "../Common/PreInventory.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import {
  CaptureUserInventoryRecord,
  type UserInventoryRecord,
} from "../Common/UserInventory.ts";
import type { CUserItemMan } from "./CUserItemMan.ts";
import {
  PlanInitPreInventory,
  type PreInventoryObservation,
  type PreInventoryUserState,
  type PreInventoryLoadPlan,
} from "./PreInventory.ts";
import {
  PlanInitUserInventory,
  type UserInventoryLoadPlan,
} from "./UserInventory.ts";

/** OBSERVATIONS only. Owned rows already contain observed raw OLE DATEs, NOT
 * Unix expiry, invented stock, SQL bindings or implicit financial outcomes.
 * Closed/unreached rowsets are never inspected. There are NO effect callbacks. */
export interface InventoryInitializationObservation {
  readonly Initial: Readonly<PreInventoryUserState>;
  readonly PreOpened: boolean;
  readonly PreRows: readonly Readonly<PreInventoryObservation>[];
  readonly OwnedOpened: boolean;
  readonly OwnedRows: readonly Readonly<UserInventoryRecord>[];
}
export type InventoryInitializationPlan = Readonly<
  {
    CatalogRevision: number;
    Pre: Readonly<PreInventoryLoadPlan>;
  } & (
    | {
        Stage: "pre-open-failed" | "owned-open-failed";
        Owned: null;
        ClockRevision: null;
      }
    | {
        Stage: "complete";
        Owned: Readonly<UserInventoryLoadPlan>;
        ClockRevision: number;
      }
  )
>;

/** CDBMan::InitUserInventory0040AF55 ordering, factored as an isolated observation
 * projection, NOT an implementation of native SQL/financial initialization.
 * Prefix XP may change the level used by owned expiry EVEN IF LoadOn failed;
 * a later owned-open failure does NOT erase the pre trace/After. Nothing here
 * installs After, deletes SQL, grants items or retries irreversible effects.
 * A single actual manager snapshot covers BOTH stages; clock generations are
 * fenced before/after all callbacks. Revisions are diagnostics, not authority. */
export function PlanUserInventoryInitialization(
  input: Readonly<InventoryInitializationObservation>,
  items: CUserItemMan,
  clock: CDBClock,
  text: CTextCodec = DefaultTextCodec,
): InventoryInitializationPlan {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid inventory initialization observation");
  const catalog = items.CaptureSnapshot();
  const { PreOpened, Initial } = input;
  if (typeof PreOpened !== "boolean")
    throw new CProtocolError("Invalid pre rowset-open observation");
  // Native short-circuit: do not touch OwnedOpened/Rows or any clock method
  // when pre-open failed; do not touch rows/clock on owned-open failure.
  const ownedOpened = PreOpened ? input.OwnedOpened : false;
  if (typeof ownedOpened !== "boolean")
    throw new CProtocolError("Invalid owned rowset-open observation");
  const clockState = ownedOpened ? clock.GetState() : null;
  const initial = { ...Initial };
  const preSource = PreOpened ? input.PreRows : [];
  if (
    !Array.isArray(preSource) ||
    preSource.length > RuntimePolicy.MaxNativePreInventoryLoadRows
  )
    throw new CProtocolError("Inventory initialization pre input limit");
  const ownedSource = ownedOpened ? input.OwnedRows : [];
  if (
    !Array.isArray(ownedSource) ||
    ownedSource.length > RuntimePolicy.MaxNativeInventoryLoadRows
  )
    throw new CProtocolError("Inventory initialization owned input limit");
  const preInputs = [...preSource],
    ownedInputs = [...ownedSource];
  // Latch BOTH stages before the first codec/catalog callout. Later mutation
  // of a source array or an earlier primitive cannot alter this observation.
  const preRows = preInputs.map((o) => {
    if (!o || typeof o !== "object" || Array.isArray(o))
      throw new CProtocolError("Invalid pre-inventory observation");
    const { Row, PremiumTicketResult, ExecResult, ReturnValue } = o;
    return Object.freeze({
      Row: CapturePreInventory(Row),
      PremiumTicketResult,
      ExecResult,
      ReturnValue,
    });
  });
  const ownedRows = ownedInputs.map(CaptureUserInventoryRecord);
  const assertStable = () => {
    if (items.GetState().Revision !== catalog.Revision)
      throw new CProtocolError(
        "Inventory initialization catalog generation changed",
      );
    if (clockState) {
      const current = clock.GetState();
      if (
        current.Revision !== clockState.Revision ||
        current.Synchronized !== clockState.Synchronized
      )
        throw new CProtocolError(
          "Inventory initialization clock generation changed",
        );
    }
  };
  assertStable();
  const pre = PlanInitPreInventory(preRows, catalog, initial, PreOpened, text);
  assertStable();
  if (!PreOpened)
    return Object.freeze({
      Stage: "pre-open-failed",
      CatalogRevision: catalog.Revision,
      Pre: pre,
      Owned: null,
      ClockRevision: null,
    });
  if (!ownedOpened)
    return Object.freeze({
      Stage: "owned-open-failed",
      CatalogRevision: catalog.Revision,
      Pre: pre,
      Owned: null,
      ClockRevision: null,
    });
  const environment = StrictCalendarEnvironment(() => clock.GetLocalTime());
  const owned = PlanInitUserInventory(
    ownedRows,
    catalog,
    pre.After.Level,
    () => {
      assertStable();
      const captured = clock.CaptureLocalTime();
      if (captured.Revision !== clockState!.Revision)
        throw new CProtocolError(
          "Inventory initialization clock generation changed",
        );
      // Explicit time avoids a second sample; retain native per-known-row reads,
      // including level-invalid rows, not one whole-batch 'now' observation.
      const value = new CTime(environment, captured.Time).GetVariantTime();
      assertStable();
      return value;
    },
    text,
  );
  assertStable();
  return Object.freeze({
    Stage: "complete",
    CatalogRevision: catalog.Revision,
    Pre: pre,
    Owned: owned,
    ClockRevision: clockState!.Revision,
  });
}
