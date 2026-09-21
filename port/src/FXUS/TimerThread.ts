/** Native source unit: CX/CxUtil/TimerThread.cpp. */
import type { CMainPool } from "./MainPool.ts";

const TIMER_INTERVAL_MS = 0x190;
const CLOCK_REPORT_TICKS = 750;
const CLIENT_SOCKET_FLUSH_TICKS = 6;
const LOCAL_SOCKET_FLUSH_TICKS = 4;

/** CTimerThread — CxUtil's 400 ms pool/socket maintenance worker. */
export class CTimerThread {
  private m_nReportTick = 0;
  private m_nClientFlushTick = 0;
  private m_nLocalFlushTick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly mainPool: CMainPool) {}

  /** CTimerThread::OnTimer — native wall-clock diagnostic every 750 ticks. */
  OnTimer(): void {
    if (++this.m_nReportTick % CLOCK_REPORT_TICKS === 0) console.log(`[FXUS] ${new Date().toLocaleString()}`);
  }

  /** CTimerThread::FlushClientSocketSndBuffer.
   * Native output buffers flush every six ticks; Bun writes immediately. */
  FlushClientSocketSndBuffer(): void {
    this.m_nClientFlushTick = (this.m_nClientFlushTick + 1) % CLIENT_SOCKET_FLUSH_TICKS;
  }

  /** CTimerThread::FlushLocalSocketSndBuffer.
   * Native center output flushes every four ticks; Bun writes immediately. */
  FlushLocalSocketSndBuffer(): void {
    this.m_nLocalFlushTick = (this.m_nLocalFlushTick + 1) % LOCAL_SOCKET_FLUSH_TICKS;
  }

  private Tick(): void {
    this.OnTimer();
    this.mainPool.OnTimer();
    this.FlushLocalSocketSndBuffer();
    this.FlushClientSocketSndBuffer();
  }

  /** CTimerThread::Proc — represented by Bun's non-blocking interval. */
  Start(): void {
    if (this.timer !== null) return;
    console.log("[FXUS] TimerThread started.");
    this.timer = setInterval(() => this.Tick(), TIMER_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** CThread::Terminate counterpart for the Bun interval adapter. */
  Stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
