/** Native source unit: CX/CxUtil/UserPool.cpp. */
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { UTIL_ClientReceivedPacket, UTIL_ClientSend } from "../protocol/PacketIDs.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";

const POOL_MAINTENANCE_TICKS = 0x4b;

/** CUserPool — the connected tool sockets and their attached identities. */
export class CUserPool {
  private static m_nTimerCount = 0;

  m_setUser = new Set<CUser>();
  m_setSocket = new Set<CClientSocket>();

  /** CUserPool::AddNewSocket — seat every attached user atomically. */
  AddNewSocket(socket: CClientSocket): number {
    const added: CUser[] = [];
    for (const user of socket.m_apUser) {
      if (!user) continue;
      if (this.m_setUser.has(user)) {
        console.error("[Util] Try to insert already resident user in user room");
        for (const seated of added) this.m_setUser.delete(seated);
        return 0;
      }
      this.m_setUser.add(user);
      added.push(user);
    }
    if (this.m_setSocket.has(socket)) {
      console.error("[Util] Try to insert already resident socket in userpool");
    }
    this.m_setSocket.add(socket);
    this.OnAddNewSocket(socket);
    return 1;
  }

  /** CUserPool::OnAddNewSocket — a no-op in the base. */
  OnAddNewSocket(_socket: CClientSocket): void {}

  /** CUserPool::DelSocket. Native FXUS leaves local-table rows resident. */
  DelSocket(socket: CClientSocket): void {
    this.m_setSocket.delete(socket);
  }

  /** CUserPool::SendAll — every connected tool. */
  SendAll(packet: CSendPacket): void {
    for (const socket of this.m_setSocket) socket.SendPacket(packet);
  }

  /** CUserPool::OnPacket — the packet-20 RTT fallback dispatch. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() === UTIL_ClientReceivedPacket.OnEstimateRTT) this.OnEstimateRTT(n, socket);
  }

  /** CUserPool::OnEstimateRTT (20) — echo the client stamp. */
  OnEstimateRTT(n: CReceivedPacket, socket: CClientSocket): void {
    const packet = new CSendPacket(UTIL_ClientSend.OnEstimateRTTRes);
    packet.Encode4(n.Decode4());
    socket.SendPacket(packet);
  }

  /** CUserPool::OnTimer — the native 75-tick pool-lock maintenance gate.
   * JavaScript's single event loop needs no equivalent critical section. */
  OnTimer(): void {
    CUserPool.m_nTimerCount = (CUserPool.m_nTimerCount + 1) % POOL_MAINTENANCE_TICKS;
  }
}
