/** Native source unit: CX/CxLogin/UserPool.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import { C2S_LoginPacket, S2C_LoginResponsePacket } from "../protocol/PacketIDs.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";

const TIMEOUT_SWEEP_TICKS = 0x4b;
const SOCKET_RTT_TIMEOUT_MS = 0x7530;

/** CUserPool — common login-client socket/user ownership and RTT dispatch. */
export class CUserPool {
  private static m_nTimerCount = 0;

  readonly m_setUser = new Set<CUser>();
  readonly m_setSocket = new Set<CClientSocket>();

  protected OnAddNewUser(_user: CUser): void {}
  protected OnDeleteUser(_user: CUser): void {}

  AddNewUser(user: CUser): number {
    if (this.m_setUser.has(user)) {
      console.error("[LS] Try to insert already resident user in user room");
      return 0;
    }
    this.m_setUser.add(user);
    this.OnAddNewUser(user);
    return 1;
  }

  DeleteUser(user: CUser): number {
    if (!this.m_setUser.delete(user)) return 0;
    this.OnDeleteUser(user);
    return 1;
  }

  FindUser(user: CUser): boolean {
    return this.m_setUser.has(user);
  }

  AddSocket(socket: CClientSocket): number {
    if (this.m_setSocket.has(socket)) {
      console.error("[LS] Try to insert already resident socket in userpool");
    } else {
      this.m_setSocket.add(socket);
    }
    return 1;
  }

  DelSocket(socket: CClientSocket): number {
    return this.m_setSocket.delete(socket) ? 1 : 0;
  }

  CreateSocketList(): CClientSocket[] {
    return [...this.m_setSocket];
  }

  static SendAll(sockets: Iterable<CClientSocket>, packet: CSendPacket): void {
    for (const socket of sockets) socket.SendPacket(packet);
  }

  /** CUserPool::OnTimer — every 75 login timer ticks. */
  OnTimer(): void {
    if (++CUserPool.m_nTimerCount % TIMEOUT_SWEEP_TICKS === 0) this.DisconnectTimeoutSocket();
  }

  /** CUserPool::DisconnectTimeoutSocket — 30-second RTT timeout. */
  DisconnectTimeoutSocket(): void {
    const now = timeGetTime();
    for (const socket of [...this.m_setSocket]) {
      if (((now - socket.m_dwLastRTT) >>> 0) > SOCKET_RTT_TIMEOUT_MS) {
        console.log(`Disconnect Timeout Socket: ${socket.bunSocket?.remoteAddress ?? ""}`);
        socket.PostClosePacket();
      }
    }
  }

  /** CUserPool::OnPacket — inherited packet-20 fallback. */
  OnPacket(packet: CReceivedPacket, socket: CClientSocket): void {
    if (packet.Decode1() === C2S_LoginPacket.OnEstimateRTT) this.OnEstimateRTT(packet, socket);
  }

  /** CUserPool::OnEstimateRTT. */
  protected OnEstimateRTT(packet: CReceivedPacket, socket: CClientSocket): void {
    const response = new CSendPacket(S2C_LoginResponsePacket.OnEstimateRTTRes, CipherDegree.kPacketEncryptedCRC8);
    const clientStamp = packet.Decode4();
    const now = timeGetTime();
    response.Encode4(clientStamp);
    response.Encode4(now);
    socket.m_dwLastRTT = now;
    socket.SendPacket(response);
  }
}
