import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  IntegerRange,
  SessionLimit,
  SlotStateMask,
  UserCount,
} from "../Common/OfficialValues.ts";

/** Native004198FD/004199E5/00423D8D/0041AF4B projection only. PrimaryColor
 * and resolved bomber selections are observed from existing resource policy;
 * this module neither reads resources nor grants user/table/financial authority. */
export interface WaitingVoteJoinObservation {
  readonly Occupied: readonly boolean[];
  readonly SlotInfo: readonly (readonly number[])[];
  readonly Votes: readonly number[];
  readonly TargetSerialNo: number;
  readonly ChiefSlot: number;
}
export interface WaitingVoteJoinPlan {
  readonly Slots: readonly number[];
  readonly SlotInfo: readonly (readonly number[])[];
  /** AddUser does NOT write votes or target. Deleted healthy vacancies already
   * have0; never manufacture a pending ballot or erase arbitrary observed bits. */
  readonly Votes: readonly number[];
  readonly TargetSerialNo: number;
  readonly ChiefSlot: number;
}
export function PlanWaitingVoteJoin(
  source: WaitingVoteJoinObservation,
  bombers: readonly number[],
  primaryColor: number,
): Readonly<WaitingVoteJoinPlan> {
  const occupied = Array.from(source.Occupied),
    info = Array.from(source.SlotInfo, (r) => Array.from(r)),
    votes = Array.from(source.Votes),
    target = source.TargetSerialNo,
    chief = source.ChiefSlot,
    selected = Array.from(bombers);
  if (
    occupied.length !== SessionLimit.Players ||
    info.length !== SessionLimit.Players ||
    votes.length !== SessionLimit.Players ||
    occupied.some((x) => typeof x !== "boolean") ||
    info.some(
      (r) =>
        r.length !== 3 ||
        r.some(
          (n) => !Number.isInteger(n) || n < 0 || n > IntegerRange.UInt8Maximum,
        ),
    ) ||
    votes.some(
      (n) => !Number.isInteger(n) || n < 0 || n > IntegerRange.UInt32Maximum,
    ) ||
    !Number.isInteger(target) ||
    target <= 0 ||
    target > IntegerRange.UInt32Maximum ||
    !Number.isInteger(chief) ||
    chief < 0 ||
    chief >= SessionLimit.Players ||
    !occupied[chief] ||
    selected.length < UserCount.Minimum ||
    selected.length > UserCount.Maximum ||
    selected.some(
      (n) => !Number.isInteger(n) || n < 0 || n > SlotStateMask.Bomber,
    ) ||
    !Number.isInteger(primaryColor) ||
    primaryColor < 0 ||
    primaryColor > SlotStateMask.Color
  )
    throw new CProtocolError("Invalid waiting-vote join observation");
  const slots: number[] = [];
  for (const bomber of selected) {
    const slot = occupied.findIndex(
      (yes, i) => !yes && !(info[i]![0]! & SlotStateMask.Closed),
    );
    if (slot < 0)
      throw new CProtocolError("Insufficient open waiting-vote join slots");
    occupied[slot] = true;
    slots.push(slot);
    const row = info[slot]!;
    row[0] = row[0]! & ~(SlotStateMask.Chief | SlotStateMask.Status);
    row[1] = (row[1]! & ~SlotStateMask.Bomber) | bomber;
    row[2] = (row[2]! & ~SlotStateMask.Color) | primaryColor;
  }
  return Object.freeze({
    Slots: Object.freeze(slots),
    SlotInfo: Object.freeze(info.map((r) => Object.freeze(r))),
    Votes: Object.freeze(votes),
    TargetSerialNo: target,
    ChiefSlot: chief,
  });
}
