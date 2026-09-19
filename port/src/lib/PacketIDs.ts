/**
 * Client-facing packet IDs. There is no kPacket* enum in the original PDBs —
 * the numbers below are the dispatch values read straight out of the
 * OnPacket handlers of the decompiled servers (CxLogin.exe.c /
 * FxServer.exe.c / FxShop.exe.c / CxUtil.exe.c / CxCenter.exe.c).  They form
 * one shared namespace per direction; each server handles its own subset.
 * Handler names are the official ones.
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

// CChannelPool::OnPacket (FxServer.exe.c:6942) — the game-server lobby dispatch
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
  Chat: 208, // CChatPool::OnPacket (also the default branch)
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

/** CClientSocket (client-facing) crypto constants — FxServer.exe.c:9848.
 *  SetSequence(40, 40, 3, 3): the sequence starts at 3 and rolls by 40. */
export const CLIENTSOCKET_HEADER_CODE_RCV = 192; // 0xC0
export const CLIENTSOCKET_HEADER_CODE_SND = 102; // 0x66
export const CLIENTSOCKET_HEADER_CODE_MODIFIER = 231; // 0xE7
export const CLIENTSOCKET_SEQ_DELTA = 40;
export const CLIENTSOCKET_SEQ = 3;

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
  OnTranxData: 211, // CMainPool::OnRequestTranxData
  OnPackageMap: 213, // CItemMan cached packet (UpdatePackageMapPacket)
  OnCartList: 214, // CMainPool::OnRequestCartList
  OnShopSvrInfo: 212, // CCenterProcess::MakeShopInfoPacket — [E4 n][n×(E4 ip, E2 port)]
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
