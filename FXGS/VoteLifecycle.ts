import { CProtocolError } from "../Common/CProtocolError.ts";
import { IntegerRange, SessionLimit } from "../Common/OfficialValues.ts";
export type NativeVoteTransition =
  | "RequestFailed"
  | "Launch"
  | "Begin"
  | "ReturnPrepare";
export interface NativeVoteState {
  readonly TargetSerialNo: number;
  readonly Votes: readonly number[];
}
/**00420F19/00420BB3/0041BDCF do NOT write votes/target. Ordinary0041B0DA
 * clears only target+828, not the+780 array. Immutable data, never an issuer,
 * callback, financial replay permission or a live Apply/Restore API. */
export function PlanNativeVoteTransition(
  source: NativeVoteState,
  kind: NativeVoteTransition,
): Readonly<NativeVoteState> {
  const { TargetSerialNo, Votes } = source,
    votes = Array.from(Votes);
  if (
    !["RequestFailed", "Launch", "Begin", "ReturnPrepare"].includes(kind) ||
    votes.length !== SessionLimit.Players ||
    [TargetSerialNo, ...votes].some(
      (v) => !Number.isInteger(v) || v < 0 || v > IntegerRange.UInt32Maximum,
    )
  )
    throw new CProtocolError("Invalid native vote transition observation");
  return Object.freeze({
    TargetSerialNo: kind === "ReturnPrepare" ? 0 : TargetSerialNo,
    Votes: Object.freeze(votes),
  });
}
