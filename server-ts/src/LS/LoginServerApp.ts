/** Native source unit: CX/CxLogin/LoginServerApp.cpp. */
import { CServerConfig, CXLOGIN_STR_KEYS } from "../core/ServerConfig.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CMultiServer } from "./MultiServer.ts";
import { MTUDPServer } from "./MTUDPServer.ts";
import { CTimerThread } from "./TimerThread.ts";
import { SetLocalUserTableFinder } from "./UDPPacketDispatcher.ts";
import { CConfigDyn } from "./ConfigDyn.ts";
import { PACKET_NAME_TABLES } from "../core/protocol/PacketIDs.ts";
import { CLoginPool } from "./LoginPool.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { CMainSystem } from "./MainSystem.ts";
import { CListenThread } from "./ListenThread.ts";

/** CLoginServerApp — native owner of the CxLogin setup sequence. */
export class CLoginServerApp {
  db: CDBMan | null = null;
  centerProcess: CCenterProcess | null = null;
  loginPool: CLoginPool | null = null;
  mtudpServer: MTUDPServer | null = null;
  timerThread: CTimerThread | null = null;
  listenThread: CListenThread | null = null;

  constructor(
    private readonly cfgFile: string,
    private readonly dbDir: string,
  ) {}

  /** CLoginServerApp::SetUp. */
  async SetUp(): Promise<void> {
    const { cfgFile, dbDir } = this;
    const cfg = new CServerConfig(CXLOGIN_STR_KEYS);
    cfg.Init(cfgFile);
    CServerConfig.ms_pInstance = cfg;

    PacketLog.Configure("LS");
    PacketLog.Register("LS", "recv", ...PACKET_NAME_TABLES.LS.recv);
    PacketLog.Register("LS", "send", ...PACKET_NAME_TABLES.LS.send);

    const db = new CDBMan(dbDir);
    this.db = db;
    new CConfigDyn(db);
    const multiServer = new CMultiServer();
    multiServer.Init(db);

    const centerProcess = new CCenterProcess(null as unknown as CLoginPool, multiServer, db);
    centerProcess.m_cfg = cfg;
    const loginPool = new CLoginPool(centerProcess, db, multiServer);
    this.centerProcess = centerProcess;
    this.loginPool = loginPool;
    centerProcess.AttachPool(loginPool);
    centerProcess.UpdateLevelLimit();
    centerProcess.UpdateAdvertisement();
    centerProcess.UpdateGuildServerList();

    // MTUDPServer + CUDPPacketDispatcher (CxLogin.exe.c:16086-16098) — the
    // unreliable UDP peer on ServerPort+1 for the 'check udp comm' handshake,
    // started BEFORE CListenThread, exactly like the original's boot order.
    SetLocalUserTableFinder(
      (sn) => CLoginPool.ms_pInstance?.m_localUserTable.FindUserFromGlobalSerialNo(sn) ?? null,
    );
    this.mtudpServer = new MTUDPServer();
    await this.mtudpServer.Startup();

    // the client listener (CMainSystem init — ServerPort). The original boots it
    // last: CCenterProcess::Init (with the endless 3 s retry loop) runs before
    // CListenThread::Resume, so the port only opens 3838 once the center is up.
    const port = cfg.GetNumAttribute("ServerPort");
    await centerProcess.ConnectToCenter(cfg);

    // CTimerThread::Resume (CxLogin.exe.c:16048 — right after CCenterProcess::Init)
    this.timerThread = new CTimerThread(centerProcess, loginPool);
    this.timerThread.Start();

    const mainSystem = new CMainSystem(cfg);
    this.listenThread = new CListenThread(port, mainSystem, loginPool);
    this.listenThread.Start();
  }

  /** CLoginServerApp::CleanUp — active Bun resources in native order. */
  CleanUp(): void {
    this.listenThread?.Stop();
    this.mtudpServer?.m_dispatcher.Terminate();
    this.mtudpServer?.Cleanup();
    this.timerThread?.Stop();
    this.centerProcess?.Stop();
    this.db?.Close();
    SetLocalUserTableFinder(() => null);
    this.listenThread = null;
    this.mtudpServer = null;
    this.timerThread = null;
    this.centerProcess = null;
    this.loginPool = null;
    this.db = null;
    CLoginPool.ms_pInstance = null;
    CConfigDyn.ms_pInstance = null;
  }
}

/** Port entry: Bun's event loop replaces the native blocking CApp::Run. */
export async function main(cfgFile: string, dbDir: string): Promise<CLoginServerApp> {
  const app = new CLoginServerApp(cfgFile, dbDir);
  try {
    await app.SetUp();
    return app;
  } catch (error) {
    app.CleanUp();
    throw error;
  }
}
