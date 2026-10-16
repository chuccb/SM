/**
 * Verified numeric values from the shipped executable/pseudocode, NOT tuning knobs.
 * Names below are descriptive where original enum names did not survive IDA.
 * Keep source VA references here; deployment/security policy belongs in RuntimePolicy.
 */
/** Fixed-width boundaries used by the supplied x86 integer operations. */
export const IntegerRange = {
  UInt8Maximum: 0xff,
  UInt16Maximum: 0xffff,
  Int16Minimum: -0x8000,
  Int16Maximum: 0x7fff,
  Int32Minimum: -0x80000000,
  Int32Maximum: 0x7fffffff,
  UInt32Maximum: 0xffffffff,
} as const;

/** OLE DB DBTIMESTAMP / SYSTEMTIME16-byte layouts from supplied FXGS headers
 * and004404D0/00440F00; these are native field offsets, NOT Unix units. */
export const NativeTimeFormat = {
  DBTimestampBytes: 16,
  SystemTimeBytes: 16,
  DBTimestamp: {
    Year: 0,
    Month: 2,
    Day: 4,
    Hour: 6,
    Minute: 8,
    Second: 10,
    Fraction: 12,
  },
  SystemTime: {
    Year: 0,
    Month: 2,
    DayOfWeek: 4,
    Day: 6,
    Hour: 8,
    Minute: 10,
    Second: 12,
    Milliseconds: 14,
  },
} as const;

export const CipherDegree = { None: 0, CRC32: 1, CRC8: 2 } as const;
export type CipherDegree = (typeof CipherDegree)[keyof typeof CipherDegree];

// LS/CxLogin.exe.c CBufferManipulator::{Encrypt1,Encrypt2,Encrypt4} @ 00423120..00423150.
export const ScalarCipher = {
  ByteXor: 0x5a,
  WordXor: 0xa569,
  DwordXor: 0x96ca5395,
} as const;
// SimpleStreamEncrypt3/Decrypt3 @ 00429EB0 / 00429F50. Chaining uses LE x86 DWORDs.
export const StreamCipher = {
  InitialKeyXor: 0x53351d9c,
  KeyDecrement: 1674226915,
} as const;
// CCRC8 / CCRC32 @ 00424DB0 / 00424CA0: non-reflected, MSB-first, no final XOR.
export const CRCPolynomial = { CRC8: 0x07, CRC32: 0x04c11db7 } as const;
// CLoginPool::OnLogin @ 0040F1D0: nested string encryption, independent of packet CRC key.
export const LoginStringKey = { ID: 0x11223344, Password: 0x44332211 } as const;
// CClientSocket constructor @ LS 00408560; all client services share these settings.
export const ClientSocketCode = {
  ReceiveBase: 192,
  SendBase: 102,
  Modifier: 231,
  InitialSequence: 40,
  SequenceDelta: 3,
  HeaderTypeCount: 16,
  MaxPacketLength: 0x4000,
} as const;
// Local/Center sockets @ LS 0040C380, Center 0040E3A0. Direction is local -> Center.
export const LocalSocketCode = {
  ReceiveBase: 96,
  SendBase: 189,
  Modifier: 231,
  InitialSequence: 40,
  SequenceDelta: 0,
} as const;
// CMainSystem::OnConnEstablished @ LS 00410B30. These are advertised version words.
export const LoginVersion = { Major: 3, Minor: 7 } as const;
// CDBMan::GetUserHashNo @ LS 0040A280; ASCII lowercase first *encoded byte*, not JS hash.
export const DatabaseLayout = { UserShardCount: 6 } as const;
// Parameters of prCreateUser @ LS 0040A700; sizes are legacy encoded bytes, not characters.
export const UserFieldSize = {
  ID: 16,
  Name: 16,
  EncodedPassword: 24,
  Email: 64,
  Address: 72,
  Tel: 40,
  Profile: 264,
  PasswordQ: 250,
  PasswordA: 100,
  IdentityNo: 50,
  Birthday: 10,
} as const;
// CClientSocket::AddNewUsers fixed array + CConnectPool::OnConnEstablished @ FXGS 004081EF.
export const UserCount = { Minimum: 1, Maximum: 2 } as const;
// CBaseSession and CGameSessionTable @ FXGS 004198FD, 004217CF, 00422FD7.
export const SessionLimit = {
  Players: 8,
  GameSessions: 255,
  NoSession: 0xffff,
  NoSlot: -1,
  NoEligibleChief: -2, // GetNextChiefSlot00423D3B; Supreme may be nonempty
  TitleBytes: 40,
  PasswordBytes: 8,
  ChangedTitleBytes: 22,
} as const;
/** CBaseSession::LockBaseSessions and table traversal 004219A2. Independent
 * of player capacity despite the equal literal eight; Bun needs no native locks. */
