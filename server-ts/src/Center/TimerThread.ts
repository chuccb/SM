/** Native source unit: CX/CxCenter/TimerThread.cpp. */
import {
  CLOCK_REPORT_TICKS,
  SERVER_STATE_BROADCAST_TICKS,
  TIMER_INTERVAL_MS,
  TIMEOUT_SWEEP_TICKS,
  USER_COUNT_REPORT_TICKS,
} from "./Defs.ts";
import type { CGlobalUserTable } from "./GlobalUserTable.ts";

/** Port-only narrow dependency replacing the native app/singleton lookups. */
export interface CenterTimerHost {
  readonly globalUserTable: CGlobalUserTable;
  SendLocalSvrStatePacket(fRegister: number): void;
  MakeUserCountHTML(): number;
  MakeUserCountLog(): number;
}

/** CTimerThread — Center's 400 ms timeout/state-broadcast worker. */
export class CTimerThread {
  private m_nTick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: CenterTimerHost) {}

  /** CTimerThread::OnTimer. */
  OnTimer(): void {
    this.m_nTick = (this.m_nTick + 1) >>> 0;
    if (this.m_nTick % TIMEOUT_SWEEP_TICKS === 0) {
      this.host.globalUserTable.DeleteConnectionTimeoutUser();
    }
    if (this.m_nTick % SERVER_STATE_BROADCAST_TICKS === 0) {
      this.host.SendLocalSvrStatePacket(0);
    }
    if (this.m_nTick % USER_COUNT_REPORT_TICKS === 0) {
      this.host.MakeUserCountHTML();
      this.host.MakeUserCountLog();
    }
    if (this.m_nTick % CLOCK_REPORT_TICKS === 0) {
      console.log(`[Center] ${new Date().toLocaleString()}`);
    }
  }

  /** CTimerThread::Proc — represented by Bun's non-blocking interval. */
  Start(): void {
    if (this.timer !== null) return;
    console.log("[Center] TimerThread started.");
    this.timer = setInterval(() => this.OnTimer(), TIMER_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** CThread::Terminate counterpart for the Bun interval adapter. */
  Stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
