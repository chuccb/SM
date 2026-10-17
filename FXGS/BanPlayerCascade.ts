import { CBanChief, type BanChiefState } from "./CBanChief.ts";
import {
  PlanBanPlayerAfterDeparture,
  type BanPlayerObservation,
  type BanPlayerDepartureObservation,
} from "./BanPlayer.ts";

export interface BanPlayerCascadePlan {
  readonly Departure: Readonly<BanPlayerDepartureObservation>;
  /** Native Init order, not final setter order. Socket keys retain the ORIGINAL
   * capture labels after the first group has disappeared. Data, not authority. */
  readonly Resets: readonly Readonly<{
    SocketKey: number;
    State: Readonly<BanChiefState>;
  }>[];
  readonly After: Readonly<BanChiefState>;
}
/**0041BA8D ->00424F78 -> table DestroyPlayer(TRUE), possibly chief-left twice.
 * Fork only. No roster/pool/ID/SQL/publication, and no executable capability.
 * The caller preflights distinct WinMM samples before consuming any roster. */
export function PlanBanPlayerCascade(
  source: BanPlayerObservation,
  departing: number,
  before: CBanChief,
  timeGetTime: () => number,
): Readonly<BanPlayerCascadePlan> {
  const departure = PlanBanPlayerAfterDeparture(source, departing),
    next = before.Fork(timeGetTime),
    resets: { SocketKey: number; State: Readonly<BanChiefState> }[] = [];
  if (source.Actors[source.ChiefSlot]?.SocketKey === departing) {
    next.Init();
    resets.push({ SocketKey: departing, State: next.CaptureSnapshot() });
  }
  const remaining = departure.Remaining,
    eject = departure.Decision?.Eject;
  if (
    eject &&
    remaining.Actors[remaining.ChiefSlot]?.SocketKey === eject.SocketKey
  ) {
    next.Init();
    resets.push({ SocketKey: eject.SocketKey, State: next.CaptureSnapshot() });
  }
  return Object.freeze({
    Departure: departure,
    Resets: Object.freeze(resets.map((r) => Object.freeze(r))),
    After: next.CaptureSnapshot(),
  });
}
