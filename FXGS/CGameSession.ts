import { PlanGameTypeTransition } from "./GameTypeTransition.ts";
import {
  PlanNativeVoteTransition,
  type NativeVoteState,
} from "./VoteLifecycle.ts";
import { CBaseSession } from "./CBaseSession.ts";
import { PlanWaitingVoteJoin } from "./WaitingVoteJoin.ts";
import {
  PlanHostAskBanPlayer,
  PlanRespondToBanPlayer,
  MakeBanPlayerPacket,
  type BanPlayerObservation,
  type BanPlayerPlan,
} from "./BanPlayer.ts";
import {
  PlanBanPlayerCascade,
  type BanPlayerCascadePlan,
} from "./BanPlayerCascade.ts";
import { randomInt, randomUUID } from "node:crypto";
import { CListSession } from "./CListSession.ts";
import { MissionInfo } from "./MissionInfo.ts";
import type { CItemAttr, ItemAttr } from "./CItemAttr.ts";
import { CBanChief, type BanChiefState } from "./CBanChief.ts";
import { PlanDeferBanChief, MakeBanChiefPacket } from "./WaitingChief.ts";
import { CUdpLossRegulator } from "./CUdpLossRegulator.ts";
import { HOSTHANDLE, invalidHost } from "../Common/HOSTHANDLE.ts";
import type { CUser, UserDynamicSnapshot } from "../Common/CUser.ts";
import { CGameContext } from "./CGameContext.ts";
import {
  PlanTakeHouse,
  MakeTakeHousePacket,
  MakeTakeHouseRequest,
  type HouseCell,
  type HouseDropRequest,
} from "./HouseClaim.ts";
import { CDynInfoCalculator } from "../Common/CDynInfoCalculator.ts";
import { CGameClock } from "./CGameClock.ts";
import { CSyncGameObjMan } from "./CSyncGameObjMan.ts";
import { CGameSessionStrategy } from "./CGameSessionStrategy.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  ClientRequest,
  ServerResponse,
} from "../Common/Protocol/PacketTypes.ts";
import {
  SessionLimit,
  GameGhostAssignment,
  GameGhostRule,
  SlotStateMask,
  SessionModified,
  LimitedTeamColors,
  TeamLimit,
  GameType,
  StartGameResult,
  JoinSessionResult,
  ChannelType,
  GameStage,
  GamePlayerState,
  GamePosition,
  BombRule,
  BomberRandomRule,
  GameUDPFormat,
  GameConnectionTime,
  UserCount,
  GameContextLimit,
  RoundResultRule,
  GameDetailResult,
  BomberEvent,
  IntegerRange,
  GameResultRule,
  GameResultCategory,
  GameResultTiming,
  PlayerStateTimerRule,
  GameLaunchRule,
  GameLapRule,
  MapSelection,
  AirplaneItemRule,
  AirplaneRequestRule,
  GameItemType,
  GamePickupState,
  MoneyPickupRule,
  ItemThrowRule,
  SyncGameObjectRule,
  SpecialItemRule,
  BanChiefRule,
} from "../Common/OfficialValues.ts";
import type { _USERINVENTORY } from "../Common/DB/Rows.ts";
import { NormalizeID } from "../Common/CIDCompare.ts";
import {
  IsSpecialItemType,
  NormalizeSpecialItemRequest,
  MakeSpecialItemRequest,
  MakeSpecialItemPacket,
  CopySpecialItemInventory,
} from "./SpecialItemUse.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { EventItemAnnouncement } from "../Common/Protocol/OfficialMessages.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import type { CBomberAttr } from "./CBomberAttr.ts";
import type { CGameMapTmplList } from "./CGameMapTmplList.ts";
import type {
  CDBMan,
  GameResultSubmission,
  MoneyPickupSubmission,
  HouseClaimSubmission,
  SpecialItemUseSubmission,
} from "./CDBMan.ts";

/** Optional native-launch resources. Their presence never bypasses the full
 * room/CRC/peer checks or the durable result service requirement. Random is a
 * trusted test injection, not packet data; default is independent15-bit CSPRNG. */
export interface GameLaunchServices {
  readonly Items: CItemAttr;
  readonly Random?: () => number;
}
export interface GameSessionLaunchResources extends GameLaunchServices {
  readonly CreateClock?: () => CGameClock;
}

/** Pure extracted encoding/selection result, NOT a committed native launch.
 * No room state, socket, scoring record or clock is modified by its builder. */
export interface GameLaunchPacket {
  readonly MapIndex: number;
  readonly BomberIndices: readonly number[];
  readonly SpawnIndices: readonly number[];
  readonly Packet: CSendPacket;
}

/** Detached native money-pickup calculation, NOT a claim or durable receipt.
 * Only the clone is dirtied. A bonus preview consumes one trusted random draw;
 * no box, live wallet, clock, result baseline, or outbound queue is mutated. */
export interface MoneyPickupPreview {
  readonly Multiplier: number;
  readonly Delta: number;
  readonly DiagnosticAmountExceeded: boolean;
  readonly Before: UserDynamicSnapshot;
  readonly After: UserDynamicSnapshot;
  readonly Packet: CSendPacket;
}

/** Pure decision extracted from 0041D31A, NOT settlement. CountedSlots records
 * the native IncGame traversal prefix (it stops before a conflicting claimant).
 * Reading it does not increment the flush-cadence counter, stop a clock, emit
 * 163, or change stage.
 */
export interface GameEndDecision {
  readonly Ready: boolean;
  readonly Forced: boolean;
  readonly WinningColor: number;
  readonly ConflictingClaims: boolean;
  readonly CountedSlots: readonly number[];
}

/** Modern projection of native 163 effects, NOT a persistence receipt.
 * Money and GamesSinceFlush are intentionally unchanged by SendGameResult.
 * The native rank update is requested only on LevelDirection >0; not performed.
 */
export interface GameResultPlayerPreview {
  readonly Slot: number;
  readonly GlobalSerialNo: number;
  readonly Category: number;
  readonly KillCount: number;
  readonly SaveCount: number;
  readonly ExperienceDelta: number;
  readonly LevelDirection: number;
  readonly OldPercentage: number;
  readonly NewPercentage: number;
  readonly LookLevel: number;
  readonly LevelUp: boolean;
  readonly Detail: number;
  readonly WinMultiplier: number;
  readonly Before: UserDynamicSnapshot;
  readonly After: UserDynamicSnapshot;
}
export interface GameResultPreview {
  readonly WinningColor: number;
  readonly ElapsedMilliseconds: number;
  readonly ExperienceScale: number;
  readonly HasLapOrHouseState: boolean;
  readonly DifferentColorShopItemAttempted: boolean;
  readonly Players: readonly (GameResultPlayerPreview | undefined)[];
  readonly RankUpdateSlots: readonly number[];
  /** Detached copy; mutation cannot affect the live calculator. */
  readonly CalculatorAfterBytes: Buffer;
  readonly Packet: CSendPacket;
}

/** Modern storage/rank injection. No service means result commit is unavailable. */
/** Modern injection of the native table-owned removal/195/pool4 boundary.
 * No hook means graph consumption remains unavailable, not an imaginary lobby. */
export interface GameSessionRemovalServices {
  /** Opaque constructor-bound table issuer; never returned by plan/inspection. */
  readonly TableAuthority?: object;
  readonly EjectBanPlayer?: (room: CGameSession, socket: CClientSocket) => void;
  readonly EjectPlayerForUDP: (
    room: CGameSession,
    socket: CClientSocket,
    noticeUser?: CUser,
  ) => void;
  readonly IsCurrentSession?: (room: CGameSession) => boolean;
  readonly EjectChief?: (
    room: CGameSession,
    socket: CClientSocket,
    notice: CSendPacket,
    commitRemoval: (destroy: () => boolean) => boolean,
  ) => void;
}

export interface GameResultServices {
  readonly DB: CDBMan;
  readonly ChannelIndex: number;
  readonly UpdateRankList: (user: CUser) => void;
}
interface PendingGameResult {
  readonly Preview: GameResultPreview;
  readonly Submission: GameResultSubmission;
  readonly Fingerprint: string;
  readonly Occupants: readonly (CUser | undefined)[];
  readonly EndTick: number;
}
export type SpecialItemUseFailure = GameplayCommitFailure;
export interface SpecialItemUseState {
  readonly Sequence: number;
  readonly Pending: boolean;
  readonly Attempts: number;
  readonly Failure: SpecialItemUseFailure | undefined;
}
interface PendingSpecialItemUse {
  readonly Submission: Omit<SpecialItemUseSubmission, "Packet">;
  readonly PacketHex: string;
  readonly RequestHex: string;
  readonly Resource: ItemAttr;
  readonly Sender: CClientSocket;
  readonly Fingerprint: string;
  readonly Occupants: readonly (CUser | undefined)[];
  readonly Inventories: readonly (
    | Readonly<{ Container: _USERINVENTORY[]; Rows: readonly _USERINVENTORY[] }>
    | undefined
  )[];
}
interface PendingMoneyPickup {
  // Packet is held as immutable hex; every DB/transport call receives a copy.
  readonly Submission: Omit<MoneyPickupSubmission, "Packet">;
  readonly PacketHex: string;
  readonly After: UserDynamicSnapshot;
  readonly Fingerprint: string;
  readonly Occupants: readonly (CUser | undefined)[];
}
export type GameplayCommitFailure =
  | "conflict"
  | "storage"
  | "state-changed"
  | "stored-state-changed";
export type MoneyPickupFailure = GameplayCommitFailure;
export type HouseClaimFailure = GameplayCommitFailure;
/** Bounded modern diagnostics, never player IDs, wallet values or SQL errors. */
export interface MoneyPickupState {
  readonly Sequence: number;
  readonly Pending: boolean;
  readonly Attempts: number;
  readonly Failure: MoneyPickupFailure | undefined;
}
interface PendingHouseClaim {
  readonly Submission: Omit<HouseClaimSubmission, "Packet">;
  readonly PacketHex: string;
  readonly RequestHex: string;
  readonly After: UserDynamicSnapshot;
  readonly Fingerprint: string;
  readonly Occupants: readonly (CUser | undefined)[];
}
export interface HouseClaimState {
  readonly Sequence: number;
  readonly Pending: boolean;
  readonly Attempts: number;
  readonly Failure: HouseClaimFailure | undefined;
}
interface ResultRound {
  readonly RoundID: string;
  readonly StartTick: number;
  Pending: PendingGameResult | undefined;
  Durable: boolean;
  Applying: boolean;
  Returning: boolean;
  SpecialSequence: number;
  PendingSpecial: PendingSpecialItemUse | undefined;
  SpecialAttempts: number;
  SpecialFailure: SpecialItemUseFailure | undefined;
  HouseSequence: number;
  PendingHouse: PendingHouseClaim | undefined;
  HouseAttempts: number;
  HouseFailure: HouseClaimFailure | undefined;
  MoneySequence: number;
  PendingMoney: PendingMoneyPickup | undefined;
  MoneyAttempts: number;
  MoneyFailure: MoneyPickupFailure | undefined;
}
export type ResultPublicationFailure = "rank" | "packet" | "return-packet";

/** Modern per-round delivery-attempt counters; NOT transport acknowledgements.
 * Kept bounded rather than appending a record on every 400ms tick. */
export interface GameUpdatePublicationFailures {
  readonly BombTimer: number;
  readonly ServerDie: number;
}

interface PreparedVoteNativeStart {
  readonly Socket: CClientSocket | undefined;
  readonly Token: object;
  readonly StartTick: number;
  readonly Chief: Readonly<BanChiefState>;
  readonly Sequence: number;
  readonly InitialObjects: number;
  readonly Rebirth: boolean;
  readonly Packet: CSendPacket;
}
interface PreparedVoteLaunch {
  readonly Code: number;
  readonly States?: readonly Buffer[];
  readonly Launch?: GameLaunchPacket;
  readonly Airplane: CSendPacket | undefined;
  readonly Tick: number | undefined;
}
interface PreparedBanPlayerDeparture {
  readonly Socket: CClientSocket;
  readonly Policy: Readonly<BanPlayerCascadePlan>;
  readonly Sockets: readonly CClientSocket[];
  readonly Players: readonly (CUser | undefined)[];
  readonly Messages: readonly {
    Packet: CSendPacket;
    Targets: readonly CClientSocket[];
  }[];
  FinalChiefState?: Readonly<BanChiefState>;
  NativeStart: PreparedVoteNativeStart | undefined;
}
interface BanPlayerRemovalEntry {
  readonly Socket: CClientSocket;
  readonly Reset: Readonly<BanChiefState> | undefined;
  readonly Departure: PreparedBanPlayerDeparture | undefined;
  readonly NativeStart: PreparedVoteNativeStart | undefined;
}
/** Audited ordinary native launch/loading/recovery and durable result tail.
 * Normal waiting-chief/Loading/Running/Result Update is scheduled; special
 * modes and remaining events are NOT a complete playable/client-verified game. */
export class CGameSession extends CListSession {
  readonly m_pStrategy = new CGameSessionStrategy();
  readonly m_banChief = new CBanChief(() => this.m_gameClock.GetCurrentTime());
  /** Native+872 slot->ghost and +904 ghost->slot. Descriptive recovered roles,
   * not original field symbols. Public arrays are trusted internal state. */
  readonly m_anSlotGhost = new Int32Array(SessionLimit.Players).fill(
    GameGhostAssignment.NoGhost,
  );
  readonly m_anGhostSlot = new Int32Array(GameGhostRule.Capacity).fill(
    SessionLimit.NoSlot,
  );
  m_nGhostCount = 0; // native+936; leaving destruction notably does NOT decrement
  private m_bGameTransition = false;
  #liveBanPlayer:
    | {
        Target: number;
        Votes: readonly number[];
        Players: readonly (CUser | undefined)[];
      }
    | undefined;
  #banPlayerOperation = false;
  #preparedVoteStarts = new WeakSet<PreparedVoteNativeStart>();
  #expectedBanRemoval:
    | {
        Socket: CClientSocket;
        Reset: Readonly<BanChiefState> | undefined;
        NativeStart: PreparedVoteNativeStart | undefined;
        Consumed: boolean;
        Active: boolean;
        Guard: () => void;
      }
    | undefined;
  #tableRemovalStack: BanPlayerRemovalEntry[] = [];
  #waitingBanDeparture: PreparedBanPlayerDeparture | undefined;

