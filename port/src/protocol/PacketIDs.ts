import {
  DefinePacketNameTable,
  ResolvePacketName,
  TAIWAN_BILLING_OPCODE_BYTES,
  type PacketDescriptor,
  type PacketNameTable,
} from "./PacketNames.ts";

/**
 * PacketID (nPacketType) tables — the single enumeration point for every server.
 *
 * There is no kPacket* enum in the original PDBs; every number below was
 * audited out of the decompiled servers (CxLogin.exe.c / FxServer.exe.c /
 * FxShop.exe.c / CxUtil.exe.c / CxCenter.exe.c):
 *
 *   receive side = the literal `case` values of each pool's OnPacket dispatch
 *     — LS CLoginPool::OnPacket (CxLogin.exe.c:15254, cases 1-9/20/60/61),
 *     GS CChannelPool::OnPacket (FxServer.exe.c:6942; connect stage
 *     CConnectPool::OnPacket 10361; chat CChatPool::OnPacket 7297; in-session
 *     CGameSession::OnPacket 37668 for ids 96..189 via CBaseSessionTable
 *     vtbl+84), shop CMainPool::OnPacket (FxShop.exe.c:20547), util
 *     CMainPool::OnPacket (CxUtil.exe.c:21528);
 *
 *   send side = the second argument of every CSendPacket ctor / InitPacket
 *     call in each .c.  A ctor site whose packet is pushed through the
 *     CCenterProcess link (vtbl+68 on `this+4`) is NOT client-facing — those
 *     are the MC_* server→center ids and live in protocol/CenterProtocol.ts (CxCenter's own
 *     sends are the CM_* family).  LS 0/1/7/9/100, GS 1/3/4/7/9/10/11 and
 *     shop 2/3/9 all resolved to S2S this way.
 *
 * All client-facing servers share ONE type namespace per direction (a client
 * socket talks LS, GS, shop and util with the same type byte), so the same id
 * may appear in more than one server's tables — that is the protocol, not
 * duplication.  Within each table ids are sorted ascending; each entry names
 * the official handler/sender and its decompile site.
 *
 * Production packet constructors and dispatches must not repeat type literals
 * outside this file (or protocol/CenterProtocol.ts for MC/CM).  Numeric values remain only in
 * wire fixtures that independently pin these tables. PacketLog resolves id →
 * official name through each server's registrations; unknown ids stay `p<N>`
 * (asserted by test/packetlog.test.ts).
 *
 * NOTE on `new CSendPacket(PACKET_TYPE_PLACEHOLDER, deg)` sites: the zero
 * placeholder (the original CSendPacket ctor default) is not a wire id — the
 * real type is set by the follow-up InitPacket(GS_ClientSend.X) call.  Only
 * ctor sites whose argument IS the final wire id belong in these tables.
 *
 * Contents:
 *   1. LS   — login server: LS_ReceivedPacket / LS_SendPacket / LS_ClientSend
 *   2. GS   — game server lobby: GS_ReceivedPacket / GS_ClientSend
 *   3. SES  — in-room session: SESSION_ReceivedPacket / GS_ClientSend
 *   4. Shop — SS_ReceivedPacket / SC_SendPacket
 *   5. Util — UTIL_ClientReceivedPacket / UTIL_ClientSend
 *   6. BILL — billing link: TW/LocalBilling/Coupon packet contexts
 *   7. MON  — monitor console: MONITOR_ReceivedPacket / MONITOR_ClientSend
 *   8. PacketIdName — reverse lookup for logs/tests
 */

// ═══════════════════════════════ 1. LOGIN SERVER ═══════════════════════════════
// CLoginPool::OnPacket (CxLogin.exe.c:15254)
export const LS_ReceivedPacket = {
  OnAskMultiServer: 1,
  OnAskFirstInfo: 2,
  OnLogin: 3,
  OnNewUserConfirmId: 4,
  OnNewUser: 5,
  OnReqConnectToSvr: 6,
  OnConnEstablished: 7, // CLoginPool::OnConnEstablished — logs + disconnects
  OnCrashInfo: 8,
  OnRequestEnterChannelStage: 9,
  OnEstimateRTT: 20, // CUserPool::OnPacket → CUserPool::OnEstimateRTT
  OnRequestDestoryService: 60, // (official spelling)
  OnReplyDestoryService: 61,
} as const;

/**
 * LS → client responses (one per matching request id).
 * The channel-info family (10/11/13/14) is NOT here — the client never sends
 * a matching request id for those; they live in LS_ClientSend below.
 */
