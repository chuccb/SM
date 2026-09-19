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
 *     are the MC_* server→center ids and live in lib/S2S.ts (CxCenter's own
 *     sends are the CM_* family).  LS 0/1/7/9/100, GS 1/3/4/7/9/10/11 and
 *     shop 2/3/9 all resolved to S2S this way.
 *
 * All client-facing servers share ONE type namespace per direction (a client
 * socket talks LS, GS, shop and util with the same type byte), so the same id
 * may appear in more than one server's tables — that is the protocol, not
 * duplication.  Within each table ids are sorted ascending; each entry names
 * the official handler/sender and its decompile site.
 *
 * Packet-type literals are forbidden outside this file (and lib/S2S.ts for
 * the MC-star / CM-star server-to-server families).  PacketLog resolves
 * id → official name through the Register() calls in each server's main; the
 * fallback for an unknown id stays p⌐N¬ (asserted by test/packetlog.test.ts).
 *
 * NOTE on `new CSendPacket(0, deg)` sites: 0 is the reusable-container
 * placeholder (the original CSendPacket ctor default), not a wire id — the
 * real type is set by the follow-up InitPacket(GS_ClientSend.X) call.  Only
 * ctor sites whose argument IS the final wire id belong in these tables.
 *
 * Contents:
 *   1. LS   — login server: LS_ReceivedPacket / LS_SendPacket / LS_ClientSend
 *   2. GS   — game server lobby: GS_ReceivedPacket / GS_ClientSend
 *   3. SES  — in-room session: SESSION_ReceivedPacket / GS_INPLAY_SendInventory
 *   4. Shop — SS_ReceivedPacket / SC_SendPacket
 *   5. Util — US_ReceivedPacket / UTIL_ClientPacket / UTIL_ClientSend
 *   6. BILL — billing link: BILLING_SendPacket / BILLING_ReceivedPacket
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
// 208 → CChatPool::OnPacket (FxServer.exe.c:7297 — chat subtypes 25/26/27/28/
// 30/31/71/74/216, tail always CUserPool::OnPacket); 209 → OnRequestUserInventory.
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
  OnRequestSessionList: 84, // vtbl+56
  OnRequestGuildMemberInfo: 85,
  OnJoinSession: 86, // vtbl+60
  Chat: 208, // explicit case → ResetOffset + CChatPool::OnPacket
  OnRequestUserInventory: 209,
} as const;

