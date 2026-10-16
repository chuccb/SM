import { NormalizeID } from "../Common/CIDCompare.ts";
import { CGlobalUserTable } from "./CGlobalUserTable.ts";
import { CLocalServerMan } from "./CLocalServerMan.ts";
import type { CLocalServer } from "./CLocalServer.ts";
import type { CUser, PendingConnection } from "./CUser.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { _USERINFO } from "../Common/DB/Rows.ts";
import type { ServerConfig } from "../Common/CServerConfig.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  ChannelType,
  UserCount,
  SessionLimit,
} from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import {
  CaptureConnectionIdentities,
  type ConnectionIdentity,
  type ConnectionAuthorization,
} from "./ConnectionAuthorization.ts";

type Phase = "active" | "released" | "invalidated" | "consumed";
interface OwnerCapture {
  readonly User: CUser;
  readonly Info: _USERINFO;
  readonly Generation: object;
  readonly Inventory: readonly object[];
  readonly Rows: readonly object[];
  readonly NativeRows: readonly object[] | undefined;
  readonly Fingerprint: string;
}
interface AuthorizationState {
  readonly Socket: CClientSocket;
  readonly Server: CLocalServer;
  readonly Pending: PendingConnection;
  readonly Identities: readonly Readonly<ConnectionIdentity>[];
  readonly Owners: readonly OwnerCapture[];
  readonly IssuedAt: number;
  Phase: Phase;
  Checking: boolean;
}
function fingerprint(user: CUser): string {
  return JSON.stringify({
    Info: { ...user.m_userInfo },
    Dynamic: user.GetDynamicInfoSnapshot(),
    Auth: user.GetAuthencode(),
    Initialized: user.m_bClientInitialized,
    Session: user.GetSessionIdx(),
    SessionSerial: user.GetSessionSerialNo(),
    Slot: user.m_nSlotIdx,
    InventoryGeneration: user.GetUserInventoryGeneration(),
    Inventory: user.GetInventoryStateSnapshot(),
  });
}
function capture(user: CUser): OwnerCapture {
  return {
    User: user,
    Info: user.m_userInfo,
    Generation: user.GetConnectionGeneration(),
    Inventory: user.m_aInventory,
    Rows: Object.freeze([...user.m_aInventory]),
    NativeRows: user.CaptureUserInventory()?.Rows,
    Fingerprint: fingerprint(user),
  };
}
function arrayWritable(array: readonly unknown[]): boolean {
  return (
    Array.isArray(array) &&
    Object.isExtensible(array) &&
    Object.getOwnPropertyDescriptor(array, "length")?.writable === true &&
    array.every(
      (_, i) =>
        Object.getOwnPropertyDescriptor(array, String(i))?.configurable !==
        false,
    )
  );
}
/** Center ownership/transfer state machine. Current deployment is in-process,
 * NOT original Center TCP. Authorization leases are explicit MODERN hardening:
 * exclusive non-consuming preflight, followed by whole-group single-use commit.
 * They do not authorize money/native SQL or make external effects replay-safe. */
