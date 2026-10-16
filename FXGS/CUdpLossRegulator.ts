import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import type { CUser } from "../Common/CUser.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { GameConnectionTime, SessionLimit } from "../Common/OfficialValues.ts";

/** FXGS 004161AC..004165C0, matrix at native +12: eight reporter rows by eight
 * reported-target columns, DWORD boolean entries (not counters).
 * Pure graph kernel: returns sockets to eject; the session TABLE owns removals.
 * It simulates removal of all local players on each selected socket, just like
 * native DestroyPlayer. No invented quorum, RTT estimate, or automatic TCP relay.
 * Reports are client claims, not evidence of an authenticated network failure. */
export class CUdpLossRegulator {
  m_bPending = false;
  m_dwFirstLossTime = 0;
  private readonly m_aLoss = new Uint32Array(
    SessionLimit.Players * SessionLimit.Players,
  );
  constructor(
    private readonly timeGetTime: () => number = () => performance.now(),
  ) {}
  Init(): void {
    this.m_bPending = false;
    this.m_dwFirstLossTime = 0;
    this.m_aLoss.fill(0);
  }
  GetLossMatrix(): Uint32Array {
    return this.m_aLoss.slice();
  }
  /** 004161CE. Structural and ownership checks happen before setting pending.
   * Native trusts the caller's socket/slots; the rewrite additionally validates
   * the complete local-player group against the current room array. */
  OnNotifyUdpLoss(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
    players: readonly (CUser | undefined)[],
  ): void {
    const target = packet.Decode1();
    packet.AssertEnd();
    if (players.length !== SessionLimit.Players)
      throw new CProtocolError(
        "UDP loss player array must contain eight slots",
      );
    if (target >= SessionLimit.Players || !players[target])
      throw new CProtocolError("UDP loss target is not an occupied room slot");
    if (
      !socket.GetUserCount() ||
      socket.m_aUser.some(
        (user) =>
          user.m_pClientSocket !== socket ||
          user.GetSelfidx() < 0 ||
          user.m_nSlotIdx < 0 ||
          user.m_nSlotIdx >= SessionLimit.Players ||
          players[user.m_nSlotIdx] !== user,
      )
    )
      throw new CProtocolError("UDP loss reporter is not in this room");
    if (!this.m_bPending) {
      this.m_bPending = true;
      this.m_dwFirstLossTime = this.timeGetTime() >>> 0;
    }
    for (const user of socket.m_aUser)
      this.m_aLoss[user.m_nSlotIdx * SessionLimit.Players + target] = 1;
  }
  /** 0041624D: only self-index-zero users participate in the graph. Choose the
   * highest incident degree, then FEWEST outgoing reports, then lowest slot.
   * Remove its row/column and repeat; diagonal reports contribute degree TWO.
   * Native consumes one CRT rand()%10 draw for diagnostic logging each batch;
   * that logging/draw and native table removal/195/IsSetFree/pool-4 side effects
   * are intentionally NOT emulated by this pure kernel. */
  RegulateConnection(players: readonly (CUser | undefined)[]): CClientSocket[] {
    const rejected = this.GetRegulationCandidates(players);
    this.Init();
    return rejected;
  }
  /** Modern non-consuming plan: table batches must preflight all scope/identity
   * guards BEFORE taking the first user out. Pure native selection is unchanged. */
  GetRegulationCandidates(
    players: readonly (CUser | undefined)[],
  ): CClientSocket[] {
    const matrix = this.m_aLoss.slice();
    if (players.length !== SessionLimit.Players)
      throw new CProtocolError(
        "UDP loss player array must contain eight slots",
      );
    const eligible = players.map(
      (user) => !!user?.m_pClientSocket && user.GetSelfidx() === 0,
    );
    const rejected: CClientSocket[] = [];
    for (;;) {
      const outgoing = new Uint32Array(SessionLimit.Players);
      const degree = new Uint32Array(SessionLimit.Players);
      for (let row = 0; row < SessionLimit.Players; row++)
        if (eligible[row])
          for (let column = 0; column < SessionLimit.Players; column++)
            if (
              eligible[column] &&
              matrix[row * SessionLimit.Players + column]
            ) {
              outgoing[row]!++;
              degree[row]!++;
              degree[column]!++;
            }
      let selected = -1;
      for (let slot = 0; slot < SessionLimit.Players; slot++)
        if (
          eligible[slot] &&
          degree[slot]! > 0 &&
          (selected < 0 ||
            degree[slot]! > degree[selected]! ||
            (degree[slot] === degree[selected] &&
              outgoing[slot]! < outgoing[selected]!))
        )
          selected = slot;
      if (selected < 0) break;
      const socket = players[selected]!.m_pClientSocket!;
      rejected.push(socket);
      for (let slot = 0; slot < SessionLimit.Players; slot++) {
        matrix[selected * SessionLimit.Players + slot] = 0;
        matrix[slot * SessionLimit.Players + selected] = 0;
        if (players[slot]?.m_pClientSocket === socket) eligible[slot] = false;
      }
    }
    return rejected;
  }
  /** Modern non-consuming query of the 00416595 condition. A partial driver
   * must not clear a due graph before the table/195/pool-4 recovery is available.
   * Pending is independent of the zero-valued timestamp sentinel. */
  IsRegulationDue(): boolean {
    return (
      this.m_bPending &&
      ((this.timeGetTime() >>> 0) - this.m_dwFirstLossTime) >>> 0 >
        GameConnectionTime.UdpLossBatchMs
    );
  }
  /** 00416595. This extracted kernel still does NOT apply socket removals. */
  DeferRegulateConnection(
    players: readonly (CUser | undefined)[],
  ): CClientSocket[] {
    if (this.IsRegulationDue()) return this.RegulateConnection(players);
    return [];
  }
}
