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
 * CLocalSocket::CLocalSocket — SetHeaderCode(rcv=96, snd=189, mod=231)
 * (CxLogin.exe.lst:40C1F3). The original local link runs SetSequence(40, 40,
 * 0, 0) — a static check code with the deg-0 type conversion enabled — but
 * the conversion rows only line up when both ends share the header type,
 * and the original's accept side stamps SetHeaderType(counter++ % 16)
 * (CxCenter 40E1FE) while the connect side derives a constant 1 from the
 * static code ((40+96)^96-231). How the original reconciles those rows is
 * not resolved yet; until it is, the port runs the self-consistent variant
 * below (seq 0 → conversion off, code rolls (ht+231)^(base+seq) by 40).
 * The center link only ever connects port servers to each other, so this
 * is not client-observable.
 */
export const LOCALSOCKET_HEADER_CODE_RCV = 96;
export const LOCALSOCKET_HEADER_CODE_SND = 189;
export const LOCALSOCKET_HEADER_CODE_MODIFIER = 231;
export const LOCALSOCKET_SEQ = 0;
export const LOCALSOCKET_SEQ_DELTA = 40;

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
  OnDestructCenterSvr: 100, // CxCenter.exe.c:15315 CLoginServer::OnPacket — LS shutdown notice → CGlobalUserTable::GetUser(-1) + SetFree
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