/** Client-facing packet ids only the game server sends. */
export const GS_ClientSend = {
  OnConnect: 0, // CMainSystem::OnConnEstablished [E2 CENTER_VERSION][E2 CONN_HELLO_VERSION][E4 headerType][EStr url]
  OnReqConnectToSvrRes: 2, // CM 1 success path: [E1 1][E1 type][E4 idx][E4 ip][E2 port]
  OnReqConnectToSvrFail: 6, // CheckEnterGame failure code
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
  OnShoutMsg: 74,
  OnRequestMyInfoRes: 64, // CChannelPool::OnRequestMyInfo
  OnRequestModifyUserInfoRes: 65, // CChannelPool::OnRequestModifyUserInfo [E1 result] (1 = ok, 0 = db failure)
  OnRequestGuildInfoRes: 66,
  OnGuildMemberListRes: 67, // CChannelPool::PutGuildMemberListPacket
  OnRequestUserInfoDetailRes: 71,
  OnRequestUserLocationRes: 72,
  OnRequestUserSimpleInfoRes: 70, // CChannelPool::PutUserSimpleInfoPacket
  OnCreateSessionRes: 80, // [E1 result][E2 idx][E4 serial][E1 gameType]
  OnJoinSessionRes: 81, // [E1 result]
  OnSessionSimpleInfo: 83, // CListSession::MakeSimpleInfoPacket (room list)
  OnSessionCreated: 85, // CListSession::MakeCreatedPacket
  OnSessionModified: 86, // CListSession::MakeModifiedPacket
  OnSessionDestroyed: 87, // CListSession::MakeDestroyedPacket
  OnGameTypeMod: 92, // CGameSession::SendGameTypeMod (empty body)
  OnGameTypeNormal: 93, // CGameSession::SendGameTypeNormal (empty body)
  OnSetPlayer: 105, // CBaseSession::MakeSetPlayerPacket
  OnResetPlayer: 106, // CBaseSession::SendResetPlayer [E1 slot][E4 serial]
  OnSetSlotState: 107, // CBaseSession::MakeSetSlotStatePacket [E1 slot][EBuffer 3]
  OnSelectColorRes: 108, // CBaseSession::OnSelectColor [E1 (slot<<4)|color]
  OnSelectBomberRes: 109, // CBaseSession::OnSelectBomber [E1 (slot<<4)|bomber]
  OnOpenCloseSlotRes: 110, // CListSession::DoOpenCloseSlot [E1 (slot<<4)|closed]
  OnSessionMapIdx: 112, // CGameSession::SendSessionInfoPacket tail [E2 mapIdx]
  OnBanVoteRequest: 113, // CListSession::OnHostAskBanPlayer [E4 serial][EStr name]
  OnBanPlayerRes: 114, // CListSession::DeferBanPlayer [E1 code][EStr name?]
  OnStartGameRes: 115, // CGameSession::OnRequestStartGame [E1 CanStartGame]
  OnStartGame: 116, // CGameSession::LaunchGameStage
  OnChangeTitle: 117, // CBaseSession::DoChangeTitle [EStr title]
  OnPlayEmotion: 118, // CBaseSession::OnPlayEmotion (SendPacketExclude self)
  OnNeedStartGame: 121, // CGameSession::DeferBanChief [E1 0/1/2/3][E2 seconds]
  OnUDPPeerInfo: 120, // CGameSession::OnUDPPeerInfo — the peer matrix broadcast
  OnBangPok: 122, // CListSession::DoBangPok (empty body)
  OnStartGame2: 150, // CGameSession::DoStartGame [E4 seed][E4 seq][E4 ghostStartMs][E4 ghostFreqMs]
  OnSetBombTimerRes: 152, // CGameSession::Update tick [E1 n][n×(E2 bombId)(E1 kick)]
  OnBombIgniteRes: 153, // CGameSession::OnBombIgnite [E1 slot][E1 pos][E1 attr][E2 bombId]
  OnBombKickThrowRes: 154, // CGameSession::OnBombKickThrow [E1 slot][E2 bombId][E1 pos]
  OnMovableBoxMoveRes: 155, // CGameSession::OnMovableBoxMove [E1×4 relay]
  OnRequestEatItemRes: 156, // CGameSession::OnRequestEatItem [E1 slot][E1 box][E1 item](+lucci [E1 n])
  OnRequestEatObstacleRes: 157, // CGameSession::OnRequestEatObstacle [E1 slot][E1 pos]
  OnBomberEvent: 159, // CGameSession::OnSetBomberEvent/OnBomberDie relay
  OnEffectRes: 160, // CGameSession::OnSetEffect [buffer relay]
  OnDropObstacleRes: 161, // CGameSession::OnDropObstacle [E1 a][E1 pos]
  OnGameResult: 163, // CGameSession::SendGameResult (the results unit)
  OnReturnPrepareStage: 164, // CGameSession::DoReturnPrepareStage [E1 0]
  OnDestroyBoxRes: 165, // CGameSession::OnDestroyBox [E1×3 relay]
  OnGhostGenerate: 166, // CGameSession::OnRequestGenerateGhost [E1 ghost][E1 slot|0x80][E1 tag]
  OnGhostDestroy: 167, // OnRequestDestroyGhost/DealWithGhostOfLeavingPlayer [E1 ghost]
  OnLapInfoRes: 170, // CGameSession::OnLapInfo [E1 n][8×(E1 place][E1 laps)]
  OnRequestAirplaneRes: 171, // CGameSession::OnRequestAirplane [E4 t][E1 n][n×(E1×4)]
  OnItemThrowRes: 172, // CGameSession::OnItemThrow [E1×6 relay]
  OnAirplaneItemProb: 173, // CGameSession::SendAirplaneItemProb [E1 prob]
  OnObjCreate: 174, // CSyncGameObjMan::OnReqCreateObj [E2 id][E1 slot][E2 type][EBuffer 20]
  OnObjInitial: 175, // CSyncGameObjMan::SetInitialObjNo [E2 id][E1 slot]
  OnObjDestroy: 176, // OnReqDestroyObj/OnPlayerLeave [E2 id][E4 crc]
  OnReqEatBulaRes: 177, // CGameSession::OnReqEatBula [E1 n][n×(E1 x][E1 y][E1 slot)]
  OnReqTakeHouseRes: 178, // CGameSession::OnReqTakeHouse [E1 slot][E1 n]…
  OnUdpLossBan: 195, // asm-only site in Update: empty body + stage=4 (UDP-loss kick)
  OnHackingKick: 196, // CGameSession::OnHackingSuspected [E1 slot]
  OnUserInventory: 201, // [E1 n][per-user inventory]
  OnUserItemList: 202, // the whole FxItem table
  OnPreInventory: 207, // [E1 n][per-user pre-inventory]
  OnEnterGame: 210, // [E1 attr] — the entry-accepted packet
  OnRequestUDPRelayRes: 54, // OnNotifyUDPLoss/OnRequestUDPRelay → the target [E1 senderSlot]
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

/**
 * Ctor-verified send ids of the in-play strategies (FxServer.exe.c
 * CSendPacket/InitPacket audit) — the strategy unit implements these; they are
 * listed here so the namespace stays enumerable in one place.  Each entry is
 * the enclosing (official) handler name of the construction site.
 */
export const GS_INPLAY_SendInventory = {
  OnChangeAILevel: 111, // CPracticeSession::MakeChangeAILevelPacket (InitPacket)
  OnGuildSessionInfo: 88, // CGuildSessionStrategy::EncodeGuildSessionInfo (InitPacket)
  OnPracticeSessionCreated: 89, // CGameSessionTable::DoCreatePracticeSession (3 sites)
  OnBombIgnite: 153, // CGameSession::OnBombIgnite (InitPacket)
  OnBomberDie: 159, // CGameSession::OnBomberDie
  OnSetEffect: 160, // CGameSession::OnSetEffect
  OnDropObstacle: 161, // CGameSession::OnDropObstacle
  OnDestroyBox: 165, // CGameSession::OnDestroyBox
  OnLapInfo: 170, // CGameSession::OnLapInfo
  OnRequestAirplane: 171, // CGameSession::OnRequestAirplane
  OnReqCreateObj: 174, // CSyncGameObjMan::OnReqCreateObj
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
  OnUserInventory: 201, // CUser::MakeUserInventoryPacket
  OnUserItemList: 202, // CItemMan::PutUserItemList (the FxItem table)
  OnRemainCash: 203, // CBillingProcess::OnRemainCashTw
  OnPurchaseRes: 204, // OnReqPurchaseStockItem / OnRequestPresent — [E1 code][EStr msg]
  OnStringTable: 205, // CItemMan cached packet (UpdateStringPacket)
  OnReqPurchaseRes: 206, // CMainPool::OnRequestCharge — [E1 attr][E4 sn][E4 cash]
  OnPreInventory: 207, // [E1 n][n×(nothing)] — CUser::MakePreInventoryPacket is empty
  OnUseCouponRes: 208, // CMainPool::OnRequestUseCoupon — [E1 code]
  OnDigiQAuthenRes: 209, // CBillingProcess::OnDigiQAuthen — [E1 12][E4][E4] then RequestRemainCashTw | [E1 13][EStr msg] (billing stub path)
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
export const US_ReceivedPacket = {
  OnConnEstablished: 3,
  OnAdminNotifyMsg: 4,
  OnAdminNotifyGameServerMsg: 5,
  OnSystemMsg: 10,
  OnKickoffUser: 12,
  OnReqUserInfo: 13,
  OnUpdateItem: 14,
  OnEstimateRTT: 20, // CUserPool::OnPacket
} as const;

/** The util relays these to the center (degree 0 links). */
export const UTIL_ClientPacket = {
  OnConnEstablished: 7, // CMainPool::OnConnEstablished [E1 n][n×(EStr name, E4 serial)]
  OnAdminNotifyMsg: 25, // → center MC 4 [EStr]
  OnAdminNotifyGameServerMsg: 26, // → center MC 5 [E1 type][EStr]
  OnSystemMsg: 31, // → center MC 10 [EStr]
  OnKickoffUser: 32, // → center MC 1 [EStr name]
  OnReqUserInfo: 64, // → center MC 7 [E4 serial][EStr account]
  OnUpdateItem: 66, // → center MC 11 [EStr "UpdateFxItem" iff the leading byte is 11]
  OnEstimateRTT: 20, // CUserPool::OnEstimateRTT — [E4 t] echoed back
} as const;

/** What the util sends its admin tools (all degree 0 — SetCipherDegree(0)). */
export const UTIL_ClientSend = {
  OnConnect: 0, // CMainSystem::OnConnEstablished [E2 CENTER_VERSION][E2 CONN_HELLO_VERSION][E4 headerType][EStr url]
  OnEstimateRTTRes: 20, // CUserPool::OnEstimateRTT
  OnAdminNotifyMsg: 26, // CCenterProcess::OnAdminNotifyMsg rebroadcast
  OnUserDetailInfo: 64, // CMainPool::SendUserDetailInfo [E1 n][E4 n2]
} as const;

// ══════════════════════════ 6. SHOP ↔ BILLING LINK ══════════════════════════
// The shop ↔ digicell billing link (CBillingSocketTw).  Request ids encode the
// Tw flow (…01 = request, …2 = response); the dispatch decodes an E4 type.
/** Shop → billing server (CBillingProcess senders; FxShop.exe.c).  The ctor's
 *  degree-4 arg clamps to 0, so every billing send is plain with an E1 type. */
export const BILLING_SendPacket = {
  RequestCheckCoupon: 0, // CBillingProcess::RequestCheckCoupon (1844)
  RequestUseCoupon: 1, // CBillingProcess::RequestUseCoupon (1905)
  RequestGift: 7, // CBillingProcess::RequestGift (1751)
  RequestRemainCashTw: 301, // CBillingProcess::RequestRemainCashTw (00402690)
  RequestPurchaseTw: 311, // CBillingProcess::RequestPurchaseTw (00402860)
  PurchaseConfirmTw: 321, // sent by CBillingProcess::OnPurchaseOKTw (00403C80)
  OnConnEstablished: 331, // CBillingProcess::ConnectToSvr hello (004015F0)
  RequestDigiQAuthorization: 341, // CBillingProcess::RequestDigiQAuthorization (00401DF0)
  TwRequestRTT: 351, // CBillingProcess::TwRequestRTT (00401030)
} as const;

export const BILLING_ReceivedPacket = {
  OnRemainCashTw: 302,
  OnPurchaseOKTw: 312,
  OnPurchaseConfirmTw: 322,
  OnDigiQAuthen: 342,
  OnEstimateRTT: 352,
} as const;

// ═══════════════════════════ 7. MONITOR CONSOLE ═══════════════════════════
// CMonitorSocket::OnPacket (center) — operator console protocol.  The reply
// reuses the request's id (the dispatch reads the id back off the reply).
export const MONITOR_ReceivedPacket = {
  OnRequestCurrentUserStat: 1,
  OnRequestSvrState: 2,
} as const;

export const MONITOR_ClientSend = {
  OnRequestCurrentUserStat: 1, // [E4 current][E4 max]
  OnRequestSvrState: 2, // [E1 n][n×svr rows]
} as const;

// ═══════════════════════════════ 8. REVERSE LOOKUP ═══════════════════════════════

/** All client-facing name tables, keyed the way PacketLog.Register keys them. */
export const PACKET_NAME_TABLES: Record<string, { recv: PacketNameTable[]; send: PacketNameTable[] }> = {
  LS: { recv: [LS_ReceivedPacket], send: [LS_SendPacket, LS_ClientSend] },
  GS: { recv: [GS_ReceivedPacket, SESSION_ReceivedPacket], send: [GS_ClientSend] },
  Shop: { recv: [SS_ReceivedPacket], send: [SC_SendPacket] },
  FXUS: { recv: [US_ReceivedPacket], send: [UTIL_ClientSend] },
  BILL: { recv: [BILLING_ReceivedPacket], send: [BILLING_SendPacket] },
  Center: { recv: [MONITOR_ReceivedPacket], send: [MONITOR_ClientSend] },
};

/** id → official handler name for a server key/dir; null when unregistered. */
export function PacketIdName(tableKey: string, dir: "recv" | "send", id: number): string | null {
  const tables = PACKET_NAME_TABLES[tableKey]?.[dir];
  if (!tables) return null;
  for (const t of tables) for (const name of Object.keys(t)) if (t[name as keyof typeof t] === id) return name;
  return null;
}

/** Any object whose values are packet ids (structural, to avoid an import cycle). */
export type PacketNameTable = Record<string, number>;

/** Client-facing socket crypto constants — CxLogin.exe.lst:4098B6
 *  / FxServer.exe.lst:407D19. SetHeaderCode(rcv=0xC0, snd=0x66, mod=0xE7);
 *  SetSequence(40, 40, 3, 3) = the sequence starts at 40 and rolls by 3. */
export const CLIENTSOCKET_HEADER_CODE_RCV = 192; // 0xC0
export const CLIENTSOCKET_HEADER_CODE_SND = 102; // 0x66
export const CLIENTSOCKET_HEADER_CODE_MODIFIER = 231; // 0xE7
export const CLIENTSOCKET_SEQ = 40;
export const CLIENTSOCKET_SEQ_DELTA = 3;
