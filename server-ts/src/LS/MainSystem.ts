/** Native source unit: CX/CxLogin/MainSystem.cpp. */
import { CServerConfig } from "../core/ServerConfig.ts";
import { CSendPacket, CipherDegree } from "../core/Packet.ts";
import { CENTER_VERSION, CONN_HELLO_VERSION, SVRCLASS_LOGIN } from "../protocol/CenterProtocol.ts";
import { S2C_LoginNoticePacket } from "../protocol/PacketIDs.ts";
import type { CClientSocket } from "./ClientSocket.ts";

/**
 * CMainSystem (CxLogin.exe.c:16669 ctor, 16362 OnConnEstablished) — the LS's
 * accept-greeter.  The ctor reads the UrlPatchNumber/UrlPatch[i] config family
 * into a string table; OnConnEstablished sends the accept packet 0
 * ([E2 3][E2 7][E4 headerType][EStr table entry]) round-robin per connection
 * and the accept path then arms the socket's cipher degree (CListenThread::Proc
 * CxLogin.exe.c:12021-12025: hello → SetCipherDegree(2) → IssueReceive).
 */
export class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  m_astrUrlPatch: string[] = []; // this+1..+3 (vector<string>)
  m_nUrlPatchIdx = 0; // this+4

  constructor(cfg: CServerConfig) {
    CMainSystem.ms_pInstance = this;
    const n = cfg.GetNumAttribute("UrlPatchNumber");
    for (let i = 0; i < n; i++) this.m_astrUrlPatch.push(cfg.GetAttribute(`UrlPatch${i}`));
  }

  OnConnEstablished(socket: CClientSocket): void {
    const packet = new CSendPacket(S2C_LoginNoticePacket.OnConnect, CipherDegree.kPacketRaw);
    packet.Encode2(CENTER_VERSION);
    packet.Encode2(CONN_HELLO_VERSION[SVRCLASS_LOGIN]);
    packet.Encode4(socket.m_nHeaderType);
    // round-robin: idx = (idx + 1) % count, then send table[idx]
    if (this.m_astrUrlPatch.length > 0) {
      this.m_nUrlPatchIdx = (this.m_nUrlPatchIdx + 1) % this.m_astrUrlPatch.length;
      packet.EncodeStr(this.m_astrUrlPatch[this.m_nUrlPatchIdx]!);
    } else {
      packet.EncodeStr("");
    }
    socket.SendPacket(packet);
  }
}