export const LS_SendPacket = {
  OnAskMultiServerRes: 1,
  OnAskFirstInfoRes: 2,
  OnLoginRes: 3,
  OnNewUserConfirmIdRes: 4,
  OnNewUserRes: 5,
  OnReqConnectToSvrRes: 6,
  OnEstimateRTTRes: 20,
  OnRequestDestoryServiceRes: 60,
} as const;

/** LS → client ids with no matching request id (CxLogin.exe.c send sites). */
export const LS_ClientSend = {
  OnConnect: 0, // CMainSystem::OnConnEstablished [E2 CENTER_VERSION][E2 CONN_HELLO_VERSION][E4 headerType][EStr url]
  OnNotice: 7, // CConfigDyn::GetNoticePacket [COSmartStream containing one EStr]
  OnChannelInfo: 10, // CChannelCache::MakeInfoPacket (24883) — [E1 full][OSstream]
  OnChannelsExtraInfo: 11, // CCenterProcess::MakeChannelsExtraInfoPacket (6414)
  OnChannelState: 13, // CChannelCache::MakeStatePacket (24737) — [E2 n][n×E2 users]
  OnChannelsGameState: 14, // CCenterProcess::MakeChannelsGameStatePacket (5925)
  OnSvrReservedMsg: 16, // CCenterProcess::OnSvrReservedMsg
  OnAdminNotifyMsg: 26,
  OnWhisper: 27, // CCenterProcess::OnWhisper (CxLogin.exe.c:5058) — relay to the target's socket [EStr]×5[E4]×3; no caller in CxCenter.exe.c (arrives via the S2S vtbl)
  OnSystemMsg: 30,
} as const;

// ═══════════════════════════ 2. GAME SERVER (lobby) ═══════════════════════════
// CChannelPool::OnPacket (FxServer.exe.c:6942) — the game-server lobby dispatch.
// Structure: 7 → CConnectPool::OnConnEstablished (CConnectPool::OnPacket
// FxServer.exe.c:10361 decodes E1==7, anything else falls through to
// CUserPool::OnPacket); the lobby ids below per CChannelPool::OnPacket;
// 96..189 → CBaseSessionTable vtbl+84 (CGameSession::OnPacket, FxServer.exe.c:37668);
// Unhandled lobby ids rewind into the CChatPool base dispatcher
// (FxServer.exe.c:7297: 25/26/27/29/30/31/71/216), whose tail rewinds again
// for CUserPool; 209 is handled directly by OnRequestUserInventory.  These
// are inheritance dispatches over the SAME wire opcode, not nested bytes.
export const GS_ReceivedPacket = {
  OnReqConnectToSvr: 6,
  OnConnEstablished: 7, // CConnectPool::OnConnEstablished
  OnReqChannelsState: 15,
  OnEnterChannelStage: 16,
  OnEstimateRTT: 20, // CUserPool::OnPacket (via CConnectPool::OnPacket)
  OnInviteUser: 28,
  OnGuildMarkRevision: 38,
  OnRequestUserSimpleInfo: 64,
  OnRequestMyInfo: 65,
  OnRequestModifyUserInfo: 66,
  OnRequestUserInfoDetail: 67,
  OnRequestSessionInfoDetail: 68,
  OnRequestUserLocation: 69,
  OnRequestGuildInfo: 70,
  OnCreateSession: 80, // CBaseSessionTable vtbl+52
  OnEnterSession: 81, // vtbl+64 (JoinSession)
  OnJoinFreeSession: 82, // vtbl+68 (JoinFreeSession)
  OnEnterLobbyStage: 83,
  OnRequestCreateGuildSession: 84, // vtbl+56 = CGameSessionTable::CreateSessionGuild
  OnRequestGuildMemberInfo: 85,
  OnRequestCreatePracticeSession: 86, // vtbl+60 = CGameSessionTable::CreateSessionPractice (the original log line misspells "PraticeSession")
  OnRequestUserInventory: 209,
} as const;

