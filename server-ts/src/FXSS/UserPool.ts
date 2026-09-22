/** Native source unit: FX/FxShop/UserPool.cpp. */
import { timeGetTime } from "../core/timeGetTime.ts";
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { S2C_ShopPacket, C2S_ShopPacket } from "../core/protocol/PacketIDs.ts";
import type { CUser } from "./User.ts";
import type { CClientSocket } from "./ClientSocket.ts";

const TIMEOUT_SWEEP_TICKS = 0x4b;
const SOCKET_RTT_TIMEOUT_MS = 0x7530;

/** CUserPool — the socket/user sets plus the 20-RTT fallback dispatch. */
export class CUserPool {
  private static m_nTimerCount = 0;

  m_setSocket = new Set<CClientSocket>();
  m_setUser = new Set<CUser>();

  /** CUserPool::AddSocket (:421630) — a duplicate insert reports. */
  AddSocket(socket: CClientSocket): void {
    if (this.m_setSocket.has(socket)) console.error(`[Shop] Try to insert already resident socket in userpool`);
    this.m_setSocket.add(socket);
  }

  DelSocket(socket: CClientSocket): void {
    this.m_setSocket.delete(socket);
  }

  /** CUserPool::AddNewSocket (:29679 shop twin of the GS guard) — a user
   *  already resident aborts the seat: report, roll back the users seated
   *  so far, refuse the socket. */
  AddNewSocket(socket: CClientSocket): number {
    const added: CUser[] = [];
    for (const user of socket.m_apUser) {
      if (!user) continue;
      if (this.m_setUser.has(user)) {
        console.error(`[Shop] Try to insert already resident user in user room`);
        for (const u of added) this.m_setUser.delete(u);
        return 0;
      }
      this.m_setUser.add(user);
      added.push(user);
    }
    this.AddSocket(socket);
    this.OnAddNewSocket(socket);
    return 1;
  }

  /** CUserPool::DeleteSocket */
  DeleteSocket(socket: CClientSocket): number {
    for (const user of socket.m_apUser) {
      if (user && !this.m_setUser.has(user)) return 0;
    }
    for (const user of socket.m_apUser) if (user) this.m_setUser.delete(user);
    this.OnDeleteSocket(socket);
    this.DelSocket(socket);
    return 1;
  }

  OnAddNewSocket(_socket: CClientSocket): void {}

  OnDeleteSocket(_socket: CClientSocket): void {}

  /** CUserPool::OnPacket — the default branch: packet 20 RTT echo only.
   *  [E4 t] → client 20 [E4 t][E4 now]. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() !== C2S_ShopPacket.OnEstimateRTT) return;
    const packet = new CSendPacket(S2C_ShopPacket.OnEstimateRTTRes);
    const t = n.Decode4();
    const now = timeGetTime();
    packet.Encode4(t);
    packet.Encode4(now);
    socket.m_dwLastRTT = now;
    socket.SendPacket(packet);
  }

  /** CUserPool::CreateSocketList + SendAll — snapshot then broadcast. */
  static CreateSocketList(pool: CUserPool): CClientSocket[] {
    return [...pool.m_setSocket];
  }

  static SendAll(sockets: CClientSocket[], packet: CSendPacket): void {
    for (const socket of sockets) socket.SendPacket(packet);
  }

  /** CUserPool::OnTimer (:421030) — every call bumps the shared BSS counter
   *  (dword_498368) and the sweep fires at %0x4B: 75 ticks × 400 ms = 30 s.
   *  DisconnectTimeoutSocket (:29065) kicks sockets idle past 0x7530 ms —
   *  the Shop's idle gate is 30 s, not the GS's 0x9C40. */
  OnTimer(): void {
    if (++CUserPool.m_nTimerCount % TIMEOUT_SWEEP_TICKS === 0) this.DisconnectTimeoutSocket();
  }

  /** CUserPool::DisconnectTimeoutSocket (:29065) — 0x7530 ms without RTT. */
  DisconnectTimeoutSocket(): void {
    const now = timeGetTime();
    for (const socket of [...this.m_setSocket]) {
      if (((now - socket.m_dwIdleTime) >>> 0) > SOCKET_RTT_TIMEOUT_MS) {
        console.error(`[Shop] Disconnect Timeout Socket [${socket.m_apUser[0]?.GetName() ?? "NULL"}]`);
        socket.Close();
      }
    }
  }
}
