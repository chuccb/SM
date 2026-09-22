/** Native source unit: FX/FxServer/TimerThread.cpp. */
import { timeGetTime } from "../core/timeGetTime.ts";
import type { CDBMan } from "../db/DBMan.ts";
import { CLIENT_SOCKET_CENSUS_MS } from "../core/PacketSocket.ts";
import { CHANNEL_TYPE_GUILD } from "./Defs.ts";
import type { CChannelPool } from "./ChannelPool.ts";
import { CClientSocket } from "./ClientSocket.ts";
import type { CConnectPool } from "./ConnectPool.ts";
import type { CGameSessionTable } from "./GameSessionTable.ts";
import { CGuildTable } from "./Guild.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { CMainSystem } from "./MainSystem.ts";

const TIMER_INTERVAL_MS = 0x190;
const CLIENT_SOCKET_FLUSH_TICKS = 0x0c;
const LOCAL_SOCKET_FLUSH_TICKS = 3;
const ROOM_INFO_FLUSH_TICKS = 0x0c;
const ROOM_TABLE_FLUSH_TICKS = 3;
const CLOCK_REPORT_TICKS = 0x2ee;
const FREE_SERVER_CACHE_TICKS = 0x0c;
const USER_INFO_FLUSH_TICKS = 0x96;
const GUILD_INFO_FLUSH_TICKS = 0x12c;
const PROFILE_REPORT_TICKS = 0x5dc;
const CPU_CHECK_TICKS = 3;

/** CTimerThread — native common base of the normal and time-critical workers. */
export abstract class CTimerThread {
  protected timer: ReturnType<typeof setInterval> | null = null;

