import { GameUpdateTiming } from "../Common/OfficialValues.ts";
import type { CGameSessionTable } from "./CGameSessionTable.ts";

/** Partial port of CTimerThreadNormal::Proc 00415B65 / UpdateGameSessions
 * 004158C9. Bun replaces the native worker/thread with an unref'd timeout.
 * Sleep BEFORE each traversal and schedule the next sleep AFTER synchronous
 * work, as native does; do not invent a 60Hz physics clock or catch-up frames.
 *
 * ONLY the table's explicitly bound ordinary Running/Result rounds are driven.
 * The native pool/room-cache/user/guild flush/logging jobs and waiting/loading/
 * practice Update paths remain unported. This timer cannot make a room playable.
 */
export class CTimerThreadNormal {
  private m_timer: ReturnType<typeof setTimeout> | undefined;
  private m_bStarted = false;
  private m_bStopped = false;
  private m_nFailedTicks = 0;
  constructor(readonly m_gameSessionTable: CGameSessionTable) {}

  /** Modern single-use lifecycle, not a claim to emulate CThread handles. */
  Start(): void {
    if (this.m_bStarted || this.m_bStopped)
      throw new Error("Game timer cannot be started twice or after cleanup");
    this.m_bStarted = true;
    this.Schedule();
  }
  Stop(): void {
    this.m_bStopped = true;
    clearTimeout(this.m_timer);
    this.m_timer = undefined;
  }
  IsRunning(): boolean {
    return this.m_bStarted && !this.m_bStopped;
  }
  GetFailedTickCount(): number {
    return this.m_nFailedTicks;
  }
  UpdateGameSessions(): void {
    this.m_gameSessionTable.UpdateGameSessions();
  }
  private Schedule(): void {
    if (this.m_bStopped) return;
    this.m_timer = setTimeout(() => {
      this.m_timer = undefined;
      if (this.m_bStopped) return;
      try {
        this.UpdateGameSessions();
      } catch {
        // The table isolates per-room failures. An unexpected outer failure is
        // counted without logging exception/SQL/account data or killing Bun.
        this.m_nFailedTicks++;
      } finally {
        // Stop called from a synchronous callback must prevent re-scheduling.
        this.Schedule();
      }
    }, GameUpdateTiming.NormalTimerIntervalMilliseconds);
    this.m_timer.unref();
  }
}
