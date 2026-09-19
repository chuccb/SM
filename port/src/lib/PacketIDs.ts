/**
 * Client-facing packet IDs — the single enumeration point for every server.
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
 *     vtbl+84), shop CMainPool::OnPacket, util CMainPool::OnPacket 21528;
 *
 *   send side = the second argument of every CSendPacket ctor / InitPacket
 *     call in each .c.  A ctor site whose packet is pushed through the
 *     CCenterProcess link (vtbl+68 on `this+4`) is NOT client-facing — those
 *     are the MC_* server→center ids and live in lib/S2S.ts (CxCenter's own
 *     sends are the CM_* family).  LS 0/1/7/9/100, GS 1/3/4/7/9/10/11 and
 *     shop 2/3/9 all resolved to S2S this way.
 *
 * One shared namespace per direction; each server handles its own subset.
 * Handler names are the official ones.  GS ids owned by the in-play
 * strategies that are not implemented yet are inventoried in
 * GS_INPLAY_SendInventory below; the billing-dependent shop replies (209)
 * are marked as stub paths.
 */

// ===================== client → login/game/shop/util servers =====================
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

// CChannelPool::OnPacket (FxServer.exe.c:6942) — the game-server lobby dispatch.
// Structure: 7 → CConnectPool::OnConnEstablished (CConnectPool::OnPacket
// FxServer.exe.c:10361 decodes E1==7, anything else falls through to
// CUserPool::OnPacket); the lobby ids below per CChannelPool::OnPacket;
// 96..189 → CBaseSessionTable vtbl+84 (CGameSession::OnPacket, FxServer.exe.c:37668);
// 208 → CChatPool::OnPacket (FxServer.exe.c:7297 — chat subtypes 25/26/27/28/
// 30/31/71/74/216, tail always CUserPool::OnPacket); 209 → OnRequestUserInventory.
export const GS_ReceivedPacket = {
  OnConnEstablished: 7, // CConnectPool::OnConnEstablished
  OnReqConnectToSvr: 6,
  OnReqChannelsState: 15,
  OnEnterChannelStage: 16,
  OnInviteUser: 28,
  OnGuildMarkRevision: 38,
  OnEstimateRTT: 20, // CUserPool::OnPacket (via CConnectPool::OnPacket)
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
  OnRequestUserInventory: 209,
  Chat: 208, // explicit case → ResetOffset + CChatPool::OnPacket
} as const;

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

// CMonitorSocket::OnPacket (center) — operator console protocol
/** Client-facing packet ids only the game server sends. */

