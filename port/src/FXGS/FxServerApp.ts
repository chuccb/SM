/** Native source unit: FX/FxServer/FxServerApp.cpp.
 * CFxServerApp::SetUp composes the separately owned TCP/MTUDP units. */

import { dirname, join } from "node:path";
import { CServerConfig, FXSERVER_STR_KEYS } from "../core/ServerConfig.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CIDFMan } from "./IDFMan.ts";
import { PACKET_NAME_TABLES } from "../protocol/PacketIDs.ts";
import { CChannelPool } from "./ChannelPool.ts";
import { CBomberAttr } from "./BomberAttr.ts";
import { CGameMapTmplList } from "./GameMapTmplList.ts";
import { CItemAttr } from "./ItemAttr.ts";
import { CConnectPool } from "./ConnectPool.ts";
import { CUserItemMan } from "./ItemMan.ts";
import { CGameSessionTable } from "./GameSessionTable.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { CMainSystem } from "./MainSystem.ts";
import { CGuildTable } from "./Guild.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { CListenThread } from "./ListenThread.ts";
import { CUDPPacketDispatcher } from "./UDPPacketDispatcher.ts";
import { MTUDPServer } from "./MTUDPServer.ts";
import { CTimerThreadNormal, CTimerThreadTimeCritical } from "./TimerThread.ts";

// ============================ boot ============================

/** CFxServerApp — native owner of the FxServer setup sequence. */
export class CFxServerApp {
  db: CDBMan | null = null;
  centerProcess: CCenterProcess | null = null;
  listenThread: CListenThread | null = null;
  udpDispatcher: CUDPPacketDispatcher | null = null;
  mtudpServer: MTUDPServer | null = null;
  timerThreadNormal: CTimerThreadNormal | null = null;
  timerThreadTimeCritical: CTimerThreadTimeCritical | null = null;

  constructor(
    private readonly cfgFile: string,
    private readonly dbDir: string,
  ) {}

  /** CFxServerApp::SetUp. */
  async SetUp(): Promise<void> {
    const { cfgFile, dbDir } = this;
    const cfg = new CServerConfig(FXSERVER_STR_KEYS);
    cfg.Init(cfgFile);
    CServerConfig.ms_pInstance = cfg;

    PacketLog.Configure("GS");
    PacketLog.Register("GS", "recv", ...PACKET_NAME_TABLES.GS.recv);
    PacketLog.Register("GS", "send", ...PACKET_NAME_TABLES.GS.send);

    // CBomberAttr / CItemAttr / CGameMapTmplList load from the IDF package
    // (FxServer.idd/.idx, CIDFMan::CIDFMan hardcodes the "FxServer" base —
    // FxServer.exe.c:13436 loads them right after CUserItemMan).  The package
    // ships in the server directory, next to the .cfg.
    new CIDFMan(join(dirname(cfgFile), "FxServer"));
    new CBomberAttr().Load();
    new CItemAttr().Load();
    new CGameMapTmplList().CreateTmplList();

    const db = new CDBMan(dbDir);
    this.db = db;
    const itemMan = new CUserItemMan();
    itemMan.Init(db);
    new CLocalUserTable();
    const mainSystem = new CMainSystem(cfg);
    const connectPool = new CConnectPool(db);
    const channelPool = new CChannelPool(db);
    new CGuildTable(db);
    const center = new CCenterProcess(db);
    this.centerProcess = center;
    // CCenterProcess::Init (FxServer.exe.c:13383) — the WinMain order is the
    // center attach (with the endless 3 s retry loop) BEFORE CListenThread.
    await center.Init(cfg);
    // The session ctors bind their strategy from MainSystem+8 (:37220), so
    // the channel table has to be in before CGameSessionTable constructs its
    // 510 sessions (the original races this against its DB opens).
    await center.WaitChannelInfo();
    const sessionTable = new CGameSessionTable();

    const port = cfg.GetNumAttribute("ServerPort");
    this.listenThread = new CListenThread(port, mainSystem);
    this.listenThread.Start();

    // MTUDPServer::StartupBase (42E828) owns the UDP peer on ServerPort + 1;
    // CUDPPacketDispatcher owns only validated launch-handshake packets.  Await
    // the bind so an occupied port fails startup instead of leaving a TCP-only
    // server whose clients freeze while loading the map.
    const udpDispatcher = new CUDPPacketDispatcher();
    const mtudpServer = new MTUDPServer((payload, host) => udpDispatcher.OnUDPPacket(payload, host));
    this.udpDispatcher = udpDispatcher;
    this.mtudpServer = mtudpServer;
    await mtudpServer.StartupBase(0);

    this.timerThreadNormal = new CTimerThreadNormal(db, connectPool, channelPool, sessionTable);
    this.timerThreadTimeCritical = new CTimerThreadTimeCritical();
    this.timerThreadNormal.Start();
    this.timerThreadTimeCritical.Start();
  }

  /** CFxServerApp::CleanUp — active Bun resources in native order. */
  CleanUp(): void {
    this.listenThread?.Stop();
    this.udpDispatcher?.Terminate();
    this.mtudpServer?.Cleanup();
    this.timerThreadNormal?.Stop();
    this.timerThreadTimeCritical?.Stop();
    this.centerProcess?.Stop();
    this.db?.Close();
    this.listenThread = null;
    this.udpDispatcher = null;
    this.mtudpServer = null;
    this.timerThreadNormal = null;
    this.timerThreadTimeCritical = null;
    this.centerProcess = null;
    this.db = null;
  }
}

/** Port entry: Bun's event loop replaces the native blocking CApp::Run. */
export async function main(cfgFile: string, dbDir: string): Promise<CFxServerApp> {
  const app = new CFxServerApp(cfgFile, dbDir);
  try {
    await app.SetUp();
    return app;
  } catch (error) {
    app.CleanUp();
    throw error;
  }
}
