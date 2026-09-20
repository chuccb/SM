/** the session-strategy unit — the CGameSessionStrategy vtable (the base
 *  stubs) and the type-77 guild variant with its CGuildDynInfoCalculator. */

import { Encode4 } from "../core/BufferManipulator.ts";
import { CSendPacket } from "../core/Packet.ts";
import { GS_INPLAY_SendInventory } from "../lib/PacketIDs.ts";
import { MAX_SESSION_SLOTS, SLOTSTATE_COLOR_MASK } from "./Defs";
import { CGameSession } from "./Session";
import { CGuildTable } from "./Tables";
import { CClientSocket } from "./User";

// ============================ CGameSessionStrategy ============================

/**
 * CGuildDynInfoCalculator — the per-result guild accountant SendGameResult
 * builds fresh for every call (:36694, the ctor sets the vtbl and calls
 * Clear).  Eight-entry arrays keyed by guild index — the serials (+8), the
 * result bytes (+40: 0/1 win, 2 lose, 3 draw), the exp pot (+104) — and by
 * slot — the guild assignment (+72) plus two write-only bookkeeping arrays
 * (+136/+168); +4 is the guild count.  The strategy feeds one row per
 * seated user; OnGameResult turns it into the CGuild counter bumps and the
 * prUpdateGuildDynamic write-back (Flush, :16117).
 */
export class CGuildDynInfoCalculator {
  m_nGuildCount = 0; // +4
  m_argSerialNo = new Int32Array(MAX_SESSION_SLOTS); // +8 — the guild serials
  m_anResult = new Int32Array(MAX_SESSION_SLOTS); // +40 — 0/1 win, 2 lose, 3 draw
  m_anGuildIdx = new Int32Array(MAX_SESSION_SLOTS); // +72 — slot → guild index
  m_anExp = new Int32Array(MAX_SESSION_SLOTS); // +104
  m_anMember = new Int32Array(MAX_SESSION_SLOTS); // +136 — written, never read
  m_anMembers = new Int32Array(MAX_SESSION_SLOTS); // +168 — written, never read

  /** CGuildDynInfoCalculator::Clear (FxServer.exe.c:16000). */
  Clear(): void {
    this.m_nGuildCount = 0;
    this.m_argSerialNo.fill(0);
    this.m_anResult.fill(0);
    this.m_anGuildIdx.fill(0);
    this.m_anExp.fill(0);
    this.m_anMember.fill(0);
    this.m_anMembers.fill(0);
  }

  /** CGuildDynInfoCalculator::FindGuild (FxServer.exe.c:16028). */
  FindGuild(serial: number): number {
    for (let i = 0; i < this.m_nGuildCount; i++) {
      if (this.m_argSerialNo[i] === serial) return i;
    }
    return -1;
  }

  /** CGuildDynInfoCalculator::AddGuild (FxServer.exe.c:16047). */
  AddGuild(serial: number): number {
    const idx = this.m_nGuildCount++;
    this.m_argSerialNo[idx] = serial;
    this.m_anResult[idx] = 0;
    this.m_anExp[idx] = 0;
    this.m_anMembers[idx] = 0;
    return idx;
  }

  /** CGuildDynInfoCalculator::AddPlayer (FxServer.exe.c:16174) — the odd
   *  `--members` on the found branch is the original's; the counter has no
   *  reader anywhere in FXGS. */
  AddPlayer(slot: number, serial: number): void {
    this.m_anMember[slot] = 1;
    let guild = this.FindGuild(serial);
    if (guild === -1) guild = this.AddGuild(serial);
    else this.m_anMembers[guild]--;
    this.m_anGuildIdx[slot] = guild;
    this.m_anMembers[guild]++;
  }

  /** CGuildDynInfoCalculator::MarkPlayerResult (FxServer.exe.c:16012). */
  MarkPlayerResult(slot: number, n3: number): void {
    this.m_anResult[this.m_anGuildIdx[slot]!] = n3;
  }

  /** CGuildDynInfoCalculator::AddPlayerExp (FxServer.exe.c:16018). */
  AddPlayerExp(slot: number, exp: number): void {
    this.m_anExp[this.m_anGuildIdx[slot]!]! += exp;
  }

