/** Native source unit: CX/CxUtil/ClientSocket.cpp. */
import { CPacketSocket } from "../core/PacketSocket.ts";
import { PACKET_HEADER_TYPE_COUNT } from "../core/PacketHeaderConverter.ts";
import { enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
} from "../core/PacketSocket.ts";
import { CUser } from "./User.ts";
import { DeleteUtilSocket, DispatchUtilClientPacket } from "./runtime/MainPoolRuntime.ts";

/** CClientSocket (CxUtil) — one connected admin tool. */
export class CClientSocket extends CPacketSocket {
  /** CClientSocket::OnReceiveCompletionPacket guards the client links
   *  (CxUtil.exe.c:17458) and reports the overflow like every other
   *  client-facing build. */
  override m_fReceiveFloodGuard = true;
  protected override ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), disconnected.`);
  }

  protected override ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CClientSocket::PutPacket's wrapper switch (CxUtil.exe.c:17261) — the
   *  invalid-packet line is FXUS's own "( = NULL ) packet: (%s)" shape. */
  protected override ReportPutError(err: EnSocket): void {
    const addr = this.bunSocket?.remoteAddress ?? "";
    if (err === enSocket.kioNotConnected) console.error("Not-connected client socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error(`tried to send invalid( = NULL ) packet: (${addr})`);
  }
  static ms_nLocalSerialNo = 1;
  /** dword_49F968 — the per-connection header-type counter. It starts at 0
   *  and is separate from the serial: the first client connection gets
   *  header type 0 (CxLogin.exe.c:9898, CxUtil.exe.c:17717). */
  static override ms_nHeaderTypeCounter = 0;
  m_nLocalSerialNo = 0; // +236
  m_apUser: CUser[] = []; // +476 (the array is 476, the count 472)
  m_nUserCount = 0; // +472

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      // the vtable routes completed packets into CMainPool::OnPacket
      onPacket: (_sock, packet) => DispatchUtilClientPacket(packet, this),
      onClose: () => DeleteUtilSocket(this),
    });
    this.m_szLogTag = "FXUS";
    this.m_fClientLink = true;
    // dword_49F968: the header type comes from the counter's PRE-increment
    // value (read the counter, THEN increment; SetHeaderType(counter % 16)) — the
    // first client connection gets header type 0.
    this.SetHeaderType(CClientSocket.ms_nHeaderTypeCounter % PACKET_HEADER_TYPE_COUNT);
    CClientSocket.ms_nHeaderTypeCounter++;
    this.m_nLocalSerialNo = CClientSocket.ms_nLocalSerialNo++;
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
  }

  /** CClientSocket::AddNewUsers — n fresh users REPLACE the old array. */
  AddNewUsers(count: number): void {
    if (count <= 0) {
      this.m_nUserCount = count;
      return;
    }
    this.m_apUser = [];
    for (let i = 0; i < count; i++) this.m_apUser.push(new CUser(this));
    this.m_nUserCount = count;
  }

  /** CClientSocket::GetUser(socket, i). */
  GetUser(i: number): CUser | null {
    return this.m_apUser[i] ?? null;
  }

  GetUserCount(): number {
    return this.m_nUserCount;
  }

  /** CClientSocket::ClearAttachedUsers. */
  ClearAttachedUsers(): void {
    this.m_apUser = [];
    this.m_nUserCount = 0;
  }
}
