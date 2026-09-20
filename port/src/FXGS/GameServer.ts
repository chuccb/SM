/**
 * FXGS — the game server (FxServer.exe).
 *
 * This unit covers everything from process boot through the lobby:
 *   boot          CFxServerApp::SetUp — config, DB, pools, listeners
 *   center link   CCenterProcess::Init (greeting + identification
 *                 [class=10][idx^0x77][u16 7][u16 3]) and its OnPacket
 *                 dispatch (2 ResConnEstablished, 3 LocalServerInfo,
 *                 4 LocalServerState, 5 LocalGameState, 7 SvrReservedMsg,
 *                 8 AdminNotifyMsg, 10 UserChannelResult, 11 DeleteUser,
 *                 12 InitialSvrAttr, 13 SystemMsg, 14 ItemDBInit)
 *   client entry  CMainSystem::OnConnEstablished pushes packet 0
 *                 [E2 3][E2 7][E4 headerType] at once; CConnectPool::OnPacket
 *                 handles 7 (ConnEstablished) and 20 (RTT), and
 *                 OnCenterResConnEstablished performs the DB login
 *                 (prGetUserInfo + InitUserInventory + guilds) and answers
 *                 210 / 202 / 207 / 201 before moving the socket into the
 *                 channel pool
 *   lobby         CChannelPool::OnPacket — 6 ReqConnectToSvr, 15
 *                 ReqChannelsState, 16 EnterChannelStage, 20 RTT (via
 *                 CUserPool), 28 InviteUser, 38 GuildMarkRevision,
 *                 64/65/66/67/68/69/70 user+guild info, 80/81/82 session
 *                 create/join/join-free (via CGameSessionTable), 83
 *                 EnterLobbyStage, 85 GuildMemberInfo, 209 UserInventory
 *                 and 208 → CChatPool (25/26/27/28/30/31/71/74/216)
 *
 * The socket stage tag (+468) mirrors the original exactly: 0 = the connect
 * pool, 3 = channel-select stage (after 16), 1 = lobby stage (after 83),
 * 2 = seated in a room, 4 = playing, 6 = practice.
 *
 * The unit is split one module per original component, dependency-ordered:
 *   Defs          the shared constants (slot-state bits, session-idx
 *                 sentinels, RTT/hash/timeout values) — every magic number
 *                 that more than one class repeats
 *   Rows          the DB row types and the item tables (CUserItemMan)
 *   User          CUser and CClientSocket (+ GetInfoStr)
 *   Tables        CLocalUserTable, CGuild, CGuildTable
 *   Pools         CUserPool, CConnectPool (the client entry)
 *   GameData      the FxServer.idx/.idd tables (CBomberAttr, maps)
 *   GameContext   the in-play board state (CBanChief, the dyn calculators,
 *                 CGameClock, CSyncGameObjMan, CUdpLossRegulator)
 *   Session       CGameSession — one room
 *   Strategy      the session-strategy vtable unit (base stubs + type-77
 *                 guild variant with its results accountant)
 *   Practice      CPracticeSession (the solo rooms with their AI seats)
 *   SessionTable  CGameSessionTable (the two 255-slot halves)
 *   Chat          CChatPool + CChannelPool (the lobby)
 *   System        CMainSystem + CCenterProcess (the center link)
 *   Boot          CUDPPacketDispatcher::OnUDPPacket + main()
 * This file is the facade: it re-exports every module so the rest of the
 * port (main.ts, the e2e tests) keeps a single import path.
 */

export * from "./Defs.ts";
export * from "./CUserItemMan.ts";
export * from "./User.ts";
export * from "./Tables.ts";
export * from "./Pools.ts";
export * from "./GameData.ts";
export * from "./GameContext.ts";
export * from "./Session.ts";
export * from "./Strategy.ts";
export * from "./Practice.ts";
export * from "./SessionTable.ts";
export * from "./Chat.ts";
export * from "./System.ts";
export * from "./Boot.ts";
