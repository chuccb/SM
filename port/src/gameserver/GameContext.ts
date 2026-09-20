/** the in-play board state — CBanChief, the exp calculators,
 *  CGameContext, CGameClock, CSyncGameObjMan and CUdpLossRegulator. */

import { Decode1, Decode2, Decode4, Encode1, Encode2, Encode4, EncodeBuffer } from "../core/BufferManipulator.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, kPacketEncryptedCRC8 } from "../core/Packet.ts";
import { GS_ClientSend } from "../lib/PacketIDs.ts";
import { CDynInfoCalculator_GetLevel, CDynInfoCalculator_GetMaxExpInLevel } from "../login/LevelTable.ts";
import { MAX_SESSION_SLOTS, SLOTSTATE_COLOR_MASK, TICK_U32_MASK, UDP_REGULATE_DELAY } from "./Defs";
import { CGameSession } from "./Session";
import { CGameSessionTable } from "./SessionTable";
import { CMainSystem } from "./System";
import { CClientSocket, CUser, GetInfoStr } from "./User";

// ============================ CGameContext / in-play state ============================

/**
 * CBanChief (+12576) — the idle-room start-gate timers
 * (FxServer.exe.lst:401010..401140).  All delays are timeGetTime ticks.
 */
export class CBanChief {
  m_dwCanStartTime = 0; // +4 (SetCanStart)
  m_nCanStart = 0; // +8 (SetCanStart)
  m_nOddSlot = 0; // +12 (SetOddSlot)
  m_dwOddSlotTime = 0; // +16 (SetOddSlot)
  m_nWarnedBan = 0; // +14 (SetWarnedBan)
  m_dwWarnedBanTime = 0; // +18 (SetWarnedBan)
  m_nWarnedBanOdd = 0; // +1C (SetWarnedBanOddSlot)
  m_dwWarnedBanOddTime = 0; // +20 (SetWarnedBanOddSlot)

  /** CBanChief::Init (401101) — SetOddSlot(0) then SetCanStart(0). */
  Init(): void {
    this.SetOddSlot(0);
    this.SetCanStart(0);
  }

  /** CBanChief::SetWarnedBanOddSlot (401010). */
  SetWarnedBanOdd(n: number): void {
    this.m_nWarnedBanOdd = n;
    this.m_dwWarnedBanOddTime = n !== 0 ? CGameClock.Now() : 0;
  }

  /**
   * CBanChief::IsBanChief (40102F) — true once timeGetTime-SetCanStart beats
   * (flag ? 10000 : 20000) × superChief, superChief being the 1/3 flag from
   * "Item/SuperChief".  The middle gameType argument is not read.
   */
  IsBanChief(nFlag: number, _gameType: number, superChief: number): boolean {
    const elapsed = (CGameClock.Now() - this.m_dwCanStartTime) | 0;
    const v = (nFlag !== 0 ? 10000 : 20000) * superChief;
    return elapsed > v;
  }

  /** CBanChief::SetWarnedBan (401065). */
  SetWarnedBan(n: number): void {
    this.m_nWarnedBan = n;
    this.m_dwWarnedBanTime = n !== 0 ? CGameClock.Now() : 0;
  }

  /** CBanChief::GetWarningDelay (401084) — ticks × 10000 (32-bit wrap). */
  GetWarningDelay(ticks: number): number {
    return Math.imul(ticks, 10000) >>> 0;
  }

  /** CBanChief::GetOddSlotInManner (401091) — ticks × 5000 (32-bit wrap). */
  GetOddSlotInManner(ticks: number): number {
    return Math.imul(ticks, 5000) >>> 0;
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
    this.m_nWarnedBanOdd = 0;
    this.m_dwWarnedBanOddTime = 0;
  }
}

/**
 * CDynInfoCalculator — the 0x254-byte statistics block at CGameSession+11684
 * (+0x2DA4).  CDynInfoCalculator::Init runs once per launch (the launch tail
 * of CGameSession::LaunchGameStage); the bomber-event / game-result units
 * then read it to award exp.  All offsets below are calculator relative.
 */
