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