/** Client-facing packet IDs sent by the game server. */
export const GS_ClientSend = {
  OnConnect: 0, // CMainSystem::OnConnEstablished [E2 CENTER_VERSION][E2 CONN_HELLO_VERSION][E4 headerType][EStr url]
  OnReqConnectToSvrRes: 6, // FxServer 004036E6: both Center results and local CheckEnterGame refusals
  OnChannelsState: 13, // CCenterProcess::MakeChannelsStatePacket
  OnChannelsGameState: 14, // CCenterProcess::MakeChannelsGameStatePacket
  OnChannelAnnounce: 15, // the empty lobby announce (OnAddNewSocket / 83)
  OnSvrReservedMsg: 16, // CCenterProcess::OnSvrReservedMsg
  OnGuildBanRes: 17, // guild-table overflow on entry
  OnEstimateRTTRes: 20, // CUserPool::OnEstimateRTT
  OnChatMsg: 25, // lobby/in-session chat
  OnItemMsg: 25, // CChatPool::OnItemMsg shares the chat id
  OnKickoffUser: 26, // CGameSessionTable::KickImp "abnormal state…"
  OnAdminNotifyMsg: 26,
  OnWhisperRes: 27, // CChatPool::OnWhisper (to the receiver)
  OnWhisperFail: 28, // target absent: [E1 0][EStr name]
  OnInviteUser: 29,
  OnSystemMsg: 30,
  OnRequestUDPRelayRes: 54, // OnNotifyUDPLoss/OnRequestUDPRelay → the target [E1 senderSlot]
  OnRequestMyInfoRes: 64, // CChannelPool::OnRequestMyInfo
  OnRequestModifyUserInfoRes: 65, // CChannelPool::OnRequestModifyUserInfo [E1 result] (1 = ok, 0 = db failure)
  OnRequestGuildInfoRes: 66,
  OnGuildMemberListRes: 67, // CChannelPool::PutGuildMemberListPacket
  OnRequestUserSimpleInfoRes: 70, // CChannelPool::PutUserSimpleInfoPacket
  OnRequestUserInfoDetailRes: 71,
  OnRequestUserLocationRes: 72,
  OnShoutMsg: 74,
  OnCreateSessionRes: 80, // [E1 result][E2 idx][E4 serial][E1 gameType]
  OnJoinSessionRes: 81, // [E1 result]
  OnJoinFreeSessionRes: 82, // JoinFreeSession [E1 2] — the +1316 candidate list is never filled in FXGS
  OnSessionSimpleInfo: 83, // CListSession::MakeSimpleInfoPacket (room list)
  OnSessionInfoDetailRes: 84, // OnRequestSessionInfoDetail (68): [E1 0/1] + per-slot blocks [+E4 time]
  OnSessionCreated: 85, // CListSession::MakeCreatedPacket
  OnSessionModified: 86, // CListSession::MakeModifiedPacket
  OnSessionDestroyed: 87, // CListSession::MakeDestroyedPacket
  OnGuildSessionInfo: 88, // CGuildSessionStrategy::EncodeGuildSessionInfo
  OnPracticeSessionCreated: 89, // CGameSessionTable::DoCreatePracticeSession
  OnGameTypeMod: 92, // CGameSession::SendGameTypeMod (empty body)
  OnGameTypeNormal: 93, // CGameSession::SendGameTypeNormal (empty body)
  OnSetPlayer: 105, // CBaseSession::MakeSetPlayerPacket
  OnResetPlayer: 106, // CBaseSession::SendResetPlayer [E1 slot][E4 serial]
  OnSetSlotState: 107, // CBaseSession::MakeSetSlotStatePacket [E1 slot][EBuffer 3]
  OnSelectColorRes: 108, // CBaseSession::OnSelectColor [E1 (slot<<4)|color]
  OnSelectBomberRes: 109, // CBaseSession::OnSelectBomber [E1 (slot<<4)|bomber]
  OnOpenCloseSlotRes: 110, // CListSession::DoOpenCloseSlot [E1 (slot<<4)|closed]
  OnChangeAILevel: 111, // CPracticeSession::MakeChangeAILevelPacket
  OnSessionMapIdx: 112, // CGameSession::SendSessionInfoPacket tail [E2 mapIdx]
  OnBanVoteRequest: 113, // CListSession::OnHostAskBanPlayer [E4 serial][EStr name]
  OnBanPlayerRes: 114, // CListSession::DeferBanPlayer [E1 code][EStr name?]
  OnStartGameRes: 115, // CGameSession::OnRequestStartGame [E1 CanStartGame]
  OnStartGame: 116, // CGameSession::LaunchGameStage
  OnChangeTitle: 117, // CBaseSession::DoChangeTitle [EStr title]
  OnPlayEmotion: 118, // CBaseSession::OnPlayEmotion (SendPacketExclude self)
  OnUDPPeerInfo: 120, // CGameSession::OnUDPPeerInfo — the peer matrix broadcast
  // DeferBanChief: E1 stage 0/1 warning, 2/3 removal (ordinary/odd-slot); E2 warningSeconds (10 or SuperChief 30).
  OnNeedStartGame: 121,
  OnBangPok: 122, // CListSession::DoBangPok (empty body)
  OnStartGame2: 150, // CGameSession::DoStartGame [E4 seed][E4 seq][E4 ghostStartMs][E4 ghostFreqMs]
  OnSetBombTimerRes: 152, // CGameSession::Update tick [E1 n][n×(E2 bombId)(E1 kick)]
  OnBombIgniteRes: 153, // CGameSession::OnBombIgnite [E1 slot][E1 pos][E1 attr][E2 bombId]
  OnBombIgnite: 153, // official construction-site alias
  OnBombKickThrowRes: 154, // CGameSession::OnBombKickThrow [E1 slot][E2 bombId][E1 pos]
  OnMovableBoxMoveRes: 155, // CGameSession::OnMovableBoxMove [E1×4 relay]
  OnRequestEatItemRes: 156, // CGameSession::OnRequestEatItem [E1 slot][E1 box][E1 item](+lucci [E1 n])
  OnRequestEatObstacleRes: 157, // CGameSession::OnRequestEatObstacle [E1 slot][E1 pos]
  OnBomberEvent: 159, // CGameSession::OnSetBomberEvent/OnBomberDie relay
  OnBomberDie: 159, // official construction-site alias
  OnEffectRes: 160, // CGameSession::OnSetEffect [buffer relay]
  OnSetEffect: 160, // official construction-site alias
  OnDropObstacleRes: 161, // CGameSession::OnDropObstacle [E1 a][E1 pos]
  OnDropObstacle: 161, // official construction-site alias
  OnGameResult: 163, // CGameSession::SendGameResult (the results unit)
  OnReturnPrepareStage: 164, // CGameSession::DoReturnPrepareStage [E1 0]
  OnDestroyBoxRes: 165, // CGameSession::OnDestroyBox [E1×3 relay]
  OnDestroyBox: 165, // official construction-site alias
  OnGhostGenerate: 166, // CGameSession::OnRequestGenerateGhost [E1 ghost][E1 slot|0x80][E1 tag]
  OnGhostDestroy: 167, // OnRequestDestroyGhost/DealWithGhostOfLeavingPlayer [E1 ghost]
  OnLapInfoRes: 170, // CGameSession::OnLapInfo [E1 n][8×(E1 place][E1 laps)]
  OnLapInfo: 170, // official construction-site alias
  OnRequestAirplaneRes: 171, // CGameSession::OnRequestAirplane [E4 t][E1 n][n×(E1×4)]
  OnRequestAirplane: 171, // official construction-site alias
  OnItemThrowRes: 172, // CGameSession::OnItemThrow [E1×6 relay]
  OnAirplaneItemProb: 173, // CGameSession::SendAirplaneItemProb [E1 prob]
  OnObjCreate: 174, // CSyncGameObjMan::OnReqCreateObj [E2 id][E1 slot][E2 type][EBuffer 20]
  OnReqCreateObj: 174, // official construction-site alias
  OnObjInitial: 175, // CSyncGameObjMan::SetInitialObjNo [E2 id][E1 slot]
  OnObjDestroy: 176, // OnReqDestroyObj/OnPlayerLeave [E2 id][E4 crc]
  OnReqEatBulaRes: 177, // CGameSession::OnReqEatBula [E1 n][n×(E1 x][E1 y][E1 slot)]
  OnReqTakeHouseRes: 178, // CGameSession::OnReqTakeHouse [E1 slot][E1 n]…
  OnUdpLossBan: 195, // asm-only site in Update: empty body + stage=4 (UDP-loss kick)
  OnHackingKick: 196, // CGameSession::OnHackingSuspected [E1 slot]
  OnUserInventory: 201, // [E1 users][users×(E4 itemCount + inventory rows)]
  OnUserItemList: 202, // the whole FxItem table
  OnPreInventory: 207, // [E1 n][per-user pre-inventory]
  OnEnterGame: 210, // [E1 attr] — the entry-accepted packet
} as const;

