/** Native source unit: CX/CxRelay/CxRelayApp.cpp. */
import { CServerConfig, CXRELAY_STR_KEYS } from "../core/ServerConfig.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { MTUDPServer } from "./MTUDPServer.ts";
import { CTimerThread } from "./TimerThread.ts";
import { CUDPPacketDispatcher } from "./UDPPacketDispatcher.ts";

/** CCxRelayApp — native owner of the relay setup sequence. */
export class CCxRelayApp {
  server: MTUDPServer | null = null;
  dispatcher: CUDPPacketDispatcher | null = null;
  timerThread: CTimerThread | null = null;

  constructor(private readonly cfgFile: string) {}

  /** CCxRelayApp::SetUp. */
  async SetUp(): Promise<void> {
    const { cfgFile } = this;
    const cfg = new CServerConfig(CXRELAY_STR_KEYS);
    cfg.Init(cfgFile);
    CServerConfig.ms_pInstance = cfg;
    PacketLog.Configure("Relay");

    const timerThread = new CTimerThread();
    this.timerThread = timerThread;
    timerThread.Run(); // CTimerThread::Resume

    const server = new MTUDPServer();
    this.server = server;
    await server.Startup(cfg); // CCxRelayApp::SetUp — MTUDPServer vtbl+24 (Startup)
    server.Run(); // StartupBase resumes the native listening thread

    const dispatcher = new CUDPPacketDispatcher(server);
    this.dispatcher = dispatcher;
    dispatcher.Run(); // CUDPPacketDispatcher::Resume
  }

  /** CCxRelayApp::CleanUp — active Bun resources in native termination order. */
  CleanUp(): void {
    this.server?.Cleanup();
    this.dispatcher?.Terminate();
    this.timerThread?.Stop();
    this.server = null;
    this.dispatcher = null;
    this.timerThread = null;
  }
}

/** Port entry: Bun's event loop replaces the native blocking CApp::Run. */
export async function main(cfgFile: string): Promise<CCxRelayApp> {
  const app = new CCxRelayApp(cfgFile);
  try {
    await app.SetUp();
    return app;
  } catch (error) {
    app.CleanUp();
    throw error;
  }
}
