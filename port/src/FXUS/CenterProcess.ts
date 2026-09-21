/** Native source unit: CX/CxUtil/CenterProcess.cpp. */
import { CServerConfig } from "../core/ServerConfig.ts";
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { CLocalSocket } from "../shared/LocalSocket.ts";
import { CM_UtilServerPacket, SVRCLASS_UTIL } from "../protocol/CenterProtocol.ts";
import { S2C_UtilPacket } from "../protocol/PacketIDs.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { BroadcastUtilPacket, SendUtilUserDetail } from "./MainPoolRuntime.ts";
import { CMainSystem } from "./MainSystem.ts";

/** CCenterProcess — the util's center link (class 99). */
export class CCenterProcess {
  static ms_pInstance: CCenterProcess | null = null;

  m_cLocalSocket = new CLocalSocket({
    // the recv loop pumps every parsed packet into CCenterProcess::OnPacket
    onPacket: (_sock, packet) => this.OnPacket(packet),
    onClose: () => {
      console.error("LocalSocket connection closed from center server, terminate process.");
      process.exit(0);
    },
  });

  /** CCenterProcess::SendPacket — to the center over the local socket. */
  SendPacket(packet: CSendPacket): void {
    this.m_cLocalSocket.SendToCenter(packet);
  }

  /** Port-side destruction of the owned center transport. */
  Stop(): void {
    this.m_cLocalSocket.hooks.onClose = () => {};
    this.m_cLocalSocket.Close();
    if (CCenterProcess.ms_pInstance === this) CCenterProcess.ms_pInstance = null;
  }

  /**
   * CCenterProcess::Init — the "Try to connect center server." loop: retry
   * every 3 s until the greeting + identify ([99][idx^0x77][E2 5][E2 3])
   * succeed, then report "Connection to Center Server established".
   */
  async Init(cfg: CServerConfig): Promise<void> {
    // the 3 s retry loop lives in CLocalSocket.ConnectToCenter (CxUtil.exe.c:15596)
    await this.m_cLocalSocket.ConnectToCenter(
      cfg.GetAttribute("CenterIP"),
      cfg.GetNumAttribute("CenterPort"),
      SVRCLASS_UTIL,
      cfg.GetServerIdx(),
      // gameVersion/clientVersion default from S2S GAME_VERSION/CLIENT_VERSION
      // (CxUtil.exe.c:15626 — [E2 5][E2 3])
    );
    console.log("[FXUS] Connection to Center Server established");
  }

  /** CCenterProcess::OnPacket — 8 broadcast, 10 user result, 12 FXAttr. */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case CM_UtilServerPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n);
        break;
      case CM_UtilServerPacket.OnUserChannelResult:
        this.OnUserChannelResult(n);
        break;
      case CM_UtilServerPacket.OnInitialSvrAttr:
        CMainSystem.ms_pInstance?.OnInitialSvrAttr(n);
        break;
      default:
        return;
    }
  }

  /**
   * CCenterProcess::OnAdminNotifyMsg (CM 8) — [EStr] rebroadcast to every
   * tool under id 26.
   */
  OnAdminNotifyMsg(n: CReceivedPacket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(S2C_UtilPacket.OnAdminNotifyMsg);
    packet.EncodeStr(str);
    BroadcastUtilPacket(packet);
  }

  /**
   * CCenterProcess::OnUserChannelResult (CM 10) — [E4 serial][EStr][E1][E4];
   * the answer rides packet 64 to the tool that asked.
   */
  OnUserChannelResult(n: CReceivedPacket): void {
    const serial = n.Decode4();
    const str = n.DecodeStr();
    const userType = n.Decode1();
    const sessionIdx = n.Decode4();
    const User = CLocalUserTable.ms_pInstance?.FindUserFromGlobalSerialNo(serial);
    if (User) SendUtilUserDetail(User, str, userType, sessionIdx);
  }
}