  private m_nativeLaunchToken: object | undefined;
  private m_dwLaunchTime = 0;
  private m_dwGhostStart = 0;
  private m_dwGhostFrequency = 0;
  private m_dwLastGhostTime = 0;
  private readonly m_dwGameSequenceKey: number;
  private m_dwGameSequence: number;
  private m_bRebirthMap = false;
  readonly m_missionInfo = new MissionInfo();
  private m_dwAirplaneInitialTime = 0;
  private m_dwAirplaneFrequency = 0;
  // Native+12624: last SCHEDULED tick (request now+2000), NOT receipt time.
  // Kept descriptive inspection key; the next gate adds7000 to this DWORD.
  private m_dwLastAirplaneRequestTime = 0;
  // Native OnLapInfo sort records +12632 (time + inverted-coordinate DWORD),
  // not transmitted host pointers. Launch fills BOTH words withFFFFFFFF.
  private readonly m_adwLapSort = new Uint32Array(
    SessionLimit.Players * GameLaunchRule.LapSortWordsPerSlot,
  );
  private readonly m_adwLapPrefix = new Uint32Array(SessionLimit.Players);
  private readonly m_anOpaque11612 = new Int32Array(
    GameLaunchRule.OpaqueStartWords,
  ).fill(GameLaunchRule.InitialOpaqueStartWord);
  private m_dwOpaque12552 = 0;
  private m_bRemovingPlayer = false;
  private m_bDeletingPlayerRecords = false;
  private m_pRegulatingSocket: CClientSocket | undefined;
  private m_plannedChiefReset: Readonly<BanChiefState> | undefined;
  private m_nChiefWarningPublicationFailures = 0;
  // Native session+12548. Native start retains the last Loading Update tick;
  // ONLY the trusted Begin adapter supplies an explicit start-time anchor.
  private m_dwLastUpdateTime = 0;
  private m_bUpdating = false;
  private m_bPublishingUpdate = false;
  private m_nBombTimerPublicationFailures = 0;
  private m_nServerDiePublicationFailures = 0;
  private m_resultRound: ResultRound | undefined;
  private m_preparedRoundToken: object | undefined;
  private m_lastStartedRoundToken: object | undefined;
  private readonly m_departedRoundUsers = new Set<CUser>();
  private readonly m_resultPublicationFailures: ResultPublicationFailure[] = [];
  private m_nGameType: number = GameType.Normal;
  // MODERN waiting-mode issuance/epoch. Never a native combat/financial token.
  #waitingGameType: number = GameType.Normal;
  #gameTypeRevision = 0;
  // Native has one CGameContext at +1184, selected by GetCurrentGameContext.
  private readonly m_gameContext = new CGameContext();
  readonly m_dynInfoCalculator = new CDynInfoCalculator(
    () => this.channelType === ChannelType.Premium,
  );
  readonly m_syncGameObjMan = new CSyncGameObjMan();
  m_nGameState: number = GameStage.Loading;
  // Native +1180 and +11572: selected map and actual (possibly random) bomber.
  m_nMapIdxPlaying = -1;
  readonly m_aBomberIdxPlaying = new Int32Array(SessionLimit.Players).fill(-1);
  // Native +11604: multi-valued player-state byte, NOT a boolean.
  // Modern initialization removes the native pre-launch uninitialized read.
  readonly m_aPlayerState = new Uint8Array(SessionLimit.Players).fill(
    GamePlayerState.Inactive,
  );
  // Native +11652, cleared by full LaunchGameStage. OnSetBomberEvent kind0
  // sets it for a nonzero shop-item quantity BEFORE inventory lookup succeeds.
  // This proves an attempt flag, not confirmed consumption, billing or auth.
  readonly m_aShopItemAttempted = new Uint32Array(SessionLimit.Players);
  // Modern identity guard; statistics retain native launch colors/counts even
  // after someone leaves. A replacement user must NOT inherit an old slot's XP.
  private m_aRoundPlayers: readonly (CUser | undefined)[] | undefined;
  // Native +12940, +12948, +988 respectively. Endpoint padding is not retained.
  private readonly m_abUDPPeerReceived = new Uint8Array(SessionLimit.Players);
  private readonly m_adwPlayerJoinTime = new Uint32Array(SessionLimit.Players);
  private readonly m_aUDPHost: HOSTHANDLE[][] = Array.from(
    { length: SessionLimit.Players },
    () => Array<HOSTHANDLE>(GameUDPFormat.HostsPerSlot).fill(invalidHost),
  );
  readonly m_udpLossRegulator = new CUdpLossRegulator(() =>
    this.m_gameClock.GetCurrentTime(),
  );
  constructor(
    index: number,
    serial: number,
    title: string,
    password: string,
    manner: number,
    text: CTextCodec,
    readonly bombers: CBomberAttr,
    readonly maps: CGameMapTmplList,
    readonly channelType: number = ChannelType.Normal,
    private readonly m_gameClock = new CGameClock(),
    private readonly resultServices?: GameResultServices,
    private readonly removalServices?: GameSessionRemovalServices,
    private readonly launchServices?: GameLaunchServices,
  ) {
    super(index, serial, title, password, manner, text);
    // CGameSession::Init0041AD15: sequence starts at room serial; rand key is
    // per room generation, NOT refreshed each round or used as authentication.
    this.m_dwGameSequence = serial >>> 0;
    this.m_dwGameSequenceKey = this.DrawNativeRandom();
    // Defensive initialization before any network handler. Native initializes
    // these during LaunchGameStage; network use still requires that generation.
    this.m_gameContext.Init();
    this.m_syncGameObjMan.Init(this);
    this.m_dwStartChatTimeTick = m_gameClock.GetCurrentTime();
    this.m_banChief.Init();
  }
  protected override AddUser(
    user: CUser,
    slot: number,
    bomber: number,
    color: number,
  ): void {
    super.AddUser(user, slot, bomber, color);
    // Preserve native field reset BEFORE the fallible per-local clock read.
    this.#ResetJoinedPlayerState(slot);
    this.m_adwPlayerJoinTime[slot] = this.m_gameClock.GetCurrentTime();
  }
  #ResetJoinedPlayerState(slot: number): void {
    //0041AF4B; modern defensive endpoint/state clearing is preserved.
    this.m_aBomberIdxPlaying[slot] = -1;
    this.m_aPlayerState[slot] = GamePlayerState.Active;
    this.m_abUDPPeerReceived[slot] = 0;
    this.m_aUDPHost[slot]!.fill(invalidHost);
  }
  #InstallJoinedPlayerState(slot: number, tick: number): void {
    this.#ResetJoinedPlayerState(slot);
    this.m_adwPlayerJoinTime[slot] = tick;
  }
  private SocketSlots(socket: CClientSocket): number[] {
    if (
      socket.GetUserCount() < UserCount.Minimum ||
      socket.GetUserCount() > UserCount.Maximum
    )
      throw new CProtocolError("Invalid room socket player count");
    const slots = Array.from(socket.m_aUser, (user, self) => {
      if (!user) throw new CProtocolError("Missing local room player");
      const slot = user.m_nSlotIdx;
      if (
        slot < 0 ||
        slot >= SessionLimit.Players ||
        this.m_rgPlayer[slot] !== user ||
        user.IsSetFree() !== 0 ||
        user.m_pClientSocket !== socket ||
        user.GetSelfidx() !== self ||
        user.GetSessionIdx() !== this.m_nIdx ||
        user.GetSessionSerialNo() !== this.m_ulSerialNo
      )
        throw new CProtocolError(
          "Socket sender/player is not in this room generation",
        );
      return slot;
    });
    if (new Set(slots).size !== slots.length)
      throw new CProtocolError("Duplicate local-player room slots");
    return slots;
  }
  HasUDPPeerInfo(slot: number): boolean {
    this.AssertSlot(slot);
    return this.m_abUDPPeerReceived[slot] === 1;
  }
  GetUDPPeerHosts(slot: number): readonly HOSTHANDLE[] {
    this.AssertSlot(slot);
    return this.m_aUDPHost[slot]!.slice();
  }
  /** Modern read-only inspection of native+12948 join DWORDs; not a new packet.
   * Unlike discovery endpoints, DestroyPlayer must NOT reset this value. */
  GetPlayerJoinTime(slot: number): number {
    this.AssertSlot(slot);
    return this.m_adwPlayerJoinTime[slot]!;
  }
  /** Extracted TCP 120 encoder from 0041CE45: eight presence bytes; occupied
   * slots have three (DWORD address, WORD port) pairs and a join-time DWORD.
   * That last DWORD is NOT the user's global serial number. */
  MakeUDPPeerInfoPacket(): CSendPacket {
    const out = new CSendPacket(
      ServerResponse.UDPPeerInfo,
      undefined,
      this.text,
    );
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      const user = this.m_rgPlayer[slot];
      out.Encode1(user ? 1 : 0);
      if (user) {
        for (const host of this.m_aUDPHost[slot]!)
          out.Encode4(host.Address).Encode2(host.Port);
        out.Encode4(this.m_adwPlayerJoinTime[slot]!);
      }
    }
    return out;
  }
  /** 0041CE45. The dispatcher/table verify source IP, server, room generation.
   * Validate the WHOLE local-player group before committing either slot (native
   * marks flags during validation and can otherwise leave a half-updated pair).
   * Candidate indices are preserved: duplicate/zero addresses leave a HOLE,
   * not a compacted list. Same address with a DIFFERENT port is not a duplicate. */
  OnUDPPeerInfo(
    user: CUser,
    observed: HOSTHANDLE,
    addresses: readonly number[],
    ports: readonly number[],
  ): boolean {
    if (this.IsGameplayCommitPending()) return false;
    if (this.m_bGameTransition || this.m_bRemovingPlayer || this.m_bUpdating)
      throw new CProtocolError("UDP peer info during room transition/update");
    const socket = user.m_pClientSocket;
    if (!socket || !socket.m_aUser.includes(user))
      throw new CProtocolError("Detached UDP peer user");
    const slots = this.SocketSlots(socket);
    if (!observed.Address || !observed.Port)
      throw new CProtocolError("Invalid observed UDP peer endpoint");
    if (
      addresses.length !== GameUDPFormat.AdvertisedHostCount ||
      ports.length !== GameUDPFormat.AdvertisedHostCount
    )
      throw new CProtocolError("Expected two advertised UDP hosts");
    const candidates = addresses.map(
      (address, i) => new HOSTHANDLE(address, ports[i]!),
    );
    if (slots.some((slot) => this.HasUDPPeerInfo(slot))) return false;
    const hosts = Array<HOSTHANDLE>(GameUDPFormat.HostsPerSlot).fill(
      invalidHost,
    );
    hosts[0] = observed;
    for (const [i, candidate] of candidates.entries())
      if (
        candidate.Address !== 0 &&
        !hosts.slice(0, i + 1).some((host) => host.Equals(candidate))
      )
        hosts[i + 1] = candidate;
    if (
      this.m_nativeLaunchToken &&
      this.m_bPlaying &&
      this.m_nGameState === GameStage.Loading &&
      this.AllPlayerStartPredicate([], slots)
    )
      this.ValidateNativeStart();
    this.WithGameTransition(() => {
      for (const slot of slots) {
        this.m_aUDPHost[slot] = hosts.slice();
        this.m_abUDPPeerReceived[slot] = 1;
      }
      this.SendPacket(this.MakeUDPPeerInfoPacket());
      if (this.m_bPlaying && this.m_nGameState === GameStage.Loading)
        this.TryStartGame();
    });
    return true;
  }
  /** 0041AFFE: ready bit 0x08 ALONE is insufficient; peer discovery is required
   * for EVERY occupied slot. Empty rooms must never start vacuously. */
  IsAllPlayerReadyForStart(): boolean {
    return this.AllPlayerStartPredicate([], []);
  }
  private AllPlayerStartPredicate(
    readySlots: readonly number[],
    peerSlots: readonly number[],
  ): boolean {
    return (
      this.GetCurPlayer() > 0 &&
      this.m_rgPlayer.every(
        (user, slot) =>
          !user ||
          ((peerSlots.includes(slot) || this.HasUDPPeerInfo(slot)) &&
            (readySlots.includes(slot) ||
              (this.m_rgSlotInfo[slot]![0]! & SlotStateMask.Status) ===
                SlotStateMask.ReadyForStart)),
      )
    );
  }
  /** TCP 109 / 0041D431. UDP type 1 instead reaches the empty 0041B506 overload.
   * CRC and four bytes per local player: actual bomber, default count/power/speed.
   * Parse and validate BOTH local players before changing either ready bit. */
  OnReadyForImmediateStart(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): void {
    if (this.m_bGameTransition || this.m_bRemovingPlayer || this.m_bUpdating)
      throw new CProtocolError(
        "Loading response during room transition/update",
      );
    if (!this.m_bPlaying || this.m_nGameState !== GameStage.Loading) return;
    const slots = this.SocketSlots(socket);
    if (this.m_nMapIdxPlaying < 0)
      throw new CUnsupportedOperation("loading context", "no selected map");
    const crc = packet.Decode4();
    const attributes = slots.map(() => ({
      bomber: packet.Decode1(),
      count: packet.Decode1(),
      power: packet.Decode1(),
      speed: packet.Decode1(),
    }));
    packet.AssertEnd();
    if (crc !== this.maps.GetCRC(this.m_nMapIdxPlaying))
      throw new CProtocolError("Loading map CRC mismatch", "map-crc-mismatch");
    for (const [i, slot] of slots.entries()) {
      const actual = attributes[i]!;
      if (actual.bomber !== this.m_aBomberIdxPlaying[slot])
        throw new CProtocolError("Loading bomber index mismatch");
      if (
        actual.count !== this.bombers.GetDefBombCount(actual.bomber) ||
        actual.power !== this.bombers.GetDefBombPower(actual.bomber) ||
        actual.speed !== this.bombers.GetDefSpeed(actual.bomber)
      )
        throw new CProtocolError("Loading bomber attributes mismatch");
    }
    if (this.m_nativeLaunchToken && this.AllPlayerStartPredicate(slots, []))
      this.ValidateNativeStart();
    this.WithGameTransition(() => {
      for (const slot of slots)
        this.m_rgSlotInfo[slot]![0] =
          (this.m_rgSlotInfo[slot]![0]! & ~SlotStateMask.Status) |
          SlotStateMask.ReadyForStart;
      this.TryStartGame();
    });
  }
  /** 0041BF1B. Direct trusted calls cannot manufacture a native launch token. */
  DeferStartGame(): void {
    if (this.m_bUpdating || this.m_bRemovingPlayer)
      throw new CProtocolError("Deferred start during room update/removal");
    this.WithGameTransition(() => this.TryStartGame());
  }
  private TryStartGame(prepared?: PreparedVoteNativeStart): void {
    if (
      !this.m_bPlaying ||
      this.m_nGameState !== GameStage.Loading ||
      !this.IsAllPlayerReadyForStart()
    )
      return;
    if (
      !this.m_nativeLaunchToken ||
      this.m_nativeLaunchToken !== this.m_preparedRoundToken
    )
      throw new CUnsupportedOperation(
        "CGameSession::DoStartGame",
        "no complete native launch generation attached; no fabricated 150",
      );
    this.DoStartGame(prepared);
  }
  /** Source's 0041DC31 loading-only timeout block. Returns unique sockets to
   * remove, WITHOUT making up pool-type-4 recovery or scheduling a partial loop.
   * Native's 30s fallback can be selected after removals clear m_bPlaying mid-loop;
   * that changing-state case belongs to the not-yet-ported complete Update. */
  GetExpiredUDPPeerSockets(): CClientSocket[] {
    if (!this.m_bPlaying || this.m_nGameState !== GameStage.Loading) return [];
    const time = this.m_gameClock.GetCurrentTime();
    return this.GetSockets().filter((socket) =>
      this.SocketSlots(socket).some(
        (slot) =>
          !this.HasUDPPeerInfo(slot) &&
          (time - this.m_adwPlayerJoinTime[slot]!) >>> 0 >
            GameConnectionTime.LoadingPeerTimeoutMs,
      ),
    );
  }
  /** 185 / 0041D0BC: notify the target about the reporting primary slot.
   * TCP response 54; the client's exact reaction is not verified. This does
   * NOT implement Relay registration, forwarding or a new endpoint packet.
   * Target native CUser+20 is CSafeObject::IsSetFree, not GetSelfidx. */
  OnNotifyUDPLoss(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const slots = this.SocketSlots(socket);
    const target = packet.Decode1();
    packet.AssertEnd();
    this.AssertSlot(target);
    const user = this.m_rgPlayer[target];
    if (!user || user.IsSetFree() !== 0) return;
    user.m_pClientSocket?.SendPacket(
      new CSendPacket(
        ServerResponse.UDPPeerNotice,
        undefined,
        this.text,
      ).Encode1(slots[0]!),
    );
  }
  /** 186 / 0041D6E7. Like 185 this decodes ONE target slot and sends 54
   * containing the sender's PRIMARY room slot to the TARGET socket. Additional
   * condition: the reporting primary's +11604 inactive byte must not be one.
   * Neither handler registers, configures, or forwards through the Relay. */
  OnRequestUDPRelay(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const slots = this.SocketSlots(socket);
    const target = packet.Decode1();
    packet.AssertEnd();
    this.AssertSlot(target);
    if (this.m_aPlayerState[slots[0]!] === GamePlayerState.Inactive) return;
    const user = this.m_rgPlayer[target];
    if (!user || user.IsSetFree() !== 0) return;
    user.m_pClientSocket?.SendPacket(
      new CSendPacket(
        ServerResponse.UDPPeerNotice,
        undefined,
        this.text,
      ).Encode1(slots[0]!),
    );
  }
  /** Pure ordinary-room slice of LaunchGameStage 00420BB3. Builds 116 and the
   * resolved bomber/spawn arrays but DOES NOT launch, send, initialize scoring,
   * or modify m_bPlaying. Random-map selection / team remapping stay separate.
   * Native STL forward shuffle consumes (map capacity - 1) CRT draws first. */
  MakeLaunchGameStagePacket(
    mapIndex: number,
    random: () => number = () => randomInt(BomberRandomRule.NativeRandomRange),
    slotStates: readonly Uint8Array[] = this.m_rgSlotInfo,
  ): GameLaunchPacket {
    if (
      this.m_nGameType !== GameType.Normal ||
      this.channelType === ChannelType.Guild
    )
      throw new CUnsupportedOperation(
        "loading packet variant",
        "ordinary normal rooms only",
      );
    if (
      slotStates.length !== SessionLimit.Players ||
      Array.from(slotStates).some((state) => state?.length !== 3)
    )
      throw new CProtocolError("Invalid launch slot-state snapshot");
    const capacity = this.maps.GetMapMaxPlayer(mapIndex);
    if (!this.GetCurPlayer() || this.GetCurPlayer() > capacity)
      throw new CProtocolError("Invalid loading map capacity");
    const draw = (): number => {
      const value = random();
      if (
        !Number.isInteger(value) ||
        value < 0 ||
        value >= BomberRandomRule.NativeRandomRange
      )
        throw new CProtocolError("Invalid native-range random draw");
      return value;
    };
    const packet = new CSendPacket(
      ServerResponse.LaunchGameStage,
      undefined,
      this.text,
    )
      .Encode4(this.m_gameClock.GetCurrentTime())
      .Encode2(mapIndex)
      .Encode1(this.GetCurPlayer());
    const positions = Array.from({ length: capacity }, (_, i) => i);
    for (let i = 1; i < positions.length; i++) {
      const j = draw() % (i + 1);
      [positions[i], positions[j]] = [positions[j]!, positions[i]!];
    }
    const actualBombers = Array<number>(SessionLimit.Players).fill(-1);
    const spawns = Array<number>(SessionLimit.Players).fill(-1);
    let spawn = 0;
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      if (!this.m_rgPlayer[slot]) continue;
      let bomber = slotStates[slot]![1]! & SlotStateMask.Bomber;
      if (bomber === this.bombers.GetRandomBomberIdx()) {
        const normal = this.bombers.GetNormalCount();
        if (
          normal <= 0 ||
          this.bombers.GetTotalCount() - normal !==
            BomberRandomRule.RequiredRandomOnlyCount
        )
          throw new CProtocolError("Unsupported random-only bomber layout");
        if (draw() % BomberRandomRule.RandomOnlyBranchModulo !== 0)
          bomber = draw() % normal;
        else
          bomber =
            normal +
            (draw() % BomberRandomRule.SecondRandomOnlyModulo !== 0 ? 1 : 0);
      }
      if (bomber < 0 || bomber >= this.bombers.GetTotalCount())
        throw new CProtocolError("Invalid loading bomber index");
      const position = positions[spawn++]!;
      actualBombers[slot] = bomber;
      spawns[slot] = position;
      packet
        .Encode1(slot)
        .Encode1(0)
        .Encode1(position)
        .Encode1(bomber)
        .Encode1(slotStates[slot]![2]! & SlotStateMask.Color);
    }
    return Object.freeze({
      MapIndex: mapIndex,
      BomberIndices: Object.freeze(actualBombers),
      SpawnIndices: Object.freeze(spawns),
      Packet: packet,
    });
  }
  /** Pure 150 encoder extracted from DoStartGame 0041BDCF. The two ghost timing
   * DWORDs are sent as SECONDS, before native converts its countdowns to ms.
   * XOR DWORD is opaque: no claim that this is a cryptographic anti-cheat token.
   * This method does NOT start the clock, increment state, or send anything. */
  MakeBeginGamePacket(
    mapIndex: number,
    startTime: number,
    sequence: number,
    xorKey: number,
  ): CSendPacket {
    for (const value of [startTime, sequence, xorKey])
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw new CProtocolError("Invalid begin-game DWORD");
    return new CSendPacket(ServerResponse.BeginGame, undefined, this.text)
      .Encode4(startTime)
      .Encode4((sequence ^ xorKey) >>> 0)
      .Encode4(this.maps.GetMapGhostStart(mapIndex))
      .Encode4(this.maps.GetMapGhostFreq(mapIndex));
  }
  private DrawNativeRandom(source?: () => number): number {
    const value = source
      ? source()
      : this.launchServices?.Random
        ? this.launchServices.Random()
        : randomInt(BomberRandomRule.NativeRandomRange);
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value >= BomberRandomRule.NativeRandomRange
    )
      throw new CProtocolError("Invalid native-range random draw");
    return value;
  }
  /** Modern detached publication: callbacks see a finished transition, never
   * half-initialized launch/clock/statistics. Native synchronous send timing is
   * intentionally not claimed; transport errors are bounded attempt counters. */
  private WithGameTransition<T>(action: () => T): T {
    if (this.m_bGameTransition)
      throw new CProtocolError("Reentrant game transition");
    this.m_bGameTransition = true;
    this.BeginPacketBatch();
    try {
      return action();
    } finally {
      try {
        this.EndPacketBatch();
      } finally {
        this.m_bGameTransition = false;
      }
    }
  }
  private RequireLaunchServices(): GameLaunchServices {
    if (!this.launchServices || !this.resultServices)
      throw new CUnsupportedOperation(
        "CGameSession::DoStartGame",
        "full launch resources / durable result services absent; no fabricated start success",
      );
    this.RequireOrdinaryResultLifecycle();
    this.#AssertOwnedBanPlayerState();
    if (this.#liveBanPlayer) this.#RequireLiveBanPlayerScope();
    return this.launchServices;
  }
  /** 0041C9C4. Native calls this BEFORE CanStartGame, even on a failed request.
   * +1180 is separate from the signed WORD waiting-room selection+850. */
  SetMapIdxPlayingByLevel(
    level: number,
    authority23: number,
    authencodeOne: boolean,
  ): void {
    if (
      this.m_bGameTransition ||
      this.m_bUpdating ||
      this.m_bRemovingPlayer ||
      this.m_bPlaying ||
      this.m_resultRound
    )
      throw new CProtocolError(
        "Playing-map selection during active room transition",
      );
    this.SelectPlayingMap(level, authority23, authencodeOne);
  }
  private SelectPlayingMap(
    level: number,
    authority23: number,
    authencodeOne: boolean,
  ): void {
    const selected = this.m_nMapIdx;
    this.m_nMapIdxPlaying =
      selected >= 0
        ? selected
        : this.maps.GetRandomMapIdx(
            this.GetCurPlayer(),
            level,
            selected === MapSelection.Random
              ? -1
              : MapSelection.FirstTheme - selected,
            0,
            authority23,
            authencodeOne,
            this.channelType,
            () => this.DrawNativeRandom(),
          );
  }
  MakeStartColorStates(mapIndex: number): Buffer[] {
    const states = this.m_rgSlotInfo.map((state) => Buffer.from(state));
    const mapping = Array<number>(TeamLimit.Colors).fill(-1);
    for (let slot = 0; slot < SessionLimit.Players; slot++)
      if (this.m_rgPlayer[slot]) {
        const color = states[slot]![2]! & SlotStateMask.Color;
        if (color >= TeamLimit.Colors)
          throw new CProtocolError("Invalid launch team color");
        mapping[color] = color;
      }
    if (this.maps.GetMapMaxTeam(mapIndex) >= TeamLimit.Colors) return states;
    for (const color of GameLaunchRule.RemappedColors)
      if (mapping[color] !== -1) {
        const target = LimitedTeamColors.find(
          (candidate) => mapping[candidate] === -1,
        );
        if (target !== undefined) {
          mapping[color] = target;
          mapping[target] = 0;
        }
      }
    for (let slot = 0; slot < SessionLimit.Players; slot++)
      if (this.m_rgPlayer[slot]) {
        const state = states[slot]!;
        state[2] =
          (state[2]! & ~SlotStateMask.Color) |
          mapping[state[2]! & SlotStateMask.Color]!;
      }
    return states;
  }
  /** 004204EB ordinary branch. Missing iteminfo produces no173; weights and
   * item IDs are preserved bytes, not normalized or interpreted as loot odds. */
  MakeAirplaneItemProbPacket(mapIndex: number): CSendPacket | undefined {
    const services = this.RequireLaunchServices(),
      map = this.maps.GetMapTmpl(mapIndex);
    const entries = services.Items.GetAirplaneItemProbability(
      map.m_aMissionInfo[0]!,
    );
    if (!entries) return;
    const initial =
      this.IsLadderGame() &&
      map.m_nAirplaneInitialTime > AirplaneItemRule.LadderInitialTimeMaximumMs
        ? AirplaneItemRule.LadderInitialTimeMaximumMs
        : map.m_nAirplaneInitialTime;
    const packet = new CSendPacket(
      ServerResponse.AirplaneItemProbability,
      undefined,
      this.text,
    )
      .Encode4(initial)
      .Encode4(map.m_nAirplaneFrequency)
      .Encode1(entries.length);
    for (const entry of entries)
      packet.Encode1(entry.ItemIndex).Encode1(entry.Weight);
    return packet;
  }
  /** 00420F19. Plan/validate all predictable errors BEFORE115 success. Original
   * GetRandomMapIdx/CanStart failure codes/order and changed-only107 are retained.
   * Kernel-only rooms without injected services still cannot unlock by106. */
  OnRequestStartGame(packet: CReceivedPacketBase, socket: CClientSocket): void {
    packet.AssertEnd();
    this.RequireChief(socket);
    if (this.m_bRemovingPlayer || this.m_bUpdating || this.m_bGameTransition)
      throw new CProtocolError("Start during room transition/update/removal");
    if (this.m_bPlaying) return;
    if (this.m_resultRound || this.m_nGameState !== GameStage.Loading)
      throw new CProtocolError("Start requires an idle prepare stage");
    if (!this.launchServices || !this.resultServices) {
      const code = this.CanStartGame();
      if (!code) this.RequireLaunchServices();
      socket.SendPacket(
        new CSendPacket(ServerResponse.StartGame, undefined, this.text).Encode1(
          code,
        ),
      );
      return;
    }
    this.WithGameTransition(() => {
      const p = this.#liveBanPlayer
        ? this.#WithVoteLifecyclePreparation(
            (stable) => this.#PrepareRequestVoteLaunch(stable),
            true,
          )
        : this.#PrepareRequestVoteLaunch(() => {});
      this.QueuePacketTo(
        new CSendPacket(ServerResponse.StartGame, undefined, this.text).Encode1(
          p.Code,
        ),
        [socket],
      );
      if (p.Code) return;
      for (let slot = 0; slot < SessionLimit.Players; slot++)
        if (
          this.m_rgPlayer[slot] &&
          !p.States![slot]!.equals(this.m_rgSlotInfo[slot]!)
        ) {
          p.States![slot]!.copy(this.m_rgSlotInfo[slot]!);
          this.PutPacket(this.MakeSetSlotStatePacket(slot));
        }
      this.LaunchGameStage(p.Launch!, p.Airplane, p.Tick);
    });
  }
  #PrepareRequestVoteLaunch(stable: () => void): PreparedVoteLaunch {
    this.RequireLaunchServices();
    stable();
    for (const peer of this.GetSockets()) {
      if (!peer.IsConnected())
        throw new CProtocolError("Launch participant socket is closed");
      this.SocketSlots(peer);
    }
    const chief = this.m_rgPlayer[this.m_nChiefSlotidx]!;
    this.SelectPlayingMap(chief.GetLevel(), 0, chief.GetAuthencode() === 1);
    stable();
    const chosenMap = this.m_nMapIdxPlaying,
      check = () => {
        stable();
        if (this.m_nMapIdxPlaying !== chosenMap)
          throw new CProtocolError(
            "Chosen native vote launch map changed during preparation",
          );
      };
    const code = this.CanStartGame(false, this.m_nMapIdxPlaying);
    check();
    if (code) return { Code: code, Airplane: undefined, Tick: undefined };
    const map = this.maps.GetMapTmpl(this.m_nMapIdxPlaying),
      states = this.MakeStartColorStates(this.m_nMapIdxPlaying),
      preflight = new CDynInfoCalculator(
        () => this.channelType === ChannelType.Premium,
      );
    preflight.Init(this.m_rgPlayer, states);
    const mission = new MissionInfo();
    mission.Assign(map.m_aMissionInfo);
    const count = map.m_nSyncGameObjCount;
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > SyncGameObjectRule.MaximumWireID + 1
    )
      throw new CProtocolError(
        "Invalid initial synchronized-object resource count",
      );
    const launch = this.MakeLaunchGameStagePacket(
        this.m_nMapIdxPlaying,
        () => {
          check();
          const n = this.DrawNativeRandom();
          check();
          return n;
        },
        states,
      ),
      airplane = this.MakeAirplaneItemProbPacket(this.m_nMapIdxPlaying);
    check();
    const tick = this.#liveBanPlayer
      ? this.#ReadVoteTransitionTime(check)
      : undefined;
    check();
    return {
      Code: StartGameResult.Valid,
      States: states,
      Launch: launch,
      Airplane: airplane,
      Tick: tick,
    };
  }
  /** Full ordinary00420BB3 state tail, using a prevalidated detached packet.
   * Ready/status bits, peer flags/hosts, join times and context state timestamps
   * are NOT reset by native launch. Statistics snapshot AFTER color remapping. */
  private LaunchGameStage(
    launch: GameLaunchPacket,
    airplane?: CSendPacket,
    preparedTick?: number,
  ): void {
    const vote = PlanNativeVoteTransition(
      {
        TargetSerialNo: this.m_ulBanTargetSerialNo,
        Votes: Array.from(this.m_anBanPlayerVote),
      },
      "Launch",
    );
    const map = this.maps.GetMapTmpl(launch.MapIndex);
    this.m_aBomberIdxPlaying.set(launch.BomberIndices);
    this.SendPacket(launch.Packet);
    this.InitRoundStatistics();
    this.m_nativeLaunchToken = this.m_preparedRoundToken;
    this.m_udpLossRegulator.Init();
    this.SetPlaying(true);
    this.m_gameContext.Init();
    this.m_aShopItemAttempted.fill(0);
    for (let slot = 0; slot < SessionLimit.Players; slot++)
      this.m_aPlayerState[slot] = this.m_rgPlayer[slot]
        ? GamePlayerState.Active
        : GamePlayerState.Inactive;
    this.m_anSlotGhost.fill(GameGhostAssignment.NoGhost);
    this.m_anGhostSlot.fill(SessionLimit.NoSlot);
    this.m_nGhostCount = 0;
    this.m_dwLastGhostTime = 0;
    this.m_dwGhostStart = map.m_nGhostStart >>> 0;
    this.m_dwGhostFrequency = map.m_nGhostFreq >>> 0;
    this.m_dwLaunchTime = preparedTick ?? this.m_gameClock.GetCurrentTime();
    this.m_missionInfo.Assign(map.m_aMissionInfo);
    this.m_dwAirplaneInitialTime = map.m_nAirplaneInitialTime >>> 0;
    this.m_dwAirplaneFrequency = map.m_nAirplaneFrequency >>> 0;
    this.m_adwLapSort.fill(GameLaunchRule.InitialLapWord);
    this.m_adwLapPrefix.fill(0);
    if (airplane) this.SendPacket(airplane);
    this.#AssertNativeVoteTransition(vote);
  }
  /** 0041BDCF. This path is reachable only after a committed launch and full
   * ready+peer predicate. Result UUID is bound internally, never from a client.
   * Native table ClearModifiedFlag affects its CACHE flags; this immediate
   * publication adapter has no such cache and MUST NOT clear room modified bits. */
  private ValidateNativeStart(): void {
    this.RequireLaunchServices();
    if (
      !this.m_bPlaying ||
      this.m_nGameState !== GameStage.Loading ||
      this.m_resultRound ||
      !this.m_preparedRoundToken ||
      this.m_nativeLaunchToken !== this.m_preparedRoundToken ||
      this.m_preparedRoundToken === this.m_lastStartedRoundToken
    )
      throw new CProtocolError(
        "Duplicate or incomplete native start/statistics generation",
      );
    this.ValidateResultParticipants();
    const count = this.maps.GetSyncGameObjCount(this.m_nMapIdxPlaying);
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > SyncGameObjectRule.MaximumWireID + 1
    )
      throw new CProtocolError(
        "Invalid initial synchronized-object resource count",
      );
  }
  private DoStartGame(prepared?: PreparedVoteNativeStart): void {
    this.ValidateNativeStart();
    const vote = PlanNativeVoteTransition(
      {
        TargetSerialNo: this.m_ulBanTargetSerialNo,
        Votes: Array.from(this.m_anBanPlayerVote),
      },
      "Begin",
    );
    const p =
      prepared ??
      (this.#liveBanPlayer
        ? this.#WithVoteLifecyclePreparation((stable) =>
            this.#PrepareVoteNativeStart(stable, undefined),
          )
        : undefined);
    if (
      p &&
      (!this.#preparedVoteStarts.has(p) ||
        p.Token !== this.m_nativeLaunchToken ||
        p.Sequence !== this.m_dwGameSequence ||
        (p.Socket &&
          (this.#tableRemovalStack.at(-1)?.Socket !== p.Socket ||
            this.#tableRemovalStack.at(-1)?.NativeStart !== p)))
    )
      throw new CProtocolError("Expired/unissued prepared native vote start");
    if (p) this.#preparedVoteStarts.delete(p);
    this.m_syncGameObjMan.Init(this);
    this.m_syncGameObjMan.SetInitialObjNo(
      p?.InitialObjects ?? this.maps.GetSyncGameObjCount(this.m_nMapIdxPlaying),
    );
    this.m_anOpaque11612.fill(GameLaunchRule.InitialOpaqueStartWord);
    if (p) this.m_gameClock.StartGameAt(p.StartTick);
    else this.m_gameClock.StartGame();
    this.m_dwOpaque12552 = 0;
    this.m_nGameState = GameStage.Running;
    const packet =
      p?.Packet ??
      new CSendPacket(ServerResponse.BeginGame, undefined, this.text)
        .Encode4(this.m_gameClock.GetStartGameTime())
        .Encode4((this.m_dwGameSequence ^ this.m_dwGameSequenceKey) >>> 0)
        .Encode4(this.m_dwGhostStart)
        .Encode4(this.m_dwGhostFrequency);
    this.m_dwGameSequence = (this.m_dwGameSequence + 1) >>> 0;
    this.m_bRebirthMap =
      p?.Rebirth ?? this.maps.IsRebirthMap(this.m_nMapIdxPlaying);
    this.m_dwGhostStart =
      Math.imul(this.m_dwGhostStart, GameLaunchRule.MillisecondsPerSecond) >>>
      0;
    this.m_dwGhostFrequency =
      Math.imul(
        this.m_dwGhostFrequency,
        GameLaunchRule.MillisecondsPerSecond,
      ) >>> 0;
    for (let slot = 0; slot < SessionLimit.Players; slot++)
      if (!this.m_rgPlayer[slot]) this.m_aUDPHost[slot]!.fill(invalidHost);
    if (p) this.m_banChief.InstallSnapshot(p.Chief);
    else this.m_banChief.Init();
    this.m_dwLastAirplaneRequestTime = 0;
    this.BindResultRound(false);
    this.#AssertNativeVoteTransition(vote);
    this.SendPacket(packet);
  }
  /** Read-only availability, never an issuance token. Internal join paths
   * independently check the private registry and constructor-bound issuer. */
  HasUnownedBanPlayerState(): boolean {
    return !this.#HasConsistentBanPlayerState();
  }
  /**00422849/0041BD0E/0042410D: joining during a waiting vote changes the
   * roster, NOT ballots/target/chief, never Defer and never a new113/114 ACK.
   * Modern whole-group preflight prepares ALL81/105/107/112/93 bodies and
   * per-local join clocks before the first membership/tuple write. */
  JoinPlayerDuringVote(
    authority: object,
    socket: CClientSocket,
    bombers: readonly number[],
  ): void {
    if (!this.IsTableRemovalIssuer(authority))
      throw new CProtocolError("Invalid waiting-vote join issuer");
    this.#AssertOwnedBanPlayerState();
    this.#RequireLiveBanPlayerScope();
    if (!this.#liveBanPlayer || this.m_bPlaying || this.m_resultRound)
      throw new CProtocolError("Join requires an issued idle waiting vote");
    this.#WithBanPlayerTransition(() => {
      const prepared = this.WithBanPlayerPreparation((capture) => {
        const group = socket.m_aUser,
          users = Array.from(group),
          beforeLive = this.#liveBanPlayer!,
          slotBuffers = this.m_rgSlotInfo.slice(),
          fingerprint = this.WaitingChiefFingerprint(),
          connected = socket.IsConnected(),
          pool = socket.m_nPoolType;
        if (
          !connected ||
          users.length < UserCount.Minimum ||
          users.length > UserCount.Maximum ||
          new Set(users).size !== users.length ||
          users.some(
            (u, self) =>
              !u ||
              u.m_pClientSocket !== socket ||
              u.GetSelfidx() !== self ||
              u.IsSetFree() !== 0 ||
              u.GetSessionIdx() !== SessionLimit.NoSession ||
              u.GetSessionSerialNo() !== IntegerRange.UInt32Maximum ||
              this.m_rgPlayer.includes(u),
          )
        )
          throw new CProtocolError("Invalid incoming waiting-vote join group");
        const existingSerials = new Set(
          this.m_rgPlayer.flatMap((u) => (u ? [u.GetGlobalSerialNo()] : [])),
        );
        for (const u of users) {
          const serial = u.GetGlobalSerialNo();
          if (
            !Number.isInteger(serial) ||
            serial <= 0 ||
            serial > IntegerRange.UInt32Maximum ||
            existingSerials.has(serial)
          )
            throw new CProtocolError(
              "Invalid/duplicate incoming waiting-vote serial",
            );
          existingSerials.add(serial);
        }
        const owners = users.map((u) => ({
          Info: u.m_userInfo,
          Native: u.CaptureUserInventory()?.Rows,
          Pre: u.CapturePreInventory().Rows,
          Owned: u.GetUserInventoryGeneration(),
          PreEpoch: u.GetPreInventoryGeneration(),
          Connection: this.ChiefConnectionGeneration(u),
          Legacy: u.m_aInventory,
          Slot: u.m_nSlotIdx,
        }));
        const incomingFingerprint = () =>
            JSON.stringify(
              users.map((u) => ({
                Info: u.m_userInfo,
                Serial: u.GetGlobalSerialNo(),
                Dynamic: u.GetDynamicInfoSnapshot(),
                Inventory: u.CaptureUserInventory()
                  ? null
                  : u.GetInventoryStateSnapshot(),
                Auth: u.GetAuthencode(),
                Free: u.IsSetFree(),
              })),
            ),
          incoming = incomingFingerprint();
        const stable = () => {
          capture.Stable();
          this.#RequireLiveBanPlayerScope();
          this.#AssertOwnedBanPlayerState();
          if (
            this.#liveBanPlayer !== beforeLive ||
            this.m_resultRound ||
            this.WaitingChiefFingerprint() !== fingerprint ||
            this.m_rgSlotInfo.some((b, i) => b !== slotBuffers[i]) ||
            socket.m_aUser !== group ||
            group.length !== users.length ||
            Array.from(group).some((u, i) => u !== users[i]) ||
            socket.IsConnected() !== connected ||
            socket.m_nPoolType !== pool
          )
            throw new CProtocolError(
              "Waiting-vote join context changed during preparation",
            );
          users.forEach((u, i) => {
            const o = owners[i]!;
            if (
              u.m_pClientSocket !== socket ||
              u.GetSelfidx() !== i ||
              u.GetSessionIdx() !== SessionLimit.NoSession ||
              u.GetSessionSerialNo() !== IntegerRange.UInt32Maximum ||
              u.m_nSlotIdx !== o.Slot ||
              u.m_userInfo !== o.Info ||
              u.m_aInventory !== o.Legacy ||
              u.CaptureUserInventory()?.Rows !== o.Native ||
              u.CapturePreInventory().Rows !== o.Pre ||
              u.GetUserInventoryGeneration().Native !== o.Owned.Native ||
              u.GetUserInventoryGeneration().Revision !== o.Owned.Revision ||
              u.GetPreInventoryGeneration() !== o.PreEpoch ||
              this.ChiefConnectionGeneration(u) !== o.Connection
            )
              throw new CProtocolError(
                "Waiting-vote join owner/generation changed during preparation",
              );
          });
          if (incomingFingerprint() !== incoming)
            throw new CProtocolError(
              "Waiting-vote join user data changed during preparation",
            );
        };
        stable();
        const selected = Array.from(bombers);
        if (selected.length !== users.length)
          throw new CProtocolError("Waiting-vote join bomber count mismatch");
        const resolved = selected.map((n) => {
          stable();
          const b = this.bombers.IsValidSelectIdx(n)
            ? n
            : this.bombers.GetRandomBomberIdx();
          stable();
          return b;
        });
        const first = this.m_rgPlayer.findIndex(
          (u, i) => !u && !(this.m_rgSlotInfo[i]![0]! & SlotStateMask.Closed),
        );
        if (first < 0) throw new CProtocolError("Waiting-vote room full");
        const color = this.GetColorForNewComer(first);
        stable();
        const plan = PlanWaitingVoteJoin(
          {
            Occupied: this.m_rgPlayer.map(Boolean),
            SlotInfo: this.m_rgSlotInfo.map((b) => Array.from(b)),
            Votes: Array.from(this.m_anBanPlayerVote),
            TargetSerialNo: this.m_ulBanTargetSerialNo,
            ChiefSlot: this.m_nChiefSlotidx,
          },
          resolved,
          color,
        );
        if (plan.Slots.some((slot) => this.m_anBanPlayerVote[slot] !== 0))
          throw new CProtocolError("Issued vote vacancy has a stale ballot");
        const times = users.map(() => {
          stable();
          const tick = this.m_gameClock.GetCurrentTime();
          stable();
          if (
            !Number.isInteger(tick) ||
            tick < 0 ||
            tick > IntegerRange.UInt32Maximum
          )
            throw new CProtocolError("Invalid waiting-vote join clock");
          return tick;
        });
        const view = new CBaseSession(
          this.m_nIdx,
          this.m_ulSerialNo,
          this.text,
        );
        this.m_rgPlayer.forEach((u, i) => {
          view.m_rgPlayer[i] = u;
          view.m_rgSlotInfo[i] = Buffer.from(plan.SlotInfo[i]!);
        });
        plan.Slots.forEach((slot, i) => {
          view.m_rgPlayer[slot] = users[i]!;
        });
        const packets: {
          Packet: CSendPacket;
          Targets: readonly CClientSocket[];
        }[] = [];
        const add = (
          packet: CSendPacket,
          targets: readonly CClientSocket[],
        ) => {
          stable();
          packets.push({ Packet: packet, Targets: [...targets] });
        };
        add(
          new CSendPacket(
            ServerResponse.JoinSession,
            undefined,
            this.text,
          ).Encode1(JoinSessionResult.Success),
          [socket],
        );
        for (let slot = 0; slot < SessionLimit.Players; slot++) {
          const u = view.m_rgPlayer[slot];
          add(
            u
              ? view.MakeSetPlayerPacket(slot, u.m_pClientSocket === socket)
              : view.MakeSetSlotStatePacket(slot),
            [socket],
          );
        }
        for (let i = 0; i < 2; i++)
          add(
            new CSendPacket(
              ServerResponse.SelectMap,
              undefined,
              this.text,
            ).Encode2(this.m_nMapIdx & 0xffff),
            [socket],
          );
        for (const slot of plan.Slots)
          add(view.MakeSetPlayerPacket(slot, true), capture.Sockets);
        add(
          new CSendPacket(
            this.m_nGameType === GameType.Mod
              ? ServerResponse.GameTypeMod
              : ServerResponse.GameTypeNormal,
            undefined,
            this.text,
          ),
          [socket],
        );
        stable();
        return { users, plan, times, packets, beforeLive };
      });
      // Callback-free native-field publication; do not call a clock/codec or
      // reinterpret pre/native inventory, and do NOT rewrite ANY ballot.
      const { users, plan, times, packets, beforeLive } = prepared;
      plan.Slots.forEach((slot, i) => {
        const row = plan.SlotInfo[slot]!;
        super.AddUser(
          users[i]!,
          slot,
          row[1]! & SlotStateMask.Bomber,
          row[2]! & SlotStateMask.Color,
        );
        this.#InstallJoinedPlayerState(slot, times[i]!);
      });
      socket.m_nPoolType = "Session";
      this.m_nModified |= SessionModified.PlayerCount;
      this.#liveBanPlayer = {
        Target: beforeLive.Target,
        Votes: beforeLive.Votes,
        Players: Object.freeze(this.m_rgPlayer.slice()),
      };
      for (const p of packets) this.QueuePacketTo(p.Packet, p.Targets);
    });
  }
  #VoteLifecycleFingerprint(ignorePlayingMap = false): string {
    const r = this.m_resultRound;
    return JSON.stringify([
      this.WaitingChiefFingerprint(ignorePlayingMap),
      this.GetGameLaunchState(),
      Array.from(this.m_aPlayerState),
      Array.from(this.m_abUDPPeerReceived),
      Array.from(this.m_adwPlayerJoinTime),
      this.m_aUDPHost.map((row) => row.map((h) => [h.Address, h.Port])),
      r
        ? [
            r.RoundID,
            r.StartTick,
            r.Durable,
            r.Applying,
            r.Returning,
            !!r.Pending,
            !!r.PendingMoney,
            !!r.PendingHouse,
            !!r.PendingSpecial,
            r.MoneySequence,
            r.HouseSequence,
            r.SpecialSequence,
          ]
        : null,
    ]);
  }
  #WithVoteLifecyclePreparation<T>(
    action: (stable: () => void) => T,
    ignorePlayingMap = false,
  ): T {
    return this.WithBanPlayerPreparation((capture) => {
      const native = this.m_nativeLaunchToken,
        prepared = this.m_preparedRoundToken,
        last = this.m_lastStartedRoundToken,
        round = this.m_resultRound,
        live = this.#liveBanPlayer,
        slotBuffers = this.m_rgSlotInfo.slice(),
        fingerprint = this.#VoteLifecycleFingerprint(ignorePlayingMap);
      const stable = () => {
        capture.Stable();
        this.#AssertOwnedBanPlayerState();
        this.#RequireLiveBanPlayerScope();
        if (
          this.m_nativeLaunchToken !== native ||
          this.m_preparedRoundToken !== prepared ||
          this.m_lastStartedRoundToken !== last ||
          this.m_resultRound !== round ||
          this.#liveBanPlayer !== live ||
          this.m_rgSlotInfo.some((b, i) => b !== slotBuffers[i]) ||
          this.#VoteLifecycleFingerprint(ignorePlayingMap) !== fingerprint
        )
          throw new CProtocolError(
            "Vote lifecycle changed during native transition preparation",
          );
      };
      stable();
      const result = action(stable);
      stable();
      return result;
    });
  }
  #ReadVoteTransitionTime(stable: () => void): number {
    stable();
    const tick = this.m_gameClock.GetCurrentTime();
    stable();
    if (
      !Number.isInteger(tick) ||
      tick < 0 ||
      tick > IntegerRange.UInt32Maximum
    )
      throw new CProtocolError("Invalid native vote transition DWORD clock");
    return tick;
  }
  #ValidateVoteStartSurvivors(excluded: readonly CClientSocket[]): void {
    this.RequireLaunchServices();
    if (
      !this.m_bPlaying ||
      this.m_nGameState !== GameStage.Loading ||
      this.m_resultRound ||
      !this.m_nativeLaunchToken ||
      this.m_nativeLaunchToken !== this.m_preparedRoundToken ||
      this.m_preparedRoundToken === this.m_lastStartedRoundToken ||
      !this.m_aRoundPlayers
    )
      throw new CProtocolError(
        "Vote start lacks complete native loading generation",
      );
    for (const peer of this.GetSockets().filter((s) => !excluded.includes(s))) {
      if (!peer.IsConnected())
        throw new CProtocolError("Vote start survivor is closed");
      this.SocketSlots(peer);
      for (const u of peer.m_aUser)
        if (
          u !== this.m_aRoundPlayers[u.m_nSlotIdx] ||
          this.m_departedRoundUsers.has(u) ||
          (this.m_rgSlotInfo[u.m_nSlotIdx]![2]! & SlotStateMask.Color) >=
            SessionLimit.Players
        )
          throw new CProtocolError("Vote start survivor changed since launch");
    }
  }
  #PrepareVoteNativeStart(
    stable: () => void,
    forSocket: CClientSocket | undefined,
    time: () => number = () => this.#ReadVoteTransitionTime(stable),
  ): PreparedVoteNativeStart {
    const token = this.m_nativeLaunchToken;
    if (!token || token !== this.m_preparedRoundToken)
      throw new CProtocolError("Missing private native vote start token");
    const count = this.maps.GetSyncGameObjCount(this.m_nMapIdxPlaying),
      rebirth = this.maps.IsRebirthMap(this.m_nMapIdxPlaying);
    stable();
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > SyncGameObjectRule.MaximumWireID + 1
    )
      throw new CProtocolError("Invalid vote start synchronized-object count");
    const tick = time(),
      helper = this.m_banChief.Fork(time);
    helper.Init();
    if (
      !Number.isInteger(tick) ||
      tick < 0 ||
      tick > IntegerRange.UInt32Maximum
    )
      throw new CProtocolError("Invalid native vote start DWORD clock");
    const packet = new CSendPacket(
      ServerResponse.BeginGame,
      undefined,
      this.text,
    )
      .Encode4(tick)
      .Encode4((this.m_dwGameSequence ^ this.m_dwGameSequenceKey) >>> 0)
      .Encode4(this.m_dwGhostStart)
      .Encode4(this.m_dwGhostFrequency);
    stable();
    const result: PreparedVoteNativeStart = {
      Socket: forSocket,
      Token: token,
      StartTick: tick,
      Chief: helper.CaptureSnapshot(),
      Sequence: this.m_dwGameSequence,
      InitialObjects: count,
      Rebirth: rebirth,
      Packet: packet,
    };
    this.#preparedVoteStarts.add(result);
    return result;
  }
  #PrepareVoteDepartureStart(
    socket: CClientSocket,
    policy: Readonly<BanPlayerCascadePlan>,
    sockets: readonly CClientSocket[],
    time: () => number,
  ): PreparedVoteNativeStart | undefined {
    if (!this.m_bPlaying || this.m_nGameState !== GameStage.Loading)
      return undefined;
    const eject = policy.Departure.Decision?.Eject,
      second = eject ? sockets[eject.SocketKey]! : undefined,
      excluded = second ? [socket, second] : [socket],
      survivors = this.m_rgPlayer.filter(
        (u) => u && !excluded.includes(u.m_pClientSocket!),
      );
    if (
      !survivors.length ||
      survivors.some(
        (u) =>
          !this.HasUDPPeerInfo(u!.m_nSlotIdx) ||
          (this.m_rgSlotInfo[u!.m_nSlotIdx]![0]! & SlotStateMask.Status) !==
            SlotStateMask.ReadyForStart,
      )
    )
      return undefined;
    this.#ValidateVoteStartSurvivors(excluded);
    // The caller already wraps each read with its whole-room/epoch fence.
    const stable = () => {
      this.#AssertOwnedBanPlayerState();
      this.#RequireLiveBanPlayerScope();
    };
    return this.#PrepareVoteNativeStart(stable, second ?? socket, time);
  }
  #AssertNativeVoteTransition(expected: Readonly<NativeVoteState>): void {
    if (
      this.m_ulBanTargetSerialNo !== expected.TargetSerialNo ||
      this.m_anBanPlayerVote.some((v, i) => v !== expected.Votes[i])
    )
      throw new CProtocolError(
        "Native launch/start unexpectedly rewrote vote state",
      );
    this.#AssertOwnedBanPlayerState();
  }
  #HasConsistentBanPlayerState(): boolean {
    const live = this.#liveBanPlayer;
    return this.m_ulBanTargetSerialNo === 0
      ? !live
      : !!live &&
          live.Target === this.m_ulBanTargetSerialNo &&
          this.m_anBanPlayerVote.every((v, i) => v === live.Votes[i]) &&
          this.m_rgPlayer.every((u, i) => u === live.Players[i]);
  }
  HasActiveBanPlayerVote(): boolean {
    return (
      this.m_ulBanTargetSerialNo !== 0 && this.#HasConsistentBanPlayerState()
    );
  }
  #AssertOwnedBanPlayerState(): void {
    if (!this.#HasConsistentBanPlayerState())
      throw new CUnsupportedOperation(
        "Unowned or changed vote-ban state",
        "public fields/read-only DTOs cannot install an active vote",
      );
  }
  #HasSupportedWaitingGameType(): boolean {
    return (
      this.m_nGameType === GameType.Normal ||
      (this.m_nGameType === GameType.Mod &&
        this.#waitingGameType === GameType.Mod &&
        !this.m_bPlaying &&
        !this.m_nativeLaunchToken &&
        !this.m_resultRound)
    );
  }
  GetGameTypeState(): Readonly<{
    Value: number;
    WaitingIssued: boolean;
    Revision: number;
  }> {
    return Object.freeze({
      Value: this.m_nGameType,
      WaitingIssued:
        !this.m_bPlaying &&
        !this.m_nativeLaunchToken &&
        !this.m_resultRound &&
        this.#HasSupportedWaitingGameType(),
      Revision: this.#gameTypeRevision,
    });
  }
  #RequireLiveBanPlayerScope(): void {
    if (
      !this.#HasSupportedWaitingGameType() ||
      this.channelType === ChannelType.Guild ||
      this.IsBangPok() ||
      this.m_nIdx < 0 ||
      this.m_nIdx >= SessionLimit.GameSessions
    )
      throw new CUnsupportedOperation(
        "Vote-ban outside ordinary native room",
        "special-mode vote cascades remain unavailable",
      );
    if (this.m_bPlaying) {
      const token = this.m_nativeLaunchToken,
        round = this.m_resultRound;
      if (
        !token ||
        token !== this.m_preparedRoundToken ||
        (this.m_nGameState === GameStage.Loading
          ? !!round || token === this.m_lastStartedRoundToken
          : (this.m_nGameState !== GameStage.Running &&
              this.m_nGameState !== GameStage.Result) ||
            !round ||
            this.m_lastStartedRoundToken !== token ||
            round.StartTick !== this.m_gameClock.GetStartGameTime())
      )
        throw new CUnsupportedOperation(
          "Vote-ban without complete native launch/round",
          "public Playing/stage/DTO is not native or financial authority",
        );
    }
    if (
      this.IsResultCommitPending() ||
      this.IsGameplayCommitPending() ||
      this.m_resultRound?.Applying ||
      this.m_resultRound?.Returning
    )
      throw new CProtocolError(
        "Vote-ban during frozen financial/result transition",
      );
    if (
      this.m_bPlaying &&
      this.m_nGameState === GameStage.Result &&
      !this.m_resultRound?.Durable
    )
      throw new CUnsupportedOperation(
        "Vote-ban without durable native result",
        "result flags alone do not grant receipt authority",
      );
    if (
      !this.removalServices?.TableAuthority ||
      !this.removalServices.EjectBanPlayer ||
      !this.removalServices.IsCurrentSession?.(this)
    )
      throw new CUnsupportedOperation(
        "Vote-ban without current table service",
        "no public plan/boolean authorizes removal",
      );
  }
  #WithBanPlayerTransition<T>(
    action: () => T,
    updatingOwner?: CClientSocket,
  ): T {
    if (
      this.#banPlayerOperation ||
      this.m_bGameTransition ||
      this.m_bRemovingPlayer ||
      (this.m_bUpdating &&
        (!updatingOwner || this.m_pRegulatingSocket !== updatingOwner))
    )
      throw new CProtocolError("Reentrant vote-ban transition");
    this.#banPlayerOperation = true;
    try {
      return this.WithGameTransition(action);
    } finally {
      this.#banPlayerOperation = false;
    }
  }
  #PrepareBanPlayerMessages(
    plan: Readonly<BanPlayerPlan>,
    sockets: readonly CClientSocket[],
  ) {
    return plan.Messages.map((m) => ({
      Packet: MakeBanPlayerPacket(m.Message, this.text),
      Targets: m.Recipients.map((key) => {
        const s = sockets[key];
        if (!s) throw new CProtocolError("Missing captured vote socket");
        return s;
      }),
    }));
  }
  #PublishBanPlayerState(plan: Readonly<BanPlayerPlan>): void {
    this.m_anBanPlayerVote.set(plan.After.Votes);
    this.m_ulBanTargetSerialNo = plan.After.TargetSerialNo;
    this.#liveBanPlayer = plan.After.TargetSerialNo
      ? {
          Target: plan.After.TargetSerialNo,
          Votes: Object.freeze([...plan.After.Votes]),
          Players: Object.freeze(this.m_rgPlayer.slice()),
        }
      : undefined;
  }
  #PrepareBanPlayerDeparture(
    socket: CClientSocket,
    observation: Readonly<BanPlayerObservation>,
    sockets: readonly CClientSocket[],
    before: CBanChief,
    time: () => number,
  ): PreparedBanPlayerDeparture {
    const key = sockets.indexOf(socket);
    if (key < 0)
      throw new CProtocolError("Vote departure outside captured group");
    this.ValidatePlayerRemoval(socket, { PlanningBatch: true });
    const policy = PlanBanPlayerCascade(observation, key, before, time),
      eject = policy.Departure.Decision?.Eject;
    if (eject)
      this.ValidatePlayerRemoval(sockets[eject.SocketKey]!, {
        PlanningBatch: true,
      });
    const messages = policy.Departure.Decision
      ? this.#PrepareBanPlayerMessages(policy.Departure.Decision, sockets)
      : [];
    const nativeStart = this.#PrepareVoteDepartureStart(
      socket,
      policy,
      sockets,
      time,
    );
    // Clocks and codecs are fallible injected ports. Revalidate the WHOLE ghost
    // image/candidate tuple AFTER them, before the table may clear any IDs.
    this.ValidatePlayerRemoval(socket, { PlanningBatch: true });
    if (eject)
      this.ValidatePlayerRemoval(sockets[eject.SocketKey]!, {
        PlanningBatch: true,
      });
    return {
      Socket: socket,
      Policy: policy,
      Sockets: [...sockets],
      Players: this.m_rgPlayer.slice(),
      Messages: messages,
      NativeStart: nativeStart,
    };
  }
  #EjectLiveBanPlayer(
    socket: CClientSocket,
    reset: Readonly<BanChiefState> | undefined,
    nativeStart?: PreparedVoteNativeStart,
  ): void {
    const capture = this.CaptureBanPlayerPreparation(),
      fingerprint = this.#VoteLifecycleFingerprint(),
      guard = () => {
        capture.Stable();
        this.#RequireLiveBanPlayerScope();
        this.#AssertOwnedBanPlayerState();
        if (this.#VoteLifecycleFingerprint() !== fingerprint)
          throw new CProtocolError(
            "Vote ejection source changed before consumption",
          );
      },
      previous = this.#expectedBanRemoval,
      entry = {
        Socket: socket,
        Reset: reset,
        NativeStart: nativeStart,
        Consumed: false,
        Active: true,
        Guard: guard,
      };
    this.#expectedBanRemoval = entry;
    try {
      this.removalServices!.EjectBanPlayer!(this, socket);
      if (
        !entry.Consumed ||
        socket.m_aUser.some(
          (u) =>
            u.GetSessionIdx() !== SessionLimit.NoSession ||
            u.GetSessionSerialNo() !== IntegerRange.UInt32Maximum ||
            u.m_nSlotIdx !== SessionLimit.NoSlot,
        ) ||
        socket.m_nPoolType !== "SessionRemoved" ||
        this.m_rgPlayer.some((u) => u?.m_pClientSocket === socket)
      )
        throw new CProtocolError(
          "Vote table service did not consume exact removal",
        );
    } finally {
      entry.Active = false;
      this.#expectedBanRemoval = previous;
    }
  }
  #ApplyPreparedBanPlayerDeparture(prepared: PreparedBanPlayerDeparture): void {
    const { Remaining, Decision } = prepared.Policy.Departure;
    if (
      this.m_nChiefSlotidx !== Remaining.ChiefSlot ||
      this.m_ulBanTargetSerialNo !== Remaining.TargetSerialNo ||
      this.m_anBanPlayerVote.some((v, i) => v !== Remaining.Votes[i]) ||
      this.m_rgPlayer.some(
        (u, i) =>
          u !==
          (prepared.Players[i]?.m_pClientSocket === prepared.Socket
            ? undefined
            : prepared.Players[i]),
      )
    )
      throw new CProtocolError(
        "Vote departure does not match prepared remaining state",
      );
    if (Decision) {
      this.#PublishBanPlayerState(Decision);
      if (Decision.Eject) {
        const key = Decision.Eject.SocketKey,
          target = prepared.Sockets[key]!;
        this.#EjectLiveBanPlayer(
          target,
          prepared.Policy.Resets.find((r) => r.SocketKey === key)?.State,
          prepared.NativeStart,
        );
      }
      for (const m of prepared.Messages)
        this.QueuePacketTo(m.Packet, m.Targets);
    }
    if (prepared.FinalChiefState)
      this.m_banChief.InstallSnapshot(prepared.FinalChiefState);
  }
  /** Called ONLY by the constructor-bound table issuer. A public DTO/target,
   * reflective modern flags or a retained service callback cannot enter this
   * scope. Each native ejection entry is consumed once and revoked on return. */
  IsTableRemovalIssuer(authority: object): boolean {
    return (
      !!this.removalServices?.TableAuthority &&
      authority === this.removalServices.TableAuthority
    );
  }
  ValidateUnboundTableRemoval(): void {
    if (
      this.#liveBanPlayer ||
      this.m_ulBanTargetSerialNo ||
      this.#banPlayerOperation ||
      this.#tableRemovalStack.length
    )
      throw new CProtocolError(
        "Vote removal cannot use unbound legacy table adapter",
      );
  }
  WithTablePlayerRemoval(
    authority: object,
    socket: CClientSocket,
    action: () => boolean,
  ): boolean {
    if (
      !this.removalServices?.TableAuthority ||
      authority !== this.removalServices.TableAuthority ||
      !this.removalServices.IsCurrentSession?.(this)
    )
      throw new CProtocolError("Invalid table removal issuer/generation");
    const expected = this.#expectedBanRemoval;
    if (
      this.#tableRemovalStack.length &&
      (!expected?.Active || expected.Consumed || expected.Socket !== socket)
    )
      throw new CProtocolError("Unissued nested vote removal");
    const execute = (departure?: PreparedBanPlayerDeparture): boolean => {
      if (expected) {
        if (!expected.Active || expected.Consumed || expected.Socket !== socket)
          throw new CProtocolError("Expired/reused vote removal");
        expected.Guard();
        expected.Consumed = true;
      }
      const key = departure?.Sockets.indexOf(socket),
        entry: BanPlayerRemovalEntry = {
          Socket: socket,
          Departure: departure,
          NativeStart: expected?.NativeStart ?? departure?.NativeStart,
          Reset:
            expected?.Reset ??
            (key !== undefined
              ? departure?.Policy.Resets.find((r) => r.SocketKey === key)?.State
              : undefined),
        };
      this.#tableRemovalStack.push(entry);
      try {
        return action();
      } finally {
        if (this.#tableRemovalStack.pop() !== entry)
          throw new CProtocolError("Corrupt table removal stack");
      }
    };
    if (expected) return execute();
    this.#AssertOwnedBanPlayerState();
    if (!this.m_ulBanTargetSerialNo) return execute();
    this.#RequireLiveBanPlayerScope();
    if (this.#waitingBanDeparture) {
      if (
        this.#waitingBanDeparture.Socket !== socket ||
        !this.m_bUpdating ||
        this.m_pRegulatingSocket !== socket
      )
        throw new CProtocolError("Expired waiting vote departure");
      return execute(this.#waitingBanDeparture);
    }
    return this.#WithBanPlayerTransition(
      () => {
        const prepared = this.WithBanPlayerPreparation((capture) => {
          const fingerprint = this.#VoteLifecycleFingerprint(),
            stable = () => {
              capture.Stable();
              this.#RequireLiveBanPlayerScope();
              this.#AssertOwnedBanPlayerState();
              if (this.#VoteLifecycleFingerprint() !== fingerprint)
                throw new CProtocolError(
                  "Vote departure changed during preparation",
                );
            };
          const prepared = this.#PrepareBanPlayerDeparture(
            socket,
            capture.Observation,
            capture.Sockets,
            this.m_banChief,
            () => this.#ReadVoteTransitionTime(stable),
          );
          stable();
          return prepared;
        });
        return execute(prepared);
      },
      this.m_bUpdating ? socket : undefined,
    );
  }
  ValidateBanPlayerEjection(authority: object, socket: CClientSocket): void {
    const e = this.#expectedBanRemoval;
    if (
      !this.removalServices?.TableAuthority ||
      authority !== this.removalServices.TableAuthority ||
      !e?.Active ||
      e.Consumed ||
      e.Socket !== socket
    )
      throw new CProtocolError("Expired/unissued vote ejection");
    e.Guard();
  }
  #OnBanPlayerPacket(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
    host: boolean,
  ): void {
    this.#RequireLiveBanPlayerScope();
    this.#AssertOwnedBanPlayerState();
    this.#WithBanPlayerTransition(() => {
      const prepared = this.WithBanPlayerPreparation((capture) => {
        const fingerprint = this.#VoteLifecycleFingerprint(),
          stable = () => {
            capture.Stable();
            this.#RequireLiveBanPlayerScope();
            this.#AssertOwnedBanPlayerState();
            if (this.#VoteLifecycleFingerprint() !== fingerprint)
              throw new CProtocolError("Vote room changed during preparation");
          },
          sender = capture.Sockets.indexOf(socket),
          source = capture.Observation;
        const plan = host
          ? PlanHostAskBanPlayer(
              source,
              sender,
              {
                get TargetSerialNo() {
                  return packet.Decode4();
                },
                get Immediate() {
                  const n = packet.Decode1();
                  packet.AssertEnd();
                  return n;
                },
              },
              (slot, attribute) => {
                stable();
                const found = capture.Query(slot, attribute);
                stable();
                return found;
              },
            )
          : PlanRespondToBanPlayer(source, sender, {
              get TargetSerialNo() {
                return packet.Decode4();
              },
              get Answer() {
                const n = packet.Decode1();
                packet.AssertEnd();
                return n;
              },
            });
        const messages = this.#PrepareBanPlayerMessages(plan, capture.Sockets);
        let departure: PreparedBanPlayerDeparture | undefined;
        if (plan.Eject) {
          departure = this.#PrepareBanPlayerDeparture(
            capture.Sockets[plan.Eject.SocketKey]!,
            { ...source, ...plan.After },
            capture.Sockets,
            this.m_banChief,
            () => this.#ReadVoteTransitionTime(stable),
          );
        }
        stable();
        return { plan, messages, departure };
      });
      const { plan, messages, departure } = prepared;
      this.#PublishBanPlayerState(plan);
      if (plan.Eject)
        this.#EjectLiveBanPlayer(
          departure!.Socket,
          departure!.Policy.Resets.find(
            (r) => r.SocketKey === plan.Eject!.SocketKey,
          )?.State,
          departure!.NativeStart,
        );
      for (const m of messages) this.QueuePacketTo(m.Packet, m.Targets);
    });
  }
  OnHostAskBanPlayer(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.#OnBanPlayerPacket(packet, socket, true);
  }
  OnRespondToBanPlayer(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): void {
    this.#OnBanPlayerPacket(packet, socket, false);
  }
  protected override GetBanPlayerObservationContext(): string {
    return JSON.stringify([
      super.GetBanPlayerObservationContext(),
      this.channelType,
      this.m_nGameType,
      this.#gameTypeRevision,
    ]);
  }
  /** Read-side prediction ONLY. Base policy models ordinary first-occupied
   * chief succession, not a Guild/Mod strategy or executable vote cascade. */
  override PrepareBanPlayerAfterDeparture(
    socket: CClientSocket,
  ): ReturnType<CListSession["PrepareBanPlayerAfterDeparture"]> {
    if (
      this.channelType === ChannelType.Guild ||
      !this.#HasSupportedWaitingGameType()
    )
      throw new CUnsupportedOperation(
        "Nonordinary vote-departure observation",
        "only ordinary first-occupied chief succession is modeled",
      );
    return super.PrepareBanPlayerAfterDeparture(socket);
  }
  /** Ordinary nonplaying rooms, independent of UDP launch opt-in. Special
   * strategies and unowned/changed vote fields stay unsupported, not silently run. */
  IsWaitingChiefScheduled(): boolean {
    return (
      !this.m_bPlaying &&
      this.#HasSupportedWaitingGameType() &&
      this.channelType !== ChannelType.Guild &&
      !this.IsBangPok() &&
      this.#HasConsistentBanPlayerState() &&
      !this.IsResultCommitPending() &&
      !this.IsGameplayCommitPending() &&
      Number.isInteger(this.m_nChiefSlotidx) &&
      this.m_nChiefSlotidx >= 0 &&
      this.m_nChiefSlotidx < SessionLimit.Players &&
      !!this.m_rgPlayer[this.m_nChiefSlotidx]?.m_pClientSocket
    );
  }
  GetWaitingChiefPublicationFailures(): number {
    return this.m_nChiefWarningPublicationFailures;
  }
  /** Real deployment owners are Center CUsers with opaque connection epochs.
   * Standalone Common CUser kernels have no Center owner/transfer generation.
   * This read-only epoch is a fence, NEVER permission to transfer or replay. */
  private ChiefConnectionGeneration(user: CUser): object | undefined {
    return (
      user as CUser & { GetConnectionGeneration?: () => object }
    ).GetConnectionGeneration?.();
  }
  private WaitingChiefFingerprint(ignorePlayingMap = false): string {
    return JSON.stringify({
      Index: this.m_nIdx,
      Serial: this.m_ulSerialNo,
      Playing: this.m_bPlaying,
      Stage: this.m_nGameState,
      Type: this.m_nGameType,
      GameTypeRevision: this.#gameTypeRevision,
      Chief: this.m_nChiefSlotidx,
      Capacity: this.m_nMaxPlayer,
      Count: this.GetCurPlayer(),
      Manner: this.m_nManner,
      BangPok: this.m_bBangPok,
      BanTarget: this.m_ulBanTargetSerialNo,
      BanVotes: Array.from(this.m_anBanPlayerVote),
      Ghosts: {
        Count: this.m_nGhostCount,
        ByPlayer: Array.from(this.m_anSlotGhost),
        ByGhost: Array.from(this.m_anGhostSlot),
      },
      Maps: [this.m_nMapIdx, ignorePlayingMap ? null : this.m_nMapIdxPlaying],
      Modified: this.m_nModified,
      Slots: this.m_rgSlotInfo.map((s) => s.toString("hex")),
      Ban: this.m_banChief.CaptureSnapshot(),
      Clock: this.m_gameClock.GetStateSnapshot(),
      Users: this.m_rgPlayer.map((u) =>
        u
          ? {
              Info: u.m_userInfo,
              Dynamic: u.GetDynamicInfoSnapshot(),
              // Native rows are immutable and checked by vector identity AND
              // epoch below; don't reserialize3200 native rows on each clock read.
              Inventory: u.CaptureUserInventory()
                ? null
                : u.GetInventoryStateSnapshot(),
              Generation: u.GetUserInventoryGeneration(),
              PreGeneration: u.GetPreInventoryGeneration(),
              Pool: u.m_pClientSocket?.m_nPoolType,
              Connected: u.m_pClientSocket?.IsConnected(),
              Free: u.IsSetFree(),
              Self: u.GetSelfidx(),
              Session: u.GetSessionIdx(),
              Serial: u.GetSessionSerialNo(),
              Slot: u.m_nSlotIdx,
            }
          : null,
      ),
    });
  }
  /**0041C15B ordinary waiting-chief branch. Snapshot/prepare ALL helper state,
   * clocks and121 images before publishing. Native sends121 before table-owned
   * departure/pool4; modern guards reject nested transitions and stale owners.
   * No native SQL, financial grant, UDP195 or automatic lobby route is added. */
  DeferBanChief(): void {
    if (
      this.m_bUpdating ||
      this.m_bRemovingPlayer ||
      this.m_bGameTransition ||
      this.m_resultRound?.Applying ||
      this.m_resultRound?.Returning ||
      this.IsResultCommitPending() ||
      this.IsGameplayCommitPending()
    )
      throw new CProtocolError("Chief update during frozen room transition");
    if (
      !this.#HasSupportedWaitingGameType() ||
      this.channelType === ChannelType.Guild ||
      this.IsBangPok() ||
      (this.m_ulBanTargetSerialNo !== 0 && !this.#HasConsistentBanPlayerState())
    )
      throw new CUnsupportedOperation(
        "DeferBanChief special/vote recovery",
        "only ordinary normal waiting rooms are enabled",
      );
    this.#AssertOwnedBanPlayerState();
    const slot = this.m_nChiefSlotidx,
      chief =
        Number.isInteger(slot) && slot >= 0 && slot < SessionLimit.Players
          ? this.m_rgPlayer[slot]
          : undefined,
      chiefSocket = chief?.m_pClientSocket;
    // Native playing branch precedes chief lookup; absent chief/socket reads NO clock.
    if (!this.m_bPlaying && (!chief || !chiefSocket)) return;
    this.m_bUpdating = true;
    try {
      const occupants = this.m_rgPlayer.slice(),
        slotBuffers = this.m_rgSlotInfo.slice(),
        owners = occupants.map((u) =>
          u
            ? {
                Info: u.m_userInfo,
                Socket: u.m_pClientSocket,
                Inventory: u.m_aInventory,
                Rows: u.CaptureUserInventory()?.Rows,
                PreRows: u.CapturePreInventory().Rows,
                ConnectionGeneration: this.ChiefConnectionGeneration(u),
              }
            : undefined,
        ),
        targets = this.GetSockets(),
        groups = targets.map((s) => ({
          Array: s.m_aUser,
          Users: s.m_aUser.slice(),
        }));
      let expected = this.WaitingChiefFingerprint();
      const assertStable = () => {
        if (
          this.removalServices?.IsCurrentSession &&
          !this.removalServices.IsCurrentSession(this)
        )
          throw new CProtocolError("Stale chief room generation");
        for (let i = 0; i < SessionLimit.Players; i++) {
          const u = this.m_rgPlayer[i],
            owner = owners[i];
          if (
            u !== occupants[i] ||
            this.m_rgSlotInfo[i] !== slotBuffers[i] ||
            (u &&
              (!owner ||
                u.m_userInfo !== owner.Info ||
                u.m_pClientSocket !== owner.Socket ||
                u.m_aInventory !== owner.Inventory ||
                u.CaptureUserInventory()?.Rows !== owner.Rows ||
                u.CapturePreInventory().Rows !== owner.PreRows ||
                this.ChiefConnectionGeneration(u) !==
                  owner.ConnectionGeneration))
          )
            throw new CProtocolError(
              "Chief room owner changed during preparation",
            );
        }
        targets.forEach((s, i) => {
          const g = groups[i]!;
          if (
            s.m_aUser !== g.Array ||
            s.m_aUser.length !== g.Users.length ||
            s.m_aUser.some((u, j) => u !== g.Users[j]) ||
            !s.IsConnected()
          )
            throw new CProtocolError(
              "Chief socket group changed during preparation",
            );
          this.SocketSlots(s);
        });
        if (this.WaitingChiefFingerprint() !== expected)
          throw new CProtocolError(
            "Chief room state changed during preparation/publication",
          );
      };
      const readTime = () => {
        assertStable();
        const time = this.m_gameClock.GetCurrentTime();
        assertStable();
        return time;
      };
      assertStable();
      const superChief =
        !this.m_bPlaying &&
        chief!.HasFunctionalItem(BanChiefRule.SuperChiefAttribute);
      assertStable(); // also catches same-value native/pre reinstall inside codec
      let voteDeparture: PreparedBanPlayerDeparture | undefined;
      const plan = PlanDeferBanChief(
        this.m_banChief,
        {
          Playing: this.m_bPlaying,
          ChiefAvailable: !!chiefSocket,
          SuperChief: superChief,
          Manner: this.IsManner(),
          Capacity: this.m_nMaxPlayer,
          PlayerCount: this.GetCurPlayer(),
        },
        readTime,
        () => {
          assertStable();
          const result = this.CanStartGame(true, this.m_nMapIdxPlaying);
          assertStable();
          return result;
        },
        this.m_ulBanTargetSerialNo
          ? (next) => {
              this.#RequireLiveBanPlayerScope();
              this.#AssertOwnedBanPlayerState();
              assertStable();
              voteDeparture = this.#PrepareBanPlayerDeparture(
                chiefSocket!,
                this.CaptureBanPlayerObservation(),
                targets,
                next,
                readTime,
              );
              next.InstallSnapshot(voteDeparture.Policy.After);
              assertStable();
            }
          : undefined,
      );
      if (voteDeparture) voteDeparture.FinalChiefState = plan.After;
      const packets = plan.Notices.map((n) => ({
        ChiefOnly: n.ChiefOnly,
        Packet: MakeBanChiefPacket(n, this.text),
      }));
      if (plan.Eject) {
        if (!chiefSocket || !this.removalServices?.EjectChief)
          throw new CUnsupportedOperation(
            "DeferBanChief table removal",
            "native ordinary table-owned121/removal/pool4 service required",
          );
        this.ValidatePlayerRemoval(chiefSocket, { PlanningBatch: true });
      }
      assertStable();
      this.m_banChief.InstallSnapshot(plan.After);
      expected = this.WaitingChiefFingerprint();
      for (const { ChiefOnly, Packet } of packets) {
        if (ChiefOnly) {
          let consumed = false,
            active = true;
          try {
            this.removalServices!.EjectChief!(
              this,
              chiefSocket!,
              Packet,
              (destroy) => {
                if (!active || consumed || !this.m_bUpdating)
                  throw new CProtocolError(
                    "Chief removal callback expired/reused",
                  );
                assertStable();
                consumed = true;
                this.m_pRegulatingSocket = chiefSocket;
                this.m_plannedChiefReset = plan.After;
                this.#waitingBanDeparture = voteDeparture;
                try {
                  return destroy();
                } finally {
                  this.m_pRegulatingSocket = undefined;
                  this.m_plannedChiefReset = undefined;
                  this.#waitingBanDeparture = undefined;
                }
              },
            );
          } finally {
            active = false;
          }
          if (!consumed)
            throw new CProtocolError("Chief removal service did not commit");
        } else {
          const bytes = Packet.GetBuffer();
          for (const socket of targets) {
            assertStable();
            try {
              socket.SendPacket(
                new CSendPacket(
                  ServerResponse.BanChief,
                  Packet.GetCipherDegree(),
                  this.text,
                ).EncodeBuffer(bytes.subarray(1)),
              );
            } catch {
              this.m_nChiefWarningPublicationFailures++;
            }
            assertStable();
          }
        }
      }
    } finally {
      this.m_bUpdating = false;
    }
  }
  HasScheduledGame(): boolean {
    return this.IsWaitingChiefScheduled() || this.HasScheduledRound();
  }
  HasScheduledRound(): boolean {
    return (
      !!this.m_resultRound ||
      (this.m_bPlaying &&
        this.m_nGameState === GameStage.Loading &&
        !!this.m_nativeLaunchToken)
    );
  }
  IsLoadingGame(): boolean {
    return (
      this.m_bPlaying &&
      this.m_nGameState === GameStage.Loading &&
      !!this.m_nativeLaunchToken
    );
  }
  /** Detached modern inspection, not additional native packets or auth proof. */
  GetGameLaunchState() {
    return {
      NativeLaunch: !!this.m_nativeLaunchToken,
      LaunchTime: this.m_dwLaunchTime,
      GhostStart: this.m_dwGhostStart,
      GhostFrequency: this.m_dwGhostFrequency,
      LastGhostTime: this.m_dwLastGhostTime,
      GameSequence: this.m_dwGameSequence,
      GameSequenceKey: this.m_dwGameSequenceKey,
      RebirthMap: this.m_bRebirthMap,
      Mission: this.m_missionInfo.GetWords(),
      AirplaneInitialTime: this.m_dwAirplaneInitialTime,
      AirplaneFrequency: this.m_dwAirplaneFrequency,
      LastAirplaneRequestTime: this.m_dwLastAirplaneRequestTime,
      LapSort: [...this.m_adwLapSort],
      LapPrefix: [...this.m_adwLapPrefix],
      Opaque11612: [...this.m_anOpaque11612],
      Opaque12552: this.m_dwOpaque12552,
    };
  }
  /** 0041DF66 loading traversal. Native tests the FIRST encountered unpeered
   * slot, which can be a secondary local, for the post-removal IsSetFree guard.
   * A normal-room removal can start ready survivors inside DestroyPlayer. */
  private UpdateLoading(): void {
    this.RequireLaunchServices();
    const time = this.m_gameClock.GetCurrentTime();
    const candidates: { socket: CClientSocket; trigger: CUser }[] = [],
      seen = new Set<CClientSocket>();
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      const user = this.m_rgPlayer[slot];
      if (
        !user ||
        this.HasUDPPeerInfo(slot) ||
        (time - this.m_adwPlayerJoinTime[slot]!) >>> 0 <=
          GameConnectionTime.LoadingPeerTimeoutMs
      )
        continue;
      const socket = user.m_pClientSocket;
      if (!socket)
        throw new CProtocolError("Detached loading timeout participant");
      if (!seen.has(socket)) {
        seen.add(socket);
        candidates.push({ socket, trigger: user });
      }
    }
    if (candidates.length && !this.removalServices)
      throw new CUnsupportedOperation(
        "loading peer timeout removal",
        "no table-owned removal service; frame retained",
      );
    for (const { socket } of candidates)
      this.ValidatePlayerRemoval(socket, { PlanningBatch: true });
    // Every potential start survivor must be valid BEFORE the first ejection.
    for (const socket of this.GetSockets())
      if (!seen.has(socket)) {
        if (!socket.IsConnected())
          throw new CProtocolError("Loading survivor socket is closed");
        for (const slot of this.SocketSlots(socket)) {
          if (
            this.m_rgPlayer[slot] !== this.m_aRoundPlayers?.[slot] ||
            this.m_departedRoundUsers.has(this.m_rgPlayer[slot]!)
          )
            throw new CProtocolError("Loading survivor changed since launch");
          if (
            (this.AssertSlot(slot)[2]! & SlotStateMask.Color) >=
            SessionLimit.Players
          )
            throw new CProtocolError("Loading survivor has invalid team color");
        }
      }
    this.m_bUpdating = true;
    try {
      for (const { socket, trigger } of candidates) {
        const slot = this.FindPlayerSlot(trigger);
        if (
          slot < 0 ||
          this.HasUDPPeerInfo(slot) ||
          (time - this.m_adwPlayerJoinTime[slot]!) >>> 0 <=
            (this.m_bPlaying
              ? GameConnectionTime.LoadingPeerTimeoutMs
              : GameConnectionTime.PreparePeerTimeoutMs)
        )
          continue;
        this.m_pRegulatingSocket = socket;
        this.removalServices!.EjectPlayerForUDP(this, socket, trigger);
      }
      this.m_dwLastUpdateTime = time;
    } finally {
      this.m_pRegulatingSocket = undefined;
      this.m_bUpdating = false;
    }
  }
  GetGameClock(): CGameClock {
    return this.m_gameClock;
  }
  GetCurrentGameContext(): CGameContext {
    return this.m_gameContext;
  }
  /** Low-level native pointer deletion. Full transport/ghost/sync/chief/slot
   * cleanup belongs to DestroyPlayer, NOT this method. Modern tombstones still
   * reject same-object leave/rejoin ABA in a prepared calculator generation. */
  override DeleteAllUser(socket: CClientSocket): void {
    if (
      (this.m_bRemovingPlayer && !this.m_bDeletingPlayerRecords) ||
      this.m_bPublishingUpdate ||
      (this.m_bUpdating && !this.m_bDeletingPlayerRecords) ||
      (this.m_bGameTransition && !this.m_bDeletingPlayerRecords) ||
      ((this.m_ulBanTargetSerialNo !== 0 || !!this.#liveBanPlayer) &&
        !(
          this.m_bDeletingPlayerRecords &&
          this.#tableRemovalStack.at(-1)?.Socket === socket
        )) ||
      this.m_resultRound?.Applying ||
      this.m_resultRound?.Returning ||
      this.IsResultCommitPending() ||
      this.IsGameplayCommitPending()
    )
      throw new CProtocolError(
        "Pointer deletion during frozen result/update/removal publication",
      );
    const slots = Array.from(socket.m_aUser, (u) =>
      u ? this.FindPlayerSlot(u) : SessionLimit.NoSlot,
    );
    if (slots.some((slot) => slot < 0) || new Set(slots).size !== slots.length)
      throw new CProtocolError("Invalid departing room group");
    for (const [i, user] of socket.m_aUser.entries())
      if (this.m_aRoundPlayers?.[slots[i]!] === user)
        this.m_departedRoundUsers.add(user);
    super.DeleteAllUser(socket);
  }
  /** During removal all bodies/targets are queued detached. This preserves each
   * peer's native ordering while preventing custom SendPacket reentry between
   * partial roster/slot/chief mutations. Other room broadcasts remain immediate. */
  override SendPacket(packet: CSendPacket, except?: CClientSocket): void {
    if (this.m_bRemovingPlayer || this.m_bGameTransition)
      this.PutPacket(packet, except);
    else super.SendPacket(packet, except);
  }
  IsRemovingPlayer(): boolean {
    return (
      this.m_bRemovingPlayer ||
      this.#banPlayerOperation ||
      this.#tableRemovalStack.length !== 0
    );
  }
  /** Modern PRE-MUTATION structural/scope validation for table batches. Closed
   * sockets / marked-free users can leave; they must not receive195 afterward.
   * Uncommitted loading / unowned vote / BangPok / guild remain fail-closed.
   * PlanningBatch ignores only update ownership while doing NO mutation;
   * SessionIdsCleared validates the native table's already-detached ID tuple. */
  ValidatePlayerRemoval(
    socket: CClientSocket,
    options: { PlanningBatch?: boolean; SessionIdsCleared?: boolean } = {},
  ): void {
    const entry = this.#tableRemovalStack.at(-1),
      expected = this.#expectedBanRemoval,
      issued =
        entry?.Socket === socket ||
        !!(
          expected?.Active &&
          !expected.Consumed &&
          expected.Socket === socket
        );
    if (
      this.m_bUpdating &&
      !issued &&
      this.m_pRegulatingSocket !== socket &&
      !options.PlanningBatch
    )
      throw new CProtocolError("Player removal during a round update");
    if (
      ((this.m_bRemovingPlayer || this.m_bGameTransition) &&
        !issued &&
        !options.PlanningBatch) ||
      this.m_bPublishingUpdate ||
      this.m_resultRound?.Applying ||
      this.m_resultRound?.Returning ||
      this.IsResultCommitPending() ||
      this.IsGameplayCommitPending()
    )
      throw new CProtocolError(
        "Cannot remove a player during frozen result/update publication",
      );
    if (
      this.channelType === ChannelType.Guild ||
      this.IsBangPok() ||
      (this.m_ulBanTargetSerialNo !== 0 && !this.#HasConsistentBanPlayerState())
    )
      throw new CUnsupportedOperation(
        "DestroyPlayer special/vote recovery",
        "guild, BangPok and unowned pending vote cascades are not enabled",
      );
    if (
      this.m_bPlaying &&
      this.m_nGameState === GameStage.Loading &&
      !this.m_nativeLaunchToken
    )
      throw new CUnsupportedOperation(
        "DestroyPlayer loading recovery",
        "no complete native launch generation for post-removal start",
      );
    if (
      socket.GetUserCount() < UserCount.Minimum ||
      socket.GetUserCount() > UserCount.Maximum
    )
      throw new CProtocolError("Invalid departing local-player count");
    const slots = Array.from(socket.m_aUser, (user, self) => {
      if (!user) throw new CProtocolError("Missing departing local player");
      const slot = user.m_nSlotIdx;
      if (
        this.FindPlayerSlot(user) < 0 ||
        user.m_pClientSocket !== socket ||
        user.GetSelfidx() !== self ||
        user.GetSessionIdx() !==
          (options.SessionIdsCleared ? SessionLimit.NoSession : this.m_nIdx) ||
        user.GetSessionSerialNo() !==
          (options.SessionIdsCleared
            ? IntegerRange.UInt32Maximum
            : this.m_ulSerialNo)
      )
        throw new CProtocolError(
          "Departing socket is not in this room generation",
        );
      return slot;
    });
    if (new Set(slots).size !== slots.length)
      throw new CProtocolError("Duplicate departing slots");
    this.PlanLeavingGhosts(socket); // validates the ENTIRE mapping before mutation
  }
  /** Modern whole-image validation, shared by request and departure paths.
   * Do NOT equate count with live mappings: native departure never decrements
   * it and may even reassign to a soon-vacant local slot. */
  private GetValidatedGhostAssignments() {
    const byPlayer = this.m_anSlotGhost.slice(),
      byGhost = this.m_anGhostSlot.slice();
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      const ghost = byPlayer[slot]!;
      if (
        ghost < GameGhostAssignment.NoGhost ||
        ghost >= GameGhostRule.Capacity ||
        (ghost >= 0 && byGhost[ghost] !== slot)
      )
        throw new CProtocolError("Invalid native ghost mapping");
    }
    for (let ghost = 0; ghost < GameGhostRule.Capacity; ghost++) {
      const owner = byGhost[ghost]!;
      if (
        owner < SessionLimit.NoSlot ||
        owner >= SessionLimit.Players ||
        (owner >= 0 && byPlayer[owner] !== ghost)
      )
        throw new CProtocolError("Invalid native ghost mapping");
    }
    return { byPlayer, byGhost };
  }
  private PlanLeavingGhosts(socket: CClientSocket) {
    const { byPlayer, byGhost } = this.GetValidatedGhostAssignments();
    const packets: CSendPacket[] = [];
    for (const user of socket.m_aUser) {
      const slot = this.FindPlayerSlot(user);
      if (slot < 0) throw new CProtocolError("Ghost departure outside room");
      const ghost = byPlayer[slot]!;
      if (ghost < 0) continue;
      // Native searches BEFORE removing ANY user. Do NOT exclude the leaving
      // socket: with two locals, a ghost may be moved twice or back to an
      // already processed leaving slot. Preserve this surprising source quirk.
      const next = this.m_rgPlayer.findIndex(
        (u, i) => !!u && byPlayer[i] === GameGhostAssignment.NoGhost,
      );
      byPlayer[slot] = GameGhostAssignment.NoGhost;
      if (next < 0) {
        byGhost[ghost] = SessionLimit.NoSlot;
        packets.push(
          new CSendPacket(
            ServerResponse.DestroyGhost,
            undefined,
            this.text,
          ).Encode1(ghost),
        );
      } else {
        byPlayer[next] = ghost;
        byGhost[ghost] = next;
        packets.push(
          new CSendPacket(ServerResponse.GenerateGhost, undefined, this.text)
            .Encode1(ghost)
            .Encode1(next),
        );
      }
    }
    return { byPlayer, byGhost, packets };
  }
  /** 0041AE53. Count deliberately unchanged; public trusted adapter cannot
   * mutate another player's assignments during publication/removal callbacks. */
  DealWithGhostOfLeavingPlayer(socket: CClientSocket): void {
    if (
      this.m_bUpdating ||
      this.m_bRemovingPlayer ||
      this.m_bGameTransition ||
      this.m_resultRound?.Pending ||
      this.IsGameplayCommitPending() ||
      this.m_resultRound?.Applying ||
      this.m_resultRound?.Returning
    )
      throw new CProtocolError("Ghost departure during active room transition");
    this.SocketSlots(socket);
    this.WithGameTransition(() => this.DoDealWithGhostOfLeavingPlayer(socket));
  }
  private DoDealWithGhostOfLeavingPlayer(socket: CClientSocket): void {
    const plan = this.PlanLeavingGhosts(socket);
    this.m_anSlotGhost.set(plan.byPlayer);
    this.m_anGhostSlot.set(plan.byGhost);
    for (const packet of plan.packets) this.SendPacket(packet);
  }
  /** 0041BA8D ordinary table-owned departure. No automatic end on player<2;
   * no reset of vacant player-state/actual-bomber/join-tick/clock/calculator.
   * Frozen undurable plans and unported cascades fail BEFORE any mutation. */
  override DestroyPlayer(socket: CClientSocket, includeSelf = false): boolean {
    // Native TABLE has already cleared the shared session IDs, while direct
    // internal game-layer callers have not. Both require the exact retained
    // membership/slot group; the batch planner always requires CURRENT ids.
    const sessionIdsCleared =
      socket.GetUserCount() > 0 &&
      Array.from(socket.m_aUser).every(
        (u) =>
          !!u &&
          u.GetSessionIdx() === SessionLimit.NoSession &&
          u.GetSessionSerialNo() === IntegerRange.UInt32Maximum,
      );
    this.ValidatePlayerRemoval(socket, {
      SessionIdsCleared: sessionIdsCleared,
    });
    const primarySlot = socket.m_aUser[0]!.m_nSlotIdx,
      chiefLeft = this.IsChief(socket),
      removingBefore = this.m_bRemovingPlayer,
      removalEntry = this.#tableRemovalStack.at(-1);
    if (this.m_ulBanTargetSerialNo && removalEntry?.Socket !== socket)
      throw new CProtocolError(
        "Active vote departure requires issued table scope",
      );
    this.m_bRemovingPlayer = true;
    this.BeginPacketBatch();
    try {
      for (const user of socket.m_aUser) {
        this.m_abUDPPeerReceived[user.m_nSlotIdx] = 0;
        this.m_aUDPHost[user.m_nSlotIdx]!.fill(invalidHost);
      }
      this.DoDealWithGhostOfLeavingPlayer(socket);
      const deletingBefore = this.m_bDeletingPlayerRecords;
      this.m_bDeletingPlayerRecords = true;
      try {
        super.DestroyPlayer(socket, includeSelf);
      } finally {
        this.m_bDeletingPlayerRecords = deletingBefore;
      }
      this.m_pStrategy.DestroyPlayer(socket); // ordinary ret4
      this.m_syncGameObjMan.OnPlayerLeave(primarySlot); // ONLY first local player
      if (chiefLeft) {
        // Waiting-chief ejection preflights BOTH native clock resets before
        // sending121. Do not sample a fallible clock after roster consumption.
        if (removalEntry?.Reset)
          this.m_banChief.InstallSnapshot(removalEntry.Reset);
        else if (this.m_plannedChiefReset)
          this.m_banChief.InstallSnapshot(this.m_plannedChiefReset);
        else this.m_banChief.Init();
        this.SetNewChief();
      }
      socket.m_nPoolType = "Lobby";
      this.FlushPacket(); // deferred until final state under the modern batch
      this.DeleteAllSlotidx(socket);
      this.m_pStrategy.SendSessionInfo(); // ordinary ret4
      if (removalEntry?.Departure)
        this.#ApplyPreparedBanPlayerDeparture(removalEntry.Departure);
      // 0041BBC4: removing the unready last peer may start ready survivors.
      if (this.m_bPlaying && this.m_nGameState === GameStage.Loading) {
        const start = removalEntry?.NativeStart;
        if (this.#banPlayerOperation && this.m_bGameTransition)
          this.TryStartGame(start);
        else this.WithGameTransition(() => this.TryStartGame(start));
      }
      socket.AddBeforeJoinSession(this.m_nIdx);
      return true;
    } finally {
      try {
        this.EndPacketBatch();
      } finally {
        this.m_bRemovingPlayer = removingBefore;
      }
    }
  }
  /** Extracted calculator Init + unordered team-pair block of 00420BB3.
   * Preparation ONLY: no 116/150, clock, peer reset, playing flag or stage change.
   * Validate the whole room/socket ownership before replacing existing stats.
   */
  PrepareRoundStatistics(): void {
    if (this.m_bRemovingPlayer || this.m_bUpdating || this.m_bGameTransition)
      throw new CProtocolError(
        "Statistics preparation during player removal/update",
      );
    if (this.m_resultRound || this.m_nativeLaunchToken)
      throw new CProtocolError("Cannot replace active launch/round statistics");
    for (const socket of this.GetSockets()) this.SocketSlots(socket);
    this.InitRoundStatistics();
  }
  private InitRoundStatistics(): void {
    this.m_dynInfoCalculator.Init(this.m_rgPlayer, this.m_rgSlotInfo);
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      if (!this.m_rgPlayer[slot]) continue;
      this.m_dynInfoCalculator.IncMyTeamNo(slot); // self is included
      for (let other = slot + 1; other < SessionLimit.Players; other++) {
        if (!this.m_rgPlayer[other]) continue;
        if (
          this.m_dynInfoCalculator.GetTeamColor(slot) ===
          this.m_dynInfoCalculator.GetTeamColor(other)
        ) {
          this.m_dynInfoCalculator.IncMyTeamNo(slot);
          this.m_dynInfoCalculator.IncMyTeamNo(other);
        } else {
          this.m_dynInfoCalculator.IncOtherTeamNo(slot);
          this.m_dynInfoCalculator.IncOtherTeamNo(other);
        }
      }
    }
    this.m_aRoundPlayers = this.m_rgPlayer.slice();
    this.m_departedRoundUsers.clear();
    this.m_preparedRoundToken = Object.freeze({});
  }

  /** 0041B482: do not add an occupancy/color filter to the final state count;
   * the supplied binary counts ALL eight state bytes equal to 2 or 6.
   */
  GetWinGameResult(slot: number): boolean {
    const color = this.AssertSlot(slot)[2]! & SlotStateMask.Color;
    const own = this.m_dynInfoCalculator.GetMyTeamNo(slot);
    if (own < RoundResultRule.MinimumLargeTeamPlayers) return false;
    let otherLargeTeam = false;
    let winningStates = 0;
    for (let other = 0; other < SessionLimit.Players; other++) {
      if (
        (this.m_rgSlotInfo[other]![2]! & SlotStateMask.Color) !== color &&
        this.m_dynInfoCalculator.GetMyTeamNo(other) >=
          RoundResultRule.MinimumLargeTeamPlayers
      )
        otherLargeTeam = true;
      const state = this.m_aPlayerState[other]!;
      if (
        state === GamePlayerState.WinClaim ||
        state === GamePlayerState.HouseWinner
      )
        winningStates++;
    }
    return otherLargeTeam && winningStates === own;
  }

  /** 0041CA78: classification only; never derives authencode from TicketDate. */
  GetGameDetailResult(slot: number): number {
    this.AssertSlot(slot);
    const user = this.m_rgPlayer[slot];
    if (!user || user.IsSetFree())
      throw new CProtocolError("Missing result player");
    let result: number =
      user.GetAuthencode() === RoundResultRule.PremiumAuthencode
        ? GameDetailResult.AuthencodeOne
        : GameDetailResult.None;
    const kills = this.m_dynInfoCalculator.GetKillCount(slot);
    if (
      kills >= RoundResultRule.MinimumDetailKills &&
      kills === this.m_dynInfoCalculator.GetOtherTeamNo(slot)
    ) {
      result = GameDetailResult.KillCountMatch;
      const own = this.m_dynInfoCalculator.GetMyTeamNo(slot);
      if (
        own >= RoundResultRule.MinimumLargeTeamPlayers &&
        own === this.m_dynInfoCalculator.GetSaveCount(slot) + 1
      )
        return GameDetailResult.KillSaveCountMatch;
    }
    return result;
  }

  /** Base ordinary room virtual +156 / 004209A6 is xor eax,eax; ret. */
  IsLadderGame(): number {
    return 0;
  }

  /** Isolated calculation + 163 encoding of SendGameResult 0041FF51.
   * NO live users/calculator/clock/stage/DB/packets/rank list are changed.
   * This intentionally does NOT implement SendGameResult or end/return timers.
   * Native normal strategy callbacks are no-ops; guild plugin is unsupported.
   * The caller-provided elapsed value is trusted model input, NOT client data.
   */
  MakeGameResultPreview(
    winningColor: number,
    elapsedMilliseconds = this.m_gameClock.ElapsedTime(),
  ): GameResultPreview {
    if (this.channelType === ChannelType.Guild)
      throw new CUnsupportedOperation(
        "guild game result",
        "unported guild strategy/plugin",
      );
    if (
      !Number.isInteger(winningColor) ||
      winningColor < RoundResultRule.NoWinnerColor ||
      winningColor >= SessionLimit.Players
    )
      throw new CProtocolError("Invalid game result color");
    if (
      !Number.isInteger(elapsedMilliseconds) ||
      elapsedMilliseconds < 0 ||
      elapsedMilliseconds > IntegerRange.UInt32Maximum
    )
      throw new CProtocolError("Invalid unsigned game result duration");
    this.ValidateResultParticipants();
    const experienceScale =
      elapsedMilliseconds <= GameResultRule.ZeroRewardMilliseconds
        ? 0
        : elapsedMilliseconds > GameResultRule.FullRewardMilliseconds
          ? 1
          : Math.fround(
              (elapsedMilliseconds - GameResultRule.ZeroRewardMilliseconds) *
                GameResultRule.DurationRampReciprocal,
            );
    const specialState = this.m_aPlayerState.some(
      (state) =>
        state === GamePlayerState.LapFinished ||
        state === GamePlayerState.HouseWinner ||
        state === GamePlayerState.HouseTie,
    );
    const shopAttempt = this.m_rgPlayer.some(
      (user, slot) =>
        user &&
        this.m_aShopItemAttempted[slot] !== 0 &&
        (this.m_rgSlotInfo[slot]![2]! & SlotStateMask.Color) !== winningColor,
    );
    const calculator = this.m_dynInfoCalculator.CloneForResultCalculation();
    const premiumTeammates = this.m_rgPlayer.filter(
      (user, slot) =>
        user &&
        calculator.GetTeamColor(slot) === winningColor &&
        user.GetAuthencode() === RoundResultRule.PremiumAuthencode,
    ).length;
    const out = new CSendPacket(ServerResponse.GameResult, undefined, this.text)
      .Encode1(specialState ? 1 : 0)
      .Encode1(winningColor)
      .Encode1(this.m_pStrategy.GetResultViewType())
      .Encode1(this.IsLadderGame())
      .Encode1(shopAttempt ? 1 : 0);
    const players: (GameResultPlayerPreview | undefined)[] = [];
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      const user = this.m_rgPlayer[slot];
      out.Encode1(user ? 1 : 0);
      if (!user) {
        players.push(undefined);
        continue;
      }
      const before = user.GetDynamicInfoSnapshot();
      const projected = user.CloneForResultCalculation();
      calculator.SetHasPremium(
        user.GetAuthencode() === RoundResultRule.PremiumAuthencode ? 1 : 0,
      );
      const isDraw = winningColor === RoundResultRule.NoWinnerColor;
      const isWin =
        !isDraw &&
        (this.m_rgSlotInfo[slot]![2]! & SlotStateMask.Color) === winningColor;
      const category = isDraw
        ? GameResultCategory.Draw
        : isWin
          ? this.GetWinGameResult(slot)
            ? GameResultCategory.LargeTeamWin
            : GameResultCategory.Win
          : GameResultCategory.Lose;
      let detail: number =
        this.channelType !== ChannelType.Premium &&
        user.GetAuthencode() === RoundResultRule.PremiumAuthencode
          ? GameDetailResult.AuthencodeOne
          : GameDetailResult.None;
      let delta = 0,
        direction = 0,
        multiplier = 1;
      if (!calculator.IsInvalidGame()) {
        let base: number;
        if (isDraw) {
          base = calculator.GetDrawExp(slot);
        } else if (isWin) {
          multiplier = shopAttempt
            ? GameResultRule.OpposingShopItemWinMultiplier
            : 1;
          if (
            calculator.GetMyTeamNo(slot) >=
              GameResultRule.MinimumCachedTeamPlayersForBonus &&
            premiumTeammates >= GameResultRule.MinimumPremiumTeammates
          )
            multiplier += GameResultRule.PremiumTeammateWinBonus;
          base = calculator.GetWinExp(slot);
        } else {
          base = calculator.GetKillNSaveExp(slot);
        }
        // Only the duration ratio is f32. Multiplication and bonus addition
        // remain double until native __ftol2 truncation to the integer delta.
        delta = Math.trunc(base * experienceScale * multiplier);
        direction = projected.IncDecExp(delta);
        if (isDraw) projected.IncDraw();
        else if (isWin) {
          detail = this.GetGameDetailResult(slot);
          projected.IncWin();
        } else projected.IncLose();
      }
      let oldPercentage = CDynInfoCalculator.GetExpPercentage(
        before.Dynamic.Exp,
      );
      const newPercentage = CDynInfoCalculator.GetExpPercentage(
        projected.GetExp(),
      );
      if (oldPercentage > newPercentage) oldPercentage = 0;
      if (detail === GameDetailResult.AuthencodeOne && delta === 0)
        detail = GameDetailResult.None;
      const result = Object.freeze({
        Slot: slot,
        GlobalSerialNo: user.GetGlobalSerialNo(),
        Category: category,
        KillCount: calculator.GetKillCount(slot),
        SaveCount: calculator.GetSaveCount(slot),
        ExperienceDelta: delta,
        LevelDirection: direction,
        OldPercentage: oldPercentage,
        NewPercentage: newPercentage,
        LookLevel: projected.GetLookLevel(),
        LevelUp: direction > 0,
        Detail: detail,
        WinMultiplier: multiplier,
        Before: before,
        After: projected.GetDynamicInfoSnapshot(),
      });
      players.push(result);
      out
        .Encode4(result.GlobalSerialNo)
        .Encode1(result.Category)
        .Encode1(result.KillCount)
        .Encode1(result.SaveCount)
        .Encode2(result.OldPercentage)
        .Encode2(result.NewPercentage)
        .Encode2(result.LookLevel)
        .Encode1(result.LevelUp ? 1 : 0)
        .Encode1(result.Detail);
    }
    return Object.freeze({
      WinningColor: winningColor,
      ElapsedMilliseconds: elapsedMilliseconds,
      ExperienceScale: experienceScale,
      HasLapOrHouseState: specialState,
      DifferentColorShopItemAttempted: !!shopAttempt,
      Players: Object.freeze(players),
      RankUpdateSlots: Object.freeze(
        players.flatMap((player, slot) => (player?.LevelUp ? [slot] : [])),
      ),
      CalculatorAfterBytes: calculator.GetStateBytes(),
      Packet: out,
    });
  }

  /** Trusted test/start-tail hook; does NOT launch, start a clock or send150.
   * Native DoStartGame binds its own round. This hook cannot grant a native
   * launch token or authorize money pickup. One generation binds only once. */
  BeginResultLifecycle(): string {
    this.RequireResultServices();
    if (
      this.m_bRemovingPlayer ||
      this.m_bUpdating ||
      this.m_bGameTransition ||
      this.m_nativeLaunchToken ||
      !this.m_bPlaying ||
      this.m_nGameState !== GameStage.Running ||
      this.m_resultRound ||
      !this.m_preparedRoundToken ||
      this.m_preparedRoundToken === this.m_lastStartedRoundToken
    )
      throw new CProtocolError(
        "Result lifecycle requires a fresh running round",
      );
    this.RequireOrdinaryResultLifecycle();
    this.ValidateResultParticipants();
    return this.BindResultRound(true);
  }
  private BindResultRound(anchorLastUpdate: boolean): string {
    const round: ResultRound = {
      RoundID: randomUUID(),
      StartTick: this.m_gameClock.GetStartGameTime(),
      Pending: undefined,
      Durable: false,
      Applying: false,
      Returning: false,
      SpecialSequence: 0,
      PendingSpecial: undefined,
      SpecialAttempts: 0,
      SpecialFailure: undefined,
      HouseSequence: 0,
      PendingHouse: undefined,
      HouseAttempts: 0,
      HouseFailure: undefined,
      MoneySequence: 0,
      PendingMoney: undefined,
      MoneyAttempts: 0,
      MoneyFailure: undefined,
    };
    this.m_resultRound = round;
    this.m_lastStartedRoundToken = this.m_preparedRoundToken;
    this.m_resultPublicationFailures.length = 0;
    // The explicit trusted-test hook anchors at start. Native DoStartGame does
    // NOT write+12548: network rounds preserve the last loading Update tick.
    if (anchorLastUpdate) this.m_dwLastUpdateTime = round.StartTick;
    this.m_nBombTimerPublicationFailures = 0;
    this.m_nServerDiePublicationFailures = 0;
    return round.RoundID;
  }
  /** 0041B193 is literally C3 (ret), verified in the supplied PE and .lst.
   * This is a native no-op, NOT a placeholder for gameplay/recovery work. */
  UpdateGameEtc(): void {}

  GetResultRoundID(): string | undefined {
    return this.m_resultRound?.RoundID;
  }
  /** Modern diagnostics: a CAS conflict returns normally but is NOT a healthy
   * running frame. Do not hide the frozen, not-yet-durable result in health data. */
  IsResultCommitPending(): boolean {
    return !!this.m_resultRound?.Pending && !this.m_resultRound.Durable;
  }
  GetResultPublicationFailures(): readonly ResultPublicationFailure[] {
    return this.m_resultPublicationFailures.slice();
  }
  /** Modern inspection helpers, not native virtual methods. */
  GetLastUpdateTime(): number {
    return this.m_dwLastUpdateTime;
  }
  GetUpdatePublicationFailures(): GameUpdatePublicationFailures {
    return {
      BombTimer: this.m_nBombTimerPublicationFailures,
      ServerDie: this.m_nServerDiePublicationFailures,
    };
  }

  /** Guarded ordinary waiting/Loading/Running/Result Update0041DC31.
   * Nonplaying ordinary rooms run the separate guarded DeferBanChief branch;
   * native loading / bound result round remain required for battle. Practice
   * and special-mode drivers stay unavailable. Frozen money/house retries
   * precede even clock sampling and end their tick. Otherwise: claims -> active
   * timeout -> UDP regulation -> bombs -> pending deaths -> queued publication.
   * Due UDP graphs require the native table removal/195/pool4 service; without
   * it they fail CLOSED before timers/graph consumption. No silent loss reset.
   * Last-update time is the tick sampled at entry, NOT a later send/SQL sample.
   */
  Update(): void {
    if (this.m_bUpdating || this.m_bRemovingPlayer || this.m_bGameTransition)
      return;
    if (!this.m_bPlaying) {
      if (this.IsWaitingChiefScheduled()) this.DeferBanChief();
      return;
    }
    if (this.m_nGameState === GameStage.Loading && this.m_nativeLaunchToken) {
      this.UpdateLoading();
      return;
    }
    if (
      this.m_nGameState !== GameStage.Running &&
      this.m_nGameState !== GameStage.Result
    )
      throw new CUnsupportedOperation(
        "CGameSession::Update unbound loading",
        "native loading generation required; practice/special-mode recovery remains unported",
      );
    this.RequireOrdinaryResultLifecycle();
    const round = this.RequireResultRound();
    if (round.PendingMoney || round.PendingHouse || round.PendingSpecial) {
      this.m_bUpdating = true;
      try {
        this.WithGameTransition(() =>
          round.PendingSpecial
            ? this.CommitPendingSpecialItemUse(round)
            : round.PendingHouse
              ? this.CommitPendingHouseClaim(round)
              : this.CommitPendingMoneyPickup(round),
        );
      } finally {
        this.m_bUpdating = false;
      }
      // Retry neither consumes a frame delta nor captures a result this tick.
      return;
    }
    const time = this.m_gameClock.GetCurrentTime();
    this.m_bUpdating = true;
    try {
      this.UpdateResultLifecycle();
      if (
        this.m_nGameState === GameStage.Running &&
        !round.Pending &&
        !round.Durable
      ) {
        if (this.m_udpLossRegulator.IsRegulationDue()) {
          const candidates = this.m_udpLossRegulator.GetRegulationCandidates(
            this.m_rgPlayer,
          );
          if (candidates.length && !this.removalServices)
            throw new CUnsupportedOperation(
              "CUdpLossRegulator ejection/recovery",
              "no table removal / 195 / native pool-type-4 service attached; graph retained",
            );
          // All predictable scope/identity/mapping failures are checked before
          // the FIRST socket leaves. Actual removals are then table-owned.
          for (const socket of candidates)
            this.ValidatePlayerRemoval(socket, { PlanningBatch: true });
          try {
            for (const socket of candidates) {
              this.m_pRegulatingSocket = socket;
              this.removalServices!.EjectPlayerForUDP(this, socket);
            }
          } finally {
            this.m_pRegulatingSocket = undefined;
          }
          this.m_udpLossRegulator.Init();
        }
        // Native PutPacket queues BOTH bodies before FlushPacket. Advancing
        // state and building both packets before any SendPacket also prevents
        // a custom transport from settling between the bomb and death blocks.
        const bombPacket = this.MakeBombTimerUpdatePacket(
          (time - this.m_dwLastUpdateTime) >>> 0,
        );
        const expired = this.m_gameContext.AdvancePlayerStateTimers(
          this.m_aPlayerState,
          () => this.m_gameClock.ElapsedTime(),
        );
        const deathPacket = expired.length
          ? this.MakeServerDieUpdatePacket(expired)
          : undefined;
        this.PublishUpdatePackets(
          [bombPacket, deathPacket].filter((p) => p !== undefined),
        );
      }
      // Also written after Result/return and a frozen CAS-conflict tick, as
      // native writes it at the end of the playing branch. Thrown failures do
      // NOT consume an unprocessed frame delta.
      this.m_dwLastUpdateTime = time;
    } finally {
      this.m_bUpdating = false;
    }
  }
  private MakeServerDieUpdatePacket(slots: readonly number[]): CSendPacket {
    const out = new CSendPacket(
      ServerResponse.BomberEvent,
      undefined,
      this.text,
    )
      .Encode1(BomberEvent.ServerDie << BomberEvent.KindShift)
      .Encode2(PlayerStateTimerRule.ServerDieHeaderCoordinate)
      .Encode2(PlayerStateTimerRule.ServerDieHeaderCoordinate)
      .Encode1(slots.length);
    for (const slot of slots)
      out
        .Encode1(slot)
        .Encode2(PlayerStateTimerRule.ServerDieEntryCoordinate)
        .Encode2(PlayerStateTimerRule.ServerDieEntryCoordinate);
    // OnBomberDie 0041BFAB has NO further effect in ordinary Normal mode. Mod
    // was rejected before any timer mutation; never omit its cascade silently.
    return out;
  }
  private PublishUpdatePackets(packets: readonly CSendPacket[]): void {
    if (!packets.length) return;
    // Capture byte bodies AND targets before invoking any user-defined callback.
    const bodies = packets.map((p) => ({
      Type: p.m_nPacketType,
      Bytes: p.GetBuffer(),
    }));
    const targets = this.GetSockets();
    this.m_bPublishingUpdate = true;
    try {
      for (const socket of targets)
        for (const { Type, Bytes } of bodies) {
          const packet = new CSendPacket(
            Type,
            undefined,
            this.text,
          ).EncodeBuffer(Bytes.subarray(1));
          try {
            socket.SendPacket(packet);
          } catch {
            if (Type === ServerResponse.BombTimer)
              this.m_nBombTimerPublicationFailures++;
            else this.m_nServerDiePublicationFailures++;
          }
        }
    } finally {
      this.m_bPublishingUpdate = false;
    }
    // Delivery failure never re-applies timers, automatically replays a body or
    // creates a second death. There is no client acknowledgement in this API.
  }

  /** 0041D31A ordinary end boundary, now with a modern durable-before-memory
   * guard. Frozen result/duration is reused on retry, never recalculated into
   * a different winner or larger XP. IncGame keeps its conflicting-claim prefix.
   * false means not ready OR storage conflict; neither publishes partial success.
   */
  DeferHandleGameEnd(): boolean {
    if (
      this.m_bGameTransition ||
      this.m_bPublishingUpdate ||
      this.m_bRemovingPlayer ||
      this.m_pRegulatingSocket ||
      this.IsGameplayCommitPending()
    )
      return false;
    if (!this.m_bPlaying || this.m_nGameState !== GameStage.Running)
      return false;
    const round = this.RequireResultRound();
    if (round.Applying || round.Durable) return false;
    if (!round.Pending) {
      const decision = this.GetGameEndDecision();
      if (!decision.Ready) return false;
      this.CapturePendingResult(
        round,
        decision.WinningColor,
        "claims",
        decision.CountedSlots,
      );
    }
    return this.CommitPendingResult(round);
  }

  /** Extracted END/RETURN portion of Update 0041DC31, also called by the
   * guarded Running/Result driver. This helper alone advances no bomb/state
   * timers or pool removal, and cannot authorize launch or schedule a room.
   * Claims are checked BEFORE the >180000ms unsigned active-time cutoff.
   * Native timeout does NOT IncGame and does NOT call sync.OnGameEnd here.
   */
  UpdateResultLifecycle(): boolean {
    if (
      this.m_bGameTransition ||
      this.m_bPublishingUpdate ||
      this.m_bRemovingPlayer ||
      this.m_pRegulatingSocket ||
      this.IsGameplayCommitPending()
    )
      return false;
    if (!this.m_bPlaying) return false;
    if (this.m_nGameState === GameStage.Result)
      return this.DeferReturnPrepareStage();
    if (this.m_nGameState !== GameStage.Running) return false;
    const round = this.RequireResultRound();
    if (round.Applying || round.Durable) return false;
    if (round.Pending) {
      const committed = this.CommitPendingResult(round);
      if (committed && round.Pending.Submission.Reason === "claims")
        this.m_syncGameObjMan.OnGameEnd();
      return committed;
    }
    if (this.DeferHandleGameEnd()) {
      this.m_syncGameObjMan.OnGameEnd();
      return true;
    }
    if (round.Pending) return false; // conflict must not be replaced by timeout
    const active =
      (this.m_gameClock.ElapsedTime() - this.m_gameClock.m_dwTimeStopped) >>> 0;
    if (active <= GameResultTiming.MaximumActiveMilliseconds) return false;
    this.CapturePendingResult(
      round,
      RoundResultRule.NoWinnerColor,
      "timeout",
      [],
    );
    return this.CommitPendingResult(round);
  }

  /** 0041B0B7: caller phase/receipt gate is modern; deadline is native strict >. */
  DeferReturnPrepareStage(): boolean {
    if (
      this.m_bGameTransition ||
      this.m_bPublishingUpdate ||
      this.m_bRemovingPlayer ||
      this.m_pRegulatingSocket ||
      this.IsGameplayCommitPending()
    )
      return false;
    const round = this.m_resultRound;
    if (
      !this.m_bPlaying ||
      this.m_nGameState !== GameStage.Result ||
      !round?.Durable ||
      round.Returning ||
      round.Applying
    )
      return false;
    if (
      (this.m_gameClock.GetCurrentTime() -
        this.m_gameClock.GetEndGameTime()) >>>
        0 <=
      GameResultTiming.ReturnPrepareMilliseconds
    )
      return false;
    return this.DoReturnPrepareStage();
  }
  /** 0041B0DA ordinary non-BangPok tail: 164 BEFORE state reset; preserve the
   * SELECTED map, calculator/player/peer/shop states, identity and chief/closed
   * bits. Only the actual playing map/bombers and ready bits are reset here. */
  DoReturnPrepareStage(): boolean {
    if (
      this.m_bGameTransition ||
      this.m_bPublishingUpdate ||
      this.m_bRemovingPlayer ||
      this.m_pRegulatingSocket ||
      this.IsGameplayCommitPending()
    )
      return false;
    const round = this.m_resultRound;
    if (
      !this.m_bPlaying ||
      this.m_nGameState !== GameStage.Result ||
      !round?.Durable ||
      round.Returning ||
      round.Applying
    )
      return false;
    if (this.IsBangPok())
      throw new CUnsupportedOperation(
        "DoBangPok",
        "group teardown is not ported",
      );
    round.Returning = true;
    for (const socket of this.GetSockets()) {
      try {
        socket.SendPacket(
          new CSendPacket(
            ServerResponse.ReturnPrepareStage,
            undefined,
            this.text,
          ).Encode1(0),
        );
      } catch {
        this.m_resultPublicationFailures.push("return-packet");
      }
    }
    const vote = PlanNativeVoteTransition(
      {
        TargetSerialNo: this.m_ulBanTargetSerialNo,
        Votes: Array.from(this.m_anBanPlayerVote),
      },
      "ReturnPrepare",
    );
    this.m_nGameState = GameStage.Loading;
    this.m_ulBanTargetSerialNo = vote.TargetSerialNo;
    this.#liveBanPlayer = undefined;
    this.m_nMapIdxPlaying = -1;
    this.m_dwStartChatTimeTick = this.m_gameClock.GetCurrentTime();
    this.SetPlaying(false);
    this.m_aBomberIdxPlaying.fill(-1);
    for (const slot of this.m_rgSlotInfo)
      slot[0] = slot[0]! & ~SlotStateMask.Status;
    this.m_pStrategy.SendSessionInfo(); // vtable+32 ordinary no-op
    this.m_resultRound = undefined;
    this.m_nativeLaunchToken = undefined;
    return true;
  }

  private RequireResultServices(): GameResultServices {
    if (!this.resultServices)
      throw new CUnsupportedOperation(
        "game result storage",
        "no durable result services attached",
      );
    return this.resultServices;
  }
  private RequireResultRound(): ResultRound {
    this.RequireResultServices();
    if (!this.m_resultRound)
      throw new CProtocolError("Result lifecycle has not been begun");
    return this.m_resultRound;
  }
  private RequireOrdinaryResultLifecycle(): void {
    if (
      this.channelType === ChannelType.Guild ||
      this.IsBangPok() ||
      this.m_nGameType !== GameType.Normal
    )
      throw new CUnsupportedOperation(
        "special result lifecycle",
        "guild/BangPok/Mod lifecycle remains unported",
      );
  }
  private ValidateResultParticipants(): void {
    if (!this.m_aRoundPlayers || !this.m_dynInfoCalculator.IsInitialized())
      throw new CProtocolError("Round statistics have not been prepared");
    for (const socket of this.GetSockets()) {
      if (!socket.IsConnected())
        throw new CProtocolError("Result socket is closed");
      this.SocketSlots(socket);
    }
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      if (!this.m_rgPlayer[slot]) continue; // departures retain native snapshot counts
      const user = this.m_rgPlayer[slot]!;
      // Terminal Center cleanup may detach a user AFTER room departure failed
      // closed on an undurable frozen plan. Such an occupied-but-freed record
      // is NOT an eligible offline award recipient. Preserve the plan; reject
      // before SQLite rather than silently changing its roster/duration/key.
      if (
        user.IsSetFree() !== 0 ||
        !user.m_pClientSocket ||
        user.GetSelfidx() < 0
      )
        throw new CProtocolError("Result participant was terminally detached");
      if (
        this.m_rgPlayer[slot] !== this.m_aRoundPlayers[slot] ||
        this.m_departedRoundUsers.has(this.m_rgPlayer[slot]!)
      )
        throw new CProtocolError(
          "Result player changed since round preparation",
        );
      if (
        (this.AssertSlot(slot)[2]! & SlotStateMask.Color) >=
        SessionLimit.Players
      )
        throw new CProtocolError("Result team color is outside 0..7");
    }
  }
  private ResultFingerprint(): string {
    return JSON.stringify({
      Players: this.m_rgPlayer.map((u) =>
        u
          ? [
              u.GetGlobalSerialNo(),
              u.GetAuthencode(),
              u.GetDynamicInfoSnapshot(),
              u.GetUserInventoryGeneration(),
              u.GetPreInventoryGeneration(),
            ]
          : null,
      ),
      Slots: this.m_rgSlotInfo.map((slot) => slot.toString("hex")),
      States: [...this.m_aPlayerState],
      Shop: [...this.m_aShopItemAttempted],
      Calculator: this.m_dynInfoCalculator.GetStateBytes().toString("hex"),
      Clock: this.m_gameClock.GetStateSnapshot(),
      GameType: this.m_nGameType,
      PlayingMap: this.m_nMapIdxPlaying,
    });
  }
  private CapturePendingResult(
    round: ResultRound,
    winningColor: number,
    reason: "claims" | "timeout",
    counted: readonly number[],
  ): void {
    if (round.PendingMoney || round.PendingHouse || round.PendingSpecial)
      throw new CProtocolError(
        "Money/house/inventory must resolve before result capture",
      );
    // Native claims sample EndGame BEFORE SendGameResult's ElapsedTime read;
    // timeout samples EndGame AFTER publication. This private early sample is
    // applied only for claims, and only after the database transaction succeeds.
    this.RequireOrdinaryResultLifecycle();
    const endTick = reason === "claims" ? this.m_gameClock.GetCurrentTime() : 0;
    const preview = this.MakeGameResultPreview(winningColor);
    const submission: GameResultSubmission = Object.freeze({
      RoundID: round.RoundID,
      ChannelIndex: this.RequireResultServices().ChannelIndex,
      SessionIndex: this.m_nIdx,
      SessionSerialNo: this.m_ulSerialNo,
      StartTick: round.StartTick,
      ElapsedMilliseconds: preview.ElapsedMilliseconds,
      WinningColor: winningColor,
      Reason: reason,
      InvalidGame: !!this.m_dynInfoCalculator.IsInvalidGame(),
      CountedSlots: Object.freeze([...counted]),
      Changes: Object.freeze(
        preview.Players.flatMap((p) =>
          p
            ? [
                {
                  Slot: p.Slot,
                  GlobalSerialNo: p.GlobalSerialNo,
                  Category: p.Category,
                  ExperienceDelta: p.ExperienceDelta,
                  Before: p.Before.Dynamic,
                  After: p.After.Dynamic,
                },
              ]
            : [],
        ),
      ),
      Packet: preview.Packet.GetBuffer(),
    });
    round.Pending = {
      Preview: preview,
      Submission: submission,
      Fingerprint: this.ResultFingerprint(),
      Occupants: this.m_rgPlayer.slice(),
      EndTick: endTick,
    };
  }
  private CommitPendingResult(round: ResultRound): boolean {
    const pending = round.Pending;
    if (
      !pending ||
      round.Durable ||
      round.Applying ||
      round.PendingMoney ||
      round.PendingHouse ||
      round.PendingSpecial
    )
      return false;
    this.RequireOrdinaryResultLifecycle();
    this.ValidateResultParticipants();
    if (
      this.m_gameClock.GetStartGameTime() !== round.StartTick ||
      this.ResultFingerprint() !== pending.Fingerprint ||
      pending.Occupants.some((u, slot) => this.m_rgPlayer[slot] !== u)
    )
      throw new CProtocolError(
        "Pending game result changed; explicit recovery required",
        "result-state-changed",
      );
    round.Applying = true;
    try {
      const status = this.RequireResultServices().DB.CommitGameResult(
        pending.Submission,
      );
      if (status === "conflict") return false;
      // A trusted storage callback can replace a native read-side generation
      // (even byte-identically). Do not install/publish a frozen result after
      // such drift; its already-committed receipt is NOT rolled back/rebased.
      if (
        this.ResultFingerprint() !== pending.Fingerprint ||
        pending.Occupants.some((u, slot) => this.m_rgPlayer[slot] !== u)
      )
        throw new CProtocolError(
          "Pending game result changed after storage; explicit recovery required",
          "result-state-changed",
        );
      // Durable marker precedes callbacks/transport: reentrant calls can NEVER
      // award twice. No await between transaction, native fields and stage.
      round.Durable = true;
      for (const slot of pending.Submission.CountedSlots)
        pending.Occupants[slot]!.IncGame();
      if (pending.Submission.Reason === "claims")
        this.m_gameClock.EndGameAt(pending.EndTick);
      this.SendGameResult(pending.Submission.WinningColor);
      if (pending.Submission.Reason === "timeout") this.m_gameClock.EndGame();
      this.m_nGameState = GameStage.Result;
      return true;
    } finally {
      round.Applying = false;
    }
  }
  /** Native result mutation/publication AFTER the SQLite durability boundary.
   * Private and gated by the matching durable ordinary result. Each player's rank
   * update stays interleaved with that player's level mutation as in native;
   * do not globally sort after all users (level-down is intentionally not moved).
   */
  private SendGameResult(winningColor: number): void {
    const round = this.m_resultRound!,
      pending = round.Pending!;
    if (!round.Durable || winningColor !== pending.Submission.WinningColor)
      throw new CProtocolError(
        "Result publication without matching durable receipt",
      );
    for (const p of pending.Preview.Players) {
      if (!p) continue;
      const user = pending.Occupants[p.Slot]!;
      this.m_dynInfoCalculator.SetHasPremium(
        user.GetAuthencode() === RoundResultRule.PremiumAuthencode ? 1 : 0,
      );
      if (!pending.Submission.InvalidGame) {
        user.IncDecExp(p.ExperienceDelta);
        if (p.Category === GameResultCategory.Draw) user.IncDraw();
        else if (p.Category === GameResultCategory.Lose) user.IncLose();
        else user.IncWin();
      }
      if (p.LevelUp) {
        try {
          this.RequireResultServices().UpdateRankList(user);
        } catch {
          this.m_resultPublicationFailures.push("rank");
        }
      }
    }
    // Detached per-target packet: a test/custom consumer cannot mutate the
    // immutable stored result or the next peer's delivery attempt. TCP enqueue
    // is NOT an end-to-end delivery acknowledgement and is not retried here.
    for (const socket of this.GetSockets()) {
      const packet = new CSendPacket(
        ServerResponse.GameResult,
        undefined,
        this.text,
      ).EncodeBuffer(pending.Submission.Packet.subarray(1));
      try {
        socket.SendPacket(packet);
      } catch {
        this.m_resultPublicationFailures.push("packet");
      }
    }
  }

  /** Pure extraction, NOT DeferHandleGameEnd: no counters, clock or settlement.
   * Assembly 0041D347..0041D354 confirms (occupied && state==5) || state==6,
   * even for an EMPTY slot with stale state 6. Preserve this known quirk here.
   * HasAuthority(25) is a constant-zero stub in this supplied FXGS build.
   */
  GetGameEndDecision(): GameEndDecision {
    const forced = this.m_aPlayerState.some(
      (state, slot) =>
        (!!this.m_rgPlayer[slot] && state === GamePlayerState.LapFinished) ||
        state === GamePlayerState.HouseWinner,
    );
    if (
      !forced &&
      this.m_aPlayerState.some(
        (state, slot) =>
          !!this.m_rgPlayer[slot] &&
          (state === GamePlayerState.Active ||
            state === GamePlayerState.PendingDie),
      )
    )
      return {
        Ready: false,
        Forced: false,
        WinningColor: RoundResultRule.NoWinnerColor,
        ConflictingClaims: false,
        CountedSlots: [],
      };
    let color: number = RoundResultRule.NoWinnerColor;
    const counted: number[] = [];
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      if (!this.m_rgPlayer[slot]) continue;
      const state = this.m_aPlayerState[slot]!;
      if (
        state === GamePlayerState.WinClaim ||
        state === GamePlayerState.LapFinished ||
        state === GamePlayerState.HouseWinner
      ) {
        const candidate = this.m_rgSlotInfo[slot]![2]! & SlotStateMask.Color;
        if (color !== RoundResultRule.NoWinnerColor && color !== candidate)
          return {
            Ready: true,
            Forced: forced,
            WinningColor: RoundResultRule.NoWinnerColor,
            ConflictingClaims: true,
            CountedSlots: counted,
          };
        color = candidate;
      }
      counted.push(slot);
    }
    return {
      Ready: true,
      Forced: forced,
      WinningColor: color,
      ConflictingClaims: false,
      CountedSlots: counted,
    };
  }

  /** Guarded common subset of 0041EE05. 0 and Mod's captain cascade remain
   * unavailable. Native normal-mode OnBomberDie 0041BFAB has no side effects.
   * Decode/validate the entire event BEFORE any counter/state/drop mutation.
   */
  OnSetBomberEvent(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket, false, false, true);
    const header = packet.Decode1();
    const x = packet.Decode2();
    const y = packet.Decode2();
    const slot = header & BomberEvent.SlotMask;
    const kind = header >>> BomberEvent.KindShift;
    this.RequireActor(slot, socket);
    if (kind !== BomberEvent.SpecialItem && this.IsSpecialItemUsePending())
      throw new CProtocolError(
        "Round inventory is frozen pending durability/publication",
      );
    if (!this.m_dynInfoCalculator.IsInitialized())
      throw new CUnsupportedOperation(
        "round statistics",
        "launch preparation has not run",
      );
    const out = new CSendPacket(
      ServerResponse.BomberEvent,
      undefined,
      this.text,
    )
      .Encode1(header)
      .Encode2(x)
      .Encode2(y);
    switch (kind) {
      case BomberEvent.SpecialItem:
        this.OnUseSpecialItem(packet, socket, slot, x, y);
        return;
      case BomberEvent.Notify1:
      case BomberEvent.Notify7:
        packet.AssertEnd();
        break;
      case BomberEvent.PendingDie:
        packet.AssertEnd();
        this.m_aPlayerState[slot] = GamePlayerState.PendingDie;
        this.m_gameContext.m_aPlayerStateTime[slot] =
          this.m_gameClock.ElapsedTime();
        // These WORDs are CPoint coordinates, NOT packed/grid tile indices.
        this.m_gameContext.m_aGhostPosition[slot] = { x, y };
        break;
      case BomberEvent.Save: {
        const saver = packet.Decode1();
        packet.AssertEnd();
        if (saver < SessionLimit.Players)
          this.m_dynInfoCalculator.SetSaverIndex(slot, saver);
        this.m_aPlayerState[slot] = GamePlayerState.Active;
        // Native forwards the five-byte header only; saver is NOT appended.
        break;
      }
      case BomberEvent.Die: {
        if (this.m_nGameType !== GameType.Normal)
          throw new CUnsupportedOperation(
            "Mod captain death cascade",
            "OnBomberDie 0041BFAB is not ported",
          );
        const killer = packet.Decode1();
        if (killer !== BomberEvent.NoKiller && killer >= SessionLimit.Players)
          throw new CProtocolError("Invalid killer slot");
        const count = packet.Decode1();
        const drops = Array.from({ length: count }, () => ({
          position: packet.Decode1(),
          box: packet.Decode1(),
        }));
        packet.AssertEnd();
        for (const { position, box } of drops) {
          if (
            box >= GameContextLimit.BoxItems ||
            position >>> GamePosition.RowShift >= GameContextLimit.Rows ||
            (position & GamePosition.ColumnMask) >= GameContextLimit.Columns
          )
            throw new CProtocolError("Invalid death-drop index or position");
        }
        if (killer !== BomberEvent.NoKiller)
          this.m_dynInfoCalculator.SetKillerIndex(slot, killer);
        out.Encode1(killer).Encode1(count);
        for (const { position, box } of drops) {
          this.m_gameContext.m_aBoxItemState[box] = GamePickupState.Unclaimed;
          this.m_gameContext.SetObstacleState(
            position >>> GamePosition.RowShift,
            position & GamePosition.ColumnMask,
            GamePickupState.Unclaimed,
          );
          out.Encode1(position).Encode1(box);
        }
        this.SendPacket(out); // unlike other supported events, includes sender
        if (this.m_aPlayerState[slot] !== GamePlayerState.Excluded4) {
          this.m_aPlayerState[slot] = GamePlayerState.Inactive;
          this.m_gameContext.m_aPlayerStateTime[slot] =
            this.m_gameClock.ElapsedTime();
        }
        return;
      }
      case BomberEvent.WinClaim:
        packet.AssertEnd();
        this.m_aPlayerState[slot] = GamePlayerState.WinClaim;
        break;
      case BomberEvent.Opaque8: {
        this.RequireNativeRunningRound(socket, "bomber event8 native round");
        const first = packet.Decode1(),
          second = packet.Decode1();
        packet.AssertEnd();
        out.Encode1(first).Encode1(second);
        this.WithGameTransition(() => this.SendPacket(out, socket));
        return;
      }
      case BomberEvent.ServerDie:
        throw new CProtocolError("Client attempted server-only die event");
      default:
        throw new CUnsupportedOperation(
          `bomber event ${kind}`,
          "unknown variants remain unported",
        );
    }
    this.SendPacket(out, socket);
  }

  /** 0041B5C8 is a genuine native C3/ret, not a missing resurrection engine.
   * No state/timer/position/ghost mutation and no guessed Update invocation. */
  DeferResurrection(): void {}

  /** 0041CBB2. The first BYTE is an opaque stored STATE, not an owned actor
   * slot. Native overwrites previous states and echoes ALL pairs, including
   * repeats and count0. It directly indexes row*45+column without axis checks:
   * preserve safe in-plane aliases, but reject memory-overrun indices. This is
   * a modern whole-body / native-round boundary, not spawn authorization. */
  OnReqEatBula(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireNativeRunningRound(socket, "Bula native round");
    const state = packet.Decode1(),
      count = packet.Decode1(),
      cells = Array.from({ length: count }, () => ({
        row: packet.Decode1(),
        column: packet.Decode1(),
      }));
    packet.AssertEnd();
    const entries = cells.map(({ row, column }) => {
      const index = row * GameContextLimit.BulaColumns + column;
      if (index >= this.m_gameContext.m_aBulaState.length)
        throw new CProtocolError("Bula flat index exceeds native state plane");
      return { row, column, index };
    });
    const out = new CSendPacket(
      ServerResponse.EatBula,
      undefined,
      this.text,
    ).Encode1(count);
    for (const { row, column } of entries)
      out.Encode1(row).Encode1(column).Encode1(state);
    this.WithGameTransition(() => {
      for (const { index } of entries)
        this.m_gameContext.m_aBulaState[index] = state;
      this.SendPacket(out);
    });
  }

  /** 0041B5E9. Native checks only slot<8, NOT sender ownership/occupancy.
   * Its two progress bytes are NOT spatial coordinates or a finish claim.
   * Compare unsigned64 (inverted progress HIGH, absolute tick LOW); don't use
   * signed32, elapsed time, or double packing (loses low bits above2^53).
   * Unknown occupied records rank too; exact ties prefer the lower slot. */
  OnLapInfo(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireNativeRunningRound(socket, "lap-info native round");
    const slot = packet.Decode1();
    this.AssertSlot(slot);
    const first = packet.Decode1(),
      second = packet.Decode1();
    packet.AssertEnd();
    this.WithGameTransition(() => {
      const tick = this.m_gameClock.GetCurrentTime(),
        offset = slot * GameLaunchRule.LapSortWordsPerSlot;
      this.m_adwLapSort[offset] = tick;
      this.m_adwLapSort[offset + 1] =
        ((GameLapRule.ProgressByteMaximum - first) <<
          GameLapRule.ProgressHighShift) |
        (GameLapRule.ProgressByteMaximum - second);
      this.m_adwLapPrefix[slot] = first;
      const ranks = Array<number>(SessionLimit.Players).fill(
        GameLapRule.FirstRank,
      );
      let reported = 0;
      for (let i = 0; i < SessionLimit.Players; i++) {
        if (!this.m_rgPlayer[i]) continue;
        const low = this.m_adwLapSort[i * GameLaunchRule.LapSortWordsPerSlot]!,
          high = this.m_adwLapSort[i * GameLaunchRule.LapSortWordsPerSlot + 1]!;
        // Native AND ==FFFFFFFF only when BOTH words are unknown.
        if ((low & high) !== -1) reported++;
        for (let j = i + 1; j < SessionLimit.Players; j++) {
          if (!this.m_rgPlayer[j]) continue;
          const otherLow =
              this.m_adwLapSort[j * GameLaunchRule.LapSortWordsPerSlot]!,
            otherHigh =
              this.m_adwLapSort[j * GameLaunchRule.LapSortWordsPerSlot + 1]!;
          ranks[
            high > otherHigh || (high === otherHigh && low > otherLow) ? i : j
          ]!++;
        }
      }
      const out = new CSendPacket(
        ServerResponse.LapInfo,
        undefined,
        this.text,
      ).Encode1(reported);
      for (let i = 0; i < SessionLimit.Players; i++) {
        if (this.m_rgPlayer[i])
          out.Encode1(ranks[i]!).Encode1(this.m_adwLapPrefix[i]!);
        else
          out.Encode1(GameLapRule.VacantByte).Encode1(GameLapRule.VacantByte);
      }
      this.SendPacket(out);
    });
  }

  /** 0041FDA7. First occupied state-5 slot wins; no broadcast/settlement here. */
  OnLapFinished(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket);
    const slot = packet.Decode1();
    packet.AssertEnd();
    this.RequireActor(slot, socket);
    if (
      !this.m_aPlayerState.some(
        (state, other) =>
          !!this.m_rgPlayer[other] && state === GamePlayerState.LapFinished,
      )
    )
      this.m_aPlayerState[slot] = GamePlayerState.LapFinished;
  }

  /** 0041CC8B, house-count arbitration, not a timer or a full result sender.
   * Packet is empty in the original; modern phase/membership/framing checks
   * do NOT prove the client requested this at the correct gameplay time.
   */
  OnShobuari(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket);
    packet.AssertEnd();
    const eligible = new Set<number>();
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      const state = this.m_aPlayerState[slot]!;
      const color = this.m_rgSlotInfo[slot]![2]! & SlotStateMask.Color;
      if (
        this.m_rgPlayer[slot] &&
        state !== GamePlayerState.Inactive &&
        state !== GamePlayerState.Excluded4 &&
        color < SessionLimit.Players
      )
        eligible.add(color);
    }
    let best = -1;
    let winner: number = RoundResultRule.NoWinnerColor;
    let tie = false;
    for (let color = 0; color < SessionLimit.Players; color++) {
      if (!eligible.has(color)) continue;
      const count = this.m_gameContext.m_aHouseCount[color]!;
      if (count > best) {
        best = count;
        winner = color;
        tie = false;
      } else if (count === best) tie = true;
    }
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      if (!this.m_rgPlayer[slot]) continue;
      if (tie || winner === RoundResultRule.NoWinnerColor)
        this.m_aPlayerState[slot] = GamePlayerState.HouseTie;
      else if (
        (this.m_rgSlotInfo[slot]![2]! & SlotStateMask.Color) === winner &&
        this.m_aPlayerState[slot] !== GamePlayerState.Inactive
      )
        this.m_aPlayerState[slot] = GamePlayerState.HouseWinner;
    }
  }

  IsHouseClaimPending(): boolean {
    return !!this.m_resultRound?.PendingHouse;
  }
  IsGameplayCommitPending(): boolean {
    return (
      this.IsMoneyPickupPending() ||
      this.IsHouseClaimPending() ||
      this.IsSpecialItemUsePending()
    );
  }
  GetHouseClaimState(): HouseClaimState {
    const round = this.m_resultRound;
    return {
      Sequence: round?.HouseSequence ?? 0,
      Pending: !!round?.PendingHouse,
      Attempts: round?.HouseAttempts ?? 0,
      Failure: round?.HouseFailure,
    };
  }
  private ValidatePendingHouseClaim(
    round: ResultRound,
    pending: PendingHouseClaim,
  ): boolean {
    try {
      this.RequireOrdinaryResultLifecycle();
      this.ValidateResultParticipants();
      const request = pending.Submission;
      if (
        this.m_resultRound !== round ||
        !this.m_bPlaying ||
        this.m_nGameState !== GameStage.Running ||
        round.Pending ||
        round.PendingMoney ||
        round.PendingSpecial ||
        round.Durable ||
        round.Applying ||
        round.Returning ||
        !this.m_nativeLaunchToken ||
        this.m_nativeLaunchToken !== this.m_preparedRoundToken ||
        this.m_gameClock.GetStartGameTime() !== round.StartTick ||
        request.RoundID !== round.RoundID ||
        request.StartTick !== round.StartTick ||
        request.ChannelIndex !== this.RequireResultServices().ChannelIndex ||
        request.ClaimSequence !== round.HouseSequence + 1 ||
        pending.Occupants.some((u, slot) => this.m_rgPlayer[slot] !== u) ||
        this.WorldCommitFingerprint() !== pending.Fingerprint
      )
        throw new CProtocolError("Pending house claim changed");
      return true;
    } catch {
      round.HouseFailure = "state-changed";
      return false;
    }
  }
  /** Independent161 plan, never reusing money144's resource/156 receipt. Root
   * COMMIT + exact readback + current all-five After precede ANY live install.
   * A lost ACK keeps board/counts/allocator/wallet frozen; retry before clocks.
   * This is not a complete restart journal or universal external-writer fence. */
  private CommitPendingHouseClaim(round: ResultRound): boolean {
    const pending = round.PendingHouse;
    if (!pending || !this.m_bGameTransition) return false;
    round.HouseAttempts = Math.min(
      round.HouseAttempts + 1,
      IntegerRange.UInt32Maximum,
    );
    if (!this.ValidatePendingHouseClaim(round, pending)) return false;
    const request = pending.Submission;
    try {
      const db = this.RequireResultServices().DB,
        status = db.CommitHouseClaim({
          ...request,
          Packet: Buffer.from(pending.PacketHex, "hex"),
        });
      if (status === "conflict") {
        round.HouseFailure = "conflict";
        return false;
      }
      if (
        (status !== "committed" && status !== "duplicate") ||
        !db.ConfirmHouseClaim({
          ...request,
          Packet: Buffer.from(pending.PacketHex, "hex"),
        })
      ) {
        round.HouseFailure = "storage";
        return false;
      }
      const stored = db.GetUserInfo(request.After.ID);
      if (
        db.GetGameResultReceipt(request.RoundID) ||
        !stored ||
        (["Money", "Exp", "Win", "Draw", "Lose"] as const).some(
          (f) => stored[f] !== request.After[f],
        )
      ) {
        round.HouseFailure = "stored-state-changed";
        return false;
      }
    } catch {
      round.HouseFailure = "storage";
      return false;
    }
    if (!this.ValidatePendingHouseClaim(round, pending)) return false;
    const user = pending.Occupants[request.Plan.Slot]!;
    user.IncDecMoney(request.Plan.Delta);
    if (
      JSON.stringify(user.GetDynamicInfoSnapshot()) !==
      JSON.stringify(pending.After)
    ) {
      round.HouseFailure = "state-changed";
      return false;
    }
    const after = request.Plan.After;
    this.m_gameContext.m_aHouseState.set(after.States);
    this.m_gameContext.m_aHouseCount.set(after.Counts);
    this.m_gameContext.m_nNextBoxItem = after.NextBoxItem;
    round.HouseSequence = request.ClaimSequence;
    round.PendingHouse = undefined;
    round.HouseFailure = undefined;
    // All live effects/key/clear precede detached callbacks; no send replay or
    // second award on publication failure. Native sends BEFORE wallet: this
    // intentionally safer durable ordering is explicitly documented.
    this.SendPacket(
      new CSendPacket(
        ServerResponse.TakeHouse,
        undefined,
        this.text,
      ).EncodeBuffer(Buffer.from(pending.PacketHex, "hex").subarray(1)),
    );
    return true;
  }
  /** Native161: actor, house pairs, requested opaque drop triples. Fully decode
   * BEFORE mutation, including bytes native leaves unread on allocator failure. */
  OnReqTakeHouse(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireNativeRunningRound(socket, "house native round", false, true);
    const slot = packet.Decode1(),
      count = packet.Decode1(),
      cells: HouseCell[] = [];
    this.RequireActor(slot, socket);
    for (let i = 0; i < count; i++)
      cells.push([packet.Decode1(), packet.Decode1()]);
    const dropCount = packet.Decode1(),
      drops: HouseDropRequest[] = [];
    for (let i = 0; i < dropCount; i++)
      drops.push([packet.Decode1(), packet.Decode1(), packet.Decode1()]);
    packet.AssertEnd();
    const round = this.RequireResultRound(),
      requestHex = MakeTakeHouseRequest({
        Slot: slot,
        Cells: cells,
        DropRequests: drops,
      })
        .GetBuffer()
        .toString("hex");
    if (round.PendingHouse) {
      if (requestHex !== round.PendingHouse.RequestHex)
        throw new CProtocolError(
          "Only the exact frozen house request may retry",
          "house-retry-mismatch",
        );
      this.WithGameTransition(() => this.CommitPendingHouseClaim(round));
      return;
    }
    this.ValidateResultParticipants();
    if (round.HouseSequence >= IntegerRange.UInt32Maximum)
      throw new CProtocolError(
        "House sequence exhausted; no wrap",
        "house-sequence",
      );
    this.WithGameTransition(() => {
      const fingerprint = this.WorldCommitFingerprint(),
        ctx = this.m_gameContext,
        plan = PlanTakeHouse(
          {
            States: [...ctx.m_aHouseState],
            Counts: [...ctx.m_aHouseCount],
            NextBoxItem: ctx.m_nNextBoxItem,
          },
          slot,
          this.AssertSlot(slot)[2]! & SlotStateMask.Color,
          cells,
          drops,
        ),
        occupants = Object.freeze(this.m_rgPlayer.slice()),
        user = occupants[slot]!,
        before = user.GetDynamicInfoSnapshot(),
        preview = user.CloneForResultCalculation();
      preview.IncDecMoney(plan.Delta);
      const after = preview.GetDynamicInfoSnapshot();
      if (
        fingerprint !== this.WorldCommitFingerprint() ||
        occupants.some((u, i) => this.m_rgPlayer[i] !== u)
      )
        throw new CProtocolError(
          "House source changed during detached calculation",
        );
      round.PendingHouse = Object.freeze({
        Submission: Object.freeze({
          RoundID: round.RoundID,
          ClaimSequence: round.HouseSequence + 1,
          ChannelIndex: this.RequireResultServices().ChannelIndex,
          SessionIndex: this.m_nIdx,
          SessionSerialNo: this.m_ulSerialNo,
          StartTick: round.StartTick,
          GlobalSerialNo: user.GetGlobalSerialNo(),
          Plan: plan,
          Before: before.Dynamic,
          After: after.Dynamic,
        }),
        PacketHex: MakeTakeHousePacket(plan).GetBuffer().toString("hex"),
        RequestHex: requestHex,
        After: after,
        Occupants: occupants,
        Fingerprint: fingerprint,
      });
      round.HouseFailure = undefined;
      this.CommitPendingHouseClaim(round);
    });
  }

  IsSpecialItemUsePending(): boolean {
    return !!this.m_resultRound?.PendingSpecial;
  }
  GetSpecialItemUseState(): SpecialItemUseState {
    const round = this.m_resultRound;
    return {
      Sequence: round?.SpecialSequence ?? 0,
      Pending: !!round?.PendingSpecial,
      Attempts: round?.SpecialAttempts ?? 0,
      Failure: round?.SpecialFailure,
    };
  }
  private InventoryIdentitiesUnchanged(
    pending: PendingSpecialItemUse,
  ): boolean {
    return pending.Inventories.every((saved, slot) => {
      const user = this.m_rgPlayer[slot];
      return !saved
        ? !user
        : !!user &&
            user.m_aInventory === saved.Container &&
            user.m_aInventory.length === saved.Rows.length &&
            saved.Rows.every((row, i) => user.m_aInventory[i] === row);
    });
  }
  private ValidatePendingSpecialItemUse(
    round: ResultRound,
    pending: PendingSpecialItemUse,
  ): boolean {
    try {
      this.RequireOrdinaryResultLifecycle();
      this.ValidateResultParticipants();
      const request = pending.Submission,
        r = request.Request,
        user = this.m_rgPlayer[r.Slot],
        item = this.RequireLaunchServices().Items.GetItemAttr(r.ItemIndex);
      if (
        this.m_resultRound !== round ||
        !this.m_bPlaying ||
        this.m_nGameState !== GameStage.Running ||
        round.Pending ||
        round.PendingMoney ||
        round.PendingHouse ||
        round.Durable ||
        round.Applying ||
        round.Returning ||
        !this.m_nativeLaunchToken ||
        this.m_nativeLaunchToken !== this.m_preparedRoundToken ||
        this.m_gameClock.GetStartGameTime() !== round.StartTick ||
        request.RoundID !== round.RoundID ||
        request.StartTick !== round.StartTick ||
        request.ChannelIndex !== this.RequireResultServices().ChannelIndex ||
        request.SessionIndex !== this.m_nIdx ||
        request.SessionSerialNo !== this.m_ulSerialNo ||
        request.ChannelType !== this.channelType ||
        request.UseSequence !== round.SpecialSequence + 1 ||
        item.Type !== request.ItemType ||
        item !== pending.Resource ||
        this.m_aPlayerState[r.Slot] !== request.PlayerState ||
        !user ||
        user.GetGlobalSerialNo() !== request.GlobalSerialNo ||
        user.m_pClientSocket !== pending.Sender ||
        !pending.Sender.IsConnected() ||
        pending.Occupants.some((u, slot) => this.m_rgPlayer[slot] !== u) ||
        !this.InventoryIdentitiesUnchanged(pending) ||
        this.WorldCommitFingerprint() !== pending.Fingerprint
      )
        throw new CProtocolError("Pending special-item source changed");
      if (this.RequireResultServices().DB.GetGameResultReceipt(round.RoundID)) {
        round.SpecialFailure = "stored-state-changed";
        return false;
      }
    } catch {
      round.SpecialFailure = "state-changed";
      return false;
    }
    return true;
  }
  private CommitPendingSpecialItemUse(round: ResultRound): boolean {
    const pending = round.PendingSpecial;
    if (!pending || !this.m_bGameTransition) return false;
    round.SpecialAttempts = Math.min(
      round.SpecialAttempts + 1,
      IntegerRange.UInt32Maximum,
    );
    if (!this.ValidatePendingSpecialItemUse(round, pending)) return false;
    const request = pending.Submission,
      db = this.RequireResultServices().DB;
    try {
      const status = db.CommitSpecialItemUse({
        ...request,
        Packet: Buffer.from(pending.PacketHex, "hex"),
      });
      if (status === "conflict") {
        round.SpecialFailure = "conflict";
        return false;
      }
      if (status !== "committed" && status !== "duplicate") {
        round.SpecialFailure = "storage";
        return false;
      }
    } catch {
      round.SpecialFailure = "storage";
      return false;
    }
    try {
      if (
        !db.ConfirmSpecialItemUse({
          ...request,
          Packet: Buffer.from(pending.PacketHex, "hex"),
        })
      ) {
        round.SpecialFailure = "storage";
        return false;
      }
      const stored = db.GetInventoryRecord(request.Before.SN),
        expected = { ...request.Before, Amount: request.AfterAmount };
      if (
        !db.GetUserInfo(request.Before.ID) ||
        (request.AfterAmount === 0
          ? stored !== undefined
          : !stored || JSON.stringify(stored) !== JSON.stringify(expected))
      ) {
        round.SpecialFailure = "stored-state-changed";
        return false;
      }
    } catch {
      round.SpecialFailure = "storage";
      return false;
    }
    // Recheck the WHOLE frozen room plus original inventory arrays/row objects
    // after every storage/receipt callback, BEFORE installing even one field.
    if (!this.ValidatePendingSpecialItemUse(round, pending)) return false;
    const r = request.Request,
      user = pending.Occupants[r.Slot]!;
    user.ConsumeUserInventory(request.Before.SN, r.Quantity);
    this.m_aShopItemAttempted[r.Slot] = SpecialItemRule.ShopAttemptValue;
    this.m_dynInfoCalculator.SetNice(r.Slot, SpecialItemRule.NiceValue);
    if (request.RefreshStateTime !== null)
      this.m_gameContext.m_aPlayerStateTime[r.Slot] = request.RefreshStateTime;
    round.SpecialSequence = request.UseSequence;
    round.PendingSpecial = undefined;
    round.SpecialFailure = undefined;
    // No synchronous user callback can observe a partial inventory/flag/Nice/
    // timestamp plan. The existing room transition lock also covers publication.
    this.SendPacket(
      new CSendPacket(
        ServerResponse.BomberEvent,
        undefined,
        this.text,
      ).EncodeBuffer(Buffer.from(pending.PacketHex, "hex").subarray(1)),
      pending.Sender,
    );
    return true;
  }
  /**0041EEBB..0041F024. BYTE opaque/itemIndex/quantity, optional DWORD SN.
   * Modern paid preflight is ATOMIC: unlike the native early dirty/decrement/
   * clamp on invalid resource/underflow, a rejected request consumes NOTHING.
   * Qty0 is a pure native relay (and Type22 state3 timer refresh), NOT proof of
   * pickup ownership. Marker108 positive requests return BEFORE decoding SN. */
  private OnUseSpecialItem(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
    slot: number,
    x: number,
    y: number,
  ): void {
    this.RequireNativeRunningRound(
      socket,
      "special-item native round",
      false,
      false,
      true,
    );
    const opaque = packet.Decode1(),
      itemIndex = packet.Decode1(),
      quantity = packet.Decode1();
    if (
      quantity > 0 &&
      this.channelType === SpecialItemRule.NoShopUseChannelType
    )
      return;
    const request = NormalizeSpecialItemRequest({
      Slot: slot,
      X: x,
      Y: y,
      Opaque: opaque,
      ItemIndex: itemIndex,
      Quantity: quantity,
      ...(quantity > 0 ? { InventorySN: packet.Decode4() } : {}),
    });
    packet.AssertEnd();
    const round = this.RequireResultRound(),
      requestHex = MakeSpecialItemRequest(request).GetBuffer().toString("hex");
    if (round.PendingSpecial) {
      if (
        requestHex !== round.PendingSpecial.RequestHex ||
        socket !== round.PendingSpecial.Sender
      )
        throw new CProtocolError("A different special-item request is pending");
      this.WithGameTransition(() => this.CommitPendingSpecialItemUse(round));
      return;
    }
    if (quantity > 0 && round.SpecialSequence >= IntegerRange.UInt32Maximum)
      throw new CProtocolError("Special-item sequence exhausted");
    const item = this.RequireLaunchServices().Items.GetItemAttr(itemIndex);
    if (!IsSpecialItemType(item.Type))
      throw new CProtocolError("Illegal special-item resource type");
    this.WithGameTransition(() => {
      this.ValidateResultParticipants();
      const fingerprint = this.WorldCommitFingerprint(),
        occupants = Object.freeze(this.m_rgPlayer.slice()),
        user = occupants[slot]!,
        type = item.Type,
        playerState = this.m_aPlayerState[slot]!,
        inventories = Object.freeze(
          occupants.map((u) =>
            u
              ? Object.freeze({
                  Container: u.m_aInventory,
                  Rows: Object.freeze([...u.m_aInventory]),
                })
              : undefined,
          ),
        );
      let before: Readonly<_USERINVENTORY> | undefined;
      if (quantity > 0) {
        const row = user.GetUserInventory(request.InventorySN!);
        if (!row)
          throw new CProtocolError("Nonresident special-item inventory SN");
        before = CopySpecialItemInventory(row, this.text);
        if (
          before.ID !== NormalizeID(user.GetName()) ||
          before.Amount < quantity
        )
          throw new CProtocolError(
            "Special-item inventory owner/amount mismatch",
          );
      }
      const stateTime =
        type === SpecialItemRule.RefreshStateTimeType &&
        playerState === GamePlayerState.PendingDie
          ? this.m_gameClock.ElapsedTime()
          : null;
      if (
        fingerprint !== this.WorldCommitFingerprint() ||
        occupants.some((u, i) => this.m_rgPlayer[i] !== u) ||
        item.Type !== type ||
        this.RequireLaunchServices().Items.GetItemAttr(itemIndex) !== item ||
        inventories.some(
          (saved, i) =>
            saved &&
            (this.m_rgPlayer[i]!.m_aInventory !== saved.Container ||
              saved.Rows.length !== saved.Container.length ||
              saved.Rows.some((row, j) => saved.Container[j] !== row)),
        )
      )
        throw new CProtocolError(
          "Special-item source changed during detached calculation",
        );
      const out = MakeSpecialItemPacket(request);
      if (quantity === 0) {
        if (stateTime !== null)
          this.m_gameContext.m_aPlayerStateTime[slot] = stateTime;
        this.SendPacket(out, socket);
        return;
      }
      round.PendingSpecial = Object.freeze({
        Submission: Object.freeze({
          RoundID: round.RoundID,
          UseSequence: round.SpecialSequence + 1,
          ChannelIndex: this.RequireResultServices().ChannelIndex,
          SessionIndex: this.m_nIdx,
          SessionSerialNo: this.m_ulSerialNo,
          StartTick: round.StartTick,
          ChannelType: this.channelType,
          GlobalSerialNo: user.GetGlobalSerialNo(),
          Request: request,
          ItemType: type,
          PlayerState: playerState,
          RefreshStateTime: stateTime,
          Before: before!,
          AfterAmount: before!.Amount - quantity,
        }),
        PacketHex: out.GetBuffer().toString("hex"),
        RequestHex: requestHex,
        Resource: item,
        Sender: socket,
        Fingerprint: fingerprint,
        Occupants: occupants,
        Inventories: inventories,
      });
      round.SpecialFailure = undefined;
      this.CommitPendingSpecialItemUse(round);
    });
  }

  IsMoneyPickupPending(): boolean {
    return !!this.m_resultRound?.PendingMoney;
  }
  GetMoneyPickupState(): MoneyPickupState {
    const round = this.m_resultRound;
    return {
      Sequence: round?.MoneySequence ?? 0,
      Pending: !!round?.PendingMoney,
      Attempts: round?.MoneyAttempts ?? 0,
      Failure: round?.MoneyFailure,
    };
  }
  /** No current-time read. All ordinary native mutation routes are gated while
   * pending; this additionally detects trusted stale/tampered live state. It is
   * NOT a lock against arbitrary external JS/SQL writers or a restart journal. */
  private WorldCommitFingerprint(): string {
    return JSON.stringify({
      Result: this.ResultFingerprint(),
      Inventories: this.m_rgPlayer.map(
        (u) => u?.GetInventoryStateSnapshot() ?? null,
      ),
      InventoryGenerations: this.m_rgPlayer.map(
        (u) => u?.GetUserInventoryGeneration() ?? null,
      ),
      Context: this.m_gameContext,
      Launch: this.GetGameLaunchState(),
      ChannelIndex: this.RequireResultServices().ChannelIndex,
      SessionIndex: this.m_nIdx,
      SessionSerialNo: this.m_ulSerialNo,
      Modified: this.m_nModified,
      LastUpdate: this.m_dwLastUpdateTime,
      GhostCount: this.m_nGhostCount,
      SlotGhost: [...this.m_anSlotGhost],
      GhostSlot: [...this.m_anGhostSlot],
      SyncObjects: this.m_syncGameObjMan.GetObjectCount(),
    });
  }
  private ValidatePendingMoneyPickup(
    round: ResultRound,
    pending: PendingMoneyPickup,
  ): boolean {
    try {
      this.RequireOrdinaryResultLifecycle();
      this.ValidateResultParticipants();
      const request = pending.Submission,
        item = this.RequireLaunchServices().Items.GetItemAttr(
          request.ItemIndex,
        );
      if (
        this.m_resultRound !== round ||
        !this.m_bPlaying ||
        this.m_nGameState !== GameStage.Running ||
        round.Pending ||
        round.PendingHouse ||
        round.PendingSpecial ||
        round.Durable ||
        round.Applying ||
        round.Returning ||
        !this.m_nativeLaunchToken ||
        this.m_nativeLaunchToken !== this.m_preparedRoundToken ||
        this.m_gameClock.GetStartGameTime() !== round.StartTick ||
        request.RoundID !== round.RoundID ||
        request.StartTick !== round.StartTick ||
        request.ChannelIndex !== this.RequireResultServices().ChannelIndex ||
        request.ClaimSequence !== round.MoneySequence + 1 ||
        item.Type !== GameItemType.Money ||
        item.Parameters[MoneyPickupRule.AmountParameterIndex] !==
          request.AmountParameter ||
        this.m_gameContext.m_aBoxItemState[request.BoxIndex] !==
          GamePickupState.Unclaimed ||
        pending.Occupants.some(
          (user, slot) => this.m_rgPlayer[slot] !== user,
        ) ||
        this.WorldCommitFingerprint() !== pending.Fingerprint
      )
        throw new CProtocolError("Pending money pickup changed");
      return true;
    } catch {
      round.MoneyFailure = "state-changed";
      return false;
    }
  }
  /** Called only under WithGameTransition (and the driver update lock). Frozen
   * randomness/key/Before/After/bytes are reused, NEVER rebased on CAS conflict.
   * SQL/lost-ack uncertainty remains pending without closing the live socket.
   * Best-effort stored-After recheck catches outside edits before replay install;
   * no claim of atomic memory+SQL fencing against arbitrary external writers.
   */
  private CommitPendingMoneyPickup(round: ResultRound): boolean {
    const pending = round.PendingMoney;
    if (!pending || !this.m_bGameTransition) return false;
    round.MoneyAttempts = Math.min(
      round.MoneyAttempts + 1,
      IntegerRange.UInt32Maximum,
    );
    if (!this.ValidatePendingMoneyPickup(round, pending)) return false;
    const request = pending.Submission,
      response = new CSendPacket(
        ServerResponse.EatItem,
        undefined,
        this.text,
      ).EncodeBuffer(Buffer.from(pending.PacketHex, "hex").subarray(1));
    try {
      const db = this.RequireResultServices().DB,
        status = db.CommitMoneyPickup({
          ...request,
          Packet: Buffer.from(pending.PacketHex, "hex"),
        });
      if (status === "conflict") {
        round.MoneyFailure = "conflict";
        return false;
      }
      if (
        (status !== "committed" && status !== "duplicate") ||
        !db.ConfirmMoneyPickup({
          ...request,
          Packet: Buffer.from(pending.PacketHex, "hex"),
        })
      ) {
        round.MoneyFailure = "storage";
        return false;
      }
      const stored = db.GetUserInfo(request.After.ID);
      if (
        db.GetGameResultReceipt(request.RoundID) ||
        !stored ||
        (["Money", "Exp", "Win", "Draw", "Lose"] as const).some(
          (field) => stored[field] !== request.After[field],
        )
      ) {
        round.MoneyFailure = "stored-state-changed";
        return false;
      }
    } catch {
      round.MoneyFailure = "storage";
      return false;
    }
    if (!this.ValidatePendingMoneyPickup(round, pending)) return false;
    const user = pending.Occupants[request.Slot]!;
    user.IncDecMoney(request.Delta); // proven native synchronous signed32 kernel
    if (
      JSON.stringify(user.GetDynamicInfoSnapshot()) !==
      JSON.stringify(pending.After)
    ) {
      round.MoneyFailure = "state-changed";
      return false; // do not install stale claims or attempt another delta
    }
    this.m_gameContext.m_aBoxItemState[request.BoxIndex] =
      GamePickupState.Claimed;
    round.MoneySequence = request.ClaimSequence;
    round.PendingMoney = undefined;
    round.MoneyFailure = undefined;
    // Completed memory/key/claim precede ALL detached transport callbacks. A
    // send failure cannot re-credit, consume another ordinal or replay156.
    this.SendPacket(response);
    return true;
  }

  /** 0041EA50's money arithmetic/wire kernel ONLY. Native149 is unrelated.
   * A trusted caller may inspect it, but the preview alone is NOT a completed
   * pickup. The native-network path uses the durable coordinator below. */
  MakeMoneyPickupPreview(
    slot: number,
    boxIndex: number,
    itemIndex: number,
    random?: () => number,
  ): MoneyPickupPreview {
    this.AssertSlot(slot);
    this.AssertPickupBoxIndex(boxIndex);
    const item = this.RequireLaunchServices().Items.GetItemAttr(itemIndex),
      user = this.m_rgPlayer[slot];
    if (!user || item.Type !== GameItemType.Money)
      throw new CProtocolError(
        "Money preview requires an occupied slot and money item",
      );
    const before = user.GetDynamicInfoSnapshot(),
      clone = user.CloneForResultCalculation(),
      multiplier =
        user.GetAuthencode() === MoneyPickupRule.BonusAuthencode
          ? (this.DrawNativeRandom(random) % MoneyPickupRule.MultiplierModulo) +
            MoneyPickupRule.MinimumMultiplier
          : MoneyPickupRule.MinimumMultiplier,
      delta = Math.imul(
        multiplier,
        item.Parameters[MoneyPickupRule.AmountParameterIndex]!,
      );
    clone.IncDecMoney(delta);
    return Object.freeze({
      Multiplier: multiplier,
      Delta: delta,
      DiagnosticAmountExceeded:
        delta > MoneyPickupRule.DiagnosticAmountThreshold,
      Before: before,
      After: clone.GetDynamicInfoSnapshot(),
      Packet: new CSendPacket(ServerResponse.EatItem, undefined, this.text)
        .Encode1(slot)
        .Encode1(boxIndex)
        .Encode1(itemIndex)
        .Encode1(multiplier),
    });
  }
  private AssertPickupBoxIndex(index: number): void {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= GameContextLimit.BoxItems
    )
      throw new CProtocolError("Pickup box index out of bounds");
  }
  /** 0041EA50: room actor, box index, actual resource item index. Only a zero
   * claim flag may publish156. Nonmoney does not change native player attrs.
   * Native trusts the supplied item identity; no spawn/position proof is added. */
  OnRequestEatItem(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireNativeRunningRound(socket, "item pickup native round", true);
    const slot = packet.Decode1(),
      boxIndex = packet.Decode1(),
      itemIndex = packet.Decode1();
    packet.AssertEnd();
    this.RequireActor(slot, socket);
    this.AssertPickupBoxIndex(boxIndex);
    const item = this.RequireLaunchServices().Items.GetItemAttr(itemIndex);
    const round = this.RequireResultRound();
    if (round.PendingMoney) {
      const frozen = round.PendingMoney.Submission;
      if (
        slot !== frozen.Slot ||
        boxIndex !== frozen.BoxIndex ||
        itemIndex !== frozen.ItemIndex ||
        item.Type !== GameItemType.Money
      )
        throw new CProtocolError(
          "Only the exact frozen money request may retry",
          "money-retry-mismatch",
        );
      this.WithGameTransition(() => this.CommitPendingMoneyPickup(round));
      return;
    }
    if (
      this.m_gameContext.m_aBoxItemState[boxIndex] !== GamePickupState.Unclaimed
    )
      return;
    if (item.Type === GameItemType.Money) {
      // All participants must remain usable: settlement cannot later silently
      // omit an orphan whose wallet was credited in this native generation.
      this.ValidateResultParticipants();
      if (round.MoneySequence >= IntegerRange.UInt32Maximum)
        throw new CProtocolError(
          "Money pickup sequence exhausted; no wrap",
          "money-sequence",
        );
      this.WithGameTransition(() => {
        const fingerprint = this.WorldCommitFingerprint(),
          occupants = Object.freeze(this.m_rgPlayer.slice()),
          preview = this.MakeMoneyPickupPreview(slot, boxIndex, itemIndex);
        if (
          fingerprint !== this.WorldCommitFingerprint() ||
          occupants.some((user, i) => this.m_rgPlayer[i] !== user)
        )
          throw new CProtocolError(
            "Money source changed during random calculation",
          );
        round.PendingMoney = Object.freeze({
          Submission: Object.freeze({
            RoundID: round.RoundID,
            ClaimSequence: round.MoneySequence + 1,
            ChannelIndex: this.RequireResultServices().ChannelIndex,
            SessionIndex: this.m_nIdx,
            SessionSerialNo: this.m_ulSerialNo,
            StartTick: round.StartTick,
            Slot: slot,
            GlobalSerialNo: occupants[slot]!.GetGlobalSerialNo(),
            BoxIndex: boxIndex,
            ItemIndex: itemIndex,
            Authencode: occupants[slot]!.GetAuthencode(),
            AmountParameter:
              item.Parameters[MoneyPickupRule.AmountParameterIndex]!,
            Multiplier: preview.Multiplier,
            Delta: preview.Delta,
            DiagnosticAmountExceeded: preview.DiagnosticAmountExceeded,
            Before: preview.Before.Dynamic,
            After: preview.After.Dynamic,
          }),
          PacketHex: preview.Packet.GetBuffer().toString("hex"),
          After: preview.After,
          Fingerprint: fingerprint,
          Occupants: occupants,
        });
        round.MoneyFailure = undefined;
        this.CommitPendingMoneyPickup(round);
      });
      return;
    }
    const response = new CSendPacket(
      ServerResponse.EatItem,
      undefined,
      this.text,
    )
      .Encode1(slot)
      .Encode1(boxIndex)
      .Encode1(itemIndex);
    this.WithGameTransition(() => {
      this.m_gameContext.m_aBoxItemState[boxIndex] = GamePickupState.Claimed;
      this.SendPacket(response);
    });
  }
  /** 0041ECA3 bounds the FLAT index, not the separate nibble coordinates.
   * Column15 aliases next-row column0 for rows0..11; echo the ORIGINAL byte. */
  OnRequestEatObstacle(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): void {
    this.RequireNativeRunningRound(socket, "obstacle pickup native round");
    const slot = packet.Decode1(),
      packedPosition = packet.Decode1();
    packet.AssertEnd();
    this.RequireActor(slot, socket);
    const index =
      (packedPosition & GamePosition.ColumnMask) +
      GameContextLimit.Columns * (packedPosition >>> GamePosition.RowShift);
    if (index >= this.m_gameContext.m_aObstacleState.length)
      throw new CProtocolError("Pickup obstacle index out of bounds");
    if (
      this.m_gameContext.m_aObstacleState[index] !== GamePickupState.Unclaimed
    )
      return;
    const response = new CSendPacket(
      ServerResponse.EatObstacle,
      undefined,
      this.text,
    )
      .Encode1(slot)
      .Encode1(packedPosition);
    this.WithGameTransition(() => {
      this.m_gameContext.m_aObstacleState[index] = GamePickupState.Claimed;
      this.SendPacket(response);
    });
  }
  /** 0041F28B: SOCKET-LOCAL self index (not a room slot), then log-only label.
   * Invalid self returns before DecodeStr in native. Valid labels do NOT grant
   * rewards. aS_3 at0048F010 is "%s" +88 raw CP949 announcement bytes, NOT
   * just "%s" or the supplied label. Preserve that suffix without transcoding.
   * No native event-log file, lottery, inventory or prize path is fabricated. */
  OnEventItem(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireNativeRunningRound(socket, "event item native round");
    const self = packet.Decode1();
    if (self >= socket.GetUserCount()) return;
    packet.DecodeStr(RuntimePolicy.MaxEventItemNameBytes);
    packet.AssertEnd();
    const message = Buffer.concat([
      this.text.Encode(socket.GetUser(self)!.GetName()),
      Buffer.from(EventItemAnnouncement.SuffixHex, "hex"),
    ]);
    const response = new CSendPacket(
      ServerResponse.EventItem,
      undefined,
      this.text,
    ).EncodeStr(message);
    this.WithGameTransition(() => this.SendPacket(response));
  }
  /** 0041E8E7 kernel, TRUSTED CALL ONLY: no ordinary request maps here.
   * In particular153 is default in native421661/4215C5. Keep its high nibble
   * and four remaining fields opaque, reset only the indexed claim flag.
   * Modern bounds/full-body/group/phase checks precede the detached publish. */
  OnItemThrow(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireNativeRunningRound(socket, "item throw native round");
    const fields = Array.from({ length: ItemThrowRule.FieldCount }, () =>
      packet.Decode1(),
    );
    packet.AssertEnd();
    this.RequireActor(
      fields[ItemThrowRule.ActorFlagsByte]! & ItemThrowRule.ActorMask,
      socket,
    );
    const boxIndex = fields[ItemThrowRule.BoxIndexByte]!;
    this.AssertPickupBoxIndex(boxIndex);
    const response = new CSendPacket(
      ServerResponse.ItemThrow,
      undefined,
      this.text,
    );
    for (const field of fields) response.Encode1(field);
    this.WithGameTransition(() => {
      this.m_gameContext.m_aBoxItemState[boxIndex] = GamePickupState.Unclaimed;
      this.SendPacket(response);
    });
  }

  private RequireRunning(
    socket: CClientSocket,
    allowMoneyRetry = false,
    allowHouseRetry = false,
    allowSpecialRetry = false,
  ): void {
    if (this.m_bUpdating || this.m_bRemovingPlayer || this.m_bGameTransition)
      throw new CProtocolError("Battle event during a round update/removal");
    if (
      this.m_resultRound?.Pending ||
      (!allowMoneyRetry && this.IsMoneyPickupPending()) ||
      (!allowHouseRetry && this.IsHouseClaimPending()) ||
      (!allowSpecialRetry && this.IsSpecialItemUsePending())
    )
      throw new CProtocolError(
        "Round money/house/inventory/result is frozen pending durability/publication",
      );
    if (!this.m_bPlaying || this.m_nGameState !== GameStage.Running)
      throw new CProtocolError("Battle event outside a running game");
    if (
      !socket.m_aUser.length ||
      socket.m_aUser.some(
        (user) => user.IsSetFree() !== 0 || this.FindPlayerSlot(user) < 0,
      )
    )
      throw new CProtocolError("Battle sender is not in this room");
    this.SocketSlots(socket);
  }
  private RequireActor(slot: number, socket: CClientSocket): void {
    if (
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= SessionLimit.Players ||
      this.m_rgPlayer[slot]?.m_pClientSocket !== socket
    )
      throw new CProtocolError("Battle slot does not belong to sender");
  }
  /** Modern phase/scope boundary: native gameplay requests must come from a
   * committed start, not zero-initialized fields in hand-made Running fixtures.
   * Native handlers do NOT impose the same phase/special-mode gate. */
  private RequireNativeRunningRound(
    socket: CClientSocket,
    feature: string,
    allowMoneyRetry = false,
    allowHouseRetry = false,
    allowSpecialRetry = false,
  ): void {
    this.RequireRunning(
      socket,
      allowMoneyRetry,
      allowHouseRetry,
      allowSpecialRetry,
    );
    if (!socket.IsConnected())
      throw new CProtocolError("Native gameplay sender socket is closed");
    this.RequireOrdinaryResultLifecycle();
    if (
      !this.m_nativeLaunchToken ||
      this.m_nativeLaunchToken !== this.m_preparedRoundToken ||
      !this.m_resultRound
    )
      throw new CUnsupportedOperation(
        feature,
        "complete ordinary native launch/start generation required",
      );
  }
  private RequireNativeGhostRound(socket: CClientSocket): void {
    this.RequireNativeRunningRound(socket, "ghost native round");
    if (
      !Number.isInteger(this.m_nGhostCount) ||
      this.m_nGhostCount < IntegerRange.Int32Minimum ||
      this.m_nGhostCount > IntegerRange.Int32Maximum
    )
      throw new CProtocolError("Invalid native signed ghost count");
  }
  /** 0041F3F1: BYTE opaque parameter, BYTE ROOM slot. Global unsigned frequency
   * uses absolute WinMM tick; minimum start uses ElapsedTime, not active time.
   * Zero last timestamp bypasses frequency; zero frequency is NOT disabled.
   * No state/dead-player/RebirthMap predicate exists in this supplied handler. */
  OnRequestGenerateGhost(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): void {
    this.RequireNativeGhostRound(socket);
    const parameter = packet.Decode1(),
      slot = packet.Decode1();
    packet.AssertEnd();
    this.RequireActor(slot, socket);
    const now = this.m_gameClock.GetCurrentTime();
    if (
      (this.m_dwLastGhostTime !== 0 &&
        (now - this.m_dwLastGhostTime) >>> 0 < this.m_dwGhostFrequency) ||
      this.m_gameClock.ElapsedTime() < this.m_dwGhostStart ||
      this.m_nGhostCount >= GameGhostRule.Capacity
    )
      return;
    const { byPlayer, byGhost } = this.GetValidatedGhostAssignments();
    if (byPlayer[slot] !== GameGhostAssignment.NoGhost) return; // native duplicate logs (or silent with freq0), no mutation
    const ghost = byGhost.indexOf(SessionLimit.NoSlot);
    if (ghost < 0) return;
    const out = new CSendPacket(
      ServerResponse.GenerateGhost,
      undefined,
      this.text,
    )
      .Encode1(ghost)
      .Encode1(slot | GameGhostRule.GeneratedOwnerFlag)
      .Encode1(parameter);
    this.WithGameTransition(() => {
      this.m_dwLastGhostTime = now;
      this.m_anGhostSlot[ghost] = slot;
      this.m_anSlotGhost[slot] = ghost;
      this.m_nGhostCount = (this.m_nGhostCount + 1) | 0;
      this.SendPacket(out);
    });
  }
  /** 0041B3FF: ONE ghost ID, NOT a player slot. Any valid room socket may
   * destroy another player's ghost: native has no ghost-owner/sender check.
   * Valid missing IDs are no-ops; reciprocal mapping is cleared and signed
   * count decremented only on an actual destroy. Last-generation tick stays. */
  OnRequestDestroyGhost(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): void {
    this.RequireNativeGhostRound(socket);
    const ghost = packet.Decode1();
    packet.AssertEnd();
    if (ghost >= GameGhostRule.Capacity)
      throw new CProtocolError("Invalid ghost index");
    const { byGhost } = this.GetValidatedGhostAssignments(),
      owner = byGhost[ghost]!;
    if (owner === SessionLimit.NoSlot) return;
    const out = new CSendPacket(
      ServerResponse.DestroyGhost,
      undefined,
      this.text,
    ).Encode1(ghost);
    this.WithGameTransition(() => {
      this.m_anGhostSlot[ghost] = SessionLimit.NoSlot;
      this.m_anSlotGhost[owner] = GameGhostAssignment.NoGhost;
      this.m_nGhostCount = (this.m_nGhostCount - 1) | 0;
      this.SendPacket(out);
    });
  }
  /** 0041D7C0. Native checks ABSOLUTE unsigned(lastScheduled+7000)<=now
   * BEFORE decoding body. Echo171: scheduled(now+2000),count,4-byte records.
   * Only each record's SECOND byte is established: context box-item index.
   * No chief/RNG/sync allocation/map-time/probability/item-choice predicate.
   * Native count0 diagnoses but still publishes/advances marker; preserve it.
   * Native >3 merely diagnoses then may overrun a ten-DWORD stack array; our
   * explicit modern cap rejects >3 before any world/marker/publication change. */
  OnRequestAirplane(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireNativeRunningRound(socket, "airplane native round");
    const now = this.m_gameClock.GetCurrentTime();
    if (
      now <
      (this.m_dwLastAirplaneRequestTime +
        AirplaneRequestRule.RequestGapMilliseconds) >>>
        0
    )
      return;
    const count = packet.Decode1();
    if (count > AirplaneRequestRule.ReportedCountMaximum)
      throw new CProtocolError(
        "Airplane count exceeds native reported maximum",
      );
    const entries = Array.from({ length: count }, () =>
      Array.from({ length: AirplaneRequestRule.EntryBytes }, () =>
        packet.Decode1(),
      ),
    );
    packet.AssertEnd();
    for (const fields of entries)
      if (
        fields[AirplaneRequestRule.BoxIndexByte]! >= GameContextLimit.BoxItems
      )
        throw new CProtocolError("Invalid airplane box-item index");
    const scheduled =
      (now + AirplaneRequestRule.ScheduledTickLeadMilliseconds) >>> 0;
    const out = new CSendPacket(ServerResponse.Airplane, undefined, this.text)
      .Encode4(scheduled)
      .Encode1(count);
    for (const fields of entries)
      for (const value of fields) out.Encode1(value);
    this.WithGameTransition(() => {
      for (const fields of entries)
        this.m_gameContext.m_aBoxItemState[
          fields[AirplaneRequestRule.BoxIndexByte]!
        ] = GamePickupState.Unclaimed;
      this.m_dwLastAirplaneRequestTime = scheduled;
      this.SendPacket(out);
    });
  }
  /** 0041E5AC. Sender index is a room slot, NOT the local 0/1 index. */
  OnBombIgnite(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket);
    const slot = packet.Decode1();
    const position = packet.Decode1();
    const attributes = packet.Decode1();
    packet.AssertEnd();
    this.RequireActor(slot, socket);
    const bomb = this.m_gameContext.AddBomb(position, attributes);
    this.SendPacket(
      new CSendPacket(ServerResponse.BombIgnite, undefined, this.text)
        .Encode1(slot)
        .Encode1(position)
        .Encode1(attributes)
        .Encode2(bomb.SerialNo),
    );
  }
  /** 0041E74E; low nibble of first byte is room slot, high nibble is forwarded. */
  OnBombKickThrow(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket);
    const action = packet.Decode1();
    const serial = packet.Decode2();
    const previous = packet.Decode1();
    const destination = packet.Decode1();
    const time = packet.Decode2();
    packet.AssertEnd();
    this.RequireActor(action & BombRule.ActorSlotMask, socket);
    if (this.m_gameContext.KickBomb(serial, previous, destination, time))
      this.SendPacket(
        new CSendPacket(ServerResponse.BombKickThrow, undefined, this.text)
          .Encode1(action)
          .Encode2(serial)
          .Encode1(destination),
      );
  }
  /** 0041B1B4. Any valid session peer may shorten a matching stationary fuse. */
  OnSetBombTimer(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket);
    const serial = packet.Decode2();
    const position = packet.Decode1();
    const time = packet.Decode2();
    packet.AssertEnd();
    this.m_gameContext.SetBombTimer(serial, position, time);
  }
  OnMovableBoxMove(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket);
    const fields = Array.from({ length: 4 }, () => packet.Decode1());
    packet.AssertEnd();
    const out = new CSendPacket(
      ServerResponse.MovableBoxMove,
      undefined,
      this.text,
    );
    for (const value of fields) out.Encode1(value);
    this.SendPacket(out);
  }
  OnDropObstacle(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket);
    const field = packet.Decode1();
    const position = packet.Decode1();
    packet.AssertEnd();
    this.m_gameContext.SetObstacleState(
      position >>> GamePosition.RowShift,
      position & GamePosition.ColumnMask,
      GamePickupState.Unclaimed,
    );
    this.SendPacket(
      new CSendPacket(ServerResponse.DropObstacle, undefined, this.text)
        .Encode1(field)
        .Encode1(position),
      socket,
    );
  }
  OnDestroyBox(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket);
    const fields = Array.from({ length: 3 }, () => packet.Decode1());
    packet.AssertEnd();
    const out = new CSendPacket(
      ServerResponse.DestroyBox,
      undefined,
      this.text,
    );
    for (const value of fields) out.Encode1(value);
    this.SendPacket(out);
  }
  OnSetEffect(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireRunning(socket);
    const data = packet.DecodeBuffer(packet.remaining);
    this.SendPacket(
      new CSendPacket(ServerResponse.Effect, undefined, this.text).EncodeBuffer(
        data,
      ),
      socket,
    );
  }
  /** Bomb-only extracted block of Update 0041DC31, NOT the whole game loop.
   * Retained as a kernel-test API. The timed driver calls the same packet maker
   * but queues death updates before publishing. It is NOT another live clock. */
  UpdateBombTimers(elapsedMilliseconds: number): void {
    if (
      this.m_bGameTransition ||
      this.m_bUpdating ||
      this.m_bRemovingPlayer ||
      this.m_resultRound?.Pending ||
      this.IsGameplayCommitPending() ||
      !this.m_bPlaying ||
      this.m_nGameState !== GameStage.Running
    )
      return;
    const out = this.MakeBombTimerUpdatePacket(elapsedMilliseconds);
    if (out) this.SendPacket(out);
  }
  private MakeBombTimerUpdatePacket(
    elapsedMilliseconds: number,
  ): CSendPacket | undefined {
    const events = this.m_gameContext.AdvanceBombTimers(elapsedMilliseconds);
    if (!events.length) return;
    const out = new CSendPacket(
      ServerResponse.BombTimer,
      undefined,
      this.text,
    ).Encode1(events.length);
    for (const event of events)
      out.Encode2(event.SerialNo).Encode1(event.Landed ? 1 : 0);
    return out;
  }
  GetColorForNewComer(slot: number): number {
    const counts = Array<number>(TeamLimit.Colors).fill(0);
    for (let i = 0; i < SessionLimit.Players; i++)
      if (this.m_rgPlayer[i])
        counts[this.m_rgSlotInfo[i]![2]! & SlotStateMask.Color]!++;
    const teams = counts.filter(Boolean).length;
    const fallback = slot % TeamLimit.Colors;
    if (teams > 1) {
      let best = -1;
      for (let i = 0; i < TeamLimit.Colors; i++)
        if (counts[i]! > 0 && (best < 0 || counts[i]! < counts[best]!))
          best = i;
      return best;
    }
    if (teams === 1) {
      const mapTeams = this.maps.GetSelectionMaxTeam(this.m_nMapIdx);
      if (
        mapTeams >= TeamLimit.LimitedMinimum &&
        mapTeams <= TeamLimit.LimitedMaximum
      )
        return counts[LimitedTeamColors[0]]! > 0
          ? LimitedTeamColors[1]
          : LimitedTeamColors[0];
      if (counts[fallback]! > 0) return fallback === 0 ? 1 : 0;
    }
    return fallback;
  }
  AddAllUser(socket: CClientSocket, bombers: readonly number[]): void {
    this.#AssertOwnedBanPlayerState();
    // Same gate as CGameSessionTable::DoJoinSession, also for direct callers.
    if (
      this.m_bPlaying ||
      this.m_resultRound ||
      this.m_ulBanTargetSerialNo ||
      this.m_bRemovingPlayer ||
      this.m_bGameTransition ||
      this.m_bUpdating
    )
      throw new CProtocolError("Cannot join an active round/removal/update");
    if (this.GetEmptySlotCount() < socket.GetUserCount())
      throw new CProtocolError("Room full");
    for (const [self, user] of socket.m_aUser.entries()) {
      const slot = this.m_rgPlayer.findIndex(
        (p, i) => !p && !(this.m_rgSlotInfo[i]![0]! & SlotStateMask.Closed),
      );
      const bomber = bombers[self] ?? this.bombers.GetRandomBomberIdx();
      this.AddUser(
        user,
        slot,
        this.bombers.IsValidSelectIdx(bomber)
          ? bomber
          : this.bombers.GetRandomBomberIdx(),
        self
          ? this.m_rgSlotInfo[socket.m_aUser[0]!.m_nSlotIdx]![2]! &
              SlotStateMask.Color
          : this.GetColorForNewComer(slot),
      );
    }
    socket.m_nPoolType = "Session";
    if (this.m_nChiefSlotidx < 0)
      this.SetChiefSlotidx(
        socket.m_aUser.reduce((best, user) =>
          user.GetLevel() > best.GetLevel() ? user : best,
        ).m_nSlotIdx,
      );
    this.m_nModified |= SessionModified.PlayerCount;
  }
  SendSessionInfoPacket(socket: CClientSocket): void {
    this.MakeSessionInfoPacket(socket);
    socket.SendPacket(
      new CSendPacket(ServerResponse.SelectMap, undefined, this.text).Encode2(
        this.m_nMapIdx & 0xffff,
      ),
    );
    this.m_pStrategy.SendSessionInfo();
    // The ordinary strategy is a no-op: the original queues the same 112 packet twice.
    socket.SendPacket(
      new CSendPacket(ServerResponse.SelectMap, undefined, this.text).Encode2(
        this.m_nMapIdx & 0xffff,
      ),
    );
  }
  /**0041B509/0041B567: mode+948 and one opcode only. Normal/Mod waiting
   * includes issued vote; Mod native battle remains unavailable and cannot be
   * authorized by a waiting-mode generation or its serialized inspection. */
  #SetGameType(type: number, socket?: CClientSocket): void {
    if (
      this.m_bGameTransition ||
      this.m_bUpdating ||
      this.m_bRemovingPlayer ||
      this.IsGameplayCommitPending()
    )
      throw new CProtocolError(
        "Game type during room transition/update/removal",
      );
    this.#AssertOwnedBanPlayerState();
    if (this.m_ulBanTargetSerialNo) {
      if (
        type === GameType.Mod &&
        (this.m_bPlaying || this.m_nativeLaunchToken || this.m_resultRound)
      )
        throw new CUnsupportedOperation(
          "Mod switch during native vote round",
          "Mod combat/captain cascade and result remain unavailable",
        );
      this.#RequireLiveBanPlayerScope();
    }
    if (this.#gameTypeRevision >= IntegerRange.UInt32Maximum)
      throw new CProtocolError("Waiting game-type revision exhausted");
    const plan = PlanGameTypeTransition(
        {
          GameType: this.m_nGameType,
          Playing: this.m_bPlaying,
          Manner: this.m_nManner,
          TargetSerialNo: this.m_ulBanTargetSerialNo,
          Votes: Array.from(this.m_anBanPlayerVote),
        },
        type,
      ),
      packet = new CSendPacket(plan.Opcode, undefined, this.text),
      targets = socket ? [socket] : this.GetSockets();
    this.WithGameTransition(() => {
      this.m_nGameType = plan.GameType;
      this.#waitingGameType = plan.GameType;
      this.#gameTypeRevision++;
      this.QueuePacketTo(packet, targets);
    });
  }
  SendGameTypeNormal(socket?: CClientSocket): void {
    this.#SetGameType(GameType.Normal, socket);
  }
  SendGameTypeMod(socket?: CClientSocket): void {
    this.#SetGameType(GameType.Mod, socket);
  }
  SendGameType(socket: CClientSocket): void {
    if (this.m_nGameType !== GameType.Normal) this.SendGameTypeMod(socket);
    else this.SendGameTypeNormal(socket);
  }
  /** 0041C47D: palette restriction preserves teams when possible. If too many
   * teams are selected, distribute occupied slots round-robin instead. The
   * original temporary 0x11111111 marker means 'seen but not remapped'; it is
   * replaced with a Set here, not transmitted or mistaken for a game constant. */
  private NormalizeTeamColors(maxTeam: number): void {
    const occupied = this.m_rgPlayer.flatMap((user, slot) =>
      user ? [slot] : [],
    );
    const colors = new Set(
      occupied.map(
        (slot) => this.m_rgSlotInfo[slot]![2]! & SlotStateMask.Color,
      ),
    );
    const mapping = new Map<number, number>();
    if (
      maxTeam >= TeamLimit.LimitedMinimum &&
      maxTeam <= TeamLimit.LimitedMaximum
    ) {
      const palette = LimitedTeamColors.slice(0, maxTeam);
      const used = new Set(palette.filter((color) => colors.has(color)));
      for (const color of used) mapping.set(color, color);
      for (const color of [...colors].sort((a, b) => a - b))
        if (!mapping.has(color)) {
          const next = palette.find((value) => !used.has(value));
          if (next !== undefined) {
            mapping.set(color, next);
            used.add(next);
          }
        }
      for (const [i, slot] of occupied.entries()) {
        const info = this.m_rgSlotInfo[slot]!;
        const previous = info[2]! & SlotStateMask.Color;
        const color =
          colors.size > maxTeam
            ? palette[i % maxTeam]!
            : mapping.get(previous)!;
        info[2] = (info[2]! & ~SlotStateMask.Color) | color;
        this.SendPacket(this.MakeSetSlotStatePacket(slot));
      }
    } else if (maxTeam === TeamLimit.Colors) {
      // Even unchanged slot states are sent after the map packet in the original.
      for (const slot of occupied)
        this.SendPacket(this.MakeSetSlotStatePacket(slot));
    } else
      throw new CUnsupportedOperation(
        "map team limit",
        "only the original 2/3/4/8-team selection rules are audited",
      );
  }
  private OwnSlot(socket: CClientSocket, self: number): number {
    const user = socket.GetUser(self);
    if (!user || this.FindPlayerSlot(user) < 0)
      throw new CProtocolError("Invalid self player");
    return this.FindPlayerSlot(user);
  }
  CanStartGame(
    allowUnselected = true,
    selectedMap = this.m_nMapIdx >= 0 ? this.m_nMapIdx : this.m_nMapIdxPlaying,
  ): number {
    const chief = this.m_rgPlayer[this.m_nChiefSlotidx];
    if (!chief) throw new CProtocolError("Missing chief");
    const users = this.m_rgPlayer.filter((u) => u !== undefined);
    if (
      users.some(
        (u) =>
          u.m_pClientSocket !== chief.m_pClientSocket &&
          (this.m_rgSlotInfo[u.m_nSlotIdx]![0]! & SlotStateMask.Status) !==
            SlotStateMask.Ready,
      )
    )
      return StartGameResult.NotReady;
    if (users.length < 2) return StartGameResult.NotEnoughPlayers;
    const teams = new Set(
      users.map(
        (u) => this.m_rgSlotInfo[u.m_nSlotIdx]![2]! & SlotStateMask.Color,
      ),
    );
    if (teams.size < 2) return StartGameResult.NotEnoughTeams;
    if (this.IsManner()) {
      const counts = [...teams].map(
        (t) =>
          users.filter(
            (u) =>
              (this.m_rgSlotInfo[u.m_nSlotIdx]![2]! & SlotStateMask.Color) ===
              t,
          ).length,
      );
      if (counts.some((n) => n !== users.length / teams.size))
        return StartGameResult.UnbalancedTeams;
    }
    if (selectedMap >= 0) {
      const map = this.maps.GetMapTmpl(selectedMap);
      if (users.length > map.m_nMaxPlayer) return StartGameResult.MapCapacity;
      if (
        this.channelType !== ChannelType.Premium &&
        chief.GetAuthencode() !== 1 &&
        map.m_nPremiumOnly === 1
      )
        return StartGameResult.PremiumMap;
      if (chief.GetLevel() < map.m_nLevelLimit)
        return StartGameResult.LevelLimit;
    }
    if (selectedMap < 0 && !allowUnselected) return StartGameResult.LevelLimit;
    return StartGameResult.Valid;
  }
  OnPacket(packet: CReceivedPacketBase, socket: CClientSocket): void {
    if (this.m_bRemovingPlayer || this.m_bGameTransition || this.m_bUpdating)
      throw new CProtocolError(
        "Room packet during a round update / during player removal or transition",
      );
    this.SocketSlots(socket); // native CheckValidSocket, strengthened whole-group validation
    if (
      (this.IsMoneyPickupPending() &&
        packet.m_nPacketType !== ClientRequest.RequestEatItem) ||
      (this.IsHouseClaimPending() &&
        packet.m_nPacketType !== ClientRequest.ReqTakeHouse)
    )
      throw new CProtocolError(
        "Room is frozen pending durable gameplay commit",
      );
    switch (packet.Decode1()) {
      case ClientRequest.HostAskBanPlayer:
        this.OnHostAskBanPlayer(packet, socket);
        return;
      case ClientRequest.RespondToBanPlayer:
        this.OnRespondToBanPlayer(packet, socket);
        return;
      case ClientRequest.SetPlayerReady: {
        const ready = packet.Decode1();
        packet.AssertEnd();
        if (ready > 1) throw new CProtocolError("Invalid ready state");
        if (this.IsChief(socket)) return;
        const slots = socket.m_aUser.map((_, self) =>
          this.OwnSlot(socket, self),
        );
        const expected = ready ? SlotStateMask.NotReady : SlotStateMask.Ready;
        // 0041E2FE logs desync and returns WITHOUT disconnect or a fake snapshot.
        // Its vtable +20 is DumpLog (0048F620), not SendSessionInfoPacket.
        // Validate the complete local-player group before modifying either slot.
        if (
          slots.some(
            (slot) =>
              (this.m_rgSlotInfo[slot]![0]! & SlotStateMask.Status) !==
              expected,
          )
        )
          return;
        for (const slot of slots) {
          const info = this.m_rgSlotInfo[slot]!;
          info[0] =
            (info[0]! & ~SlotStateMask.Status) |
            (ready ? SlotStateMask.Ready : SlotStateMask.NotReady);
          this.SendPacket(this.MakeSetSlotStatePacket(slot));
        }
        return;
      }
      case ClientRequest.SelectBomber:
      case ClientRequest.SelectColor: {
        const kind = packet.m_nPacketType;
        // CListSession::OnSelectBomber00423B7A ignores the WHOLE request while playing.
        if (kind === ClientRequest.SelectBomber && this.m_bPlaying) return;
        const value = packet.Decode1();
        packet.AssertEnd();
        const slot = this.OwnSlot(socket, value >>> 4);
        const selection = value & 15;
        if (kind === ClientRequest.SelectBomber) {
          if (!this.bombers.IsValidSelectIdx(selection))
            throw new CProtocolError("Invalid bomber");
          this.m_rgSlotInfo[slot]![1] =
            (this.m_rgSlotInfo[slot]![1]! & ~SlotStateMask.Bomber) | selection;
        } else {
          if (selection >= TeamLimit.Colors)
            throw new CProtocolError("Invalid color");
          // Native DoSelectColor00423B69 ignores mutation while playing, but
          // CBaseSession still broadcasts108 with the REQUESTED color.
          if (!this.m_bPlaying)
            this.m_rgSlotInfo[slot]![2] =
              (this.m_rgSlotInfo[slot]![2]! & ~SlotStateMask.Color) | selection;
        }
        this.SendPacket(
          new CSendPacket(
            kind === ClientRequest.SelectBomber
              ? ServerResponse.SelectBomber
              : ServerResponse.SelectColor,
            undefined,
            this.text,
          ).Encode1((slot << 4) | selection),
        );
        return;
      }
      case ClientRequest.OpenCloseSlot: {
        if (this.m_bPlaying) return; // native004241E6, no decode or reply
        this.RequireChief(socket);
        const value = packet.Decode1();
        packet.AssertEnd();
        const slot = value >>> 4;
        const info = this.AssertSlot(slot);
        const closed = !this.m_rgPlayer[slot] && (value & 15) !== 0;
        // CListSession::DoOpenCloseSlot @ 00423B8B broadcasts packed opcode 110.
        info[0] = closed
          ? info[0]! | SlotStateMask.Closed
          : info[0]! & ~SlotStateMask.Closed;
        const capacity = this.m_rgSlotInfo.filter(
          (s) => !(s[0]! & SlotStateMask.Closed),
        ).length;
        if (capacity !== this.m_nMaxPlayer) {
          this.m_nMaxPlayer = capacity;
          this.m_nModified |= SessionModified.Capacity;
        }
        this.SendPacket(
          new CSendPacket(
            ServerResponse.OpenCloseSlot,
            undefined,
            this.text,
          ).Encode1((slot << 4) | (closed ? 1 : 0)),
        );
        return;
      }
      case ClientRequest.SelectMap: {
        this.RequireChief(socket);
        const raw = packet.Decode2();
        packet.AssertEnd();
        if (this.m_bPlaying) {
          //0041C47D echoes EXISTING waiting selection only; no raw-map lookup,
          // room dirty bit, team remapping or playing-map mutation.
          this.SendPacket(
            new CSendPacket(
              ServerResponse.SelectMap,
              undefined,
              this.text,
            ).Encode2(this.m_nMapIdx),
          );
          return;
        }
        const index = (raw << 16) >> 16;
        const maxTeam = this.maps.GetSelectionMaxTeam(index);
        this.m_nMapIdx = index;
        this.m_nModified |= SessionModified.Map;
        this.SendPacket(
          new CSendPacket(
            ServerResponse.SelectMap,
            undefined,
            this.text,
          ).Encode2(raw),
        );
        this.NormalizeTeamColors(maxTeam);
        return;
      }
      case ClientRequest.SetGameTypeNormal:
      case ClientRequest.SetGameTypeMod: {
        this.RequireChief(socket);
        packet.AssertEnd();
        if (
          packet.m_nPacketType === ClientRequest.SetGameTypeMod &&
          (this.m_nativeLaunchToken || this.m_resultRound)
        )
          throw new CUnsupportedOperation(
            "Mod switch during committed ordinary round",
            "native permits it, but its active cascade/result is unported; mode retained",
          );
        if (packet.m_nPacketType === ClientRequest.SetGameTypeNormal)
          this.SendGameTypeNormal();
        else this.SendGameTypeMod();
        return;
      }
      case ClientRequest.RequestChangeTitle: {
        this.RequireChief(socket);
        const title = packet.DecodeStr(SessionLimit.ChangedTitleBytes);
        packet.AssertEnd();
        this.m_strName = title;
        this.m_nModified |= SessionModified.Title;
        this.SendPacket(
          new CSendPacket(
            ServerResponse.ChangeTitle,
            undefined,
            this.text,
          ).EncodeStr(title),
        );
        return;
      }
      case ClientRequest.PlayEmotion: {
        const slot = packet.Decode1();
        const a = packet.Decode1();
        const b = packet.Decode1();
        const c = packet.Decode2();
        packet.AssertEnd();
        if (this.m_rgPlayer[slot]?.m_pClientSocket !== socket)
          throw new CProtocolError("Emotion slot does not belong to sender");
        this.SendPacket(
          new CSendPacket(ServerResponse.PlayEmotion, undefined, this.text)
            .Encode1(slot)
            .Encode1(a)
            .Encode1(b)
            .Encode2(c),
          socket,
        );
        return;
      }
      case ClientRequest.TeamChat:
        this.OnTeamChat(packet, socket);
        return;
      case ClientRequest.RequestStartGame:
        this.OnRequestStartGame(packet, socket);
        return;
      case ClientRequest.ReadyForImmediateStart:
        this.OnReadyForImmediateStart(packet, socket);
        return;
      case ClientRequest.NotifyUDPLoss:
        this.OnNotifyUDPLoss(packet, socket);
        return;
      case ClientRequest.RequestUDPRelay:
        this.OnRequestUDPRelay(packet, socket);
        return;
      case ClientRequest.NotifyUDPPacketLoss:
        this.RequireRunning(socket);
        this.m_udpLossRegulator.OnNotifyUdpLoss(
          packet,
          socket,
          this.m_rgPlayer,
        );
        return;
      case ClientRequest.BombIgnite:
        this.OnBombIgnite(packet, socket);
        return;
      case ClientRequest.BombKickThrow:
        this.OnBombKickThrow(packet, socket);
        return;
      case ClientRequest.SetBombTimer:
        this.OnSetBombTimer(packet, socket);
        return;
      case ClientRequest.MovableBoxMove:
        this.OnMovableBoxMove(packet, socket);
        return;
      case ClientRequest.DropObstacle:
        this.OnDropObstacle(packet, socket);
        return;
      case ClientRequest.DestroyBox:
        this.OnDestroyBox(packet, socket);
        return;
      case ClientRequest.SetEffect:
        this.OnSetEffect(packet, socket);
        return;
      case ClientRequest.RequestEatItem:
        this.OnRequestEatItem(packet, socket);
        return;
      case ClientRequest.RequestEatObstacle:
        this.OnRequestEatObstacle(packet, socket);
        return;
      case ClientRequest.EventItem:
        this.OnEventItem(packet, socket);
        return;
      case ClientRequest.RequestGenerateGhost:
        this.OnRequestGenerateGhost(packet, socket);
        return;
      case ClientRequest.RequestDestroyGhost:
        this.OnRequestDestroyGhost(packet, socket);
        return;
      case ClientRequest.RequestAirplane:
        this.OnRequestAirplane(packet, socket);
        return;
      case ClientRequest.SetBomberEvent:
        this.OnSetBomberEvent(packet, socket);
        return;
      case ClientRequest.LapFinished:
        this.OnLapFinished(packet, socket);
        return;
      case ClientRequest.LapInfo:
        this.OnLapInfo(packet, socket);
        return;
      case ClientRequest.ReqEatBula:
        this.OnReqEatBula(packet, socket);
        return;
      case ClientRequest.ReqTakeHouse:
        this.OnReqTakeHouse(packet, socket);
        return;
      case ClientRequest.Shobuari:
        this.OnShobuari(packet, socket);
        return;
      case ClientRequest.ReqCreateObj:
        this.RequireRunning(socket);
        this.m_syncGameObjMan.OnReqCreateObj(packet, socket);
        return;
      case ClientRequest.ReqDestroyObj:
        this.RequireRunning(socket);
        this.m_syncGameObjMan.OnReqDestroyObj(packet, socket);
        return;
      default:
        throw new CUnsupportedOperation(
          `Room request ${packet.m_nPacketType}`,
          "FXGS CGameSession::OnPacket @ 004212AD",
        );
    }
  }
}
