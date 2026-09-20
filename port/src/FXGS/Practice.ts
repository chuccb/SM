/** CPracticeSession — the solo practice rooms with their AI seats. */

import { Encode1, Encode2 } from "../core/BufferManipulator.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, kPacketEncryptedCRC8, PACKET_TYPE_PLACEHOLDER } from "../core/Packet.ts";
import { GS_ClientSend, SESSION_ReceivedPacket } from "../lib/PacketIDs.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import {
  AI_LEVEL_BAND,
  AI_LEVEL_BAND_TOP,
  MAP_IDX_RANDOM,
  MAX_SESSION_SLOTS,
  SLOTSTATE_BOMBER_MASK,
  SLOTSTATE_CHIEF,
  SLOTSTATE_CHIEF_CLEAR,
  SLOTSTATE_COLOR_MASK,
  SLOTSTATE_GROUP_CLEAR,
  SLOTSTATE_GROUP_MASK,
} from "./Defs.ts";
import { CGameSession } from "./Session";
import { CClientSocket, CUser, GetInfoStr } from "./User";
import { CBomberAttr, CGameMapTmplList } from "./GameData";
import { CMainSystem } from "./System";
import { CDynInfoCalculator } from "./GameContext";

// ============================ CPracticeSession ============================

/**
 * CPracticeSession — the practice room (FxServer.exe.c:41691..).
 *
 * One client socket owns the whole room: its users take the low slots and,
 * for every seat i in [userCount, 2*userCount), an AI seat is bound to the
 * same socket (InitComputerPlayer, :41745).  AI seats stay open, pick bomber
 * 5 and colour 7, and carry a per-seat AI level that starts from the highest
 * human level (a 45-grid band + 1, clamped to 1..31) and moves in 15/45
 * steps through packet 110.  Seats beyond 2*userCount are closed.
 *
 * The room never enters the lobby lists (the table flags stay untouched) and
 * the results unit pays no exp — SendGameResult (004260E4) only reports the
 * per-seat rows.  The start chain (106), the map (97), the emotion (108) and
 * the in-play relays (140..154, 185, 186) are inherited from CGameSession;
 * the overrides below are the seat-oriented handlers.
 */
export class CPracticeSession extends CGameSession {
  /** +12984 — the AI seat's owning socket per slot (ctor-zeroed, 64 bytes). */
  m_argpAISocket: (CClientSocket | null)[] = new Array(MAX_SESSION_SLOTS).fill(null);
  /** +12988 — the AI seat's level per slot (the pair dword at +4; its u16
   *  low word rides the wire). */
  m_anAILevel = new Int32Array(MAX_SESSION_SLOTS);

  /** CPracticeSession::Init (FxServer.exe.c:41727) — CBaseSession::Init with
   *  the static empty title plus the practice resets.  CGameSession::Init's
   *  game-type/mission block is deliberately NOT part of this chain. */
  Init(): void {
    this.fValid = 1;
    CGameSession.ms_ulSerialNo++;
    this.m_nSerialNo = CGameSession.ms_ulSerialNo >>> 0;
    this.m_strName = "";
    this.m_rgPlayer.fill(null);
    this.m_rgSlotState.fill(0);
    this.m_nGamePhase = 0; // +984
    for (const host of this.m_rgUdpHost) host.fill(0); // memset(+988, 0, 0xC0)
    this.m_nGameSerial = this.m_nSerialNo; // +12572 = +148
    this.m_nGameVersion = CMainSystem.ms_pInstance!.m_WorkerRandom.rand(); // +12568 = rand()
    this.m_nGhostCount = 0; // +936
    this.m_rgSlotGhost.fill(-1); // memset(+872, -1, 0x20)
    this.m_rgGhostSlot.fill(-1); // memset(+904, -1, 0x20)
    this.m_nMapIdx = MAP_IDX_RANDOM; // +850 (signed i16) — the random-map mark
    this.m_nGameTypeMod = 0; // +948
    this.m_fPlaying = 0; // +852
    this.m_nCurPlayerNum = 0; // +832
    this.m_nMaxPlayerNum = 8; // +833
  }