  protected StartLoop(name: string, tick: () => void): void {
    if (this.timer !== null) return;
    console.log(`[GS] ${name} started.`);
    this.timer = setInterval(tick, TIMER_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** CThread::Terminate counterpart for the Bun interval adapter. */
  Stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** CTimerThreadNormal — room, user, guild, socket and session maintenance. */
export class CTimerThreadNormal extends CTimerThread {
  private m_nClientFlushTick = 0;
  private m_nLocalFlushTick = 0;
  private m_nRoomFlushTick = 0;
  private m_nRoomTableFlushTick = 0;
  private m_nTimeLogTick = 0;
  private m_nFreeServerListTick = 0;
  private m_nUserFlushTick = 0;
  private m_nGuildFlushTick = 0;
  private m_nProfileTick = 0;
  private censusTime: number | null = null;

  constructor(
    private readonly db: CDBMan,
    private readonly connectPool: CConnectPool,
    private readonly channelPool: CChannelPool,
    private readonly sessionTable: CGameSessionTable,
  ) {
    super();
  }

  /** CTimerThreadNormal::FlushClientSocketSndBuffer. */
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
    if (sockets !== 0 && users !== 0) console.log(`[GS] Socket count(${sockets}), UserCount(${users})`);
    this.censusTime = now;
  }

  /** CTimerThreadNormal::FlushLocalSocketSndBuffer; Bun writes immediately. */
  FlushLocalSocketSndBuffer(): void {
    this.m_nLocalFlushTick = (this.m_nLocalFlushTick + 1) % LOCAL_SOCKET_FLUSH_TICKS;
  }

  /** CTimerThreadNormal::FlushRoomModifiedInfo. */
  FlushRoomModifiedInfo(): void {
    if (++this.m_nRoomFlushTick % ROOM_INFO_FLUSH_TICKS === 0) this.sessionTable.FlushModifiedInfo();
  }

  /** CTimerThreadNormal::FlushRoomTableModifiedInfo. */
  FlushRoomTableModifiedInfo(): void {
    if (++this.m_nRoomTableFlushTick % ROOM_TABLE_FLUSH_TICKS === 0) this.sessionTable.FlushModifiedTableInfo();
  }

  /** CTimerThreadNormal::DeferTimeLog. */
  DeferTimeLog(): void {
    if (++this.m_nTimeLogTick % CLOCK_REPORT_TICKS === 0) console.log(`[GS] ${new Date().toLocaleString()}`);
  }

  /** CTimerThreadNormal::DeferUpdateFreeServerListCache. */
  DeferUpdateFreeServerListCache(): void {
    if (++this.m_nFreeServerListTick % FREE_SERVER_CACHE_TICKS === 0) this.sessionTable.CacheGameServerList();
  }

  /** CTimerThreadNormal::UpdateGameSessions. */
  UpdateGameSessions(): void {
    this.sessionTable.UpdateGameSessions();
  }

  /** CTimerThreadNormal::FlushModifiedUserInfo. */
  FlushModifiedUserInfo(): void {
    if (++this.m_nUserFlushTick % USER_INFO_FLUSH_TICKS !== 0) return;
    CLocalUserTable.ms_pInstance!.ForEach((user) => user.DeferFlushModifiedInfo(this.db, 0));
    this.channelPool.FlushAll(0);
  }

  /** CTimerThreadNormal::FlushModifiedGuildInfo. */
  FlushModifiedGuildInfo(): void {
    if (CMainSystem.ms_pInstance!.m_nChannelType !== CHANNEL_TYPE_GUILD) return;
    if (++this.m_nGuildFlushTick % GUILD_INFO_FLUSH_TICKS === 0) {
      CGuildTable.ms_pInstance!.ForEach((guild) => guild.DeferFlushModifiedInfo(0));
    }
  }

  /** CTimerThreadNormal::FlushProfile; present natively but not called by Proc. */
  FlushProfile(): void {
    if (++this.m_nProfileTick % PROFILE_REPORT_TICKS === 0) console.log(`[GS] PROFILE MARK, AT ${new Date().toLocaleString()}`);
  }

  private Tick(): void {
    this.connectPool.OnTimer();
    this.channelPool.OnTimer();
    this.FlushRoomModifiedInfo();
    this.FlushRoomTableModifiedInfo();
    this.DeferUpdateFreeServerListCache();
    this.FlushModifiedUserInfo();
    this.FlushModifiedGuildInfo();
    this.FlushLocalSocketSndBuffer();
    this.FlushClientSocketSndBuffer();
    this.UpdateGameSessions();
    this.DeferTimeLog();
  }

  /** CTimerThreadNormal::Proc — represented by Bun's non-blocking interval. */
  Start(): void {
    this.StartLoop("TimerThreadNormal", () => this.Tick());
  }
}

/** CTimerThreadTimeCritical — host CPU diagnostics, isolated from game state. */
export class CTimerThreadTimeCritical extends CTimerThread {
  private m_nCheckTick = 0;
  private previousCpu = process.cpuUsage();
  private previousTime = performance.now();

  /** CTimerThreadTimeCritical::CheckCPUUsage.
   * `process.cpuUsage` is the portable Bun equivalent of the native PDH
   * process counter; the percentage is measured against one CPU's wall time. */
  CheckCPUUsage(): void {
    if (++this.m_nCheckTick % CPU_CHECK_TICKS !== 0) return;
    const now = performance.now();
    const elapsedMicros = (now - this.previousTime) * 1_000;
    const currentCpu = process.cpuUsage();
    const usedMicros = currentCpu.user - this.previousCpu.user + currentCpu.system - this.previousCpu.system;
    this.previousCpu = currentCpu;
    this.previousTime = now;
    if (elapsedMicros <= 0) return;
    const percent = (usedMicros * 100) / elapsedMicros;
    if (percent >= 80) console.error(`[GS] Abnormal CPU Usage: ${percent.toFixed(2)}, at ${new Date().toLocaleString()}`);
  }

  /** CTimerThreadTimeCritical::Proc — represented by Bun's interval. */
  Start(): void {
    this.StartLoop("TimerThreadTimeCritical", () => this.CheckCPUUsage());
  }
}
