/** Native source unit: CX/CxCenter/CxCenterApp.cpp. */
import { CServerConfig } from "../core/ServerConfig.ts";
import { PacketLog } from "../core/PacketLog.ts";
import {
  MC_PACKET_NAMES_BY_SERVER_CLASS,
  CM_PACKET_NAMES_BY_SERVER_CLASS,
} from "../core/protocol/CenterProtocol.ts";
import { PACKET_NAME_TABLES } from "../core/protocol/PacketIDs.ts";
import { CLocalServerMan } from "./LocalServerMan.ts";
import { CListenThread } from "./ListenThread.ts";
import { CMonitorListenThread } from "./MonitorListenThread.ts";
import { CTimerThread } from "./TimerThread.ts";

/**
 * CCxCenterApp — native owner of the center setup/cleanup sequence.
 *
 * The original app derives from CApp and creates CLocalServerMan as a separate
 * singleton in SetUp; it is not a server manager subclass. The Bun port keeps
 * that ownership explicit through composition.
 */
export class CCxCenterApp {
  readonly localServerMan: CLocalServerMan;
  readonly listenThread: CListenThread;
  readonly monitorListenThread: CMonitorListenThread;
  readonly timerThread: CTimerThread;

  constructor(cfg: CServerConfig) {
    this.localServerMan = new CLocalServerMan(cfg);
    this.listenThread = new CListenThread(
      this.localServerMan,
      cfg.GetNumAttribute("CenterPort"),
    );
    this.monitorListenThread = new CMonitorListenThread(
      this.localServerMan,
      cfg.GetNumAttribute("CenterPort") + 1,
    );
    this.timerThread = new CTimerThread(this.localServerMan);

    PacketLog.Configure("Center");
    for (const [serverClass, table] of Object.entries(MC_PACKET_NAMES_BY_SERVER_CLASS)) {
      PacketLog.Register(`Center:${serverClass}`, "recv", table);
    }
    for (const [serverClass, table] of Object.entries(CM_PACKET_NAMES_BY_SERVER_CLASS)) {
      PacketLog.Register(`Center:${serverClass}`, "send", table);
    }
    PacketLog.Register("MON", "recv", ...PACKET_NAME_TABLES.MON.recv);
    PacketLog.Register("MON", "send", ...PACKET_NAME_TABLES.MON.send);
  }

  /** CCxCenterApp::SetUp — native order, omitting Windows-only plumbing. */
  SetUp(): void {
    this.localServerMan.Init();
    this.timerThread.Start();
    this.monitorListenThread.Start();
    this.listenThread.Start();
  }

  /**
   * CCxCenterApp::CleanUp starts by terminating the two listeners, then its
   * workers. Bun listeners close active sockets before the timer is stopped.
   */
  CleanUp(): void {
    this.listenThread.Stop();
    this.monitorListenThread.Stop();
    this.timerThread.Stop();
  }
}
