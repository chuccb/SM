/** Native source unit: FX/FxServer/DynInfoCalculator.cpp. */
import { CDynInfoCalculator_GetLevel, CDynInfoCalculator_GetMaxExpInLevel, LEVEL_EXP_SENTINEL } from "../common/LevelTable.ts";
import { MAX_SESSION_SLOTS, SLOTSTATE_COLOR_MASK } from "./Defs.ts";
import { CMainSystem } from "./MainSystem.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";

/**
 * CDynInfoCalculator — the 0x254-byte statistics block at CGameSession+11684
 * (+0x2DA4).  CDynInfoCalculator::Init runs once per launch (the launch tail
 * of CGameSession::LaunchGameStage); the bomber-event / game-result units
 * then read it to award exp.  All offsets below are calculator relative.
 */
export class CDynInfoCalculator {
  m_nPlayerCount = 0; // +4 (non-empty slots)
  m_dwAvgWeight = 0; // +8 (float: Σ sqrt(level+100) / m_nPlayerCount)
  m_dwColourWeight = new Float32Array(MAX_SESSION_SLOTS); // +12 (per-colour average sqrt(level+100))
  m_vtSlotWeight = new Float32Array(MAX_SESSION_SLOTS); // +44 (+0x2C, per-slot sqrt(level+100))
  m_nSaveMatrix = new Int32Array(MAX_SESSION_SLOTS * MAX_SESSION_SLOTS); // +76 (+0x4C, 8×8 marks)
  // Offsets first-hand: SetKillerIndex (40B1DC) = ++*(this + 4*killer + 364),
  // SetSaverIndex (40B1EC) = ++*(this + 4*saver + 332).  These are also the
  // two bytes serialized by both CGameSession::SendGameResult and
  // CPracticeSession::SendGameResult through GetKillCount/GetSaveCount.
  m_vtKills = new Int32Array(MAX_SESSION_SLOTS); // +364 (+0x16C, GetKillCount)
  m_vtSaves = new Int32Array(MAX_SESSION_SLOTS); // +332 (+0x14C, GetSaveCount)
  m_nUnk18C = new Int32Array(MAX_SESSION_SLOTS); // +396 (+0x18C, zeroed only)
  m_vtNice = new Int32Array(MAX_SESSION_SLOTS); // +428 (+0x1AC, SetNice)
  // +460: the official writes -1 into empty slots (the decompiler rendered
  // the dword bit pattern as a NaN float because the surrounding fields are
  // weights).
  m_vtColour = new Int32Array(MAX_SESSION_SLOTS).fill(-1); // +460 (+0x1CC, GetTeamColor)
  m_vtColourCount = new Int32Array(MAX_SESSION_SLOTS); // +492 (+0x1EC, players per colour)
  m_vtMyTeamNo = new Int32Array(MAX_SESSION_SLOTS); // +524 (+0x20C, Get/IncMyTeamNo)
  m_vtOtherTeamNo = new Int32Array(MAX_SESSION_SLOTS); // +556 (+0x22C, Get/IncOtherTeamNo)
  m_nPremiumFlag = 0; // +588 (+0x24C, SetHasPremium / IsPremiumRewardCondition)
  m_nInvalidGame = 1; // +592 (+0x250, forced 1 by Init; 0 once a second socket is seen)

