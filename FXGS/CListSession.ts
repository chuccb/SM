import {
  CaptureBanPlayerObservation,
  PlanHostAskBanPlayer,
  PlanRespondToBanPlayer,
  PlanDeferBanPlayer,
  PlanBanPlayerAfterDeparture,
  type BanPlayerObservation,
  type BanPlayerPlan,
  type BanPlayerDepartureObservation,
} from "./BanPlayer.ts";
import type { CUser } from "../Common/CUser.ts";
import { CBaseSession } from "./CBaseSession.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import {
  SessionLimit,
  SlotStateMask,
  SessionModified,
  ChatFormat,
  ListSessionLayout,
  UserCount,
} from "../Common/OfficialValues.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";

export class CListSession extends CBaseSession {
  m_nChiefSlotidx: number = SessionLimit.NoSlot;
  /** Native+780 votes and +152 DWORD matrix; no invented matrix semantics. */
  readonly m_anBanPlayerVote = new Uint32Array(SessionLimit.Players);
  readonly m_adwOpaqueSlotMatrix = new Uint32Array(
    ListSessionLayout.SlotMatrixStride ** 2,
  );
  m_nMapIdx = -1;
  m_bPlaying = false;
  m_nMaxPlayer: number = SessionLimit.Players;
  m_nModified = 0;
  // Native +828 is the vote-ban TARGET GLOBAL SERIAL (OnRespondToBanPlayer),
  // not a ready-count or generic dirty flag. CGameSession owns waiting vote dispatch.
  m_ulBanTargetSerialNo = 0;
  private m_bPreparingBanPlayer = false;
  m_bBangPok = false;
  protected m_dwStartChatTimeTick = 0;
  constructor(
    index: number,
    serial: number,
    public m_strName: string,
    readonly m_strPassword: string,
    readonly m_nManner: number,
    text: CTextCodec,
  ) {
    super(index, serial, text);
    text.AssertSize(m_strName, SessionLimit.TitleBytes, "room title");
    text.AssertSize(m_strPassword, SessionLimit.PasswordBytes, "room password");
  }
  /** Detached modern observations, NOT permission to install a vote or execute
   * numeric SocketKey intents later. Ordinary waiting104/105 dispatch uses
   * separate private issuance/table scopes, NEVER these returned DTOs. */
  CaptureBanPlayerObservation(): Readonly<BanPlayerObservation> {
    const sockets = this.GetSockets();
    for (const socket of sockets) {
      const locals = Array.from(socket.m_aUser);
      if (
        locals.length < UserCount.Minimum ||
        locals.length > UserCount.Maximum ||
        locals.some(
          (user, self) =>
            !user ||
            user.m_pClientSocket !== socket ||
            user.GetSelfidx() !== self ||
            this.m_rgPlayer[user.m_nSlotIdx] !== user,
        )
      )
        throw new CProtocolError(
          "Ban-player observation has an incomplete local group",
        );
    }
    return CaptureBanPlayerObservation({
      Actors: this.m_rgPlayer.map((user, slot) => {
        if (!user) return null;
        const socket = user.m_pClientSocket,
          self = user.GetSelfidx();
        if (
          !socket ||
          socket.m_aUser[self] !== user ||
          user.m_nSlotIdx !== slot ||
          user.IsSetFree() !== 0 ||
          user.GetSessionIdx() !== this.m_nIdx ||
          user.GetSessionSerialNo() !== this.m_ulSerialNo
        )
          throw new CProtocolError(
            "Ban-player observation has a stale room owner",
          );
        return {
          SerialNo: user.GetGlobalSerialNo(),
          SocketKey: sockets.indexOf(socket),
          Self: self,
          Name: user.GetName(),
        };
      }),
      Votes: Array.from(this.m_anBanPlayerVote),
      TargetSerialNo: this.m_ulBanTargetSerialNo,
      ChiefSlot: this.m_nChiefSlotidx,
    });
  }
  /** Modern synchronous observation fence, NOT an execution/financial lease. */
  protected GetBanPlayerObservationContext(): string {
    return JSON.stringify([
      this.m_nIdx,
      this.m_ulSerialNo,
      this.m_bPlaying,
      this.m_bBangPok,
    ]);
  }
  protected CaptureBanPlayerPreparation() {
    const context = this.GetBanPlayerObservationContext(),
      users = this.m_rgPlayer.slice(),
      players = this.m_rgPlayer,
      groups = this.GetSockets().map((socket) => ({
        Socket: socket,
        Array: socket.m_aUser,
        Users: socket.m_aUser.slice(),
        Connected: socket.IsConnected(),
        Pool: socket.m_nPoolType,
      })),
      epoch = (user: CUser) =>
        (
          user as CUser & { GetConnectionGeneration?: () => object }
        ).GetConnectionGeneration?.(),
      owners = users.map((user) =>
        user
          ? {
              Info: user.m_userInfo,
              Native: user.CaptureUserInventory()?.Rows,
              Pre: user.CapturePreInventory().Rows,
              OwnedEpoch: user.GetUserInventoryGeneration(),
              PreEpoch: user.GetPreInventoryGeneration(),
              ConnectionEpoch: epoch(user),
              Legacy: user.m_aInventory,
            }
          : null,
      ),
      observation = this.CaptureBanPlayerObservation(),
      fingerprint = JSON.stringify(observation);
    const stable = () => {
      if (
        this.GetBanPlayerObservationContext() !== context ||
        this.m_rgPlayer !== players ||
        this.m_rgPlayer.some((u, i) => u !== users[i]) ||
        groups.some(
          (g) =>
            g.Socket.m_aUser !== g.Array ||
            g.Socket.m_aUser.length !== g.Users.length ||
            g.Socket.m_aUser.some((u, i) => u !== g.Users[i]) ||
            g.Socket.IsConnected() !== g.Connected ||
            g.Socket.m_nPoolType !== g.Pool,
        )
      )
        throw new CProtocolError("Ban-player observation ownership changed");
      users.forEach((u, i) => {
        const o = owners[i];
        if (
          u &&
          (!o ||
            u.m_userInfo !== o.Info ||
            u.m_aInventory !== o.Legacy ||
            u.CaptureUserInventory()?.Rows !== o.Native ||
            u.CapturePreInventory().Rows !== o.Pre ||
            u.GetUserInventoryGeneration().Native !== o.OwnedEpoch.Native ||
            u.GetUserInventoryGeneration().Revision !== o.OwnedEpoch.Revision ||
            u.GetPreInventoryGeneration() !== o.PreEpoch ||
            epoch(u) !== o.ConnectionEpoch)
        )
          throw new CProtocolError("Ban-player observation generation changed");
      });
      if (JSON.stringify(this.CaptureBanPlayerObservation()) !== fingerprint)
        throw new CProtocolError("Ban-player observation state changed");
    };
    stable();
    return {
      Observation: observation,
      Stable: stable,
      Sockets: groups.map((g) => g.Socket),
      Query: (slot: number, attribute: string) => {
        stable();
        const found = users[slot]!.HasFunctionalItem(attribute);
        stable();
        return found;
      },
    };
  }
  protected WithBanPlayerPreparation<T>(
    action: (
      capture: ReturnType<CListSession["CaptureBanPlayerPreparation"]>,
    ) => T,
  ): T {
    if (this.m_bPreparingBanPlayer)
      throw new CProtocolError("Reentrant ban-player preparation");
    this.m_bPreparingBanPlayer = true;
    try {
      const capture = this.CaptureBanPlayerPreparation(),
        result = action(capture);
      capture.Stable();
      return result;
    } finally {
      this.m_bPreparingBanPlayer = false;
    }
  }
  PrepareHostAskBanPlayer(
    socket: CClientSocket,
    request: Readonly<{ TargetSerialNo: number; Immediate: number }>,
  ): Readonly<BanPlayerPlan> {
    return this.WithBanPlayerPreparation((capture) => {
      const key = capture.Sockets.indexOf(socket);
      if (key < 0)
        throw new CProtocolError("Ban-player requester outside room");
      return PlanHostAskBanPlayer(
        capture.Observation,
        key,
        request,
        capture.Query,
      );
    });
  }
  PrepareRespondToBanPlayer(
    socket: CClientSocket,
    response: Readonly<{ TargetSerialNo: number; Answer: number }>,
  ): Readonly<BanPlayerPlan> {
    return this.WithBanPlayerPreparation((capture) => {
      const key = capture.Sockets.indexOf(socket);
      if (key < 0)
        throw new CProtocolError("Ban-player respondent outside room");
      return PlanRespondToBanPlayer(capture.Observation, key, response);
    });
  }
  PrepareDeferBanPlayer(): Readonly<BanPlayerPlan> {
    return this.WithBanPlayerPreparation((capture) =>
      PlanDeferBanPlayer(capture.Observation),
    );
  }
  PrepareBanPlayerAfterDeparture(
    socket: CClientSocket,
  ): Readonly<BanPlayerDepartureObservation> {
    return this.WithBanPlayerPreparation((capture) => {
      const key = capture.Sockets.indexOf(socket);
      if (key < 0)
        throw new CProtocolError("Ban-player departure outside room");
      if (
        this.m_nIdx < 0 ||
        this.m_nIdx >= SessionLimit.GameSessions ||
        this.IsBangPok()
      )
        throw new CProtocolError(
          "Only ordinary first-occupied chief departure is modeled",
        );
      return PlanBanPlayerAfterDeparture(capture.Observation, key);
    });
  }
  /** CListSession::IsManner @ 0042173F; independent of normal/mod type. */
  IsManner(): boolean {
    return this.m_nManner !== 0;
  }
  /** 004238DA always marks the lobby-list Playing bit, even if unchanged. */
  SetPlaying(value: boolean): void {
    this.m_bPlaying = value;
    this.m_nModified |= SessionModified.Playing;
  }
  /** Native 00421746 / 0042174D. BangPok teardown is still not implemented. */
  GetStartChatTimeTick(): number {
    return this.m_dwStartChatTimeTick;
  }
  IsBangPok(): boolean {
    return this.m_bBangPok;
  }
  GetCurPlayer(): number {
    return this.m_rgPlayer.filter(Boolean).length;
  }
  /** CListSession::GetPlayerNo @ 00414C04 (native cached byte at +832). */
  GetPlayerNo(): number {
    return this.GetCurPlayer();
  }
  IsChief(socket: CClientSocket): boolean {
    return this.m_rgPlayer[this.m_nChiefSlotidx]?.m_pClientSocket === socket;
  }
  RequireChief(socket: CClientSocket): void {
    if (!this.IsChief(socket))
      throw new CProtocolError("Only the room chief may do this");
  }
  SetChiefSlotidx(slot: number): void {
    const chief = slot >= 0 ? this.m_rgPlayer[slot] : undefined;
    if (
      !Number.isInteger(slot) ||
      slot >= SessionLimit.Players ||
      slot < -2 ||
      (slot >= 0 && !chief)
    )
      throw new CProtocolError("Missing room chief");
    for (let i = 0; i < SessionLimit.Players; i++)
      this.m_rgSlotInfo[i]![0] =
        this.m_rgSlotInfo[i]![0]! & ~SlotStateMask.Chief;
    this.m_nChiefSlotidx = slot;
    this.m_bBangPok = slot === SessionLimit.NoEligibleChief;
    if (slot >= 0) {
      if (!chief) throw new CProtocolError("Missing room chief");
      this.m_rgSlotInfo[slot]![0] =
        this.m_rgSlotInfo[slot]![0]! | SlotStateMask.Chief;
      for (const user of !this.m_bPlaying
        ? (chief.m_pClientSocket?.m_aUser ?? [])
        : []) {
        const i = this.FindPlayerSlot(user);
        if (i >= 0)
          this.m_rgSlotInfo[i]![0] =
            this.m_rgSlotInfo[i]![0]! & ~SlotStateMask.Status;
      }
    }
  }
  MakeSimpleInfoPacket(): CSendPacket {
    return new CSendPacket(ServerResponse.RoomSimpleInfo, undefined, this.text)
      .Encode2(this.m_nIdx)
      .Encode4(this.m_ulSerialNo)
      .EncodeStr(this.m_strName)
      .Encode1(this.m_strPassword ? 1 : 0)
      .Encode1(this.m_nManner)
      .Encode1(this.m_bPlaying ? 1 : 0)
      .Encode2(this.m_nMapIdx & 0xffff)
      .Encode1(this.GetCurPlayer())
      .Encode1(this.m_nMaxPlayer);
  }
  MakeCreatedPacket(): CSendPacket {
    return new CSendPacket(ServerResponse.RoomCreated, undefined, this.text)
      .Encode2(this.m_nIdx)
      .Encode4(this.m_ulSerialNo)
      .EncodeStr(this.m_strName)
      .Encode1(this.m_strPassword ? 1 : 0)
      .Encode1(this.m_nManner)
      .Encode1(this.GetCurPlayer())
      .Encode1(this.m_nMaxPlayer);
  }
  MakeModifiedPacket(): CSendPacket | undefined {
    const flags = this.m_nModified;
    if (!flags) return;
    const p = new CSendPacket(ServerResponse.RoomModified, undefined, this.text)
      .Encode2(this.m_nIdx)
      .Encode4(this.m_ulSerialNo)
      .Encode1(flags);
    if (flags & SessionModified.Playing) p.Encode1(this.m_bPlaying ? 1 : 0);
    if (flags & SessionModified.Map) p.Encode2(this.m_nMapIdx & 0xffff);
    if (flags & SessionModified.PlayerCount) p.Encode1(this.GetCurPlayer());
    if (flags & SessionModified.Capacity) p.Encode1(this.m_nMaxPlayer);
    if (flags & SessionModified.Title) p.EncodeStr(this.m_strName);
    this.m_nModified = 0;
    return p;
  }
  MakeDestroyedPacket(): CSendPacket {
    return new CSendPacket(ServerResponse.RoomDestroyed, undefined, this.text)
      .Encode2(this.m_nIdx)
      .Encode4(this.m_ulSerialNo);
  }
  /** 004251E0. Two-local-player senders are explicitly not allowed; messages
   * go to matching-color slots, excluding the sender, using response 27. */
  OnTeamChat(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const message = packet.DecodeStr(RuntimePolicy.MaxChatInputBytes);
    packet.AssertEnd();
    if (socket.GetUserCount() !== 1) return;
    const user = socket.GetUser(0)!;
    const slot = this.FindPlayerSlot(user);
    if (slot < 0) throw new CProtocolError("Team chat outside room");
    const color = this.AssertSlot(slot)[2]! & SlotStateMask.Color;
    const formatted = `${user.GetName()} : ${message}`;
    this.text.AssertSize(
      formatted,
      ChatFormat.MaximumFormattedBytes,
      "team chat",
    );
    const out = new CSendPacket(
      ServerResponse.Whisper,
      undefined,
      this.text,
    ).EncodeStr(formatted);
    // Deliberately per slot, as the native loop is; a two-player recipient can
    // receive the same packet twice. This is not ordinary room broadcast.
    for (let i = 0; i < SessionLimit.Players; i++) {
      const target = this.m_rgPlayer[i];
      if (
        target &&
        i !== slot &&
        (this.AssertSlot(i)[2]! & SlotStateMask.Color) === color
      )
        target.m_pClientSocket?.SendPacket(out);
    }
  }
  /** 004238BA is the genuine pass-through List layer, not a second cleanup. */
  override DestroyPlayer(socket: CClientSocket, includeSelf = false): boolean {
    super.DestroyPlayer(socket, includeSelf);
    return true;
  }
  /** 00423DB6, only the active eight rows/columns are cleared; native memory
   * stride is TWELVE, not eight. Unrelated cells and unused columns survive. */
  protected override DeleteUser(slot: number): void {
    super.DeleteUser(slot);
    this.m_anBanPlayerVote[slot] = 0;
    for (let other = 0; other < SessionLimit.Players; other++) {
      this.m_adwOpaqueSlotMatrix[
        slot * ListSessionLayout.SlotMatrixStride + other
      ] = 0;
      this.m_adwOpaqueSlotMatrix[
        other * ListSessionLayout.SlotMatrixStride + slot
      ] = 0;
    }
    this.m_nModified |= SessionModified.PlayerCount;
  }
  /** 00423D3B ordinary rooms. RoomTicket/Supreme selection is not enabled. */
  GetNextChiefSlot(): number {
    const slot = this.m_rgPlayer.findIndex(Boolean);
    return slot < 0 ? SessionLimit.NoEligibleChief : slot;
  }
  /** 0042404B: second local players on the NEW chief socket first, then OLD
   * chief slot (even vacant), then NEW chief slot. Do not broadcast all slots. */
  SetNewChief(slot: number = SessionLimit.NoSlot): void {
    const previous = this.m_nChiefSlotidx;
    this.SetChiefSlotidx(slot < 0 ? this.GetNextChiefSlot() : slot);
    if (this.m_nChiefSlotidx >= 0)
      for (let i = 0; i < SessionLimit.Players; i++)
        if (
          this.m_rgPlayer[i] &&
          i !== this.m_nChiefSlotidx &&
          this.IsChief(this.m_rgPlayer[i]!.m_pClientSocket!)
        )
          this.PutPacket(this.MakeSetSlotStatePacket(i));
    if (previous >= 0) this.PutPacket(this.MakeSetSlotStatePacket(previous));
    if (this.m_nChiefSlotidx >= 0)
      this.PutPacket(this.MakeSetSlotStatePacket(this.m_nChiefSlotidx));
  }
}