// ═══════════════════════ 3. GAME SERVER (in-room session) ═══════════════════════
// CGameSession::OnPacket (FxServer.exe.c:37668) — in-room packets 96..189
export const SESSION_ReceivedPacket = {
  OnSetPlayerReady: 96,
  OnSelectMap: 97,
  OnSelectColor: 98, // CBaseSession::OnSelectColor
  OnSelectBomber: 99, // CListSession vtbl+120 → CBaseSession::OnSelectBomber
  OnOpenCloseSlot: 100, // CListSession::OnOpenCloseSlot
  OnSetGameTypeNormal: 102,
  OnSetGameTypeMod: 103,
  OnHostAskBanPlayer: 104, // CListSession::OnHostAskBanPlayer
  OnRespondToBanPlayer: 105,
  OnRequestStartGame: 106,
  OnRequestChangeTitle: 107, // CBaseSession
  OnPlayEmotion: 108, // CBaseSession
  OnReadyForImmediateStart: 109,
  OnRequestAILevelChange: 110, // CPracticeSession::OnRequestAILevelChange
  OnTeamChat: 111, // CListSession::OnTeamChat
  OnBombIgnite: 140,
  OnBombKickThrow: 141,
  OnSetBombTimer: 142,
  OnMovableBoxMove: 143,
  OnRequestEatItem: 144,
  OnRequestEatObstacle: 145,
  OnSetBomberEvent: 146,
  OnSetEffect: 147,
  OnDropObstacle: 148,
  OnEventItem: 149,
  OnDestroyBox: 150,
  OnRequestGenerateGhost: 151,
  OnRequestDestroyGhost: 152,
  OnLapFinished: 154,
  OnLapInfo: 155,
  OnRequestAirplane: 156,
  OnReqCreateObj: 158, // CSyncGameObjMan::OnReqCreateObj
  OnReqDestroyObj: 159,
  OnReqEatBula: 160,
  OnReqTakeHouse: 161,
  OnShobuari: 162,
  OnNotifyUDPLoss: 185,
  OnHackingSuspected: 186, // vtbl+164 → CGameSession::OnHackingSuspected
  OnNotifyUdpLossRegulator: 187, // CUdpLossRegulator::OnNotifyUdpLoss
} as const;

