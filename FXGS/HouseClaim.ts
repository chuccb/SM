import { CProtocolError } from "../Common/CProtocolError.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  GameContextLimit,
  HouseClaimRule,
  IntegerRange,
  SessionLimit,
  SlotStateMask,
} from "../Common/OfficialValues.ts";
import {
  ClientRequest,
  ServerResponse,
} from "../Common/Protocol/PacketTypes.ts";

/** Modern detached factoring of OnReqTakeHouse0041D941 / SetHouseState0041B817.
 * These are NOT recovered native types, a collision engine, or spawn proof.
 * The three drop bytes have no proven meaning here and remain opaque. */
export type HouseCell = readonly [number, number];
export type HouseDropRequest = readonly [number, number, number];
export type HouseAllocatedDrop = readonly [number, number, number, number];
export interface HouseBoardState {
  readonly States: readonly number[];
  readonly Counts: readonly number[];
  readonly NextBoxItem: number;
}
export interface HouseClaimPlan {
  readonly Slot: number;
  readonly Color: number;
  readonly Cells: readonly HouseCell[];
  readonly DropRequests: readonly HouseDropRequest[];
  readonly Before: HouseBoardState;
  readonly After: HouseBoardState;
  readonly AcceptedCells: readonly HouseCell[];
  readonly AllocatedDrops: readonly HouseAllocatedDrop[];
  readonly Delta: number;
}
function index(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= maximum)
    throw new CProtocolError("Invalid house claim index/byte");
}
function board(input: HouseBoardState): HouseBoardState {
  if (
    !input ||
    !Array.isArray(input.States) ||
    input.States.length !== GameContextLimit.Rows * GameContextLimit.Columns ||
    !Array.isArray(input.Counts) ||
    input.Counts.length !== SessionLimit.Players ||
    !Number.isInteger(input.NextBoxItem) ||
    input.NextBoxItem < GameContextLimit.FirstGeneratedBoxItem ||
    input.NextBoxItem > GameContextLimit.BoxItems
  )
    throw new CProtocolError("Invalid house board/allocator snapshot");
  for (const value of [...input.States, ...input.Counts])
    if (
      !Number.isInteger(value) ||
      value < IntegerRange.Int32Minimum ||
      value > IntegerRange.Int32Maximum
    )
      throw new CProtocolError("Invalid signed house state/count");
  return Object.freeze({
    States: Object.freeze([...input.States]),
    Counts: Object.freeze([...input.Counts]),
    NextBoxItem: input.NextBoxItem,
  });
}
/** No live mutation, clock, RNG, DB or transport. Out-of-axis cells are SKIPPED
 * as native, not fatal. Repeated pairs count only once. Allocator exhaustion is
 * an explicit modern ALL-OR-NOTHING rejection: native emits a truncated178 with
 * the original requested count. We do not emit that unsafe/incomplete image. */
export function PlanTakeHouse(
  before: HouseBoardState,
  slot: number,
  color: number,
  cells: readonly HouseCell[],
  drops: readonly HouseDropRequest[],
): HouseClaimPlan {
  index(slot, SessionLimit.Players);
  index(color, SlotStateMask.Color + 1);
  if (
    !Array.isArray(cells) ||
    !Array.isArray(drops) ||
    cells.length > HouseClaimRule.MaximumByteCount ||
    drops.length > HouseClaimRule.MaximumByteCount
  )
    throw new CProtocolError("Invalid house request count");
  const copy = <T extends readonly number[]>(
    rows: readonly T[],
    width: number,
  ): readonly T[] =>
    Object.freeze(
      rows.map((row) => {
        if (!Array.isArray(row) || row.length !== width)
          throw new CProtocolError("Invalid house request record");
        for (const value of row)
          index(value, HouseClaimRule.MaximumByteCount + 1);
        return Object.freeze([...row]) as unknown as T;
      }),
    );
  const Before = board(before),
    Cells = copy(cells, HouseClaimRule.CellFieldCount),
    DropRequests = copy(drops, HouseClaimRule.DropRequestFieldCount);
  if (Before.NextBoxItem + DropRequests.length > GameContextLimit.BoxItems)
    throw new CProtocolError(
      "House generated-box allocator exhausted; whole request rejected",
      "house-capacity",
    );
  const states = [...Before.States],
    counts = [...Before.Counts],
    accepted: HouseCell[] = [];
  for (const cell of Cells) {
    const [row, column] = cell;
    if (row >= GameContextLimit.Rows || column >= GameContextLimit.Columns)
      continue;
    const flat = row * GameContextLimit.Columns + column;
    if (states[flat] !== GameContextLimit.Unclaimed) continue;
    accepted.push(cell);
    states[flat] = slot;
    if (color < SessionLimit.Players) counts[color] = (counts[color]! + 1) | 0;
  }
  const allocated = DropRequests.map(
    ([a, b, c], i): HouseAllocatedDrop =>
      Object.freeze([a, Before.NextBoxItem + i, b, c]),
  );
  return Object.freeze({
    Slot: slot,
    Color: color,
    Cells,
    DropRequests,
    Before,
    After: board({
      States: states,
      Counts: counts,
      NextBoxItem: Before.NextBoxItem + drops.length,
    }),
    AcceptedCells: Object.freeze(accepted),
    AllocatedDrops: Object.freeze(allocated),
    Delta: Math.imul(HouseClaimRule.MoneyPerNewCell, accepted.length),
  });
}
export function MakeTakeHouseRequest(
  plan: Pick<HouseClaimPlan, "Slot" | "Cells" | "DropRequests">,
): CSendPacket {
  const p = new CSendPacket(ClientRequest.ReqTakeHouse)
    .Encode1(plan.Slot)
    .Encode1(plan.Cells.length);
  for (const cell of plan.Cells) for (const value of cell) p.Encode1(value);
  p.Encode1(plan.DropRequests.length);
  for (const drop of plan.DropRequests)
    for (const value of drop) p.Encode1(value);
  return p;
}
export function MakeTakeHousePacket(plan: HouseClaimPlan): CSendPacket {
  const p = new CSendPacket(ServerResponse.TakeHouse)
    .Encode1(plan.Slot)
    .Encode1(plan.AcceptedCells.length);
  for (const cell of plan.AcceptedCells)
    for (const value of cell) p.Encode1(value);
  p.Encode1(HouseClaimRule.DropSectionMarker).Encode1(
    plan.AllocatedDrops.length,
  );
  for (const drop of plan.AllocatedDrops)
    for (const value of drop) p.Encode1(value);
  return p;
}