export const SessionTableRule = { LockStripes: 8 } as const;
/** Native CBaseSession reserves twelve slots in its memory layout even though
 * ordinary CGameSession uses eight. +152 is a 12-stride DWORD relation matrix;
 * its broader semantics remain opaque, so do not alias stride to player count.
 * CListSession::DeleteUser 00423DB6 clears one row/column for the live capacity. */
export const ListSessionLayout = { SlotMatrixStride: 12 } as const;
/** +872 slot->ghost uses -1 for no ghost; +904 ghost->slot uses NoSlot.
 * These are assignments, NOT creation capacity/count or ghost gameplay rules. */
export const GameGhostAssignment = { NoGhost: -1 } as const;
/** 0041F3F1 / 0041B3FF: eight ghost IDs, distinct from player slots even
 * though capacities coincide. Newly created166 has owner|80 plus an opaque
 * request byte; departure transfer166 has neither the flag nor that byte. */
export const GameGhostRule = { Capacity: 8, GeneratedOwnerFlag: 0x80 } as const;
/** CClientSocket::AddBeforeJoinSession 00406F68: FIFO of UNIQUE room indices,
 * duplicates do NOT refresh position. Used by native autojoin, not a ban list. */
export const ClientSessionHistoryRule = { MaximumRooms: 5 } as const;
/** Numeric FXGS CClientSocket+468 values, NOT recovered native enum names.
 * 4 tolerates stale session packets; it is NOT Lobby (1) or Channel (3).
 * Common transport retains descriptive stage strings for LS/GS deployment. */
export const FxClientPoolType = {
  Connecting: 0,
  Lobby: 1,
  Session: 2,
  Channel: 3,
  SessionRemoved: 4,
  Practice: 6,
} as const;
/** CBanChief 0040102F..00401115, DWORD unsigned strict > comparisons.
 * IsBanChief's manner argument is UNUSED in this supplied build. */
export const BanChiefLayout = { Size: 36 } as const; // vptr + eight DWORDs
export const BanChiefTiming = {
  FullRoomMilliseconds: 10_000,
  OtherRoomMilliseconds: 20_000,
  WarningMilliseconds: 10_000,
  OddSlotMilliseconds: 5_000,
  SuperChiefMultiplier: 3,
} as const;
// COSmartStream::CompressBuffernCalcCRC @ LS 0042B860; payload and length are LE.
export const SmartStreamFormat = {
  Magic: 24,
  Raw: 0,
  Deflate: 1,
  CompressionLevel: 9,
  FileMagic: "ssi1",
} as const;
// CListSession slot state is a packed 3-byte record, not three booleans.
// See FXGS 00419715, 004199E5, 00423B8B, 0041E2FE.
export const SlotStateMask = {
  Closed: 0x01,
  Chief: 0x02,
  Status: 0x1c,
  NotReady: 0,
  Ready: 0x04,
  ReadyForStart: 0x08,
  Bomber: 0x3f,
  Color: 0x1f,
} as const;
// Server type IDs: Center CUser::CheckConnectingToSvr @ 004153B0; CLocalServerMan::GetSvr.
export const ServerType = {
  Login: 1,
  FXGame: 10,
  FXShop: 11,
  Util: 99,
} as const;
export type ServerType = (typeof ServerType)[keyof typeof ServerType];
/** Center CUser004153B0/004155F0 raw state semantics. NOT the modern
 * SessionTransferTimeoutMs policy or FXGS CUser's BYTE auth field. */