export class CDynInfoCalculator {
  m_nPlayerCount = 0; // +4 (non-empty slots)
  m_dwAvgWeight = 0; // +8 (float: Σ sqrt(level+100) / m_nPlayerCount)
  m_dwColourWeight = new Float32Array(8); // +12 (per-colour average sqrt(level+100))
  m_vtSlotWeight = new Float32Array(8); // +44 (+0x2C, per-slot sqrt(level+100))
  m_nSaveMatrix = new Int32Array(64); // +76 (+0x4C, 8×8 first-save-per-colour marks)
  m_vtKills = new Int32Array(8); // +332 (+0x14C, SetKillerIndex)
  m_vtSaves = new Int32Array(8); // +364 (+0x16C, SetSaverIndex)
  m_nUnk18C = new Int32Array(8); // +396 (+0x18C, zeroed only)
  m_nUnk1AC = new Int32Array(8); // +428 (+0x1AC, zeroed only)
  m_vtColour = new Int32Array(8).fill(-1); // +460 (+0x1CC, slot → colour)
  m_vtColourCount = new Int32Array(8); // +492 (+0x1EC, players per colour)
  m_nUnk20C = new Int32Array(8); // +524 (+0x20C, zeroed only)
  m_nUnk22C = new Int32Array(8); // +556 (+0x22C, zeroed only)
  m_nPremiumFlag = 0; // +588 (+0x24C, IsPremiumRewardCondition bypass — never set in FXGS)
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
      this.m_vtSaves[c] = 0; // [eax-80h]
      this.m_vtKills[c] = 0; // [eax-0A0h]
      this.m_nUnk1AC[c] = 0; // [eax-40h]
      this.m_nUnk18C[c] = 0; // [eax-60h]
      this.m_nUnk20C[c] = 0; // [eax+20h]
      this.m_nUnk22C[c] = 0; // [eax+40h]
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

  /** CDynInfoCalculator::SetKillerIndex (40B1DC) — case 4 of OnSetBomberEvent. */
  SetKillerIndex(killer: number): void {
    this.m_vtKills[killer]!++;
  }

  /**
   * CDynInfoCalculator::SetSaverIndex (40B1EC) — case 3 of OnSetBomberEvent.
   * The first save by colour `saver` sets the 8×8 mark (row `slot`, column
   * `saver`) and bumps that colour's save count.
   */
  SetSaverIndex(slot: number, saver: number): void {
    const i = slot + saver * 8; // lea eax, [edx+esi*8]
    if (this.m_nSaveMatrix[i] === 0) {
      this.m_nSaveMatrix[i] = 1;
      this.m_vtSaves[saver]!++;
    }
  }

  /** CDynInfoCalculator::GetExpPercentage (40B29E) — cur exp ‰ inside its level. */
  static GetExpPercentage(nCur: number): number {
    const level = CDynInfoCalculator_GetLevel(nCur);
    const nMaxExp = CDynInfoCalculator_GetMaxExpInLevel(level);
    const nLowExp = CDynInfoCalculator_GetMaxExpInLevel(level - 1);
    if (nLowExp === 0x7fffffff) return 0;
    return Math.trunc(((nCur - nLowExp) * 1000) / (nMaxExp - nLowExp));
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

/**
 * CGameSession::IsSameNumberPerTeam (FxServer.exe.lst:41B044) — every
 * occupied slot's colour must hold players / colours player counts.
 */
function IsSameNumberPerTeam(session: CGameSession): boolean {
  const counts = new Int32Array(8); // var_20 (memset 0x20)
  let teamCount = 0; // edi
  for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
    const user = session.m_rgPlayer[slot]!;
    if (user === null) continue;
    const c = session.GetColor(slot);
    if (++counts[c] === 1) teamCount++;
  }
  if (teamCount < 2) return false;
  for (let c = 0; c < MAX_SESSION_SLOTS; c++) {
    if (counts[c] !== 0 && counts[c] !== Math.trunc(session.m_nCurPlayerNum / teamCount)) return false;
  }
  return true;
}

/**
 * CGameContext — the in-play object state (0x288C bytes at CGameSession+1184;
 * CGameSession::SetCurrentGameContext picks ctx 0).  Field offsets are ctx
 * relative (FxServer.exe.c:41CD9B CGameContext::Init).
 */
export class CGameContext {
  m_rgnTeamScore = new Int32Array(8); // +0 (SetHouseState ++ per color)
  /** +32, 20 bytes per bomb, m_nBombCount entries (ignite refuses >= 150). */
  m_rgBomb: { id: number; fMoving: number; timer: number; x: number; y: number; sub: number; fFlag16: number }[] = [];
  m_nBombCount = 0; // +4812
  m_nBombIdCounter = 0; // +4816 (the per-ignite serial)
  m_nBoxItemCounter = 126; // +4916 (CGameContext::Init; AddBoxItem caps at 250)
  m_rgnBoxItem = new Int32Array(250); // +3032 (0 free / 1 eaten)
  m_rgnObstacle = new Int32Array(195); // +4032, 13 rows × 15 cols (0 free / 1 eaten)
  /** +4820 — per-slot down time (CGameClock::ElapsedTime at the trap/death). */
  m_rgnDownTime = new Int32Array(8);
  /** +4852 — per-slot [E2 x][E2 y] pair written by OnSetBomberEvent case 2. */
  m_rgnDiePos = new Int32Array(16);
  m_rgnBula = new Int32Array(1170); // +4920, 45 × 26 (GetBulaState dword[1230+45x+y]; -1 init)
  m_rgnHouse = new Int32Array(195); // +9600, 15 × 13 (GetHouseState dword[2400+15row+col]; -1 init)

