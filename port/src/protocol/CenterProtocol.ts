/**
 * Server-to-server (center link) constants and packet IDs.
 *
 * Every local server (CxLogin / FxServer / FxShop / CxUtil) attaches to the
 * center (CxCenter) over a CLocalSocket; the center-side counterpart is the
 * CLocalServer/CLocalServerMan family.
 */

import { DefinePacketNameTable, type PacketNameTable } from "./PacketNames.ts";

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
 * CLocalSocket::CLocalSocket — SetHeaderCode(rcv=96, snd=189, mod=231) and
 * SetSequence(40, 40, 0, 0) (CxLogin.exe.lst:40C1F3..40C22A).  A zero delta
 * makes check codes the fixed 96/189 pair; the nonzero sequence still enables
 * packet-type conversion and supplies key 40.  CxCenter greets with its
 * accepted socket's `m_nHeaderType` (CxCenter.exe.lst:40D7E0 reads +0x20),
 * and the connector calls SetHeaderType with that E2 value
 * (CxLogin.exe.lst:403E31 calls vtable +0x20), so both conversion rows match.
 */
export const LOCALSOCKET_HEADER_CODE_RCV = 96;
export const LOCALSOCKET_HEADER_CODE_SND = 189;
export const LOCALSOCKET_HEADER_CODE_MODIFIER = 231;
export const LOCALSOCKET_SEQ = 40;
export const LOCALSOCKET_SEQ_DELTA = 0;

/** CServerSocket (center-side accept) mirrors it: SetHeaderCode(189, 96, 231). */

/** CMonitorSocket's independent raw packet framing (CxCenter.exe.c:16424). */
export const MONITOR_HEADER_CODE_RCV = 102;
export const MONITOR_HEADER_CODE_SND = 102;
export const MONITOR_HEADER_CODE_MODIFIER = 231;
export const MONITOR_SEQ = 0;
export const MONITOR_SEQ_DELTA = 0;

/** Packets accepted by every CLocalServer before class-specific dispatch. */
export const MC_LocalServerPacket = {
  OnDeleteUser: 1,
  OnReqConnectToSvr: 2,
  OnConnEstablished: 3,
} as const;

/** CLoginServer::OnPacket additions (local login server → center). */
export const MC_LoginServerPacket = {
  OnAddNewUser: 0,
  OnDestructCenterSvr: 100,
} as const;

/** CGameServer::OnPacket additions (local game server → center). */
export const MC_GameServerPacket = {
  OnAdminNotifyMsg: 4,
  OnRequestUserChannel: 7,
  OnSystemMsg: 10,
  OnSystemCmd: 11,
} as const;

/** CShopServer::OnPacket additions (local shop server → center). */
export const MC_ShopServerPacket = {
  OnAdminNotifyMsg: 4,
  OnRequestUserChannel: 7,
  OnSetAuthenCode: 9,
} as const;

/** CUtilServer::OnPacket additions (local utility server → center). */
export const MC_UtilServerPacket = {
  OnDeleteUser: 1, // class-specific implementation replaces the base handler
  OnAdminNotifyMsg: 4,
  OnAdminNotifyGameServerMsg: 5,
  OnRequestUserChannel: 7,
  OnSystemMsg: 10,
  OnSystemCmd: 11,
} as const;

/** Complete local-server send contexts.  FxServer really constructs MC 9
 * in CCenterProcess::SendAuthenCode, although CxCenter's CGameServer dispatch
 * ignores it; keep the wire site visible without enabling that handler. */
export const MC_LoginServerSendPacket = {
  ...MC_LocalServerPacket,
  ...MC_LoginServerPacket,
} as const;
export const MC_GameServerSendPacket = {
  ...MC_LocalServerPacket,
  ...MC_GameServerPacket,
  SendAuthenCode: 9,
} as const;
export const MC_ShopServerSendPacket = {
  ...MC_LocalServerPacket,
  ...MC_ShopServerPacket,
  SendAuthenCode: 9,
} as const;
export const MC_UtilServerSendPacket = {
  ...MC_LocalServerPacket,
  ...MC_UtilServerPacket,
} as const;

/**
 * Source-compatible union for packet constructors.  New code should use its
 * class-specific MC_*ServerSendPacket table.
 */
export const MC_ReceivedPacket = {
  ...MC_LocalServerPacket,
  ...MC_LoginServerPacket,
  ...MC_GameServerPacket,
  ...MC_ShopServerPacket,
  ...MC_UtilServerPacket,
} as const;

export const MC_LocalServerPacketNames = DefinePacketNameTable(
  "enLocalPacket",
  "CLocalServer",
  "local-to-center",
  MC_LocalServerPacket,
);
export const MC_LoginServerPacketNames = DefinePacketNameTable(
  "enLocalPacket",
  "CLoginServer",
  "local-to-center",
  MC_LoginServerSendPacket,
);
export const MC_GameServerPacketNames = DefinePacketNameTable(
  "enLocalPacket",
  "CGameServer",
  "local-to-center",
  MC_GameServerSendPacket,
);
export const MC_ShopServerPacketNames = DefinePacketNameTable(
  "enLocalPacket",
  "CShopServer",
  "local-to-center",
  MC_ShopServerSendPacket,
);
export const MC_UtilServerPacketNames = DefinePacketNameTable(
  "enLocalPacket",
  "CUtilServer",
  "local-to-center",
  MC_UtilServerSendPacket,
);

