/** Native source unit: FX/FxServer/UdpLossRegulator.cpp. */
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { S2C_GamePacket } from "../core/protocol/PacketIDs.ts";
import { MAX_SESSION_SLOTS, UDP_REGULATE_DELAY } from "./Defs.ts";
import type { CGameSession } from "./GameSession.ts";
import { DestroySessionPlayer } from "./runtime/SessionTableRuntime.ts";
import { CGameClock } from "./runtime/GameSessionSupport.ts";
import type { CClientSocket } from "./ClientSocket.ts";

/**
 * CUdpLossRegulator (+12280) — the per-pair UDP-loss matrix.  Only the
 * matrix state and packet 187 live here; DeferRegulateConnection belongs
 * to the game-tick unit (FxServer.exe.c:26020).
 */
export class CUdpLossRegulator {
  m_fInit = 0; // +4
  m_dwInitTime = 0; // +8
  m_rgLoss = new Uint8Array(MAX_SESSION_SLOTS * MAX_SESSION_SLOTS); // +12, [8 * mySlot + targetSlot]

  /** CUdpLossRegulator::Init. */
  Init(): void {
    this.m_fInit = 0;
    this.m_dwInitTime = 0;
    this.m_rgLoss.fill(0);
  }

  /** CUdpLossRegulator::OnNotifyUdpLoss — packet 187. */
  OnNotifyUdpLoss(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fInit === 0) {
      this.m_fInit = 1;
      this.m_dwInitTime = CGameClock.Now();
    }
    const target = n.Decode1();
    if (target >= MAX_SESSION_SLOTS) return;
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = user.m_nSlotIdx;
      if (slot < MAX_SESSION_SLOTS) this.m_rgLoss[MAX_SESSION_SLOTS * slot + target] = 1;
    }
  }

  /** CUdpLossRegulator::DeferRegulateConnection (416595) — 8 s after the first 187. */
  DeferRegulateConnection(session: CGameSession): void {
    if (this.m_fInit !== 0 && ((CGameClock.Now() - this.m_dwInitTime) >>> 0) > UDP_REGULATE_DELAY) this.RegulateConnection(session);
  }

  /**
   * CUdpLossRegulator::RegulateConnection (4160D3) — kick the peer with the
   * most loss reports (ties: the fewest self reports), then reset.
   */
  RegulateConnection(session: CGameSession): void {
    const valid = new Int32Array(MAX_SESSION_SLOTS);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = session.m_rgPlayer[slot];
      if (user && user.m_pSocket?.GetUser(0) === user) valid[slot] = 1;
    }
    for (;;) {
      const cnt = new Int32Array(MAX_SESSION_SLOTS);
      const both = new Int32Array(MAX_SESSION_SLOTS);
      for (let a = 0; a < MAX_SESSION_SLOTS; a++) {
        if (!valid[a] || !session.m_rgPlayer[a]) continue;
        for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
          if (valid[k] && session.m_rgPlayer[k] && this.m_rgLoss[MAX_SESSION_SLOTS * a + k]! !== 0) {
            cnt[a]++;
            both[a]++;
            both[k]++;
          }
        }
      }
      let best = -1;
      let bestBoth = 0;
      let bestCnt = 0x7fffffff;
      for (let m = 0; m < MAX_SESSION_SLOTS; m++) {
        if (!valid[m]) continue;
        if (both[m]! > bestBoth || (both[m] === bestBoth && bestCnt > cnt[m]!)) {
          bestCnt = cnt[m]!;
          best = m;
          bestBoth = both[m]!;
        }
      }
      if (best === -1 || bestBoth === 0) break; // nothing reported → stop
      for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
        this.m_rgLoss[MAX_SESSION_SLOTS * best + k] = 0; // the row
        this.m_rgLoss[MAX_SESSION_SLOTS * k + best] = 0; // the column
      }
      const user = session.m_rgPlayer[best]!;
      const ip = user.m_pSocket ? user.m_pSocket.GetInfoStr() : "";
      console.error(
        `[GS] User[${ip}:${user.GetName()}] (${user.m_pSocket?.GetUserCount() ?? 0}P) banned from game session (${session.m_nIdx}) while <PLAYING> by udp loss`,
      );
      DestroySessionPlayer(user.m_pSocket!, 0);
      if (user.m_nFree === 0) {
        // [user+7A4] != 0 and [socket+244] == 0 — +244 is the IO-layer detach
        // flag that FXGS logic never sets, so the port uses the connected flag
        const socket = user.m_pSocket;
        if (socket && socket.m_bConnected) {
          socket.SendPacket(new CSendPacket(S2C_GamePacket.OnUdpLossBan)); // 195, no payload
          socket.m_nPoolType = 4; // [socket+1D4]
        }
      }
    }
    this.m_fInit = 0;
    this.m_dwInitTime = 0;
    this.m_rgLoss.fill(0);
  }
}
