/** Native source unit: CX/CxLogin/TimerThread.cpp. */
import type { CCenterProcess } from "./CenterProcess.ts";
import { CConfigDyn } from "./ConfigDyn.ts";
import type { CUserPool } from "./UserPool.ts";

const TIMER_INTERVAL_MS = 0x190;
const CLIENT_SOCKET_FLUSH_TICKS = 6;
const LOCAL_SOCKET_FLUSH_TICKS = 3;
const LEVEL_LIMIT_UPDATE_TICKS = 0x2328;
const ADVERTISEMENT_SELECT_TICKS = 0x96;
const ADVERTISEMENT_FULL_UPDATE_TICKS = 0x1194;
const GUILD_SERVER_UPDATE_TICKS = 0x0bb8;
const FX_MESSAGE_UPDATE_TICKS = 0x270f;
const PREMIUM_REWARD_UPDATE_TICKS = 0x2b67;
const CLOCK_REPORT_TICKS = 1_500;

/** CTimerThread — the login server's periodic maintenance worker. */
export class CTimerThread {
  private m_nClientFlushTick = 0;
  private m_nLocalFlushTick = 0;
  private m_nLevelLimitTick = 0;
  private m_nAdvertisementTick = 0;
  private m_nGuildServerTick = 0;
  private m_nFxMessageTick = 0;
  private m_nPremiumRewardTick = 0;
  private m_nReportTick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly center: CCenterProcess,
    private readonly userPool: CUserPool,
  ) {}

  /** CTimerThread::FlushClientSocketSndBuffer; Bun writes immediately. */
  FlushClientSocketSndBuffer(): void {
    this.m_nClientFlushTick = (this.m_nClientFlushTick + 1) % CLIENT_SOCKET_FLUSH_TICKS;
  }

  /** CTimerThread::FlushLocalSocketSndBuffer; Bun writes immediately. */
  FlushLocalSocketSndBuffer(): void {
    this.m_nLocalFlushTick = (this.m_nLocalFlushTick + 1) % LOCAL_SOCKET_FLUSH_TICKS;
  }

  /** CTimerThread::UpdateLevelLimit. */
  UpdateLevelLimit(): void {
    const tick = this.m_nLevelLimitTick++;
    if (tick % LEVEL_LIMIT_UPDATE_TICKS === 0) this.center.UpdateLevelLimit();
  }

  /** CTimerThread::UpdateAdvertisement.
   * Preserve the native post-increment inside the 150-tick gate. */
  UpdateAdvertisement(): void {
    if (this.m_nAdvertisementTick % ADVERTISEMENT_SELECT_TICKS !== 0) return;
    const tick = this.m_nAdvertisementTick++;
    this.center.UpdateAdvertisement(tick % ADVERTISEMENT_FULL_UPDATE_TICKS === 0 ? 1 : 0);
  }

  /** CTimerThread::UpdateGuildSvrList. */
  UpdateGuildSvrList(): void {
    const tick = this.m_nGuildServerTick++;
    if (tick % GUILD_SERVER_UPDATE_TICKS === 0) this.center.UpdateGuildServerList();
  }

  /** CTimerThread::UpdateFxMessage. */
  UpdateFxMessage(): void {
    const tick = this.m_nFxMessageTick++;
    if (tick % FX_MESSAGE_UPDATE_TICKS === 0) this.center.UpdateFxMessage();
  }

  /** CTimerThread::UpdatePremiumChannelMapSelReward. */
  UpdatePremiumChannelMapSelReward(): void {
    const tick = this.m_nPremiumRewardTick++;
    if (tick % PREMIUM_REWARD_UPDATE_TICKS === 0) this.center.UpdatePremiumChannelMapSelReward();
  }

  /** CTimerThread::OnTimer, in native call order. */
  OnTimer(): void {
    this.userPool.OnTimer();
    this.FlushLocalSocketSndBuffer();
    this.FlushClientSocketSndBuffer();
    this.UpdateLevelLimit();
    this.UpdateAdvertisement();
    this.UpdateGuildSvrList();
    this.UpdateFxMessage();
    this.UpdatePremiumChannelMapSelReward();
    CConfigDyn.ms_pInstance?.OnTimer();
    if (this.m_nReportTick % CLOCK_REPORT_TICKS === 0) console.log(`[LS] ${new Date().toLocaleString()}`);
    this.m_nReportTick++;
  }

  /** CTimerThread::Proc — represented by Bun's non-blocking interval. */
  Start(): void {
    if (this.timer !== null) return;
    console.log("[LS] TimerThread started.");
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
