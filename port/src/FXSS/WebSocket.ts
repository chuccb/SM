/** Native source unit: FX/FxShop/WebSocket.cpp. */
import { CPacketSocket } from "../core/PacketSocket.ts";
import { enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
} from "../protocol/PacketIDs.ts";
import { CMainPool } from "./MainPool.ts";

/** CWebSocket — the ServerPort+1 web-mall listener socket.  The framing is
 *  the standard CPacketSocket one; the first packet is OnVerifyKey. */
export class CWebSocket extends CPacketSocket {
  /** CWebSocket::OnReceiveCompletionPacket runs the same 50-stamp receive
   *  flood ring and the "(%s), disconnected." overflow report as the client
   *  sockets (FxShop.exe.c:30457); its PutPacket reports the send-side
   *  overflow with the same "(%s)" shape (:30301). */
  override m_fReceiveFloodGuard = true;
  protected override ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), disconnected.`);
  }

  protected override ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CWebSocket::PutPacket's wrapper switch (FxShop.exe.c:30290) — the
   *  client shapes. */
  protected override ReportPutError(err: EnSocket): void {
    if (err === enSocket.kioNotConnected) console.error("Not-connected client socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet");
  }
  static ms_tblSerialNo2Socket = new Map<number, CWebSocket>();

  m_nLocalSerialNo = 0;
  m_bVerified = 0;

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => {
        const pool = CMainPool.ms_pInstance;
        if (!pool) return;
        if (!this.m_bVerified) {
          pool.OnVerifyKey(packet, this);
          this.m_bVerified = 1;
          return;
        }
        // post-verify web traffic (charge receipts) — logged, no in-game effect
        console.log(`[Shop] web packet type ${packet.m_nPacketType}`);
      },
    });
    this.m_szLogTag = "Shop";
    this.m_fClientLink = true;
    // CWebSocket::CWebSocket (30541) — the same header/sequence set as the
    // client sockets; the (Web) accept path does NOT raise the cipher degree.
    this.SetHeaderCode(
      CLIENTSOCKET_HEADER_CODE_RCV,
      CLIENTSOCKET_HEADER_CODE_SND,
      CLIENTSOCKET_HEADER_CODE_MODIFIER,
    );
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
    this.m_nLocalSerialNo = 1 + CWebSocket.ms_tblSerialNo2Socket.size;
    CWebSocket.ms_tblSerialNo2Socket.set(this.m_nLocalSerialNo, this);
  }

  /** the raw verify reply (4 bytes, no packet header) */
  override SendBuffer(buf: ArrayBuffer | Uint8Array): EnSocket {
    return super.SendBuffer(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  }

  protected override OnClose(): void {
    for (const [sn, s] of CWebSocket.ms_tblSerialNo2Socket) if (s === this) CWebSocket.ms_tblSerialNo2Socket.delete(sn);
    super.OnClose();
  }
}