/** CxLogin CCenterProcess::OnPacket subset (center → login server). */
export const CM_LoginServerPacket = {
  OnCenterResAddNewUser: 0,
  OnCenterResConnectToSvr: 1,
  OnCenterResConnEstablished: 2,
  OnLocalServerInfo: 3,
  OnLocalServerState: 4,
  OnLocalGameState: 5,
  OnSvrReservedMsg: 7,
  OnAdminNotifyMsg: 8,
  OnDeleteUser: 11,
  OnSystemMsg: 13,
} as const;

/** FxServer CCenterProcess::OnPacket subset (center → game server). */
export const CM_GameServerPacket = {
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
  OnItemDBInit: 14,
} as const;

/** FxShop CCenterProcess::OnPacket subset (center → shop server). */
export const CM_ShopServerPacket = {
  OnCenterResConnectToSvr: 1,
  OnCenterResConnEstablished: 2,
  OnShopServerInfo: 6,
  OnAdminNotifyMsg: 8,
  OnInitialSvrAttr: 12,
  OnItemDBInit: 14,
} as const;

/** CxUtil CCenterProcess::OnPacket subset (center → utility server). */
export const CM_UtilServerPacket = {
  OnAdminNotifyMsg: 8,
  OnUserChannelResult: 10,
  OnInitialSvrAttr: 12,
} as const;

/** Source-compatible union for center packet constructors. */
export const CM_ReceivedPacket = {
  ...CM_LoginServerPacket,
  ...CM_GameServerPacket,
  ...CM_ShopServerPacket,
  ...CM_UtilServerPacket,
} as const;

export const CM_LoginServerPacketNames = DefinePacketNameTable(
  "enCenterPacket",
  "CxLogin::CCenterProcess",
  "center-to-local",
  CM_LoginServerPacket,
);
export const CM_GameServerPacketNames = DefinePacketNameTable(
  "enCenterPacket",
  "FxServer::CCenterProcess",
  "center-to-local",
  CM_GameServerPacket,
);
export const CM_ShopServerPacketNames = DefinePacketNameTable(
  "enCenterPacket",
  "FxShop::CCenterProcess",
  "center-to-local",
  CM_ShopServerPacket,
);
export const CM_UtilServerPacketNames = DefinePacketNameTable(
  "enCenterPacket",
  "CxUtil::CCenterProcess",
  "center-to-local",
  CM_UtilServerPacket,
);

/** Center-side accepted subsets.  These intentionally differ from the wire
 * registry for the GS-only, sent-but-ignored MC 9 compatibility path. */
export const MC_LoginServerDispatchNames = DefinePacketNameTable(
  "enLocalPacket", "CLoginServer::OnPacket", "local-to-center",
  { ...MC_LocalServerPacket, ...MC_LoginServerPacket },
);
export const MC_GameServerDispatchNames = DefinePacketNameTable(
  "enLocalPacket", "CGameServer::OnPacket", "local-to-center",
  { ...MC_LocalServerPacket, ...MC_GameServerPacket },
);
export const MC_ShopServerDispatchNames = DefinePacketNameTable(
  "enLocalPacket", "CShopServer::OnPacket", "local-to-center",
  { ...MC_LocalServerPacket, ...MC_ShopServerPacket },
);
export const MC_UtilServerDispatchNames = DefinePacketNameTable(
  "enLocalPacket", "CUtilServer::OnPacket", "local-to-center",
  { ...MC_LocalServerPacket, ...MC_UtilServerPacket },
);

/** Server-class-aware wire registries used by packet tracing. */
export const MC_PACKET_NAMES_BY_SERVER_CLASS: Readonly<Record<number, PacketNameTable>> = {
  [SVRCLASS_LOGIN]: MC_LoginServerPacketNames,
  [SVRCLASS_GAME]: MC_GameServerPacketNames,
  [SVRCLASS_SHOP]: MC_ShopServerPacketNames,
  [SVRCLASS_UTIL]: MC_UtilServerPacketNames,
};
export const MC_DISPATCH_NAMES_BY_SERVER_CLASS: Readonly<Record<number, PacketNameTable>> = {
  [SVRCLASS_LOGIN]: MC_LoginServerDispatchNames,
  [SVRCLASS_GAME]: MC_GameServerDispatchNames,
  [SVRCLASS_SHOP]: MC_ShopServerDispatchNames,
  [SVRCLASS_UTIL]: MC_UtilServerDispatchNames,
};

export const CM_PACKET_NAMES_BY_SERVER_CLASS: Readonly<Record<number, PacketNameTable>> = {
  [SVRCLASS_LOGIN]: CM_LoginServerPacketNames,
  [SVRCLASS_GAME]: CM_GameServerPacketNames,
  [SVRCLASS_SHOP]: CM_ShopServerPacketNames,
  [SVRCLASS_UTIL]: CM_UtilServerPacketNames,
};

/** CxCenter raw greeting: [E2 version 3][E2 accepted-socket header type]. */
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