  /** CGuildDynInfoCalculator::IsWinGuild (FxServer.exe.c:16165). */
  IsWinGuild(serial: number): boolean {
    const guild = this.FindGuild(serial);
    return guild !== -1 && this.m_anResult[guild]! <= 1;
  }

  /** CGuildDynInfoCalculator::Flush (FxServer.exe.c:16117) — exp/20 into
   *  the guild row, the win/lose/draw counter switch (0/1 win, 2 lose,
   *  3 draw, 4 lose), then Clear. */
  Flush(): void {
    for (let i = 0; i < this.m_nGuildCount; i++) {
      const guild = CGuildTable.ms_pInstance?.FindGuildFromSerialNo(this.m_argSerialNo[i]! >>> 0);
      if (guild) {
        guild.IncExp(Math.trunc(this.m_anExp[i]! / 20));
        const result = this.m_anResult[i]!;
        if (result <= 1) guild.IncWin();
        else if (result === 3) guild.IncDraw();
        else if (result === 2 || result === 4) guild.IncLose();
      }
    }
    this.Clear();
  }
}

/**
 * CGameSessionStrategy — the hook object every CGameSession carries
 * (+12620), bound once by the ctor's CreateSessionStrategy (FxServer.exe.c
 * :37220).  The base class is the `retn N` stub family (SendSessionInfo
 * 4216EF, SetGameResultPlayer 4216F2, GetResultViewType :37832 → 0); the
 * guild subclass below overrides the hooks that matter.  Vtable 0x48F7D4,
 * in order: Init, OnSelectColor, MakeSimpleInfoPacket, MakeCreatedPacket,
 * MakeModifiedPacket, DestroyPlayer, AddPlayer, SendSessionInfo,
 * OnGameResult, SetGameResultPlayer, GetResultViewType.
 */
export class CGameSessionStrategy {
  constructor(public m_pSession: CGameSession) {} // +4

  /** vtbl+4 — a stub on the base class. */
  Init(): void {}
  /** vtbl+8 — runs after CGameSession::DoSelectColor. */
  OnSelectColor(_slot: number, _color: number): void {}
  /** vtbl+12 — appended to every lobby 83. */
  MakeSimpleInfoPacket(_packet: CSendPacket): void {}
  /** vtbl+16 — appended to every lobby 85. */
  MakeCreatedPacket(_packet: CSendPacket): void {}
  /** vtbl+20 — appended to every lobby 86 (only when something changed). */
  MakeModifiedPacket(_packet: CSendPacket): void {}
  /** vtbl+24 — runs after CListSession::DestroyPlayer. */
  DestroyPlayer(_socket: CClientSocket): void {}
  /** vtbl+28 — runs before the seat assignment (CGameSession::AddPlayer). */
  AddPlayer(_socket: CClientSocket): void {}
  /** vtbl+32 — the "rewrite the session's packet buffer" hook.  The base
   *  stub leaves the buffer alone (so the caller's second PutPacket sends
   *  the same bytes again — the double 112); the guild variant rewrites it
   *  as 88 and broadcasts it (SendGuildSessionInfo, :423789). */
  SendSessionInfo(_packet: CSendPacket): void {}
  /** vtbl+36 — SendGameResult's tail, before the session SendPacket. */
  OnGameResult(_calc: CGuildDynInfoCalculator): void {}
  /** vtbl+40 — one call per seated user inside SendGameResult. */
  SetGameResultPlayer(_calc: CGuildDynInfoCalculator, _slot: number, _value: number, _n3: number): void {}
  /** vtbl+44 — the 163 head's view-type byte. */
  GetResultViewType(): number {
    return 0;
  }
}

/**
 * CGuildSessionStrategy — the type-77 (guild channel) variant, built by
 * CreateSessionStrategy when MainSystem+8 is 77 (:32671, operator new 0x6C).
 * A guild battle room: the roster is keyed by the seated users' guild
 * serials (user+1972), the 83/85/86 lobby packets grow the per-guild team
 * summary, every roster burst ends in an 88 broadcast, a colour pick drags
 * the same-guild seatmates along, and the results pay guild exp and
 * win/lose/draw counters.
 */
