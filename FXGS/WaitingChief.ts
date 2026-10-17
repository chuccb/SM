import { CBanChief, type BanChiefState } from "./CBanChief.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import {
  BanChiefRule,
  BanChiefTiming,
  IntegerRange,
  SessionLimit,
} from "../Common/OfficialValues.ts";

export type BanChiefReason = 0 | 1 | 2 | 3;
export interface BanChiefNotice {
  readonly Reason: BanChiefReason;
  readonly Seconds: number;
  readonly ChiefOnly: boolean;
}
/** Trusted observations, NOT client fields or permission/grant inputs.
 * HasAuthority22 is constant0 in the supplied PE; no invented authority role.
 * Capacity is native BYTE+833, NOT PlayerCount BYTE+832. */
export interface WaitingChiefObservation {
  readonly Playing: boolean;
  readonly ChiefAvailable: boolean;
  readonly SuperChief: boolean;
  readonly Manner: boolean;
  readonly Capacity: number;
  readonly PlayerCount: number;
}
export interface WaitingChiefPlan {
  readonly After: Readonly<BanChiefState>;
  readonly Notices: readonly Readonly<BanChiefNotice>[];
  readonly Eject: boolean;
}

/** Manual port of DeferBanChief0041C15B and the ordinary chief-departure Init.
 * Prepare ONLY: changes a detached CBanChief; no roster, packet queue or SQL.
 * Keep distinct entry/setter/IsBanChief time reads and unsigned strict > tests.
 * Modern preflight samples the ordinary removal Init / final reset BEFORE any
 * transport callback, then installs those exact markers during destruction.
 * CanStartGame is a trusted read-only port, called ONLY after the odd-slot tail.
 * It must use native +1180 (playing map), not the pending selected map +850. */
export function PlanDeferBanChief(
  before: CBanChief,
  observation: Readonly<WaitingChiefObservation>,
  timeGetTime: () => number,
  canStartGame: () => number,
  /** Detached removal preparation at the native Init position. No live effects. */
  prepareRemoval?: (next: CBanChief) => void,
): Readonly<WaitingChiefPlan> {
  const next = before.Fork(timeGetTime),
    notices: Readonly<BanChiefNotice>[] = [];
  let eject = false;
  const finish = () =>
    Object.freeze({
      After: next.CaptureSnapshot(),
      Notices: Object.freeze(notices),
      Eject: eject,
    });
  if (observation.Playing) {
    next.Init();
    return finish();
  }
  if (!observation.ChiefAvailable) return finish();
  const { SuperChief, Manner, Capacity, PlayerCount } = observation;
  if (
    [Capacity, PlayerCount].some(
      (n) => !Number.isInteger(n) || n < 0 || n > SessionLimit.Players,
    ) ||
    typeof SuperChief !== "boolean" ||
    typeof Manner !== "boolean"
  )
    throw new CProtocolError("Invalid waiting chief observation");
  const multiplier = SuperChief ? BanChiefTiming.SuperChiefMultiplier : 1,
    time = timeGetTime() >>> 0,
    seconds = Math.floor(
      next.GetWarningDelay(multiplier) / BanChiefTiming.MillisecondsPerSecond,
    );
  const notice = (Reason: BanChiefReason, ChiefOnly: boolean) => {
    notices.push(Object.freeze({ Reason, Seconds: seconds, ChiefOnly }));
  };
  const remove = (Reason: 2 | 3) => {
    notice(Reason, true);
    eject = true;
    if (prepareRemoval) prepareRemoval(next);
    else next.Init(); // ordinary CGameSession::DestroyPlayer, chiefLeft branch
    if (Reason === BanChiefRule.OddSlotEjection) next.SetOddSlot(false);
    else next.SetCanStart(false); // native tail AFTER table removal / pool4
    return finish();
  };
  const oddCapacity = Manner ? Capacity % 2 !== 0 : Capacity <= 1;
  if (oddCapacity) {
    if (!next.IsOddSlot()) next.SetOddSlot(true);
    else if (
      (time - next.GetLastTimeEvenSlot()) >>> 0 >
      next.GetOddSlotInManner(multiplier)
    ) {
      if (!next.IsWarnedBanOddSlot()) {
        next.SetWarnedBanOddSlot(true);
        notice(BanChiefRule.OddSlotWarning, false);
      } else if (
        (time - next.GetWarnedTimeOddSlot()) >>> 0 >
        next.GetWarningDelay(multiplier)
      )
        return remove(BanChiefRule.OddSlotEjection);
    }
  } else next.SetOddSlot(false);
  if (canStartGame() !== 0) next.SetCanStart(false);
  else if (!next.IsCanStart()) next.SetCanStart(true);
  else if (next.IsBanChief(Capacity === PlayerCount, Manner, multiplier)) {
    if (!next.IsWarnedBan()) {
      next.SetWarnedBan(true);
      notice(BanChiefRule.CanStartWarning, false);
    } else if (
      (time - next.GetWarnedTime()) >>> 0 >
      next.GetWarningDelay(multiplier)
    )
      return remove(BanChiefRule.CanStartEjection);
  }
  return finish();
}

export function MakeBanChiefPacket(
  notice: Readonly<BanChiefNotice>,
  text?: CTextCodec,
): CSendPacket {
  const { Reason, Seconds, ChiefOnly } = notice;
  if (
    !Number.isInteger(Reason) ||
    Reason < 0 ||
    Reason > 3 ||
    !Number.isInteger(Seconds) ||
    Seconds < 0 ||
    Seconds > IntegerRange.UInt16Maximum ||
    ChiefOnly !== Reason >= BanChiefRule.CanStartEjection
  )
    throw new CProtocolError("Invalid chief notice");
  return new CSendPacket(ServerResponse.BanChief, undefined, text)
    .Encode1(Reason)
    .Encode2(Seconds);
}