  /** CPracticeSession::Create (FxServer.exe.c:42403) — Init, the
   *  CGameSession::AddPlayer seat assignment (vtbl+36), the highest-level
   *  user takes the crown, then the AI seats fill in.  The 86 selects only
   *  feed the bomber preference inside AddPlayer. */
  CreatePractice(socket: CClientSocket, selects: number[]): void {
    // CPracticeSession::Create (FxServer.exe.c:42403) — named CreatePractice
    // here because CGameSession.Create (the room variant) took the C++
    // overload name
    this.Init();
    this.AddPlayer(socket, selects); // vtbl+36
    this.SetChiefSlotidx(CClientSocket.GetMaxLevelUserIdx(socket));
    this.InitComputerPlayer(socket);
  }

  /** CPracticeSession::InitComputerPlayer (FxServer.exe.c:41745). */
  InitComputerPlayer(socket: CClientSocket): void {
    const userCount = socket.GetUserCount();
    let maxLevel = 0;
    for (let i = 0; i < userCount; i++) {
      const level = socket.GetUser(i)!.m_nLevel; // GetLevel(dyn.exp at +212)
      if (maxLevel < level) maxLevel = level;
    }
    // 15*(level/15) floored onto the 45 grid, then +1 clamped into 1..31
    let band = AI_LEVEL_BAND * Math.floor(maxLevel / AI_LEVEL_BAND);
    if (band >= AI_LEVEL_BAND_TOP) band -= band % AI_LEVEL_BAND_TOP;
    let level = band + 1;
    if (level < 1) level = 1;
    if (level > 31) level = 31;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      this.m_anAILevel[slot] = level; // every seat carries the band level
      this.m_argpAISocket[slot] = slot >= userCount && slot < 2 * userCount ? socket : null;
      if (slot >= userCount) {
        const p = slot * 3;
        // the closed bit is (slot >= 2*userCount) — the AI seats stay open
        this.m_rgSlotState[p] = (this.m_rgSlotState[p]! & ~1) | (slot >= 2 * userCount ? 1 : 0);
        this.m_rgSlotState[p + 1] = (this.m_rgSlotState[p + 1]! & 0xc0) | 5; // bomber 5
        this.m_rgSlotState[p + 2] = (this.m_rgSlotState[p + 2]! & 0xe0) | 7; // colour 7
      }
      if (this.m_argpAISocket[slot] !== null) this.SetCurPlayer(this.m_nCurPlayerNum + 1);
    }
  }

  /** CPracticeSession::DestroyComputerPlayer (FxServer.exe.c:41815). */
  DestroyComputerPlayer(socket: CClientSocket): void {
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.m_argpAISocket[slot] === socket) {
        this.m_argpAISocket[slot] = null;
        this.SetCurPlayer(this.m_nCurPlayerNum - 1);
      }
    }
  }

  // ---- seat predicates: a human seat or an AI seat both count ----

  /** CPracticeSession::IsValidSlot (FxServer.exe.c:41691). */
  IsValidSlot(slot: number): boolean {
    return this.m_rgPlayer[slot] !== null || this.m_argpAISocket[slot] !== null;
  }

  /** CPracticeSession::IsPlayerSet (FxServer.exe.c:4255C4) — the same
   *  predicate under the CBaseSession name. */
  IsPlayerSet(slot: number): boolean {
    return this.m_rgPlayer[slot] !== null || this.m_argpAISocket[slot] !== null;
  }

  /** CPracticeSession::IsMySocket (FxServer.exe.c:425D40) — the AI seats
   *  answer to their owner socket too (the ghost/UDP paths call this). */
  IsMySocket(slot: number, socket: CClientSocket): number {
    const user = this.m_rgPlayer[slot];
    if (user) return user.m_pSocket === socket ? 1 : 0;
    return this.m_argpAISocket[slot] === socket ? 1 : 0;
  }

  /** CPracticeSession::IsSlotInThisSocket (FxServer.exe.c:425D72). */
  IsSlotInThisSocket(slot: number, socket: CClientSocket): number {
    if (slot >= MAX_SESSION_SLOTS) return 0;
    const user = this.m_rgPlayer[slot];
    if (!user) return this.m_argpAISocket[slot] === socket ? 1 : 0;
    return user.m_nSlotIdx >= 0 && user.m_pSocket === socket ? 1 : 0;
  }

  /** CPracticeSession::AddUser (FxServer.exe.c:425AA1) — the CBaseSession
   *  body, then the practice stage tag: the socket moves to pool 6. */
  AddUser(slot: number, user: CUser, bomber: number, color: number): void {
    if (this.m_rgPlayer[slot]) {
      console.error("[GS] m_rgPlayer[slotidx], CBaseSession::AddUser(int slotidx, CUser* pUser), not return");
      return;
    }
    this.m_rgPlayer[slot] = user;
    user.SetSessionIdx(this.m_nIdx);
    user.SetSessionSerialNo(this.m_nSerialNo);
    this.SetSlotidx(user, slot);
    user.SetPoolType(6); // user->socket +468 = 6 — the practice stage
    const p = slot * 3;
    this.m_rgSlotState[p + 1] = (this.m_rgSlotState[p + 1]! ^ (bomber ^ this.m_rgSlotState[p + 1]!)) & SLOTSTATE_BOMBER_MASK;
    this.m_rgSlotState[p] = this.m_rgSlotState[p]! & 0xe1; // keep closed + 0xE0
    this.m_rgSlotState[p + 2] = (this.m_rgSlotState[p + 2]! ^ (color ^ this.m_rgSlotState[p + 2]!)) & SLOTSTATE_COLOR_MASK;
    this.SetCurPlayer(this.m_nCurPlayerNum + 1); // CListSession::SetCurPlayer
  }

  /** CPracticeSession::DestroyPlayer (FxServer.exe.c:42022) — the
   *  CListSession::DestroyPlayer body, then the AI seats go with their
   *  socket and the stage tag returns to the lobby (1).  No crown logic:
   *  the room always empties with its owner. */
  DestroyPlayer(socket: CClientSocket, fSendReset: number): number {
    // CListSession::DestroyPlayer — CBaseSession::DestroyPlayer (:31250)
    this.DeleteSocket(socket); // vtbl+68
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = this.GetSlotidx(user);
      if (slot >= 0 && slot < this.m_nMaxSlot && this.m_rgPlayer[slot] === user) {
        this.m_abDeleted[slot] = 0;
        this.DeleteUser(slot);
      }
    }
    this.SendResetPlayer(socket, fSendReset);
    this.DealWithGhostOfLeavingPlayer(socket); // AFTER the destruction here
    this.m_pStrategy.DestroyPlayer(socket); // vtbl+24 (FxServer.exe.c:42028)
    this.DestroyComputerPlayer(socket);
    socket.m_nPoolType = 1; // back to the lobby
    this.FlushPacket();
    this.DeleteAllSlotidx(socket);
    this.m_pStrategy.SendSessionInfo(new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8)); // vtbl+32 (:42035)
    return 1;
  }

  /** CPracticeSession::SetChiefSlotidx (FxServer.exe.c:42127) — the game's
   *  crown move minus the supreme-room mark: a practice room is never
   *  supreme, and the chief's whole roster drops its ready bits. */
  SetChiefSlotidx(next: number): void {
    const old = this.m_nChiefSlotidx;
    if (old >= 0 && old < this.m_nMaxSlot) this.m_rgSlotState[old * 3] &= SLOTSTATE_CHIEF_CLEAR;
    this.m_nChiefSlotidx = next;
    if (next >= 0 && next < this.m_nMaxSlot) {
      this.m_rgSlotState[next * 3] |= SLOTSTATE_CHIEF;
      const user = this.m_rgPlayer[next];
      if (user) {
        const socket = user.m_pSocket;
        if (socket) {
          if (this.m_fPlaying === 0) {
            for (const u of socket.m_apUser) {
              if (!u) continue;
              const slot = this.GetSlotidx(u);
              if (slot < 0 || slot >= this.m_nMaxSlot) {
                console.error("[GS] slotidx < 0 || slotidx >= m_nUserCountMax, CPracticeSession::SetChiefSlotidx");
              } else {
                this.m_rgSlotState[slot * 3] &= SLOTSTATE_GROUP_CLEAR;
              }
            }
          }
        } else {
          console.error("[GS] !pSocket, CPracticeSession::SetChiefSlotidx");
        }
      } else {
        console.error("[GS] !pUser, pUser = pSocket->GetUser(selfidx); CPracticeSession::SetChiefSlotidx");
      }
    }
  }

  /** CPracticeSession::DoOpenCloseSlot (FxServer.exe.c:41834) — opening an
   *  AI seat clears its owner; closing one binds the socket and the reply
   *  carries the seat's AI level.  The 110 goes to the requester only.
   *  Named DoOpenCloseSlotAI because the CListSession variant on the base
   *  class took the C++ virtual name. */
  DoOpenCloseSlotAI(slot: number, open: number, socket: CClientSocket): void {
    if (slot < 0 || slot >= this.m_nMaxSlot) return;
    if (this.m_rgPlayer[slot]) open = 0; // a human seat always closes
    const p = slot * 3;
    const state = this.m_rgSlotState[p]!;
    if (((state & 1) === 0 || open === 0) && ((state & 1) !== 0 || open !== 0)) {
      this.m_rgSlotState[p] = state ^ ((open ^ state) & 1);
      const packet = new CSendPacket(GS_ClientSend.OnOpenCloseSlotRes, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(((slot << 4) | (open & 0xf)) & 0xff);
      if (open === 0) packet.Encode2(this.m_anAILevel[slot] & 0xffff);
      this.m_argpAISocket[slot] = open === 0 ? socket : null;
      this.SetCurPlayer(this.m_nCurPlayerNum + (open === 0 ? 1 : -1));
      socket.SendPacket(packet);
    } else {
      this.m_rgSlotState[p] = state ^ ((open ^ state) & 1);
    }
  }

  /** CPracticeSession::OnOpenCloseSlot (FxServer.exe.c:424F1) — chief only,
   *  100 → the AI-aware DoOpenCloseSlot. */
  OnOpenCloseSlot(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying !== 0) return;
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot < 0 || chiefSlot >= this.m_nMaxSlot) {
      console.error(`[GS] No Chief player exists.(Supreme Room) (SetSlotState). Disconnect [${GetInfoStr(socket)}].`);
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (!chiefUser) {
      console.error(`[GS] Chief player doesn't exists(SetSlotState). Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    if (chiefUser.m_pSocket !== socket) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: non-chief tried to open or close slot.`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const slot = b >> 4;
    const open = (b & 0xf) !== 0 ? 1 : 0;
    if (slot >= 0 && slot < this.m_nMaxSlot) {
      this.DoOpenCloseSlotAI(slot, open, socket);
      return;
    }
    console.error(`[GS] Invalid slot idx (OnOpenCloseSlot). Disconnect [${GetInfoStr(socket)}].`);
    socket.PostClosePacket();
  }

  /** CPracticeSession::OnSelectColor (FxServer.exe.c:42598) — 98 → 108; the
   *  slot rides the high nibble directly (no roster lookup) and colour 7 is
   *  the client's spectator seat: selecting it disconnects. */
  OnSelectColor(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const slot = b >> 4;
    let color = b & 0xf;
    if (color >= MAX_SESSION_SLOTS) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: coloridx is out of range.`);
      socket.PostClosePacket();
      return;
    }
    if (slot < 0 || slot >= this.m_nMaxSlot) {
      console.error(`[GS] Invalid slot idx (OnSelectColor). Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    if (color === 7) {
      console.error(`[GS] Invalid Color (OnSelectColor). Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_fPlaying !== 0) color = this.m_rgSlotState[slot * 3 + 2]! & SLOTSTATE_COLOR_MASK;
    this.SetColor(slot, color); // vtbl+116 (no-ops while playing)
    const packet = new CSendPacket(GS_ClientSend.OnSelectColorRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(((slot << 4) | (color & 0xf)) & 0xff);
    this.SendPacket(packet);
  }

  /** CPracticeSession::OnSelectBomber (FxServer.exe.c:4266D8) — 99 → 109
   *  with the in-play echo: once the game is running the seat's current
   *  bomber is re-sent instead of the requested one. */
  OnSelectBomber(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const slot = b >> 4;
    let bomber = b & 0xf;
    const attr = CBomberAttr.ms_pInstance!;
    if (bomber >= attr.GetNormalCount() && bomber !== attr.GetTotalCount()) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: bomberidx is out of range(OnSelectBomber).`);
      socket.PostClosePacket();
      return;
    }
    if (slot >= this.m_nMaxSlot) {
      console.error(`[GS] Invalid slot idx (OnSelectBomber). Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_fPlaying !== 0) bomber = this.m_rgSlotState[slot * 3 + 1]! & SLOTSTATE_BOMBER_MASK;
    const p = slot * 3 + 1;
    this.m_rgSlotState[p] = this.m_rgSlotState[p]! ^ ((bomber ^ this.m_rgSlotState[p]!) & SLOTSTATE_BOMBER_MASK);
    const packet = new CSendPacket(GS_ClientSend.OnSelectBomberRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(((slot << 4) | (bomber & 0xf)) & 0xff);
    this.SendPacket(packet);
  }

  /** CPracticeSession::OnRequestAILevelChange (FxServer.exe.c:425B4F) —
   *  110 [E1 slot][E1 up]: up moves +15 (below 45) or +45, down the mirror
   *  image, clamped to 1..31.  Asking with slot == GetUserCount moves every
   *  AI seat of the socket at once. */
  OnRequestAILevelChange(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const up = n.Decode1();
    if (slot >= this.m_nMaxSlot) {
      console.error("[GS] Index mismatch at practicesession");
      return;
    }
    if (this.m_argpAISocket[slot] === null || this.m_rgPlayer[slot] !== null) {
      console.error("[GS] User Try to change non-aI data at practicesession");
      return;
    }
    const cur = this.m_anAILevel[slot]!;
    let level: number;
    if (up !== 0) level = cur < AI_LEVEL_BAND_TOP ? cur + AI_LEVEL_BAND : cur + AI_LEVEL_BAND_TOP;
    else level = cur <= AI_LEVEL_BAND_TOP + 1 ? cur - AI_LEVEL_BAND : cur - AI_LEVEL_BAND_TOP;
    if (level > 31 || level < 1) {
      console.error("[GS] Wrong AI Level Change");
      return;
    }
    if (slot === socket.GetUserCount()) {
      // the whole-roster move: every pair takes the level, the owned seats
      // each get their 111
      for (let i = 0; i < this.m_nMaxSlot; i++) {
        this.m_anAILevel[i] = level;
        if (this.m_argpAISocket[i] !== null) {
          const packet = new CSendPacket(GS_ClientSend.OnChangeAILevel, CipherDegree.kPacketEncryptedCRC8);
          packet.Encode1(i);
          packet.Encode2(level & 0xffff);
          socket.PutPacketQueued(packet);
        }
      }
    } else {
      this.m_anAILevel[slot] = level;
      const packet = new CSendPacket(GS_ClientSend.OnChangeAILevel, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(slot);
      packet.Encode2(level & 0xffff);
      socket.PutPacketQueued(packet);
    }
    socket.FlushQueued();
  }

  /** CPracticeSession::MakeSetSlotStatePacket (FxServer.exe.c:42591C) — the
   *  107 grows the AI tail: [E1 owned][E2 level] for AI seats. */
  MakeSetSlotStatePacket(slot: number, packet: CSendPacket): void {
    packet.InitPacket(GS_ClientSend.OnSetSlotState);
    packet.Encode1(slot);
    packet.EncodeBuffer(this.m_rgSlotState.subarray(slot * 3, slot * 3 + 3));
    packet.Encode1(this.m_argpAISocket[slot] !== null ? 1 : 0);
    if (this.m_argpAISocket[slot] !== null) packet.Encode2(this.m_anAILevel[slot]! & 0xffff);
  }

  /** CPracticeSession::MakeSessionInfoPacket (FxServer.exe.c:4258CE) — the
   *  owner socket gets one 105 (fSelf forced) or 107 per slot. */
  MakeSessionInfoPacket(socket: CClientSocket): void {
    const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
    for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
      if (this.m_rgPlayer[slot]) this.MakeSetPlayerPacket(slot, 1, packet);
      else this.MakeSetSlotStatePacket(slot, packet);
      socket.PutPacketQueued(packet);
    }
  }

  /** CPracticeSession::SendSessionInfoPacket (FxServer.exe.c:4258B8) — the
   *  roster burst, no 112 tail (a practice room has no map packet). */
  SendSessionInfoPacket(socket: CClientSocket): void {
    this.MakeSessionInfoPacket(socket);
    socket.FlushQueued();
  }

  /** CPracticeSession::CanStartGame (FxServer.exe.c:4264xx) — the game's
   *  gate plus the AI seats: vtbl+204/+208 add the extra players and the
   *  one extra team, and only practice maps (+96) open the final gate. */
  CanStartGame(fNeedMap: number): number {
    const counts = new Int32Array(MAX_SESSION_SLOTS);
    let players = 0;
    let teams = 0;
    const mapIdx = this.m_nGameMapIdx;
    const chiefUser = this.m_nChiefSlotidx < MAX_SESSION_SLOTS ? this.m_rgPlayer[this.m_nChiefSlotidx] : null;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user || CClientSocket.HasAuthority(25) !== 0) continue;
      const state0 = this.m_rgSlotState[slot * 3]!;
      if (++counts[this.GetColor(slot)]! === 1) teams++;
      players++;
      if (chiefUser && chiefUser.m_pSocket === user.m_pSocket) {
        if ((state0 & SLOTSTATE_GROUP_MASK) !== 0) {
          // 00425F56: report + virtual DumpLog, then keep evaluating.  This
          // diagnostic branch is not the return-2 readiness rejection.
          console.error(`[GS] Chief Player is not stand-by, but [${(state0 >> 2) & 7}].`);
          this.DumpLog();
        }
      } else if ((state0 & SLOTSTATE_CHIEF) === 0 && (state0 & SLOTSTATE_GROUP_MASK) !== 4) {
        return 2;
      }
    }
    if (this.m_nGameType !== 0) {
      for (let c = 0; c < MAX_SESSION_SLOTS; c++) {
        if (counts[c] !== 0 && counts[c] !== Math.floor(players / teams)) return 6;
      }
    }
    players += this.GetExtraPlayerNo(); // vtbl+204 — the AI seats
    teams += this.GetExtraTeamNo(); // vtbl+208 — the practice team
    if (players < 2) return 3;
    if (teams < 2) return 5;
    if (mapIdx < 0) return fNeedMap === 0 ? 1 : 0;
    const list = CGameMapTmplList.ms_pInstance!;
    if (players > list.GetMapMaxPlayer(mapIdx)) return 4;
    if (chiefUser) {
      if (!CMainSystem.IsPremiumChannel() && chiefUser.m_fPremiumTicket !== 1 && list.GetMapPremiumOnly(mapIdx) === 1) return 7;
      if (chiefUser.m_nLevel < list.GetMapLevelLimit(mapIdx)) return 1;
    }
    return list.m_apGameMapTmpl[mapIdx]!.m_fPracticeMap === 0 ? 1 : 0;
  }

  /** CPracticeSession::GetExtraPlayerNo (FxServer.exe.c:425A6D) — the AI
   *  seat count. */
  GetExtraPlayerNo(): number {
    let n = 0;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.m_argpAISocket[slot] !== null) n++;
    }
    return n;
  }

  /** CPracticeSession::GetExtraTeamNo (FxServer.exe.c:4255C0). */
  GetExtraTeamNo(): number {
    return 1;
  }

  /** CPracticeSession::SetMapIdxPlayingByLevel (0042605F, vtbl+188) —
   *  unlike a normal room, random/theme selection is restricted to practice
   *  maps and always uses the native max-team argument 2.  The two inherited
   *  authority/ticket arguments are deliberately ignored. */
  override SetMapIdxPlayingByLevel(level: number, _authority: number, _premiumTicket: number): void {
    let mapIdx = this.m_nMapIdx;
    if (mapIdx === MAP_IDX_RANDOM) {
      mapIdx = CGameMapTmplList.ms_pInstance!.GetRandomMapIdx(this.m_nCurPlayerNum, level, -1, 1, 2, 0);
    } else if (mapIdx < 0) {
      mapIdx = CGameMapTmplList.ms_pInstance!.GetRandomMapIdx(this.m_nCurPlayerNum, level, -2 - mapIdx, 1, 2, 0);
    }
    this.m_nGameMapIdx = mapIdx;
  }

  /** CPracticeSession::LaunchGameStageEx (004259AC, vtbl+200) — called
   *  after LaunchGameStage finishes initializing the round. Practice starts
   *  immediately; its TCP109 is intentionally ignored by OnPacket. */
  override LaunchGameStageEx(): void {
    this.DeferStartGame(); // native virtual dispatch through vtbl+148
  }

  /** CPracticeSession::DeferStartGame (FxServer.exe.c:4259B4) — no UDP
   *  handshake gate: whoever is seated starts. */
  DeferStartGame(): void {
    if (this.m_nCurPlayerNum !== 0) {
      this.DoStartGame();
      this.m_nGameType100 = 0; // +12728
    }
  }

  /** CPracticeSession::DeferBanChief (004259CE) — deliberately empty. */
  override DeferBanChief(): void {}

  /** CPracticeSession::DeferHandleGameEnd (FxServer.exe.c:41942) — every
   *  valid seat (AI included) must be out of play, the winner colour comes
   *  from the seats that finished (code 2), and nobody's counters move. */
  DeferHandleGameEnd(): void {
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (!this.IsValidSlot(slot)) continue;
      const code = this.m_abDeleted[slot]!;
      if (code === 0 || code === 3) return;
    }
    let winner = -1;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const color = this.m_rgSlotState[slot * 3 + 2]! & SLOTSTATE_COLOR_MASK;
      if (this.IsValidSlot(slot) && this.m_abDeleted[slot] === 2) {
        if (winner !== -1) {
          if (winner === color) continue;
          console.error("[GS] Clients returns different results. Send 'tie' result.");
          winner = -1;
          break;
        }
        winner = color;
      }
    }
    this.m_GameClock.EndGame();
    this.SendGameResult(winner); // the practice variant (vtbl+216)
    this.m_nGamePhase = 2;
  }

  /** CPracticeSession::SendGameResult — the client-compatible practice
   *  results unit.  FxServer.map maps the 2004 build to lines 697..767 and
   *  proves its head has four bytes [E1 0][E1 win][E1 0][E1 0].  The exact
   *  2005 EXE/PDB pair inserts a result-view Encode1 at source line 705,
   *  making the function ten machine bytes larger and the payload one byte
   *  longer; that newer field is incompatible with the original client.
   *  Per seat: a human row [E1 1][E4 serial][E1 n3][E1 GetKillCount]
   *  [E1 GetSaveCount][E2 exp‰][E2 exp‰][E2 look][E1 0][E1 0], an AI row
   *  [E1 2][E1 n3][E1 GetKillCount][E1 GetSaveCount][E2 level], or an empty
   *  [E1 0]; one trailing [E1 0] per human.  No rewards: dyn rows and
   *  counters stay untouched. */
  SendGameResult(winTeam: number): void {
    const packet = new CSendPacket(GS_ClientSend.OnGameResult, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(0); // result flag
    packet.Encode1(winTeam);
    // The matching client predates the later strategy result-view byte.
    packet.Encode1(0); // IsLadderGame
    packet.Encode1(0); // different-team used-item flag
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const resultMark = winTeam === -1 ? 3 : winTeam !== (this.m_rgSlotState[slot * 3 + 2]! & SLOTSTATE_COLOR_MASK) ? 2 : 0;
      const user = this.m_rgPlayer[slot];
      if (user) {
        packet.Encode1(1);
        packet.Encode4(user.GetGlobalSerialNo()); // [+1964]
        const expPct = CDynInfoCalculator.GetExpPercentage(user.dyn.exp);
        packet.Encode1(resultMark);
        packet.Encode1(this.m_DynInfoCalculator.GetKillCount(slot)); // +12048
        packet.Encode1(this.m_DynInfoCalculator.GetSaveCount(slot)); // +12016
        packet.Encode2(expPct);
        packet.Encode2(expPct);
        packet.Encode2(user.GetLookLevel());
        packet.Encode1(0);
        packet.Encode1(0);
      } else if (this.m_argpAISocket[slot] !== null) {
        packet.Encode1(2);
        packet.Encode1(resultMark);
        packet.Encode1(this.m_DynInfoCalculator.GetKillCount(slot));
        packet.Encode1(this.m_DynInfoCalculator.GetSaveCount(slot));
        packet.Encode2(this.m_anAILevel[slot]! & 0xffff);
      } else {
        packet.Encode1(0);
      }
    }
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.m_rgPlayer[slot]) packet.Encode1(0);
    }
    this.SendPacket(packet);
  }

  /** CPracticeSession::DoReturnPrepareStage (FxServer.exe.c:425DC4) — the
   *  practice room re-enters with code 3 (the game room sends 0). */
  DoReturnPrepareStage(): void {
    const packet = new CSendPacket(GS_ClientSend.OnReturnPrepareStage, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(3);
    this.SendPacket(packet);
    this.m_nGamePhase = 0;
    this.m_nBanSerial = 0; // +828
    this.m_nGameMapIdx = -1; // +1180
    this.m_dwCreateTime = timeGetTime(); // +860
    this.SetPlaying(0);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      this.m_aBomberIdx[slot] = -1; // +11572
      this.m_rgSlotState[slot * 3] = this.m_rgSlotState[slot * 3]! & SLOTSTATE_GROUP_CLEAR;
      const host = this.m_rgUdpHost[slot]!;
      if (host.some((b) => b !== 0)) host.fill(0); // HOSTHANDLE::operator!= invalidHost
    }
    // vtbl+32 with a fresh CSendPacket, just like the normal return path.
    this.m_pStrategy.SendSessionInfo(new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8));
  }

  /** CPracticeSession::OnPacket (FxServer.exe.c:42790) — the practice room
   *  dispatch.  96, 102..105 and 107 are wrong-type errors; 101, 109 and
   *  111/112 are dropped silently. 98/99/100/110 take the practice handlers,
   *  and the in-play relays 140..152 plus 185/186 are the game's. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (!this.CheckValidSocket(socket)) {
      console.error(`[GS] !this->CheckValidSocket(pSocket), CPracticeSession::OnPacket. Disconnect socket[${GetInfoStr(socket)}]`);
      console.error(`[GS]     User[${socket.GetUser(0)?.GetName() ?? "NULL"}], Game Session Slot Index: [${this.m_nIdx}]. CurrentPoolType=${socket.m_nPoolType}.`);
      socket.PostClosePacket();
      return;
    }
    const id = n.Decode1();
    switch (id) {
      case SESSION_ReceivedPacket.OnSetPlayerReady: // 96
      case SESSION_ReceivedPacket.OnSetGameTypeNormal: // 102
      case SESSION_ReceivedPacket.OnSetGameTypeMod: // 103
      case SESSION_ReceivedPacket.OnHostAskBanPlayer: // 104
      case SESSION_ReceivedPacket.OnRespondToBanPlayer: // 105
      case SESSION_ReceivedPacket.OnRequestChangeTitle: // 107
        console.error(`[GS] Wrong Type Packet Incomming(${id})`); // (sic — the original's typo)
        break;
      case SESSION_ReceivedPacket.OnSelectMap:
        this.OnSelectMap(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSelectColor:
        this.OnSelectColor(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSelectBomber:
        this.OnSelectBomber(n, socket);
        break;
      case SESSION_ReceivedPacket.OnOpenCloseSlot:
        this.OnOpenCloseSlot(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestStartGame:
        this.OnRequestStartGame(n, socket);
        break;
      case SESSION_ReceivedPacket.OnPlayEmotion:
        this.OnPlayEmotion(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestAILevelChange: // 110
        this.OnRequestAILevelChange(n, socket);
        break;
      case SESSION_ReceivedPacket.OnBombIgnite:
        this.OnBombIgnite(n, socket);
        break;
      case SESSION_ReceivedPacket.OnBombKickThrow:
        this.OnBombKickThrow(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSetBombTimer:
        this.OnSetBombTimer(n, socket);
        break;
      case SESSION_ReceivedPacket.OnMovableBoxMove:
        this.OnMovableBoxMove(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestEatItem:
        this.OnRequestEatItem(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestEatObstacle:
        this.OnRequestEatObstacle(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSetBomberEvent:
        this.OnSetBomberEvent(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSetEffect:
        this.OnSetEffect(n, socket);
        break;
      case SESSION_ReceivedPacket.OnDropObstacle:
        this.OnDropObstacle(n, socket);
        break;
      case SESSION_ReceivedPacket.OnEventItem:
        this.OnEventItem(n, socket);
        break;
      case SESSION_ReceivedPacket.OnDestroyBox:
        this.OnDestroyBox(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestGenerateGhost:
        this.OnRequestGenerateGhost(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestDestroyGhost:
        this.OnRequestDestroyGhost(n, socket);
        break;
      case SESSION_ReceivedPacket.OnNotifyUDPLoss:
        if (this.m_fPlaying !== 0 && this.m_nGamePhase === 1) this.OnNotifyUDPLoss(n, socket);
        break;
      case SESSION_ReceivedPacket.OnHackingSuspected:
        this.OnHackingSuspected(n, socket);
        break;
      default:
        break;
    }
  }
}
