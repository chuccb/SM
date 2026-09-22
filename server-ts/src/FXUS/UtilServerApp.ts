/** Native source unit: CX/CxUtil/UtilServerApp.cpp. */
import { CServerConfig, CXUTIL_STR_KEYS } from "../core/ServerConfig.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { PACKET_NAME_TABLES } from "../core/protocol/PacketIDs.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { CMainPool } from "./MainPool.ts";
import { CMainSystem } from "./MainSystem.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { CTimerThread } from "./TimerThread.ts";
import { CListenThread } from "./ListenThread.ts";

/** CListenThread::Proc — htons(0x1FC0); cfg ServerPort is dead config. */
const LISTEN_PORT = 0x1fc0;

/** CUtilServerApp — native owner of the CxUtil setup sequence. */
export class CUtilServerApp {
  mainSystem: CMainSystem | null = null;
  localUserTable: CLocalUserTable | null = null;
  mainPool: CMainPool | null = null;
  centerProcess: CCenterProcess | null = null;
  timerThread: CTimerThread | null = null;
  listenThread: CListenThread | null = null;

  constructor(private readonly cfgFile: string) {}

  /** CUtilServerApp::SetUp. */
  async SetUp(): Promise<void> {
    const { cfgFile } = this;
    const cfg = new CServerConfig(CXUTIL_STR_KEYS);
    cfg.Init(cfgFile);
    CServerConfig.ms_pInstance = cfg;

    PacketLog.Configure("FXUS");
    PacketLog.Register("FXUS", "recv", ...PACKET_NAME_TABLES.FXUS.recv);
    PacketLog.Register("FXUS", "send", ...PACKET_NAME_TABLES.FXUS.send);

    const mainSystem = new CMainSystem();
    const localUserTable = new CLocalUserTable();
    const mainPool = new CMainPool();
    const centerProcess = new CCenterProcess();
    this.mainSystem = CMainSystem.ms_pInstance = mainSystem;
    this.localUserTable = CLocalUserTable.ms_pInstance = localUserTable;
    this.mainPool = CMainPool.ms_pInstance = mainPool;
    this.centerProcess = CCenterProcess.ms_pInstance = centerProcess;

    await centerProcess.Init(cfg);
    this.timerThread = new CTimerThread(mainPool);
    this.timerThread.Start();

    this.listenThread = new CListenThread(LISTEN_PORT, mainSystem);
    this.listenThread.Start();
  }

  /** CUtilServerApp::CleanUp — active Bun resources in native order. */
  CleanUp(): void {
    this.listenThread?.Stop();
    this.timerThread?.Stop();
    this.centerProcess?.Stop();
    if (CMainPool.ms_pInstance === this.mainPool) CMainPool.ms_pInstance = null;
    if (CLocalUserTable.ms_pInstance === this.localUserTable) CLocalUserTable.ms_pInstance = null;
    if (CMainSystem.ms_pInstance === this.mainSystem) CMainSystem.ms_pInstance = null;
    this.listenThread = null;
    this.timerThread = null;
    this.centerProcess = null;
    this.mainPool = null;
    this.localUserTable = null;
    this.mainSystem = null;
  }
}

/** Port entry: Bun's event loop replaces the native blocking CApp::Run. */
export async function main(cfgFile: string): Promise<CUtilServerApp> {
  const app = new CUtilServerApp(cfgFile);
  try {
    await app.SetUp();
    return app;
  } catch (error) {
    app.CleanUp();
    throw error;
  }
}