export const CenterConnectionRule = {
  NativeConnectingTimeoutMs: 17_500, // CMP445Ch, unsigned jbe => expire only >
  PremiumAuthencode: 1, // DWORD at Center CUser+56 compared EXACTLY, not truthy/lowBYTE
  NoServerIndex: -2147483648, // SetFree resets +64 to80000000h
} as const;
// Center_000.cfg FXGSType* and FXGS CMainSystem::IsPremiumChannel / map restrictions.
export const ChannelType = {
  Normal: 0,
  Beginner: 1,
  Premium: 41,
  Guild: 77,
  Expert: 99,
} as const;
// CLoginPool::OnLogin + OnCenterResAddNewUser @ LS 0040F1D0 / 0040F7A0.
export const LoginResult = {
  Success: 0,
  InvalidCredentials: 1,
  AlreadyConnected: 2,
  DatabaseFailure: 3,
} as const;
// CDBMan::ConfirmUnregisteredId @ 0040A2D0.
export const ConfirmIdResult = { Available: 0, Exists: 1, Failure: 2 } as const;
// CLoginPool::OnReqConnectToSvr / Center CUser::CheckConnectingToSvr. Other codes remain unmapped.
export const ConnectResult = { Failure: 0, Success: 1 } as const;
// CGameSessionTable::{DoCreateSession,DoJoinSession} @ FXGS 00422526 / 00422849.
export const CreateSessionResult = {
  Success: 0,
  Rejected: 1,
  NoFreeRoom: 2,
  AlreadyInRoom: 3,
} as const;
export const JoinSessionResult = {
  Success: 0,
  IncorrectPassword: 1,
  Unavailable: 2,
} as const;
// CListSession::MakeModifiedPacket @ FXGS 00423A1C.
export const SessionModified = {
  Playing: 0x01,
  Map: 0x02,
  PlayerCount: 0x04,
  Capacity: 0x08,
  Title: 0x10,
} as const;
// These literals are verified but their semantics are NOT established. Do not rename to invented features.
export const OpaqueOfficial = {
  // FXGS CConnectPool::OnConnEstablished @ 004081EF compares the XOR of two client DWORDs.
  FxClientIntegrityXor: [0xf1164b8b, 0x11221122] as readonly number[],
  // FXGS CUserPool::OnEstimateRTT @ 00418790, second DWORD (different first value).
  FxClientRTTIntegrity: [0xdf1a2e51, 0x11221122] as readonly number[],
  // LS CChannelCache::MakeChannelsExtraInfoPacket @ 00405A20, ad rotation word.
  AdvertisementInterval: 60,
  // LS CLoginPool::OnCenterResAddNewUser @ 0040F7A0: literal fields following Gender.
  LoginUserWord: 0,
  LoginUserByteA: 1,
  LoginUserByteB: 10,
} as const;

// Center CGameServer::Init @ 00406150 + GS GetGameAttr @ 00408191.
export const GameAttribute = { ShopInventory: 0x01 } as const;
// LS CClientSocket::CheckLoginFlush uses this original anti-flush interval.
export const LoginFlushIntervalMs = 5000;
// LS 0040EB60 static first-info strings; transmitted literally, never fetched by the server.
export const FirstInfoURL = {
  // GS CMainSystem::OnConnEstablished @ 00411737 (a literal only; never fetched).
  Greeting: "ftp://download.nexon.co.kr/ca",
  ConfirmUser: "http://mail.nexonclub.com/clubadmin/confirmuser",
  IDQuery: "http://id.nexonclub.com/nxidquery.idsocno",
} as const;
// CGameSession::OnSelectMap @ 0041C47D: palette for maps allowing two to four teams.
export const LimitedTeamColors = [0, 3, 5, 6] as const;

// FXGS CGameSession::{SendGameTypeNormal,SendGameTypeMod} @ 0041B509 / 0041B567.
// Distinct from the creation packet's Manner flag, and from GS channel Type.
export const GameType = { Normal: 0, Mod: 1 } as const;
// CGameSession::CanStartGame @ 0041C805; zero is only a validation result,
// not permission to send a start-success packet before the round lifecycle exists.
export const StartGameResult = {
  Valid: 0,
  LevelLimit: 1,
  NotReady: 2,
  NotEnoughPlayers: 3,
  MapCapacity: 4,
  NotEnoughTeams: 5,
  UnbalancedTeams: 6,
  PremiumMap: 7,
} as const;
export const MapSelection = { Random: -1, FirstTheme: -2 } as const;
export const TeamLimit = {
  Colors: 8,
  LimitedMinimum: 2,
  LimitedMaximum: 4,
} as const;

