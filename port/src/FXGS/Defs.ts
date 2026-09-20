/** FXGS shared constants — the slot-state bit fields, the session-idx
 *  sentinels and the timing/hash values, named once for the whole unit. */

/** MainSystem+8 — the channel types the GS behaviour keys on (the Center
 *  cfg's FXGSTypeN values; 77 = the guild channel). */
export const CHANNEL_TYPE_GUILD = 77;
/** …99 (cfg FXGSType4) is the accounting-log gate: SendGameResult's three
 *  exp/win/lose Reports only print on that channel type. */
export const ACCOUNTING_LOG_CHANNEL_TYPE = 99;
/** the off-screen (x,y) pair the 80 death report carries for a bomber killed
 *  by a trap or by the UDP-loss sweep (:33026, two Encode2(9999)). */
export const DEATH_COORD = 9999;
/** the map-template version floor — the loader clamps file dwords < 1000 up
 *  to it (CGameMapTmplList::Load). */
export const MAP_VERSION_MIN = 1000;
/** negative map indexes pick the theme table counting down from here
 *  (CGameMapTmplList dword 321 = the m_apTheme base). */
export const THEME_IDX_BASE = 321;
/** the original stamps are 32-bit GetTickCount() values; Date.now() is
 *  truncated to the same width before it goes on the wire or into a field. */
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
/** CUser::DeferFlushModifiedInfo — burst flush threshold (0x19). */
export const DYN_FLUSH_BURST = 0x19;

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
/** The result head's view-type byte lives on the strategy now — the base
 *  returns 0, the guild variant 1 (see CGameSessionStrategy above). */
/** CGameSession::IsLadderGame (4209A6: xor eax,eax) — the SendGameResult head
 *  byte is hardwired 0 in this build. */
export const IS_LADDER_GAME = 0;
/** asc_48F568 (EUC-KR) — "[\xbe\xcb\xb8\xb2] %s ..." = "[Notification] %s has obtained 100x the luck of experience in the premium channel."
 *  (SendGameResult → SendBigLuckMsg; GetWinExp never sets the trigger flag). */
export const STR_BIG_LUCK_MSG = "\x5b\xbe\xcb\xb8\xb2\x5d\x20\x25\x73\x20\xb4\xd4\xb2\xb2\xbc\xad\x20\xc7\xc1\xb8\xae\xb9\xcc\xbe\xf6\x20\xc3\xa4\xb3\xce\xbf\xa1\xbc\xad\x20\xb0\xe6\xc7\xe8\xc4\xa1\x20\x31\x30\x30\xb9\xe8\xc0\xc7\x20\xc7\xe0\xbf\xee\xc0\xbb\x20\xbe\xf2\xc0\xb8\xbc\xcc\xbd\xc0\xb4\xcf\xb4\xd9\x2e";

/** The session dimension everywhere: 8 slots / 8 colours / 8 loss-matrix rows
 *  (the original loops the same 8-slot tables with plain do/while). */
export const MAX_SESSION_SLOTS = 8;
