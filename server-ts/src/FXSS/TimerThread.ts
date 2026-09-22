/** Native source unit: FX/FxShop/TimerThread.cpp. */
import { timeGetTime } from "../core/timeGetTime.ts";
import { CLIENT_SOCKET_CENSUS_MS } from "../core/PacketSocket.ts";
import type { CBillingProcess } from "./BillingProcess.ts";
import { CClientSocket } from "./ClientSocket.ts";
import type { CMainPool } from "./MainPool.ts";

const TIMER_INTERVAL_MS = 0x190;
const CLIENT_SOCKET_FLUSH_TICKS = 6;
const CLOCK_REPORT_TICKS = 750;
const LOCAL_SOCKET_FLUSH_TICKS = 4;

/** CTimerThread — FxShop's 400 ms maintenance worker. */
export class CTimerThread {
  private m_nReportTick = 0;
  private m_nClientFlushTick = 0;
  private m_nLocalFlushTick = 0;
  private m_nBillingFlushTick = 0;
  private censusTime: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly mainPool: CMainPool,
    private readonly billing: CBillingProcess,
  ) {}

  /** CTimerThread::OnTimer — the native diagnostic clock runs every 750 ticks. */
  OnTimer(): void {
    if (++this.m_nReportTick % CLOCK_REPORT_TICKS === 0) console.log(`[Shop] ${new Date().toLocaleString()}`);
  }

  /** CTimerThread::FlushClientSocketSndBuffer.
   * Bun writes packets immediately; retain the native six-tick cadence and
   * five-minute socket census without inventing a second output buffer. */
  FlushClientSocketSndBuffer(): void {
    if (++this.m_nClientFlushTick % CLIENT_SOCKET_FLUSH_TICKS !== 0) return;
    const now = timeGetTime();
    this.censusTime ??= now;
    if (((now - this.censusTime) >>> 0) <= CLIENT_SOCKET_CENSUS_MS) return;

    let sockets = 0;
    let users = 0;
    for (const socket of CClientSocket.ms_tblSN2Obj.values()) {
      const count = socket.GetUserCount();
      if (count !== 0) {
        sockets++;
        users += count;
      }
    }
    if (sockets !== 0 && users !== 0) console.log(`[Shop] Socket count(${sockets}), UserCount(${users})`);
    this.censusTime = now;
  }

  /** CTimerThread::FlushLocalSocketSndBuffer; writes are immediate in the port. */
  FlushLocalSocketSndBuffer(): void {
    this.m_nLocalFlushTick = (this.m_nLocalFlushTick + 1) % LOCAL_SOCKET_FLUSH_TICKS;
  }

  /** CTimerThread::FlushBillingSocketSndBuffer; writes are immediate in the port. */
  FlushBillingSocketSndBuffer(): void {
    this.m_nBillingFlushTick = (this.m_nBillingFlushTick + 1) >>> 0;
  }

  private Tick(): void {
    this.OnTimer();
    this.mainPool.OnTimer();
    // Billing OnTimer is async (Bun.connect loop); fire-and-forget like native,
    // but surface errors instead of silencing with `void`.
    this.billing.OnTimer().catch((e) => console.error("[Shop] Billing OnTimer error", e));
    this.FlushLocalSocketSndBuffer();
    this.FlushBillingSocketSndBuffer();
    this.FlushClientSocketSndBuffer();
  }

  /** CTimerThread::Proc — represented by Bun's non-blocking interval. */
  Start(): void {
    if (this.timer !== null) return;
    console.log("[Shop] TimerThread started.");
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