// CChatPool/CListSession format into char[1024], including terminating NUL.
export const ChatFormat = { MaximumFormattedBytes: 1023 } as const;

// FXGS CGameContext size 0x288C; Init @ 0041CD9B, getters @ 0041B7BA..0041B817.
// 13x15 is the obstacle/house board; Bula has a DISTINCT 26x45 state plane.
export const GameContextLimit = {
  Bombs: 150,
  BoxItems: 250,
  FirstGeneratedBoxItem: 126,
  Rows: 13,
  Columns: 15,
  BulaRows: 26,
  BulaColumns: 45,
  Unclaimed: -1,
} as const;
/** OnReqTakeHouse0041D941. The two literal5 values have DISTINCT roles.
 * Drop payload meanings are not established; preserve all three opaque bytes. */
export const HouseClaimRule = {
  MoneyPerNewCell: 5,
  DropSectionMarker: 5,
  MaximumByteCount: 255,
  CellFieldCount: 2,
  DropRequestFieldCount: 3,
  DropResponseFieldCount: 4,
  MinimumResponseBytes: 5, // opcode + actor + acceptedCount + marker + dropCount
} as const;
// OnBombIgnite 0041E5AC / OnBombKickThrow 0041E74E / Update 0041DC31.
// Packed tile byte: row in high nibble, column in low nibble.
export const GamePosition = { RowShift: 4, ColumnMask: 0x0f } as const;
export const BombState = { Stationary: 0, Moving: 1 } as const;
export const BombRule = {
  FuseMilliseconds: 2800,
  FuseAfterLandingMilliseconds: 2000,
  PausedFlag: 0x40,
  PowerMask: 0x0f,
  ActorSlotMask: 0x0f,
} as const;
// CGameSession::Update/DoStartGame: independent of m_bPlaying and slot-ready bits.
export const GameStage = { Loading: 0, Running: 1, Result: 2 } as const;
/** CTimerThreadNormal::Proc 00415B9A sleeps 0x190ms BEFORE each traversal.
 * This is not a guessed 60Hz physics rate; native Update arbitrates client events. */
export const GameUpdateTiming = {
  NormalTimerIntervalMilliseconds: 400,
} as const;
/** Update 0041DE4F..0041DF00. The short timeout applies only when ALL EIGHT
 * state bytes are 1/3/4, including vacant slots. Expiry is unsigned >=, unlike
 * the strict > result/UDP deadlines. 9999 is the native server-die payload value;
 * its broader client-side interpretation is not established by this block. */
export const PlayerStateTimerRule = {
  AllStates1Or3Or4Milliseconds: 6_000,
  OtherStatePresentMilliseconds: 10_000,
  ServerDieHeaderCoordinate: 0,
  ServerDieEntryCoordinate: 9_999,
} as const;
// CGameSession +11604: NOT a boolean. Descriptive names, not recovered enum
// names. 0041EE05 assigns 0/1/2/3; 0041FDA7 assigns 5; 0041CC8B assigns 6/7.
// State 4 is excluded by house arbitration and preserved on event-4 death;
// its originating transition/meaning is NOT established here.
export const GamePlayerState = {
  Active: 0,
  Inactive: 1,
  WinClaim: 2,
  PendingDie: 3,
  Excluded4: 4,
  LapFinished: 5,
  HouseWinner: 6,
  HouseTie: 7,
} as const;
// CSyncGameObjMan 004154D2/004155D8: native interval and wire field widths.
export const SyncGameObjectRule = {
  CreateIntervalMilliseconds: 5000,
  CreateDataBytes: 20,
  Stopped: -1,
  MaximumWireID: 0xffff,
} as const;
// CItemAttr::Load 0040EA1E. Strings are plain in the resource; SimpleCipher is
// used only for the legacy object's in-memory copies, not on the file bytes.
export const ItemAttrFormat = {
  NameBytes: 63,
  ShipAttributeWords: 8,
  ParameterWords: 5,
  MaximumItems: 256,
  ProbabilityTableSize: 0x8000,
  MaximumWeight: 0x7fff,
  UnassignedProbabilityByte: 0xff,
  TemplatePrefixes: ["Item/Item", "Item/"] as readonly string[],
} as const;
/** OnRequestEatItem 0041EA50 / OnRequestEatObstacle 0041ECA3.
 * Native claim arrays use zero/nonzero, NOT proof of spawned item identity. */