export class CCenterServer {
  readonly m_globalUserTable = new CGlobalUserTable();
  readonly m_localServerMan: CLocalServerMan;
  private readonly m_authorizations = new WeakMap<
    ConnectionAuthorization,
    AuthorizationState
  >();
  private readonly m_issuedPending = new WeakMap<
    PendingConnection,
    readonly Readonly<{ User: CUser; Generation: object }>[]
  >();
  private readonly m_activePending = new WeakMap<
    PendingConnection,
    AuthorizationState
  >();
  private readonly m_activeSocket = new WeakMap<
    CClientSocket,
    AuthorizationState
  >();
  private readonly m_preparingSocket = new WeakSet<CClientSocket>();
  private readonly m_preparingPending = new WeakSet<PendingConnection>();
  private m_readingClock = false;
  private m_lastClock: number | undefined;
  constructor(
    config: ServerConfig,
    readonly clock: () => number = Date.now,
  ) {
    this.m_localServerMan = new CLocalServerMan(config);
  }
  private ReadClock(): number {
    if (this.m_readingClock) throw new CProtocolError("Reentrant Center clock");
    this.m_readingClock = true;
    try {
      const now = this.clock();
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        now >
          Number.MAX_SAFE_INTEGER - RuntimePolicy.SessionTransferTimeoutMs ||
        (this.m_lastClock !== undefined && now < this.m_lastClock)
      )
        throw new CProtocolError("Invalid or backwards Center clock");
      this.m_lastClock = now;
      return now;
    } catch (error) {
      // A bad/backwards wall clock must not preserve authority which could
      // become usable again after recovery with an effectively extended TTL.
      this.InvalidatePendingConnections();
      throw error;
    } finally {
      this.m_readingClock = false;
    }
  }
  private InvalidatePendingConnections(): void {
    for (const user of this.m_globalUserTable.Values()) {
      const pending = user.m_pendingConnection;
      if (!pending) continue;
      const active = this.m_activePending.get(pending);
      if (active) this.Retire(active, "invalidated");
      this.m_issuedPending.delete(pending);
      user.m_pendingConnection = undefined;
      if (!user.m_pClientSocket?.IsConnected())
        this.m_globalUserTable.DeleteUser(user);
    }
  }
  private Registered(server: CLocalServer | undefined): server is CLocalServer {
    return (
      !!server &&
      this.m_localServerMan.GetSvr(server.GetServerType(), server.GetIdx()) ===
        server
    );
  }
  OnAddNewUser(
    socket: CClientSocket,
    server: CLocalServer,
    accounts: readonly _USERINFO[],
  ): CUser[] {
    this.ExpireConnections();
    if (
      !socket.IsConnected() ||
      !this.Registered(server) ||
      // Trusted fixtures/offline bootstrap may register a local user. Neither
      // transfer reservation nor authorization is allowed until servers are live.
      this.m_activeSocket.has(socket) ||
      this.m_preparingSocket.has(socket) ||
      socket.GetUserCount() ||
      !arrayWritable(socket.m_aUser) ||
      accounts.length < UserCount.Minimum ||
      accounts.length > UserCount.Maximum
    )
      throw new CProtocolError("Invalid login group");
    const ids = accounts.map((a) => NormalizeID(a.ID));
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => this.m_globalUserTable.FindUserFromId(id))
    )
      throw new CProtocolError("Already connected", "already-connected");
    const users = accounts.map((a) => this.m_globalUserTable.AddNewUser(a));
    for (const user of users) {
      user.m_pClientSocket = socket;
      user.m_pLocalServer = server;
    }
    socket.m_aUser.push(...users);
    return users;
  }
  OnReqConnectToSvr(
    source: CClientSocket,
    type: number,
    index: number,
  ): { result: number; server?: CLocalServer } {
    const now = this.ReadClock();
    this.ExpireConnectionsAt(now);
    const target = this.m_localServerMan.GetSvr(type, index),
      users = [...source.m_aUser] as CUser[],
      sourceServer = users[0]?.m_pLocalServer;
    if (
      !target ||
      !target.m_bConnected ||
      !this.Registered(sourceServer) ||
      !sourceServer.m_bConnected ||
      users.length < UserCount.Minimum ||
      users.length > UserCount.Maximum ||
      !source.IsConnected() ||
      new Set(users).size !== users.length
    )
      return { result: 0 };
    if (
      users.some(
        (u) =>
          this.m_globalUserTable.GetUser(u.m_nGlobalSerialNo) !== u ||
          u.IsSetFree() !== 0 ||
          u.m_pClientSocket !== source ||
          u.m_pLocalServer !== sourceServer ||
          u.m_pendingConnection ||
          u.m_pLocalServer === target ||
          u.m_nSessionIdx !== SessionLimit.NoSession,
      )
    )
      return { result: 0 };
    if (
      target.m_nChannelType === ChannelType.Premium &&
      users.some((u) => u.m_userInfo.TicketDate <= Math.floor(now / 1000))
    )
      return { result: 2 };
    if (this.GetConnNo(target, true) + users.length > target.m_nMaxUser)
      return { result: 0 };
    const pending: PendingConnection = Object.freeze({
      source,
      sourceServer,
      sourceGeneration: sourceServer.GetConnectionGeneration(),
      target,
      targetGeneration: target.GetConnectionGeneration(),
      users: Object.freeze(users),
      address: source.address,
      expires: now + RuntimePolicy.SessionTransferTimeoutMs,
    });
    for (const user of users) user.m_pendingConnection = pending;
    this.m_issuedPending.set(
      pending,
      Object.freeze(
        users.map((User) =>
          Object.freeze({ User, Generation: User.GetConnectionGeneration() }),
        ),
      ),
    );
    return { result: 1, server: target };
  }
  /** No account/inventory/procedure callback is allowed BEFORE this succeeds.
   * A live lease exclusively reserves preflight, NOT another capacity slot;
   * source ownership, pending and deadline remain unchanged until consumption. */
  AuthorizeConnection(
    socket: CClientSocket,
    server: CLocalServer,
    input: readonly ConnectionIdentity[],
  ): ConnectionAuthorization {
    if (this.m_preparingSocket.has(socket))
      throw new CProtocolError(
        "Reentrant connection authorization",
        "invalid-transfer",
      );
    this.m_preparingSocket.add(socket);
    let pending: PendingConnection | undefined,
      ownsPendingGuard = false;
    try {
      const ids = CaptureConnectionIdentities(input),
        now = this.ReadClock();
      this.ExpireConnectionsAt(now);
      if (this.m_activeSocket.has(socket))
        throw new CProtocolError(
          "Connection authorization already active",
          "invalid-transfer",
        );
      pending = this.m_globalUserTable.GetUser(
        ids[0]!.GlobalSerialNo,
      )?.m_pendingConnection;
      if (!pending)
        throw new CProtocolError(
          "Invalid or replayed transfer",
          "invalid-transfer",
        );
      if (
        this.m_activePending.has(pending) ||
        this.m_preparingPending.has(pending)
      )
        throw new CProtocolError(
          "Transfer authorization already active",
          "invalid-transfer",
        );
      this.m_preparingPending.add(pending);
      ownsPendingGuard = true;
      this.ValidateGroup(socket, server, ids, pending, now);
      const state: AuthorizationState = {
        Socket: socket,
        Server: server,
        Identities: ids,
        Pending: pending,
        Owners: Object.freeze(pending.users.map(capture)),
        IssuedAt: now,
        Phase: "active",
        Checking: false,
      };
      this.ValidateState(state, now); // capture/getters cannot silently rebind source
      const lease = Object.freeze({
        UserCount: ids.length,
        Expires: pending.expires,
      }) as ConnectionAuthorization;
      this.m_authorizations.set(lease, state);
      this.m_activePending.set(pending, state);
      this.m_activeSocket.set(socket, state);
      return lease;
    } finally {
      this.m_preparingSocket.delete(socket);
      if (pending && ownsPendingGuard) this.m_preparingPending.delete(pending);
    }
  }
  private ValidateGroup(
    socket: CClientSocket,
    server: CLocalServer,
    ids: readonly Readonly<ConnectionIdentity>[],
    pending: PendingConnection,
    now: number,
  ): void {
    if (
      !socket.IsConnected() ||
      !this.Registered(server) ||
      !server.m_bConnected ||
      socket.GetUserCount() ||
      !arrayWritable(socket.m_aUser)
    )
      throw new CProtocolError(
        "Invalid establishment group",
        "invalid-transfer",
      );
    const issued = this.m_issuedPending.get(pending);
    if (
      !issued ||
      issued.length !== pending.users.length ||
      issued.some(
        (c, i) =>
          c.User !== pending.users[i] ||
          c.Generation !== c.User.GetConnectionGeneration(),
      ) ||
      pending.target !== server ||
      pending.source === socket ||
      pending.targetGeneration !== server.GetConnectionGeneration() ||
      !this.Registered(pending.sourceServer) ||
      pending.sourceGeneration !==
        pending.sourceServer.GetConnectionGeneration() ||
      pending.address !== socket.address ||
      pending.expires <= now ||
      pending.users.length !== ids.length ||
      !arrayWritable(pending.source.m_aUser)
    )
      throw new CProtocolError(
        "Invalid or replayed transfer",
        "invalid-transfer",
      );
    if (
      pending.users.some(
        (u, i) =>
          this.m_globalUserTable.GetUser(ids[i]!.GlobalSerialNo) !== u ||
          u.GetGlobalSerialNo() !== ids[i]!.GlobalSerialNo ||
          this.m_globalUserTable.FindUserFromId(ids[i]!.ID) !== u ||
          u.IsSetFree() !== 0 ||
          u.m_pendingConnection !== pending ||
          u.m_pClientSocket !== pending.source ||
          u.m_pLocalServer !== pending.sourceServer ||
          u.GetSessionIdx() !== SessionLimit.NoSession ||
          NormalizeID(u.GetName()) !== NormalizeID(ids[i]!.ID) ||
          u.m_userInfo.GuildSn !== ids[i]!.GuildSn,
      )
    )
      throw new CProtocolError(
        "Invalid or replayed transfer",
        "invalid-transfer",
      );
    // Closing/disconnecting the SOURCE while pending is legitimate. A live
    // source must still own its exact group; a detached closed source may be empty.
    const members = pending.source.m_aUser;
    if (
      (members.length !== 0 || pending.source.IsConnected()) &&
      (members.length !== pending.users.length ||
        members.some((u, i) => u !== pending.users[i]))
    )
      throw new CProtocolError(
        "Transfer source group changed",
        "invalid-transfer",
      );
  }
  private ValidateState(state: AuthorizationState, now: number): void {
    if (state.Phase !== "active" || now < state.IssuedAt)
      throw new CProtocolError(
        "Stale connection authorization",
        "invalid-transfer",
      );
    this.ValidateGroup(
      state.Socket,
      state.Server,
      state.Identities,
      state.Pending,
      now,
    );
    for (const c of state.Owners) {
      const u = c.User;
      if (
        u.m_userInfo !== c.Info ||
        u.GetConnectionGeneration() !== c.Generation ||
        u.m_aInventory !== c.Inventory ||
        u.m_aInventory.length !== c.Rows.length ||
        u.m_aInventory.some((r, i) => r !== c.Rows[i]) ||
        u.CaptureUserInventory()?.Rows !== c.NativeRows ||
        fingerprint(u) !== c.Fingerprint
      )
        throw new CProtocolError(
          "Connection authorization source changed",
          "invalid-transfer",
        );
    }
  }
  private FindAuthorization(
    socket: CClientSocket,
    server: CLocalServer,
    lease: ConnectionAuthorization,
  ): AuthorizationState {
    const state = this.m_authorizations.get(lease);
    if (!state || state.Socket !== socket || state.Server !== server)
      throw new CProtocolError(
        "Forged or foreign connection authorization",
        "invalid-transfer",
      );
    return state;
  }
  private Retire(
    state: AuthorizationState,
    phase: Exclude<Phase, "active">,
  ): void {
    if (state.Phase !== "active") return;
    state.Phase = phase;
    if (this.m_activePending.get(state.Pending) === state)
      this.m_activePending.delete(state.Pending);
    if (this.m_activeSocket.get(state.Socket) === state)
      this.m_activeSocket.delete(state.Socket);
  }
  private CheckAuthorization(state: AuthorizationState): void {
    if (state.Phase !== "active")
      throw new CProtocolError(
        "Stale connection authorization",
        "invalid-transfer",
      );
    if (state.Checking)
      throw new CProtocolError(
        "Reentrant connection authorization",
        "invalid-transfer",
      );
    state.Checking = true;
    try {
      const now = this.ReadClock();
      this.ExpireConnectionsAt(now);
      this.ValidateState(state, now);
    } catch (error) {
      this.Retire(state, "invalidated");
      throw error;
    } finally {
      state.Checking = false;
    }
  }
  CheckConnectionAuthorization(
    socket: CClientSocket,
    server: CLocalServer,
    lease: ConnectionAuthorization,
  ): void {
    this.CheckAuthorization(this.FindAuthorization(socket, server, lease));
  }
  /** Releasing/cancelling preparation DOES NOT cancel the pending transfer or
   * extend its TTL. Known retired handles release idempotently; forged ones fail. */
  ReleaseConnectionAuthorization(
    socket: CClientSocket,
    server: CLocalServer,
    lease: ConnectionAuthorization,
  ): boolean {
    const state = this.FindAuthorization(socket, server, lease);
    if (state.Checking)
      throw new CProtocolError(
        "Reentrant connection authorization",
        "invalid-transfer",
      );
    if (state.Phase !== "active") return false;
    this.Retire(state, "released");
    return true;
  }
  ConfirmAuthorizedConnection(
    socket: CClientSocket,
    server: CLocalServer,
    lease: ConnectionAuthorization,
  ): CUser[] {
    const state = this.FindAuthorization(socket, server, lease);
    this.CheckAuthorization(state);
    const valid = [...state.Pending.users];
    // No callouts/await between the FINAL whole-group check and consumption.
    // Source cleanup/close is AFTER authoritative ownership. It is not rollback.
    this.Retire(state, "consumed");
    this.m_issuedPending.delete(state.Pending);
    for (const user of valid) {
      user.m_pendingConnection = undefined;
      user.m_pClientSocket = socket;
      user.m_pLocalServer = server;
    }
    socket.m_aUser.push(...valid);
    state.Pending.source.m_aUser.length = 0;
    try {
      state.Pending.source.Close();
    } catch {
      console.warn(JSON.stringify({ event: "source-transfer-close-failed" }));
    }
    return valid;
  }
  /** Backwards-compatible one-step facade; cannot steal another live lease. */
  OnConnEstablished(
    socket: CClientSocket,
    server: CLocalServer,
    ids: readonly ConnectionIdentity[],
  ): CUser[] {
    const lease = this.AuthorizeConnection(socket, server, ids);
    try {
      return this.ConfirmAuthorizedConnection(socket, server, lease);
    } finally {
      this.ReleaseConnectionAuthorization(socket, server, lease);
    }
  }
  OnDeleteUser(socket: CClientSocket): void {
    const preparing = this.m_activeSocket.get(socket);
    if (preparing) this.Retire(preparing, "invalidated");
    for (const user of [...socket.m_aUser] as CUser[])
      if (user.m_pClientSocket === socket && !user.m_pendingConnection)
        this.m_globalUserTable.DeleteUser(user);
    socket.ClearAttachedUsers();
  }
  ExpireConnections(): void {
    this.ExpireConnectionsAt(this.ReadClock());
  }
  private ExpireConnectionsAt(now: number): void {
    for (const user of this.m_globalUserTable.Values()) {
      const pending = user.m_pendingConnection;
      if (pending && pending.expires <= now) {
        const active = this.m_activePending.get(pending);
        if (active) this.Retire(active, "invalidated");
        user.m_pendingConnection = undefined;
        if (!user.m_pClientSocket?.IsConnected())
          this.m_globalUserTable.DeleteUser(user);
      }
    }
  }
  GetConnNo(server: CLocalServer, includePending = false): number {
    let count = 0;
    for (const user of this.m_globalUserTable.Values())
      if (user.m_pLocalServer === server && user.m_pClientSocket?.IsConnected())
        count++;
      else if (includePending && user.m_pendingConnection?.target === server)
        count++;
    return count;
  }
}