/** Client-facing packet ids only the game server sends. */
export const GS_ClientSend = {
  OnConnect: 0, // CMainSystem::OnConnEstablished [E2 3][E2 7][E4 headerType]
  OnEstimateRTTRes: 20, // CUserPool::OnEstimateRTT
  OnReqConnectToSvrRes: 2, // CM 1 success path: [E1 1][E1 type][E4 idx][E4 ip][E2 port]
  OnReqConnectToSvrFail: 6, // CheckEnterGame failure code
  OnChannelAnnounce: 15, // the empty lobby announce (OnAddNewSocket / 83)
  OnChannelsState: 13, // CCenterProcess::MakeChannelsStatePacket
  OnChannelsGameState: 14, // CCenterProcess::MakeChannelsGameStatePacket
  OnSvrReservedMsg: 16, // CCenterProcess::OnSvrReservedMsg
  OnAdminNotifyMsg: 26,
  OnChatMsg: 25, // lobby/in-session chat
  OnWhisperRes: 27, // CChatPool::OnWhisper (to the receiver)
  OnWhisperFail: 28, // target absent: [E1 0][EStr name]
  OnItemMsg: 25, // CChatPool::OnItemMsg shares the chat id
  OnSystemMsg: 30,
  OnInviteUser: 29,
  OnShoutMsg: 74,
  OnKickoffUser: 26, // CGameSessionTable::KickImp "abnormal state…"
  OnGuildBanRes: 17, // guild-table overflow on entry
  OnRequestUserSimpleInfoRes: 70, // CChannelPool::PutUserSimpleInfoPacket
  OnRequestMyInfoRes: 64, // CChannelPool::OnRequestMyInfo
  OnRequestModifyUserInfoRes: 65, // CChannelPool::OnRequestModifyUserInfo [E1 result] (1 = ok, 0 = db failure)
  OnGuildMemberListRes: 67, // CChannelPool::PutGuildMemberListPacket
  OnRequestUserInfoDetailRes: 71,
  OnRequestUserLocationRes: 72,
  OnRequestGuildInfoRes: 66,
  OnUserItemList: 202, // the whole FxItem table
  OnPreInventory: 207, // [E1 n][per-user pre-inventory]
  OnUserInventory: 201, // [E1 n][per-user inventory]
  OnEnterGame: 210, // [E1 attr] — the entry-accepted packet
  OnSessionSimpleInfo: 83, // CListSession::MakeSimpleInfoPacket (room list)
  OnSessionCreated: 85, // CListSession::MakeCreatedPacket
  OnSessionModified: 86, // CListSession::MakeModifiedPacket
  OnSessionDestroyed: 87, // CListSession::MakeDestroyedPacket
  OnCreateSessionRes: 80, // [E1 result][E2 idx][E4 serial][E1 gameType]
  OnJoinSessionRes: 81, // [E1 result]
  OnGameTypeMod: 92, // CGameSession::SendGameTypeMod (empty body)
  OnGameTypeNormal: 93, // CGameSession::SendGameTypeNormal (empty body)
  OnSetPlayer: 105, // CBaseSession::MakeSetPlayerPacket
  OnResetPlayer: 106, // CBaseSession::SendResetPlayer [E1 slot][E4 serial]
  OnSetSlotState: 107, // CBaseSession::MakeSetSlotStatePacket [E1 slot][EBuffer 3]
  OnSelectColorRes: 108, // CBaseSession::OnSelectColor [E1 (slot<<4)|color]
  OnSelectBomberRes: 109, // CBaseSession::OnSelectBomber [E1 (slot<<4)|bomber]
  OnOpenCloseSlotRes: 110, // CListSession::DoOpenCloseSlot [E1 (slot<<4)|closed]
  OnBanVoteRequest: 113, // CListSession::OnHostAskBanPlayer [E4 serial][EStr name]
  OnBanPlayerRes: 114, // CListSession::DeferBanPlayer [E1 code][EStr name?]
  OnSessionMapIdx: 112, // CGameSession::SendSessionInfoPacket tail [E2 mapIdx]
  OnStartGameRes: 115, // CGameSession::OnRequestStartGame [E1 CanStartGame]
  OnStartGame: 116, // CGameSession::LaunchGameStage
  OnChangeTitle: 117, // CBaseSession::DoChangeTitle [EStr title]
  OnPlayEmotion: 118, // CBaseSession::OnPlayEmotion (SendPacketExclude self)
  OnBangPok: 122, // CListSession::DoBangPok (empty body)
  OnRequestUDPRelayRes: 54, // OnNotifyUDPLoss/OnRequestUDPRelay → the target [E1 senderSlot]
  OnUDPPeerInfo: 120, // CGameSession::OnUDPPeerInfo — the peer matrix broadcast
  OnStartGame2: 150, // CGameSession::DoStartGame [E4 seed][E4 seq][E4 ghostStartMs][E4 ghostFreqMs]
  OnBombIgniteRes: 153, // CGameSession::OnBombIgnite [E1 slot][E1 pos][E1 attr][E2 bombId]
  OnBombKickThrowRes: 154, // CGameSession::OnBombKickThrow [E1 slot][E2 bombId][E1 pos]
  OnMovableBoxMoveRes: 155, // CGameSession::OnMovableBoxMove [E1×4 relay]
  OnRequestEatItemRes: 156, // CGameSession::OnRequestEatItem [E1 slot][E1 box][E1 item](+lucci [E1 n])
  OnRequestEatObstacleRes: 157, // CGameSession::OnRequestEatObstacle [E1 slot][E1 pos]
  OnEffectRes: 160, // CGameSession::OnSetEffect [buffer relay]
  OnBomberEvent: 159, // CGameSession::OnSetBomberEvent/OnBomberDie relay
  OnDropObstacleRes: 161, // CGameSession::OnDropObstacle [E1 a][E1 pos]
  OnGhostGenerate: 166, // CGameSession::OnRequestGenerateGhost [E1 ghost][E1 slot|0x80][E1 tag]
  OnGhostDestroy: 167, // OnRequestDestroyGhost/DealWithGhostOfLeavingPlayer [E1 ghost]
  OnDestroyBoxRes: 165, // CGameSession::OnDestroyBox [E1×3 relay]
  OnRequestAirplaneRes: 171, // CGameSession::OnRequestAirplane [E4 t][E1 n][n×(E1×4)]
  OnLapInfoRes: 170, // CGameSession::OnLapInfo [E1 n][8×(E1 place][E1 laps)]
  OnItemThrowRes: 172, // CGameSession::OnItemThrow [E1×6 relay]
  OnObjCreate: 174, // CSyncGameObjMan::OnReqCreateObj [E2 id][E1 slot][E2 type][EBuffer 20]
  OnObjInitial: 175, // CSyncGameObjMan::SetInitialObjNo [E2 id][E1 slot]
  OnObjDestroy: 176, // OnReqDestroyObj/OnPlayerLeave [E2 id][E4 crc]
  OnReqEatBulaRes: 177, // CGameSession::OnReqEatBula [E1 n][n×(E1 x][E1 y][E1 slot)]
  OnReqTakeHouseRes: 178, // CGameSession::OnReqTakeHouse [E1 slot][E1 n]…
  OnSetBombTimerRes: 152, // CGameSession::Update tick [E1 n][n×(E2 bombId)(E1 kick)]
  OnReturnPrepareStage: 164, // CGameSession::DoReturnPrepareStage [E1 0]
  OnGameResult: 163, // CGameSession::SendGameResult (the results unit)
  OnNeedStartGame: 121, // CGameSession::DeferBanChief [E1 0/1/2/3][E2 seconds]
  OnUdpLossBan: 195, // asm-only site in Update: empty body + stage=4 (UDP-loss kick)
  OnAirplaneItemProb: 173, // CGameSession::SendAirplaneItemProb [E1 prob]
  OnHackingKick: 196, // CGameSession::OnHackingSuspected [E1 slot]
} as const;