/** CChatPool's client → game-server receive subset.  CChannelPool rewinds the
 * same packet before calling this base-class dispatcher; there is no outer
 * chat wrapper and no second opcode byte. */
export const GS_ChatReceivedPacket = {
  OnChatMsg: 25,
  OnAdminNotifyMsg: 26,
  OnWhisper: 27,
  OnItemMsg: 29,
  OnKickoffUser: 30,
  OnSystemMsg: 31,
  OnShoutMsg: 71,
  OnSystemCmd: 216,
} as const;

// ═══════════════════════════════ 4. SHOP SERVER ═══════════════════════════════
// CMainPool::OnPacket (FxShop.exe.c:20547) — the FxShop client dispatch on the
// 9801 listener.  The type byte is the shared client namespace; the shop
// handles its own subset and forwards everything else to CUserPool::OnPacket
// (the 20 RTT fallback).
export const SS_ReceivedPacket = {
  OnReqConnectToSvr: 6,
  OnConnEstablished: 7, // CMainPool::OnConnEstablished
  OnEstimateRTT: 20, // CUserPool::OnPacket default branch
  RequestRemainCashTw: 205, // CBillingProcess::RequestRemainCashTw
  OnReqPurchase: 206, // CMainPool::OnReqPurchase → OnReqPurchaseStockItem
  OnRequestDeleteItem: 207,
  OnUserSlotInfo: 210,
  OnRequestModifyItemVerbose: 212,
  OnRequestShopItemList: 213,
  OnRequestCharge: 214,
  OnRequestStringTable: 215,
  OnRequestUserItemList: 217,
  OnRequestPresent: 218,
  OnRequestUseCoupon: 219,
  OnRequestPackageMap: 220,
  OnRequestCartList: 221,
  OnRequestAddCartList: 222,
  OnReqPurchaseCartList: 223,
  OnReqDigiQAuthorization: 224,
  OnRequestTranxData: 225,
  OnRequestShopSvrInfo: 226,
} as const;

