/** CGameSession — one room: the session-stage dispatch (96..112), the
 *  in-play dispatch (140..162, 185..187), the ghost/lap/airplane units and
 *  the results unit (163). */

import { Decode1, Decode2, Decode4, Encode1, Encode2, Encode4, EncodeBuffer } from "../core/BufferManipulator.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, kPacketEncryptedCRC8 } from "../core/Packet.ts";
import { GS_ClientSend, SESSION_ReceivedPacket } from "../lib/PacketIDs.ts";
import { ACCOUNTING_LOG_CHANNEL_TYPE, CHANNEL_TYPE_GUILD, DEATH_COORD, IS_LADDER_GAME, MAX_SESSION_SLOTS, RETURN_STAGE_DELAY, SLOTSTATE_BOMBER_CLEAR, SLOTSTATE_BOMBER_MASK, SLOTSTATE_CHIEF, SLOTSTATE_COLOR_CLEAR, SLOTSTATE_COLOR_MASK, SLOTSTATE_GROUP_CLEAR, SLOTSTATE_GROUP_MASK, SLOTSTATE_LAUNCH_OK, SLOTSTATE_READY, STR_BIG_LUCK_MSG, SUPREME_ROOM_SWAP_COUNT, THEME_IDX_BASE, TICK_U32_MASK } from "./Defs";
import { CBanChief, CDynInfoCalculator, CGameClock, CGameContext, CSyncGameObjMan, CUdpLossRegulator } from "./GameContext";
import { CBomberAttr, CGameMapTmplList, CItemAttr } from "./GameData";
import { UserInventory } from "./Rows";
import { CGameSessionTable } from "./SessionTable";
import { CGameSessionStrategy, CGuildSessionStrategy } from "./Strategy";
import { CCenterProcess, CMainSystem } from "./System";
import { CClientSocket, CUser, GetInfoStr } from "./User";
import { CChannelPool } from "./Chat";
import { SLOTSTATE_CHIEF_CLEAR } from "./Defs";
import { CGuildDynInfoCalculator } from "./Strategy";
import { readFileSync } from "node:fs";
import { HOSTHANDLE } from "./MTUDP.ts";
import { MC_ReceivedPacket } from "../lib/S2S.ts";

// ============================ CGameSession ============================

/**
 * CGameSession — one game room (CBaseSession + CListSession + CGameSession,
 * 0x31DC bytes in the original).  The three originals are folded together
 * because every CGameSession virtual is either a CListSession body or one of
 * the empty CGameSessionStrategy thunks (FxServer.exe.lst:79685+).  Fields
 * carry the original struct offsets.
 */
export class CGameSession {
  static ms_ulSerialNo = 0; // CBaseSession::ms_ulSerialNo