export const GamePickupState = { Unclaimed: 0, Claimed: 1 } as const;
/** OnRequestEatItem +140..+1A6: authencode BYTE at CUser+2004, NOT gender,
 * authority, billing class, or a verified premium entitlement. The >10000
 * branch only diagnoses; it does NOT cap or reject the amount. */
export const MoneyPickupRule = {
  BonusAuthencode: 1,
  MinimumMultiplier: 1,
  MultiplierModulo: 2,
  AmountParameterIndex: 0, // row+144, the first of five signed parameters
  ResponseFieldCount: 4, // slot, box, item, multiplier (plus the156 selector)
  DiagnosticAmountThreshold: 10_000,
} as const;
/** OnItemThrow 0041E8E7. Six echoed BYTEs, low nibble of first is room actor.
 * No ordinary request opcode is recovered: native153 selects the default. */
export const ItemThrowRule = {
  FieldCount: 6,
  ActorFlagsByte: 0,
  BoxIndexByte: 1,
  ActorMask: 0x0f,
} as const;

// GAME PICKUP resource row+140, not FXSS item stock, price, cash or billing.
export const GameItemType = { Money: 99 } as const;

/** FXGS MTUDPBase framing 0042E122; native receive buffer is 4096 bytes. */
export const MTUDPFormat = {
  MaxFrameLength: 255,
  MaxDatagramBytes: 4096,
} as const;

/** CUDPPacketDispatcher 00416619 / OnUDPPeerInfo 0041CE45. */
export const GameUDPFormat = {
  PortOffset: 1, // MTUDPServer::StartupBase 0042E55A: ServerPort + 1
  PeerInfoBytes: 23,
  LegacyReadyBytes: 35,
  AdvertisedHostCount: 2,
  HostsPerSlot: 3,
} as const;

/** CGameSession::Update 0041DC31 and CUdpLossRegulator 00416595.
 * Comparisons are unsigned DWORD elapsed > threshold, NOT >= threshold. */
export const GameConnectionTime = {
  LoadingPeerTimeoutMs: 25_000,
  PreparePeerTimeoutMs: 30_000,
  UdpLossBatchMs: 8_000,
} as const;

/** LaunchGameStage 00420BB3. The two random-only bombers are the final rows:
 * nominal branch weights: normal 29/30, first special 1/90, second 1/45.
 * These are NOT exact CRT probabilities (modulo bias / correlated CRT draws).
 * The actual PE rand() at 0046EA5F masks to 15 bits and calls __getptd:
 * CRT state is per THREAD, not process-global. The rewrite supplies independent
 * CSPRNG draws, NOT an emulation of that native seed / sequence. */
export const BomberRandomRule = {
  RandomOnlyBranchModulo: 30,
  SecondRandomOnlyModulo: 3,
  RequiredRandomOnlyCount: 2,
  NativeRandomRange: 0x8000,
} as const;

/** CGameSession::Init0041AD15 / Launch00420BB3 / Start0041BDCF.
 * Color remapping at start is NOT the waiting-room round-robin algorithm.
 * MissionInfo has four serialized DWORDs; its native vector is separately
 * constructed EMPTY and LoadMap never deserializes pointer-looking words. */
export const GameLaunchRule = {
  MillisecondsPerSecond: 1000,
  RemappedColors: [1, 2, 4, 7],
  MissionWords: 4,
  LapSortWordsPerSlot: 2,
  InitialLapWord: 0xffffffff,
  OpaqueStartWords: 2, // native+11612/+11616, meaning not established by observed writers
  InitialOpaqueStartWord: -1,
} as const;
/** SendAirplaneItemProb004204EB reads TWO sections of at most100 names/weights.
 * Mission type1 selects section two; values are bytes, NOT normalized to100.
 * Native ladder initial-time clamp exists but ordinary IsLadderGame returns0. */
