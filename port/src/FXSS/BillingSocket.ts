/** Native source unit: FX/FxShop/BillingSocket.cpp.
 * Taiwan billing's socket overloads (FxShop 004050B0/00405360/00405550/004055E0).
 * Reuse the common byte FIFO, drain adapter and packet pump, NOT its game codec.
 */
import { CPacketSocket, type IPacketSocketHooks } from "../core/PacketSocket.ts";
import { CReceivedPacket, CSendPacket, enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import { PacketLog } from "../core/PacketLog.ts";
import {
  DecodePacketTw,
  EncodePacketTw,
  GetIncomingPacketLengthTw,
  GetOutgoingPacketLengthTw,
  TW_SOCKET_HEADER_CODE_MODIFIER,
  TW_SOCKET_HEADER_CODE_RCV,
  TW_SOCKET_HEADER_CODE_SND,
} from "./Packet.ts";
import { BILLING_PACKET_LOG_CONTEXT, BNB_TAIWAN_PacketFamily } from "../protocol/PacketIDs.ts";

export class CBillingSocketTw extends CPacketSocket {
  /** The native constructor flag at +240 controls CloseAll/overflow's exit.
   * CBillingProcess constructs its socket with 1 (00403780).
   */
  constructor(readonly m_fTerminateProcess = true, hooks?: Partial<IPacketSocketHooks>) {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, hooks);
    this.m_szLogTag = "Shop";
    this.m_szLogTable = BILLING_PACKET_LOG_CONTEXT.Taiwan;
    this.SetHeaderCode(
      TW_SOCKET_HEADER_CODE_RCV,
      TW_SOCKET_HEADER_CODE_SND,
      TW_SOCKET_HEADER_CODE_MODIFIER,
    ); // inherited native setup; Tw never reads/writes it
  }

  /** CBillingSocket::CloseAll (00405080), CMainSystem::TerminateProcess
   * (00418790): close first; fatal sockets ExitProcess(0), not reconnect.
   */
  CloseAll(): void {
    console.error("CloseAll called. terminate.");
    this.Close();
    if (this.m_fTerminateProcess) process.exit(0);
  }

  protected override ReportReceiveOverflow(): void {
    console.error("Socket receive buffer overflow on Billing Socket");
    this.CloseAll();
  }

  protected override ReportSendOverflow(): void {
    console.error("Billing Socket TW send buffer overflow, terminate process");
    this.Close();
    if (this.m_fTerminateProcess) process.exit(0);
  }

  protected override ReportSendFailure(): void {
    console.error("WriteFile failed on Billing, terminate process");
    this.CloseAll();
  }

  /** 00405360 and vtable 0047D624: invalid receive/too long/decode errors
   * call CloseAll (+100), NOT PostClosePacket. Invalid SEND does not close.
   */
  CheckResult(result: EnSocket, fSending: boolean): EnSocket {
    const address = this.bunSocket?.remoteAddress ?? "";
    switch (result) {
      case enSocket.kioNotConnected:
        console.error("Not-connected Billing socket TW tried to put packet.");
        break;
      case enSocket.kioInvalidPacket:
        if (fSending) {
          console.error("tried to send invalid( =\tNULL ) packet to local socket");
          break;
        }
        console.error(`Invalid( = NULL ) packet received from billing socket, close connection: [${address}]`);
        this.CloseAll();
        break;
      case enSocket.kioTooLongPacket:
        console.error(`Too long packet length read from billing socket, close connection: [${address}]`);
        this.CloseAll();
        break;
      case enSocket.kioSequencingError:
        console.error(`Error in billing packet sequencing, close connection: [${address}]`);
        this.CloseAll();
        break;
      case enSocket.kioDecodingError:
        console.error(`Error in local packet decoding(Maybe CRC Mismatch), close connection: [${address}]`);
        this.CloseAll();
        break;
      case enSocket.kioSendBufferOverflow:
        this.ReportSendOverflow();
        break;
    }
    return result;
  }

  // GetPacket already applies CheckResult; the common pump must not log twice.
  protected override ReportGetPacketError(): void {}

  override PutPacket(packet: CSendPacket): EnSocket {
    if (!this.m_bConnected) return this.CheckResult(enSocket.kioNotConnected, true);
    const outgoing = GetOutgoingPacketLengthTw(packet);
    if (outgoing <= 0) return this.CheckResult(enSocket.kioInvalidPacket, true);
    if (this.m_nSndCnt + outgoing > this.m_mbSndBuffer.length)
      return this.CheckResult(enSocket.kioSendBufferOverflow, true);
    if (!EncodePacketTw(packet, this.m_mbSndBuffer, this.m_nSndCnt))
      return this.CheckResult(enSocket.kioEncodingError, true);
    this.m_nSndCnt += outgoing;
    this.LogPacket("send", packet, packet.m_uOffset);
    return enSocket.kioOk;
  }

  override GetPacket(packet: CReceivedPacket): EnSocket {
    if (!this.m_bConnected) return this.CheckResult(enSocket.kioNotConnected, false);
    if (this.m_nRcvCnt === 0) return enSocket.kioNotReady;
    packet.SetCipherDegree(this.m_nCipherDegree);
    this.m_nLastRcvHeaderCode = this.m_mbRcvBuffer[0]!;
    const incoming = GetIncomingPacketLengthTw(packet, this.m_mbRcvBuffer, this.m_nRcvCnt);
    if (incoming === -1) return enSocket.kioNotReady;
    if (incoming === 0) return this.CheckResult(enSocket.kioInvalidPacket, false);
    if (incoming > this.m_nMaxPacketLen) {
      // Native decodes only the bytes actually buffered for this error path.
      DecodePacketTw(packet, this.m_mbRcvBuffer, this.m_nRcvCnt);
      return this.CheckResult(enSocket.kioTooLongPacket, false);
    }
    if (incoming > this.m_nRcvCnt) return enSocket.kioNotReady;
    if (!DecodePacketTw(packet, this.m_mbRcvBuffer, incoming))
      return this.CheckResult(enSocket.kioDecodingError, false);
    this.m_mbRcvBuffer.copyWithin(0, incoming, this.m_nRcvCnt);
    this.m_nRcvCnt -= incoming;
    this.LogPacket("recv", packet, packet.m_uLength);
    return enSocket.kioOk;
  }

  /** Native reads are capped by free receive-buffer space. Bun can deliver a
   * larger coalesced callback: pump it in bounded pieces so many valid frames
   * do not become a false overflow. An individual oversized frame still fails.
   */
  override OnReceive(data: Uint8Array): void {
    let offset = 0;
    while (this.m_bConnected && offset < data.length) {
      const available = this.m_mbRcvBuffer.length - this.m_nRcvCnt;
      if (available === 0) {
        this.ReportReceiveOverflow();
        return;
      }
      const end = Math.min(offset + available, data.length);
      super.OnReceive(data.subarray(offset, end));
      offset = end;
    }
  }

  private LogPacket(direction: "send" | "recv", packet: CSendPacket | CReceivedPacket, length: number): void {
    if (!PacketLog.ShowsInfra()) return;
    let table = this.m_szLogTable;
    if (direction === "send" && "m_nBillingPacketFamily" in packet) {
      if (packet.m_nBillingPacketFamily === BNB_TAIWAN_PacketFamily.Billing)
        table = BILLING_PACKET_LOG_CONTEXT.Billing;
      else if (packet.m_nBillingPacketFamily === BNB_TAIWAN_PacketFamily.Coupon)
        table = BILLING_PACKET_LOG_CONTEXT.Coupon;
    }
    PacketLog.Packet(this.LogPeer, this.m_szLogTag, direction, packet.m_nPacketType, packet.m_nCipherDegree,
      packet.m_pBlock.subarray(0, length), table);
  }
}
