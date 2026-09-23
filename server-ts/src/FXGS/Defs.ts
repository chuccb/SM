/** Port-only declaration module for FXGS shared native constants — the slot-state bit fields, the session-idx
 *  sentinels and the timing/hash values, named once for the whole unit. */

/** MainSystem+8 — the channel types the GS behaviour keys on (the Center
 *  cfg's FXGSTypeN values; 41 = premium, 77 = guild). */
export const PREMIUM_CHANNEL_TYPE = 41;
export const CHANNEL_TYPE_GUILD = 77;
/** …99 (cfg FXGSType4) is the accounting-log gate: SendGameResult's three
 *  exp/win/lose Reports only print on that channel type. */
export const ACCOUNTING_LOG_CHANNEL_TYPE = 99;
/** 108 — NoShopItemServer: UseSpecialItem with count!=0 is rejected (OnSetBomberEvent). */
export const CHANNEL_TYPE_NO_SHOP = 108;
/** the off-screen (x,y) pair the 80 death report carries for a bomber killed
 *  by a trap or by the UDP-loss sweep (:33026, two Encode2(9999)). */
export const DEATH_COORD = 9999;
/** the map-template version floor — the loader clamps file dwords < 1000 up
 *  to it (CGameMapTmpl::LoadMap). */
export const MAP_VERSION_MIN = 1000;
/** Signed i16 map selections (0041C497 / 0041C9C4): -1 = any map,
 * -2 = theme 0, -3 = theme 1, etc. */
export const MAP_IDX_RANDOM = -1;
export const MAP_IDX_THEME_BASE = -2;

/** Convert a themed wire selection to its zero-based theme index. */
export function GetThemeIdxFromMapIdx(mapIdx: number): number {
  return MAP_IDX_THEME_BASE - mapIdx;
}
/** Every 32-bit stamp in the original is a winmm timeGetTime() uptime
 *  dword — the port routes those through core/timeGetTime (performance.now
 *  wrapped at 2^32); the mask remains for the few raw-epoch leftovers. */
export const TICK_U32_MASK = 0xffffffff;
/** the practice AI level grid — levels live on 15-wide bands (0/15/30), the
 *  band top is 45 and the 110 handler steps ±15 inside a band, ±45 across. */
export const AI_LEVEL_BAND = 15;
export const AI_LEVEL_BAND_TOP = 45;

/** CMainSystem::OnConnEstablished (FxServer.exe.c:20694) — the client patch
 *  URL; the GS hands out the download root (shop/util hand out the patch
 *  root, the LS its UrlPatch config table). */
export const CONN_PATCH_URL = "ftp://download.nexon.co.kr/ca";

/** p7 client-check constants (CConnectPool::OnConnEstablished). */
export const FxCLIENT_HASH_A = 0xf1164b8b;
export const FxCLIENT_HASH_B = 0x11221122;
/** CUserPool::OnEstimateRTT — no second RTT within 0x1374 ms, else SpeedHack. */
export const RTT_MIN_INTERVAL = 0x1374;
/** …and the memory-check magic pair (DF1A2E51 = ~11221122). */
export const RTT_HASH = 0x11221122;
export const RTT_HASH_INV = 0xdf1a2e51;
/** CUserPool::DisconnectTimeoutSocket — 0x9C40 ms without RTT. */
export const SOCKET_TIMEOUT = 0x9c40;
/** CUser::DeferFlushModifiedInfo — completed-game threshold, not timer ticks. */
export const DYN_FLUSH_BURST = 0x19;
/** CUser::IncDecMoney (004090EC) — balance cap after signed int32 addition. */
export const USER_MONEY_MAX = 1_000_000;
/** CDBMan::InitPreInventory / CUser fixed pre-inventory pointer table. */
export const MAX_PRE_INVENTORY_ROWS = 30;
/** CUser::MakePreInventoryPacket's upper clamp before its E2 encode. */
export const PRE_INVENTORY_VALIDITY_CLAMP = 100_000;

/**
 * CBaseSession m_rgSlotState triple (+68+3·slot) bit fields — byte0: bits 2-4
 * carry the ready-group code (4 = OnSetPlayerReady's ready toggle :35286, 8 =
 * the OnReadyForImmediateStart start-gate state :34488 that the launch poll
 * requires :31919), byte1 low 6 = the selected bomber idx (:31177/:37308),
 * byte2 low 5 = the colour (:30429).  The CanStartGame stand-by check reads
 * the same group code (:33531/:33537).
 */
export const SLOTSTATE_GROUP_MASK = 0x1c;
export const SLOTSTATE_GROUP_CLEAR = 0xe3; // ~GROUP_MASK & 0xff
export const SLOTSTATE_READY = 0x04;
export const SLOTSTATE_LAUNCH_OK = 0x08;
export const SLOTSTATE_CHIEF = 0x02; // byte0 bit1 — SetChiefSlotidx's marker
export const SLOTSTATE_CHIEF_CLEAR = 0xfd; // ~CHIEF & 0xff
export const SLOTSTATE_BOMBER_MASK = 0x3f;
export const SLOTSTATE_BOMBER_CLEAR = 0xc0; // ~BOMBER_MASK & 0xff
export const SLOTSTATE_COLOR_MASK = 0x1f;
export const SLOTSTATE_COLOR_CLEAR = 0xe0; // ~COLOR_MASK & 0xff

