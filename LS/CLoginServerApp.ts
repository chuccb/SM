import { CListenSocket } from "../Common/CListenSocket.ts";
import { CCenterProcess } from "../Common/CCenterProcess.ts";
import { CMainSystem } from "./CMainSystem.ts";
import { CLoginPool } from "./CLoginPool.ts";
import { CMultiServer } from "./CMultiServer.ts";
import { CChannelCache } from "./CChannelCache.ts";
import { CConfigDyn } from "./CConfigDyn.ts";
import { CDBMan } from "./CDBMan.ts";
import type { CDBSession } from "../Common/DB/CDBSession.ts";
import type { CCenterServer } from "../Center/CCenterServer.ts";
import type { ServerConfig } from "../Common/CServerConfig.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import { ServerType } from "../Common/OfficialValues.ts";

export class CLoginServerApp {
  readonly m_listenSocket: CListenSocket;
  readonly m_loginPool: CLoginPool;
  constructor(
    readonly config: ServerConfig,
    readonly center: CCenterServer,
    session: CDBSession,
    text: CTextCodec,
  ) {
    const server = center.m_localServerMan.GetSvr(ServerType.Login, 0)!;
    const link = new CCenterProcess(center, server);
    const db = new CDBMan(session, text);
    const system = new CMainSystem(config);
    this.m_loginPool = new CLoginPool(
      db,
      link,
      new CMultiServer(config, text),
      new CChannelCache(config, center, text),
      new CConfigDyn(db.GetOption("Notice") ?? "", text),
      config,
    );
    this.m_listenSocket = new CListenSocket(
      "LoginServer",
      text,
      (p, s) => this.m_loginPool.OnPacket(p, s),
      (s) => {
        s.m_nPoolType = "Login";
        this.m_loginPool.AddNewSocket(s);
        system.OnConnEstablished(s);
      },
      (s) => {
        this.m_loginPool.DeleteSocket(s);
        link.UnregisterConnection(s);
      },
    );
  }
  async SetUp(): Promise<void> {
    await this.m_listenSocket.Listen(
      this.config.Runtime.Host,
      this.config.LS.Port,
    );
    const server = this.center.m_localServerMan.GetSvr(ServerType.Login, 0)!;
    server.m_nListenPort = this.m_listenSocket.port;
    server.m_bConnected = true;
  }
  async CleanUp(): Promise<void> {
    this.center.m_localServerMan.GetSvr(ServerType.Login, 0)!.m_bConnected =
      false;
    await this.m_listenSocket.Close();
  }
}
