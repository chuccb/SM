import type { CCenterServer } from "../Center/CCenterServer.ts";
import type { CLocalServer } from "../Center/CLocalServer.ts";
import type { CClientSocket } from "./CClientSocket.ts";
import type {
  ConnectionIdentity,
  ConnectionAuthorization,
} from "../Center/ConnectionAuthorization.ts";
import type { _USERINFO } from "./DB/Rows.ts";

/** Typed local facade. Transport is intentionally explicit: in-process, not wire-compatible Center TCP. */
export class CCenterProcess {
  constructor(
    readonly center: CCenterServer,
    readonly server: CLocalServer,
  ) {}
  RegisterConnection(socket: CClientSocket, accounts: readonly _USERINFO[]) {
    return this.center.OnAddNewUser(socket, this.server, accounts);
  }
  UnregisterConnection(socket: CClientSocket): void {
    this.center.OnDeleteUser(socket);
  }
  RequestConnection(socket: CClientSocket, type: number, index: number) {
    return this.center.OnReqConnectToSvr(socket, type, index);
  }
  /** Modern non-consuming lease; server/socket bound, not a wire ACK or SQL grant. */
  AuthorizeConnection(
    socket: CClientSocket,
    users: readonly ConnectionIdentity[],
  ): ConnectionAuthorization {
    return this.center.AuthorizeConnection(socket, this.server, users);
  }
  CheckConnectionAuthorization(
    socket: CClientSocket,
    lease: ConnectionAuthorization,
  ): void {
    this.center.CheckConnectionAuthorization(socket, this.server, lease);
  }
  /** Read-side DTOs only; does not consume the lease or grant inventory. */
  CaptureAuthorizedPreInventory(
    socket: CClientSocket,
    lease: ConnectionAuthorization,
  ) {
    return this.center.CaptureAuthorizedPreInventory(
      socket,
      this.server,
      lease,
    );
  }
  ConfirmAuthorizedConnection(
    socket: CClientSocket,
    lease: ConnectionAuthorization,
  ) {
    return this.center.ConfirmAuthorizedConnection(socket, this.server, lease);
  }
  ReleaseConnectionAuthorization(
    socket: CClientSocket,
    lease: ConnectionAuthorization,
  ): boolean {
    return this.center.ReleaseConnectionAuthorization(
      socket,
      this.server,
      lease,
    );
  }
  ConfirmConnection(
    socket: CClientSocket,
    users: readonly ConnectionIdentity[],
  ) {
    return this.center.OnConnEstablished(socket, this.server, users);
  }
}
