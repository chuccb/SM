/** Native source unit: FX/FxServer/GameSession.cpp.
 * CGameSession — one room: the session-stage dispatch (96..112), the
 *  in-play dispatch (140..162, 185..187), the ghost/lap/airplane units and
 *  the results unit (163). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CReceivedPacket, CSendPacket, CipherDegree, PACKET_TYPE_PLACEHOLDER } from "../core/Packet.ts";
import { S2C_GamePacket, C2S_GameSessionPacket } from "../core/protocol/PacketIDs.ts";
import { FunctionalItem } from "../common/Item.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import {
  ACCOUNTING_LOG_CHANNEL_TYPE,
  CHANNEL_TYPE_GUILD,
  CHANNEL_TYPE_NO_SHOP,
  BOMB_ATTR_FLAG16_MASK,
  GHOST_SLOT_NEW_FLAG,
  BOMBER_EVENT_MULTI_DIE_HEADER,
  DEATH_COORD,
  GAME_CONTEXT_BOMB_CAPACITY,
  GAME_CONTEXT_BOX_CAPACITY,
  GAME_CONTEXT_DIE_COORDS_PER_SLOT,
  GAME_CONTEXT_TILE_COLUMNS,
  GAME_CONTEXT_TILE_COUNT,
  GetThemeIdxFromMapIdx,
  IS_LADDER_GAME,
  MAP_IDX_RANDOM,
  MAX_SESSION_SLOTS,
  RETURN_STAGE_DELAY,
  GAME_DURATION_LIMIT_MS,
  HOUSE_MONEY,
  HOUSE_PACKET_TAIL,
  MAP_COLOR_IN_USE,
  SESSION_INFO_DETAIL_RESULT,
  SESSION_MODIFIED_MAP,
  SLOTSTATE_CHIEF,
  SLOTSTATE_COLOR_MASK,
  SLOTSTATE_GROUP_CLEAR,
  SLOTSTATE_GROUP_MASK,
  SLOTSTATE_LAUNCH_OK,
  SLOTSTATE_READY,
  STR_BIG_LUCK_MSG,
  SUPREME_ROOM_SWAP_COUNT,
  AUTHORITY_JOIN_CLOSED,
  AUTHORITY_BAN_CHIEF_BYPASS,
  AUTHORITY_LEVEL_BYPASS,
  AUTHORITY_ALWAYS_ZERO,
} from "./Defs.ts";
import { CBanChief } from "./BanChief.ts";
import { CDynInfoCalculator } from "./DynInfoCalculator.ts";
import { CGameClock, CGameContext } from "./runtime/GameSessionSupport.ts";
import { CSyncGameObjMan } from "./SyncGameObjMan.ts";
import { CUdpLossRegulator } from "./UdpLossRegulator.ts";
import { CBomberAttr } from "./BomberAttr.ts";
import { CGameMapTmplList } from "./GameMapTmplList.ts";
import { CItemAttr } from "./ItemAttr.ts";
import { ClearSessionModifiedFlag, DestroySessionPlayer } from "./runtime/SessionTableRuntime.ts";
import { CGameSessionStrategy } from "./GameSessionStrategy.ts";
import { CListSession } from "./ListSession.ts";
import { CGuildSessionStrategy } from "./GuildSessionStrategy.ts";
import { CMainSystem } from "./MainSystem.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import { UpdateChannelRankList } from "./runtime/ClientSocketRuntime.ts";
import type { CUser } from "./User.ts";
import { SendCenterPacket } from "./runtime/CenterProcessRuntime.ts";
import { CGuildDynInfoCalculator } from "./GuildDynInfoCalculator.ts";
import type { HOSTHANDLE } from "../common/MTUDP.ts";
import { MC_GameServerSendPacket } from "../core/protocol/CenterProtocol.ts";

const RANDOM_BOMBER_RARE_ROLL_DIVISOR = 30;
const RANDOM_BOMBER_VARIANT_ROLL_DIVISOR = 3;
const PREMIUM_LUCCI_COUNT_VARIANTS = 2;
const SUSPICIOUS_LUCCI_AMOUNT = 10_000;
const MISSION_INFO_FIELD_COUNT = 4;
const LAP_RECORD_STRIDE = 2;
const LAP_RECORD_CAPACITY = MAX_SESSION_SLOTS * LAP_RECORD_STRIDE;
const UDP_HOST_CAPACITY = 3;
const UDP_HOST_RECORD_BYTES = 8;
const UDP_HOST_BYTES_PER_SLOT = UDP_HOST_CAPACITY * UDP_HOST_RECORD_BYTES;

const MILLISECONDS_PER_SECOND = 1_000;
const UDP_JOIN_GRACE_PLAYING_MS = 25_000;
const UDP_JOIN_GRACE_WAITING_MS = 30_000;
const EXPLODED_BOMB_FUSE_MS = 2_000;
const NEW_BOMB_FUSE_MS = 2_800;
const TRAPPED_PLAYER_GRACE_MS = 10_000;
const ALL_PLAYERS_DOWN_GRACE_MS = 6_000;
const BIG_LUCK_RAMP_START_MS = 15_000;
const BIG_LUCK_RAMP_END_MS = 45_000;
const BIG_LUCK_RAMP_DURATION_MS = BIG_LUCK_RAMP_END_MS - BIG_LUCK_RAMP_START_MS;
const MAP_TEAM_COLORS = [0, 3, 5, 6] as const;
const LADDER_AIRPLANE_PROBABILITY_CAP = 30_000;
const AIRPLANE_COOLDOWN_MS = 7_000;
const AIRPLANE_RESPONSE_LEAD_MS = 2_000;

// ============================ CGameSession ============================

/**
 * CGameSession — the native GameSession.cpp layer over CListSession and
 * CBaseSession (0x31DC bytes in the original). Fields retain native offsets.
 */
export class CGameSession extends CListSession {
  m_nGameTypeMod = 0; // +948 (SendGameTypeMod 1 / SendGameTypeNormal 0)
  m_MissionInfo = new Int32Array(MISSION_INFO_FIELD_COUNT); // +12748 (tmpl+108..+120)
  m_nGameMapIdx = -1; // +1180 (SetMapIdxPlayingByLevel result)
  m_nGamePhase = 0; // +984 (0 wait / 1 in-play / 2 ended; DoStartGame 1, SendGameResult→2, DoReturnPrepareStage 0)
  m_aBomberIdx = new Int32Array(MAX_SESSION_SLOTS).fill(-1); // +11572
  m_abDeleted = new Uint8Array(MAX_SESSION_SLOTS); // +11604 (0 alive; 1 dead / 2 goal / 3 trap / 5 lap finish / 6 win / 7 draw)
  m_rgnUsedItem = new Int32Array(MAX_SESSION_SLOTS); // +11652 (a special item was used this game)
  /** +12632/+12636 — per-slot {time, rank} lap pairs (LaunchGameStage fills -1). */
  m_rgLapTime = new Int32Array(LAP_RECORD_CAPACITY).fill(-1);
  m_rgLapRank = new Int32Array(LAP_RECORD_CAPACITY).fill(-1);
  m_rgLapCount = new Int32Array(MAX_SESSION_SLOTS); // +12696 (per-slot lap byte)
  /** +12940 — the UDP-alive flags (OnUDPPeerInfo sets, DestroyPlayer clears). */
  m_rgUdpAlive = new Uint8Array(MAX_SESSION_SLOTS);
  /** +12948 — the per-slot join times (CGameSession::AddUser; the UDP sweep reads them). */
  m_rgJoinTime = new Int32Array(MAX_SESSION_SLOTS);
  /** +988 — per-slot UDP peer hosts (3 × {ip dword, port u16, pad}); the UDP unit reads these. */
  m_rgUdpHost = Array.from(
    { length: MAX_SESSION_SLOTS },
    () => new Uint8Array(UDP_HOST_BYTES_PER_SLOT),
  );
  m_BanChief = new CBanChief(); // +12576 (the idle-room start gate)
  m_nObj0 = -1; // +11612
  m_nObj1 = -1; // +11616
  /**
   * +11684..+12279 is one contiguous CDynInfoCalculator (0x254 bytes).
   * In particular, the result fields at +12016/+12048/+12208/+12240 are its
   * save/kill/my-team/other-team arrays; +12272/+12276 are its premium and
   * invalid-game flags.  Keep one object so event updates and result
   * serialization necessarily address the same native storage.
   */
  m_DynInfoCalculator = new CDynInfoCalculator();
  m_nBombTickTime = 0; // +12552 (dword 3138 — write-once zeroed at :32898, never read)
  m_dwLastTickTime = 0; // +12548 (Update's per-tick timeGetTime marker)
  m_nGameType100 = 0; // +12728 (tmpl+100 at DoStartGame)
  m_GameClock = new CGameClock(); // +12732
  m_UdpLossRegulator = new CUdpLossRegulator(); // +12280

  m_SyncGameObjMan = new CSyncGameObjMan(); // +12788
  m_pCtx = new CGameContext(); // +1184 (SetCurrentGameContext(0))
  m_nGameVersion = 0; // +12568 (rand at Init)
  m_nGameSerial = 0; // +12572 (the session serial copy)
  m_dwLaunchTime = 0; // +12556 (timeGetTime at launch)
  m_nGhostStart = 0; // +12560 (tmpl+60 s at LaunchGameStage; ×1000 ms at DoStartGame)
  m_nGhostFreq = 0; // +12564 (tmpl+64 s; ×1000 ms at DoStartGame)
  m_dwLastGhostTime = 0; // +940
  m_nGhostCount = 0; // +936
  m_rgSlotGhost = new Int32Array(MAX_SESSION_SLOTS).fill(-1); // +872 slot → ghost idx
  m_rgGhostSlot = new Int32Array(MAX_SESSION_SLOTS).fill(-1); // +904 ghost idx → slot
  m_abCaptain = new Int32Array(MAX_SESSION_SLOTS); // +952 (CheckIsCaptain's cache)
  m_dwLastAirplaneTime = 0; // +12624 (dword 3156)
  m_dwAirplaneItemProb = 0; // +12776 ← tmpl+72 (SendAirplaneItemProb dword 1)
  m_dwArg76 = 0; // +12780 (tmpl+76)

