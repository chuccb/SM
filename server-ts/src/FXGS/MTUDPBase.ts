/** Native source unit: common/MTUDPBase.cpp (FxServer.map: MTUDPBase.obj).
 *
 * The original queues validated unreliable frames through cHost; the Bun port
 * keeps the same ProcessIncomingData boundary but delivers each frame to the
 * dispatcher callback synchronously because Bun already serializes one UDP
 * socket's data callbacks.
 */
import { SplitDatagram, type HOSTHANDLE } from "../common/MTUDP.ts";

export type MTUDPFrameHandler = (payload: Uint8Array, host: HOSTHANDLE) => void;

export class MTUDPBase {
  m_nSocket: import("bun").udp.Socket<"buffer"> | null = null;
  m_nBytesRecv = 0;
  m_nBytesSend = 0;
  m_nIp = 0;
  m_nPort = 0;

  constructor(
    private readonly onFrame: MTUDPFrameHandler,
    readonly m_bAutoDeleteHost = true,
  ) {}

  /** MTUDPBase::ProcessIncomingData — validate the frame chain, then make
   * each unreliable payload available to CUDPPacketDispatcher. */
  protected ProcessIncomingData(datagram: Uint8Array, host: HOSTHANDLE): void {
    this.m_nBytesRecv += datagram.byteLength;
    for (const frame of SplitDatagram(datagram, host, "[GS]")) {
      this.onFrame(frame.payload, frame.host);
    }
  }

  /** MTUDPBase::Cleanup — Bun owns no worker thread or native host objects,
   * so closing the UDP handle is the complete port-side equivalent. */
  Cleanup(): void {
    this.m_nSocket?.close();
    this.m_nSocket = null;
    this.m_nIp = 0;
    this.m_nPort = 0;
  }
}
