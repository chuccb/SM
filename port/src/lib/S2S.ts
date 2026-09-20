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

/** the identify-frame svrIdx obfuscation — every exe writes
 *  [E4 svrIdx ^ 0x77] (FxServer.exe.c:3700, FxShop.exe.c:4279,
 *  CxUtil.exe.c:15632, CxLogin.exe.c:4928) and CxCenter decodes it back. */
export const SVRIDX_IDENTIFY_XOR = 0x77;

/** Raw center handshake, before framed traffic (CxCenter.exe.c:14324). */
export const CENTER_GREETING_SIZE = 2 + 2; // version, socket descriptor
export const LOCAL_SERVER_IDENTIFICATION_SIZE = 1 + 4 + 2 + 2; // class, index, versions

/** CClientSocket::FlushClientSocketSndBuffer's census gate (FxServer.exe.c
 *  :9185, FxShop.exe.c:5278) — the socket/user count line prints at most
 *  every 0x493E0 ms. */
export const CLIENT_SOCKET_CENSUS_MS = 0x493e0;

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

/**
 * CCenterProcess::Init — the [E2 gameVersion][E2 clientVersion] tail of the
 * identify frame ([E1 class][E4 svrIdx^0x77][E2 gv][E2 cv]), keyed by server
 * class.  Anchors: FxServer.exe.c:3703 (class 10 → 7/3), FxShop.exe.c:4276
 * (class 11 → 7/3), CxUtil.exe.c:15626 (class 99 → 5/3), CxLogin.exe.c:4927
 * (class 1 → 0/0).  The center keeps the versions per class
 * (CLocalServerMan +52/+64/+76) and the LS p6 gate (CheckEnterGame) compares
 * the client's gv against the GAME entry.
 */
export const GAME_VERSION: Readonly<Record<number, number>> = {
  [SVRCLASS_LOGIN]: 0,
  [SVRCLASS_GAME]: 7,
  [SVRCLASS_SHOP]: 7,
  [SVRCLASS_UTIL]: 5,
};
export const CLIENT_VERSION: Readonly<Record<number, number>> = {
  [SVRCLASS_LOGIN]: 0,
  [SVRCLASS_GAME]: 3,
  [SVRCLASS_SHOP]: 3,
  [SVRCLASS_UTIL]: 3,
};

/**
 * CMainSystem::OnConnEstablished — the [E2 CENTER_VERSION][E2 gameVersion]
 * head of the client accept hello (packet 0).  Anchors: FxServer.exe.c:20690,
 * CxLogin.exe.c:16395, FxShop.exe.c:21051 (all 3/7), CxUtil.exe.c:21697
 * (3/5).  Every class advertises its own GAME_VERSION entry except the login
 * server: its clients are game clients, so the LS advertises the GAME
 * class's gameVersion (LS identifies to the center with 0/0 but still says
 * 7 here) — the same value the client echoes back in its p6 CheckEnterGame
 * request, where CheckEnterGame compares it against the GAME entry.
 */
export const CONN_HELLO_VERSION: Readonly<Record<number, number>> = {
  [SVRCLASS_LOGIN]: GAME_VERSION[SVRCLASS_GAME],
  [SVRCLASS_GAME]: GAME_VERSION[SVRCLASS_GAME],
  [SVRCLASS_SHOP]: GAME_VERSION[SVRCLASS_SHOP],
  [SVRCLASS_UTIL]: GAME_VERSION[SVRCLASS_UTIL],
};