// Shop → client packet types (every CSendPacket::CSendPacket / InitPacket on
// FxShop.exe.c).  The ids are the same shared namespace, read from the other
// direction: 200/205/213 are the cached CItemMan table packets.
export const SC_SendPacket = {
  OnConnect: 0, // CMainSystem::OnConnEstablished — [E2 CENTER_VERSION][E2 CONN_HELLO_VERSION][E4 headerType][EStr url]
  OnResConnectToSvr: 6, // CMainPool::OnCenterResConnectToSvr
  OnInitialInfo: 18, // CMainPool::OnCenterResConnEstablished — account + bonus map
  OnEstimateRTTRes: 20,
  OnAdminNotifyMsg: 26, // CCenterProcess::OnAdminNotifyMsg broadcast
  OnShopItemList: 200, // CItemMan cached packet (UpdateShopItemPacket)
  OnUserInventory: 201, // [E1 users][users×(E4 itemCount + inventory rows)]
  OnUserItemList: 202, // CItemMan::PutUserItemList (the FxItem table)
  OnRemainCashTw: 203, // CBillingProcess::OnRemainCashTw
  OnPurchaseRes: 204, // OnReqPurchaseStockItem / OnRequestPresent — [E1 code][EStr msg]
  OnStringTable: 205, // CItemMan cached packet (UpdateStringPacket)
  OnReqPurchaseRes: 206, // CMainPool::OnRequestCharge — [E1 attr][E4 sn][E4 cash]
  OnPreInventory: 207, // [E1 n][n×(nothing)] — CUser::MakePreInventoryPacket is empty
  OnUseCouponRes: 208, // CMainPool::OnRequestUseCoupon — [E1 code]
  OnDigiQAuthenRes: 209, // CBillingProcess::OnDigiQAuthen — [E1 12][E4][E4] then RequestRemainCashTw | [E1 13][EStr msg]
  OnTranxData: 211, // CMainPool::OnRequestTranxData
  OnShopSvrInfo: 212, // CCenterProcess::MakeShopInfoPacket — [E4 n][n×(E4 ip, E2 port)]
  OnPackageMap: 213, // CItemMan cached packet (UpdatePackageMapPacket)
  OnCartList: 214, // CMainPool::OnRequestCartList
  OnPurchaseCartListRes: 215, // CMainPool::PurchaseCartList tail — [E1 9][E1 0][EBuffer 8 variant time] to the user's socket
} as const;

// ═══════════════════════════════ 5. UTIL SERVER ═══════════════════════════════
// CMainPool::OnPacket (CxUtil.exe.c:21528) — the admin-tool relay.  Tools
// connect on the listen socket (the binary binds the literal 0x1FC0, ignoring
// cfg ServerPort), log their identities with packet 7 and everything else is
// relayed to the center.
export const UTIL_ClientReceivedPacket = {
  OnConnEstablished: 7, // [E1 n][n×(EStr name, E4 serial)]
  OnEstimateRTT: 20, // CUserPool::OnEstimateRTT — [E4 t] echoed back
  OnAdminNotifyMsg: 25, // → center MC 4 [EStr]
  OnAdminNotifyGameServerMsg: 26, // → center MC 5 [E1 type][EStr]
  OnSystemMsg: 31, // → center MC 10 [EStr]
  OnKickoffUser: 32, // → center MC 1 [EStr name]
  OnReqUserInfo: 64, // → center MC 7 [E4 serial][EStr account]
  OnUpdateItem: 66, // → center MC 11 [EStr "UpdateFxItem" iff the leading byte is 11]
} as const;

/** What the util sends its admin tools (all degree 0 — SetCipherDegree(0)). */
export const UTIL_ClientSend = {
  OnConnect: 0, // CMainSystem::OnConnEstablished [E2 CENTER_VERSION][E2 CONN_HELLO_VERSION][E4 headerType][EStr url]
  OnEstimateRTTRes: 20, // CUserPool::OnEstimateRTT
  OnAdminNotifyMsg: 26, // CCenterProcess::OnAdminNotifyMsg rebroadcast
  OnUserDetailInfo: 64, // CMainPool::SendUserDetailInfo [E1 n][E4 n2]
} as const;

// ══════════════════════════ 6. SHOP ↔ BILLING LINK ══════════════════════════
// CBillingSocketTw carries several opcode contexts.  They must not be merged:
// Taiwan's outer opcode is E4; Billing/Coupon are [E1 family][E1 opcode].

/** BNB_TAIWAN's leading E1 family for the two legacy nested contexts. */
export const BNB_TAIWAN_PacketFamily = {
  Billing: 0,
  Coupon: 1,
} as const;
export const BILLING_PACKET_LOG_CONTEXT = {
  Taiwan: "BILL",
  Billing: "BILLING",
  Coupon: "COUPON",
} as const;

/** FxShop → Taiwan billing E4 requests. */
export const TW_BILLING_SendPacket = {
  RequestRemainCashTw: 301,
  RequestPurchaseTw: 311,
  PurchaseConfirmTw: 321,
  OnConnEstablished: 331,
  RequestDigiQAuthorization: 341,
  TwRequestRTT: 351,
} as const;