export const AirplaneItemRule = {
  Sections: 2,
  MaximumEntries: 100,
  MaximumWeightByte: 0xff,
  AlternateMissionType: 1,
  LadderInitialTimeMaximumMs: 30_000,
} as const;

/** OnRequestAirplane0041D7C0: absolute DWORD add/compare, NOT elapsed or
 * map initial/frequency. +12624 stores last SCHEDULED(now+2000), so ordinary
 * next request is due9000ms after receipt. Native >3 only diagnoses; our body
 * hardening enforces that reported maximum, preserving safe zero-count echo. */
export const AirplaneRequestRule = {
  RequestGapMilliseconds: 7000,
  ScheduledTickLeadMilliseconds: 2000,
  ReportedCountMaximum: 3,
  EntryBytes: 4,
  BoxIndexByte: 1,
} as const;

/** CDynInfoCalculator 0040B337 / getters 0041AAF1..0041AB68.
 * Offsets are DWORD indices, except Size in BYTES; +0 is the native vtable.
 * Opaque99 is reset but its meaning is not established; Nice is NOT a reward.
 */
export const DynInfoLayout = {
  Size: 596,
  PlayerCount: 1,
  OverallMean: 2,
  TeamMean: 3,
  PlayerWeight: 11,
  SaveMatrix: 19,
  SaveCount: 83,
  KillCount: 91,
  Opaque99: 99,
  Nice: 107,
  TeamColor: 115,
  TeamCount: 123,
  MyTeamNo: 131,
  OtherTeamNo: 139,
  HasPremium: 147,
  InvalidGame: 148,
} as const;
/** FXGS 0040B210 / 0040B284 / 0040B29E / 0040B337 / 0040B4CE..0040B6EB. */
export const DynInfoRule = {
  SlotStateBytes: 3,
  InvalidThreshold: IntegerRange.Int32Maximum,
  PerMille: 1000,
  LevelOffset: 100,
  MoneyPerPlayer: 300,
  MoneyDivisor: 2,
  MoneyMinimum: 200,
  MoneyMaximum: 450,
  WinFactor: 100,
  WinMinimum: 50,
  WinMaximum: 200,
  DrawFactor: 10,
  DrawMinimum: 0,
  DrawMaximum: 50,
  ResultScale: 0.5,
  ExpPerKill: 20,
  ExpPerSave: 20,
  KillSaveMaximum: 140,
  PremiumNumerator: 11,
  PremiumDenominator: 10,
} as const;
/** CGameSession::{GetWinGameResult,GetGameDetailResult,DeferHandleGameEnd}
 * 0041B482 / 0041CA78 / 0041D31A. Authencode is NOT TicketDate. */
export const RoundResultRule = {
  MinimumLargeTeamPlayers: 3,
  MinimumDetailKills: 3,
  PremiumAuthencode: 1,
  NoWinnerColor: -1,
} as const;
export const GameDetailResult = {
  None: 0,
  KillCountMatch: 1,
  KillSaveCountMatch: 2,
  AuthencodeOne: 3,
} as const;
/** OnLapInfo0041B5E9: two BYTE progress fields invert into the HIGH DWORD
 * of an unsigned QWORD; absolute WinMM tick is its LOW DWORD. Ties prefer the
 * lower room slot. Names do not claim the exact client UI meaning of either
 * progress byte. Unknown sort words still participate for occupied players. */
export const GameLapRule = {
  ProgressByteMaximum: 0xff,
  ProgressHighShift: 8,
  FirstRank: 1,
  VacantByte: 0xff,
} as const;

/** OnSetBomberEvent case0 0041EEBB..0041F024. No inferred physics, name
 * matching, price or authority rule. 108 is only proven as the no-shop-use
 * channel marker here; it is NOT renamed to a guessed ladder mode. */
export const SpecialItemRule = {
  AllowedTypes: Object.freeze([
    11, 12, 13, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32,
  ]),
  RefreshStateTimeType: 22,
  NoShopUseChannelType: 108,
  ShopAttemptValue: 1,
  NiceValue: 1,
  ResponseBytes: 9,
} as const;
/** InitUserInventory0040AF55 + resident queries00416AE5..00416C0C and
 * MakeSlotAccessoryPacket00419597. Category IDs are NOT CItemAttr Type.
 * Neutral names retain unknown meanings of category4's self BYTE and14 tail. */
