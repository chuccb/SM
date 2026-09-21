/** Native source unit: CX/CxCenter/MonitorSocket.cpp. */
import { CPacketSocket } from "../core/PacketSocket.ts";
import { CReceivedPacket, CSendPacket, enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import { MONITOR_HEADER_CODE_RCV, MONITOR_HEADER_CODE_SND, MONITOR_HEADER_CODE_MODIFIER, MONITOR_SEQ, MONITOR_SEQ_DELTA } from "../protocol/CenterProtocol.ts";
import { Center2Monitor_Packet, Monitor2Center_Packet } from "../protocol/PacketIDs.ts";
import type { CLocalServer } from "./LocalServer.ts";
import type { CGlobalUserTable } from "./GlobalUserTable.ts";

/** Port-side read model consumed by the native monitor socket. */
export interface MonitorHost {
  readonly globalUserTable: CGlobalUserTable;
  readonly servers: CLocalServer[];
}

/** CMonitorSocket (center) — SetHeaderCode(102,102,231), no rolling seq (CxCenter.exe.c:16424). */
export class CMonitorSocket extends CPacketSocket {
  /** "Socket receive buffer overflow(addr), PostClosePacket called"
   *  (CxCenter.exe.c:16400); the monitor link has no flood ring.  NB: the
   *  original also re-stamps +240 = GetTickCount() on every receipt
   *  (:16404) — a write-only liveness mark with no reader in CxCenter, so
   *  nothing to port. */
  protected override ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), PostClosePacket called`);
  }

  /** "Socket send buffer overflow, close connection: (addr)"
   *  (CxCenter.exe.c:16308). */
  protected override ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CMonitorSocket::PutPacket's wrapper switch (CxCenter.exe.c:16295). */
  protected override ReportPutError(err: EnSocket): void {
    if (err === enSocket.kioNotConnected) console.error("Not-connected monitor socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet to local socket");
  }

  /** CMonitorSocket::GetPacket's failure family (CxCenter.exe.c:16236) — the
   *  local-link wording again. */
  protected override ReportInvalidPacketLine(addr: string): void {
    console.error(`Invalid( = NULL ) packet received from local socket, close connection: [${addr}]`);
  }
  protected override ReportTooLongPacketLine(addr: string, id: number): void {
    console.error(`Too long packet length read from local socket, close connection: [${addr}], packet id[${id}]`);
  }
  protected override ReportSequencingErrorLine(addr: string): void {
    console.error(`Error in local packet sequencing, close connection: [${addr}]`);
  }
  protected override ReportDecodingErrorLine(addr: string): void {
    console.error(`Error in local packet decoding(Maybe CRC Mismatch), close connection: [${addr}]`);
  }

  constructor(private center: MonitorHost) {
    super(1024, 1024, {
      onPacket: (_sock, packet) => this.OnPacket(packet),
    });
    this.m_szLogTag = "Center";
    this.m_szLogTable = "MON";
    this.SetHeaderCode(MONITOR_HEADER_CODE_RCV, MONITOR_HEADER_CODE_SND, MONITOR_HEADER_CODE_MODIFIER);
    this.SetSequence(MONITOR_SEQ, MONITOR_SEQ, MONITOR_SEQ_DELTA, MONITOR_SEQ_DELTA);
  }

  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case Monitor2Center_Packet.OnRequestCurrentUserStat:
        this.OnRequestCurrentUserStat();
        return;
      case Monitor2Center_Packet.OnRequestSvrState:
        this.OnRequestSvrState();
        return;
      default:
        return;
    }
  }

  OnRequestCurrentUserStat(): void {
    const packet = new CSendPacket(Center2Monitor_Packet.OnRequestCurrentUserStat);
    packet.Encode4(this.center.globalUserTable.userTable.size);
    packet.Encode4(this.center.globalUserTable.m_nDailyPeakUsers);
    this.SendPacket(packet);
  }

  OnRequestSvrState(): void {
    const packet = new CSendPacket(Center2Monitor_Packet.OnRequestSvrState);
    const all = this.center.servers;
    packet.Encode4(all.length);
    for (const s of all) {
      packet.Encode1(s.nServerClass);
      packet.Encode2(s.nSvrIdx);
      packet.EncodeStr(s.m_strName);
      packet.Encode4(s.socket ? s.nConnNo : -1);
    }
    this.SendPacket(packet);
  }
}