/** Taiwan billing → FxShop E4 replies. */
export const TW_BILLING_ReceivedPacket = {
  OnRemainCashTw: 302,
  OnPurchaseOKTw: 312,
  OnPurchaseConfirmTw: 322,
  OnDigiQAuthen: 342,
  OnTwRTT: 352,
} as const;

/** BNB_TAIWAN::enBillingPacket requests: [E1 family=0][E1 opcode]. */
export const BILLING_SendPacket = {
  RequestGift: 7,
} as const;

/** This build has no active enBillingPacket receive dispatch.  Its dormant
 * handler opcodes are not inferred from function names. */

/** BNB_TAIWAN::enCouponPacket requests: [E1 family=1][E1 opcode].
 * Coupon reply opcodes are not retained by this binary and are intentionally
 * not guessed or dispatched. */
export const COUPON_SendPacket = {
  RequestCheckCoupon: 0,
  RequestUseCoupon: 1,
} as const;

// ═══════════════════════════ 7. MONITOR CONSOLE ═══════════════════════════
// CMonitorSocket::OnPacket (center) — operator console protocol.  The reply
// reuses the request's id (the dispatch reads the id back off the reply).
export const MONITOR_ReceivedPacket = {
  OnRequestCurrentUserStat: 0,
  OnRequestSvrState: 1,
} as const;

export const MONITOR_ClientSend = {
  OnRequestCurrentUserStat: 0, // [E4 current][E4 dailyPeak]
  OnRequestSvrState: 1, // [E4 n][n×(E1 class, E2 index, EStr name, E4 connNo)]
} as const;

// ═══════════════════════════════ 8. TYPED REGISTRY ═══════════════════════════════

export const LS_CLIENT_RECEIVED_NAMES = DefinePacketNameTable(
  "enGeneralServerPacket", "CxLogin::CLoginPool", "client-to-server", LS_ReceivedPacket,
  { credentials: ["OnLogin", "OnNewUserConfirmId", "OnNewUser"] },
);
export const LS_CLIENT_SEND_NAMES = DefinePacketNameTable(
  "enGeneralServerPacket", "CxLogin", "server-to-client", { ...LS_SendPacket, ...LS_ClientSend },
);
export const GS_CLIENT_RECEIVED_NAMES = DefinePacketNameTable(
  "enGameServerPacket", "FxServer::CChannelPool", "client-to-server", GS_ReceivedPacket,
);
export const GS_SESSION_RECEIVED_NAMES = DefinePacketNameTable(
  "enGameServerPacket", "FxServer::CGameSession", "client-to-server", SESSION_ReceivedPacket,
);
export const GS_CHAT_RECEIVED_NAMES = DefinePacketNameTable(
  "enGameServerPacket", "FxServer::CChatPool", "client-to-server", GS_ChatReceivedPacket,
);
export const GS_CLIENT_SEND_NAMES = DefinePacketNameTable(
  "enGameServerPacket", "FxServer", "server-to-client", GS_ClientSend,
  { canonical: {
    [GS_ClientSend.OnChatMsg]: "OnChatMsg",
    [GS_ClientSend.OnKickoffUser]: "OnKickoffUser",
    [GS_ClientSend.OnBombIgniteRes]: "OnBombIgniteRes",
    [GS_ClientSend.OnBomberEvent]: "OnBomberEvent",
    [GS_ClientSend.OnEffectRes]: "OnEffectRes",
    [GS_ClientSend.OnDropObstacleRes]: "OnDropObstacleRes",
    [GS_ClientSend.OnDestroyBoxRes]: "OnDestroyBoxRes",
    [GS_ClientSend.OnLapInfoRes]: "OnLapInfoRes",
    [GS_ClientSend.OnRequestAirplaneRes]: "OnRequestAirplaneRes",
    [GS_ClientSend.OnObjCreate]: "OnObjCreate",
  } },
);
export const SHOP_CLIENT_RECEIVED_NAMES = DefinePacketNameTable(
  "enGeneralServerPacket", "FxShop::CMainPool", "client-to-server", SS_ReceivedPacket,
  { credentials: ["OnReqDigiQAuthorization"] },
);
export const SHOP_CLIENT_SEND_NAMES = DefinePacketNameTable(
  "enGeneralServerPacket", "FxShop", "server-to-client", SC_SendPacket,
);
export const UTIL_CLIENT_RECEIVED_NAMES = DefinePacketNameTable(
  "enGeneralServerPacket", "CxUtil::CMainPool", "client-to-server", UTIL_ClientReceivedPacket,
);
export const UTIL_CLIENT_SEND_NAMES = DefinePacketNameTable(
  "enGeneralServerPacket", "CxUtil", "server-to-client", UTIL_ClientSend,
);
export const TW_BILLING_SEND_NAMES = DefinePacketNameTable(
  "enGeneralServerPacket", "FxShop::CBillingSocketTw", "shop-to-billing", TW_BILLING_SendPacket,
  { credentials: ["RequestDigiQAuthorization"], opcodeBytes: TAIWAN_BILLING_OPCODE_BYTES },
);
export const TW_BILLING_RECEIVED_NAMES = DefinePacketNameTable(
  "enGeneralServerPacket", "FxShop::CBillingSocketTw", "billing-to-shop", TW_BILLING_ReceivedPacket,
  { opcodeBytes: TAIWAN_BILLING_OPCODE_BYTES },
);
export const BILLING_SEND_NAMES = DefinePacketNameTable(
  "enBillingPacket", "BNB_TAIWAN::enBillingPacket", "shop-to-billing", BILLING_SendPacket,
);
export const COUPON_SEND_NAMES = DefinePacketNameTable(
  "enCouponPacket", "BNB_TAIWAN::enCouponPacket", "shop-to-billing", COUPON_SendPacket,
  { credentials: ["RequestCheckCoupon", "RequestUseCoupon"] },
);
export const MONITOR_RECEIVED_NAMES = DefinePacketNameTable(
  "enMonitorPacket", "CxCenter::CMonitorSocket", "monitor-to-center", MONITOR_ReceivedPacket,
);
export const MONITOR_SEND_NAMES = DefinePacketNameTable(
  "enMonitorPacket", "CxCenter::CMonitorSocket", "center-to-monitor", MONITOR_ClientSend,
);