  /**
   * CDynInfoCalculator::Init (FxServer.exe.lst:40B337) — m_rgPlayer and the
   * slot-state triples (the colour byte lives at slotstate + 3*slot + 2).
   */
  Init(users: (CUser | null)[], slotstates: Uint8Array): void {
    this.m_nInvalidGame = 1; // mov [esi+250h], 1
    this.m_nPremiumFlag = 0;
    this.m_nPlayerCount = 0;
    this.m_dwAvgWeight = 0;
    for (let c = 0; c < MAX_SESSION_SLOTS; c++) {
      this.m_vtColour[c] = -1;
      this.m_vtSlotWeight[c] = 0;
      this.m_vtColourCount[c] = 0;
      this.m_vtKills[c] = 0; // [eax-80h] → +364
      this.m_vtSaves[c] = 0; // [eax-0A0h] → +332
      this.m_vtNice[c] = 0; // [eax-40h]
      this.m_nUnk18C[c] = 0; // [eax-60h]
      this.m_vtMyTeamNo[c] = 0; // [eax+20h]
      this.m_vtOtherTeamNo[c] = 0; // [eax+40h]
      this.m_dwColourWeight[c] = 0; // fldz / [eax-1C0h]
    }
    this.m_nSaveMatrix.fill(0); // memset(+4Ch, 0, 0x100)
    let firstSocket: CClientSocket | null = null; // var_C
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = users[slot]!;
      if (user === null) continue;
      if (firstSocket === null) {
        firstSocket = user.m_pSocket;
      } else if (firstSocket !== user.m_pSocket) {
        this.m_nInvalidGame = 0; // and [esi+250h], 0
      }
      this.m_nPlayerCount++;
      const level = user.m_nLevel; // [edi+7C0h]
      this.m_dwAvgWeight += Math.sqrt(level + 100.0); // sqrt ×1 → +8
      const colour = slotstates[3 * slot + 2]! & SLOTSTATE_COLOR_MASK;
      this.m_dwColourWeight[colour] += Math.sqrt(level + 100.0); // sqrt ×2 → +0xC+4*colour
      this.m_vtColourCount[colour]++; // inc [+0x1EC+4*colour]
      this.m_vtSlotWeight[slot] = Math.sqrt(level + 100.0); // sqrt ×3 → +0x2C+4*slot
      this.m_vtColour[slot] = colour; // mov [eax], ecx
    }
    if (this.m_nPlayerCount !== 0) this.m_dwAvgWeight /= this.m_nPlayerCount;
    for (let c = 0; c < MAX_SESSION_SLOTS; c++) {
      if (this.m_vtColourCount[c] !== 0) this.m_dwColourWeight[c] /= this.vtColourCountAt(c);
    }
  }

  private vtColourCountAt(c: number): number {
    return this.m_vtColourCount[c]!;
  }

  /** CDynInfoCalculator::IsInvalidGame — FxServer.exe:0040B1BE. */
  IsInvalidGame(): number {
    return this.m_nInvalidGame;
  }

  /** CDynInfoCalculator::SetHasPremium — FxServer.exe:0041AAF1. */
  SetHasPremium(hasPremium: number): void {
    this.m_nPremiumFlag = hasPremium;
  }

  /** CDynInfoCalculator::GetKillCount — FxServer.exe:0041AAFE. */
  GetKillCount(slot: number): number {
    return this.m_vtKills[slot]!;
  }

  /** CDynInfoCalculator::GetSaveCount — FxServer.exe:0041AB0C. */
  GetSaveCount(slot: number): number {
    return this.m_vtSaves[slot]!;
  }

  /** CDynInfoCalculator::SetNice — FxServer.exe:0041AB1A. */
  SetNice(slot: number, nice: number): void {
    this.m_vtNice[slot] = nice;
  }

  /** CDynInfoCalculator::GetMyTeamNo — FxServer.exe:0041AB2C. */
  GetMyTeamNo(slot: number): number {
    return this.m_vtMyTeamNo[slot]!;
  }

  /** CDynInfoCalculator::GetOtherTeamNo — FxServer.exe:0041AB3A. */
  GetOtherTeamNo(slot: number): number {
    return this.m_vtOtherTeamNo[slot]!;
  }

  /** CDynInfoCalculator::IncMyTeamNo — FxServer.exe:0041AB48. */
  IncMyTeamNo(slot: number): void {
    this.m_vtMyTeamNo[slot]!++;
  }

  /** CDynInfoCalculator::IncOtherTeamNo — FxServer.exe:0041AB58. */
  IncOtherTeamNo(slot: number): void {
    this.m_vtOtherTeamNo[slot]!++;
  }

  /** CDynInfoCalculator::GetTeamColor — FxServer.exe:0041AB68. */
  GetTeamColor(slot: number): number {
    return this.m_vtColour[slot]!;
  }

  /** CDynInfoCalculator::SetKillerIndex (40B1DC) — case 4 of OnSetBomberEvent. */
  SetKillerIndex(_victim: number, killer: number): void {
    this.m_vtKills[killer]!++;
  }

  /**
   * CDynInfoCalculator::SetSaverIndex (40B1EC) — case 3 of OnSetBomberEvent.
   * The first save by colour `saver` sets the 8×8 mark (row `saver`,
   * column `slot` — the saver owns the 32-byte stride) and bumps that
   * colour's save count (+332).
   */
  SetSaverIndex(slot: number, saver: number): void {
    const i = slot + saver * MAX_SESSION_SLOTS; // lea eax, [edx+esi*8]
    if (this.m_nSaveMatrix[i] === 0) {
      this.m_nSaveMatrix[i] = 1;
      this.m_vtSaves[saver]!++;
    }
  }

  /** CDynInfoCalculator::GetExpPercentage (40B29E) — cur exp ‰ inside its level. */
  static GetExpPercentage(nCur: number): number {
    nCur |= 0;
    const level = CDynInfoCalculator_GetLevel(nCur);
    const nMaxExp = CDynInfoCalculator_GetMaxExpInLevel(level);
    const nLowExp = CDynInfoCalculator_GetMaxExpInLevel(level - 1);
    if (nLowExp === LEVEL_EXP_SENTINEL || nMaxExp === LEVEL_EXP_SENTINEL) return 0;
    // 0040B2C7..0040B2D2: signed sub, 32-bit imul, signed idiv.
    return Math.trunc(Math.imul((nCur - nLowExp) | 0, 1000) / (nMaxExp - nLowExp)) | 0;
  }

  /** CDynInfoCalculator::IsPremiumRewardCondition (40B2FD). */
  IsPremiumRewardCondition(): boolean {
    if (this.m_nPremiumFlag !== 0) return true;
    return CMainSystem.IsPremiumChannel();
  }

  /** CDynInfoCalculator::GetWinExp (40B4CE) — the winning-slot exp (clamped 50..200). */
  GetWinExp(slot: number, pnRewardFlag: number[]): number {
    pnRewardFlag[0] = 0; // mov [eax], edi (edi = 0)
    if (this.m_nInvalidGame !== 0) return 0;
    const colour = this.m_vtColour[slot]!;
    if (colour < 0 || this.m_vtColourCount[colour] === 0) return 0;
    if (this.m_dwColourWeight[colour] === 0) return 0;
    let t =
      (this.m_nPlayerCount * this.m_dwAvgWeight * 100.0 * this.m_vtColourCount[colour]!) /
      (this.m_vtColourCount[colour]! * this.m_dwColourWeight[colour]!);
    t *= this.m_vtSlotWeight[slot]! / this.m_dwColourWeight[colour]!; // fld [+2C+4n] / colourWeight
    t *= 0.5;
    t += this.m_vtSaves[slot]! * 20.0;
    t += this.m_vtKills[slot]! * 20.0;
    let v = Math.trunc(t);
    if (v < 50) v = 50;
    if (v > 200) v = 200;
    if (this.IsPremiumRewardCondition()) v = Math.trunc((v * 11) / 10);
    return v;
  }

  /** CDynInfoCalculator::GetDrawExp (40B5A0) — the tied-game exp (clamped 0..50). */
  GetDrawExp(slot: number): number {
    if (this.m_nInvalidGame !== 0) return 0;
    const colour = this.m_vtColour[slot]!;
    if (colour < 0 || this.m_vtColourCount[colour] === 0) return 0;
    if (this.m_dwColourWeight[colour] === 0) return 0;
    let t =
      (this.m_nPlayerCount * this.m_dwAvgWeight * 10.0 * this.m_vtColourCount[colour]!) /
      (this.m_vtColourCount[colour]! * this.m_dwColourWeight[colour]!);
    t *= this.m_vtSlotWeight[slot]! / this.m_dwColourWeight[colour]!;
    t *= 0.5;
    t += this.m_vtSaves[slot]! * 20.0;
    t += this.m_vtKills[slot]! * 20.0;
    let v = Math.trunc(t);
    if (v < 0) v = 0;
    if (v > 50) v = 50;
    if (this.IsPremiumRewardCondition()) v = Math.trunc((v * 11) / 10);
    return v;
  }

  /**
   * CDynInfoCalculator::GetKillNSaveExp (40B665) — premium channels only;
   * a bad context logs ReportError("Invalid CDynInfoCalculator context").
   */
  GetKillNSaveExp(slot: number): number {
    if (!CMainSystem.IsPremiumChannel()) return 0;
    if (this.m_nInvalidGame !== 0) {
      console.error("Invalid CDynInfoCalculator context");
      return 0;
    }
    const colour = this.m_vtColour[slot]!;
    if (colour < 0 || this.m_vtColourCount[colour] === 0 || this.m_dwColourWeight[colour] === 0) {
      console.error("Invalid CDynInfoCalculator context");
      return 0;
    }
    let v = Math.trunc(this.m_vtSaves[slot]! * 20.0 + this.m_vtKills[slot]! * 20.0);
    if (v < 0) v = 0;
    if (v > 140) v = 140;
    return v;
  }
}