/** CClientSocket+500 session-idx WORD sentinels (ctor `mov word -1`;
 *  the GetPacket switch default ignores session packets in these states). */
export const SESSION_IDX_NONE = 0xffff; // sitting in the lobby
export const SESSION_IDX_CONNECTING = 0xfffe; // still connecting
export const SESSION_SERIAL_NONE = 0xffffffff;
/** the unsigned idx validity bound — the sentinels above all fail it. */
export const SESSION_IDX_MAX = 255;

/** CChannelPool::SendUserLocation (:6192) / SendUserDetailInfo (:6561) —
 *  the Encode2(65534) "user is on another server" marker that follows the
 *  session idx in the 71/72 responses. */
export const SESSION_LOC_OTHER_SERVER = 0xfffe; // 65534

/** CListSession chief-swap counter +728 — at 10000 the room turns supreme
 *  (GetNextChiefSlot / IsLadderGame read it; the original writes 10000). */
export const SUPREME_ROOM_SWAP_COUNT = 0x2710;
/** CUdpLossRegulator::DeferRegulateConnection (:26256) — regulate only once
 *  8 s have passed since the first loss-report (187). */
export const UDP_REGULATE_DELAY = 0x1f40;
/** CGameSession::DeferReturnPrepareStage (:31979) — 8 s after the end screen. */
export const RETURN_STAGE_DELAY = 0x1f40;
/** CGameSession::IsLadderGame (4209A6: xor eax,eax) — hardwired 0.
 *  Packet 163 writes it as the fourth header byte, after strategy
 *  GetResultViewType (FxServer.exe.lst:00420011). */
export const IS_LADDER_GAME = 0;
/** asc_48F568 (EUC-KR) — "[\xbe\xcb\xb8\xb2] %s ..." = "[Notification] %s has obtained 100x the luck of experience in the premium channel."
 *  (SendGameResult → SendBigLuckMsg; GetWinExp never sets the trigger flag). */
export const STR_BIG_LUCK_MSG = "\x5b\xbe\xcb\xb8\xb2\x5d\x20\x25\x73\x20\xb4\xd4\xb2\xb2\xbc\xad\x20\xc7\xc1\xb8\xae\xb9\xcc\xbe\xf6\x20\xc3\xa4\xb3\xce\xbf\xa1\xbc\xad\x20\xb0\xe6\xc7\xe8\xc4\xa1\x20\x31\x30\x30\xb9\xe8\xc0\xc7\x20\xc7\xe0\xbf\xee\xc0\xbb\x20\xbe\xf2\xc0\xb8\xbc\xcc\xbd\xc0\xb4\xcf\xb4\xd9\x2e";

/** Client 6 OnReqConnectToSvrRes gate codes — CCenterProcess::CheckEnterGame and
 *  CUser::CheckConnectingToSvr (center). 0 no game state, 1 success, 2 premium required
 *  (center type 41 without ticket), 4 version mismatch, 5 server type unavailable.
 *  Shared with LS (same native logic). */
export const CONNECT_GATE_RESULT = {
  NoGameState: 0,
  Success: 1,
  PremiumRequired: 2,
  VersionMismatch: 4,
  ServerTypeUnavailable: 5,
} as const;

/** Session create/join result codes — client 85/81/89 etc.
 *  0 success, 1 password mismatch, 2 failure (full/not found), 3 already seated. */
export const SESSION_RESULT = {
  Success: 0,
  PasswordMismatch: 1,
  Failure: 2,
  AlreadySeated: 3,
} as const;

/** Session info detail (84) existence flag — 0 not found, 1 found (room exists). */
export const SESSION_INFO_DETAIL_RESULT = {
  NotFound: 0,
  Found: 1,
} as const;

/** CChannelPool rank/guild member paging — 9 per page (packet 70/67). */
export const RANK_PAGE_SIZE = 9;
export const GUILD_MEMBER_PAGE_SIZE = 9;

/** CChannelPool::OnEnterChannelStage sentinel threshold — 0x3E6 (998).
 *  Native checks `if (idx > 0x3E6)` to decide lobby/connecting/invalid messages
 *  vs trying to dump the room (FxServer.exe.c:6306). Since max valid idx is 254,
 *  any idx >998 is definitely sentinel or invalid. */
export const SESSION_IDX_SENTINEL_THRESHOLD = 0x3e6;

/** The session dimension everywhere: 8 slots / 8 colours / 8 loss-matrix rows
 *  (the original loops the same 8-slot tables with plain do/while). */
export const MAX_SESSION_SLOTS = 8;

