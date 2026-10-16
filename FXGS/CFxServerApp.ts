import { CUDPPacketDispatcher } from "./CUDPPacketDispatcher.ts";
import { MTUDPServer } from "./MTUDPServer.ts";
import { ClientRequest } from "../Common/Protocol/PacketTypes.ts";
import { CListenSocket } from "../Common/CListenSocket.ts";
import { CCenterProcess } from "../Common/CCenterProcess.ts";
import { CMainSystem } from "./CMainSystem.ts";
import { CChannelCache } from "../LS/CChannelCache.ts";
import { CChannelPool } from "./CChannelPool.ts";
import { CConnectPool } from "./CConnectPool.ts";
import { CGameSessionTable } from "./CGameSessionTable.ts";
import { CTimerThreadNormal } from "./CTimerThreadNormal.ts";
import { CUserItemMan } from "./CUserItemMan.ts";
import { CDBMan } from "./CDBMan.ts";
import type { CDBSession } from "../Common/DB/CDBSession.ts";
import type { CCenterServer } from "../Center/CCenterServer.ts";
import type {
  ServerConfig,
  GameServerConfig,
} from "../Common/CServerConfig.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import type { CItemAttr } from "./CItemAttr.ts";
import type { CBomberAttr } from "./CBomberAttr.ts";
import type { CGameMapTmplList } from "./CGameMapTmplList.ts";
import {
  ServerType,
  GameAttribute,
  GameUDPFormat,
} from "../Common/OfficialValues.ts";

/** Modern startup glue; original runtime classes retain their own source names. */
export class CFxServerApp {
  readonly m_listenSocket: CListenSocket;
  readonly m_udpServer: MTUDPServer;
  readonly m_channelPool: CChannelPool;
  readonly m_gameSessionTable: CGameSessionTable;
  readonly m_timerThreadNormal: CTimerThreadNormal;
  readonly m_userItemMan: CUserItemMan;
  constructor(
    readonly config: ServerConfig,
    readonly channel: GameServerConfig,
    readonly center: CCenterServer,
    session: CDBSession,
    text: CTextCodec,
    bombers: CBomberAttr,
    maps: CGameMapTmplList,
    items: CItemAttr,
  ) {
    const server = center.m_localServerMan.GetSvr(
      ServerType.FXGame,
      channel.Index,
    )!;
    const link = new CCenterProcess(center, server);
    const db = new CDBMan(session, text);
    this.m_userItemMan = new CUserItemMan(db);
    const system = new CMainSystem(
      channel.Type,
      config.FXSS.Ports.length ? GameAttribute.ShopInventory : 0,
    );
    this.m_gameSessionTable = new CGameSessionTable(
      text,
      bombers,
      maps,
      channel.Type,
      (p) => {
        for (const s of this.m_listenSocket.sockets)
          // Modern room-list publication is immediate, unlike native cached
          // periodic flush. Do not expose a departing socket's TRANSIENT pool1
          // before its explicit15/list response or195 -> pool4 boundary.
          if (
            s.m_nPoolType === "Lobby" &&
            !this.m_gameSessionTable.IsRemovingPlayer(s)
          )
            s.SendPacket(p);
      },
      {
        DB: db,
        ChannelIndex: channel.Index,
        UpdateRankList: (user) => this.m_channelPool.UpdateRankList(user),
      },
      // Do not publish successful launch while this deployment has no way
      // to receive the native discovery handshake. UDP remains opt-in.
      config.FXGS.UDPEnabled ? { Items: items } : undefined,
    );
    this.m_timerThreadNormal = new CTimerThreadNormal(this.m_gameSessionTable);
    this.m_udpServer = new MTUDPServer(
      new CUDPPacketDispatcher(this.m_gameSessionTable, (serial) => {
        const user = center.m_globalUserTable.GetUser(serial);
        const socket = user?.m_pClientSocket;
        return server.m_bConnected &&
          socket?.m_nPoolType === "Session" &&
          socket.m_aUser.every((local) => {
            const registered = center.m_globalUserTable.GetUser(
              local.m_nGlobalSerialNo,
            );
            return (
              registered === local &&
              registered.IsSetFree() === 0 &&
              registered.m_pLocalServer === server &&
              !registered.m_pendingConnection
            );
          })
          ? user
          : undefined;
      }),
    );
    this.m_channelPool = new CChannelPool(
      this.m_gameSessionTable,
      link,
      new CChannelCache(config, center, text),
    );
    // Center CGameServer::Init @ 00406150: FXAttrShop enables game attribute bit 0.
    const connect = new CConnectPool(
      db,
      link,
      this.m_userItemMan,
      this.m_gameSessionTable,
      system.GetGameAttr(),
      (socket) => this.m_channelPool.InsertRankList(socket),
    );
    this.m_listenSocket = new CListenSocket(
      `FxGame-${channel.Index}`,
      text,
      (p, s) =>
        p.m_nPacketType === ClientRequest.EstimateRTT
          ? (p.Decode1(), this.m_channelPool.OnEstimateRTT(p, s))
          : s.GetUserCount()
            ? this.m_channelPool.OnPacket(p, s)
            : connect.OnPacket(p, s),
      (s) => {
        this.m_channelPool.AddNewSocket(s);
        system.OnConnEstablished(s);
      },
      (s) => {
        try {
          this.m_gameSessionTable.DestroyPlayer(s);
        } finally {
          // A frozen/unported room must not strand global/rank ownership when
          // the real TCP socket is already gone. Such a round fails closed;
          // this does NOT repair/rebase its frozen receipt or restore a room.
          try {
            this.m_channelPool.DeleteSocket(s);
          } finally {
            link.UnregisterConnection(s);
          }
        }
      },
    );
  }
  async SetUp(): Promise<void> {
    await this.m_listenSocket.Listen(
      this.config.Runtime.Host,
      this.channel.Port,
    );
    try {
      if (this.config.FXGS.UDPEnabled) {
        const port = this.m_listenSocket.port + GameUDPFormat.PortOffset;
        if (port > 65535) throw new Error("FXGS UDP port overflows uint16");
        await this.m_udpServer.Startup(this.config.Runtime.Host, port);
      }
      const server = this.center.m_localServerMan.GetSvr(
        ServerType.FXGame,
        this.channel.Index,
      )!;
      server.m_nListenPort = this.m_listenSocket.port;
      server.m_bConnected = true;
      this.m_timerThreadNormal.Start();
    } catch (error) {
      this.m_timerThreadNormal.Stop();
      this.center.m_localServerMan.GetSvr(
        ServerType.FXGame,
        this.channel.Index,
      )!.m_bConnected = false;
      await this.m_udpServer.Cleanup();
      await this.m_listenSocket.Close();
      throw error;
    }
  }
  async CleanUp(): Promise<void> {
    // Stop synchronous game/SQL work BEFORE transports and the shared DB close.
    this.m_timerThreadNormal.Stop();
    this.center.m_localServerMan.GetSvr(
      ServerType.FXGame,
      this.channel.Index,
    )!.m_bConnected = false;
    await this.m_udpServer.Cleanup();
    await this.m_listenSocket.Close();
  }
}
