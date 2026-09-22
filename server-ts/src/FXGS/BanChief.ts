/** Native source unit: FX/FxServer/BanChief.cpp. */
import { CGameClock } from "./runtime/GameSessionSupport.ts";

const BAN_CHIEF_WARNING_DELAY_MS = 10_000; // GetWarningDelay, 401084
const BAN_CHIEF_WAIT_FULL_MS = 10_000; // IsBanChief's nonzero flag, 40102F
const BAN_CHIEF_WAIT_NOT_FULL_MS = 20_000; // IsBanChief's zero flag, 40102F
const BAN_CHIEF_ODD_SLOT_GRACE_MS = 5_000; // GetOddSlotInManner, 401091

/**
 * CBanChief (+12576) — the idle-room start-gate timers
 * (FxServer.exe.lst:401010..401140).  Stored times are timeGetTime DWORDs;
 * GetWarningDelay/GetOddSlotInManner take the native 1-or-3 chief timer
 * multiplier, never a timestamp.
 */
export class CBanChief {
  m_dwCanStartTime = 0; // +4 (SetCanStart)
  m_nCanStart = 0; // +8 (SetCanStart)
  m_nOddSlot = 0; // +12 (SetOddSlot)
  m_dwOddSlotTime = 0; // +16 (SetOddSlot)
  m_nWarnedBan = 0; // +14 (SetWarnedBan)
  m_dwWarnedBanTime = 0; // +18 (SetWarnedBan)
  m_nWarnedBanOddSlot = 0; // +1C (SetWarnedBanOddSlot)
  m_dwWarnedBanOddSlotTime = 0; // +20 (SetWarnedBanOddSlot)

  /** CBanChief::Init (401101) — SetOddSlot(0) then SetCanStart(0). */
  Init(): void {
    this.SetOddSlot(0);
    this.SetCanStart(0);
  }

  /** CBanChief::SetWarnedBanOddSlot (401010). */
  SetWarnedBanOddSlot(n: number): void {
    this.m_nWarnedBanOddSlot = n;
    this.m_dwWarnedBanOddSlotTime = n !== 0 ? CGameClock.Now() : 0;
  }

  /**
   * CBanChief::IsBanChief (40102F) — true once the unsigned DWORD elapsed
   * time since SetCanStart exceeds 10 s in a full room or 20 s otherwise,
   * multiplied by 3 for "Item/SuperChief".  The middle gameType argument is
   * present in the native signature but is not read.
   */
  IsBanChief(nRoomFull: number, _gameType: number, timerMultiplier: number): boolean {
    const elapsed = (CGameClock.Now() - this.m_dwCanStartTime) >>> 0;
    const baseDelay = nRoomFull !== 0 ? BAN_CHIEF_WAIT_FULL_MS : BAN_CHIEF_WAIT_NOT_FULL_MS;
    const delay = Math.imul(timerMultiplier, baseDelay) >>> 0;
    return elapsed > delay;
  }

  /** CBanChief::SetWarnedBan (401065). */
  SetWarnedBan(n: number): void {
    this.m_nWarnedBan = n;
    this.m_dwWarnedBanTime = n !== 0 ? CGameClock.Now() : 0;
  }

  /** CBanChief::GetWarningDelay (401084) — multiplier × 10 s as a DWORD. */
  GetWarningDelay(timerMultiplier: number): number {
    return Math.imul(timerMultiplier, BAN_CHIEF_WARNING_DELAY_MS) >>> 0;
  }

  /** CBanChief::GetOddSlotInManner (401091) — multiplier × 5 s as a DWORD. */
  GetOddSlotInManner(timerMultiplier: number): number {
    return Math.imul(timerMultiplier, BAN_CHIEF_ODD_SLOT_GRACE_MS) >>> 0;
  }

  /** CBanChief::SetCanStart (4010BB) — also clears both warned states. */
  SetCanStart(n: number): void {
    this.m_nWarnedBan = 0;
    this.m_dwWarnedBanTime = 0;
    this.m_dwCanStartTime = CGameClock.Now();
    this.m_nCanStart = n;
  }

  /** CBanChief::SetOddSlot (4010DA) — clears the odd-slot warned state. */
  SetOddSlot(n: number): void {
    this.m_nOddSlot = n;
    this.m_dwOddSlotTime = n !== 0 ? CGameClock.Now() : 0;
    this.m_nWarnedBanOddSlot = 0;
    this.m_dwWarnedBanOddSlotTime = 0;
  }
}