  m_strName = ""; // CNamedObject (the room title)
  m_setSocket = new Set<CClientSocket>(); // +128
  fValid = 0; // +140 (CBaseSession::Init sets 1, Destroy clears it)
  m_nIdx = 0; // +144 (u16, GetIdx)
  m_nSerialNo = 0; // +148 (Init: ++ms_ulSerialNo)
  m_rgPlayer: (CUser | null)[] = new Array(8).fill(null); // +20
  m_nMaxSlot = 8; // +16 (the ctor argument)
  m_rgSlotState = new Uint8Array(24); // +68, 3 bytes per slot (cleared by Init)
  m_rgVoteMatrix = new Int32Array(64); // +152 ([8][8], 48-byte stride)
  m_nChiefSwapCount = 0; // +728 (u16; >= 10000 = supreme room)
  m_rgVote = new Int32Array(8); // +780 (0 none, 1 asked, 2 yes, 3 no)
  m_nBanSerial = 0; // +828
  m_nCurPlayerNum = 0; // +832 (byte)
  m_nMaxPlayerNum = 8; // +833 (byte)
  m_szPassword = ""; // +834 (char array, DoJoinSession compares it)
  m_nLevelLimit = 0; // +840
  m_nGameType = 0; // +844 (CGameSession::Init writes it)
  m_fHasPassword = 0; // +848 (byte; set when the password is non-empty)
  m_nMapIdx = -1; // +850 (u16; -1 = random, -2-theme = theme random)
  m_fPlaying = 0; // +852
  m_fModified = 0; // +856 (1 playing / 2 map / 4 cur / 8 max / 0x10 title)
  m_dwCreateTime = 0; // +860 (timeGetTime)
  m_nChiefSlotidx = -2; // +864
  m_fSupreme = 0; // +868 (SetChiefSlotidx: NextChiefSlot == -2)
  m_nGameTypeMod = 0; // +948 (SendGameTypeMod 1 / SendGameTypeNormal 0)
  m_MissionInfo = new Int32Array(4); // +12748 (MissionInfo::operator= ← tmpl+108..+120 at LaunchGameStage)
  m_nGameMapIdx = -1; // +1180 (SetMapIdxPlayingByLevel result)
  m_nGamePhase = 0; // +984 (0 wait / 1 in-play / 2 ended; DoStartGame 1, SendGameResult→2, DoReturnPrepareStage 0)
  m_aBomberIdx = new Int32Array(8).fill(-1); // +11572
  m_abDeleted = new Uint8Array(8); // +11604 (0 alive; 1 dead / 2 goal / 3 trap / 5 lap finish / 6 win / 7 draw)
  m_rgnUsedItem = new Int32Array(8); // +11652 (a special item was used this game)
  m_rgnShopItem = new Int32Array(8); // +12112 (a shop item was used this game)  /** +12632/+12636 — per-slot {time, rank} lap pairs (LaunchGameStage fills -1). */
  m_rgLapTime = new Int32Array(16).fill(-1);
  m_rgLapRank = new Int32Array(16).fill(-1);
  m_rgLapCount = new Int32Array(8); // +12696 (per-slot lap byte)
  /** +12940 — the UDP-alive flags (OnUDPPeerInfo sets, DestroyPlayer clears). */
  m_rgUdpAlive = new Uint8Array(8);
  /** +12948 — the per-slot join times (CGameSession::AddUser; the UDP sweep reads them). */
  m_rgJoinTime = new Int32Array(8);
  /** +988 — per-slot UDP peer hosts (3 × {ip dword, port u16, pad}); the UDP unit reads these. */
  m_rgUdpHost: Uint8Array[] = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new Uint8Array(24));
  m_dwStartSeed = 0; // +12736 (the DoStartGame seed dword)
  m_BanChief = new CBanChief(); // +12576 (the idle-room start gate)
  m_nObj0 = -1; // +11612
  m_nObj1 = -1; // +11616
  /** +12016/+12048/+12208/+12240 — the four dword arrays GetWinGameResult,
   *  GetGameDetailResult and SendGameResult read.  No FXGS code writes any of
   *  them (lst: 2EF0h/2F10h/2FB0h/2FD0h appear only as reads), so they stay 0
   *  for the server's lifetime; the client-visible result bytes still flow
   *  through their comparisons. */
  m_rgColourCount = new Int32Array(8); // +12016 (GetGameDetailResult's D; SendGameResult encode 3)
  m_rgWinDetailB = new Int32Array(8); // +12048 (SendGameResult encode 2)
  m_rgDetailCount = new Int32Array(8); // +12208 (GetWinGameResult's expected-finish count)
  m_rgWinDetailA = new Int32Array(8); // +12240 (GetGameDetailResult's A)
  m_nBombTickTime = 0; // +12552 (the last bomb-tick time)
  m_dwLastTickTime = 0; // +12548 (Update's per-tick timeGetTime marker)
  m_nGameType100 = 0; // +12728 (tmpl+100 at DoStartGame)
  m_GameClock = new CGameClock(); // +12732
  m_UdpLossRegulator = new CUdpLossRegulator(); // +12280
  m_DynInfoCalculator = new CDynInfoCalculator(); // +11684 (the results unit)
  m_fSkipExpReward = 0; // +12276 (SendGameResult/DeleteUser: nonzero skips every exp reward; nothing writes it)
  m_dwPremiumFlag = 0; // +12272 (SendGameResult's per-user premium dword, user+2004 == 1)

  m_SyncGameObjMan = new CSyncGameObjMan(); // +12788
  m_pCtx = new CGameContext(); // +1184 (SetCurrentGameContext(0))
  m_nGameVersion = 0; // +12568 (rand at Init)
  m_nGameSerial = 0; // +12572 (the session serial copy)
  m_dwLaunchTime = 0; // +12556 (timeGetTime at launch)
  m_nGhostStart = 0; // +12560 (tmpl+60 s at LaunchGameStage; ×1000 ms at DoStartGame)
  m_nGhostFreq = 0; // +12564 (tmpl+64 s; ×1000 ms at DoStartGame)
  m_dwLastGhostTime = 0; // +940
  m_nGhostCount = 0; // +936
  m_rgSlotGhost = new Int32Array(8).fill(-1); // +872 slot → ghost idx
  m_rgGhostSlot = new Int32Array(8).fill(-1); // +904 ghost idx → slot
  m_abCaptain = new Int32Array(8); // +952 (CheckIsCaptain's cache)
  m_dwLastAirplaneTime = 0; // +12624 (dword 3156)
  m_dwAirplaneItemProb = 0; // +12776 ← tmpl+72 (SendAirplaneItemProb dword 1)
  m_dwArg76 = 0; // +12780 (tmpl+76)

  m_pStrategy: CGameSessionStrategy; // +12620 — bound once by the ctor

  constructor() {
    // CGameSession ctor tail (FxServer.exe.c:37220) — CreateSessionStrategy
    // picks the guild variant on a type-77 channel.  The port's boot awaits
    // the channel table before building the session table, so MainSystem+8
    // is final here (the original races CM 3 against its DB opens).
    this.m_pStrategy = CGameSession.CreateSessionStrategy(this);
  }

  /** CGameSession::CreateSessionStrategy (FxServer.exe.c:32664) — the
   *  guild strategy only on the type-77 channel. */
  static CreateSessionStrategy(session: CGameSession): CGameSessionStrategy {
    if (CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD) return new CGuildSessionStrategy(session);
    return new CGameSessionStrategy(session);
  }

  /** CBaseSession::Init — CListSession::Init / CGameSession::Init heads. */
  Init(title: string | null, password: string | null, gameType?: number): void {
    this.fValid = 1;
    CGameSession.ms_ulSerialNo++;
    this.m_nSerialNo = CGameSession.ms_ulSerialNo >>> 0;
    this.m_strName = title ?? "";
    this.m_rgPlayer.fill(null);
    this.m_rgSlotState.fill(0);
    if (gameType !== undefined) {
      this.m_szPassword = password ?? "";
      this.m_fHasPassword = this.m_szPassword.length > 0 ? 1 : 0;
      this.m_nMapIdx = -1;
      this.m_nCurPlayerNum = 0;
      this.m_nMaxPlayerNum = this.m_nMaxSlot;
      this.m_fPlaying = 0;
      this.m_fModified = 0;
      this.m_dwCreateTime = Date.now() & TICK_U32_MASK;
      // ---- CGameSession::Init tail (FxServer.exe.c:31752) ----
      this.m_nGamePhase = 0; // +984
      for (const host of this.m_rgUdpHost) host.fill(0); // memset(+988, 0, 0xC0)
      this.m_nGameMapIdx = -1; // +295
      this.m_nGameType = gameType; // +211
      this.m_nGameVersion = Math.floor(Math.random() * 0x7fffffff); // +3142
      this.m_nGameSerial = this.m_nSerialNo; // +3143
      this.m_aBomberIdx.fill(-1); // memset(+11572, -1, 0x20)
      this.m_nGameTypeMod = 0; // +948
      this.m_abCaptain.fill(0); // memset(+952, 0, 0x20)
      this.m_nGhostCount = 0; // +936
      this.m_rgSlotGhost.fill(-1); // memset(+872, -1, 0x20)
      this.m_rgGhostSlot.fill(-1); // memset(+904, -1, 0x20)
    }
  }

  /** CGameSession::Create — CListSession::Init + AddPlayer + InitBangPok. */
  Create(socket: CClientSocket, title: string, password: string, selects: number[], gameType: number): void {
    this.Init(title, password, gameType);
    this.AddPlayerList(socket, selects); // vtbl+24 = CListSession::AddPlayer
    this.m_fModified = 0;
    this.InitBangPok(socket);
  }

  GetName(): string {
    return this.m_strName;
  }

  hasPassword(): boolean {
    return this.m_fHasPassword !== 0;
  }

  // ---- slot-state helpers (the 3-byte records at +68) ----
  // byte0: 0x01 closed / 0x02 chief / 0x1C the ready group (0x04 ready)
  // byte1: 0x3F bomber select, byte2: 0x1F team color

  IsClosed(slot: number): boolean {
    return (this.m_rgSlotState[slot * 3]! & 1) !== 0;
  }

  SetClosed(slot: number, closed: boolean): void {
    const p = slot * 3;
    this.m_rgSlotState[p] = closed ? (this.m_rgSlotState[p]! | 1) : (this.m_rgSlotState[p]! & 0xfe);
  }

  IsReady(slot: number): boolean {
    return (this.m_rgSlotState[slot * 3]! & SLOTSTATE_READY) !== 0;
  }

  /** CanStartGame's stand-by probe — the whole 0x1C group. */
  GetReadyGroup(slot: number): number {
    return this.m_rgSlotState[slot * 3]! & SLOTSTATE_GROUP_MASK;
  }

  GetColor(slot: number): number {
    return this.m_rgSlotState[slot * 3 + 2]! & SLOTSTATE_COLOR_MASK;
  }

  /** CGameSession::DoSelectColor (:41B197) — CListSession::DoSelectColor,
   *  then the strategy's same-guild colour drag. */
  SetColor(slot: number, color: number): void {
    const p = slot * 3 + 2;
    this.m_rgSlotState[p] = (this.m_rgSlotState[p]! & SLOTSTATE_COLOR_CLEAR) | (color & SLOTSTATE_COLOR_MASK);
    this.m_pStrategy.OnSelectColor(slot, color); // strategy vtbl+8
  }

  GetBomber(slot: number): number {
    return this.m_rgSlotState[slot * 3 + 1]! & SLOTSTATE_BOMBER_MASK;
  }

  SetBomber(slot: number, bomber: number): void {
    const p = slot * 3 + 1;
    this.m_rgSlotState[p] = (this.m_rgSlotState[p]! & SLOTSTATE_BOMBER_CLEAR) | (bomber & SLOTSTATE_BOMBER_MASK);
  }

  // ---- CBaseSession slot bookkeeping ----

  /** CBaseSession::IsEmptySlot — nobody seated and the slot open. */
  IsEmptySlot(slot: number): boolean {
    return this.m_rgPlayer[slot] === null && !this.IsClosed(slot);
  }

  IsNullSlot(slot: number): boolean {
    return this.m_rgPlayer[slot] === null;
  }

  /** IsPlayerSet (vtbl+184) — CGameSession also counts practice occupants. */
  IsPlayerSet(slot: number): boolean {
    return this.m_rgPlayer[slot] !== null;
  }

  GetEmptySlotCount(): number {
    let n = 0;
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsEmptySlot(i)) n++;
    return n;
  }

  GetNullSlotCount(): number {
    let n = 0;
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsNullSlot(i)) n++;
    return n;
  }

  GetEmptySlot(): number {
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsEmptySlot(i)) return i;
    return -1;
  }

  GetNullSlot(): number {
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsNullSlot(i)) return i;
    return -1;
  }

  /** CBaseSession::GetSlotidx — the user's +490. */
  GetSlotidx(user: CUser | null): number {
    return user ? user.m_nSlotIdx : -1;
  }

  /** CBaseSession::SetSlotidx. */
  SetSlotidx(user: CUser | null, slot: number): void {
    if (user) user.m_nSlotIdx = slot;
  }

  /** CBaseSession::CheckValidPlayer (vtbl+96). */
  CheckValidPlayer(user: CUser | null): boolean {
    const slot = this.GetSlotidx(user);
    return slot >= 0 && slot < this.m_nMaxSlot && this.m_rgPlayer[slot] === user;
  }

  /** CBaseSession::CheckValidSocket (vtbl+100). */
  CheckValidSocket(socket: CClientSocket): boolean {
    const n = socket.GetUserCount();
    if (n <= 0) return false;
    for (let i = 0; i < n; i++) {
      if (!this.CheckValidPlayer(socket.GetUser(i))) return false;
    }
    return true;
  }

  // ---- sending ----

  /** CBaseSession::SendPacket — every socket of the room. */
  SendPacket(packet: CSendPacket): void {
    for (const socket of this.m_setSocket) socket.SendPacket(packet);
  }

  /** CBaseSession::SendPacketExclude. */
  SendPacketExclude(packet: CSendPacket, except: CClientSocket): void {
    for (const socket of this.m_setSocket) {
      if (socket !== except) socket.SendPacket(packet);
    }
  }

  /** CBaseSession::PutPacket — queue for everyone (optionally minus one). */
  PutPacket(packet: CSendPacket, except: CClientSocket | null = null): void {
    for (const socket of this.m_setSocket) {
      if (socket !== except) socket.PutPacketQueued(packet);
    }
  }

  /** CBaseSession::FlushPacket — drain the queues, close dead sockets. */
  FlushPacket(): void {
    for (const socket of [...this.m_setSocket]) {
      if (socket.m_bConnected) socket.FlushQueued();
      else {
        console.error(`[GS] Not connected socket (${socket.GetUser(0)?.GetName() ?? "NULL"}) in game session. Post Close Packet.`);
        socket.PostClosePacket();
      }
    }
  }

  // ---- the 105/106/107/112 makers ----

  /** CBaseSession::MakeSetSlotStatePacket — 107 [E1 slot][EBuffer 3]. */
  MakeSetSlotStatePacket(slot: number, packet: CSendPacket): void {
    packet.InitPacket(GS_ClientSend.OnSetSlotState);
    packet.Encode1(slot);
    packet.EncodeBuffer(this.m_rgSlotState.subarray(slot * 3, slot * 3 + 3));
  }

  /** CBaseSession::MakeSlotAccessoryPacket — the tail of packet 105. */
  MakeSlotAccessoryPacket(slot: number, packet: CSendPacket): void {
    const user = this.m_rgPlayer[slot]!;
    let n9 = 0;
    for (let i = 0; i < 9; i++) if (user.GetSlotDecorationLoaded(i)) n9++;
    packet.Encode1(n9);
    if (n9 > 0) {
      packet.Encode1(slot);
      for (let i = 0; i < 9; i++) {
        const deco = user.GetSlotDecorationLoaded(i);
        if (deco) {
          packet.Encode1(i);
          packet.Encode2(deco.nAttr1 & 0xffff); // UserInventory+24
        }
      }
    }
    let n5 = 0;
    for (let i = 0; i < 5; i++) if (user.GetCharDecoLoaded(i)) n5++;
    packet.Encode1(n5);
    if (n5 > 0) {
      packet.Encode1(slot);
      for (let i = 0; i < 5; i++) {
        const deco = user.GetCharDecoLoaded(i);
        if (deco) {
          packet.Encode4(deco.nAttr1); // UserInventory+24
          packet.Encode4(deco.nAttr2); // +28
          packet.Encode4(deco.nAttr3); // +32
        }
      }
    }
    const loaded14 = user.GetInventoryLoaded(14);
    packet.Encode4(loaded14 ? loaded14.nAttr3 : 0); // UserInventory+32
  }

  /** CBaseSession::MakeSetPlayerPacket — 105 [slot][serial][self][community]
   *  [deco?][state 3B][simple info][accessory]. */
  MakeSetPlayerPacket(slot: number, fSelf: number, packet: CSendPacket): void {
    const user = this.m_rgPlayer[slot];
    if (!user) return;
    packet.InitPacket(GS_ClientSend.OnSetPlayer);
    packet.Encode1(slot);
    packet.Encode4(user.GetGlobalSerialNo());
    packet.Encode1(fSelf);
    packet.Encode1(user.account.CommunitySvr);
    if (fSelf !== 0) {
      const deco = user.GetInventoryLoaded(4);
      packet.Encode1(deco ? deco.nAttr1 & 0xff : 255); // UserInventory+24
    }
    packet.EncodeBuffer(this.m_rgSlotState.subarray(slot * 3, slot * 3 + 3));
    user.AppendSimpleInfoPacket(packet);
    this.MakeSlotAccessoryPacket(slot, packet);
  }

  /** CBaseSession::MakeSessionInfoPacket — 105/107 for every slot. */
  MakeSessionInfoPacket(socket: CClientSocket): void {
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
      if (this.m_rgPlayer[slot]) this.MakeSetPlayerPacket(slot, socket === this.m_rgPlayer[slot]!.m_pSocket ? 1 : 0, packet);
      else this.MakeSetSlotStatePacket(slot, packet);
      socket.PutPacketQueued(packet);
    }
  }

  /** CBaseSession::SendSessionInfoPacket / CGameSession override
   *  (FxServer.exe.c:41AF87) — 105s + 112 + the strategy's SendSessionInfo +
   *  a second PutPacket of the same buffer.  The base strategy's
   *  SendSessionInfo is a bare `retn 4` (FxServer.exe.lst:4216EF), so on a
   *  normal channel the buffer still holds the 112 and the second PutPacket
   *  sends it AGAIN — the original client receives two consecutive 112s.
   *  The type-77 guild strategy rewrites the buffer as packet 88
   *  (EncodeGuildSessionInfo) and broadcasts it; the guild-channel session
   *  state is not modeled yet. */
  SendSessionInfoPacket(socket: CClientSocket): void {
    this.MakeSessionInfoPacket(socket);
    const packet = new CSendPacket(GS_ClientSend.OnSessionMapIdx, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(this.m_nMapIdx & 0xffff);
    socket.PutPacketQueued(packet); // the joiner's 112
    // strategy vtbl+32 (:41AF87): the base stub leaves the buffer — the
    // second PutPacket re-sends the 112; the guild variant rewrites it as
    // the 88, broadcasts it to the room, and the joiner's second PutPacket
    // sends the 88
    this.m_pStrategy.SendSessionInfo(packet);
    socket.PutPacketQueued(packet);
    socket.FlushQueued();
  }

  /** CBaseSession::SendJoinPacket — build the newcomer's self-view 105
   *  (fSelf=1, so the category-4 deco byte rides along) and PutPacket it to
   *  every room socket EXCEPT the joiner (CBaseSession::PutPacket skips the
   *  excluded socket,
   *  FxServer.exe.c:30670-30686) — this is how the seated players see the
   *  joiner.  The joiner got the full roster from SendSessionInfoPacket
   *  (vtbl+80) already.  FlushPacket drains the whole room either way
   *  (FxServer.exe.c:30926 LABEL_4). */
  SendJoinPacket(socket: CClientSocket): void {
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    const n = socket.GetUserCount();
    if (n <= 0) {
      this.FlushPacket();
      return;
    }
    for (let i = 0; i < n; i++) {
      const user = socket.GetUser(i);
      if (!this.CheckValidPlayer(user)) {
        console.error(`[GS] Wrong session player send session packet(SendJoinPacket). Disconnect user[${user?.GetName() ?? "NULL"}].`);
        socket.PostClosePacket();
        return;
      }
      this.MakeSetPlayerPacket(this.GetSlotidx(user), 1, packet);
      this.PutPacket(packet, socket);
    }
    this.FlushPacket();
    this.m_pStrategy.SendSessionInfo(new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8)); // vtbl+32 (:41AFDC)
  }

  /** CBaseSession::SendResetPlayer — 106 for the leaver's users. */
  SendResetPlayer(socket: CClientSocket, fSendReset: number): void {
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    const n = socket.GetUserCount();
    for (let i = 0; i < n; i++) {
      const user = socket.GetUser(i);
      if (user && this.GetSlotidx(user) >= 0) {
        packet.InitPacket(GS_ClientSend.OnResetPlayer);
        packet.Encode1(this.GetSlotidx(user));
        packet.Encode4(user.GetGlobalSerialNo());
        this.PutPacket(packet);
      }
    }
    if (fSendReset !== 0) socket.SendPacket(packet);
    this.FlushPacket();
  }

  // ---- seating ----

  /** CGameSession::GetColorForNewComer (FxServer.exe.c:32760). */
  GetColorForNewComer(slot: number): number {
    const counts = new Int32Array(8);
    let used = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i]) {
        if (++counts[this.GetColor(i)]! === 1) used++;
      }
    }
    const want = slot % 8;
    if (used > 1) {
      let best = -1;
      let bestCount = 8;
      for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
        if (counts[i]! !== 0 && counts[i]! < bestCount) {
          bestCount = counts[i]!;
          best = i;
        }
      }
      if (best >= 0) return best;
      return want;
    }
    if (used === 1) {
      const mapIdx = this.m_nMapIdx;
      let teams: number;
      if (mapIdx === -1) teams = 0;
      else if (mapIdx < 0) teams = CGameMapTmplList.ms_pInstance?.m_apTheme[THEME_IDX_BASE - mapIdx]?.m_nMaxTeam ?? 0;
      else teams = CGameMapTmplList.ms_pInstance?.GetMapMaxTeam(mapIdx) ?? 0;
      if (teams < 2 || teams > 4) {
        if (counts[want]! > 0) return want === 0 ? 1 : 0;
      } else if (counts[0]! <= 0) {
        return 0;
      } else {
        return 3;
      }
    }
    return want;
  }

  /** CBaseSession::AddUser(slot, user, bomber, color) + the CListSession tail. */
  AddUser(slot: number, user: CUser, bomber: number, color: number): void {
    if (this.m_rgPlayer[slot]) {
      console.error("[GS] m_rgPlayer[slotidx], CBaseSession::AddUser(int slotidx, CUser* pUser), not return");
      return;
    }
    this.m_rgPlayer[slot] = user;
    user.SetSessionIdx(this.m_nIdx);
    user.SetSessionSerialNo(this.m_nSerialNo);
    this.SetSlotidx(user, slot);
    user.SetPoolType(2); // user->socket +468 = 2
    const p = slot * 3;
    this.m_rgSlotState[p + 1] = (this.m_rgSlotState[p + 1]! ^ (bomber ^ this.m_rgSlotState[p + 1]!)) & SLOTSTATE_BOMBER_MASK;
    this.m_rgSlotState[p] = this.m_rgSlotState[p]! & 0xe1; // keep closed + 0xE0
    this.m_rgSlotState[p + 2] = (this.m_rgSlotState[p + 2]! ^ (color ^ this.m_rgSlotState[p + 2]!)) & SLOTSTATE_COLOR_MASK;
    this.m_nCurPlayerNum++;
    this.m_fModified |= 4;
    // CGameSession::AddUser tail (41AF4B)
    this.m_aBomberIdx[slot] = -1; // or [esi+edi*4+2D34h], -1
    this.m_rgUdpAlive[slot] = 0; // +12940 = 0 (CGameSession::AddUser, FxServer.exe.c:31876) — the flag OnUDPPeerInfo (type 11) sets and IsAllPlayerReadyForStart/the 30 s udp-loss sweep read
    this.m_rgJoinTime[slot] = CGameClock.Now(); // [esi+edi*4+3294h] = timeGetTime()
  }

  /**
   * CGameSession::OnUDPPeerInfo (41CE45) — a UDP handshake arrived: merge the
   * self-reported hosts into the slot's HOSTHANDLE list and broadcast the
   * peer matrix (120) to every TCP socket of the room.
   */
  OnUDPPeerInfo(user: CUser, host: HOSTHANDLE, hosts: number[], ports: number[]): void {
    const socket = user.m_pSocket;
    if (!socket) return;
    if (user.GetSessionIdx() !== this.m_nIdx) return;
    if (user.GetSessionSerialNo() !== this.m_nSerialNo) return;
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const u: CUser | null = socket.GetUser(i);
      if (!u) continue;
      const slot = u.m_nSlotIdx;
      if (!this.m_rgPlayer[slot]) return;
      if (this.m_rgUdpAlive[slot] === 1) return;
      this.m_rgUdpAlive[slot] = 1;
    }
    for (let i = 0; i < count; i++) {
      const u = socket.GetUser(i)!;
      if (!this.CheckValidPlayer(u) || u.m_nSlotIdx >= MAX_SESSION_SLOTS) return;
    }
    for (let i = 0; i < count; i++) {
      const slot = socket.GetUser(i)!.m_nSlotIdx;
      const base = this.m_rgUdpHost[slot]!;
      base[0] = (host.ip >>> 24) & 0xff;
      base[1] = (host.ip >>> 16) & 0xff;
      base[2] = (host.ip >>> 8) & 0xff;
      base[3] = host.ip & 0xff;
      base[4] = (host.port >>> 8) & 0xff;
      base[5] = host.port & 0xff;
      let filled = 1; // host[0] occupies the first 8 bytes
      for (let j = 0; j < 2; j++) {
        if (hosts[j] === 0) continue;
        let found = false;
        for (let k = 0; k < filled; k++) {
          const ip = ((base[8 * k]! << 24) | (base[8 * k + 1]! << 16) | (base[8 * k + 2]! << 8) | base[8 * k + 3]!) >>> 0;
          const port = (base[8 * k + 4]! << 8) | base[8 * k + 5]!;
          if (ip === hosts[j] && port === ports[j]) {
            found = true;
            break;
          }
        }
        if (!found && filled < 3) {
          const at = 8 * filled;
          base[at] = (hosts[j]! >>> 24) & 0xff;
          base[at + 1] = (hosts[j]! >>> 16) & 0xff;
          base[at + 2] = (hosts[j]! >>> 8) & 0xff;
          base[at + 3] = hosts[j]! & 0xff;
          base[at + 4] = (ports[j]! >>> 8) & 0xff;
          base[at + 5] = ports[j]! & 0xff;
          filled++;
        }
      }
    }
    const packet = new CSendPacket(GS_ClientSend.OnUDPPeerInfo, CipherDegree.kPacketEncryptedCRC8);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.m_rgPlayer[slot]) {
        packet.Encode1(1);
        const base = this.m_rgUdpHost[slot]!;
        for (let k = 0; k < 3; k++) {
          const at = 8 * k;
          const ip = ((base[at]! << 24) | (base[at + 1]! << 16) | (base[at + 2]! << 8) | base[at + 3]!) >>> 0;
          const port = (base[at + 4]! << 8) | base[at + 5]!;
          packet.Encode4(ip);
          packet.Encode2(port);
        }
        packet.Encode4(this.m_rgJoinTime[slot]! >>> 0);
      } else {
        packet.Encode1(0);
        this.m_rgUdpHost[slot]!.fill(0);
      }
    }
    this.SendPacket(packet);
    if (this.m_fPlaying !== 0 && this.m_nGamePhase === 0) this.DeferStartGame();
  }

  /**
   * The launch-phase UDP-loss sweep inside CGameSession::Update (the phase-0
   * branch): a player that never completed the UDP handshake within 25 s of
   * joining gets kicked with an empty 195 and the socket parked on stage 4.
   * (The <WAITING>/30 s variant in the original is dead code there: the sweep
   * only runs while m_fPlaying is set.)
   */
  private SweepUdpLossOnLaunching(): void {
    // 41DF53 — the grace is 25 s while the room is already flagged playing,
    // 30 s in the waiting stage; the Report string switches with it.
    const grace = this.m_fPlaying !== 0 ? 25000 : 30000;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user) continue;
      if (this.m_rgUdpAlive[slot] !== 0) continue;
      if (CGameClock.Now() - this.m_rgJoinTime[slot]! <= grace) continue;
      const ip = user.m_pSocket ? GetInfoStr(user.m_pSocket) : "";
      console.error(
        `[GS] User[${ip}:${user.GetName()}] (${user.m_pSocket?.GetUserCount() ?? 0}P) banned from game session (${this.m_nIdx}) while ${this.m_fPlaying !== 0 ? "<STARTING>" : "<WAITING>"} by udp loss`,
      );
      this.DumpLog();
      CGameSessionTable.ms_pInstance!.DestroyPlayer(user.m_pSocket!, 0);
      if (user.m_nFree === 0) {
        // [socket+244] == 0 — the IO-layer detach flag FXGS logic never sets,
        // so the port uses the connected flag
        const socket = user.m_pSocket;
        if (socket && socket.m_bConnected) {
          socket.SendPacket(new CSendPacket(GS_ClientSend.OnUdpLossBan, CipherDegree.kPacketEncryptedCRC8)); // 195, no payload
          socket.m_nPoolType = 4; // [socket+1D4]
        }
      }
    }
  }

  /** CBaseSession::AddUser(socket, selects, i) — pick slot/bomber/color. */
  AddUserFromSocket(socket: CClientSocket, selects: number[], i: number): void {
    const user = socket.GetUser(i)!;
    const slot = CClientSocket.HasAuthority(1) !== 0 ? this.GetNullSlot() : this.GetEmptySlot();
    let bomber = selects[i] ?? 0;
    if (!CBomberAttr.ms_pInstance!.IsValidSelectIdx(bomber)) bomber = CBomberAttr.ms_pInstance!.GetRandomBomberIdx();
    let color: number;
    if (i <= 0) color = this.GetColorForNewComer(slot);
    else {
      const first = this.GetSlotidx(socket.GetUser(0));
      color = this.GetColor(first);
    }
    if (CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD) {
      for (let s = 0; s < this.m_nMaxSlot; s++) {
        const other = this.m_rgPlayer[s];
        if (other && other.GetGuildSerialNo() === user.GetGuildSerialNo()) {
          color = this.GetColor(s);
          break;
        }
      }
    }
    this.AddUser(slot, user, bomber, color);
  }

  /** CBaseSession::AddAllUser (vtbl+40). */
  AddAllUser(socket: CClientSocket, selects: number[]): void {
    for (let i = 0; i < socket.GetUserCount(); i++) this.AddUserFromSocket(socket, selects, i);
  }

  /** CBaseSession::AddPlayer (vtbl+36 body): seat check, AddAllUser, AddSocket. */
  AddPlayer(socket: CClientSocket, selects: number[]): number {
    if (this.m_fPlaying !== 0) return 0;
    const n = socket.GetUserCount();
    const free = CClientSocket.HasAuthority(1) !== 0 ? this.GetNullSlotCount() : this.GetEmptySlotCount();
    if (free < n) return 0;
    this.m_pStrategy.AddPlayer(socket); // strategy vtbl+28 (FxServer.exe.c:32856)
    this.AddAllUser(socket, selects);
    this.m_setSocket.add(socket);
    return 1;
  }

  /** CListSession::AddPlayer — CGameSession::AddPlayer wraps it (vtbl+36):
   *  the operator seat-close loop and the strategy's buffer hook ride the
   *  tail (:32862..:32875).  Both authority gates are constant-0 stubs. */
  AddPlayerList(socket: CClientSocket, selects: number[]): number {
    if (this.m_fPlaying !== 0) return 0;
    if (this.AddPlayer(socket, selects) === 0) {
      console.error("[GS] !CListSession::AddPlayer(pSocket, rgnBomber), CGameSession::AddPlayer");
      return 0;
    }
    if (CClientSocket.HasAuthority(24) !== 0) {
      // CListSession::AddPlayer: the operator link takes the crown
      this.SetNewChief(this.GetSlotidx(socket.GetUser(0)));
    }
    if (CClientSocket.HasAuthority(1) !== 0) {
      // CGameSession::AddPlayer's tail: close the operator's seats
      for (let i = 0; i < socket.GetUserCount(); i++) {
        this.DoOpenCloseSlot(this.GetSlotidx(socket.GetUser(i)), 1);
      }
    }
    this.m_pStrategy.SendSessionInfo(new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8)); // vtbl+32
    return 1;
  }

  /** CBaseSession::DeleteUser(slot) + CListSession/DeleteUser + CGameSession::DeleteUser (41D297). */
  DeleteUser(slot: number): void {
    const user = this.m_rgPlayer[slot];
    if (this.fValid !== 0) {
      // CGameSession::DeleteUser — in-play: the captain's death cascade and
      // the loss count (+12276, the results-unit gate, is 0 until then).
      let incLose: boolean;
      if (this.m_nGamePhase === 1) {
        this.OnBomberDie(slot);
        incLose = true;
      } else {
        incLose = this.m_nGamePhase === 0;
      }
      if (incLose) user?.IncLose();
    }
    this.m_rgPlayer[slot] = null;
    this.m_rgSlotState[slot * 3] = this.m_rgSlotState[slot * 3]! & 0xfd; // clear chief
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      this.m_rgVoteMatrix[slot * 8 + i] = 0;
      this.m_rgVoteMatrix[i * 8 + slot] = 0;
    }
    this.m_rgVote[slot] = 0;
    this.m_nCurPlayerNum--;
    this.m_fModified |= 4;
    this.m_aBomberIdx[slot] = -1; // CGameSession+11572 dword[slot]
    const host = this.m_rgUdpHost[slot]!;
    if (host.some((b) => b !== 0)) host.fill(0); // HOSTHANDLE::operator!= invalidHost
  }

  /** CBaseSession::DeleteAllSlotidx — SetSlotidx(-1) for the socket's users. */
  DeleteAllSlotidx(socket: CClientSocket): void {
    if (!socket) return;
    for (let i = 0; i < socket.GetUserCount(); i++) this.SetSlotidx(socket.GetUser(i), -1);
  }

  // ---- chief ----

  /** CListSession::IsChief — the socket owns the chief user. */
  IsChief(socket: CClientSocket): boolean {
    if (!socket) return false;
    const slot = this.m_nChiefSlotidx;
    if (slot < 0 || slot >= this.m_nMaxSlot) return false;
    const user = this.m_rgPlayer[slot];
    return user !== null && user.m_pSocket === socket;
  }

  /** CListSession::GetFirstSupremeChief — the first RoomTicket holder. */
  GetFirstSupremeChief(): number {
    if (this.m_nMaxSlot <= 0) return -2;
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      const user = this.m_rgPlayer[i];
      if (user && user.HasFunctionalItem("Item/RoomTicket")) return i;
    }
    return -2;
  }

  /** CListSession::GetNextChiefSlot. */
  GetNextChiefSlot(): number {
    if (this.m_nChiefSwapCount >= SUPREME_ROOM_SWAP_COUNT) return this.GetFirstSupremeChief();
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      if (this.m_rgPlayer[i]) return i;
    }
    return -2;
  }

  /** CListSession::SetChiefSlotidx — byte0 0x02 marks the chief. */
  SetChiefSlotidx(next: number): void {
    this.m_fSupreme = next === -2 ? 1 : 0;
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
              if (slot >= 0 && slot < this.m_nMaxSlot) this.m_rgSlotState[slot * 3] &= SLOTSTATE_GROUP_CLEAR; // clear ready
            }
          }
        } else {
          console.error("[GS] !pSocket, CListSession::SetChiefSlotidx");
        }
      } else {
        console.error("[GS] !pUser, CListSession::SetChiefSlotidx");
      }
    }
  }

  /** CListSession::SetNewChief — move the crown and queue the 107s. */
  SetNewChief(next: number): void {
    const old = this.m_nChiefSlotidx;
    let nextSlot = next;
    if (nextSlot < 0) nextSlot = this.GetNextChiefSlot();
    this.SetChiefSlotidx(nextSlot);
    if (this.m_nChiefSlotidx >= 0 && this.m_nMaxSlot > 0) {
      for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
        const user = this.m_rgPlayer[slot];
        if (user && slot !== this.m_nChiefSlotidx && this.IsChief(user.m_pSocket!)) {
          const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
          this.MakeSetSlotStatePacket(slot, packet);
          this.PutPacket(packet);
        }
      }
    }
    if (old >= 0) {
      const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
      this.MakeSetSlotStatePacket(old, packet);
      this.PutPacket(packet);
    }
    if (this.m_nChiefSlotidx >= 0) {
      const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
      this.MakeSetSlotStatePacket(this.m_nChiefSlotidx, packet);
      this.PutPacket(packet);
    }
  }

  /** CListSession::InitBangPok — decide the first chief. */
  InitBangPok(socket: CClientSocket): void {
    let chief = 0;
    this.m_fSupreme = 0;
    if (this.m_nChiefSwapCount < SUPREME_ROOM_SWAP_COUNT) {
      const maxLevelUser = socket.GetMaxLevelUser();
      let slot = 0;
      for (; slot < this.m_nMaxSlot && this.m_rgPlayer[slot] !== maxLevelUser; slot++);
      if (slot === this.m_nMaxSlot) {
        slot = 0;
        for (; slot < this.m_nMaxSlot; slot++) {
          const user = this.m_rgPlayer[slot];
          if (user && user.m_pSocket === socket) break;
        }
      }
      this.SetChiefSlotidx(slot);
    } else {
      for (; chief < this.m_nMaxSlot; chief++) {
        const user = this.m_rgPlayer[chief];
        if (user && user.HasFunctionalItem("Item/RoomTicket")) break;
      }
      if (chief >= this.m_nMaxSlot) {
        this.m_nChiefSlotidx = -2;
        console.log("[GS] Spurious LadderSession Creation");
        return;
      }
      this.SetChiefSlotidx(chief);
    }
    this.m_nBanSerial = 0;
  }

  /** CListSession::DoBangPok — 122 to everyone, then out to the lobby. */
  DoBangPok(): void {
    for (const socket of [...this.m_setSocket]) {
      const p = new CSendPacket(GS_ClientSend.OnBangPok, CipherDegree.kPacketEncryptedCRC8);
      socket.SendPacket(p);
      socket.m_nPoolType = 4; // CClientSocket+468 = 4 (MoveToExchangeSession)
      CGameSessionTable.ms_pInstance!.MoveToExchangeSession(socket, 0);
    }
  }

  // ---- title ----

  /** CListSession::CanRequestChangeTitle (vtbl+108). */
  CanRequestChangeTitle(socket: CClientSocket): boolean {
    if (this.IsChief(socket)) return true;
    console.error("[GS] !this->IsChief(pSocket), CListSession::CanRequestChangeTitle");
    return false;
  }

  /** CBaseSession::DoChangeTitle + the CListSession modified bit. */
  DoChangeTitle(title: string): void {
    this.m_strName = title;
    const packet = new CSendPacket(GS_ClientSend.OnChangeTitle, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(title);
    this.SendPacket(packet);
    this.m_fModified |= 0x10;
  }

  /** CListSession::DoOpenCloseSlot (vtbl+124) — 110 + the open-slot count. */
  DoOpenCloseSlot(slot: number, close: number): void {
    if (slot < 0 || slot >= this.m_nMaxSlot) return;
    if (this.m_rgPlayer[slot]) close = 0;
    const packet = new CSendPacket(GS_ClientSend.OnOpenCloseSlotRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(((slot << 4) | (close & 0xf)) & 0xff);
    this.SendPacket(packet);
    const p = slot * 3;
    const state = this.m_rgSlotState[p]!;
    const changing = (state & 1) === 0 !== (close === 0);
    this.m_rgSlotState[p] = state ^ ((close ^ state) & 1);
    if (changing) {
      let open = 0;
      for (let i = 0; i < this.m_nMaxSlot; i++) {
        if ((this.m_rgSlotState[i * 3]! & 1) === 0) open++;
      }
      if (open !== this.m_nMaxPlayerNum) {
        this.m_fModified |= 8;
        this.m_nMaxPlayerNum = open;
      }
    }
  }

  /** CListSession::SetPlaying. */
  SetPlaying(playing: number): void {
    this.m_fModified |= 1;
    this.m_fPlaying = playing;
  }

  /** CListSession::SetCurPlayer. */
  SetCurPlayer(cur: number): void {
    this.m_fModified |= 4;
    this.m_nCurPlayerNum = cur;
  }

  // ---- room list packets (83/85/86/87) ----

  /** CListSession::MakeSimpleInfoPacket — 83 [E2 idx][E4 serial][EStr name]
   *  [E1 hasPW][E1 gameType][E1 playing][E2 mapIdx][E1 cur][E1 max]. */
  /** CGameSession::MakeSimpleInfoPacket (:41ADFD) — the 83, then the
   *  strategy's guild-team append. */
  MakeSimpleInfoPacket(packet: CSendPacket): void {
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.EncodeStr(this.m_strName);
    packet.Encode1(this.m_fHasPassword);
    packet.Encode1(this.m_nGameType);
    packet.Encode1(this.m_fPlaying);
    packet.Encode2(this.m_nMapIdx & 0xffff);
    packet.Encode1(this.m_nCurPlayerNum);
    packet.Encode1(this.m_nMaxPlayerNum);
    this.m_pStrategy.MakeSimpleInfoPacket(packet); // vtbl+12
  }

  /** CGameSession::MakeCreatedPacket (:41AE15) — the 85, then the guild
   *  append. */
  MakeCreatedPacket(packet: CSendPacket): void {
    packet.InitPacket(GS_ClientSend.OnSessionCreated);
    this.MakeSimpleInfoCreated(packet);
    this.m_pStrategy.MakeCreatedPacket(packet); // vtbl+16
  }

  private MakeSimpleInfoCreated(packet: CSendPacket): void {
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.EncodeStr(this.m_strName);
    packet.Encode1(this.m_fHasPassword);
    packet.Encode1(this.m_nGameType);
    packet.Encode1(this.m_nCurPlayerNum);
    packet.Encode1(this.m_nMaxPlayerNum);
  }

  /** CListSession::MakeModifiedPacket — 86, or 0 when nothing changed. */
  MakeModifiedPacket(packet: CSendPacket): number {
    if (this.m_fModified === 0) return 0;
    packet.InitPacket(GS_ClientSend.OnSessionModified);
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.Encode1(this.m_fModified);
    if ((this.m_fModified & 1) !== 0) packet.Encode1(this.m_fPlaying);
    if ((this.m_fModified & 2) !== 0) packet.Encode2(this.m_nMapIdx & 0xffff);
    if ((this.m_fModified & 4) !== 0) packet.Encode1(this.m_nCurPlayerNum);
    if ((this.m_fModified & 8) !== 0) packet.Encode1(this.m_nMaxPlayerNum);
    if ((this.m_fModified & 0x10) !== 0) packet.EncodeStr(this.m_strName);
    this.m_fModified = 0; // CListSession::MakeModifiedPacket clears before returning
    this.m_pStrategy.MakeModifiedPacket(packet); // vtbl+20
    return 1;
  }

  /** CListSession::MakeDestroyedPacket — 87 [E2 idx][E4 serial]. */
  MakeDestroyedPacket(packet: CSendPacket): void {
    packet.InitPacket(GS_ClientSend.OnSessionDestroyed);
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
  }

  // ---- leaving ----

  /** CGameSession::DestroyPlayer — the full leave path (FxServer.exe.c:32692). */
  DestroyPlayer(socket: CClientSocket, fSendReset: number): number {
    let dissolve = false;
    // CGameSession::DestroyPlayer (:32692) loop 1 — for the seated leavers,
    // clear the UDP-alive flag (+12940) and the 24-byte ghost-host block
    // (+988, memset 0x18) before anything else runs.
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = this.GetSlotidx(user);
      if (slot >= 0 && slot < this.m_nMaxSlot && this.m_rgPlayer[slot] === user) {
        this.m_rgUdpAlive[slot] = 0;
        this.m_rgUdpHost[slot]!.fill(0);
      }
    }
    const wasChief = this.IsChief(socket);
    // the first leaver's slot drives CSyncGameObjMan::OnPlayerLeave
    const firstUser = socket.GetUserCount() > 0 ? socket.GetUser(0) : null;
    const firstSlot = firstUser ? firstUser.m_nSlotIdx : -1;
    this.DealWithGhostOfLeavingPlayer(socket);
    // CListSession::DestroyPlayer → CBaseSession::DestroyPlayer (:31250):
    // DeleteSocket (vtbl+68), DeleteAllUser (vtbl+52 — per user the vtbl+96
    // residency check then the virtual DeleteUser(slot); a non-resident
    // user reports), SendResetPlayer, socket +468 = 1.
    this.m_setSocket.delete(socket);
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = this.GetSlotidx(user);
      if (slot >= 0 && slot < this.m_nMaxSlot && this.m_rgPlayer[slot] === user) {
        this.DeleteUser(slot); // vtbl+56 = CGameSession::DeleteUser
      } else {
        console.error(`[GS] Invalid User try to destory, socket [${user.GetName()}]`);
      }
    }
    this.SendResetPlayer(socket, fSendReset);
    socket.m_nPoolType = 1; // socket +468 = 1 (back to the lobby)
    this.m_pStrategy.DestroyPlayer(socket); // vtbl+24 (FxServer.exe.c:32731)
    this.m_SyncGameObjMan.OnPlayerLeave(firstSlot);
    if (wasChief) {
      const oldSupreme = this.m_fSupreme;
      this.m_BanChief = new CBanChief(); // CBanChief::Init(+12576)
      this.SetNewChief(-1);
      if (this.m_nChiefSwapCount >= SUPREME_ROOM_SWAP_COUNT && oldSupreme === 0 && this.m_fSupreme !== 0 && this.m_fPlaying === 0) {
        dissolve = true;
      }
    }
    this.FlushPacket();
    this.DeleteAllSlotidx(socket);
    this.m_pStrategy.SendSessionInfo(new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8)); // vtbl+32 (:32746)
    if (this.m_nBanSerial !== 0) this.DeferBanPlayer(); // +207 → vtbl+144
    // a chief gone while the game is launching → try to start with the rest
    if (this.m_fPlaying !== 0 && this.m_nGamePhase === 0) this.DeferStartGame(); // +213/+246 → vtbl+148
    socket.AddBeforeJoinSession(this.m_nIdx);
    if (dissolve) this.DoBangPok();
    return 1;
  }

  /**
   * CGameSession::DealWithGhostOfLeavingPlayer (FxServer.exe.c:31813) —
   * hand each of the leaving socket's ghosts to the first live socket with a
   * free ghost slot (166), or destroy them (167) when nobody can take one.
   */
  DealWithGhostOfLeavingPlayer(socket: CClientSocket): void {
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = this.GetSlotidx(user);
      if (slot < 0 || slot >= MAX_SESSION_SLOTS) continue;
      const ghost = this.m_rgSlotGhost[slot]!;
      if (ghost === -1) continue;
      let freeSlot = 0;
      while (freeSlot < MAX_SESSION_SLOTS && !(this.m_rgPlayer[freeSlot] !== null && this.m_rgSlotGhost[freeSlot] === -1)) freeSlot++;
      if (freeSlot >= MAX_SESSION_SLOTS) {
        const p = new CSendPacket(GS_ClientSend.OnGhostDestroy, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(ghost);
        this.SendPacket(p);
        this.m_rgSlotGhost[slot] = -1;
        this.m_rgGhostSlot[ghost] = -1;
      } else {
        const p = new CSendPacket(GS_ClientSend.OnGhostGenerate, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(ghost);
        p.Encode1(freeSlot);
        this.SendPacket(p);
        this.m_rgSlotGhost[slot] = -1;
        this.m_rgGhostSlot[freeSlot] = ghost;
        this.m_rgSlotGhost[freeSlot] = ghost;
      }
    }
  }

  // ---- the in-play tick (CGameSession::Update, FxServer.exe.c:34783) ----

  /**
   * CGameSession::Update — every valid session gets this from
   * CGameSessionTable::UpdateGameSessions (4219A2) on the 400 ms timer (the
   * table's scratch packet argument carries no payload of its own).
   */
  Update(): void {
    if (this.fValid === 0) return;
    if (this.m_fPlaying === 0) {
      // !playing → vtbl+224 CBaseSession::DeferBanChief — the ban-chief unit.
      this.DeferBanChief();
      return;
    }
    const time = Date.now();
    this.m_dwLastTickTime = time;
    if (this.m_nGamePhase === 0) {
      // launching: kick the sockets that never completed the UDP handshake
      this.SweepUdpLossOnLaunching();
      return;
    }
    if (this.m_nGamePhase === 2) {
      this.DeferReturnPrepareStage();
      return;
    }
    // phase 1 — in play
    this.DeferHandleGameEnd();
    if (this.m_nGamePhase !== 1) {
      // the defer moved the game on — CSyncGameObjMan::OnGameEnd, once
      this.m_SyncGameObjMan.OnGameEnd();
      return;
    }
    if (this.m_GameClock.ElapsedTime() - this.m_GameClock.m_dwSuspended > 0x2bf20) {
      // the 3-minute play window (suspended time does not count) ran out
      this.SendGameResult(-1);
      this.m_GameClock.EndGame();
      this.m_nGamePhase = 2;
      return;
    }
    this.m_UdpLossRegulator.DeferRegulateConnection(this);
    const ctx = this.m_pCtx;
    const elapsed = time - this.m_nBombTickTime;
    this.m_nBombTickTime = time;
    let exploded = 0;
    if (ctx.m_nBombCount > 0) {
      // 152 — the bomb clock: every armed bomb counts down by the elapsed ms
      const packet = new CSendPacket(GS_ClientSend.OnSetBombTimerRes, CipherDegree.kPacketEncryptedCRC8);
      const countOffset = packet.m_uOffset;
      packet.Encode1(0);
      let i = 0;
      while (i < ctx.m_nBombCount) {
        const bomb = ctx.m_rgBomb[i]!;
        if (bomb.fFlag16 === 0 || bomb.fMoving === 1) bomb.timer -= elapsed;
        if (bomb.timer <= 0) {
          exploded++;
          packet.Encode2(bomb.id);
          if (bomb.fMoving === 1) {
            // a kicked bomb re-arms for another 2 s instead of exploding
            bomb.timer = 2000;
            bomb.fMoving = 0;
            packet.Encode1(1);
          } else {
            packet.Encode1(0);
            ctx.m_nBombCount--;
            if (ctx.m_nBombCount > 0) ctx.m_rgBomb[i] = ctx.m_rgBomb[ctx.m_nBombCount]!;
            continue; // re-examine the slot the last bomb moved into
          }
        }
        i++;
      }
      if (exploded > 0) {
        packet.Encode1At(countOffset, exploded);
        this.PutPacket(packet);
      }
    }
    // 159 — the trap clock: trapped players die once the grace runs out
    let died = 0;
    let grace = 10000;
    {
      let allDown = true;
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        const code = this.m_abDeleted[slot]!;
        if (code !== 3 && code !== 1 && code !== 4) {
          allDown = false;
          break;
        }
      }
      if (allDown) grace = 6000; // everybody down/goal/trapped: the short fuse
    }
    const packet2 = new CSendPacket(GS_ClientSend.OnBomberEvent, CipherDegree.kPacketEncryptedCRC8);
    packet2.Encode1(80);
    packet2.Encode2(0);
    packet2.Encode2(0);
    const countOffset2 = packet2.m_uOffset;
    packet2.Encode1(0);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.m_abDeleted[slot] !== 3) continue;
      if (this.m_GameClock.ElapsedTime() - ctx.m_rgnDownTime[slot]! >= grace) {
        packet2.Encode1(slot);
        packet2.Encode2(DEATH_COORD);
        packet2.Encode2(DEATH_COORD);
        died++;
        this.m_abDeleted[slot] = 1;
        ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime();
        this.OnBomberDie(slot);
      }
    }
    if (died > 0) {
      packet2.Encode1At(countOffset2, died);
      this.PutPacket(packet2);
    }
    if (exploded > 0 || died > 0) this.FlushPacket();
  }

  /**
   * CGameSession::DeferBanChief (vtbl+224, FxServer.exe.lst:41C15B) — the
   * idle-room start gate.  The chief must press start within IsBanChief's
   * window (10 s idle games / 20 s fresh rooms since SetCanStart, halved when
   * he wears "Item/SuperChief" or holds Pm authority 25) or receive warning
   * 121 (E1 1/2/3 per stage); expiry removes him (163 with result 2).  A
   * start-flood gets the odd-slot grace (GetOddSlotInManner = count × 5 s)
   * and its own warning; expiry restarts the whole CanStart cycle
   * (SetCanStart(1)).  A chief-side decline (b) or the arrival of an
   * already-started room resets the cycle (SetCanStart(0)).
   */
  DeferBanChief(): void {
    if (this.m_fPlaying !== 0) {
      // cmp [esi+354h], ebx — a playing room only resets the gate
      this.m_BanChief.Init();
      return;
    }
    const slot = this.m_nChiefSlotidx; // [+360]
    if (slot < 0 || slot >= MAX_SESSION_SLOTS) return;
    const user = this.m_rgPlayer[slot]!;
    if (user === null || user.m_pSocket === null) return;
    // neg/sbb/and 2/inc — "Item/SuperChief" stretches every gate ×3
    const superChief = user.HasFunctionalItem("Item/SuperChief") ? 3 : 1;
    const now = CGameClock.Now(); // timeGetTime
    let oddGate = false; // 41C238
    if (this.m_nGameType === 0) {
      // [+34C] plain rooms: only 2+-player ones are gated
      if (this.m_nMaxPlayerNum > 1) {
        this.m_BanChief.SetOddSlot(0); // 41C202
      } else if (CClientSocket.HasAuthority(22) !== 0) { // CUser::HasAuthority(22)
        this.m_BanChief.SetOddSlot(0); // 41C1F5 → 41C202 (CUser::HasAuthority)
      } else {
        oddGate = true;
      }
    } else {
      // event rooms: odd player counts are gated
      if (this.m_nMaxPlayerNum % 2 === 0) {
        this.m_BanChief.SetOddSlot(0); // 41C1E4 even → 41C202
      } else if (CClientSocket.HasAuthority(22) !== 0) { // CUser::HasAuthority(22)
        this.m_BanChief.SetOddSlot(0); // 41C1F5 → 41C202
      } else {
        oddGate = true;
      }
    }
    if (oddGate) {
      // 41C238 — the odd-slot grace (GetOddSlotInManner = now × 5000)
      const bc = this.m_BanChief;
      if (bc.m_nOddSlot === 0) {
        bc.SetOddSlot(1);
      } else if (now - bc.m_dwOddSlotTime > bc.GetOddSlotInManner(now)) {
        if (bc.m_nWarnedBanOddSlot === 0) {
          bc.SetWarnedBanOddSlot(1);
          const p = new CSendPacket(GS_ClientSend.OnNeedStartGame, CipherDegree.kPacketEncryptedCRC8);
          p.Encode1(1);
          p.Encode2(Math.trunc(bc.GetWarningDelay(now) / 1000));
          this.SendPacket(p);
        } else if (now - bc.m_dwWarnedBanOddSlotTime > bc.GetWarningDelay(now)) {
          const p = new CSendPacket(GS_ClientSend.OnNeedStartGame, CipherDegree.kPacketEncryptedCRC8);
          p.Encode1(3);
          p.Encode2(Math.trunc(bc.GetWarningDelay(now) / 1000));
          user.m_pSocket.SendPacket(p); // vtbl+68 — the chief only
          // CBaseSessionTable vtbl+48 (the DestroyPlayer override) then +468 = 4
          CGameSessionTable.ms_pInstance!.DestroyPlayer(user.m_pSocket, 0);
          bc.SetCanStart(0); // 41C46C → SetCanStart(0)
          return;
        }
      }
    }
    // 41C211 — the fresh-room start gate
    if (this.CanStartGame(1) !== 0) {
      // vtbl+220 refused → restart the whole cycle
      this.m_BanChief.SetCanStart(0);
      return;
    }
    if (this.m_BanChief.m_nCanStart === 0) {
      this.m_BanChief.SetCanStart(1); // 41C231
      return;
    }
    // 41C35B — the idle-game gate
    if (CClientSocket.HasAuthority(22) !== 0) return; // CUser::HasAuthority(22)
    const flag = this.m_nMaxPlayerNum - this.m_nCurPlayerNum < 0 ? 1 : 0;
    if (!this.m_BanChief.IsBanChief(flag, this.m_nGameType, superChief)) return;
    if (this.m_BanChief.m_nWarnedBan === 0) {
      this.m_BanChief.SetWarnedBan(1);
      const p = new CSendPacket(GS_ClientSend.OnNeedStartGame, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(0);
      p.Encode2(Math.trunc(this.m_BanChief.GetWarningDelay(now) / 1000));
      this.SendPacket(p);
      return;
    }
    if (now - this.m_BanChief.m_dwWarnedBanTime <= this.m_BanChief.GetWarningDelay(now)) return;
    const p2 = new CSendPacket(GS_ClientSend.OnNeedStartGame, CipherDegree.kPacketEncryptedCRC8);
    p2.Encode1(2);
    p2.Encode2(Math.trunc(this.m_BanChief.GetWarningDelay(now) / 1000));
    user.m_pSocket.SendPacket(p2); // vtbl+68 — the chief only
    CGameSessionTable.ms_pInstance!.DestroyPlayer(user.m_pSocket, 0); // vtbl+48 (+468 = 4 in the tail)
    this.m_BanChief.SetCanStart(0); // 41C46C
  }

  /** CGameSession::DeferReturnPrepareStage (41B0B7) — 8 s after the end screen. */
  DeferReturnPrepareStage(): void {
    if (Date.now() - this.m_GameClock.m_dwEndTime > RETURN_STAGE_DELAY) this.DoReturnPrepareStage();
  }

  /** CGameSession::DoReturnPrepareStage (41B0DA). */
  DoReturnPrepareStage(): void {
    const packet = new CSendPacket(GS_ClientSend.OnReturnPrepareStage, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(0);
    this.SendPacket(packet);
    this.m_nGamePhase = 0;
    this.m_nBanSerial = 0; // +828
    this.m_nGameMapIdx = -1; // +1180
    this.m_dwCreateTime = Date.now(); // +860
    this.SetPlaying(0);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      this.m_aBomberIdx[slot] = -1; // +11572
      this.m_rgSlotState[slot * 3] = this.m_rgSlotState[slot * 3]! & SLOTSTATE_GROUP_CLEAR;
    }
    // strategy vtbl+32 with a fresh buffer (:41B197's DoReturnPrepareStage
    // tail) — the base stub no-ops, the guild variant broadcasts an 88
    this.m_pStrategy.SendSessionInfo(new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8));
    if (this.m_fSupreme !== 0) this.DoBangPok();
  }

  /**
   * CGameSession::DeferHandleGameEnd (41D31A) — the game is over when some
   * player finished (lap code 5) or won (6); otherwise every player must be
   * out of play (not 0/3).  The winner colour is the first finished player's
   * colour; any later disagreement downgrades to a tie (-1).
   */
  DeferHandleGameEnd(): void {
    let finished = false;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const code = this.m_abDeleted[slot]!;
      if (this.m_rgPlayer[slot] !== null && (code === 5 || code === 6)) finished = true;
    }
    if (!finished) {
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        const code = this.m_abDeleted[slot]!;
        if (this.m_rgPlayer[slot] !== null && (code === 0 || code === 3)) return;
      }
    }
    let winner = -1;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user) continue;
      // CUser::HasAuthority(25) is the constant-0 stub — skipped
      const code = this.m_abDeleted[slot]!;
      if (code !== 2 && code !== 5 && code !== 6) {
        user.IncGame();
        continue;
      }
      const color = this.m_rgSlotState[slot * 3 + 2]! & SLOTSTATE_COLOR_MASK;
      if (winner === -1) {
        winner = color;
        user.IncGame();
      } else if (winner === color) {
        user.IncGame();
      } else {
        console.error("[GS] Clients returns different results. Send 'tie' result.");
        winner = -1;
        // the disagreement path skips IncGame for this user
      }
    }
    this.m_GameClock.EndGame();
    this.SendGameResult(winner); // sets the phase 2 internally in the original
    this.m_nGamePhase = 2;
  }

  /**
   * CGameSession::GetWinGameResult (41B482) — 1 when the number of slots in a
   * finish state (2 goal / 6 win) equals the slot's expected count (+12208)
   * while another team still has a pending count; in practice the counters
   * are never written, so this always returns 0.
   */
  GetWinGameResult(n8: number): number {
    const expected = this.m_rgDetailCount[n8]!; // [+12208+4n8]
    if (expected <= 2) return 0;
    const colour = this.GetColor(n8) & SLOTSTATE_COLOR_MASK;
    let otherPlaying = 0;
    for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
      if ((this.GetColor(k) & SLOTSTATE_COLOR_MASK) !== colour && this.m_rgDetailCount[k]! > 2) otherPlaying = 1;
    }
    if (otherPlaying === 0) return 0;
    let finished = 0;
    for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
      if (this.m_abDeleted[k] === 2 || this.m_abDeleted[k] === 6) finished++;
    }
    return finished === expected ? 1 : 0;
  }

  /**
   * CGameSession::GetGameDetailResult (41CA8C) — the winner slot's detail
   * byte: 3 when the slot's user carries the premium ticket, 1 when
   * +12240[n8] == +12048[n8] (both > 2), 2 when +12208[n8] == +12016[n8] + 1
   * (both > 2).  Those counters are never written in FXGS, so the practical
   * result is premium ? 3 : 0.
   */
  GetGameDetailResult(n8: number): number {
    let result = 0;
    if (this.m_rgPlayer[n8]?.m_fPremiumTicket === 1) result = 3;
    const a = this.m_rgWinDetailA[n8]!; // [+12240+4n8]
    if (a > 2 && a === this.m_rgWinDetailB[n8]!) {
      // [+12048+4n8]
      result = 1;
      const c = this.m_rgDetailCount[n8]!; // [+12208+4n8]
      if (c > 2 && c === this.m_rgColourCount[n8]! + 1) return 2;
    }
    return result;
  }

  /**
   * CGameSession::SendGameResult (vtbl+216, :36660) — the results unit.
   * Head [E1 flag][E1 winTeam][E1 view-type][E1 ladder][E1 diff-team item
   * flag]; per user [E1 1][E4 serial] then [E1 result][E1 +12048][E1 +12016]
   * [E2 exp‰][E2 exp‰ re-read][E2 look-level][E1 got-exp][E1 detail]; empty
   * slots send [E1 0].  IncDecExp feeds the DB dyn rows, IncWin/IncLose/
   * IncDraw the user counters, and level-ups re-sort the lobby rank list.
   */
  SendGameResult(winTeam: number): void {
    const packet = new CSendPacket(GS_ClientSend.OnGameResult, CipherDegree.kPacketEncryptedCRC8);
    const guildCalc = new CGuildDynInfoCalculator(); // the stack local at :36694
    const timeFactor = this.GetGameExpTimeFactor(); // v50 — the 41FE83 ladder
    let flag = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_abDeleted[i] === 5 || this.m_abDeleted[i] === 6 || this.m_abDeleted[i] === 7) flag = 1;
    }
    packet.Encode1(flag);
    packet.Encode1(winTeam & 0xff);
    packet.Encode1(this.m_pStrategy.GetResultViewType()); // strategy vtbl+44 (guild → 1)
    packet.Encode1(IS_LADDER_GAME); // session vtbl+156
    let diffTeamUsedItem = 0; // v47
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i] !== null && this.m_rgnUsedItem[i] !== 0 && (this.GetColor(i) & SLOTSTATE_COLOR_MASK) !== winTeam) diffTeamUsedItem = 1;
    }
    packet.Encode1(diffTeamUsedItem);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot]!;
      if (user === null) {
        packet.Encode1(0);
        continue;
      }
      packet.Encode1(1);
      packet.Encode4(user.GetGlobalSerialNo()); // [+1964]
      let expPct = CDynInfoCalculator.GetExpPercentage(user.dyn.exp); // [+212] before the rewards
      let gotExp = 0; // DrawExp
      let gained = 0; // value
      let detail = 0; // GameDetailResult
      this.m_dwPremiumFlag = user.m_fPremiumTicket === 1 ? 1 : 0; // [+12272]
      if (!CMainSystem.IsPremiumChannel() && user.m_fPremiumTicket === 1) detail = 3;
      let result: number; // n3
      if (winTeam === -1) {
        result = 3;
        if (this.m_fSkipExpReward === 0) {
          const exp = this.m_DynInfoCalculator.GetDrawExp(slot);
          gained = Math.trunc(exp * timeFactor);
          gotExp = user.IncDecExp(gained) > 0 ? 1 : 0;
          user.IncDraw(); // vtbl+180 (UserIncDraw)
          if (CMainSystem.ms_pInstance!.m_nChannelType === ACCOUNTING_LOG_CHANNEL_TYPE) console.error(`${user.GetName()}:D:${gained}`);
        }
      } else if ((this.GetColor(slot) & SLOTSTATE_COLOR_MASK) === winTeam) {
        result = this.GetWinGameResult(slot);
        if (this.m_fSkipExpReward === 0) {
          let boost = 1.0; // v49
          if (diffTeamUsedItem !== 0) boost = 1.05;
          if (this.m_rgDetailCount[slot]! >= 2) {
            let premiumWinners = 0;
            for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
              const w = this.m_rgPlayer[k]!;
              if (w !== null && (this.GetColor(k) & SLOTSTATE_COLOR_MASK) === winTeam && w.m_fPremiumTicket === 1) premiumWinners++;
            }
            if (premiumWinners >= 2) boost += 0.1;
          }
          const rewardFlag = [0]; // v45 — GetWinExp only zeroes it, so the big-luck branch stays dead in FXGS
          const exp = this.m_DynInfoCalculator.GetWinExp(slot, rewardFlag);
          gained = Math.trunc(exp * timeFactor * boost);
          gotExp = user.IncDecExp(gained) > 0 ? 1 : 0;
          detail = this.GetGameDetailResult(slot);
          user.IncWin(); // vtbl+172 (UserIncWin)
          if (CMainSystem.ms_pInstance!.m_nChannelType === ACCOUNTING_LOG_CHANNEL_TYPE) console.error(`${user.GetName()}:W:${gained}`);
          if (rewardFlag[0] !== 0) this.SendBigLuckMsg(STR_BIG_LUCK_MSG.replace("%s", user.GetName()));
        }
      } else {
        result = 2;
        if (this.m_fSkipExpReward === 0) {
          const exp = this.m_DynInfoCalculator.GetKillNSaveExp(slot);
          gained = Math.trunc(exp * timeFactor);
          gotExp = user.IncDecExp(gained) > 0 ? 1 : 0;
          user.IncLose(); // vtbl+176 (UserIncLose)
          if (CMainSystem.ms_pInstance!.m_nChannelType === ACCOUNTING_LOG_CHANNEL_TYPE) console.error(`${user.GetName()}:L:${gained}`);
        }
      }
      const pctNow = CDynInfoCalculator.GetExpPercentage(user.dyn.exp); // re-read after the rewards
      if (expPct > pctNow) expPct = 0;
      if (detail === 3 && gained === 0) detail = 0;
      packet.Encode1(result);
      packet.Encode1(this.m_rgWinDetailB[slot]!); // [+12048+4slot]
      packet.Encode1(this.m_rgColourCount[slot]!); // [+12016+4slot]
      packet.Encode2(expPct);
      packet.Encode2(pctNow);
      packet.Encode2(user.GetLookLevel());
      packet.Encode1(gotExp);
      packet.Encode1(detail);
      if (gotExp !== 0) CChannelPool.ms_pInstance!.UpdateRankList(user);
      this.m_pStrategy.SetGameResultPlayer(guildCalc, slot, gained, result); // vtbl+40 (:36841)
    }
    this.m_pStrategy.OnGameResult(guildCalc); // vtbl+36 (:36858)
    this.SendPacket(packet);
  }

  /** CGameSession::SendBigLuckMsg (:36478) — packet 10 [EStr] through the
   *  center link; CLocalServerMan::OnSystemMsg rebroadcasts it as CM 13. */
  SendBigLuckMsg(strMsg: string): void {
    const packet = new CSendPacket(MC_ReceivedPacket.OnSystemMsg);
    packet.EncodeStr(strMsg);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }


  /** SendGameResult's time factor (the 41FE83 ladder). */
  private GetGameExpTimeFactor(): number {
    const elapsed = this.m_GameClock.ElapsedTime();
    if (elapsed < 15000) return 0.0;
    if (elapsed <= 45000) return (elapsed - 15000) / 30000.0;
    return 1.0;
  }

  /** CGameSessionTable::CloseSession's empty check lives on +832. */
  IsEmpty(): boolean {
    return this.m_nCurPlayerNum === 0;
  }

  /**
   * [this+852] — the vtbl+20 override marker DeferBanChief reads before its
   * chief probe (CGameSession::DumpLog prints the room header in FXGS).
   */
  vtblHasDumpLog(): number {
    return 0;
  }

  // ---- ready / map / color / bomber / slots (the 96..111 handlers) ----

  /**
   * CGameSession::OnSetPlayerReady — the *members'* ready toggle
   * (FxServer.exe.c:35201).  The body runs only when the sender is NOT the
   * chief's socket: the chief has no ready state of his own (he starts the
   * game), and a chief-sent 96 is silently ignored.
   */
  OnSetPlayerReady(n: CReceivedPacket, socket: CClientSocket): void {
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot >= MAX_SESSION_SLOTS) return;
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (!chiefUser || chiefUser.m_pSocket === socket) return;
    const sender = socket.GetUser(0);
    if (!sender || sender.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    if (b !== 1 && b !== 0) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: set player ready packet out of range.`);
      socket.PostClosePacket();
      return;
    }
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const user = socket.GetUser(i);
      if (!user) {
        console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: null user sent set player ready packet.`);
        socket.PostClosePacket();
        return;
      }
      const slot = this.GetSlotidx(user);
      if (slot >= MAX_SESSION_SLOTS) {
        console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: non-valid player sent set player ready packet.`);
        socket.PostClosePacket();
        return;
      }
      const p = slot * 3;
      if (b !== 0) {
        if ((this.m_rgSlotState[p]! & SLOTSTATE_GROUP_MASK) !== 0) {
          console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: set player ready packet [${b}] doesn't sync. Don't disconnect.`);
          return;
        }
        this.m_rgSlotState[p] = (this.m_rgSlotState[p]! & SLOTSTATE_GROUP_CLEAR) | SLOTSTATE_READY;
      } else {
        if ((this.m_rgSlotState[p]! & SLOTSTATE_GROUP_MASK) !== SLOTSTATE_READY) {
          console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: set player ready packet [${b}] doesn't sync. Don't disconnect.`);
          return;
        }
        this.m_rgSlotState[p] = this.m_rgSlotState[p]! & SLOTSTATE_GROUP_CLEAR;
      }
      this.MakeSetSlotStatePacket(slot, packet);
      this.PutPacket(packet);
    }
    this.FlushPacket();
  }

  /** CGameSession::OnSelectMap (FxServer.exe.c:33211). */
  OnSelectMap(n: CReceivedPacket, socket: CClientSocket): void {
    const mapIdx = n.Decode2() | 0;
    if (this.m_fPlaying === 0) {
      this.m_fModified |= 2;
      this.m_nMapIdx = mapIdx;
    }
    const packet = new CSendPacket(GS_ClientSend.OnSessionMapIdx, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(this.m_nMapIdx & 0xffff);
    this.PutPacket(packet);
    this.FlushPacket();
    if (this.m_fPlaying !== 0) return;
    // the team count of the chosen map (321 - mapIdx indexes m_apTheme)
    let teams: number;
    if (mapIdx === -1) teams = 8;
    else if (mapIdx >= 0) teams = CGameMapTmplList.ms_pInstance?.GetMapMaxTeam(mapIdx) ?? 0;
    else teams = CGameMapTmplList.ms_pInstance?.m_apTheme[THEME_IDX_BASE - mapIdx]?.m_nMaxTeam ?? 0;
    // The color -> target-color map (:33264).  memset(0xFF) leaves every
    // entry at -1 (untouched); each color actually in use gets the marker
    // 0x11111111 (286331153).  For team counts the fold switch does not
    // cover (5/6/7) the marker survives into the apply step, whose `& 0xff`
    // then yields the original's quirky 0x11 — kept verbatim.
    const colorMap = new Int32Array(8).fill(-1);
    let usedColors = 0;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.IsPlayerSet(slot) && colorMap[this.GetColor(slot)]! === -1) {
        usedColors++;
        colorMap[this.GetColor(slot)] = 0x11111111;
      }
    }
    const IN_USE = 0x11111111;
    if (teams < usedColors) {
      // round-robin re-assignment onto {0,3,5,6} for 2..4 team maps
      let k = 0;
      const teamColorPool = [0, 3, 5, 6];
      if (teams >= 2 && teams <= 4) {
        for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
          if (!this.IsPlayerSet(slot)) continue;
          const p = slot * 3 + 2;
          const want = teamColorPool[k % teams]!;
          this.m_rgSlotState[p] = (this.m_rgSlotState[p]! ^ (want ^ this.m_rgSlotState[p]!)) & SLOTSTATE_COLOR_MASK;
          k++;
          const sp = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
          this.MakeSetSlotStatePacket(slot, sp);
          this.PutPacket(sp);
        }
      }
    } else {
      switch (teams) {
        case 2:
          if (colorMap[0] === IN_USE) colorMap[0] = 0;
          if (colorMap[3] === IN_USE) colorMap[3] = 3;
          for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
            if (colorMap[i] === IN_USE) {
              if (colorMap[0] !== 0) {
                colorMap[i] = 0;
                colorMap[0] = 0;
              } else if (colorMap[3] !== 3) {
                colorMap[i] = 3;
                colorMap[3] = 3;
              }
            }
          }
          break;
        case 3:
          if (colorMap[0] === IN_USE) colorMap[0] = 0;
          if (colorMap[3] === IN_USE) colorMap[3] = 3;
          if (colorMap[5] === IN_USE) colorMap[5] = 5;
          for (let j = 0; j < MAX_SESSION_SLOTS; j++) {
            if (colorMap[j] === IN_USE) {
              if (colorMap[0] !== 0) {
                colorMap[j] = 0;
                colorMap[0] = 0;
              } else if (colorMap[3] === 3) {
                if (colorMap[5] !== 5) {
                  colorMap[j] = 5;
                  colorMap[5] = 5;
                }
              } else {
                colorMap[j] = 3;
                colorMap[3] = 3;
              }
            }
          }
          break;
        case 4:
          if (colorMap[0] === IN_USE) colorMap[0] = 0;
          if (colorMap[3] === IN_USE) colorMap[3] = 3;
          if (colorMap[5] === IN_USE) colorMap[5] = 5;
          if (colorMap[6] === IN_USE) colorMap[6] = 6;
          for (let m = 0; m < MAX_SESSION_SLOTS; m++) {
            if (colorMap[m] === IN_USE) {
              if (colorMap[0] !== 0) {
                colorMap[m] = 0;
                colorMap[0] = 0;
              } else if (colorMap[3] === 3) {
                if (colorMap[5] === 5) {
                  if (colorMap[6] !== 6) {
                    colorMap[m] = 6;
                    colorMap[6] = 6;
                  }
                } else {
                  colorMap[m] = 5;
                  colorMap[5] = 5;
                }
              } else {
                colorMap[m] = 3;
                colorMap[3] = 3;
              }
            }
          }
          break;
        case 8:
          for (let k = 0; k < MAX_SESSION_SLOTS; k++) colorMap[k] = k;
          break;
        default:
          break;
      }
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        if (!this.IsPlayerSet(slot)) continue;
        const p = slot * 3 + 2;
        const want = colorMap[this.GetColor(slot)]! & 0xff;
        this.m_rgSlotState[p] = (this.m_rgSlotState[p]! ^ (want ^ this.m_rgSlotState[p]!)) & SLOTSTATE_COLOR_MASK;
        const sp = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
        this.MakeSetSlotStatePacket(slot, sp);
        this.PutPacket(sp);
      }
    }
    this.FlushPacket();
  }

  /** CBaseSession::OnSelectColor — 98 → 108 (FxServer.exe.c:30993). */
  OnSelectColor(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const selfIdx = b >> 4;
    const colorIdx = b & 0xf;
    const target = socket.GetUser(selfIdx);
    const slot = this.GetSlotidx(target);
    if (selfIdx < 0 || selfIdx >= socket.GetUserCount()) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: selfidx is out of range.`);
      socket.PostClosePacket();
      return;
    }
    if (colorIdx >= MAX_SESSION_SLOTS) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: coloridx is out of range.`);
      socket.PostClosePacket();
      return;
    }
    if (slot >= 0 && slot < this.m_nMaxSlot) {
      this.SetColor(slot, colorIdx); // DoSelectColor
      const packet = new CSendPacket(GS_ClientSend.OnSelectColorRes, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(((slot << 4) | (colorIdx & 0xf)) & 0xff);
      this.SendPacket(packet);
      return;
    }
    console.error(`[GS] Invalid slot idx (OnSelectColor). Disconnect [${GetInfoStr(socket)}].`);
    socket.PostClosePacket();
  }

  /** CListSession::OnSelectBomber → CBaseSession::OnSelectBomber — 99 → 109. */
  OnSelectBomber(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying !== 0) return;
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const selfIdx = b >> 4;
    const bomberIdx = b & 0xf;
    const target = socket.GetUser(selfIdx);
    const slot = this.GetSlotidx(target);
    if (selfIdx < 0 || selfIdx >= socket.GetUserCount()) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: selfidx is out of range(OnSelectBomber).`);
      socket.PostClosePacket();
      return;
    }
    const attr = CBomberAttr.ms_pInstance!;
    if (bomberIdx < attr.GetNormalCount() || bomberIdx === attr.GetTotalCount()) {
      if (slot >= 0 && slot < this.m_nMaxSlot) {
        const p = slot * 3 + 1;
        this.m_rgSlotState[p] = (this.m_rgSlotState[p]! ^ ((bomberIdx ^ this.m_rgSlotState[p]!) & SLOTSTATE_BOMBER_MASK));
        const packet = new CSendPacket(GS_ClientSend.OnSelectBomberRes, CipherDegree.kPacketEncryptedCRC8);
        packet.Encode1(((slot << 4) | (bomberIdx & 0xf)) & 0xff);
        this.SendPacket(packet);
        return;
      }
      console.error(`[GS] Invalid slot idx (OnSelectBomber). Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: bomberidx is out of range(OnSelectBomber).`);
    socket.PostClosePacket();
  }

  /** CListSession::OnOpenCloseSlot — 100 (chief only, FxServer.exe.c:40725). */
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
    const close = (b & 0xf) !== 0 ? 1 : 0;
    if (slot >= 0 && slot < this.m_nMaxSlot) {
      this.DoOpenCloseSlot(slot, close);
      return;
    }
    console.error(`[GS] Invalid slot idx (OnOpenCloseSlot). Disconnect [${GetInfoStr(socket)}].`);
    socket.PostClosePacket();
  }

  /** CGameSession::OnSetGameTypeNormal — 102 → 93. */
  OnSetGameTypeNormal(socket: CClientSocket): void {
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot >= MAX_SESSION_SLOTS) {
      console.error("[GS] No chief exists but player request to set game type");
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (chiefUser && chiefUser.m_pSocket === socket) this.SendGameTypeNormal();
    else console.error("[GS] Non-chief player request to set game type");
  }

  /** CGameSession::OnSetGameTypeMod — 103 → 92. */
  OnSetGameTypeMod(socket: CClientSocket): void {
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot >= MAX_SESSION_SLOTS) {
      console.error("[GS] No chief exists but player request to set game type");
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (chiefUser && chiefUser.m_pSocket === socket) this.SendGameTypeMod();
    else console.error("[GS] Non-chief player request to set game type");
  }

  /** CGameSession::SendGameTypeNormal — +948 = 0, packet 93. */
  SendGameTypeNormal(): void {
    this.m_nGameTypeMod = 0;
    this.SendPacket(new CSendPacket(GS_ClientSend.OnGameTypeNormal, CipherDegree.kPacketEncryptedCRC8));
  }

  /** CGameSession::SendGameTypeMod — +948 = 1, packet 92. */
  SendGameTypeMod(): void {
    this.m_nGameTypeMod = 1;
    this.SendPacket(new CSendPacket(GS_ClientSend.OnGameTypeMod, CipherDegree.kPacketEncryptedCRC8));
  }

  /** CGameSession::SendGameType — the join tail (92 or 93). */
  SendGameType(socket: CClientSocket): void {
    socket.SendPacket(new CSendPacket(this.m_nGameTypeMod !== 0 ? GS_ClientSend.OnGameTypeMod : GS_ClientSend.OnGameTypeNormal, CipherDegree.kPacketEncryptedCRC8));
  }

  // ---- ban votes (104/105 → 113/114) ----

  /** CListSession::OnHostAskBanPlayer (FxServer.exe.c:41110). */
  OnHostAskBanPlayer(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot < 0 || chiefSlot >= this.m_nMaxSlot) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: Non-chief player ask ban player (there is no chief player exists)`);
      socket.PostClosePacket();
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot]!;
    if (!chiefUser || chiefUser.m_pSocket !== socket) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: Non-chief player ask ban player`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_nBanSerial !== 0) {
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(1);
      socket.SendPacket(p);
      return;
    }
    const serial = n.Decode4();
    const superFlag = n.Decode1();
    let slot = this.GetSlotidxFromSerialNo(serial);
    if (socket.GetSelfidxFromSerialNo(serial) !== -1) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: Chief player ask ban himself`);
      socket.PostClosePacket();
      return;
    }
    // the target's users record 0, everyone else 1 (asked)
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      const u = this.m_rgPlayer[i];
      if (u && u.GetGlobalSerialNo() === serial) {
        this.m_rgVote[i] = 0;
        slot = i;
      } else {
        this.m_rgVote[i] = 1;
      }
    }
    if (slot === -1) {
      this.m_nBanSerial = 0;
      return;
    }
    const targetUser = this.m_rgPlayer[slot]!;
    if (superFlag !== 0 || CClientSocket.HasAuthority(21) !== 0) {
      // a super chief (Item/SuperChief) or an operator kicks outright
      let hasSuper = false;
      for (const u of socket.m_apUser) {
        if (u && u.HasFunctionalItem("Item/SuperChief")) {
          hasSuper = true;
          break;
        }
      }
      if (hasSuper || CClientSocket.HasAuthority(21) !== 0) {
        this.m_nBanSerial = 0;
        const targetSocket = targetUser.m_pSocket!;
        this.MoveToExchangeSession(targetSocket);
        const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(4);
        this.SendPacket(p);
        return;
      }
    }
    // Item/BanReflex bounces the ban onto the chief
    let reflex = false;
    for (const u of targetUser.m_pSocket?.m_apUser ?? []) {
      if (u && u.HasFunctionalItem("Item/BanReflex")) {
        reflex = true;
        break;
      }
    }
    if (reflex) {
      this.m_nBanSerial = 0;
      const chief = this.m_rgPlayer[this.m_nChiefSlotidx]!;
      const chiefSocket = chief.m_pSocket!;
      this.MoveToExchangeSession(chiefSocket);
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(5);
      p.EncodeStr(chief.GetName());
      this.SendPacket(p);
      return;
    }
    // start the vote: the chief is a yes, the ask goes to the rest
    for (const u of targetUser.m_pSocket?.m_apUser ?? []) {
      const s = this.GetSlotidx(u);
      if (s >= 0) this.m_rgVote[s] = 0;
    }
    this.m_nBanSerial = serial;
    for (const u of socket.m_apUser) {
      const s = this.GetSlotidx(u);
      if (s >= 0) this.m_rgVote[s] = 2;
    }
    this.DeferBanPlayer();
    if (this.m_nBanSerial !== 0) {
      const ask = new CSendPacket(GS_ClientSend.OnBanVoteRequest, CipherDegree.kPacketEncryptedCRC8);
      ask.Encode4(serial);
      ask.EncodeStr(targetUser.GetName());
      const chiefSocket = chiefUser.m_pSocket!;
      const targetSocket = targetUser.m_pSocket!;
      const sent = new Set<CClientSocket>();
      for (const u of this.m_rgPlayer) {
        if (!u || u === chiefUser) continue;
        if (u.GetGlobalSerialNo() === serial) continue;
        const member = u.m_pSocket;
        if (!member || member === targetSocket || member === chiefSocket) continue;
        if (sent.has(member)) continue;
        sent.add(member);
        member.SendPacket(ask);
      }
      const res = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      res.Encode1(0);
      socket.SendPacket(res);
    }
  }

  /** The MoveToExchangeSession stub — FXGS only logs and retags the socket. */
  MoveToExchangeSession(socket: CClientSocket): void {
    console.error("[GS] CBaseSessionTable::MoveToExchangeSession(CClientSocket* pSocket1, CClientSocket* pSocket2)");
    void socket;
  }

  /** CListSession::GetSlotidxFromSerialNo. */
  GetSlotidxFromSerialNo(serial: number): number {
    return this.m_rgPlayer.findIndex((u) => u && u.GetGlobalSerialNo() === serial);
  }

  /** CListSession::OnRespondToBanPlayer — 105 (FxServer.exe.c:40232+). */
  OnRespondToBanPlayer(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_nBanSerial === 0 || this.m_nBanSerial !== (n.Decode4() >>> 0)) return;
    const yes = n.Decode1();
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const slot = this.GetSlotidx(socket.GetUser(i));
      if (this.m_rgVote[slot] !== 1) break;
      this.m_rgVote[slot] = yes !== 0 ? 2 : 3;
    }
    this.DeferBanPlayer();
  }

  /** CListSession::DeferBanPlayer (vtbl+144) — count and apply the votes. */
  DeferBanPlayer(): void {
    let targetSlot = -1;
    let total = 0;
    let yes = 0;
    let no = 0;
    for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user) continue;
      if (user.GetGlobalSerialNo() === this.m_nBanSerial) targetSlot = slot;
      const vote = this.m_rgVote[slot]!;
      if (vote !== 0) {
        total++;
        if (vote === 2) yes++;
        else if (vote === 3) no++;
      }
    }
    if (targetSlot === -1) {
      this.m_nBanSerial = 0;
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(4);
      this.SendPacket(p);
      return;
    }
    if (2 * yes > total) {
      // banned by majority
      this.m_nBanSerial = 0;
      const target = this.m_rgPlayer[targetSlot]!;
      const targetSocket = target.m_pSocket!;
      this.MoveToExchangeSession(targetSocket);
      targetSocket.m_nPoolType = 4;
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(2);
      p.EncodeStr(target.GetName());
      this.SendPacket(p);
      return;
    }
    if (2 * no >= total || yes + no >= total) {
      this.m_nBanSerial = 0;
      const target = this.m_rgPlayer[targetSlot]!;
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(3);
      p.EncodeStr(target.GetName());
      this.SendPacket(p);
    }
  }

  // ---- title / emotion / team chat ----

  /** CBaseSession::OnRequestChangeTitle — 107 (FxServer.exe.c:41978A). */
  OnRequestChangeTitle(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.CanRequestChangeTitle(socket)) {
      let title = n.DecodeStr();
      if (title.length > 0x16) title = title.slice(0, 21);
      this.DoChangeTitle(title);
    } else {
      console.error("[GS] !this->CanRequestChangeTitle(pSocket), CBaseSession::CanRequestChangeTitle");
    }
  }

  /** CBaseSession::OnPlayEmotion — 108 → 118 minus the sender. */
  OnPlayEmotion(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const a = n.Decode1();
    const b = n.Decode1();
    const c = n.Decode2();
    const user = this.m_rgPlayer[slot];
    if (user && user.m_pSocket === socket) {
      const packet = new CSendPacket(GS_ClientSend.OnPlayEmotion, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(slot);
      packet.Encode1(a);
      packet.Encode1(b);
      packet.Encode2(c);
      this.SendPacketExclude(packet, socket);
    } else {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
    }
  }

  /** CListSession::OnTeamChat — 111 → 27 to the same color (424251E0). */
  OnTeamChat(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    if (socket.GetUserCount() !== 1) {
      console.error(`[GS] 2 Player requested Team Chat, NOT ALLOWED![${GetInfoStr(socket)}]`);
      return;
    }
    if (msg.length + user0.GetName().length + 10 > 0x400) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const text = `${user0.GetName()} : ${msg}`;
    const packet = new CSendPacket(GS_ClientSend.OnWhisperRes, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(text);
    const slot = this.GetSlotidx(user0);
    const color = this.GetColor(slot);
    for (let s = 0; s < MAX_SESSION_SLOTS; s++) {
      const other = this.m_rgPlayer[s];
      if (other && s !== slot && this.GetColor(s) === color) {
        other.m_pSocket?.SendPacket(packet);
      }
    }
  }

  // ---- starting the game (106 → 115/116) ----

  /** CGameSession::CanStartGame (FxServer.exe.c:41C805) — 0 = go. */
  CanStartGame(fNeedMap: number): number {
    const counts = new Int32Array(8);
    let players = 0;
    let teams = 0;
    const chiefSlot = this.m_nChiefSlotidx;
    const chiefUser = chiefSlot < MAX_SESSION_SLOTS ? this.m_rgPlayer[chiefSlot] : null;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user || CClientSocket.HasAuthority(25) !== 0) continue;
      const state0 = this.m_rgSlotState[slot * 3]!;
      const state1 = this.m_rgSlotState[slot * 3 + 1]!;
      if (++counts[this.GetColor(slot)]! === 1) teams++;
      players++;
      if (chiefUser && chiefUser.m_pSocket === user.m_pSocket) {
        if ((state0 & SLOTSTATE_GROUP_MASK) !== 0) {
          console.error(`[GS] Chief Player is not stand-by, but [${(state0 >> 2) & 7}].`);
          return 2;
        }
      } else if ((state0 & SLOTSTATE_CHIEF) === 0 && (state0 & SLOTSTATE_GROUP_MASK) !== 4) {
        return 2;
      }
      void state1;
    }
    if (this.m_nGameType !== 0) {
      for (let c = 0; c < MAX_SESSION_SLOTS; c++) {
        if (counts[c] !== 0 && counts[c] !== Math.floor(players / teams)) return 6;
      }
    }
    const total = players; // GetExtraPlayerNo() == 0
    const totalTeams = teams; // GetExtraTeamNo() == 0
    if (total < 2) return 3;
    if (totalTeams < 2) return 5;
    const mapIdx = this.m_nGameMapIdx;
    const list = CGameMapTmplList.ms_pInstance!;
    if (mapIdx >= 0) {
      if (total > list.GetMapMaxPlayer(mapIdx)) return 4;
      if (chiefUser) {
        if (CClientSocket.HasAuthority(23) !== 0) return 0;
        if (!CMainSystem.IsPremiumChannel() && chiefUser.m_fPremiumTicket !== 1 && list.GetMapPremiumOnly(mapIdx) === 1) return 7;
        if (chiefUser.m_nLevel >= list.GetMapLevelLimit(mapIdx)) return 0; // chief level (dword +496), not exp
      } else {
        return 0;
      }
    } else if (fNeedMap !== 0) {
      return 0;
    }
    return 1;
  }

  /** CGameSession::SetMapIdxPlayingByLevel (FxServer.exe.c:41C9C4). */
  SetMapIdxPlayingByLevel(level: number, gm: number, premiumTicket: number): void {
    let mapIdx = this.m_nMapIdx;
    if (mapIdx === -1) {
      mapIdx = CGameMapTmplList.ms_pInstance!.GetRandomMapIdx(this.m_nCurPlayerNum, level, -1, 0, gm, premiumTicket);
    } else if (mapIdx < 0) {
      mapIdx = CGameMapTmplList.ms_pInstance!.GetRandomMapIdx(this.m_nCurPlayerNum, level, -2 - mapIdx, 0, gm, premiumTicket);
    }
    this.m_nGameMapIdx = mapIdx;
  }

  /** CGameSession::CheckIsCaptain — the highest exp of a color (mod mode). */
  CheckIsCaptain(slot: number): number {
    const user = this.m_rgPlayer[slot];
    if (!user) {
      this.m_abCaptain[slot] = 1;
      return 1;
    }
    const exp = user.dyn.exp;
    const color = this.GetColor(slot);
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      const other = this.m_rgPlayer[i];
      if (other && color === this.GetColor(i) && exp < other.dyn.exp) {
        this.m_abCaptain[slot] = 0;
        return 0;
      }
    }
    this.m_abCaptain[slot] = 1;
    return 1;
  }

  /** CGameSession::OnBomberDie — the captain falls and the team follows (mod mode, 41BFAB). */
  OnBomberDie(slot: number): void {
    if (slot < 0 || slot >= MAX_SESSION_SLOTS) return;
    const user = this.m_rgPlayer[slot];
    if (!user || this.m_nGameTypeMod === 0 || this.m_abCaptain[slot] === 0) return;
    const exp = user.dyn.exp;
    const color = this.GetColor(slot);
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      const other = this.m_rgPlayer[i];
      if (other && color === this.GetColor(i) && exp < other.dyn.exp) return;
    }
    let n = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      const other = this.m_rgPlayer[i];
      if (other && i !== slot && color === this.GetColor(i)) {
        const code = this.m_abDeleted[i]!;
        if (code === 0 || code === 3) n++;
      }
    }
    if (n > 0) {
      const packet = new CSendPacket(GS_ClientSend.OnBomberEvent, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(80);
      packet.Encode2(0);
      packet.Encode2(0);
      packet.Encode1(n);
      for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
        const other = this.m_rgPlayer[i];
        if (!other || i === slot || color !== this.GetColor(i)) continue;
        const code = this.m_abDeleted[i]!;
        if (code === 0 || code === 3) {
          packet.Encode1(i);
          packet.Encode2(DEATH_COORD);
          packet.Encode2(DEATH_COORD);
          this.m_abDeleted[i] = 1;
        }
      }
      this.PutPacket(packet, null);
      this.FlushPacket();
    }
  }

  /**
   * CGameSession::SendAirplaneItemProb (FxServer.exe.c:36914) — packet 173.
   * The head is [E4 +12776][E4 +12780]; the IsLadderGame (vtbl+156) clamp
   * (over 30000 → 30000) is dead code because IsLadderGame is the
   * constant-0 stub (FxServer.exe.c:37120).  The body then reads
   * iteminfo.txt from the working directory at send time — two lists of
   * "name prob" lines with the names resolved through
   * CItemAttr::GetItemidx.  MissionInfo[0] (+12748 ← tmpl+108) picking
   * list two (the mission/kart drops), anything else list one (the
   * airplane drops).  A missing file sends nothing at all: the whole
   * SendPacket sits inside the fopen-null check.
   */
  SendAirplaneItemProb(): void {
    const packet = new CSendPacket(GS_ClientSend.OnAirplaneItemProb, CipherDegree.kPacketEncryptedCRC8);
    if (this.IsLadderGame() !== 0 && this.m_dwAirplaneItemProb > 30000) packet.Encode4(30000);
    else packet.Encode4(this.m_dwAirplaneItemProb >>> 0);
    packet.Encode4(this.m_dwArg76 >>> 0);
    // fopen("iteminfo.txt", "r") — whitespace-split "%s %d" pairs, two
    // lists, each headed by its count
    let text: string;
    try {
      text = readFileSync("iteminfo.txt", "latin1");
    } catch {
      return; // fopen null — no packet leaves the server
    }
    const tokens = text.split(/\s+/).filter((t) => t.length > 0);
    let pos = 0;
    const readList = (): { idx: number; prob: number }[] => {
      const count = parseInt(tokens[pos++]!, 10) | 0;
      const list: { idx: number; prob: number }[] = [];
      for (let i = 0; i < count; i++) {
        const name = tokens[pos++] ?? "";
        const prob = parseInt(tokens[pos++] ?? "0", 10) | 0;
        list.push({ idx: CItemAttr.ms_pInstance?.GetItemidx(name) ?? -1, prob });
      }
      return list;
    };
    const airplane = readList();
    const mission = readList();
    const list = this.m_MissionInfo[0] === 1 ? mission : airplane;
    packet.Encode1(list.length);
    for (const entry of list) {
      packet.Encode1(entry.idx & 0xff); // (unsigned __int8) of the idx dword
      packet.Encode1(entry.prob & 0xff);
    }
    this.SendPacket(packet);
  }
  /** CGameSession::IsLadderGame (vtbl+156, FxServer.exe.c:37120) — the
   *  constant-0 stub (`xor eax,eax`) in this build. */
  IsLadderGame(): number {
    return IS_LADDER_GAME;
  }

  /** CGameSession::LaunchGameStage — packet 116 (FxServer.exe.c:37254). */
  LaunchGameStage(): void {
    const packet = new CSendPacket(GS_ClientSend.OnStartGame, CipherDegree.kPacketEncryptedCRC8);
    // DoLaunchGameStageEx is an empty `retn` in the original
    packet.Encode4(Date.now() & TICK_U32_MASK);
    // the map idx rides through vtbl+24 = Encode2 (FxServer.exe.c:37289:
    // +28 E4 tick / +24 E2 mapIdx / +20 E1 cur) — an E4 here makes the
    // client read a garbage map index and crash on load
    packet.Encode2(this.m_nGameMapIdx & 0xffff);
    packet.Encode1(this.m_nCurPlayerNum); // +832 — GetPlayerNo(), not the max
    const tmpl = CGameMapTmplList.ms_pInstance!.m_apGameMapTmpl[this.m_nGameMapIdx];
    const spawns = Math.min(tmpl ? tmpl.m_nMaxPlayer : 8, 8);
    const order: number[] = [];
    for (let i = 0; i < spawns; i++) order.push(i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    let next = 0;
    const attr = CBomberAttr.ms_pInstance!;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      this.m_aBomberIdx[slot] = -1;
      if (!this.IsPlayerSet(slot)) continue;
      let bomber = this.GetBomber(slot);
      if (bomber === attr.GetTotalCount() && attr.GetNormalCount() > 0) {
        if (Math.floor(Math.random() * 30) !== 0) {
          bomber = Math.floor(Math.random() * attr.GetNormalCount());
        } else {
          bomber = attr.GetNormalCount() + (Math.floor(Math.random() * 3) !== 0 ? 1 : 0);
        }
      }
      this.m_aBomberIdx[slot] = bomber;
      packet.Encode1(slot);
      if (this.m_nGameTypeMod !== 0) packet.Encode1(this.CheckIsCaptain(slot));
      else packet.Encode1(0);
      packet.Encode1(order[next++] ?? 0);
      packet.Encode1(bomber);
      packet.Encode1(this.GetColor(slot));
    }
    this.SendPacket(packet);
    // CDynInfoCalculator::Init(+11684) — the results-unit weights (m_rgPlayer,
    // and the slot-state triples whose +2 byte holds the colour)
    this.m_DynInfoCalculator.Init(this.m_rgPlayer, this.m_rgSlotState);
    this.m_UdpLossRegulator.Init();
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) this.m_abDeleted[slot] = this.IsPlayerSet(slot) ? 0 : 1;
    this.SetPlaying(1);
    // SetCurrentGameContext(0) + CGameContext::Init
    this.m_pCtx.Init();
    this.m_rgnUsedItem.fill(0); // memset(+11652, 0, 0x20)
    this.m_abDeleted.fill(0);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) this.m_abDeleted[slot] = this.IsPlayerSet(slot) ? 0 : 1;
    this.m_rgSlotGhost.fill(-1); // memset(+872, -1, 0x20)
    this.m_rgGhostSlot.fill(-1); // memset(+904, -1, 0x20)
    this.m_nGhostCount = 0; // +936
    this.m_dwLastGhostTime = 0; // +940
    this.m_dwLaunchTime = Date.now() & TICK_U32_MASK;
    this.m_nGhostStart = tmpl ? tmpl.m_nArg60 : 0; // +12560 ← tmpl+60 (seconds; ×1000 at DoStartGame)
    this.m_nGhostFreq = tmpl ? tmpl.m_nArg64 : 0; // +12564 ← tmpl+64
    this.m_dwAirplaneItemProb = tmpl ? tmpl.m_dwAirplaneItemProb : 0; // +12776 ← tmpl+72
    this.m_dwArg76 = tmpl ? tmpl.m_dwArg76 : 0; // +12780 ← tmpl+76
    // MissionInfo::operator= (+12748 ← tmpl+108..+120) — the server never
    // reads dwords 1..3 or the LapTileInfo vector copy back.
    for (let i = 0; i < 4; i++) this.m_MissionInfo[i] = tmpl ? [tmpl.m_nMissionType, tmpl.m_nLapTileCount, tmpl.m_nLapTime, tmpl.m_nLapBonus][i]! : 0;
    this.m_rgLapTime.fill(-1); // fill(_QWORD*)+12632..+12696 = -1 (the 8 {time,rank} pairs)
    this.m_rgLapRank.fill(-1);
    this.m_rgLapCount.fill(0); // +12696..+12727 = 0
    this.SendAirplaneItemProb();
  }

  /** CGameSession::OnRequestStartGame — 106 (FxServer.exe.c:37434). */
  OnRequestStartGame(_n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] [Hacking suspected:${GetInfoStr(socket)}] No chief player exists but tried to start game, ${chiefSlot}`);
      this.DoBangPok();
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (!chiefUser || chiefUser.m_pSocket !== socket) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: Non-chief player request to start game`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_fPlaying !== 0) return;
    // fold the sub colors (1,2,4,7) onto the main ones (0,3,5,6):
    // color -> target map, -1 = untouched (:37490); in-use colors are marked
    // with themselves, a claimed main is consumed by writing 0 into its slot
    const colorMap = new Int32Array(8).fill(-1);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.IsPlayerSet(slot) && colorMap[this.GetColor(slot)] === -1) colorMap[this.GetColor(slot)] = this.GetColor(slot);
    }
    const claimMain = (idx: number): void => {
      if (colorMap[0] === -1) {
        colorMap[idx] = 0;
        colorMap[0] = 0;
      } else if (colorMap[3] === -1) {
        colorMap[idx] = 3;
        colorMap[3] = 0;
      } else if (colorMap[5] === -1) {
        colorMap[idx] = 5;
        colorMap[5] = 0;
      } else if (colorMap[6] === -1) {
        colorMap[idx] = 6;
        colorMap[6] = 0;
      }
    };
    if (colorMap[1] !== -1) claimMain(1);
    if (colorMap[2] !== -1) claimMain(2);
    if (colorMap[4] !== -1) claimMain(4);
    if (colorMap[7] !== -1) claimMain(7);
    this.SetMapIdxPlayingByLevel(chiefUser.dyn.exp, CClientSocket.HasAuthority(23), chiefUser.m_fPremiumTicket);
    const can = this.CanStartGame(0);
    const res = new CSendPacket(GS_ClientSend.OnStartGameRes, CipherDegree.kPacketEncryptedCRC8);
    res.Encode1(can);
    socket.SendPacket(res);
    if (can !== 0) return;
    if (CGameMapTmplList.ms_pInstance!.GetMapMaxTeam(this.m_nGameMapIdx) < MAX_SESSION_SLOTS) {
      let changed = false;
      const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        if (!this.IsPlayerSet(slot)) continue;
        const want = colorMap[this.GetColor(slot)]!;
        if (this.GetColor(slot) !== want) {
          const p = slot * 3 + 2;
          this.m_rgSlotState[p] = (this.m_rgSlotState[p]! ^ (want ^ this.m_rgSlotState[p]!)) & SLOTSTATE_COLOR_MASK;
          changed = true;
          this.MakeSetSlotStatePacket(slot, packet);
          this.PutPacket(packet);
        }
      }
      if (changed) this.FlushPacket();
    }
    this.LaunchGameStage();
    // LaunchGameStageEx (vtbl+200) is an empty `retn`
  }

  /** CGameSession::OnHackingSuspected — 186 (FxServer.exe.c:36160). */
  OnHackingSuspected(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const slot = n.Decode1();
    const serial = n.Decode4();
    const code = n.Decode1();
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] Hacking suspected [${user0.GetName()}]: illegal slotidx (OnHackingSuspected)`);
      socket.PostClosePacket();
      return;
    }
    const target = this.m_rgPlayer[slot];
    if (!target || target.GetGlobalSerialNo() !== serial) return;
    const names = [
      "khcFailedGameContextSync",
      "kBombIgniteIllegalSlotidx",
      "kMovableBoxNotFound",
      "",
      "kEatObstacle",
      "khcSpecialItemWrong",
      "khcSpecialItemOverflow",
      "kSpecialItemShort",
    ];
    if (code === 3 || code === 8) return;
    if (code >= names.length) {
      console.error(`[GS] Hacking suspected [${user0.GetName()}]: illegal hacking code (OnHackingSuspected)`);
      const p = new CSendPacket(GS_ClientSend.OnHackingKick, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(slot);
      this.SendPacketExclude(p, socket);
      socket.ForceSendAndClose(p);
      return;
    }
    console.error(`[GS] [${user0.GetName()}] reported [${target.GetName()}] committed hacking (${names[code]}).`);
    if (target.m_pSocket === socket) {
      console.error(`[GS] Hacking suspected [${target.GetName()}] (${GetInfoStr(socket)}) by itself. Disconnect.`);
      const p = new CSendPacket(GS_ClientSend.OnHackingKick, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(slot);
      this.SendPacketExclude(p, socket);
      socket.ForceSendAndClose(p);
      return;
    }
    let reports = 0;
    let players = 0;
    const reporterSlot = this.GetSlotidx(user0);
    if (reporterSlot >= 0 && reporterSlot < MAX_SESSION_SLOTS) this.m_rgVoteMatrix[slot * 8 + reporterSlot] = 1;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i]) {
        players++;
        if (this.m_rgVoteMatrix[slot * 8 + i] !== 0) reports++;
      } else if (this.m_rgVoteMatrix[slot * 8 + i] !== 0) {
        console.error("[GS] Hacking Info Doesn't Sync");
        this.m_rgVoteMatrix[slot * 8 + i] = 0;
      }
    }
    if (reports < Math.floor(players / 2)) return;
    console.error(`[GS] Hacking suspected [${target.GetName()}] by major of the session. Disconnect.`);
    const p = new CSendPacket(GS_ClientSend.OnHackingKick, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(slot);
    this.SendPacketExclude(p, target.m_pSocket!);
    target.m_pSocket!.ForceSendAndClose(p);
  }

  // ==================== the in-play stage (CGameSession::OnPacket 140..162 / 185) ====================

  /** CGameSession::IsMySocket (vtbl+188) — m_rgPlayer[slot] lives on this socket. */
  IsMySocket(slot: number, socket: CClientSocket): number {
    return this.m_rgPlayer[slot]?.m_pSocket === socket ? 1 : 0;
  }

  /** CGameSession::IsSlotInThisSocket (vtbl+192). */
  IsSlotInThisSocket(slot: number, socket: CClientSocket): number {
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] illegal user request. - nIdx < 0 || nIdx >= kFxPlayerMaxNo, nIdx = ${slot}`);
      return 0;
    }
    const user = this.m_rgPlayer[slot];
    if (!user) {
      console.error("[GS] illegal user request. - m_rgPlayer == NULL");
      return 0;
    }
    if (user.GetSelfidx() < 0) {
      console.error("[GS] illegal user request. - Selfidx < 0");
      return 0;
    }
    if (user.m_pSocket === socket) return 1;
    console.error("[GS] illegal user request. - GetSocket() != pSocket");
    return 0;
  }

  /** CGameSession::OnBombIgnite (140, FxServer.exe.c:41E5AC). */
  OnBombIgnite(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    if (this.IsMySocket(slot, socket) === 0) {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const ctx = this.m_pCtx;
    if (ctx.m_nBombCount >= 150) {
      console.error(`[GS] Bomb array overflow. Disconnect user[${this.m_rgPlayer[slot]?.GetName()}] (${GetInfoStr(socket)})`);
      socket.PostClosePacket();
      return;
    }
    const pos = n.Decode1();
    const attr = n.Decode1();
    const bomb = {
      id: ctx.m_nBombIdCounter++,
      fMoving: 0,
      timer: 2800,
      x: pos >> 4,
      y: pos & 0xf,
      sub: attr & 0xf,
      fFlag16: attr & 0x40 ? 1 : 0,
    };
    ctx.m_rgBomb[ctx.m_nBombCount] = bomb;
    const packet = new CSendPacket(GS_ClientSend.OnBombIgniteRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slot);
    packet.Encode1(((pos >> 4) << 4) | (pos & 0xf));
    packet.Encode1(attr);
    packet.Encode2(bomb.id);
    this.SendPacket(packet);
    ctx.m_nBombCount++;
  }

  /** CGameSession::OnBombKickThrow (141, FxServer.exe.c:41E74E). */
  OnBombKickThrow(n: CReceivedPacket, socket: CClientSocket): void {
    const slotCode = n.Decode1();
    const slot = slotCode & 0xf;
    const bombId = n.Decode2();
    const pos = n.Decode1();
    if (this.IsMySocket(slot, socket) === 0) {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const ctx = this.m_pCtx;
    let idx = 0;
    while (idx < ctx.m_nBombCount && ctx.m_rgBomb[idx]!.id !== bombId) idx++;
    if (idx >= ctx.m_nBombCount) return;
    const bomb = ctx.m_rgBomb[idx]!;
    if (bomb.x !== pos >> 4 || bomb.y !== (pos & 0xf) || bomb.fMoving !== 0) return;
    const newPos = n.Decode1();
    bomb.x = newPos >> 4;
    bomb.y = newPos & 0xf;
    bomb.fMoving = 1;
    bomb.timer = n.Decode2();
    const packet = new CSendPacket(GS_ClientSend.OnBombKickThrowRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slotCode);
    packet.Encode2(bombId);
    packet.Encode1(((newPos >> 4) << 4) | (newPos & 0xf));
    this.SendPacket(packet);
  }

  /** CGameSession::OnSetBombTimer (142, FxServer.exe.c:32034) — a client shortens the fuse. */
  OnSetBombTimer(n: CReceivedPacket, _socket: CClientSocket): void {
    const bombId = n.Decode2();
    const pos = n.Decode1();
    const timer = n.Decode2();
    const ctx = this.m_pCtx;
    let idx = 0;
    while (idx < ctx.m_nBombCount && ctx.m_rgBomb[idx]!.id !== bombId) idx++;
    if (idx >= ctx.m_nBombCount) return;
    const bomb = ctx.m_rgBomb[idx]!;
    if (bomb.x !== pos >> 4 || bomb.y !== (pos & 0xf) || bomb.fMoving !== 0) return;
    if (bomb.timer > timer) bomb.timer = timer;
    bomb.fFlag16 = 0;
  }

  /** CGameSession::OnMovableBoxMove (143, FxServer.exe.c:32082) — a plain 4-byte relay. */
  OnMovableBoxMove(n: CReceivedPacket, _socket: CClientSocket): void {
    const a = n.Decode1();
    const b = n.Decode1();
    const c = n.Decode1();
    const d = n.Decode1();
    const packet = new CSendPacket(GS_ClientSend.OnMovableBoxMoveRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(a);
    packet.Encode1(b);
    packet.Encode1(c);
    packet.Encode1(d);
    this.SendPacket(packet);
  }

  /** CGameSession::OnRequestEatItem (144, FxServer.exe.c:41EA50). */
  OnRequestEatItem(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player requested to eat item. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const slot = n.Decode1();
    const box = n.Decode1();
    const item = n.Decode1();
    if (this.IsSlotInThisSocket(slot, socket) === 0) {
      console.error(`[GS] illegal user requested to eat item. disconnect [${user0.GetName()}].`);
      return;
    }
    const eater = this.m_rgPlayer[slot];
    if (slot >= MAX_SESSION_SLOTS) {
      console.error("[GS] player of invalid slotidx requested to eat item");
      socket.PostClosePacket();
      return;
    }
    if (box >= 250) {
      if (eater) console.error(`[GS] Invalid box idx from user[${eater.GetName()}], Disconnect player`);
      socket.PostClosePacket();
      return;
    }
    const itemAttr = CItemAttr.ms_pInstance!;
    if (item >= itemAttr.m_vtName.length) {
      if (eater) console.error(`[GS] Invalid item idx from user [${eater.GetName()}], Disconnect player.`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_pCtx.m_rgnBoxItem[box] !== 0) return;
    this.m_pCtx.m_rgnBoxItem[box] = 1;
    const packet = new CSendPacket(GS_ClientSend.OnRequestEatItemRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slot);
    packet.Encode1(box);
    packet.Encode1(item);
    if (itemAttr.m_vtEffect[item] === 99) {
      let count = 1;
      if (eater && (eater.m_fPremiumTicket & 0xff) === 1) count = Math.floor(Math.random() * 2) + 1; // user+2004 byte
      packet.Encode1(count);
      const lucci = count * itemAttr.m_vtAmount[item]!;
      if (lucci > 10000) console.error(`[GS] suspicious on lucci amount ${lucci}`);
      eater?.IncDecMoney(lucci);
    }
    this.SendPacket(packet);
  }

  /** CGameSession::OnRequestEatObstacle (145, FxServer.exe.c:41ECA3). */
  OnRequestEatObstacle(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const pos = n.Decode1();
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] OnRequestEatObstacle User none [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    if (this.IsSlotInThisSocket(slot, socket) === 0) {
      console.error(`[GS] OnRequestEatObstacle slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const obstacleId = (pos & 0xf) + 15 * (pos >> 4);
    if (obstacleId > 0xc2) {
      console.error(`[GS] Invalid obstacle id from user[${user0.GetName()}], Disconnect player`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_pCtx.m_rgnObstacle[obstacleId] !== 0) return;
    this.m_pCtx.m_rgnObstacle[obstacleId] = 1;
    const packet = new CSendPacket(GS_ClientSend.OnRequestEatObstacleRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slot);
    packet.Encode1(pos);
    this.SendPacket(packet);
  }

  /** CGameSession::OnSetBomberEvent (146, FxServer.exe.c:41EE05) — the event umbrella. */
  OnSetBomberEvent(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying === 0) return;
    const slotCode = n.Decode1();
    const a = n.Decode2();
    const b = n.Decode2();
    const packet = new CSendPacket(GS_ClientSend.OnBomberEvent, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slotCode);
    packet.Encode2(a);
    packet.Encode2(b);
    const slot = slotCode & 0xf;
    const event = slotCode >> 4;
    if (slot >= MAX_SESSION_SLOTS || this.IsMySocket(slot, socket) === 0) {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const ctx = this.m_pCtx;
    switch (event) {
      case 0: {
        // UseSpecialItem
        const x = n.Decode1();
        const itemidx = n.Decode1();
        const count = n.Decode1();
        if (count !== 0) {
          if (CMainSystem.ms_pInstance!.m_nChannelType === 108) {
            console.error(`[GS] ${this.m_rgPlayer[slot]?.GetName()} Try to Use ShopItem at NoShopItemServer`);
            return;
          }
          this.m_rgnUsedItem[slot] = 1;
          this.m_rgnShopItem[slot] = 1;
          const sn = n.Decode4();
          const user = this.m_rgPlayer[slot];
          const inv = user ? user.GetUserInventory(sn) : null;
          let underflow = false;
          if (inv) {
            underflow = inv.Amount - count < 0;
            inv.Amount -= count;
            inv.fModified = 1;
            if (underflow) inv.Amount = 0;
          }
          if (!inv || underflow) {
            console.error("[GS] Tried to use nonresident Item..Disconnect user");
            socket.PostClosePacket();
            return;
          }
        }
        const itemAttr = CItemAttr.ms_pInstance!;
        if (itemidx < 0 || itemidx >= itemAttr.m_vtName.length) {
          console.error(`[GS] Illegal itemidx (UseSpecialItem). Disconnect [${GetInfoStr(socket)}].`);
          socket.PostClosePacket();
          return;
        }
        const effect = itemAttr.m_vtEffect[itemidx]!;
        if (effect === 22) {
          if (this.m_abDeleted[slot] === 3) ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime() | 0;
        } else if (!((effect >= 11 && effect <= 13) || effect === 21 || (effect > 22 && effect <= 28) || effect === 31 || effect === 32)) {
          console.error(`[GS] Illegal item effect (UseSpecialItem). Disconnect [${GetInfoStr(socket)}].`);
          socket.PostClosePacket();
          return;
        }
        packet.Encode1(x);
        packet.Encode1(itemidx);
        packet.Encode1(count);
        this.SendPacketExclude(packet, socket);
        break;
      }
      case 1:
      case 7:
        this.SendPacketExclude(packet, socket);
        break;
      case 2: {
        this.m_abDeleted[slot] = 3;
        ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime() | 0;
        ctx.m_rgnDiePos[2 * slot] = a & 0xffff;
        ctx.m_rgnDiePos[2 * slot + 1] = b & 0xffff;
        this.SendPacketExclude(packet, socket);
        break;
      }
      case 3: {
        const saver = n.Decode1();
        if (saver < MAX_SESSION_SLOTS) this.m_DynInfoCalculator.SetSaverIndex(slot, saver); // the first save feeds GetWinExp/GetDrawExp
        this.m_abDeleted[slot] = 0;
        this.SendPacketExclude(packet, socket);
        break;
      }
      case 4: {
        // the death report
        let killer = n.Decode1();
        killer = (killer << 24) >> 24; // signed char
        if (killer !== -1) this.m_DynInfoCalculator.SetKillerIndex(killer);
        packet.Encode1(killer);
        this.OnBomberDie(slot);
        const drops = n.Decode1();
        packet.Encode1(drops);
        if (drops > 0) {
          for (let i = 0; i < drops; i++) {
            const obspos = n.Decode1(); // byte 1 → the obstacle grid (+4032)
            const boxpos = n.Decode1(); // byte 2 → the box-item table (+3032)
            ctx.m_rgnObstacle[(obspos & 0xf) + 15 * (obspos >> 4)] = 0;
            ctx.m_rgnBoxItem[boxpos] = 0;
            packet.Encode1(obspos);
            packet.Encode1(boxpos);
          }
        }
        this.SendPacket(packet);
        if (this.m_abDeleted[slot] !== 4) {
          this.m_abDeleted[slot] = 1;
          ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime() | 0;
        }
        return;
      }
      case 5:
        console.error("[GS] user tried to send die by server packet");
        this.SendPacketExclude(packet, socket);
        break;
      case 6:
        this.m_abDeleted[slot] = 2;
        this.SendPacketExclude(packet, socket);
        break;
      case 8: {
        const v = n.Decode1();
        const w = n.Decode1();
        packet.Encode1(v);
        packet.Encode1(w); // lst 41F1D3-41F203: both bytes echo
        this.SendPacketExclude(packet, socket);
        break;
      }
      default:
        console.error("[GS] user tried to send invalid set bomber event packet");
        return;
    }
  }

  /** CGameSession::OnSetEffect (147, FxServer.exe.c:41CA78) — the raw buffer relay. */
  OnSetEffect(n: CReceivedPacket, socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnEffectRes, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeBuffer(n.m_pBlock.subarray(n.m_uOffset), n.m_uLength - n.m_uOffset);
    this.SendPacketExclude(packet, socket);
  }

  /** CGameSession::OnDropObstacle (148, FxServer.exe.c:41B2E0). */
  OnDropObstacle(n: CReceivedPacket, socket: CClientSocket): void {
    const a = n.Decode1();
    const pos = n.Decode1();
    this.m_pCtx.m_rgnObstacle[(pos & 0xf) + 15 * (pos >> 4)] = 0;
    const packet = new CSendPacket(GS_ClientSend.OnDropObstacleRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(a);
    packet.Encode1(pos);
    this.SendPacketExclude(packet, socket);
  }

  /** CGameSession::OnEventItem (149, FxServer.exe.c:41F28B) — the 30 announcement. */
  OnEventItem(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode1();
    if (idx >= socket.GetUserCount()) {
      console.error(`[GS] Tried to eat event item by illegal user in the session(${this.m_nIdx})`);
      return;
    }
    const itemName = n.DecodeStr();
    const eater = socket.GetUser(idx)!;
    console.log(`[GS] Event Item(${itemName}) eaten by User(${eater.GetName()}) in the session(${this.m_nIdx})`);
    const packet = new CSendPacket(GS_ClientSend.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8); // id 30 (OnEventItemMsg shares the OnSystemMsg id)
    packet.EncodeStr(eater.GetName());
    this.SendPacket(packet);
  }

  /** CGameSession::OnDestroyBox (150, FxServer.exe.c:41B376) — a plain 3-byte relay. */
  OnDestroyBox(n: CReceivedPacket, _socket: CClientSocket): void {
    const a = n.Decode1();
    const b = n.Decode1();
    const c = n.Decode1();
    const packet = new CSendPacket(GS_ClientSend.OnDestroyBoxRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(a);
    packet.Encode1(b);
    packet.Encode1(c);
    this.SendPacket(packet);
  }

  /** CGameSession::OnRequestGenerateGhost (151, FxServer.exe.c:41F3F1). */
  OnRequestGenerateGhost(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const tag = n.Decode1();
    const slot = n.Decode1();
    if (this.IsSlotInThisSocket(slot, socket) === 0) {
      console.error(`[GS] illegal user requested to Generate Ghost. disconnect [${user0.GetName()}].`);
      return;
    }
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] Illegal slot idx(OnRequestGenerateGhost). Disconnect [${user0.GetName()}].`);
      socket.PostClosePacket();
      return;
    }
    const now = CGameClock.Now();
    if (
      (this.m_dwLastGhostTime === 0 || ((now - this.m_dwLastGhostTime) >>> 0) >= this.m_nGhostFreq) &&
      this.m_GameClock.ElapsedTime() >= this.m_nGhostStart &&
      this.m_nGhostCount < MAX_SESSION_SLOTS
    ) {
      if (this.m_rgSlotGhost[slot] !== -1) {
        if (this.m_nGhostFreq === 0) return;
        if (this.m_rgGhostSlot[this.m_rgSlotGhost[slot]!] !== slot) console.error("[GS] Mapping is inconsistent ghostidx to slotidx.");
        console.error("[GS] Player having ghost tried to generate more ghost: There must be a leg.");
        console.error(
          `[GS]     - LastGhost:${this.m_dwLastGhostTime}   CurTime:${now}   Diff:${(now - this.m_dwLastGhostTime) | 0}   - GhostStart:${this.m_nGhostStart}   GhostFreq:${this.m_nGhostFreq}   GameStart:0   Elapsed:${this.m_GameClock.ElapsedTime()}`,
        );
        if (this.IsMySocket(slot, socket) === 0) console.error("[GS]     Socket Mismatch!");
        console.error(`[GS]       User[${user0.GetName()}]    slotidx:${slot}   GhostCount:${this.m_nGhostCount}`);
        console.error("[GS]     - Slot->Ghost - Ghost->Slot -");
        for (let i = 0; i < MAX_SESSION_SLOTS; i++) console.error(`[GS]       ${this.m_rgSlotGhost[i]}       ${this.m_rgGhostSlot[i]}     `);
        this.DumpLog();
        return;
      }
      let ghost = 0;
      while (ghost < MAX_SESSION_SLOTS && this.m_rgGhostSlot[ghost] !== -1) ghost++;
      if (ghost < MAX_SESSION_SLOTS) {
        this.m_dwLastGhostTime = now;
        this.m_rgGhostSlot[ghost] = slot;
        this.m_rgSlotGhost[slot] = ghost;
        this.m_nGhostCount++;
        const packet = new CSendPacket(GS_ClientSend.OnGhostGenerate, CipherDegree.kPacketEncryptedCRC8);
        packet.Encode1(ghost);
        packet.Encode1(slot | 0x80);
        packet.Encode1(tag);
        this.SendPacket(packet);
      }
    }
  }

  /** CGameSession::DumpLog (vtbl+20, 41E0D5) — the diagnostic dump; state-free. */
  DumpLog(): void {}

  /** CGameSession::OnRequestDestroyGhost (152, FxServer.exe.c:41B3FF). */
  OnRequestDestroyGhost(n: CReceivedPacket, _socket: CClientSocket): void {
    const idx = n.Decode1();
    if (idx >= MAX_SESSION_SLOTS) {
      console.error("[GS] Wrong Ghostdestroy idx input");
      return;
    }
    const slot = this.m_rgGhostSlot[idx]!;
    if (slot === -1) return;
    if (this.m_rgSlotGhost[slot] === idx) {
      this.m_rgGhostSlot[idx] = -1;
      this.m_rgSlotGhost[slot] = -1;
      this.m_nGhostCount--;
      const packet = new CSendPacket(GS_ClientSend.OnGhostDestroy, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(idx);
      this.SendPacket(packet);
    } else {
      console.error("[GS] Ghost idx mismatch to slot idx ");
    }
  }

  /** CGameSession::OnLapFinished (154, FxServer.exe.c:36502) — the first finisher only. */
  OnLapFinished(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const user = this.m_rgPlayer[slot];
    if (!user || user.m_pSocket !== socket) {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i] && this.m_abDeleted[i] === 5) return;
    }
    this.m_abDeleted[slot] = 5;
  }

  /** CGameSession::OnLapInfo (155, FxServer.exe.c:41B5E9) — the 170 rank broadcast. */
  OnLapInfo(n: CReceivedPacket, _socket: CClientSocket): void {
    const slot = n.Decode1();
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] [CGameSession::OnLapInfo] User sent invalid slot idx, slotidx=${slot}`);
      return;
    }
    const lap = n.Decode1();
    const v = n.Decode1();
    const rank = ((255 - v) | ((255 - lap) << 8)) & 0xffff;
    const now = CGameClock.Now();
    this.m_rgLapTime[2 * slot] = now | 0;
    this.m_rgLapRank[2 * slot] = rank;
    this.m_rgLapCount[slot] = lap;
    // the pairwise place table (times at +12632, ranks at +12636)
    const place = new Int32Array(8).fill(1);
    let count = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i] && !(this.m_rgLapTime[2 * i] === -1 && this.m_rgLapRank[2 * i] === -1)) count++;
    }
    // the original packs {time, rank} into one u64 (time in the low dword,
    // rank in the high dword) and compares those — i.e. rank first, then time
    const lapKeyLessOrEqual = (a: number, b: number): boolean => {
      const rankA = this.m_rgLapRank[2 * a]! >>> 0;
      const rankB = this.m_rgLapRank[2 * b]! >>> 0;
      if (rankA !== rankB) return rankA < rankB;
      const timeA = this.m_rgLapTime[2 * a]! >>> 0;
      const timeB = this.m_rgLapTime[2 * b]! >>> 0;
      return timeA <= timeB;
    };
    for (let i = 0; i < 7; i++) {
      if (!this.m_rgPlayer[i]) continue;
      for (let k = i + 1; k < MAX_SESSION_SLOTS; k++) {
        if (!this.m_rgPlayer[k]) continue;
        if (lapKeyLessOrEqual(i, k)) place[k]!++;
        else place[i]!++;
      }
    }
    const packet = new CSendPacket(GS_ClientSend.OnLapInfoRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(count);
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i]) {
        // a seated slot always encodes its place/laps (place stays 1 while the
        // pair is still {−1,−1}); only truly empty slots get the 255 marker
        packet.Encode1(place[i]!);
        packet.Encode1(this.m_rgLapCount[i]!);
      } else {
        packet.Encode1(255);
        packet.Encode1(255);
      }
    }
    this.SendPacket(packet);
  }

  /** CGameSession::OnRequestAirplane (156, FxServer.exe.c:41D7C0). */
  OnRequestAirplane(n: CReceivedPacket, socket: CClientSocket): void {
    const now = CGameClock.Now();
    if (this.m_dwLastAirplaneTime + 7000 > now) return;
    const count = n.Decode1();
    if (count === 0 || count > 3) console.error(`[GS] Strange Request Airplane, nCount=${count}`);
    const packet = new CSendPacket(GS_ClientSend.OnRequestAirplaneRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode4((now + 2000) >>> 0);
    packet.Encode1(count);
    const boxes: number[] = [];
    for (let i = 0; i < count; i++) {
      const a = n.Decode1();
      const box = n.Decode1();
      const b = n.Decode1();
      const c = n.Decode1();
      if (box >= 250) {
        const user = socket.GetUser(0);
        if (user) console.error(`[GS] Invalid box idx from user[${user.GetName()}], Disconnect player`);
        socket.PostClosePacket();
        return;
      }
      packet.Encode1(a);
      packet.Encode1(box);
      packet.Encode1(b);
      packet.Encode1(c);
      boxes.push(box);
    }
    for (const box of boxes) this.m_pCtx.m_rgnBoxItem[box] = 0;
    this.m_dwLastAirplaneTime = now + 2000;
    this.SendPacket(packet);
  }

  /** CSyncGameObjMan::OnReqCreateObj (158) / OnReqDestroyObj (159). */
  OnReqCreateObj(n: CReceivedPacket, socket: CClientSocket): void {
    this.m_SyncGameObjMan.OnReqCreateObj(n, socket);
  }
  OnReqDestroyObj(n: CReceivedPacket, socket: CClientSocket): void {
    this.m_SyncGameObjMan.OnReqDestroyObj(n, socket);
  }

  /** CGameSession::OnReqEatBula (160, FxServer.exe.c:41CBB2). */
  OnReqEatBula(n: CReceivedPacket, _socket: CClientSocket): void {
    const slot = n.Decode1();
    const count = n.Decode1();
    const packet = new CSendPacket(GS_ClientSend.OnReqEatBulaRes, CipherDegree.kPacketEncryptedCRC8);
    const countOffset = packet.m_uOffset;
    packet.Encode1(0);
    if (count > 0) {
      let left = count;
      do {
        const x = n.Decode1();
        const y = n.Decode1();
        packet.Encode1(x);
        packet.Encode1(y);
        packet.Encode1(slot);
        this.m_pCtx.SetBulaState(x, y, slot);
      } while (--left !== 0);
    }
    packet.Encode1At(countOffset, count & 0xff);
    this.SendPacket(packet);
  }

  /** CGameSession::OnReqTakeHouse (161, FxServer.exe.c:41D941). */
  OnReqTakeHouse(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const total = n.Decode1();
    const color = this.GetColor(slot); // already masked — the SetHouseState team index
    const packet = new CSendPacket(GS_ClientSend.OnReqTakeHouseRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slot);
    const houseCountOffset = packet.m_uOffset;
    packet.Encode1(0);
    let taken = 0;
    for (let left = total; left > 0; left--) {
      const row = n.Decode1();
      const col = n.Decode1();
      if (row < 13 && col < 15 && this.m_pCtx.GetHouseState(row, col) === -1) {
        packet.Encode1(row);
        packet.Encode1(col);
        taken++;
        this.m_pCtx.SetHouseState(row, col, slot, color);
      }
    }
    packet.Encode1At(houseCountOffset, taken & 0xff);
    packet.Encode1(5);
    const boxTotal = n.Decode1();
    const boxCountOffset = packet.m_uOffset;
    packet.Encode1(0);
    for (let i = 0; i < boxTotal; i++) {
      const a = n.Decode1();
      const b = n.Decode1();
      const c = n.Decode1();
      const box = this.m_pCtx.AddBoxItem();
      if (box === -1) break;
      packet.Encode1(a);
      packet.Encode1(box);
      packet.Encode1(b);
      packet.Encode1(c);
    }
    packet.Encode1At(boxCountOffset, boxTotal & 0xff);
    this.SendPacket(packet);
    this.m_rgPlayer[slot]?.IncDecMoney(5 * taken);
  }

  /** CGameSession::OnShobuari (162, FxServer.exe.c:41CC8B) — settle the score, no packet. */
  OnShobuari(): void {
    let bestColor = -1;
    let bestScore = -1;
    let tie = 0;
    const present = new Uint8Array(8);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (!this.m_rgPlayer[slot]) continue;
      const code = this.m_abDeleted[slot]!;
      if (code !== 1 && code !== 4 && this.GetColor(slot) < MAX_SESSION_SLOTS) present[this.GetColor(slot)] = 1;
    }
    for (let color = 0; color < MAX_SESSION_SLOTS; color++) {
      if (!present[color]) continue;
      const score = this.m_pCtx.m_rgnTeamScore[color]!;
      if (score > bestScore) {
        bestScore = score;
        bestColor = color;
        tie = 0;
      } else if (score === bestScore) {
        tie = 1;
      }
    }
    if (tie !== 0 || bestColor === -1) {
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        if (this.m_rgPlayer[slot]) this.m_abDeleted[slot] = 7;
      }
    } else {
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        if (this.m_rgPlayer[slot] && this.GetColor(slot) === bestColor && this.m_abDeleted[slot] !== 1) {
          this.m_abDeleted[slot] = 6;
        }
      }
    }
  }

  /** CGameSession::OnNotifyUDPLoss (185, 41D0BC) — tell the blamed slot to relay (54). */
  /**
   * CGameSession::OnNotifyUDPLoss (case 185, FxServer.exe.c:34093) — relay
   * the asker's slot to one member.  The asker must be seated (slot < 8) and
   * the target live.  NB: the near-twin CGameSession::OnRequestUDPRelay
   * (FxServer.exe.c:34508) adds the m_abDeleted != 1 (asker alive) gate and
   * the "Request UDPRelay" Report — but it has no vtable slot and no caller
   * in FXGS (dead in this build), so the shipped 185 shape is this one.
   */
  OnNotifyUDPLoss(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    if (slot >= MAX_SESSION_SLOTS) return;
    const target = this.m_rgPlayer[slot];
    if (!target || target.m_nFree !== 0) return; // CUser+20 — the live-object mark
    const user0 = socket.GetUser(0);
    const senderSlot = user0 ? user0.m_nSlotIdx : 8;
    if (senderSlot >= MAX_SESSION_SLOTS) return;
    const packet = new CSendPacket(GS_ClientSend.OnRequestUDPRelayRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(senderSlot);
    target.m_pSocket?.SendPacket(packet);
  }

  /**
   * CGameSession::OnReadyForImmediateStart (109, FxServer.exe.c:41D431).
   * The original validates the map CRC against CGameMapTmpl +88 and the four
   * attrs against CBomberAttr / m_aBomberIdx before opening the start gate
   * ("Hacking suspected" + disconnect).  Those checks are deliberately
   * dropped: the client CRCs the same FxServer.idx entry, so any drift in
   * our template parse turned into a false positive that blocked every
   * launch.  The packet fields are still decoded to keep the wire layout,
   * and the boarding guard stays (the original ignores 109 while the
   * socket's roster is not fully seated).
   */
  OnReadyForImmediateStart(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying === 0 || this.m_nGamePhase !== 0) return;
    n.Decode4(); // the map CRC — check removed
    const userCount = socket.GetUserCount();
    for (let i = 0; i < userCount; i++) {
      const user = socket.GetUser(i)!;
      if (!this.m_rgPlayer[user.m_nSlotIdx]) return; // still boarding
    }
    for (let i = 0; i < userCount; i++) {
      n.Decode1(); // bomberidx
      n.Decode1(); // bombcount
      n.Decode1(); // bombpower
      n.Decode1(); // speed
    }
    for (let i = 0; i < userCount; i++) {
      const slot = socket.GetUser(i)!.m_nSlotIdx;
      this.m_rgSlotState[3 * slot] = (this.m_rgSlotState[3 * slot]! & SLOTSTATE_GROUP_CLEAR) | SLOTSTATE_LAUNCH_OK;
    }
    this.DeferStartGame();
  }

  /** CGameSession::DeferStartGame (vtbl+148, 41BF1B). */
  DeferStartGame(): void {
    if (this.IsAllPlayerReadyForStart() !== 0) this.DoStartGame();
  }

  /** CGameSession::IsAllPlayerReadyForStart (31906). */
  IsAllPlayerReadyForStart(): number {
    if (this.m_nCurPlayerNum === 0) return 0;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (user && (this.m_rgUdpAlive[slot] === 0 || (this.m_rgSlotState[3 * slot]! & SLOTSTATE_GROUP_MASK) !== SLOTSTATE_LAUNCH_OK)) return 0;
    }
    return 1;
  }

  /** CGameSession::DoStartGame (32879) — the 150 kickoff. */
  DoStartGame(): void {
    this.m_SyncGameObjMan.Init(this);
    const tmpl = this.m_nGameMapIdx >= 0 ? CGameMapTmplList.ms_pInstance!.m_apGameMapTmpl[this.m_nGameMapIdx] : undefined;
    this.m_SyncGameObjMan.SetInitialObjNo(tmpl ? tmpl.m_nArg84 : 0);
    this.m_nObj0 = -1; // +11612
    this.m_nObj1 = -1; // +11616
    this.m_GameClock.StartGame();
    CGameSessionTable.ms_pInstance!.ClearModifiedFlag(this.m_nIdx); // the table vtbl+12
    this.m_nBombTickTime = 0; // +12552 (dword 3138)
    this.m_nGamePhase = 1;
    const packet = new CSendPacket(GS_ClientSend.OnStartGame2, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode4(this.m_dwStartSeed);
    packet.Encode4((this.m_nGameSerial ^ this.m_nGameVersion) >>> 0);
    this.m_nGameSerial = (this.m_nGameSerial + 1) >>> 0;
    // the wire carries the RAW tmpl+60/+64 seconds (FxServer.exe.c:32906 and
    // :32908 encode this+3140/this+3141 before the *= 1000 at :32911-32912
    // rescales the server-side state) — the client rescales on its own
    packet.Encode4(this.m_nGhostStart);
    packet.Encode4(this.m_nGhostFreq);
    this.m_nGameType100 = tmpl ? tmpl.m_fReBirthMap : 0; // +12728 ← tmpl+100
    this.m_nGhostStart *= 1000;
    this.m_nGhostFreq *= 1000;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (!this.m_rgPlayer[slot]) this.m_rgUdpHost[slot]!.fill(0);
    }
    this.m_BanChief = new CBanChief(); // CBanChief::Init: SetCanStart(0)/SetOddSlot(0)
    this.m_dwLastAirplaneTime = 0; // +12624 (dword 3156)
    this.SendPacket(packet);
  }

  /**
   * CGameSession::OnRequestSessionInfoDetail (FxServer.exe.c:36389) — the
   * room-detail 84: [E1 1] then per slot [E1 0] or [E1 1][E1 user+104]
   * [EStr name][E2 look][E1 in-play state][E1 chief], tail [E4 time].  The
   * user+104 byte has no writer in FXGS, so the original always sends 0.
   */
  OnRequestSessionInfoDetail(socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnSessionInfoDetailRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(1); // the room exists (this branch only runs for a live one)
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (user === null) {
        packet.Encode1(0);
        continue;
      }
      packet.Encode1(1);
      packet.Encode1(0); // user+104 — no writer in FXGS (see the comment above)
      packet.EncodeStr(user.GetName());
      packet.Encode2(user.GetLookLevel());
      packet.Encode1(
        this.m_fPlaying !== 0 ? ((this.m_abDeleted[slot] === 1 || this.m_abDeleted[slot] === 4) ? 2 : 1) : 0,
      );
      packet.Encode1((this.m_rgSlotState[slot * 3]! & SLOTSTATE_CHIEF) !== 0 ? 1 : 0);
    }
    // the mid-game tail: 3 minutes minus the play time (suspend gaps
    // excluded), clamped into 0..180000
    let time = 0;
    if (this.m_fPlaying !== 0 && this.m_nGamePhase === 1) {
      const played = (this.m_GameClock.ElapsedTime() - this.m_GameClock.m_dwSuspended) | 0;
      time = Math.min(Math.max(180000 - played, 0), 180000);
    }
    packet.Encode4(time >>> 0);
    socket.SendPacket(packet);
  }

  /** CGameSession::OnPacket — the room dispatch (FxServer.exe.c:37668). */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (!this.CheckValidSocket(socket)) {
      console.error(`[GS] !this->CheckValidSocket(pSocket), CGameSession::OnPacket. Disconnect socket[${GetInfoStr(socket)}]`);
      console.error(`[GS]     User[${socket.GetUser(0)?.GetName() ?? "NULL"}], Game Session Slot Index: [${this.m_nIdx}]. CurrentPoolType=${socket.m_nPoolType}.`);
      socket.PostClosePacket();
      return;
    }
    switch (n.Decode1()) {
      case SESSION_ReceivedPacket.OnSetPlayerReady:
        this.OnSetPlayerReady(n, socket);
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
      case SESSION_ReceivedPacket.OnSetGameTypeNormal:
        this.OnSetGameTypeNormal(socket);
        break;
      case SESSION_ReceivedPacket.OnSetGameTypeMod:
        this.OnSetGameTypeMod(socket);
        break;
      case SESSION_ReceivedPacket.OnHostAskBanPlayer:
        this.OnHostAskBanPlayer(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRespondToBanPlayer:
        this.OnRespondToBanPlayer(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestStartGame:
        this.OnRequestStartGame(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestChangeTitle:
        this.OnRequestChangeTitle(n, socket);
        break;
      case SESSION_ReceivedPacket.OnPlayEmotion:
        this.OnPlayEmotion(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReadyForImmediateStart:
        this.OnReadyForImmediateStart(n, socket);
        break;
      case SESSION_ReceivedPacket.OnTeamChat:
        this.OnTeamChat(n, socket);
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
      case SESSION_ReceivedPacket.OnLapFinished:
        this.OnLapFinished(n, socket);
        break;
      case SESSION_ReceivedPacket.OnLapInfo:
        this.OnLapInfo(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestAirplane:
        this.OnRequestAirplane(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReqCreateObj:
        this.m_SyncGameObjMan.OnReqCreateObj(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReqDestroyObj:
        this.m_SyncGameObjMan.OnReqDestroyObj(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReqEatBula:
        this.OnReqEatBula(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReqTakeHouse:
        this.OnReqTakeHouse(n, socket);
        break;
      case SESSION_ReceivedPacket.OnShobuari:
        this.OnShobuari();
        break;
      case SESSION_ReceivedPacket.OnNotifyUDPLoss:
        this.OnNotifyUDPLoss(n, socket);
        break;
      case SESSION_ReceivedPacket.OnHackingSuspected:
        this.OnHackingSuspected(n, socket);
        break;
      case SESSION_ReceivedPacket.OnNotifyUdpLossRegulator:
        // (+213 != 0 && +246 == 1) — only mid-game
        if (this.m_fPlaying !== 0 && this.m_nGamePhase === 1) this.m_UdpLossRegulator.OnNotifyUdpLoss(n, socket);
        break;
      default:
        break;
    }
  }
}
