/**
 * Server-to-server (center link) constants and packet IDs.
 *
 * Every local server (CxLogin / FxServer / FxShop / CxUtil) attaches to the
 * center (CxCenter) over a CLocalSocket; the center-side counterpart is the
 * CLocalServer/CLocalServerMan family.
 */

/** CLocalSocket identification bytes (first byte of the attach handshake). */
export const SVRCLASS_LOGIN = 1;
export const SVRCLASS_GAME = 10;
export const SVRCLASS_SHOP = 11;
export const SVRCLASS_UTIL = 99;

/**
 * CLocalSocket::CLocalSocket — SetHeaderCode(96, 189, 231);
 * SetSequence(40, 40, 0, 0) = deltas 40, sequences 0: the local link carries
 * a static check code and NO packet-type conversion (fMakeConvert stays
 * false because the CRC-key sequence is 0).
 */
export const LOCALSOCKET_HEADER_CODE_RCV = 96;
export const LOCALSOCKET_HEADER_CODE_SND = 189;
export const LOCALSOCKET_HEADER_CODE_MODIFIER = 231;
export const LOCALSOCKET_SEQ_DELTA = 40;
export const LOCALSOCKET_SEQ = 0;

/** CServerSocket (center-side accept) mirrors it: SetHeaderCode(189, 96, 231). */

/**
 * Local server → center packets (CLocalServer::OnPacket and friends).
 * Dispatch lives in CxCenter.exe.c.
 */
export const MC_ReceivedPacket = {
  OnAddNewUser: 0, // CLoginServer::OnAddNewUser (only accepted on the LS class)
  OnDeleteUser: 1, // CLocalServer::OnDeleteUser
  OnReqConnectToSvr: 2, // CLocalServer::OnReqConnectToSvr
  OnConnEstablished: 3, // CLocalServer vtbl+28 → OnConnEstablished
  OnAdminNotifyMsg: 4,
  OnAdminNotifyGameServerMsg: 5,
  OnRequestUserChannel: 7, // CShopServer::OnRequestUserChannel (the shop link)
  OnSvrReservedMsg: 7, // the generic CLocalServer::OnPacket name for the same id
  OnSetAuthenCode: 9, // CShopServer::OnSetAuthenCode
  OnSystemMsg: 10,
  OnSystemCmd: 11,
  OnLocalServerState: 4, // CGameServer::OnPacket → OnAdminNotifyMsg(4); state via LS handler
} as const;

/** Center → local server packets (CCenterProcess::OnPacket on each server). */
export const CM_ReceivedPacket = {
  OnCenterResAddNewUser: 0,
  OnCenterResConnectToSvr: 1,
  OnCenterResConnEstablished: 2,
  OnLocalServerInfo: 3,
  OnLocalServerState: 4,
  OnLocalGameState: 5,
  OnSvrReservedMsg: 7,
  OnAdminNotifyMsg: 8,
  OnUserChannelResult: 10,
  OnDeleteUser: 11,
  OnInitialSvrAttr: 12,
  OnSystemMsg: 13,
  OnItemDBInit: 14, // CUserItemMan::Init (GS) / CItemMan::Update*Table (shop)
  OnShopServerInfo: 6, // CCenterProcess::OnShopServerInfo — [E4 n][n×(E4 ip, E2 port)]
} as const;

/** CxCenter greet: Encode2(3 /* version *\/); Encode2(sd). */
export const CENTER_VERSION = 3;
