/** Native source unit: FX/FxServer/UserPool.cpp. */
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { S2C_GamePacket, C2S_GameLobbyPacket } from "../core/protocol/PacketIDs.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import { RTT_HASH, RTT_HASH_INV, RTT_MIN_INTERVAL, SOCKET_TIMEOUT } from "./Defs.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";

const TIMEOUT_SWEEP_CALLS = 0x258;

/** CUserPool — the socket/user set shared by the connect and channel pools. */
export class CUserPool {
  private static m_nTimerCount = 0;

  m_setSocket = new Set<CClientSocket>();
  m_setUser = new Set<CUser>();

  /** CUserPool::AddSocket */
  AddSocket(socket: CClientSocket): void {
    this.m_setSocket.add(socket);
  }

  /** CUserPool::DelSocket */
  DelSocket(socket: CClientSocket): void {
    this.m_setSocket.delete(socket);
  }

  /** CUserPool::AddNewSocket — seat the users, then OnAddNewSocket.  The
   *  set insert failing on an already-resident user aborts the whole seat:
   *  the users added so far are erased and the socket is refused (:29641). */
  AddNewSocket(socket: CClientSocket): number {
    const added: CUser[] = [];
    for (const user of socket.m_apUser) {
      if (!user) continue;
      if (this.m_setUser.has(user)) {
        console.error(`[GS] Try to insert already resident user in user room`);
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

  /** CUserPool::DeleteSocket — 0 when a user was not resident. */
  DeleteSocket(socket: CClientSocket): number {
    for (const user of socket.m_apUser) {
      if (user && !this.m_setUser.has(user)) return 0;
    }
    for (const user of socket.m_apUser) {
      if (user) this.m_setUser.delete(user);
    }
    this.OnDeleteSocket(socket);
    this.DelSocket(socket);
    return 1;
  }

  /** CUserPool::OnAddNewSocket — a no-op in the base. */
  OnAddNewSocket(_socket: CClientSocket): void {}

  /** CUserPool::OnDeleteSocket — a no-op in the base. */
  OnDeleteSocket(_socket: CClientSocket): void {}

  /** CUserPool::OnPacket — the 20 RTT fallback with the GS anti-cheat checks. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() !== C2S_GameLobbyPacket.OnEstimateRTT) return;
    const packet = new CSendPacket(S2C_GamePacket.OnEstimateRTTRes);
    const rttValue = n.Decode4(); // the client's stamp, echoed verbatim
    const hash = n.Decode4();
    const now = timeGetTime();
    packet.Encode4(rttValue);
    packet.Encode4(now);
    // the official stamps the socket's idle dword on EVERY RTT probe before
    // any check (FxServer.exe.c:29295 `M_start[18] = Time`) — it is exactly
    // the field DisconnectTimeoutSocket sweeps on, in the same timeGetTime
    // domain the echo carries to the client.
    socket.m_dwIdleTime = timeGetTime();
    const last = socket.m_dwLastRTT;
    socket.m_dwLastRTT = now;
    socket.SendPacket(packet);
    if (last !== 0 && ((now - last) >>> 0) < RTT_MIN_INTERVAL) {
      const name = socket.GetUser(0)?.GetName() ?? socket.bunSocket?.remoteAddress ?? "";
      console.error(`[GS] Hacking Suspected [${name}] : SpeedHack. Disconnect.`);
      socket.PostClosePacket();
      return;
    }
    if (hash !== RTT_HASH && hash !== RTT_HASH_INV) {
      const name = socket.GetUser(0)?.GetName() ?? socket.bunSocket?.remoteAddress ?? "";
      console.error(`[GS] Hacking Suspected [${name}] : Memory Modification. Disconnect. Received Hash Value : [${hash.toString(16)}]`);
      socket.PostClosePacket();
    }
  }

  /** CUserPool::CreateSocketList (FxServer.exe.c:29563) — snapshot the pool
   *  into a broadcast list; fLobbyOnly keeps the lobby-stage sockets only. */
  CreateSocketList(fLobbyOnly: number): CClientSocket[] {
    const list: CClientSocket[] = [];
    for (const socket of this.m_setSocket) {
      if (fLobbyOnly !== 0 && socket.m_nPoolType !== 1) continue;
      list.push(socket);
    }
    return list;
  }

  /** CUserPool::SendAll (FxServer.exe.c:29361) — the FlushModifiedInfo
   *  broadcast: walk the pre-built list, and a not-connected zombie only
   *  leaves the LIST (report + PostClosePacket), never the pool. */
  static SendAll(packet: CSendPacket, sockets: CClientSocket[]): void {
    for (const socket of [...sockets]) {
      if (socket.m_bConnected) {
        socket.SendPacket(packet);
        continue;
      }
      console.error(`[GS] Not connected socket (${socket.bunSocket?.remoteAddress ?? ""}) in user pool. Post Close Packet.`);
      socket.PostClosePacket();
      sockets.splice(sockets.indexOf(socket), 1);
    }
  }

  /** CUserPool::OnTimer (:29605) — every call bumps the ONE shared BSS
   *  counter (dword_4AF7B8, +2 per CTimerThreadNormal tick) and the sweep
   *  fires at %0x258 — 300 ticks = 120 s with both pools wired. */
  OnTimer(): void {
    if (++CUserPool.m_nTimerCount % TIMEOUT_SWEEP_CALLS === 0) this.DisconnectTimeoutSocket();
  }

  /** CUserPool::DisconnectTimeoutSocket (:29397) — 0x9C40 ms without RTT,
   *  then the count summary Report. */
  DisconnectTimeoutSocket(): void {
    const now = timeGetTime();
    let count = 0;
    for (const socket of [...this.m_setSocket]) {
      if (((now - socket.m_dwIdleTime) >>> 0) > SOCKET_TIMEOUT) {
        console.error(`[GS] Disconnect timeout socket (${socket.GetInfoStr()})`);
        socket.PostClosePacket();
        count++;
      }
    }
    if (count > 0) console.log(`[GS] Disconnect time-out users: (${count})`);
  }
}