export const UserInventoryRule = {
  LoadCountLimit: 400,
  UnequippedSlot: 0xff,
  FunctionalCategory: 2,
  SelfInfoCategory: 4,
  LevelIconCategory: 5,
  FakeLevelCategory: 6,
  SlotDecorationCategory: 10,
  CharDecorationCategory: 12,
  AccessoryTailCategory: 14,
  SlotDecorationPositions: 9,
  CharDecorationPositions: 5,
} as const;

/** InitPreInventory0040ACF4 / MakePreInventoryPacket00416CA9.
 * Category is the FxItem definition's BYTE, NOT PreInventory.Type or CItemAttr.
 * 100000 gates only the displayed ValidityPeriod WORD, not SQL expiry. */
export const PreInventoryRule = {
  SuccessfulLoadLimit: 30,
  PremiumTicketCategory: 9,
  MoneyCategory: 100,
  ExperienceCategory: 101,
  HiddenValidityPeriodThreshold: 100_000,
  PremiumAuthencode: 1,
} as const;
export const PreInventoryFormat = {
  NativeRecordBytes: 56,
} as const;

/** MakeUserInventoryPacket00416C0C. Inventory Amount is NOT ItemID. The native
 * description precedes eight RAW x86 f64 VariantTime bytes, not scalar coding. */
export const UserInventoryFormat = {
  NativeRecordBytes: 84,
  VariantTimeBytes: 8,
} as const;

/** OnSetBomberEvent 0041EE05. Several descriptive event names remain opaque.
 * 0 relays special items with optional durable inventory consumption;
 * 8 echoes two opaque bytes, NOT a rebirth transition.
 * 5 is server-only and explicitly rejected by modern policy.
 */
export const BomberEvent = {
  SpecialItem: 0,
  Notify1: 1,
  PendingDie: 2,
  Save: 3,
  Die: 4,
  ServerDie: 5,
  WinClaim: 6,
  Notify7: 7,
  Opaque8: 8,
  KindShift: 4,
  SlotMask: 0x0f,
  NoKiller: 0xff,
} as const;

/** SendGameResult 0041FF51 / constants 0048F5C8..0048F5E0.
 * The reciprocal is the PE's binary32 0x380bcf65, NOT a double division.
 * Shop-item flag writer: OnSetBomberEvent(kind 0) 0041EF15; not billing/auth.
 */
export const GameResultRule = {
  ZeroRewardMilliseconds: 15_000,
  FullRewardMilliseconds: 45_000,
  DurationRampReciprocal: Math.fround(1 / 30_000),
  OpposingShopItemWinMultiplier: 1.05,
  PremiumTeammateWinBonus: 0.1,
  MinimumCachedTeamPlayersForBonus: 2,
  MinimumPremiumTeammates: 2,
} as const;
export const GameResultCategory = {
  Win: 0,
  LargeTeamWin: 1,
  Lose: 2,
  Draw: 3,
} as const;
/** CUser::DeferFlushModifiedInfo 00417603: unsigned game count >=25 or force.
 * This describes native cadence, NOT a durable SQLite flush implementation.
 */
export const UserDynamicRule = {
  GamesPerNativeFlush: 25,
  // CUser::IncDecMoney 004090EC: signed32 add, then [0,1,000,000] clamp.
  // NOT the SQLite storage range, shop price, cash credit, or payout cap.
  MaximumMoney: 1_000_000,
} as const;

/** CGameSession::Update 0041DC31 and DeferReturnPrepareStage 0041B0B7.
 * Comparisons are strict >, on DWORD subtraction, not >= or wall-clock dates. */
export const GameResultTiming = {
  MaximumActiveMilliseconds: 180_000,
  ReturnPrepareMilliseconds: 8_000,
} as const;
/** SendGameResult scalar body sizes, before stream/header/CRC framing. */
export const GameResultFormat = {
  PrefixBytes: 5,
  OccupiedPlayerBytes: 15,
} as const;
