import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  GameType,
  IntegerRange,
  SessionLimit,
} from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
export interface GameTypeObservation {
  readonly GameType: number;
  readonly Playing: boolean;
  readonly Manner: number;
  readonly TargetSerialNo: number;
  readonly Votes: readonly number[];
}
export interface GameTypePlan extends GameTypeObservation {
  readonly Opcode: number;
}
/** Native0041B509/0041B567 stores +948 then sends93/92. NO vote/target,
 * Manner,ready,helper,statistics,clock,strategy or SQL effect. Immutable data,
 * not permission to enter Mod combat or install an issued waiting mode. */
export function PlanGameTypeTransition(
  source: GameTypeObservation,
  requested: number,
): Readonly<GameTypePlan> {
  const { GameType: before, Playing, Manner, TargetSerialNo, Votes } = source,
    votes = Array.from(Votes);
  if (
    !Number.isInteger(before) ||
    before < IntegerRange.Int32Minimum ||
    before > IntegerRange.UInt32Maximum ||
    typeof Playing !== "boolean" ||
    !Number.isInteger(Manner) ||
    Manner < 0 ||
    Manner > IntegerRange.UInt8Maximum ||
    votes.length !== SessionLimit.Players ||
    [TargetSerialNo, ...votes].some(
      (v) => !Number.isInteger(v) || v < 0 || v > IntegerRange.UInt32Maximum,
    ) ||
    (requested !== GameType.Normal && requested !== GameType.Mod)
  )
    throw new CProtocolError("Invalid native game-type transition observation");
  return Object.freeze({
    GameType: requested,
    Playing,
    Manner,
    TargetSerialNo,
    Votes: Object.freeze(votes),
    Opcode:
      requested === GameType.Mod
        ? ServerResponse.GameTypeMod
        : ServerResponse.GameTypeNormal,
  });
}
