/**
 * Port-only ESM dependency boundary for CGameClock and CGameContext.
 *
 * Both classes and all of their native methods belong to
 * FX/FxServer/GameSession.cpp (FxServer.map: GameSession.obj); there are no
 * GameClock.cpp or GameContext.cpp source units.  Keeping these two leaf
 * classes outside GameSession.ts prevents the native BanChief/UdpLossRegulator
 * dependencies from forming an unsafe JavaScript initialization cycle.  The
 * public source-unit façade remains GameSession.ts.
 */
import { timeGetTime } from "../../core/timeGetTime.ts";
import {
  GAME_CONTEXT_BOX_CAPACITY,
  GAME_CONTEXT_BOX_SERIAL_START,
  GAME_CONTEXT_BULA_COLUMNS,
  GAME_CONTEXT_BULA_COUNT,
  GAME_CONTEXT_DIE_COORDS_PER_SLOT,
  GAME_CONTEXT_TILE_COLUMNS,
  GAME_CONTEXT_TILE_COUNT,
  MAX_SESSION_SLOTS,
} from "../Defs.ts";

/** CGameClock (+12732) — StartGame/EndGame/ElapsedTime (FxServer.exe.c:41B843). */
export class CGameClock {
  m_dwSuspended = 0; // +0 (ResumeGame adds the suspend gap here)
  m_dwStartTime = 0; // +4
  m_dwEndTime = 0; // +8
  m_dwSuspendAt = 0; // +12

  static Now(): number {
    return timeGetTime();
  }

  StartGame(): void {
    this.m_dwSuspended = 0;
    this.m_dwEndTime = 0;
    this.m_dwStartTime = CGameClock.Now();
  }

  EndGame(): void {
    this.m_dwEndTime = CGameClock.Now();
  }

  /** CGameClock::SuspendGame / ResumeGame. */
  SuspendGame(): void {
    if (this.m_dwSuspendAt !== 0) {
      console.error("[GS] Mismatch suspend/resume game clock (suspend)");
      this.ResumeGame();
    }
    this.m_dwSuspendAt = CGameClock.Now();
  }

  ResumeGame(): void {
    if (this.m_dwSuspendAt !== 0) {
      const gap = (CGameClock.Now() - this.m_dwSuspendAt) >>> 0;
      this.m_dwSuspendAt = 0;
      this.m_dwSuspended = (this.m_dwSuspended + gap) >>> 0;
    } else {
      console.error("[GS] Mismatch suspend/resume game clock (resume)");
    }
  }

  ElapsedTime(): number {
    return (CGameClock.Now() - this.m_dwStartTime) >>> 0;
  }
}

/**
 * CGameContext — the in-play object state (0x288C bytes at CGameSession+1184;
 * CGameSession::SetCurrentGameContext picks ctx 0).  Field offsets are ctx
 * relative (FxServer.exe.c:41CD9B CGameContext::Init).
 */
export class CGameContext {
  m_rgnTeamScore = new Int32Array(MAX_SESSION_SLOTS); // +0 (SetHouseState ++ per color)
  /** +32, 20 bytes per bomb, m_nBombCount entries. */
  m_rgBomb: { id: number; fMoving: number; timer: number; x: number; y: number; sub: number; fFlag16: number }[] = [];
  m_nBombCount = 0; // +4812; ignite refuses GAME_CONTEXT_BOMB_CAPACITY
  m_nBombIdCounter = 0; // +4816 (the per-ignite serial)
  m_nBoxItemCounter = GAME_CONTEXT_BOX_SERIAL_START; // +4916
  m_rgnBoxItem = new Int32Array(GAME_CONTEXT_BOX_CAPACITY); // +3032 (0 free / 1 eaten)
  m_rgnObstacle = new Int32Array(GAME_CONTEXT_TILE_COUNT); // +4032 (0 free / 1 eaten)
  /** +4820 — per-slot down time (CGameClock::ElapsedTime at the trap/death). */
  m_rgnDownTime = new Int32Array(MAX_SESSION_SLOTS);
  /** +4852 — per-slot [E2 x][E2 y] pair written by OnSetBomberEvent case 2. */
  m_rgnDiePos = new Int32Array(MAX_SESSION_SLOTS * GAME_CONTEXT_DIE_COORDS_PER_SLOT);
  m_rgnBula = new Int32Array(GAME_CONTEXT_BULA_COUNT); // +4920; -1 init
  m_rgnHouse = new Int32Array(GAME_CONTEXT_TILE_COUNT); // +9600; -1 init

  /** CGameContext::Init (FxServer.exe.c:41CD9B). */
  Init(): void {
    this.m_rgnTeamScore.fill(0);
    this.m_rgBomb = [];
    this.m_nBombCount = 0;
    this.m_nBombIdCounter = 0;
    this.m_rgnBoxItem.fill(0);
    this.m_rgnObstacle.fill(0);
    this.m_nBoxItemCounter = GAME_CONTEXT_BOX_SERIAL_START;
    this.m_rgnDownTime.fill(0);
    this.m_rgnDiePos.fill(0);
    this.m_rgnBula.fill(-1);
    this.m_rgnHouse.fill(-1);
  }

  /** CGameContext::AddBoxItem — the running box serial, -1 at the native cap. */
  AddBoxItem(): number {
    if (this.m_nBoxItemCounter >= GAME_CONTEXT_BOX_CAPACITY) return -1;
    return this.m_nBoxItemCounter++;
  }

  /** CGameContext::GetBulaState / SetBulaState. */
  GetBulaState(x: number, y: number): number {
    return this.m_rgnBula[GAME_CONTEXT_BULA_COLUMNS * x + y]!;
  }

  SetBulaState(x: number, y: number, value: number): void {
    this.m_rgnBula[GAME_CONTEXT_BULA_COLUMNS * x + y] = value;
  }

  /** CGameContext::GetHouseState / SetHouseState. */
  GetHouseState(row: number, col: number): number {
    return this.m_rgnHouse[GAME_CONTEXT_TILE_COLUMNS * row + col]!;
  }

  SetHouseState(row: number, col: number, value: number, color: number): void {
    this.m_rgnHouse[GAME_CONTEXT_TILE_COLUMNS * row + col] = value;
    if (color < MAX_SESSION_SLOTS) this.m_rgnTeamScore[color]!++;
  }
}
