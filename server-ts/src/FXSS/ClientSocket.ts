/** Native source unit: FX/FxShop/ClientSocket.cpp. */
import { timeGetTime } from "../core/timeGetTime.ts";
import { CPacketSocket } from "../core/PacketSocket.ts";
import { PACKET_HEADER_TYPE_COUNT } from "../core/PacketHeaderConverter.ts";
import { CipherDegree, enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
} from "../core/PacketSocket.ts";
import { CUser } from "./User.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { DeleteShopSocket, DispatchShopClientPacket } from "./runtime/MainPoolRuntime.ts";

const INITIAL_IDLE_AGE_MS = 5_000;

/** CClientSocket — the 9801 client connection (CListenThread accept).
 *  Every accepted socket gets SetCipherDegree(2) (CFxShopApp::SetUp). */
export class CClientSocket extends CPacketSocket {
  /** CClientSocket::OnReceiveCompletionPacket guards the client links only
   *  (FxShop.exe.c:5890). */
  override m_fReceiveFloodGuard = true;
  protected override ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), disconnected.`);
  }

  protected override ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CClientSocket::PutPacket's wrapper switch (FxShop.exe.c:5705). */
  protected override ReportPutError(err: EnSocket): void {
    if (err === enSocket.kioNotConnected) console.error("Not-connected client socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet");
  }
  static override ms_nHeaderTypeCounter = 0;
  static ms_tblSN2Obj = new Map<number, CClientSocket>();

  m_nLocalSerialNo = 0;
  m_dwLastRTT = 0;
  m_dwIdleTime = (timeGetTime() - INITIAL_IDLE_AGE_MS) >>> 0;
  m_apUser: (CUser | null)[] = []; // +460
  m_nUserCount = 0; // +456
  m_nSelectedUserIdx = 0; // +464 (u16)
  m_strPeerAddress = ""; // CSocket::GetAddressString

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => DispatchShopClientPacket(packet, this),
    });
    this.m_szLogTag = "Shop";
    this.m_fClientLink = true;
    this.m_nLocalSerialNo = CClientSocket.ms_tblSN2Obj.size + 1;
    this.SetHeaderType(CClientSocket.ms_nHeaderTypeCounter % PACKET_HEADER_TYPE_COUNT);
    CClientSocket.ms_nHeaderTypeCounter++;
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
    this.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8); // CFxShopApp::SetUp — the client sockets are ciphered
    CClientSocket.ms_tblSN2Obj.set(this.m_nLocalSerialNo, this);
  }

  /** CClientSocket::AddNewUsers — the shop is single-user per socket. */
  AddNewUsers(n: number): void {
    this.m_apUser = [];
    for (let i = 0; i < n; i++) this.m_apUser.push(new CUser(this));
    this.m_nUserCount = n;
  }

  GetUser(i: number): CUser | null {
    return this.m_apUser[i] ?? null;
  }

  GetUserCount(): number {
    return this.m_nUserCount;
  }

  protected override OnClose(): void {
    DeleteShopSocket(this);
    for (const user of this.m_apUser) {
      if (!user) continue;
      CLocalUserTable.ms_pInstance?.Remove(user);
      user.m_pSocket = null;
    }
    this.m_apUser = [];
    this.m_nUserCount = 0;
    CClientSocket.ms_tblSN2Obj.delete(this.m_nLocalSerialNo);
    super.OnClose();
  }
}
