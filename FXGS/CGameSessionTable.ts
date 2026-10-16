import type { CUser } from "../Common/CUser.ts";
import type { HOSTHANDLE } from "../Common/HOSTHANDLE.ts";
import {
  CGameSession,
  type GameResultServices,
  type GameSessionLaunchResources,
} from "./CGameSession.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  SessionLimit,
  SessionTableRule,
  IntegerRange,
  UserCount,
  CreateSessionResult,
  JoinSessionResult,
  ChannelType,
} from "../Common/OfficialValues.ts";
import {
  ClientRequest,
  ServerResponse,
} from "../Common/Protocol/PacketTypes.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import type { CBomberAttr } from "./CBomberAttr.ts";
import type { CGameMapTmplList } from "./CGameMapTmplList.ts";

/** Modern sanitized update diagnostics. No exception text, SQL, account, packet
 * body or UUID is retained/exposed. Repeated failures replace a bounded entry. */
export interface GameSessionUpdateFailure {
  readonly SessionIndex: number;
  readonly SessionSerialNo: number;
  readonly Code: "protocol-error" | "unported-feature" | "update-error";
  readonly ConsecutiveFailures: number;
}

/** Original 255 normal room indices; serial numbers reject stale/recycled indices. */
export class CGameSessionTable {
  readonly m_rgGameSession = new Map<number, CGameSession>();
  private m_ulSerialNo = 0;
  private readonly m_setDestroyingPlayer = new Set<CClientSocket>();
  private readonly m_setRecoveringPlayer = new Set<CClientSocket>();
  private m_nRecoveryNoticeFailures = 0;
  private m_nRoomNoticeFailures = 0;
  private m_bUpdatingGameSessions = false;
  private readonly m_mapUpdateFailure = new Map<
    number,
    GameSessionUpdateFailure
  >();
  constructor(
    readonly text: CTextCodec,
    readonly bombers: CBomberAttr,
    readonly maps: CGameMapTmplList,
    readonly channelType: number,
    readonly broadcast: (packet: CSendPacket) => void,
    private readonly resultServices?: GameResultServices,
    private readonly launchResources?: GameSessionLaunchResources,
  ) {}
  GetBaseSession(index: number, serial: number): CGameSession | undefined {
    const s = this.m_rgGameSession.get(index);
    return s?.m_ulSerialNo === serial ? s : undefined;
  }
  /** 00421EE5. Modern UDP hardening drops invalid/stale indices instead of
   * letting an unauthenticated datagram disconnect a named user's TCP socket. */
  OnUDPPeerInfo(
    index: number,
    serial: number,
    user: CUser,
    observed: HOSTHANDLE,
    addresses: readonly number[],
    ports: readonly number[],
  ): boolean {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= SessionLimit.GameSessions
    )
      return false;
    const room = this.GetBaseSession(index, serial);
    if (!room || room.FindPlayerSlot(user) < 0) return false;
    return room.OnUDPPeerInfo(user, observed, addresses, ports);
  }
  GetSession(socket: CClientSocket): CGameSession | undefined {
    const user = socket.GetUser(0);
    return user
      ? this.GetBaseSession(user.m_nSessionIdx, user.m_nSessionSerialNo)
      : undefined;
  }
  PutAllSessionInfo(socket: CClientSocket): void {
    // Original striped-lock traversal order, even though Bun needs no eight locks.
    for (let stripe = 0; stripe < SessionTableRule.LockStripes; stripe++)
      for (
        let i = stripe;
        i < SessionLimit.GameSessions;
        i += SessionTableRule.LockStripes
      ) {
        const room = this.m_rgGameSession.get(i);
        if (room) socket.SendPacket(room.MakeSimpleInfoPacket());
      }
  }
  /** 004219A2 normal-room striped traversal, with an explicit modern scope
   * gate: native ordinary Loading and bound Running/Result are scheduled.
   * Waiting-chief/practice/special modes are NOT silently declared implemented.
   * A pending money plan retries inside the room before clock/world updates.
   * One room's SQL/unsupported/identity failure cannot stop all other rooms.
   * Failed frozen plans may retry on the next tick under the existing receipt
   * guard; this is NOT a conflict repair or live-room restart recovery system.
   */
  UpdateGameSessions(): void {
    if (this.m_bUpdatingGameSessions) return;
    this.m_bUpdatingGameSessions = true;
    try {
      for (let stripe = 0; stripe < SessionTableRule.LockStripes; stripe++)
        for (
          let index = stripe;
          index < SessionLimit.GameSessions;
          index += SessionTableRule.LockStripes
        ) {
          const room = this.m_rgGameSession.get(index);
          if (!room?.HasScheduledGame()) {
            this.m_mapUpdateFailure.delete(index);
            continue;
          }
          try {
            room.Update();
            this.FlushModifiedInfo(room);
            this.m_mapUpdateFailure.delete(index);
          } catch (error) {
            const previous = this.m_mapUpdateFailure.get(index);
            this.m_mapUpdateFailure.set(index, {
              SessionIndex: index,
              SessionSerialNo: room.m_ulSerialNo,
              Code:
                error instanceof CProtocolError
                  ? "protocol-error"
                  : error instanceof CUnsupportedOperation
                    ? "unported-feature"
                    : "update-error",
              ConsecutiveFailures:
                previous?.SessionSerialNo === room.m_ulSerialNo
                  ? previous.ConsecutiveFailures + 1
                  : 1,
            });
          }
        }
    } finally {
      this.m_bUpdatingGameSessions = false;
    }
  }
  /** 00421A5A: normal 255-room stripes only, without an IsValid/round gate.
   * CGameSession::UpdateGameEtc is a verified native ret. Missing Map entries
   * stand for native preallocated inactive objects and have no effects either.
   * Do NOT turn this no-op hook into invented maintenance or call it on a
   * guessed cadence; native CTimerThreadNormal::Proc does not call this hook.
   */
  UpdateGameEtc(): void {
    for (let stripe = 0; stripe < SessionTableRule.LockStripes; stripe++)
      for (
        let index = stripe;
        index < SessionLimit.GameSessions;
        index += SessionTableRule.LockStripes
      )
        this.m_rgGameSession.get(index)?.UpdateGameEtc();
  }
  GetUpdateFailures(): readonly GameSessionUpdateFailure[] {
    return [...this.m_mapUpdateFailure.values()].map((failure) => ({
      ...failure,
    }));
  }
  GetScheduledRoundCount(): number {
    return [...this.m_rgGameSession.values()].filter((room) =>
      room.GetResultRoundID(),
    ).length;
  }
  GetLoadingSessionCount(): number {
    return [...this.m_rgGameSession.values()].filter((room) =>
      room.IsLoadingGame(),
    ).length;
  }
  GetPendingResultCount(): number {
    return [...this.m_rgGameSession.values()].filter((room) =>
      room.IsResultCommitPending(),
    ).length;
  }
  GetPendingMoneyPickupCount(): number {
    return [...this.m_rgGameSession.values()].filter((room) =>
      room.IsMoneyPickupPending(),
    ).length;
  }
  GetPendingHouseClaimCount(): number {
    return [...this.m_rgGameSession.values()].filter((room) =>
      room.IsHouseClaimPending(),
    ).length;
  }
  GetPendingSpecialItemUseCount(): number {
    return [...this.m_rgGameSession.values()].filter((room) =>
      room.IsSpecialItemUsePending(),
    ).length;
  }
  private DecodeBombers(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): number[] {
    const n = packet.Decode1();
    if (n !== socket.GetUserCount())
      throw new CProtocolError("Player count mismatch");
    return Array.from(
      { length: n },
      () => packet.Decode1() % (this.bombers.GetTotalCount() + 1),
    );
  }
  CreateSession(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const title = packet.DecodeStr(SessionLimit.TitleBytes);
    const password = packet.DecodeStr(SessionLimit.PasswordBytes);
    const manner = packet.Decode1();
    const bombers = this.DecodeBombers(packet, socket);
    packet.AssertEnd();
    if (this.channelType === ChannelType.Guild)
      throw new CUnsupportedOperation(
        "CGuildSessionStrategy",
        "guild DB/match state is not ported",
      );
    if (socket.m_aUser.some((u) => u.m_nSessionIdx !== SessionLimit.NoSession))
      throw new CProtocolError("Already in a room");
    let index = 0;
    while (this.m_rgGameSession.has(index) && index < SessionLimit.GameSessions)
      index++;
    if (index === SessionLimit.GameSessions) {
      socket.SendPacket(
        new CSendPacket(
          ServerResponse.CreateSession,
          undefined,
          this.text,
        ).Encode1(CreateSessionResult.NoFreeRoom),
      );
      return;
    }
    const room = new CGameSession(
      index,
      (this.m_ulSerialNo = (this.m_ulSerialNo + 1) >>> 0),
      title,
      password,
      manner,
      this.text,
      this.bombers,
      this.maps,
      this.channelType,
      this.launchResources?.CreateClock?.(),
      this.resultServices,
      {
        EjectPlayerForUDP: (session, target, noticeUser) =>
          this.EjectPlayerForUDP(session, target, noticeUser),
      },
      this.launchResources,
    );
    room.AddAllUser(socket, bombers);
    this.m_rgGameSession.set(index, room);
    socket.SendPacket(
      new CSendPacket(ServerResponse.CreateSession, undefined, this.text)
        .Encode1(CreateSessionResult.Success)
        .Encode2(index)
        .Encode4(room.m_ulSerialNo)
        .Encode1(manner),
    );
    room.SendSessionInfoPacket(socket);
    room.m_nModified = 0;
    this.broadcast(room.MakeCreatedPacket());
  }
  JoinSession(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const index = packet.Decode2();
    const serial = packet.Decode4();
    const password = packet.DecodeStr(SessionLimit.PasswordBytes);
    const bombers = this.DecodeBombers(packet, socket);
    packet.AssertEnd();
    this.DoJoinSession(socket, index, serial, password, bombers);
  }
  DoJoinSession(
    socket: CClientSocket,
    index: number,
    serial: number,
    password: string,
    bombers: readonly number[],
  ): void {
    const room = this.GetBaseSession(index, serial);
    let code: number = JoinSessionResult.Success;
    if (
      !room ||
      room.m_bPlaying ||
      socket.m_aUser.some((u) => u.m_nSessionIdx !== SessionLimit.NoSession) ||
      room.GetEmptySlotCount() < socket.GetUserCount()
    )
      code = JoinSessionResult.Unavailable;
    else if (room.m_strPassword && room.m_strPassword !== password)
      code = JoinSessionResult.IncorrectPassword;
    if (code || !room) {
      socket.SendPacket(
        new CSendPacket(
          ServerResponse.JoinSession,
          undefined,
          this.text,
        ).Encode1(code),
      );
      return;
    }
    room.AddAllUser(socket, bombers);
    socket.SendPacket(
      new CSendPacket(ServerResponse.JoinSession, undefined, this.text).Encode1(
        JoinSessionResult.Success,
      ),
    );
    room.SendSessionInfoPacket(socket);
    room.SendJoinPacket(socket);
    room.SendGameType(socket);
    this.FlushModifiedInfo(room);
  }
  JoinFreeSession(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const bombers = this.DecodeBombers(packet, socket);
    packet.AssertEnd();
    // Safe deterministic first-fit policy, not a claim to restore original matchmaking scores.
    const room = [...this.m_rgGameSession.values()].find(
      (r) =>
        !r.m_strPassword &&
        !r.m_bPlaying &&
        r.GetEmptySlotCount() >= socket.GetUserCount(),
    );
    if (room)
      this.DoJoinSession(socket, room.m_nIdx, room.m_ulSerialNo, "", bombers);
    else
      socket.SendPacket(
        new CSendPacket(
          ServerResponse.JoinSession,
          undefined,
          this.text,
        ).Encode1(JoinSessionResult.Unavailable),
      );
  }
  /** Modern callback reentry guard for channel transitions/195 publication. */
  IsRemovingPlayer(socket: CClientSocket): boolean {
    return (
      this.m_setDestroyingPlayer.has(socket) ||
      this.m_setRecoveringPlayer.has(socket) ||
      !!this.GetSession(socket)?.IsRemovingPlayer()
    );
  }
  GetRemovalPublicationFailures(): Readonly<{
    RecoveryNotice: number;
    RoomNotice: number;
  }> {
    return {
      RecoveryNotice: this.m_nRecoveryNoticeFailures,
      RoomNotice: this.m_nRoomNoticeFailures,
    };
  }
  /** 00421C32 ordinary normal-table generation/close boundary. Unsupported
   * room cascades preflight BEFORE identities or pointers are cleared. */
  DestroyPlayer(socket: CClientSocket, includeSelf = false): boolean {
    if (this.m_setDestroyingPlayer.has(socket))
      throw new CProtocolError("Nested table player removal");
    const primary = socket.GetUser(0),
      count = socket.GetUserCount();
    if (count) {
      const users = Array.from(socket.m_aUser);
      // Native room IDX/serial live on the shared TCP socket. Replicated CUser
      // fields must agree even on the stale/no-room branch, or clearing the
      // group could corrupt a DIFFERENT live room. Closed/SetFree is allowed.
      if (
        !primary ||
        count < UserCount.Minimum ||
        count > UserCount.Maximum ||
        new Set(users).size !== count ||
        users.some(
          (u, self) =>
            !u ||
            u.m_pClientSocket !== socket ||
            u.GetSelfidx() !== self ||
            u.GetSessionIdx() !== primary.GetSessionIdx() ||
            u.GetSessionSerialNo() !== primary.GetSessionSerialNo(),
        )
      )
        throw new CProtocolError("Incoherent departing local-player group");
    }
    const room = this.GetSession(socket);
    if (!room) {
      // Native stale-generation table path clears session IDX/serial but not
      // the retained slotidx; never remove a recycled room's current occupant.
      if (
        primary &&
        primary.GetSessionIdx() < SessionLimit.GameSessions &&
        socket.m_aUser.every((u) => u.m_pClientSocket === socket)
      )
        for (const user of socket.m_aUser) {
          user.m_nSessionIdx = SessionLimit.NoSession;
          user.m_nSessionSerialNo = IntegerRange.UInt32Maximum;
        }
      return false;
    }
    room.ValidatePlayerRemoval(socket);
    this.m_setDestroyingPlayer.add(socket);
    try {
      // 00421C32 clears these BEFORE the game virtual call; Native socket-shared
      // fields are replicated on this deployment's CUsers. Slotidx stays live.
      for (const user of socket.m_aUser) {
        user.m_nSessionIdx = SessionLimit.NoSession;
        user.m_nSessionSerialNo = IntegerRange.UInt32Maximum;
      }
      if (!room.DestroyPlayer(socket, includeSelf)) return false;
      if (
        !room.GetCurPlayer() &&
        this.GetBaseSession(room.m_nIdx, room.m_ulSerialNo) === room
      ) {
        this.m_rgGameSession.delete(room.m_nIdx);
        this.m_mapUpdateFailure.delete(room.m_nIdx);
        this.PublishRoomInfo(room.MakeDestroyedPacket());
      } else this.FlushModifiedInfo(room);
      return true;
    } finally {
      this.m_setDestroyingPlayer.delete(socket);
    }
  }
  /** CUdpLossRegulator00416460..00416558 -> tableDestroy -> primary IsSetFree /
   * TCP closing guard -> EMPTY195 -> pool4. Not a transport reconnect, rank
   * removal or auto-Lobby; late session packets are ignored until a valid route. */
  EjectPlayerForUDP(
    room: CGameSession,
    socket: CClientSocket,
    noticeUser = socket.GetUser(0),
  ): void {
    if (
      this.m_setRecoveringPlayer.has(socket) ||
      this.GetBaseSession(room.m_nIdx, room.m_ulSerialNo) !== room ||
      this.GetSession(socket) !== room
    )
      throw new CProtocolError("UDP ejection room generation mismatch/reentry");
    if (
      !noticeUser ||
      !socket.m_aUser.includes(noticeUser) ||
      noticeUser.m_pClientSocket !== socket
    )
      throw new CProtocolError(
        "UDP recovery notice user is not owned by socket",
      );
    this.m_setRecoveringPlayer.add(socket);
    try {
      if (!this.DestroyPlayer(socket))
        throw new CProtocolError("UDP ejection did not remove a player");
      if (noticeUser.IsSetFree() === 0 && socket.IsConnected()) {
        try {
          socket.SendPacket(
            new CSendPacket(
              ServerResponse.UDPConnectionRejected,
              undefined,
              this.text,
            ),
          );
        } catch {
          this.m_nRecoveryNoticeFailures++;
        } finally {
          socket.m_nPoolType = "SessionRemoved";
        } // native+468 =4 AFTER send
      }
    } finally {
      this.m_setRecoveringPlayer.delete(socket);
    }
  }
  private PublishRoomInfo(packet: CSendPacket): void {
    try {
      this.broadcast(packet);
    } catch {
      this.m_nRoomNoticeFailures++;
    } // committed departure is not replayed
  }
  private FlushModifiedInfo(room: CGameSession): void {
    if (room.IsGameplayCommitPending()) return; // preserve frozen native dirty/state snapshot
    // A due UDP batch can close the last-peer room INSIDE Update. Map presence
    // is native IsValid: never emit a stale86 after that generation's87, or
    // flush a replaced generation merely because its Update stack is unwinding.
    if (this.GetBaseSession(room.m_nIdx, room.m_ulSerialNo) !== room) return;
    const p = room.MakeModifiedPacket();
    if (p) this.PublishRoomInfo(p);
  }
  OnRequestSessionInfoDetail(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): void {
    const room = this.GetBaseSession(packet.Decode2(), packet.Decode4());
    packet.AssertEnd();
    const p = new CSendPacket(
      ServerResponse.SessionDetail,
      undefined,
      this.text,
    ).Encode1(room ? 1 : 0);
    if (room) {
      for (const user of room.m_rgPlayer) {
        p.Encode1(user ? 1 : 0);
        if (user)
          p.Encode1(user.m_userInfo.Gender)
            .EncodeStr(user.GetName())
            .Encode2(user.GetLevel())
            .Encode1(0)
            .Encode1(user.m_nSlotIdx === room.m_nChiefSlotidx ? 1 : 0);
      }
      p.Encode4(0); // Waiting-room state has no elapsed gameplay timer (0041FBC7).
    }
    socket.SendPacket(p);
  }
  OnPacket(packet: CReceivedPacketBase, socket: CClientSocket): void {
    if (this.IsRemovingPlayer(socket))
      throw new CProtocolError("Session packet during table removal");
    switch (packet.Decode1()) {
      case ClientRequest.CreateSession:
        this.CreateSession(packet, socket);
        return;
      case ClientRequest.JoinSession:
        this.JoinSession(packet, socket);
        return;
      case ClientRequest.AutoJoinSession:
        this.JoinFreeSession(packet, socket);
        return;
      case ClientRequest.RequestSessionInfoDetail:
        this.OnRequestSessionInfoDetail(packet, socket);
        return;
      default: {
        const room = this.GetSession(socket);
        if (!room) {
          const index = socket.GetUser(0)?.GetSessionIdx();
          // 0042233B: no-room (>=255) requests are ignored, not disconnected;
          // valid-range stale generations are ignored ONLY for native pool4.
          if (
            index !== undefined &&
            (index >= SessionLimit.GameSessions ||
              socket.m_nPoolType === "SessionRemoved")
          )
            return;
          throw new CProtocolError("Session request without a room");
        }
        packet.Rewind();
        room.OnPacket(packet, socket);
        this.FlushModifiedInfo(room);
      }
    }
  }
}