/** Registries keyed exactly like PacketLog's socket log-table tags. */
export const PACKET_NAME_TABLES: Readonly<Record<string, {
  readonly recv: readonly PacketNameTable[];
  readonly send: readonly PacketNameTable[];
}>> = {
  LS: { recv: [LS_CLIENT_RECEIVED_NAMES], send: [LS_CLIENT_SEND_NAMES] },
  GS: {
    recv: [GS_CLIENT_RECEIVED_NAMES, GS_CHAT_RECEIVED_NAMES, GS_SESSION_RECEIVED_NAMES],
    send: [GS_CLIENT_SEND_NAMES],
  },
  Shop: { recv: [SHOP_CLIENT_RECEIVED_NAMES], send: [SHOP_CLIENT_SEND_NAMES] },
  FXUS: { recv: [UTIL_CLIENT_RECEIVED_NAMES], send: [UTIL_CLIENT_SEND_NAMES] },
  BILL: { recv: [TW_BILLING_RECEIVED_NAMES], send: [TW_BILLING_SEND_NAMES] },
  LOCALBILL: { recv: [TW_BILLING_SEND_NAMES], send: [TW_BILLING_RECEIVED_NAMES] },
  BILLING: { recv: [], send: [BILLING_SEND_NAMES] },
  COUPON: { recv: [], send: [COUPON_SEND_NAMES] },
  MON: { recv: [MONITOR_RECEIVED_NAMES], send: [MONITOR_SEND_NAMES] },
};

/** Context-bound reverse lookup; no family/direction/context information is lost. */
export function PacketIdDescriptor(
  tableKey: string,
  dir: "recv" | "send",
  id: number,
): PacketDescriptor | null {
  for (const table of PACKET_NAME_TABLES[tableKey]?.[dir] ?? []) {
    const descriptor = ResolvePacketName(table, id);
    if (descriptor !== null) return descriptor;
  }
  return null;
}

/** Canonical name lookup for logs and diagnostics. */
export function PacketIdName(tableKey: string, dir: "recv" | "send", id: number): string | null {
  return PacketIdDescriptor(tableKey, dir, id)?.canonicalName ?? null;
}

/** Client-facing socket crypto constants — CxLogin.exe.lst:4098B6
 *  / FxServer.exe.lst:407D19. SetHeaderCode(rcv=0xC0, snd=0x66, mod=0xE7);
 *  SetSequence(40, 40, 3, 3) = the sequence starts at 40 and rolls by 3. */
export const CLIENTSOCKET_HEADER_CODE_RCV = 192; // 0xC0
export const CLIENTSOCKET_HEADER_CODE_SND = 102; // 0x66
export const CLIENTSOCKET_HEADER_CODE_MODIFIER = 231; // 0xE7
export const CLIENTSOCKET_SEQ = 40;
export const CLIENTSOCKET_SEQ_DELTA = 3;