/** CGameContext fixed storage dimensions recovered from GameSession.cpp. */
export const GAME_CONTEXT_TILE_COLUMNS = 15;
export const GAME_CONTEXT_TILE_ROWS = 13;
export const GAME_CONTEXT_TILE_COUNT = GAME_CONTEXT_TILE_COLUMNS * GAME_CONTEXT_TILE_ROWS;
export const GAME_CONTEXT_BULA_COLUMNS = 45;
export const GAME_CONTEXT_BULA_ROWS = 26;
export const GAME_CONTEXT_BULA_COUNT = GAME_CONTEXT_BULA_COLUMNS * GAME_CONTEXT_BULA_ROWS;
export const GAME_CONTEXT_BOX_CAPACITY = 250;
export const GAME_CONTEXT_BOX_SERIAL_START = 126;
export const GAME_CONTEXT_BOMB_CAPACITY = 150;
export const GAME_CONTEXT_DIE_COORDS_PER_SLOT = 2;

/** CGameSession::OnRequestGenerateGhost — slot|0x80 marks a newly spawned ghost (vs transferred). */
export const GHOST_SLOT_NEW_FLAG = 0x80;
/** CGameSession::Update trapped-grace multi-die header — event 5 (server die) <<4 | slot 0 = 80. */
export const BOMBER_EVENT_MULTI_DIE_HEADER = 80;

/** CChatPool — native checks `len > 0x400` (1024) for too-long chat/item/shout messages. */
export const CHAT_MAX_PACKET_LEN = 0x400;

/** CPracticeSession — AI seats use bomber 5 and colour 7 (FxServer.exe.c:41745). */
export const PRACTICE_AI_BOMBER = 5;
export const PRACTICE_AI_COLOR = 7;
/** CPracticeSession — AI level range 1..31 (FxServer.exe.c:41745 / 425B4F). */
export const AI_LEVEL_MIN = 1;
export const AI_LEVEL_MAX = 31;

/** CListSession m_fModified bit flags — lobby 86 [E1 mask] + optional fields. */
export const SESSION_MODIFIED_PLAYING = 1;
export const SESSION_MODIFIED_MAP = 2;
export const SESSION_MODIFIED_CUR_PLAYER = 4;
export const SESSION_MODIFIED_MAX_PLAYER = 8;
export const SESSION_MODIFIED_TITLE = 0x10;

/** CBaseSession slot bit0 — closed (1 = closed). */
export const SLOTSTATE_CLOSED = 1;
export const SLOTSTATE_CLOSED_CLEAR = 0xfe; // ~CLOSED & 0xff
/** Clears chief + group bits (AddUserBase): ~(CHIEF|GROUP_MASK) with CHIEF=0x02, GROUP=0x1C => 0xE1. */
export const SLOTSTATE_CHIEF_GROUP_CLEAR = 0xe1;

/** CBaseSession::OnRequestChangeTitle — title longer than 0x16 (22) chars is truncated to 21. */
export const ROOM_TITLE_TRUNCATION_THRESHOLD = 0x16;
export const ROOM_TITLE_TRUNCATED_LENGTH = 21;

/** CGameSession random map color tracking — 0x11111111 marks a color in use (SetMapIdxPlayingByLevel). */
export const MAP_COLOR_IN_USE = 0x11111111;

/** CGameSession — max game duration before forced end (0x2BF20 = 180000 ms = 3 min). */
export const GAME_DURATION_LIMIT_MS = 0x2bf20;

/** CSyncGameObjMan — initial bestLoad for FindMinimumLoadSlotIdx (0x80000000 = large positive for min search). */
export const SYNC_BEST_LOAD_INIT = 0x80000000;

/** CGameSessionTable m_acTableFlags — lobby announce flags (timer sweep). */
export const SESSION_TABLE_FLAG_CREATED = 1;
export const SESSION_TABLE_FLAG_EXISTING = 2;
export const SESSION_TABLE_FLAG_DESTROYED = 4;

/** CGameSession::OnBombIgnite — attr byte 0x40 marks flag16 (server die? etc). */
export const BOMB_ATTR_FLAG16_MASK = 0x40;

/** CUser::HasAuthority codes — recovered from FXGS usage (FxServer.exe.c). */
export const AUTHORITY_JOIN_CLOSED = 1; // bypass closed slots / password (GM)
export const AUTHORITY_SHOUT = 7; // CChatPool::OnShoutMsg gate
export const AUTHORITY_BAN_IMMUNE = 21; // super chief ban bypass (operator)
export const AUTHORITY_BAN_CHIEF_BYPASS = 22; // DeferBanChief odd-slot and full-room bypass
export const AUTHORITY_LEVEL_BYPASS = 23; // CanStartGame level/premium bypass (GM)
export const AUTHORITY_SUPREME_CHIEF = 24; // AddPlayer sets new chief (RoomTicket holder path)
export const AUTHORITY_ALWAYS_ZERO = 25; // constant-0 stub, skipped in player counts

/** CGameSession::OnReqTakeHouse — 5 lucci per house taken. */
export const HOUSE_MONEY = 5;
/** CGameSession::OnReqTakeHouse — fixed byte 5 after house list in packet 161 res. */
export const HOUSE_PACKET_TAIL = 5;