/**
 * Ctor-verified send ids of the in-play strategies (FxServer.exe.c
 * CSendPacket/InitPacket audit) — the strategy unit implements these; they are
 * listed here so the namespace stays enumerable in one place.  Each entry is
 * the enclosing (official) handler name of the construction site.
 */
export const GS_INPLAY_SendInventory = {
  OnBombIgnite: 153, // CGameSession::OnBombIgnite (InitPacket)
  OnBomberDie: 159, // CGameSession::OnBomberDie
  OnSetEffect: 160, // CGameSession::OnSetEffect
  OnDropObstacle: 161, // CGameSession::OnDropObstacle
  OnDestroyBox: 165, // CGameSession::OnDestroyBox
  OnLapInfo: 170, // CGameSession::OnLapInfo
  OnRequestAirplane: 171, // CGameSession::OnRequestAirplane
  OnReqCreateObj: 174, // CSyncGameObjMan::OnReqCreateObj
  OnChangeAILevel: 111, // CPracticeSession::MakeChangeAILevelPacket (InitPacket)
  OnGuildSessionInfo: 88, // CGuildSessionStrategy::EncodeGuildSessionInfo (InitPacket)
  OnPracticeSessionCreated: 89, // CGameSessionTable::DoCreatePracticeSession (3 sites)
} as const;

export const MONITOR_ReceivedPacket = {
  OnRequestCurrentUserStat: 1,
  OnRequestSvrState: 2,
} as const;

// ===================== server → client responses =====================
// Sent by the login server (CxLogin.exe.c) — response ids mirror their requests.
export const LS_SendPacket = {
  OnAskMultiServerRes: 1,
  OnAskFirstInfoRes: 2,
  OnLoginRes: 3,
  OnNewUserConfirmIdRes: 4,
  OnNewUserRes: 5,
  OnReqConnectToSvrRes: 6,
  OnChannelInfo: 10, // CChannelCache::MakeInfoPacket
  OnChannelsExtraInfo: 11, // CCenterProcess::MakeChannelsExtraInfoPacket
  OnChannelsGameState: 14, // CCenterProcess::MakeChannelsGameStatePacket
  OnChannelState: 13, // CChannelCache::MakeStatePacket
  OnEstimateRTTRes: 20,
  OnRequestDestoryServiceRes: 60,
} as const;

/** The CSendPacket-side LS table — ids the login server initiates itself
 * (CxLogin.exe.c LS_ClientSend; the response ids above live in LS_SendPacket). */