  /** CGameContext::Init (FxServer.exe.c:41CD9B). */
  Init(): void {
    this.m_rgnTeamScore.fill(0);
    this.m_rgBomb = [];
    this.m_nBombCount = 0;
    this.m_nBombIdCounter = 0;
    this.m_rgnBoxItem.fill(0);
    this.m_rgnObstacle.fill(0);
    this.m_nBoxItemCounter = 126;
    this.m_rgnDownTime.fill(0);
    this.m_rgnDiePos.fill(0);
    this.m_rgnBula.fill(-1);
    this.m_rgnHouse.fill(-1);
  }

  /** CGameContext::AddBoxItem — the running box serial, -1 at the 250 cap. */
  AddBoxItem(): number {
    if (this.m_nBoxItemCounter >= 250) return -1;
    return this.m_nBoxItemCounter++;
  }

  /** CGameContext::GetBulaState / SetBulaState (dword[1230 + 45x + y]). */
  GetBulaState(x: number, y: number): number {
    return this.m_rgnBula[45 * x + y]!;
  }
  SetBulaState(x: number, y: number, v: number): void {
    this.m_rgnBula[45 * x + y] = v;
  }

  /** CGameContext::GetHouseState / SetHouseState (dword[2400 + 15row + col]). */
  GetHouseState(row: number, col: number): number {
    return this.m_rgnHouse[15 * row + col]!;
  }
  SetHouseState(row: number, col: number, v: number, color: number): void {
    this.m_rgnHouse[15 * row + col] = v;
    if (color < MAX_SESSION_SLOTS) this.m_rgnTeamScore[color]!++;
  }
}

/** CGameClock (+12732) — StartGame/EndGame/ElapsedTime (FxServer.exe.c:41B843). */
export class CGameClock {
  m_dwSuspended = 0; // +0 (ResumeGame adds the suspend gap here)
  m_dwStartTime = 0; // +4
  m_dwEndTime = 0; // +8
  m_dwSuspendAt = 0; // +12

  static Now(): number {
    return Date.now() & TICK_U32_MASK;
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
 * CSyncGameObjMan (+12788) — the synchronized-object ownership table.
 * A map objId → slot plus one per-slot set (FxServer.exe.c:415451).
 */
export class CSyncGameObjMan {
  m_mapObj = new Map<number, number>(); // +0 objId → slotidx
  m_rgSetObj: Set<number>[] = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new Set<number>()); // +44
  m_pGameSession: CGameSession | null = null; // +140 (dword 35)
  m_nNextObjId = -1; // +144 (dword 36; ctor -1, Init 0)
  m_dwLastCreateTime = 0; // +148 (dword 37)

  /** CSyncGameObjMan::Init. */
  Init(session: CGameSession): void {
    for (const set of this.m_rgSetObj) set.clear();
    this.m_mapObj.clear();
    this.m_pGameSession = session;
    this.m_nNextObjId = 0;
    this.m_dwLastCreateTime = 0;
  }

  /** CSyncGameObjMan::OnGameEnd — drop the next-object id back to -1. */
  OnGameEnd(): void {
    this.m_nNextObjId = -1;
  }

  /** CSyncGameObjMan::Delegate — record objId under the owning slot. */
  Delegate(objId: number, slot: number): void {
    this.m_rgSetObj[slot]!.add(objId);
    this.m_mapObj.set(objId, slot);
  }

  /** CSyncGameObjMan::FindMinimumLoadSlotIdx — the socket-chief slot with the least objs. */
  FindMinimumLoadSlotIdx(): number {
    if (!this.m_pGameSession) {
      console.error("[GS] [CSyncGameObjMan::FindMinimumSlotIdx] m_pGameSession is NULL");
      return -1;
    }
    let best = -1;
    let bestLoad = 0x80000000;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_pGameSession.m_rgPlayer[slot];
      if (user && user.GetSelfidx() === 0 && this.m_rgSetObj[slot]!.size < bestLoad) {
        bestLoad = this.m_rgSetObj[slot]!.size;
        best = slot;
      }
    }
    if (best === -1) console.error("[GS] No player here??? .\\SyncGameObjMan.cpp(55)");
    return best;
  }