  m_pStrategy: CGameSessionStrategy; // +12620 — bound once by the ctor

  constructor() {
    super(MAX_SESSION_SLOTS);
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

  /** CGameSession::Init — CListSession::Init followed by the game layer. */
  override Init(title: string | null, password: string | null, gameType?: number): void {
    super.Init(title, password, gameType);
    if (gameType === undefined) return;
    this.m_nGamePhase = 0; // +984
    for (const host of this.m_rgUdpHost) host.fill(0); // memset(+988, 0, 0xC0)
    this.m_nGameMapIdx = -1; // +1180
    this.m_nGameVersion = CMainSystem.ms_pInstance!.m_WorkerRandom.rand(); // +12568
    this.m_nGameSerial = this.m_nSerialNo; // +12572
    this.m_aBomberIdx.fill(-1); // +11572
    this.m_nGameTypeMod = 0; // +948
    this.m_abCaptain.fill(0); // +952
    this.m_nGhostCount = 0; // +936
    this.m_rgSlotGhost.fill(-1); // +872
    this.m_rgGhostSlot.fill(-1); // +904
    this.m_BanChief.Init(); // +12576
  }

  /** CGameSession::MakeModifiedPacket — CListSession packet plus strategy tail. */
  override MakeModifiedPacket(packet: CSendPacket): number {
    const modified = super.MakeModifiedPacket(packet);
    if (modified !== 0) this.m_pStrategy.MakeModifiedPacket(packet);
    return modified;
  }

  /** CGameSession::Create — CListSession::Init + AddPlayer + InitBangPok. */
  Create(socket: CClientSocket, title: string, password: string, selects: number[], gameType: number): void {
    this.Init(title, password, gameType);
    this.AddPlayer(socket, selects);
    this.m_fModified = 0;
    this.InitBangPok(socket);
  }

  // ---- slot-state helpers (the 3-byte records at +68) ----
  // byte0: 0x01 closed / 0x02 chief / 0x1C the ready group (0x04 ready)
  // byte1: 0x3F bomber select, byte2: 0x1F team color

  /** CGameSession::DoSelectColor (:41B197) — CListSession::DoSelectColor,
   * then the strategy's same-guild colour drag. */
  override DoSelectColor(slot: number, color: number): void {
    super.DoSelectColor(slot, color);
    this.m_pStrategy.OnSelectColor(slot, color); // strategy vtbl+8
  }

  // ---- CBaseSession slot bookkeeping ----

  /** IsPlayerSet (vtbl+184) — CGameSession also counts practice occupants. */
  IsPlayerSet(slot: number): boolean {
    return this.m_rgPlayer[slot] !== null;
  }

  // ---- sending ----

  // ---- the 105/106/107/112 makers ----

  /** CBaseSession::SendSessionInfoPacket / CGameSession override
   *  (FxServer.exe.c:41AF87) — 105s + 112 + the strategy's SendSessionInfo +
   *  a second PutPacket of the same buffer.  The base strategy's
   *  SendSessionInfo is a bare `retn 4` (FxServer.exe.lst:4216EF), so on a
   *  normal channel the buffer still holds the 112 and the second PutPacket
   *  sends it AGAIN — the original client receives two consecutive 112s.
   *  The type-77 guild strategy rewrites the buffer as packet 88
   *  (EncodeGuildSessionInfo) and broadcasts it; the guild-channel session
   *  state is not modeled yet. */
  override SendSessionInfoPacket(socket: CClientSocket): void {
    this.MakeSessionInfoPacket(socket);
    const packet = new CSendPacket(S2C_GamePacket.OnSessionMapIdx);
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

  /** CGameSession::SendJoinPacket — base join broadcast plus strategy tail. */
  override SendJoinPacket(socket: CClientSocket): void {
    super.SendJoinPacket(socket);
    this.m_pStrategy.SendSessionInfo(new CSendPacket(PACKET_TYPE_PLACEHOLDER));
  }

  // ---- seating ----

  /** CGameSession::GetColorForNewComer (FxServer.exe.c:32760). */
  override GetColorForNewComer(slot: number): number {
    const counts = new Int32Array(MAX_SESSION_SLOTS);
    let used = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i]) {
        if (++counts[this.GetColor(i)]! === 1) used++;
      }
    }
    const want = slot % MAX_SESSION_SLOTS;
    if (used > 1) {
      let best = -1;
      let bestCount = MAX_SESSION_SLOTS;
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
      if (mapIdx === MAP_IDX_RANDOM) teams = 0;
      else if (mapIdx < 0) teams = CGameMapTmplList.ms_pInstance?.GetThemeMaxMaxPlayer(GetThemeIdxFromMapIdx(mapIdx)) ?? 0;
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

  /** CGameSession::AddUser — list seating plus per-game UDP state. */
  override AddUser(slot: number, user: CUser, bomber: number, color: number): void {
    super.AddUser(slot, user, bomber, color);
    this.m_aBomberIdx[slot] = -1;
    this.m_rgUdpAlive[slot] = 0;
    this.m_rgJoinTime[slot] = CGameClock.Now();
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
      let filled = 1; // host[0] occupies the first record
      for (let j = 0; j < UDP_HOST_CAPACITY - 1; j++) {
        if (hosts[j] === 0) continue;
        let found = false;
        for (let k = 0; k < filled; k++) {
          const at = UDP_HOST_RECORD_BYTES * k;
          const ip = ((base[at]! << 24) | (base[at + 1]! << 16) | (base[at + 2]! << 8) | base[at + 3]!) >>> 0;
          const port = (base[at + 4]! << 8) | base[at + 5]!;
          if (ip === hosts[j] && port === ports[j]) {
            found = true;
            break;
          }
        }
        if (!found && filled < UDP_HOST_CAPACITY) {
          const at = UDP_HOST_RECORD_BYTES * filled;
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
    const packet = new CSendPacket(S2C_GamePacket.OnUDPPeerInfo);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.m_rgPlayer[slot]) {
        packet.Encode1(1);
        const base = this.m_rgUdpHost[slot]!;
        for (let k = 0; k < UDP_HOST_CAPACITY; k++) {
          const at = UDP_HOST_RECORD_BYTES * k;
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
    const grace = this.m_fPlaying !== 0 ? UDP_JOIN_GRACE_PLAYING_MS : UDP_JOIN_GRACE_WAITING_MS;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user) continue;
      if (this.m_rgUdpAlive[slot] !== 0) continue;
      if (((CGameClock.Now() - this.m_rgJoinTime[slot]!) >>> 0) <= grace) continue;
      const ip = user.m_pSocket ? user.m_pSocket.GetInfoStr() : "";
      console.error(
        `[GS] User[${ip}:${user.GetName()}] (${user.m_pSocket?.GetUserCount() ?? 0}P) banned from game session (${this.m_nIdx}) while ${this.m_fPlaying !== 0 ? "<STARTING>" : "<WAITING>"} by udp loss`,
      );
      this.DumpLog();
      DestroySessionPlayer(user.m_pSocket!, 0);
      if (user.m_nFree === 0) {
        // [socket+244] == 0 — the IO-layer detach flag FXGS logic never sets,
        // so the port uses the connected flag
        const socket = user.m_pSocket;
        if (socket && socket.m_bConnected) {
          socket.SendPacket(new CSendPacket(S2C_GamePacket.OnUdpLossBan)); // 195, no payload
          socket.m_nPoolType = 4; // [socket+1D4]
        }
      }
    }
  }

  /** CGameSession::AddPlayer — strategy hooks around CListSession::AddPlayer. */
  override AddPlayer(socket: CClientSocket, selects: number[]): number {
    if (this.m_fPlaying !== 0) return 0;
    const freeSlots = socket.HasAuthority(AUTHORITY_JOIN_CLOSED) !== 0 ? this.GetNullSlotCount() : this.GetEmptySlotCount();
    if (freeSlots < socket.GetUserCount()) return 0;

    this.m_pStrategy.AddPlayer(socket);
    if (super.AddPlayer(socket, selects) === 0) {
      console.error("[GS] !CListSession::AddPlayer(pSocket, rgnBomber), CGameSession::AddPlayer");
      return 0;
    }
    if (socket.HasAuthority(AUTHORITY_JOIN_CLOSED) !== 0) {
      for (let i = 0; i < socket.GetUserCount(); i++) {
        this.DoOpenCloseSlot(this.GetSlotidx(socket.GetUser(i)), 1);
      }
    }
    this.m_pStrategy.SendSessionInfo(new CSendPacket(PACKET_TYPE_PLACEHOLDER));
    return 1;
  }

  /** CGameSession::DeleteUser (41D297) — game accounting around list removal. */
  override DeleteUser(slot: number): void {
    const user = this.m_rgPlayer[slot];
    if (this.fValid !== 0) {
      let incLose: boolean;
      if (this.m_nGamePhase === 1) {
        this.OnBomberDie(slot);
        incLose = this.m_DynInfoCalculator.IsInvalidGame() === 0;
      } else {
        incLose = this.m_nGamePhase === 0;
      }
      if (incLose) user?.IncLose();
    }
    super.DeleteUser(slot);
    this.m_aBomberIdx[slot] = -1;
    const host = this.m_rgUdpHost[slot]!;
    if (host.some((byte) => byte !== 0)) host.fill(0);
  }

  // ---- chief ----

  // ---- title ----

  // ---- room list packets (83/85/86/87) ----

  /** CGameSession::MakeSimpleInfoPacket — list packet plus strategy tail. */
  override MakeSimpleInfoPacket(packet: CSendPacket): void {
    super.MakeSimpleInfoPacket(packet);
    this.m_pStrategy.MakeSimpleInfoPacket(packet);
  }

  /** CGameSession::MakeCreatedPacket — list packet plus strategy tail. */
  override MakeCreatedPacket(packet: CSendPacket): void {
    super.MakeCreatedPacket(packet);
    this.m_pStrategy.MakeCreatedPacket(packet);
  }

  // ---- leaving ----

  /** CGameSession::DestroyPlayer — the full leave path (FxServer.exe.c:32692). */
  override DestroyPlayer(socket: CClientSocket, fSendReset: number): number {
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
    super.DestroyPlayer(socket, fSendReset);
    this.m_pStrategy.DestroyPlayer(socket); // vtbl+24 (FxServer.exe.c:32731)
    this.m_SyncGameObjMan.OnPlayerLeave(firstSlot);
    if (wasChief) {
      const oldSupreme = this.m_fSupreme;
      this.m_BanChief.Init(); // CBanChief::Init(+12576)
      this.SetNewChief(-1);
      if (this.m_nChiefSwapCount >= SUPREME_ROOM_SWAP_COUNT && oldSupreme === 0 && this.m_fSupreme !== 0 && this.m_fPlaying === 0) {
        dissolve = true;
      }
    }
    this.FlushPacket();
    this.DeleteAllSlotidx(socket);
    this.m_pStrategy.SendSessionInfo(new CSendPacket(PACKET_TYPE_PLACEHOLDER)); // vtbl+32 (:32746)
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
        const p = new CSendPacket(S2C_GamePacket.OnGhostDestroy);
        p.Encode1(ghost);
        this.SendPacket(p);
        this.m_rgSlotGhost[slot] = -1;
        this.m_rgGhostSlot[ghost] = -1;
      } else {
        const p = new CSendPacket(S2C_GamePacket.OnGhostGenerate);
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
    // The official Update stamps +12548 once per playing tick and reads it
    // back as the bomb-clock delta (FxServer.exe.c:34851/35056); +12552 is
    // write-once-zeroed (:32898) and never touched again.
    const time = timeGetTime();
    const prevTick = this.m_dwLastTickTime;
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
    if (this.m_GameClock.ElapsedTime() - this.m_GameClock.m_dwSuspended > GAME_DURATION_LIMIT_MS) {
      // the 3-minute play window (suspended time does not count) ran out
      this.SendGameResult(-1);
      this.m_GameClock.EndGame();
      this.m_nGamePhase = 2;
      return;
    }
    this.m_UdpLossRegulator.DeferRegulateConnection(this);
    const ctx = this.m_pCtx;
    // epoch-domain guard: the official runs on timeGetTime (bounded since
    // boot); Date.now() needs the 0 sentinel so the very first tick of a
    // process contributes no delta.
    const elapsed = prevTick === 0 ? 0 : (time - prevTick) >>> 0;
    let exploded = 0;
    if (ctx.m_nBombCount > 0) {
      // 152 — the bomb clock: every armed bomb counts down by the elapsed ms
      const packet = new CSendPacket(S2C_GamePacket.OnSetBombTimerRes);
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
            bomb.timer = EXPLODED_BOMB_FUSE_MS;
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
    let grace = TRAPPED_PLAYER_GRACE_MS;
    {
      let allDown = true;
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        const code = this.m_abDeleted[slot]!;
        if (code !== 3 && code !== 1 && code !== 4) {
          allDown = false;
          break;
        }
      }
      if (allDown) grace = ALL_PLAYERS_DOWN_GRACE_MS; // everybody down/goal/trapped: the short fuse
    }
    const packet2 = new CSendPacket(S2C_GamePacket.OnBomberEvent);
    packet2.Encode1(BOMBER_EVENT_MULTI_DIE_HEADER);
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
   * idle-room automatic-chief-removal gate.  Once CanStartGame succeeds, a
   * full room waits 10 s and a non-full room 20 s before packet 121 stage 0;
   * the following warning lasts another 10 s before stage 2 removes the
   * chief.  An odd-capacity room first has its own 5 s grace, stage 1 warning
   * and stage 3 removal.  "Item/SuperChief" changes the native timer
   * multiplier from 1 to 3, so every one of those periods becomes three
   * times longer and the packet's E2 warningSeconds is 30 rather than 10.
   * All elapsed comparisons are unsigned timeGetTime DWORD subtraction.
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

    // 41C1AC..41C1C2: EDI is a multiplier (1 normally, 3 for SuperChief).
    // It is passed to every GetWarningDelay/GetOddSlotInManner call; it is
    // not the timeGetTime value kept separately in the native stack local.
    const timerMultiplier = user.HasFunctionalItem(FunctionalItem.SuperChief) ? 3 : 1;
    const now = CGameClock.Now(); // timeGetTime
    const bc = this.m_BanChief;
    const warningDelay = bc.GetWarningDelay(timerMultiplier);
    const warningSeconds = Math.trunc(warningDelay / MILLISECONDS_PER_SECOND);

    let oddGate = false; // 41C238
    if (this.m_nGameType === 0) {
      // Plain rooms only enter the odd-slot sub-gate at capacity 0 or 1.
      if (this.m_nMaxPlayerNum > 1) {
        bc.SetOddSlot(0); // 41C202
      } else if (user.HasAuthority(AUTHORITY_BAN_CHIEF_BYPASS) !== 0) { // CUser::HasAuthority(AUTHORITY_BAN_CHIEF_BYPASS)
        bc.SetOddSlot(0); // 41C1F5 → 41C202 (CUser::HasAuthority)
      } else {
        oddGate = true;
      }
    } else {
      // Event rooms enter the sub-gate when their configured capacity is odd.
      if (this.m_nMaxPlayerNum % 2 === 0) {
        bc.SetOddSlot(0); // 41C1E4 even → 41C202
      } else if (user.HasAuthority(AUTHORITY_BAN_CHIEF_BYPASS) !== 0) { // CUser::HasAuthority(AUTHORITY_BAN_CHIEF_BYPASS)
        bc.SetOddSlot(0); // 41C1F5 → 41C202
      } else {
        oddGate = true;
      }
    }
    if (oddGate) {
      // 41C238 — GetOddSlotInManner receives the same 1/3 multiplier.
      if (bc.m_nOddSlot === 0) {
        bc.SetOddSlot(1);
      } else if (((now - bc.m_dwOddSlotTime) >>> 0) > bc.GetOddSlotInManner(timerMultiplier)) {
        if (bc.m_nWarnedBanOddSlot === 0) {
          bc.SetWarnedBanOddSlot(1);
          const p = new CSendPacket(S2C_GamePacket.OnNeedStartGame);
          p.Encode1(1);
          p.Encode2(warningSeconds);
          this.SendPacket(p);
        } else if (((now - bc.m_dwWarnedBanOddSlotTime) >>> 0) > warningDelay) {
          const p = new CSendPacket(S2C_GamePacket.OnNeedStartGame);
          p.Encode1(3);
          p.Encode2(warningSeconds);
          const chiefSocket = user.m_pSocket;
          chiefSocket.SendPacket(p); // vtbl+68 — the chief only
          DestroySessionPlayer(chiefSocket, 0); // table vtbl+48
          chiefSocket.m_nPoolType = 4; // 41C347, after DestroyPlayer reset it to 1
          bc.SetOddSlot(0); // 41C351 — not SetCanStart
          return;
        }
      }
    }

    // 41C211 — the ordinary start gate
    if (this.CanStartGame(1) !== 0) {
      bc.SetCanStart(0);
      return;
    }
    if (bc.m_nCanStart === 0) {
      bc.SetCanStart(1); // 41C231
      return;
    }

    // 41C35B — the first argument to IsBanChief is byte(+833) == byte(+832).
    if (user.HasAuthority(AUTHORITY_BAN_CHIEF_BYPASS) !== 0) return; // CUser::HasAuthority(AUTHORITY_BAN_CHIEF_BYPASS)
    const roomFull = this.m_nMaxPlayerNum === this.m_nCurPlayerNum ? 1 : 0;
    if (!bc.IsBanChief(roomFull, this.m_nGameType, timerMultiplier)) return;
    if (bc.m_nWarnedBan === 0) {
      bc.SetWarnedBan(1);
      const p = new CSendPacket(S2C_GamePacket.OnNeedStartGame);
      p.Encode1(0);
      p.Encode2(warningSeconds);
      this.SendPacket(p);
      return;
    }
    if (((now - bc.m_dwWarnedBanTime) >>> 0) <= warningDelay) return;

    const p = new CSendPacket(S2C_GamePacket.OnNeedStartGame);
    p.Encode1(2);
    p.Encode2(warningSeconds);
    const chiefSocket = user.m_pSocket;
    chiefSocket.SendPacket(p); // vtbl+68 — the chief only
    DestroySessionPlayer(chiefSocket, 0); // table vtbl+48
    chiefSocket.m_nPoolType = 4; // 41C462, after DestroyPlayer reset it to 1
    bc.SetCanStart(0); // 41C46C
  }

  /** CGameSession::DeferReturnPrepareStage (41B0B7) — 8 s after the end
   *  screen.  The original compares two timeGetTime-domain dwords
   *  (`timeGetTime() - m_dwEndTime > 0x1F40`); the >>> 0 keeps the delta
   *  in that unsigned domain across the 49.7-day wrap. */
  DeferReturnPrepareStage(): void {
    const sinceEnd = (CGameClock.Now() - this.m_GameClock.m_dwEndTime) >>> 0;
    if (sinceEnd > RETURN_STAGE_DELAY) this.DoReturnPrepareStage();
  }

  /** CGameSession::DoReturnPrepareStage (41B0DA). */
  DoReturnPrepareStage(): void {
    const packet = new CSendPacket(S2C_GamePacket.OnReturnPrepareStage);
    packet.Encode1(0);
    this.SendPacket(packet);
    this.m_nGamePhase = 0;
    this.m_nBanSerial = 0; // +828
    this.m_nGameMapIdx = -1; // +1180
    this.m_dwCreateTime = timeGetTime(); // +860 (a timeGetTime dword)
    this.SetPlaying(0);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      this.m_aBomberIdx[slot] = -1; // +11572
      this.m_rgSlotState[slot * 3] = this.m_rgSlotState[slot * 3]! & SLOTSTATE_GROUP_CLEAR;
    }
    // strategy vtbl+32 with a fresh buffer (:41B197's DoReturnPrepareStage
    // tail) — the base stub no-ops, the guild variant broadcasts an 88
    this.m_pStrategy.SendSessionInfo(new CSendPacket(PACKET_TYPE_PLACEHOLDER));
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
      // CUser::HasAuthority(AUTHORITY_ALWAYS_ZERO) is the constant-0 stub — skipped
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
   * finish state (2 goal / 6 win) equals this slot's GetMyTeamNo count while
   * another colour still has a pending my-team count.
   */
  GetWinGameResult(n8: number): number {
    const expected = this.m_DynInfoCalculator.GetMyTeamNo(n8); // +12208
    if (expected <= 2) return 0;
    const colour = this.GetColor(n8) & SLOTSTATE_COLOR_MASK;
    let otherPlaying = 0;
    for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
      if ((this.GetColor(k) & SLOTSTATE_COLOR_MASK) !== colour && this.m_DynInfoCalculator.GetMyTeamNo(k) > 2) otherPlaying = 1;
    }
    if (otherPlaying === 0) return 0;
    let finished = 0;
    for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
      if (this.m_abDeleted[k] === 2 || this.m_abDeleted[k] === 6) finished++;
    }
    return finished === expected ? 1 : 0;
  }