/** LS → client packet ids that have no matching request id. */
export const LS_ClientSend = {
  OnChannelInfo: 10, // CChannelCache::MakeInfoPacket
  OnChannelsGameState: 14, // CCenterProcess::MakeChannelsGameStatePacket
  OnChannelsExtraInfo: 11, // CCenterProcess::MakeChannelsExtraInfoPacket
  OnChannelState: 13, // CChannelCache::MakeStatePacket
  OnSvrReservedMsg: 16, // CCenterProcess::OnSvrReservedMsg
  OnAdminNotifyMsg: 26,
  OnWhisper: 27, // CCenterProcess::OnWhisper (CxLogin.exe.c:5058) — relay to the target's socket [EStr][EStr][EStr][EStr][EStr][E4][E4][E4]; no caller in CxCenter.exe.c (arrives via the S2S vtbl)
  OnSystemMsg: 30,
} as const;

// Util server client dispatch (CxUtil.exe.c: CMainPool::OnPacket 21528)
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

/** CClientSocket (client-facing) crypto constants — CxLogin.exe.lst:4098B6
 *  / FxServer.exe.lst:407D19. SetHeaderCode(rcv=0xC0, snd=0x66, mod=0xE7);
 *  SetSequence(40, 40, 3, 3) = the sequence starts at 40 and rolls by 3. */
export const CLIENTSOCKET_HEADER_CODE_RCV = 192; // 0xC0
export const CLIENTSOCKET_HEADER_CODE_SND = 102; // 0x66
export const CLIENTSOCKET_HEADER_CODE_MODIFIER = 231; // 0xE7
export const CLIENTSOCKET_SEQ = 40;
export const CLIENTSOCKET_SEQ_DELTA = 3;

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
// direction: 205/200/213 are the cached CItemMan table packets.
export const SC_SendPacket = {
  OnResConnectToSvr: 6, // CMainPool::OnCenterResConnectToSvr
  OnAdminNotifyMsg: 26, // CCenterProcess::OnAdminNotifyMsg broadcast
  OnEstimateRTTRes: 20,
  OnInitialInfo: 18, // CMainPool::OnCenterResConnEstablished — account + bonus map
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
  OnPackageMap: 213, // CItemMan cached packet (UpdatePackageMapPacket)
  OnCartList: 214, // CMainPool::OnRequestCartList
  OnShopSvrInfo: 212, // CCenterProcess::MakeShopInfoPacket — [E4 n][n×(E4 ip, E2 port)]
  OnPurchaseCartListRes: 215, // CMainPool::PurchaseCartList tail — [E1 9][E1 0][EBuffer 8 variant time] to the user's socket
} as const;

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

// The util server (CxUtil) — the admin-tool relay.  Tools connect on the
// listen socket (the binary binds the literal 0x1FC0, ignoring cfg
// ServerPort), log their identities with packet 7 and everything else is
// relayed to the center (CMainPool::OnPacket, CxUtil.exe.c:21528).
export const UTIL_ClientPacket = {
  OnEstimateRTT: 20, // CUserPool::OnEstimateRTT — [E4 t] echoed back
  OnConnEstablished: 7, // CMainPool::OnConnEstablished [E1 n][n×(EStr name, E4 serial)]
  OnAdminNotifyMsg: 25, // → center MC 4 [EStr]
  OnAdminNotifyGameServerMsg: 26, // → center MC 5 [E1 type][EStr]
  OnSystemMsg: 31, // → center MC 10 [EStr]
  OnKickoffUser: 32, // → center MC 1 [EStr name]
  OnReqUserInfo: 64, // → center MC 7 [E4 serial][EStr account]
  OnUpdateItem: 66, // → center MC 11 [EStr "UpdateFxItem" iff the leading byte is 11]
} as const;

/** What the util sends its admin tools (all degree 0 — SetCipherDegree(0)). */
export const UTIL_ClientSend = {
  OnConnect: 0, // CMainSystem::OnConnEstablished [E2 3][E2 5][E4 headerType][EStr url]
  OnEstimateRTTRes: 20, // CUserPool::OnEstimateRTT
  OnAdminNotifyMsg: 26, // CCenterProcess::OnAdminNotifyMsg rebroadcast
  OnUserDetailInfo: 64, // CMainPool::SendUserDetailInfo [E1 n][E4 n2]
} as const;