export class CGuildSessionStrategy extends CGameSessionStrategy {
  m_nGuildCount = 0; // +8
  m_argSerialNo = new Int32Array(MAX_SESSION_SLOTS); // +12 — the guild serials
  m_anPlayerCount = new Int32Array(MAX_SESSION_SLOTS); // +44 — seated members
  m_anWinCount = new Int32Array(MAX_SESSION_SLOTS); // +76 — session wins

  /** CGuildSessionStrategy::CGuildSessionStrategy (:39767) — Init clears. */
  constructor(session: CGameSession) {
    super(session);
    this.Init();
  }

  /** CGuildSessionStrategy::Init (:39687). */
  Init(): void {
    this.m_nGuildCount = 0;
    this.m_argSerialNo.fill(0);
    this.m_anPlayerCount.fill(0);
    this.m_anWinCount.fill(0);
  }

  /** CGuildSessionStrategy::FindIdxByGuildNo (:39696). */
  FindIdxByGuildNo(serial: number): number {
    for (let i = 0; i < this.m_nGuildCount; i++) {
      if (this.m_argSerialNo[i] === serial) return i;
    }
    return -1;
  }

  /** CGuildSessionStrategy::OnSelectColor (:39784) — every OTHER seat of
   *  the same guild takes the colour too (the caller already set slot).
   *  The original derefs the slot's user unchecked — the caller guarantees
   *  a seated slot. */
  OnSelectColor(slot: number, color: number): void {
    const leader = this.m_pSession.m_rgPlayer[slot]!;
    for (let other = 0; other < MAX_SESSION_SLOTS; other++) {
      if (other === slot) continue;
      const user = this.m_pSession.m_rgPlayer[other];
      if (user && user.m_nGuildSN === leader.m_nGuildSN) {
        const p = other * 3 + 2;
        this.m_pSession.m_rgSlotState[p] =
          this.m_pSession.m_rgSlotState[p]! ^ ((color ^ this.m_pSession.m_rgSlotState[p]!) & SLOTSTATE_COLOR_MASK);
      }
    }
  }

  /** CGuildSessionStrategy::EncodeGuildSessionInfo (:39737) — the 88 body:
   *  [E4 count][count × [E4 serial][E4 playerCount][E4 winCount]]. */
  EncodeGuildSessionInfo(packet: CSendPacket): void {
    packet.InitPacket(GS_INPLAY_SendInventory.OnGuildSessionInfo);
    packet.Encode4(this.m_nGuildCount);
    for (let i = 0; i < this.m_nGuildCount; i++) {
      packet.Encode4(this.m_argSerialNo[i]! >>> 0);
      packet.Encode4(this.m_anPlayerCount[i]! >>> 0);
      packet.Encode4(this.m_anWinCount[i]! >>> 0);
    }
  }

