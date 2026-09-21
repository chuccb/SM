/** Native source unit: CX/CxRelay/TimerThread.cpp. */
import { TIMER_DATE_STRIDE, TIMER_TICK, WEEK_DAYS } from "./Defs.ts";
import { Report } from "./Report.ts";

/**
 * CTimerThread — the 400 ms tick; every 750th tick logs the current time
 * (CTimerThread::OnTimer).
 */
export class CTimerThread {
  m_dwTick = 0; // dword_45D4B0
  private timer: ReturnType<typeof setInterval> | null = null;

  Run(): void {
    if (this.timer !== null) return;
    Report("TimerThread started.");
    this.timer = setInterval(() => {
      this.OnTimer();
    }, TIMER_TICK);
    this.timer.unref?.();
  }

  /** CThread::Terminate counterpart for the Bun interval adapter. */
  Stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** CTimerThread::OnTimer — "%d/%02d/%02d (%s) %02d:%02d". */
  OnTimer(): void {
    this.m_dwTick++;
    if (this.m_dwTick % TIMER_DATE_STRIDE !== 0) return;
    const now = new Date();
    Report(
      `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} (${WEEK_DAYS[now.getDay()]}) ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    );
  }
}