  /** CSyncGameObjMan::SetInitialObjNo — the initial 175s (tmpl+84 objects). */
  SetInitialObjNo(n: number): void {
    if (!this.m_pGameSession) {
      console.error("[GS] [CSyncGameObjMan::SetInitialObjNo] m_pGameSession is NULL");
      return;
    }
    this.m_nNextObjId = 0;
    for (let id = 0; id < n; id++) {
      const slot = this.FindMinimumLoadSlotIdx();
      if (slot === -1) {
        console.error(`[GS] FindMinimumLadSlotIdx returned -1 on Object id ${id}`);
        continue;
      }
      this.Delegate(id, slot);
      const packet = new CSendPacket(GS_ClientSend.OnObjInitial, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode2(id);
      packet.Encode1(slot);
      this.m_pGameSession.SendPacket(packet);
      this.m_nNextObjId++;
    }
  }

  /** CSyncGameObjMan::OnReqCreateObj — packet 158 → 174. */
  OnReqCreateObj(n: CReceivedPacket, _socket: CClientSocket): void {
    const session = this.m_pGameSession;
    if (!session) {
      console.error("[GS] [CSyncGameObjMan::OnReqCreateObj] m_pGameSession is NULL");
      return;
    }
    const elapsed = (session.m_GameClock.ElapsedTime() - session.m_GameClock.m_dwSuspended) >>> 0;
    if (elapsed < this.m_dwLastCreateTime + 5000) return;
    this.m_dwLastCreateTime = elapsed;
    const objType = n.Decode2();
    const buf = new Uint8Array(20);
    n.DecodeBufferAt(n.m_uOffset, buf, 20);
    n.m_uOffset += 20;
    const objId = this.m_nNextObjId;
    this.m_nNextObjId = objId + 1;
    const slot = this.FindMinimumLoadSlotIdx();
    if (slot === -1) {
      console.error("[GS] CSyncGameObjMan::OnReqCreateObj, FindMinimumLoadSlotIdx returned -1, cannot create obj");
      return;
    }
    this.Delegate(objId, slot);
    const packet = new CSendPacket(GS_ClientSend.OnObjCreate, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(objId);
    packet.Encode1(slot);
    packet.Encode2(objType);
    packet.EncodeBuffer(buf, 20);
    session.SendPacket(packet);
  }

  /** CSyncGameObjMan::OnReqDestroyObj — packet 159 → 176. */
  OnReqDestroyObj(n: CReceivedPacket, _socket: CClientSocket): void {
    const session = this.m_pGameSession;
    if (!session) {
      console.error("[GS] [CSyncGameObjMan::OnReqDestroyObj] m_pGameSession is NULL");
      return;
    }
    const objId = n.Decode2();
    if (!this.m_mapObj.has(objId)) return;
    const crc = n.Decode4();
    for (const set of this.m_rgSetObj) set.delete(objId);
    this.m_mapObj.delete(objId);
    const packet = new CSendPacket(GS_ClientSend.OnObjDestroy, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(objId);
    packet.Encode4(crc);
    session.SendPacket(packet);
  }

  /** CSyncGameObjMan::OnPlayerLeave — the leaver's objects vanish as 176 [E2 id][E4 0]. */
  OnPlayerLeave(slot: number): void {
    if (this.m_nNextObjId === -1) return;
    const session = this.m_pGameSession;
    if (!session) {
      console.error("[GS] [CSyncGameObjMan::OnPlayerLeave] m_pGameSession is NULL");
      return;
    }
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] .\\SyncGameObjMan.cpp(99) : Invalid slotidx, ${slot}`);
      return;
    }
    if (session.m_nCurPlayerNum !== 0) {
      for (const objId of [...this.m_rgSetObj[slot]!]) {
        if (!this.m_mapObj.has(objId)) {
          console.error(`[GS] Player has invalid obj, objId = ${objId}, session idx = ${session.m_nIdx}`);
        } else {
          this.m_mapObj.delete(objId);
        }
        const packet = new CSendPacket(GS_ClientSend.OnObjDestroy, CipherDegree.kPacketEncryptedCRC8);
        packet.Encode2(objId);
        packet.Encode4(0);
        session.SendPacket(packet);
      }
      this.m_rgSetObj[slot]!.clear();
    }
  }
}

/**
 * CUdpLossRegulator (+12280) — the per-pair UDP-loss matrix.  Only the
 * matrix state and packet 187 live here; DeferRegulateConnection belongs
 * to the game-tick unit (FxServer.exe.c:26020).
 */
export class CUdpLossRegulator {
  m_fInit = 0; // +4
  m_dwInitTime = 0; // +8
  m_rgLoss = new Uint8Array(64); // +12, [8 * mySlot + targetSlot]

  /** CUdpLossRegulator::Init. */
  Init(): void {
    this.m_fInit = 0;
    this.m_dwInitTime = 0;
    this.m_rgLoss.fill(0);
  }

  /** CUdpLossRegulator::OnNotifyUdpLoss — packet 187. */
  OnNotifyUdpLoss(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fInit === 0) {
      this.m_fInit = 1;
      this.m_dwInitTime = CGameClock.Now();
    }
    const target = n.Decode1();
    if (target >= MAX_SESSION_SLOTS) return;
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = user.m_nSlotIdx;
      if (slot < MAX_SESSION_SLOTS) this.m_rgLoss[8 * slot + target] = 1;
    }
  }

  /** CUdpLossRegulator::DeferRegulateConnection (416595) — 8 s after the first 187. */
  DeferRegulateConnection(session: CGameSession): void {
    if (this.m_fInit !== 0 && CGameClock.Now() - this.m_dwInitTime > UDP_REGULATE_DELAY) this.RegulateConnection(session);
  }

  /**
   * CUdpLossRegulator::RegulateConnection (4160D3) — kick the peer with the
   * most loss reports (ties: the fewest self reports), then reset.
   */
  RegulateConnection(session: CGameSession): void {
    const valid = new Int32Array(8);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = session.m_rgPlayer[slot];
      if (user && user.m_pSocket?.GetUser(0) === user) valid[slot] = 1;
    }
    for (;;) {
      const cnt = new Int32Array(8);
      const both = new Int32Array(8);
      for (let a = 0; a < MAX_SESSION_SLOTS; a++) {
        if (!valid[a] || !session.m_rgPlayer[a]) continue;
        for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
          if (valid[k] && session.m_rgPlayer[k] && this.m_rgLoss[8 * a + k]! !== 0) {
            cnt[a]++;
            both[a]++;
            both[k]++;
          }
        }
      }
      let best = -1;
      let bestBoth = 0;
      let bestCnt = 0x7fffffff;
      for (let m = 0; m < MAX_SESSION_SLOTS; m++) {
        if (!valid[m]) continue;
        if (both[m]! > bestBoth || (both[m] === bestBoth && bestCnt > cnt[m]!)) {
          bestCnt = cnt[m]!;
          best = m;
          bestBoth = both[m]!;
        }
      }
      if (best === -1 || bestBoth === 0) break; // nothing reported → stop
      for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
        this.m_rgLoss[8 * best + k] = 0; // the row
        this.m_rgLoss[8 * k + best] = 0; // the column
      }
      const user = session.m_rgPlayer[best]!;
      const ip = user.m_pSocket ? GetInfoStr(user.m_pSocket) : "";
      console.error(
        `[GS] User[${ip}:${user.GetName()}] (${user.m_pSocket?.GetUserCount() ?? 0}P) banned from game session (${session.m_nIdx}) while <PLAYING> by udp loss`,
      );
      CGameSessionTable.ms_pInstance!.DestroyPlayer(user.m_pSocket!, 0);
      if (user.m_nFree === 0) {
        // [user+7A4] != 0 and [socket+244] == 0 — +244 is the IO-layer detach
        // flag that FXGS logic never sets, so the port uses the connected flag
        const socket = user.m_pSocket;
        if (socket && socket.m_bConnected) {
          socket.SendPacket(new CSendPacket(GS_ClientSend.OnUdpLossBan, CipherDegree.kPacketEncryptedCRC8)); // 195, no payload
          socket.m_nPoolType = 4; // [socket+1D4]
        }
      }
    }
    this.m_fInit = 0;
    this.m_dwInitTime = 0;
    this.m_rgLoss.fill(0);
  }
}
