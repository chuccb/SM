import type { Socket } from "node:net";
import { CPacketSocket } from "./CPacketSocket.ts";
import type { CSendPacketBase } from "./CSendPacketBase.ts";
import type { CReceivedPacketBase } from "./CReceivedPacketBase.ts";
import type { CTextCodec } from "./CTextCodec.ts";
import { CProtocolError, CUnsupportedOperation } from "./CProtocolError.ts";
import { RuntimePolicy } from "./RuntimePolicy.ts";
import { ClientSessionHistoryRule } from "./OfficialValues.ts";
import { NormalizePeerIP } from "./CIPAddress.ts";
import type { CUser } from "./CUser.ts";

export type ClientPacketHandler = (
  packet: CReceivedPacketBase,
  socket: CClientSocket,
) => void | Promise<void>;
export type PoolStage =
  | "Login"
  | "Connecting"
  | "Channel"
  | "Lobby"
  | "Session"
  | "SessionRemoved" // FXGS native pool4: explicit 83/16 exits, not automatic Lobby
  | "Shop";
/** Bun's node:net transport replaces IOCP; handlers for each socket stay ordered. */
export class CClientSocket extends CPacketSocket {
  readonly m_aUser: CUser[] = [];
  m_nPoolType: PoolStage = "Connecting";
  private readonly m_aBeforeJoinSession: number[] = [];
  m_bClosed = false;
  m_nLastLogin = 0;
  m_nConfigHash = 0;
  m_nLastReceive = Date.now();
  readonly address: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly closeCompleted = Promise.withResolvers<void>();
  private queuedBytes = 0;
  private rateStart = Date.now();
  private rateCount = 0;
  onClose: (() => void) | undefined;
  OnPacket: ClientPacketHandler | undefined;
  constructor(
    readonly socket: Socket,
    readonly m_nLocalSerialNo: number,
    headerType: number,
    text: CTextCodec,
    maxPacketLength?: number,
  ) {
    super(
      {
        headerType,
        ...(maxPacketLength !== undefined ? { maxPacketLength } : {}),
      },
      text,
    );
    this.address = NormalizePeerIP(socket.remoteAddress ?? "");
    socket.setNoDelay(true);
    socket.setTimeout(RuntimePolicy.IdleTimeoutSeconds * 1000);
    socket.on("timeout", () => this.Close());
    socket.on("data", (data) =>
      this.Receive(typeof data === "string" ? Buffer.from(data) : data),
    );
    socket.on("error", () => this.Close());
    socket.once("close", () => {
      this.m_bClosed = true;
      try {
        this.onClose?.();
      } finally {
        this.closeCompleted.resolve();
      }
    });
  }
  private Receive(data: Buffer): void {
    if (this.m_bClosed) return;
    this.m_nLastReceive = Date.now();
    try {
      const packets = this.GetPackets(data);
      if (this.m_nLastReceive - this.rateStart >= 1000) {
        this.rateStart = this.m_nLastReceive;
        this.rateCount = 0;
      }
      this.rateCount += packets.length;
      if (this.rateCount > RuntimePolicy.MaxPacketsPerSecond)
        throw new CProtocolError("Packet rate limit");
      for (const packet of packets) {
        this.queuedBytes += packet.m_uLength;
        if (this.queuedBytes > RuntimePolicy.MaxBufferedReceiveBytes)
          throw new CProtocolError("Handler queue limit");
        this.queue = this.queue.then(async () => {
          try {
            if (!this.m_bClosed) await this.OnPacket?.(packet, this);
          } catch (error) {
            // Do not log packet bodies/passwords/SQL exceptions from user input.
            console.warn(
              JSON.stringify({
                event: "client-packet-rejected",
                service: this.m_nPoolType,
                opcode: packet.m_nPacketType,
                reason:
                  error instanceof CProtocolError
                    ? error.code
                    : error instanceof CUnsupportedOperation
                      ? "unported-feature"
                      : "handler-error",
                ...(error instanceof CUnsupportedOperation
                  ? { feature: error.feature }
                  : {}),
              }),
            );
            this.Close();
          } finally {
            this.queuedBytes -= packet.m_uLength;
          }
        });
      }
    } catch {
      this.Close();
    }
  }
  SendPacket(packet: CSendPacketBase): void {
    if (this.m_bClosed || this.socket.destroyed) return;
    if (
      this.socket.writableLength + packet.GetOutgoingPacketLength() >
      RuntimePolicy.MaxBufferedSendBytes
    ) {
      this.Close();
      return;
    }
    this.socket.write(this.PutPacket(packet));
  }
  /** Modern transport join: server.close may precede Bun's per-socket close
   * callbacks. Ownership cleanup MUST finish before Center/DB teardown. */
  WaitForClose(): Promise<void> {
    return this.closeCompleted.promise;
  }
  async WaitForHandlers(): Promise<void> {
    await this.queue;
  }
  GetUser(index: number): CUser | undefined {
    return this.m_aUser[index];
  }
  GetUserCount(): number {
    return this.m_aUser.length;
  }
  /**00406C66: xor eax,eax; ret4. No this/Authority access in THIS build.
   * Never infer socket permissions21 or other role bits from SQLite users. */
  HasAuthority(_authority: number): number {
    return 0;
  }
  /** 00406BAD / 00406F68. Modern validation rejects invalid normal indices;
   * the native history does not include serial generations and is not auth. */
  CheckInBeforeJoinSession(index: number): boolean {
    return this.m_aBeforeJoinSession.includes(index);
  }
  AddBeforeJoinSession(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 0xffff)
      throw new CProtocolError("Invalid previous room index");
    if (this.CheckInBeforeJoinSession(index)) return;
    if (
      this.m_aBeforeJoinSession.length === ClientSessionHistoryRule.MaximumRooms
    )
      this.m_aBeforeJoinSession.shift();
    this.m_aBeforeJoinSession.push(index);
  }
  /** Detached modern inspection, not a native packet or method. */
  GetBeforeJoinSessions(): readonly number[] {
    return this.m_aBeforeJoinSession.slice();
  }
  ClearAttachedUsers(): void {
    // Modern in-process Center shares the SAME CUser objects after a handoff.
    // This is detach-only: native 00406C6B instead SetFree's service-local copies.
    // Terminal deletion/marking belongs to CGlobalUserTable.DeleteUser, otherwise
    // closing the old source would invalidate the new target's live users.
    this.m_aUser.length = 0;
  }
  Close(): void {
    if (!this.m_bClosed) {
      this.m_bClosed = true;
      this.socket.destroy();
    }
  }
  IsConnected(): boolean {
    return !this.m_bClosed && !this.socket.destroyed;
  }
}