  /** CGuildSessionStrategy::EncodeGuildSessionSimpleInfo (:39811) — APPENDS
   *  to the 83/85/86 the caller already built: [E4 distinct seated colours]
   *  [per colour group: [E4 guilds][guilds × E4 serial]].  Guilds without a
   *  seated member group under colour 0.  The lobby Make hooks all jmp
   *  here in the original (0x4237DF/E4/E9). */
  EncodeGuildSessionSimpleInfo(packet: CSendPacket): void {
    const colourOfGuild = new Int32Array(MAX_SESSION_SLOTS);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_pSession.m_rgPlayer[slot];
      const open = (this.m_pSession.m_rgSlotState[slot * 3]! & 1) === 0;
      if (!open || !user) continue;
      const guild = this.FindIdxByGuildNo(user.m_nGuildSN);
      if (guild !== -1) colourOfGuild[guild] = this.m_pSession.m_rgSlotState[slot * 3 + 2]! & SLOTSTATE_COLOR_MASK;
    }
    let distinct = 0;
    for (let i = 0; i < this.m_nGuildCount; i++) {
      let seen = false;
      for (let j = 0; j < i; j++) {
        if (colourOfGuild[i] === colourOfGuild[j]) seen = true;
      }
      if (!seen) distinct++;
    }
    packet.Encode4(distinct >>> 0);
    const visited = new Int32Array(MAX_SESSION_SLOTS);
    for (let i = 0; i < this.m_nGuildCount; i++) {
      if (visited[i] !== 0) continue;
      let size = 0;
      for (let k = i; k < this.m_nGuildCount; k++) {
        if (colourOfGuild[i] === colourOfGuild[k]) size++;
      }
      packet.Encode4(size >>> 0);
      for (let k = i; k < this.m_nGuildCount; k++) {
        if (colourOfGuild[i] === colourOfGuild[k]) {
          visited[k] = 1;
          packet.Encode4(this.m_argSerialNo[k]! >>> 0);
        }
      }
    }
  }

  /** The lobby Make hooks — all three share the body above. */
  MakeSimpleInfoPacket(packet: CSendPacket): void {
    this.EncodeGuildSessionSimpleInfo(packet);
  }
  MakeCreatedPacket(packet: CSendPacket): void {
    this.EncodeGuildSessionSimpleInfo(packet);
  }
  MakeModifiedPacket(packet: CSendPacket): void {
    this.EncodeGuildSessionSimpleInfo(packet);
  }

  /** CGuildSessionStrategy::DestroyPlayer (:39936) — the guild's seated
   *  count drops; an empty guild leaves the list (the arrays shift). */
  DestroyPlayer(socket: CClientSocket): void {
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i)!;
      const guild = this.FindIdxByGuildNo(user.m_nGuildSN);
      if (guild === -1) continue;
      if (--this.m_anPlayerCount[guild] === 0) {
        this.m_nGuildCount--;
        for (let k = guild; k < this.m_nGuildCount; k++) {
          this.m_argSerialNo[k] = this.m_argSerialNo[k + 1]!;
          this.m_anPlayerCount[k] = this.m_anPlayerCount[k + 1]!;
          this.m_anWinCount[k] = this.m_anWinCount[k + 1]!;
        }
      }
    }
  }

  /** CGuildSessionStrategy::AddPlayer (:39985). */
  AddPlayer(socket: CClientSocket): void {
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const serial = socket.GetUser(i)!.m_nGuildSN;
      const guild = this.FindIdxByGuildNo(serial);
      if (guild === -1) {
        this.m_anWinCount[this.m_nGuildCount] = 0;
        this.m_argSerialNo[this.m_nGuildCount] = serial;
        this.m_anPlayerCount[this.m_nGuildCount] = 1;
        this.m_nGuildCount++;
      } else {
        this.m_anPlayerCount[guild]++;
      }
    }
  }

  /** CGuildSessionStrategy::SendGuildSessionInfo (:423789) — rewrite the
   *  buffer as 88 and broadcast it through the session. */
  SendSessionInfo(packet: CSendPacket): void {
    this.EncodeGuildSessionInfo(packet);
    this.m_pSession.SendPacket(packet);
  }

  /** CGuildSessionStrategy::OnGameResult (:39715) — the winning guilds'
   *  session win counters, then the calculator's Flush. */
  OnGameResult(calc: CGuildDynInfoCalculator): void {
    for (let i = 0; i < this.m_nGuildCount; i++) {
      if (calc.IsWinGuild(this.m_argSerialNo[i]!)) this.m_anWinCount[i]!++;
    }
    calc.Flush();
  }

  /** CGuildSessionStrategy::SetGameResultPlayer (:4237A5). */
  SetGameResultPlayer(calc: CGuildDynInfoCalculator, slot: number, value: number, n3: number): void {
    const user = this.m_pSession.m_rgPlayer[slot]!;
    calc.AddPlayer(slot, user.m_nGuildSN);
    calc.AddPlayerExp(slot, value);
    calc.MarkPlayerResult(slot, n3);
  }

  /** CGuildSessionStrategy::GetResultViewType (:39681). */
  GetResultViewType(): number {
    return 1;
  }
}
