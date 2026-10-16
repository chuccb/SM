import { CUser as CLocalUser } from "../Common/CUser.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CLocalServer } from "./CLocalServer.ts";
export interface PendingConnection {
  readonly source: CClientSocket;
  readonly sourceServer: CLocalServer;
  readonly sourceGeneration: object;
  readonly target: CLocalServer;
  readonly targetGeneration: object;
  readonly users: readonly CUser[];
  readonly address: string;
  readonly expires: number;
}
export class CUser extends CLocalUser {
  private m_localServer: CLocalServer | undefined;
  private m_pending: PendingConnection | undefined;
  private m_connectionGeneration: object = Object.freeze({});
  get m_pLocalServer(): CLocalServer | undefined {
    return this.m_localServer;
  }
  set m_pLocalServer(value: CLocalServer | undefined) {
    if (this.m_localServer !== value) {
      this.m_localServer = value;
      this.m_connectionGeneration = Object.freeze({});
    }
  }
  get m_pendingConnection(): PendingConnection | undefined {
    return this.m_pending;
  }
  set m_pendingConnection(value: PendingConnection | undefined) {
    this.m_pending = value;
    this.m_connectionGeneration = Object.freeze({});
  }
  /** Tracks authoritative pending replacement/consumption, including same-value
   * republishing and clear/restore ABA. Not an auth token itself. */
  GetConnectionGeneration(): object {
    return this.m_connectionGeneration;
  }
  /** Legacy local predicate ONLY, not an authorization grant. Actual handoff
   * now requires CCenterServer's issued-pending registry and private lease. */
  CheckConnectionEstablished(
    server: CLocalServer,
    socket: CClientSocket,
    now: number,
  ): boolean {
    const pending = this.m_pendingConnection;
    return (
      pending !== undefined &&
      pending.target === server &&
      pending.expires > now &&
      pending.address === socket.address
    );
  }
}