  /**
   * CGameSession::GetGameDetailResult (41CA78) — the winner slot's detail
   * byte: 3 for a premium ticket; 1 when GetOtherTeamNo == GetKillCount
   * (both > 2); 2 when that holds and GetMyTeamNo == GetSaveCount + 1
   * (both > 2).
   */
  GetGameDetailResult(n8: number): number {
    let result = 0;
    if (this.m_rgPlayer[n8]?.m_fPremiumTicket === 1) result = 3;
    const otherTeamNo = this.m_DynInfoCalculator.GetOtherTeamNo(n8); // +12240
    if (otherTeamNo > 2 && otherTeamNo === this.m_DynInfoCalculator.GetKillCount(n8)) {
      result = 1;
      const myTeamNo = this.m_DynInfoCalculator.GetMyTeamNo(n8); // +12208
      if (myTeamNo > 2 && myTeamNo === this.m_DynInfoCalculator.GetSaveCount(n8) + 1) return 2;
    }
    return result;
  }

  /**
   * CGameSession::SendGameResult (vtbl+216) — the results unit.
   *
   * The Taiwan client-compatible (2004-08-06 map) head is four bytes:
   * [E1 flag][E1 winTeam][E1 ladder][E1 diff-team item flag].  The matching
   * 2005-01-04 EXE added a strategy result-view byte between winTeam and
   * ladder; that newer five-byte head shifts every row for the original
   * client and makes it fail while decoding 163, so it is deliberately not
   * emitted here.  Per user: [E1 1][E4 serial][E1 result]
   * [E1 GetKillCount][E1 GetSaveCount][E2 exp‰][E2 exp‰ re-read]
   * [E2 look-level][E1 got-exp][E1 detail]; empty slots send [E1 0].
   * IncDecExp feeds the DB dyn rows, IncWin/IncLose/IncDraw the same
   * persistent dyn block, and level-ups re-sort the lobby rank list.
   */
  SendGameResult(winTeam: number): void {
    const packet = new CSendPacket(S2C_GamePacket.OnGameResult);
    const guildCalc = new CGuildDynInfoCalculator(); // the stack local at :36694
    const timeFactor = this.GetGameExpTimeFactor(); // v50 — the 41FE83 ladder
    let flag = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_abDeleted[i] === 5 || this.m_abDeleted[i] === 6 || this.m_abDeleted[i] === 7) flag = 1;
    }
    packet.Encode1(flag);
    packet.Encode1(winTeam & 0xff);
    // FxServer.map's client-compatible build goes straight from winTeam to
    // IsLadderGame.  The later EXE's m_pStrategy->GetResultViewType() byte is
    // the one-byte protocol insertion that the original client cannot parse.
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
      this.m_DynInfoCalculator.SetHasPremium(user.m_fPremiumTicket === 1 ? 1 : 0); // +12272
      if (!CMainSystem.IsPremiumChannel() && user.m_fPremiumTicket === 1) detail = 3;
      let result: number; // n3
      if (winTeam === -1) {
        result = 3;
        if (this.m_DynInfoCalculator.IsInvalidGame() === 0) {
          const exp = this.m_DynInfoCalculator.GetDrawExp(slot);
          gained = Math.trunc(exp * timeFactor);
          gotExp = user.IncDecExp(gained) > 0 ? 1 : 0;
          user.IncDraw(); // vtbl+180 (UserIncDraw)
          if (CMainSystem.ms_pInstance!.m_nChannelType === ACCOUNTING_LOG_CHANNEL_TYPE) console.error(`${user.GetName()}:D:${gained}`);
        }
      } else if ((this.GetColor(slot) & SLOTSTATE_COLOR_MASK) === winTeam) {
        result = this.GetWinGameResult(slot);
        if (this.m_DynInfoCalculator.IsInvalidGame() === 0) {
          let boost = 1.0; // v49
          if (diffTeamUsedItem !== 0) boost = 1.05;
          if (this.m_DynInfoCalculator.GetMyTeamNo(slot) >= 2) {
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
        if (this.m_DynInfoCalculator.IsInvalidGame() === 0) {
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
      packet.Encode1(this.m_DynInfoCalculator.GetKillCount(slot)); // +12048
      packet.Encode1(this.m_DynInfoCalculator.GetSaveCount(slot)); // +12016
      packet.Encode2(expPct);
      packet.Encode2(pctNow);
      packet.Encode2(user.GetLookLevel());
      packet.Encode1(gotExp);
      packet.Encode1(detail);
      if (gotExp !== 0) UpdateChannelRankList(user);
      this.m_pStrategy.SetGameResultPlayer(guildCalc, slot, gained, result); // vtbl+40 (:36841)
    }
    this.m_pStrategy.OnGameResult(guildCalc); // vtbl+36 (:36858)
    this.SendPacket(packet);
  }

  /** CGameSession::SendBigLuckMsg (:36478) — packet 10 [EStr] through the
   *  center link; CLocalServerMan::OnSystemMsg rebroadcasts it as CM 13. */
  SendBigLuckMsg(strMsg: string): void {
    const packet = new CSendPacket(MC_GameServerSendPacket.OnSystemMsg, CipherDegree.kPacketRaw);
    packet.EncodeStr(strMsg);
    SendCenterPacket(packet);
  }

  /** SendGameResult's time factor (the 41FE83 ladder). */
  private GetGameExpTimeFactor(): number {
    const elapsed = this.m_GameClock.ElapsedTime();
    if (elapsed < BIG_LUCK_RAMP_START_MS) return 0.0;
    if (elapsed <= BIG_LUCK_RAMP_END_MS) {
      return (elapsed - BIG_LUCK_RAMP_START_MS) / BIG_LUCK_RAMP_DURATION_MS;
    }
    return 1.0;
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
      console.error(`[GS] Null player sent socket. Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    if (b !== 1 && b !== 0) {
      console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: set player ready packet out of range.`);
      socket.PostClosePacket();
      return;
    }
    const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER);
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const user = socket.GetUser(i);
      if (!user) {
        console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: null user sent set player ready packet.`);
        socket.PostClosePacket();
        return;
      }
      const slot = this.GetSlotidx(user);
      if (slot >= MAX_SESSION_SLOTS) {
        console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: non-valid player sent set player ready packet.`);
        socket.PostClosePacket();
        return;
      }
      const p = slot * 3;
      if (b !== 0) {
        if ((this.m_rgSlotState[p]! & SLOTSTATE_GROUP_MASK) !== 0) {
          console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: set player ready packet [${b}] doesn't sync. Don't disconnect.`);
          return;
        }
        this.m_rgSlotState[p] = (this.m_rgSlotState[p]! & SLOTSTATE_GROUP_CLEAR) | SLOTSTATE_READY;
      } else {
        if ((this.m_rgSlotState[p]! & SLOTSTATE_GROUP_MASK) !== SLOTSTATE_READY) {
          console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: set player ready packet [${b}] doesn't sync. Don't disconnect.`);
          return;
        }
        this.m_rgSlotState[p] = this.m_rgSlotState[p]! & SLOTSTATE_GROUP_CLEAR;
      }
      this.MakeSetSlotStatePacket(slot, packet);
      this.PutPacket(packet);
    }
    this.FlushPacket();
  }

  /** CGameSession::OnSelectMap (0041C47D..0041C782). */
  OnSelectMap(n: CReceivedPacket, _socket: CClientSocket): void {
    const mapIdx = (n.Decode2() << 16) >> 16; // 0041C497: movsx edi, ax
    if (this.m_fPlaying === 0) {
      this.m_fModified |= SESSION_MODIFIED_MAP;
      this.m_nMapIdx = mapIdx;
    }
    const packet = new CSendPacket(S2C_GamePacket.OnSessionMapIdx);
    packet.Encode2(this.m_nMapIdx & 0xffff);
    this.PutPacket(packet);
    if (this.m_fPlaying === 0) this.FoldColorsForMap(mapIdx);
    // The map response and all slot updates are queued before the ONE flush.
    this.FlushPacket();
  }

  /** The OnSelectMap colour fold. Do not call SetColor: the original writes
   * the packed state directly, without the strategy's OnSelectColor hook. */
  private FoldColorsForMap(mapIdx: number): void {
    const maps = CGameMapTmplList.ms_pInstance;
    const teams = mapIdx === MAP_IDX_RANDOM ? MAX_SESSION_SLOTS
      : mapIdx >= 0 ? maps?.GetMapMaxTeam(mapIdx) ?? 0
      : maps?.GetThemeMaxMaxPlayer(GetThemeIdxFromMapIdx(mapIdx)) ?? 0;
    const colorMap = new Int32Array(MAX_SESSION_SLOTS).fill(-1);
    let usedColors = 0;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.IsPlayerSet(slot) && colorMap[this.GetColor(slot)] === -1) {
        usedColors++;
        colorMap[this.GetColor(slot)] = MAP_COLOR_IN_USE;
      }
    }

    const applyColor = (slot: number, color: number): void => {
      this.SetColorBits(slot, color);
      const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER);
      this.MakeSetSlotStatePacket(slot, packet);
      this.PutPacket(packet);
    };

    if (teams < usedColors) {
      if (teams >= 2 && teams <= MAP_TEAM_COLORS.length) {
        let next = 0;
        for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
          if (this.IsPlayerSet(slot)) applyColor(slot, MAP_TEAM_COLORS[next++ % teams]!);
        }
      }
      return;
    }

    if (teams >= 2 && teams <= MAP_TEAM_COLORS.length) {
      const palette = MAP_TEAM_COLORS.slice(0, teams);
      for (const color of palette) {
        if (colorMap[color] === MAP_COLOR_IN_USE) colorMap[color] = color;
      }
      for (let color = 0; color < MAX_SESSION_SLOTS; color++) {
        if (colorMap[color] !== MAP_COLOR_IN_USE) continue;
        const target = palette.find((entry) => colorMap[entry] !== entry);
        if (target !== undefined) {
          colorMap[color] = target;
          colorMap[target] = target;
        }
      }
    } else if (teams === MAX_SESSION_SLOTS) {
      for (let color = 0; color < MAX_SESSION_SLOTS; color++) colorMap[color] = color;
    }
    // For 5/6/7 teams (and the other switch defaults), the official leaves
    // MAP_COLOR_IN_USE intact: its low five bits become 0x11. Do not "correct" it.
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.IsPlayerSet(slot)) applyColor(slot, colorMap[this.GetColor(slot)]!);
    }
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
    this.SendPacket(new CSendPacket(S2C_GamePacket.OnGameTypeNormal));
  }

  /** CGameSession::SendGameTypeMod — +948 = 1, packet 92. */
  SendGameTypeMod(): void {
    this.m_nGameTypeMod = 1;
    this.SendPacket(new CSendPacket(S2C_GamePacket.OnGameTypeMod));
  }

  /** CGameSession::SendGameType — the join tail (92 or 93). */
  SendGameType(socket: CClientSocket): void {
    socket.SendPacket(new CSendPacket(this.m_nGameTypeMod !== 0 ? S2C_GamePacket.OnGameTypeMod : S2C_GamePacket.OnGameTypeNormal));
  }

  // ---- ban votes (104/105 → 113/114) ----

  // ---- title / emotion / team chat ----

  // ---- starting the game (106 → 115/116) ----

  /** CGameSession::CanStartGame (FxServer.exe.c:41C805) — 0 = go. */
  CanStartGame(fNeedMap: number): number {
    const counts = new Int32Array(MAX_SESSION_SLOTS);
    let players = 0;
    let teams = 0;
    const chiefSlot = this.m_nChiefSlotidx;
    const chiefUser = chiefSlot < MAX_SESSION_SLOTS ? this.m_rgPlayer[chiefSlot] : null;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user || user.HasAuthority(AUTHORITY_ALWAYS_ZERO) !== 0) continue;
      const state0 = this.m_rgSlotState[slot * 3]!;
      if (++counts[this.GetColor(slot)]! === 1) teams++;
      players++;
      if (chiefUser && chiefUser.m_pSocket === user.m_pSocket) {
        if ((state0 & SLOTSTATE_GROUP_MASK) !== 0) {
          // Native CanStartGame reports the anomalous chief state and calls
          // virtual DumpLog, but does not reject the start on this branch.
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
    const total = players; // GetExtraPlayerNo() == 0
    const totalTeams = teams; // GetExtraTeamNo() == 0
    if (total < 2) return 3;
    if (totalTeams < 2) return 5;
    const mapIdx = this.m_nGameMapIdx;
    const list = CGameMapTmplList.ms_pInstance!;
    if (mapIdx >= 0) {
      if (total > list.GetMapMaxPlayer(mapIdx)) return 4;
      if (chiefUser) {
        if (chiefUser.HasAuthority(AUTHORITY_LEVEL_BYPASS) !== 0) return 0;
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
    if (mapIdx === MAP_IDX_RANDOM) {
      mapIdx = CGameMapTmplList.ms_pInstance!.GetRandomMapIdx(this.m_nCurPlayerNum, level, -1, 0, gm, premiumTicket);
    } else if (mapIdx < 0) {
      mapIdx = CGameMapTmplList.ms_pInstance!.GetRandomMapIdx(this.m_nCurPlayerNum, level, GetThemeIdxFromMapIdx(mapIdx), 0, gm, premiumTicket);
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
      const packet = new CSendPacket(S2C_GamePacket.OnBomberEvent);
      packet.Encode1(BOMBER_EVENT_MULTI_DIE_HEADER);
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
    const packet = new CSendPacket(S2C_GamePacket.OnAirplaneItemProb);
    if (this.IsLadderGame() !== 0 && this.m_dwAirplaneItemProb > LADDER_AIRPLANE_PROBABILITY_CAP) {
      packet.Encode4(LADDER_AIRPLANE_PROBABILITY_CAP);
    } else {
      packet.Encode4(this.m_dwAirplaneItemProb >>> 0);
    }
    packet.Encode4(this.m_dwArg76 >>> 0);
    // fopen("iteminfo.txt", "r") — whitespace-split "%s %d" pairs, two
    // lists, each headed by its count. Fall back to server-ts/data/iteminfo.txt.
    let text: string;
    try {
      text = readFileSync("iteminfo.txt", "latin1");
    } catch {
      try {
        text = readFileSync(join(import.meta.dir, "..", "..", "data", "iteminfo.txt"), "latin1");
      } catch {
        return; // fopen null — no packet leaves the server
      }
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
    const packet = new CSendPacket(S2C_GamePacket.OnStartGame);
    // DoLaunchGameStageEx is an empty `retn` in the original
    packet.Encode4(timeGetTime()); // the 116 tick — a raw timeGetTime dword
    // the map idx rides through vtbl+24 = Encode2 (FxServer.exe.c:37289:
    // +28 E4 tick / +24 E2 mapIdx / +20 E1 cur) — an E4 here makes the
    // client read a garbage map index and crash on load
    packet.Encode2(this.m_nGameMapIdx & 0xffff);
    packet.Encode1(this.m_nCurPlayerNum); // +832 — GetPlayerNo(), not the max
    const tmpl = CGameMapTmplList.ms_pInstance!.m_apGameMapTmpl[this.m_nGameMapIdx];
    const spawns = Math.min(tmpl ? tmpl.m_nMaxPlayer : MAX_SESSION_SLOTS, MAX_SESSION_SLOTS);
    const order: number[] = [];
    for (let i = 0; i < spawns; i++) order.push(i);
    const random = CMainSystem.ms_pInstance!.m_WorkerRandom;
    random.random_shuffle(order); // forward STL swaps, before any bomber draws
    let next = 0;
    const attr = CBomberAttr.ms_pInstance!;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      this.m_aBomberIdx[slot] = -1;
      if (!this.IsPlayerSet(slot)) continue;
      let bomber = this.GetBomber(slot);
      if (bomber === attr.GetTotalCount() && attr.GetNormalCount() > 0) {
        if ((random.rand() % RANDOM_BOMBER_RARE_ROLL_DIVISOR) !== 0) {
          bomber = random.rand() % attr.GetNormalCount();
        } else {
          bomber = attr.GetNormalCount() + ((random.rand() % RANDOM_BOMBER_VARIANT_ROLL_DIVISOR) !== 0 ? 1 : 0);
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
    // 00420D66..00420DEF: initialise each valid seat's inclusive own-team
    // size and opposing-team size.  IsPlayerSet is virtual, so Practice AI
    // seats participate even though CDynInfoCalculator::Init only weights
    // real CUser objects.
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (!this.IsPlayerSet(slot)) continue;
      this.m_DynInfoCalculator.IncMyTeamNo(slot); // count the seat itself
      const color = this.GetColor(slot);
      for (let other = slot + 1; other < MAX_SESSION_SLOTS; other++) {
        if (!this.IsPlayerSet(other)) continue;
        if (color === this.GetColor(other)) {
          this.m_DynInfoCalculator.IncMyTeamNo(slot);
          this.m_DynInfoCalculator.IncMyTeamNo(other);
        } else {
          this.m_DynInfoCalculator.IncOtherTeamNo(slot);
          this.m_DynInfoCalculator.IncOtherTeamNo(other);
        }
      }
    }
    this.SetPlaying(1);
    // SetCurrentGameContext(0) + CGameContext::Init (FxServer.exe.c:37254)
    this.m_pCtx.Init();
    this.m_rgnUsedItem.fill(0); // memset(+11652, 0, 0x20)
    // FxServer.exe.c:37254 — single init of +11604 after context init.
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) this.m_abDeleted[slot] = this.IsPlayerSet(slot) ? 0 : 1;
    this.m_rgSlotGhost.fill(-1); // memset(+872, -1, 0x20)
    this.m_rgGhostSlot.fill(-1); // memset(+904, -1, 0x20)
    this.m_nGhostCount = 0; // +936
    this.m_dwLastGhostTime = 0; // +940
    this.m_dwLaunchTime = timeGetTime();
    this.m_nGhostStart = tmpl ? tmpl.m_nGhostStart : 0; // +12560 ← tmpl+60 (seconds; ×1000 at DoStartGame)
    this.m_nGhostFreq = tmpl ? tmpl.m_nGhostFreq : 0; // +12564 ← tmpl+64
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
      console.error(`[GS] Null player sent socket. Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] [Hacking suspected:${socket.GetInfoStr()}] No chief player exists but tried to start game, ${chiefSlot}`);
      this.DoBangPok();
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (!chiefUser || chiefUser.m_pSocket !== socket) {
      console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: Non-chief player request to start game`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_fPlaying !== 0) return;
    // fold the sub colors (1,2,4,7) onto the main ones (0,3,5,6):
    // color -> target map, -1 = untouched (:37490); in-use colors are marked
    // with themselves, a claimed main is consumed by writing 0 into its slot
    const colorMap = new Int32Array(MAX_SESSION_SLOTS).fill(-1);
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
    // OnRequestStartGame (FxServer.exe.c:37595): user+1984 is LEVEL, not exp (+212). The ticket argument
    // is a BOOL produced by comparing the byte at +2004 with exactly 1.
    this.SetMapIdxPlayingByLevel(chiefUser.m_nLevel, chiefUser.HasAuthority(AUTHORITY_LEVEL_BYPASS), chiefUser.m_fPremiumTicket === 1 ? 1 : 0);
    const can = this.CanStartGame(0);
    const res = new CSendPacket(S2C_GamePacket.OnStartGameRes);
    res.Encode1(can);
    socket.SendPacket(res);
    if (can !== 0) return;
    if (CGameMapTmplList.ms_pInstance!.GetMapMaxTeam(this.m_nGameMapIdx) < MAX_SESSION_SLOTS) {
      let changed = false;
      const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER);
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        if (!this.IsPlayerSet(slot)) continue;
        const want = colorMap[this.GetColor(slot)]!;
        if (this.GetColor(slot) !== want) {
          this.SetColorBits(slot, want);
          changed = true;
          this.MakeSetSlotStatePacket(slot, packet);
          this.PutPacket(packet);
        }
      }
      if (changed) this.FlushPacket();
    }
    this.LaunchGameStage();
    this.LaunchGameStageEx(); // native 00421205, vtbl+200; practice overrides it
  }

  /** CGameSession::DoLaunchGameStageEx (0041B1B3) — native empty hook. */
  DoLaunchGameStageEx(): void {}

  /** CGameSession::LaunchGameStageEx (004209B9) — normal rooms wait for
   * TCP109 + UDP readiness. Only this base implementation is an empty ret. */
  LaunchGameStageEx(): void {}

  /** CGameSession::OnHackingSuspected — 186 (FxServer.exe.c:36160). */
  OnHackingSuspected(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${socket.GetInfoStr()}].`);
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
      const p = new CSendPacket(S2C_GamePacket.OnHackingKick);
      p.Encode1(slot);
      this.SendPacketExclude(p, socket);
      socket.ForceSendAndClose(p);
      return;
    }
    console.error(`[GS] [${user0.GetName()}] reported [${target.GetName()}] committed hacking (${names[code]}).`);
    if (target.m_pSocket === socket) {
      console.error(`[GS] Hacking suspected [${target.GetName()}] (${socket.GetInfoStr()}) by itself. Disconnect.`);
      const p = new CSendPacket(S2C_GamePacket.OnHackingKick);
      p.Encode1(slot);
      this.SendPacketExclude(p, socket);
      socket.ForceSendAndClose(p);
      return;
    }
    let reports = 0;
    let players = 0;
    const reporterSlot = this.GetSlotidx(user0);
    if (reporterSlot >= 0 && reporterSlot < MAX_SESSION_SLOTS) this.m_rgVoteMatrix[slot * MAX_SESSION_SLOTS + reporterSlot] = 1;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i]) {
        players++;
        if (this.m_rgVoteMatrix[slot * MAX_SESSION_SLOTS + i] !== 0) reports++;
      } else if (this.m_rgVoteMatrix[slot * MAX_SESSION_SLOTS + i] !== 0) {
        console.error("[GS] Hacking Info Doesn't Sync");
        this.m_rgVoteMatrix[slot * MAX_SESSION_SLOTS + i] = 0;
      }
    }
    if (reports < Math.floor(players / 2)) return;
    console.error(`[GS] Hacking suspected [${target.GetName()}] by major of the session. Disconnect.`);
    const p = new CSendPacket(S2C_GamePacket.OnHackingKick);
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
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    const ctx = this.m_pCtx;
    if (ctx.m_nBombCount >= GAME_CONTEXT_BOMB_CAPACITY) {
      console.error(`[GS] Bomb array overflow. Disconnect user[${this.m_rgPlayer[slot]?.GetName()}] (${socket.GetInfoStr()})`);
      socket.PostClosePacket();
      return;
    }
    const pos = n.Decode1();
    const attr = n.Decode1();
    const bomb = {
      id: ctx.m_nBombIdCounter++,
      fMoving: 0,
      timer: NEW_BOMB_FUSE_MS,
      x: pos >> 4,
      y: pos & 0xf,
      sub: attr & 0xf,
      fFlag16: attr & BOMB_ATTR_FLAG16_MASK ? 1 : 0,
    };
    ctx.m_rgBomb[ctx.m_nBombCount] = bomb;
    const packet = new CSendPacket(S2C_GamePacket.OnBombIgniteRes);
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
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${socket.GetInfoStr()}].`);
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
    const packet = new CSendPacket(S2C_GamePacket.OnBombKickThrowRes);
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
    const packet = new CSendPacket(S2C_GamePacket.OnMovableBoxMoveRes);
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
      console.error(`[GS] Null player requested to eat item. Disconnect [${socket.GetInfoStr()}].`);
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
    if (box >= GAME_CONTEXT_BOX_CAPACITY) {
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
    const packet = new CSendPacket(S2C_GamePacket.OnRequestEatItemRes);
    packet.Encode1(slot);
    packet.Encode1(box);
    packet.Encode1(item);
    if (itemAttr.m_vtEffect[item] === 99) {
      let count = 1;
      // Native compares the user+2004 premium byte to exactly 1.
      if (eater && (eater.m_fPremiumTicket & 0xff) === 1) {
        count = (CMainSystem.ms_pInstance!.m_WorkerRandom.rand() % PREMIUM_LUCCI_COUNT_VARIANTS) + 1;
      }
      packet.Encode1(count);
      const lucci = count * itemAttr.m_vtAmount[item]!;
      if (lucci > SUSPICIOUS_LUCCI_AMOUNT) console.error(`[GS] suspicious on lucci amount ${lucci}`);
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
      console.error(`[GS] OnRequestEatObstacle User none [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    if (this.IsSlotInThisSocket(slot, socket) === 0) {
      console.error(`[GS] OnRequestEatObstacle slotidx and socket doesn't match: hacking suspected [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    const obstacleId = (pos & 0xf) + GAME_CONTEXT_TILE_COLUMNS * (pos >> 4);
    if (obstacleId >= GAME_CONTEXT_TILE_COUNT) {
      console.error(`[GS] Invalid obstacle id from user[${user0.GetName()}], Disconnect player`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_pCtx.m_rgnObstacle[obstacleId] !== 0) return;
    this.m_pCtx.m_rgnObstacle[obstacleId] = 1;
    const packet = new CSendPacket(S2C_GamePacket.OnRequestEatObstacleRes);
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
    const packet = new CSendPacket(S2C_GamePacket.OnBomberEvent);
    packet.Encode1(slotCode);
    packet.Encode2(a);
    packet.Encode2(b);
    const slot = slotCode & 0xf;
    const event = slotCode >> 4;
    if (slot >= MAX_SESSION_SLOTS || this.IsMySocket(slot, socket) === 0) {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    switch (event) {
      case 0:
        this.HandleUseSpecialItem(n, socket, slot, packet);
        break;
      case 1:
      case 7:
        this.SendPacketExclude(packet, socket);
        break;
      case 2:
        this.HandleTrapped(n, socket, slot, a, b, packet);
        break;
      case 3:
        this.HandleRescue(n, socket, slot, packet);
        break;
      case 4:
        this.HandleDeath(n, socket, slot, packet);
        return;
      case 5:
        console.error("[GS] user tried to send die by server packet");
        this.SendPacketExclude(packet, socket);
        break;
      case 6:
        this.m_abDeleted[slot] = 2;
        this.SendPacketExclude(packet, socket);
        break;
      case 8:
        this.HandleAuxEvent(n, socket, packet);
        break;
      default:
        console.error("[GS] user tried to send invalid set bomber event packet");
        return;
    }
  }

  private HandleUseSpecialItem(n: CReceivedPacket, socket: CClientSocket, slot: number, packet: CSendPacket): void {
    const ctx = this.m_pCtx;
    const x = n.Decode1();
    const itemidx = n.Decode1();
    const count = n.Decode1();
    if (count !== 0) {
      if (CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_NO_SHOP) {
        console.error(`[GS] ${this.m_rgPlayer[slot]?.GetName()} Try to Use ShopItem at NoShopItemServer`);
        return;
      }
      this.m_rgnUsedItem[slot] = 1;
      this.m_DynInfoCalculator.SetNice(slot, 1); // session +12112 = calculator +0x1AC
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
      console.error(`[GS] Illegal itemidx (UseSpecialItem). Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    const effect = itemAttr.m_vtEffect[itemidx]!;
    if (effect === 22) {
      if (this.m_abDeleted[slot] === 3) ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime() | 0;
    } else if (!((effect >= 11 && effect <= 13) || effect === 21 || (effect > 22 && effect <= 28) || effect === 31 || effect === 32)) {
      console.error(`[GS] Illegal item effect (UseSpecialItem). Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    packet.Encode1(x);
    packet.Encode1(itemidx);
    packet.Encode1(count);
    this.SendPacketExclude(packet, socket);
  }

  private HandleTrapped(_n: CReceivedPacket, socket: CClientSocket, slot: number, a: number, b: number, packet: CSendPacket): void {
    const ctx = this.m_pCtx;
    this.m_abDeleted[slot] = 3;
    ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime() | 0;
    ctx.m_rgnDiePos[GAME_CONTEXT_DIE_COORDS_PER_SLOT * slot] = a & 0xffff;
    ctx.m_rgnDiePos[GAME_CONTEXT_DIE_COORDS_PER_SLOT * slot + 1] = b & 0xffff;
    this.SendPacketExclude(packet, socket);
  }

  private HandleRescue(n: CReceivedPacket, socket: CClientSocket, slot: number, packet: CSendPacket): void {
    const saver = n.Decode1();
    if (saver < MAX_SESSION_SLOTS) this.m_DynInfoCalculator.SetSaverIndex(slot, saver);
    this.m_abDeleted[slot] = 0;
    this.SendPacketExclude(packet, socket);
  }

  private HandleDeath(n: CReceivedPacket, _socket: CClientSocket, slot: number, packet: CSendPacket): void {
    const ctx = this.m_pCtx;
    let killer = n.Decode1();
    killer = (killer << 24) >> 24; // signed char
    if (killer !== -1) this.m_DynInfoCalculator.SetKillerIndex(slot, killer);
    packet.Encode1(killer);
    this.OnBomberDie(slot);
    const drops = n.Decode1();
    packet.Encode1(drops);
    if (drops > 0) {
      for (let i = 0; i < drops; i++) {
        const obspos = n.Decode1();
        const boxpos = n.Decode1();
        ctx.m_rgnObstacle[(obspos & 0xf) + GAME_CONTEXT_TILE_COLUMNS * (obspos >> 4)] = 0;
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
  }

  private HandleAuxEvent(n: CReceivedPacket, socket: CClientSocket, packet: CSendPacket): void {
    const v = n.Decode1();
    const w = n.Decode1();
    packet.Encode1(v);
    packet.Encode1(w);
    this.SendPacketExclude(packet, socket);
  }

  /** CGameSession::OnSetEffect (147, FxServer.exe.c:41CA78) — the raw buffer relay. */
  OnSetEffect(n: CReceivedPacket, socket: CClientSocket): void {
    const packet = new CSendPacket(S2C_GamePacket.OnEffectRes);
    packet.EncodeBuffer(n.m_pBlock.subarray(n.m_uOffset), n.m_uLength - n.m_uOffset);
    this.SendPacketExclude(packet, socket);
  }

  /** CGameSession::OnDropObstacle (148, FxServer.exe.c:41B2E0). */
  OnDropObstacle(n: CReceivedPacket, socket: CClientSocket): void {
    const a = n.Decode1();
    const pos = n.Decode1();
    this.m_pCtx.m_rgnObstacle[(pos & 0xf) + GAME_CONTEXT_TILE_COLUMNS * (pos >> 4)] = 0;
    const packet = new CSendPacket(S2C_GamePacket.OnDropObstacleRes);
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
    const packet = new CSendPacket(S2C_GamePacket.OnSystemMsg); // id 30 (OnEventItemMsg shares the OnSystemMsg id)
    packet.EncodeStr(eater.GetName());
    this.SendPacket(packet);
  }

  /** CGameSession::OnDestroyBox (150, FxServer.exe.c:41B376) — a plain 3-byte relay. */
  OnDestroyBox(n: CReceivedPacket, _socket: CClientSocket): void {
    const a = n.Decode1();
    const b = n.Decode1();
    const c = n.Decode1();
    const packet = new CSendPacket(S2C_GamePacket.OnDestroyBoxRes);
    packet.Encode1(a);
    packet.Encode1(b);
    packet.Encode1(c);
    this.SendPacket(packet);
  }

  /** CGameSession::OnRequestGenerateGhost (151, FxServer.exe.c:41F3F1). */
  OnRequestGenerateGhost(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${socket.GetInfoStr()}].`);
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
        const packet = new CSendPacket(S2C_GamePacket.OnGhostGenerate);
        packet.Encode1(ghost);
        packet.Encode1(slot | GHOST_SLOT_NEW_FLAG);
        packet.Encode1(tag);
        this.SendPacket(packet);
      }
    }
  }

  /** CGameSession::DumpLog (vtbl+20, 41E0D5) — the room diagnostic: the
   *  header counters, the phase timing line and the eight seat lines. */
  DumpLog(): void {
    console.log(
      `[GS]     [${String(this.m_nIdx).padStart(3, "0")}]     Valid:${this.fValid}     Player:${this.m_nCurPlayerNum}/${this.m_nMaxPlayerNum}     Playing:${this.m_fPlaying}     Map:${this.m_nGameMapIdx}     Private:${this.m_fHasPassword}     MOD:${this.m_nGameTypeMod}     Chief:${this.m_nChiefSlotidx}`,
    );
    if (this.m_fPlaying !== 0) {
      const now = CGameClock.Now();
      const start = this.m_GameClock.m_dwStartTime;
      const end = this.m_GameClock.m_dwEndTime;
      const launch = this.m_dwLaunchTime;
      if (this.m_nGamePhase === 2) {
        // CxCenter-shaped columns: (now−end, end−start, start−launch)
        console.log(`[GS]               Game Over    Now:${String((now - end) >>> 0).padEnd(8)}   Start:${String((end - start) | 0).padEnd(8)}    LaunchTime:${(start - launch) | 0}`);
      } else if (this.m_nGamePhase === 1) {
        console.log(`[GS]               Playing      Now:${String((end - start) | 0).padEnd(8)}   Start:${String((start - launch) | 0).padEnd(8)}    LaunchTime:${launch}`);
      } else if (this.m_nGamePhase === 0) {
        console.log(`[GS]               Wait for UDP conn...        Now:${String((now - launch) >>> 0).padEnd(8)}      LaunchTime:${launch}`);
      }
    }
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      const player = this.m_rgPlayer[i];
      if (!player) {
        console.log(`[GS]           . slotidx(${i + 1}) : (NULL)`);
        continue;
      }
      const socket = player.m_pSocket;
      if (!socket) {
        console.log(`[GS]           . slotidx(${i}) : ${player.GetName()}(invalid socket ptr = 00000000)`);
        continue;
      }
      const b0 = this.m_rgSlotState[3 * i]!;
      const b2 = this.m_rgSlotState[3 * i + 2]!;
      console.log(
        `[GS]           . slotidx(${i + 1}) : ${player.GetName()}[${socket.bunSocket?.remoteAddress ?? ""}] (${socket.GetUserCount()}P)   bomber:color:chief:state=${this.m_aBomberIdx[i]}:${b2 & SLOTSTATE_COLOR_MASK}:${(b0 & SLOTSTATE_CHIEF) !== 0 ? 1 : 0}:${(b0 >> 2) & 7}`,
      );
    }
  }

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
      const packet = new CSendPacket(S2C_GamePacket.OnGhostDestroy);
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
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${socket.GetInfoStr()}].`);
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
    this.m_rgLapTime[LAP_RECORD_STRIDE * slot] = now | 0;
    this.m_rgLapRank[LAP_RECORD_STRIDE * slot] = rank;
    this.m_rgLapCount[slot] = lap;
    // the pairwise place table (times at +12632, ranks at +12636)
    const place = new Int32Array(MAX_SESSION_SLOTS).fill(1);
    let count = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i] && !(this.m_rgLapTime[LAP_RECORD_STRIDE * i] === -1 && this.m_rgLapRank[LAP_RECORD_STRIDE * i] === -1)) count++;
    }
    // the original packs {time, rank} into one u64 (time in the low dword,
    // rank in the high dword) and compares those — i.e. rank first, then time
    const lapKeyLessOrEqual = (a: number, b: number): boolean => {
      const rankA = this.m_rgLapRank[LAP_RECORD_STRIDE * a]! >>> 0;
      const rankB = this.m_rgLapRank[LAP_RECORD_STRIDE * b]! >>> 0;
      if (rankA !== rankB) return rankA < rankB;
      const timeA = this.m_rgLapTime[LAP_RECORD_STRIDE * a]! >>> 0;
      const timeB = this.m_rgLapTime[LAP_RECORD_STRIDE * b]! >>> 0;
      return timeA <= timeB;
    };
    for (let i = 0; i < MAX_SESSION_SLOTS - 1; i++) {
      if (!this.m_rgPlayer[i]) continue;
      for (let k = i + 1; k < MAX_SESSION_SLOTS; k++) {
        if (!this.m_rgPlayer[k]) continue;
        if (lapKeyLessOrEqual(i, k)) place[k]!++;
        else place[i]!++;
      }
    }
    const packet = new CSendPacket(S2C_GamePacket.OnLapInfoRes);
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
    if (((now - this.m_dwLastAirplaneTime) >>> 0) < AIRPLANE_COOLDOWN_MS) return; // the 7 s airplane gate, wrap-safe
    const count = n.Decode1();
    if (count === 0 || count > 3) console.error(`[GS] Strange Request Airplane, nCount=${count}`);
    const packet = new CSendPacket(S2C_GamePacket.OnRequestAirplaneRes);
    packet.Encode4((now + AIRPLANE_RESPONSE_LEAD_MS) >>> 0);
    packet.Encode1(count);
    const boxes: number[] = [];
    for (let i = 0; i < count; i++) {
      const a = n.Decode1();
      const box = n.Decode1();
      const b = n.Decode1();
      const c = n.Decode1();
      if (box >= GAME_CONTEXT_BOX_CAPACITY) {
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
    this.m_dwLastAirplaneTime = (now + AIRPLANE_RESPONSE_LEAD_MS) >>> 0;
    this.SendPacket(packet);
  }

  /** CGameSession::OnReqEatBula (160, FxServer.exe.c:41CBB2). */
  OnReqEatBula(n: CReceivedPacket, _socket: CClientSocket): void {
    const slot = n.Decode1();
    const count = n.Decode1();
    const packet = new CSendPacket(S2C_GamePacket.OnReqEatBulaRes);
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
  OnReqTakeHouse(n: CReceivedPacket, _socket: CClientSocket): void {
    const slot = n.Decode1();
    const total = n.Decode1();
    const color = this.GetColor(slot); // already masked — the SetHouseState team index
    const packet = new CSendPacket(S2C_GamePacket.OnReqTakeHouseRes);
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
    packet.Encode1(HOUSE_PACKET_TAIL);
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
    this.m_rgPlayer[slot]?.IncDecMoney(HOUSE_MONEY * taken);
  }

  /** CGameSession::OnShobuari (162, FxServer.exe.c:41CC8B) — settle the score, no packet. */
  OnShobuari(): void {
    let bestColor = -1;
    let bestScore = -1;
    let tie = 0;
    const present = new Uint8Array(MAX_SESSION_SLOTS);
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

  /**
   * CGameSession::OnNotifyUDPPacketLoss — practice-session packet-185 gate.
   * Live human peers feed the regulator only while neither endpoint is dead.
   */
  OnNotifyUDPPacketLoss(n: CReceivedPacket, socket: CClientSocket): void {
    const targetSlot = n.Decode1();
    if (targetSlot >= MAX_SESSION_SLOTS) return;
    const target = this.m_rgPlayer[targetSlot];
    if (!target || target.m_nFree !== 0) return;
    const sender = socket.GetUser(0);
    const senderSlot = sender?.m_nSlotIdx ?? MAX_SESSION_SLOTS;
    if (senderSlot >= MAX_SESSION_SLOTS) return;
    if (this.m_abDeleted[targetSlot] !== 0 || this.m_abDeleted[senderSlot] !== 0) return;

    n.m_uOffset = 0;
    n.Decode1();
    this.m_UdpLossRegulator.OnNotifyUdpLoss(n, socket);
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
    const senderSlot = user0 ? user0.m_nSlotIdx : MAX_SESSION_SLOTS;
    if (senderSlot >= MAX_SESSION_SLOTS) return;
    const packet = new CSendPacket(S2C_GamePacket.OnRequestUDPRelayRes);
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
    this.m_SyncGameObjMan.SetInitialObjNo(tmpl ? tmpl.m_nSyncGameObjCount : 0);
    this.m_nObj0 = -1; // +11612
    this.m_nObj1 = -1; // +11616
    this.m_GameClock.StartGame();
    ClearSessionModifiedFlag(this.m_nIdx); // the table vtbl+12
    this.m_nBombTickTime = 0; // +12552 (dword 3138)
    this.m_nGamePhase = 1;
    const packet = new CSendPacket(S2C_GamePacket.OnStartGame2);
    packet.Encode4(this.m_GameClock.m_dwStartTime); // dword 3184 — read after StartGame (FxServer.exe.c:32901)
    packet.Encode4((this.m_nGameSerial ^ this.m_nGameVersion) >>> 0);
    this.m_nGameSerial = (this.m_nGameSerial + 1) >>> 0;
    // the wire carries the RAW tmpl+60/+64 seconds (FxServer.exe.c:32906 and
    // :32908 encode this+3140/this+3141 before the *= 1000 at :32911-32912
    // rescales the server-side state) — the client rescales on its own
    packet.Encode4(this.m_nGhostStart);
    packet.Encode4(this.m_nGhostFreq);
    this.m_nGameType100 = tmpl ? tmpl.m_fReBirthMap : 0; // +12728 ← tmpl+100
    this.m_nGhostStart *= MILLISECONDS_PER_SECOND;
    this.m_nGhostFreq *= MILLISECONDS_PER_SECOND;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (!this.m_rgPlayer[slot]) this.m_rgUdpHost[slot]!.fill(0);
    }
    this.m_BanChief.Init(); // CBanChief::Init: SetOddSlot(0), then SetCanStart(0)
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
    const packet = new CSendPacket(S2C_GamePacket.OnSessionInfoDetailRes);
    packet.Encode1(SESSION_INFO_DETAIL_RESULT.Found); // the room exists (this branch only runs for a live one)
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (user === null) {
        packet.Encode1(SESSION_INFO_DETAIL_RESULT.NotFound);
        continue;
      }
      packet.Encode1(SESSION_INFO_DETAIL_RESULT.Found);
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
      console.error(`[GS] !this->CheckValidSocket(pSocket), CGameSession::OnPacket. Disconnect socket[${socket.GetInfoStr()}]`);
      console.error(`[GS]     User[${socket.GetUser(0)?.GetName() ?? "NULL"}], Game Session Slot Index: [${this.m_nIdx}]. CurrentPoolType=${socket.m_nPoolType}.`);
      socket.PostClosePacket();
      return;
    }
    switch (n.Decode1()) {
      case C2S_GameSessionPacket.OnSetPlayerReady:
        this.OnSetPlayerReady(n, socket);
        break;
      case C2S_GameSessionPacket.OnSelectMap:
        this.OnSelectMap(n, socket);
        break;
      case C2S_GameSessionPacket.OnSelectColor:
        this.OnSelectColor(n, socket);
        break;
      case C2S_GameSessionPacket.OnSelectBomber:
        this.OnSelectBomber(n, socket);
        break;
      case C2S_GameSessionPacket.OnOpenCloseSlot:
        this.OnOpenCloseSlot(n, socket);
        break;
      case C2S_GameSessionPacket.OnSetGameTypeNormal:
        this.OnSetGameTypeNormal(socket);
        break;
      case C2S_GameSessionPacket.OnSetGameTypeMod:
        this.OnSetGameTypeMod(socket);
        break;
      case C2S_GameSessionPacket.OnHostAskBanPlayer:
        this.OnHostAskBanPlayer(n, socket);
        break;
      case C2S_GameSessionPacket.OnRespondToBanPlayer:
        this.OnRespondToBanPlayer(n, socket);
        break;
      case C2S_GameSessionPacket.OnRequestStartGame:
        this.OnRequestStartGame(n, socket);
        break;
      case C2S_GameSessionPacket.OnRequestChangeTitle:
        this.OnRequestChangeTitle(n, socket);
        break;
      case C2S_GameSessionPacket.OnPlayEmotion:
        this.OnPlayEmotion(n, socket);
        break;
      case C2S_GameSessionPacket.OnReadyForImmediateStart:
        this.OnReadyForImmediateStart(n, socket);
        break;
      case C2S_GameSessionPacket.OnTeamChat:
        this.OnTeamChat(n, socket);
        break;
      case C2S_GameSessionPacket.OnBombIgnite:
        this.OnBombIgnite(n, socket);
        break;
      case C2S_GameSessionPacket.OnBombKickThrow:
        this.OnBombKickThrow(n, socket);
        break;
      case C2S_GameSessionPacket.OnSetBombTimer:
        this.OnSetBombTimer(n, socket);
        break;
      case C2S_GameSessionPacket.OnMovableBoxMove:
        this.OnMovableBoxMove(n, socket);
        break;
      case C2S_GameSessionPacket.OnRequestEatItem:
        this.OnRequestEatItem(n, socket);
        break;
      case C2S_GameSessionPacket.OnRequestEatObstacle:
        this.OnRequestEatObstacle(n, socket);
        break;
      case C2S_GameSessionPacket.OnSetBomberEvent:
        this.OnSetBomberEvent(n, socket);
        break;
      case C2S_GameSessionPacket.OnSetEffect:
        this.OnSetEffect(n, socket);
        break;
      case C2S_GameSessionPacket.OnDropObstacle:
        this.OnDropObstacle(n, socket);
        break;
      case C2S_GameSessionPacket.OnEventItem:
        this.OnEventItem(n, socket);
        break;
      case C2S_GameSessionPacket.OnDestroyBox:
        this.OnDestroyBox(n, socket);
        break;
      case C2S_GameSessionPacket.OnRequestGenerateGhost:
        this.OnRequestGenerateGhost(n, socket);
        break;
      case C2S_GameSessionPacket.OnRequestDestroyGhost:
        this.OnRequestDestroyGhost(n, socket);
        break;
      case C2S_GameSessionPacket.OnLapFinished:
        this.OnLapFinished(n, socket);
        break;
      case C2S_GameSessionPacket.OnLapInfo:
        this.OnLapInfo(n, socket);
        break;
      case C2S_GameSessionPacket.OnRequestAirplane:
        this.OnRequestAirplane(n, socket);
        break;
      case C2S_GameSessionPacket.OnReqCreateObj:
        this.m_SyncGameObjMan.OnReqCreateObj(n, socket);
        break;
      case C2S_GameSessionPacket.OnReqDestroyObj:
        this.m_SyncGameObjMan.OnReqDestroyObj(n, socket);
        break;
      case C2S_GameSessionPacket.OnReqEatBula:
        this.OnReqEatBula(n, socket);
        break;
      case C2S_GameSessionPacket.OnReqTakeHouse:
        this.OnReqTakeHouse(n, socket);
        break;
      case C2S_GameSessionPacket.OnShobuari:
        this.OnShobuari();
        break;
      case C2S_GameSessionPacket.OnNotifyUDPLoss:
        this.OnNotifyUDPLoss(n, socket);
        break;
      case C2S_GameSessionPacket.OnHackingSuspected:
        this.OnHackingSuspected(n, socket);
        break;
      case C2S_GameSessionPacket.OnNotifyUdpLossRegulator:
        // (+213 != 0 && +246 == 1) — only mid-game
        if (this.m_fPlaying !== 0 && this.m_nGamePhase === 1) this.m_UdpLossRegulator.OnNotifyUdpLoss(n, socket);
        break;
      default:
        break;
    }
  }
}

// Native GameSession.cpp classes kept behind a port-only ESM cycle boundary.
export { CGameClock, CGameContext } from "./runtime/GameSessionSupport.ts";
