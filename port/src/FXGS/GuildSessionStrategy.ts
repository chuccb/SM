/** Native source unit: FX/FxServer/GuildSessionStrategy.cpp. */
import { CSendPacket } from "../core/Packet.ts";
import { GS_ClientSend } from "../protocol/PacketIDs.ts";
import { MAX_SESSION_SLOTS, SLOTSTATE_COLOR_MASK } from "./Defs.ts";
import type { CGameSession } from "./GameSession.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import { CGuildDynInfoCalculator } from "./GuildDynInfoCalculator.ts";
import { CGameSessionStrategy } from "./GameSessionStrategy.ts";

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
  override Init(): void {
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
  override OnSelectColor(slot: number, color: number): void {
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
    packet.InitPacket(GS_ClientSend.OnGuildSessionInfo);
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
  override MakeSimpleInfoPacket(packet: CSendPacket): void {
    this.EncodeGuildSessionSimpleInfo(packet);
  }
  override MakeCreatedPacket(packet: CSendPacket): void {
    this.EncodeGuildSessionSimpleInfo(packet);
  }
  override MakeModifiedPacket(packet: CSendPacket): void {
    this.EncodeGuildSessionSimpleInfo(packet);
  }

  /** CGuildSessionStrategy::DestroyPlayer (:39936) — the guild's seated
   *  count drops; an empty guild leaves the list (the arrays shift). */
  override DestroyPlayer(socket: CClientSocket): void {
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
  override AddPlayer(socket: CClientSocket): void {
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
  override SendSessionInfo(packet: CSendPacket): void {
    this.EncodeGuildSessionInfo(packet);
    this.m_pSession.SendPacket(packet);
  }

  /** CGuildSessionStrategy::OnGameResult (:39715) — the winning guilds'
   *  session win counters, then the calculator's Flush. */
  override OnGameResult(calc: CGuildDynInfoCalculator): void {
    for (let i = 0; i < this.m_nGuildCount; i++) {
      if (calc.IsWinGuild(this.m_argSerialNo[i]!)) this.m_anWinCount[i]!++;
    }
    calc.Flush();
  }

  /** CGuildSessionStrategy::SetGameResultPlayer (:4237A5). */
  override SetGameResultPlayer(calc: CGuildDynInfoCalculator, slot: number, value: number, n3: number): void {
    const user = this.m_pSession.m_rgPlayer[slot]!;
    calc.AddPlayer(slot, user.m_nGuildSN);
    calc.AddPlayerExp(slot, value);
    calc.MarkPlayerResult(slot, n3);
  }

  /** CGuildSessionStrategy::GetResultViewType (:39681). */
  override GetResultViewType(): number {
    return 1;
  }
}
