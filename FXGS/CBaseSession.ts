import { PutSlotAccessoryList } from "../Common/UserInventory.ts";
import { UserInventoryRule } from "../Common/OfficialValues.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CUser } from "../Common/CUser.ts";
import { SessionLimit, SlotStateMask } from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";

/** FXGS CBaseSession: bounded packed slot state; no new client-side object format. */
export class CBaseSession {
  readonly m_rgPlayer: (CUser | undefined)[] = Array.from({
    length: SessionLimit.Players,
  });
  readonly m_rgSlotInfo: Buffer[] = Array.from(
    { length: SessionLimit.Players },
    () => Buffer.alloc(3),
  );
  private readonly m_aPendingPackets: {
    Type: number;
    Cipher: ReturnType<CSendPacket["GetCipherDegree"]>;
    Bytes: Buffer;
    Targets: readonly CClientSocket[];
  }[] = [];
  private m_nPacketBatchDepth = 0;
  private m_bFlushingPackets = false;
  private m_nPacketPublicationFailures = 0;
  constructor(
    readonly m_nIdx: number,
    readonly m_ulSerialNo: number,
    readonly text: CTextCodec,
  ) {}
  GetEmptySlotCount(): number {
    return this.m_rgPlayer.filter(
      (p, i) => !p && !(this.m_rgSlotInfo[i]![0]! & SlotStateMask.Closed),
    ).length;
  }
  /** 00419880 reads CUser+1960, even after DeleteAllUser has cleared pointers. */
  GetSlotidx(user: CUser): number {
    return user.m_nSlotIdx;
  }
  /** Modern membership validation must NOT confuse a retained native slot
   * with a current room pointer (especially during reset106/stale generations). */
  FindPlayerSlot(user: CUser): number {
    const slot = this.GetSlotidx(user);
    return Number.isInteger(slot) &&
      slot >= 0 &&
      slot < SessionLimit.Players &&
      this.m_rgPlayer[slot] === user
      ? slot
      : SessionLimit.NoSlot;
  }
  GetSockets(): CClientSocket[] {
    return [
      ...new Set(
        this.m_rgPlayer.flatMap((u) =>
          u?.m_pClientSocket ? [u.m_pClientSocket] : [],
        ),
      ),
    ];
  }
  SendPacket(packet: CSendPacket, except?: CClientSocket): void {
    for (const socket of this.GetSockets())
      if (socket !== except) socket.SendPacket(packet);
  }
  /** Native PutPacket snapshots a body for each current recipient. Bun stages
   * detached bodies instead of native socket send buffers; no delivery ack. */
  PutPacket(packet: CSendPacket, except?: CClientSocket): void {
    this.QueuePacketTo(
      packet,
      this.GetSockets().filter((s) => s !== except),
    );
  }
  protected QueuePacketTo(
    packet: CSendPacket,
    targets: readonly CClientSocket[],
  ): void {
    this.m_aPendingPackets.push({
      Type: packet.m_nPacketType,
      Cipher: packet.GetCipherDegree(),
      Bytes: packet.GetBuffer(),
      Targets: targets.slice(),
    });
  }
  /** Modern batching lets removal finish state mutations before any custom
   * transport callback; native methods keep their original Put/Flush ordering. */
  protected BeginPacketBatch(): void {
    this.m_nPacketBatchDepth++;
  }
  protected EndPacketBatch(): void {
    this.m_nPacketBatchDepth--;
    if (!this.m_nPacketBatchDepth) this.FlushPacket();
  }
  FlushPacket(): void {
    if (this.m_nPacketBatchDepth || this.m_bFlushingPackets) return;
    const pending = this.m_aPendingPackets.splice(0);
    this.m_bFlushingPackets = true;
    try {
      for (const { Type, Cipher, Bytes, Targets } of pending)
        for (const socket of Targets) {
          try {
            socket.SendPacket(
              new CSendPacket(Type, Cipher, this.text).EncodeBuffer(
                Bytes.subarray(1),
              ),
            );
          } catch {
            this.m_nPacketPublicationFailures++;
          }
        }
    } finally {
      this.m_bFlushingPackets = false;
    }
  }
  GetPacketPublicationFailureCount(): number {
    return this.m_nPacketPublicationFailures;
  }
  protected AssertSlot(slot: number): Buffer {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SessionLimit.Players)
      throw new CProtocolError("Invalid session slot");
    return this.m_rgSlotInfo[slot]!;
  }
  /**00419597. Native equipped fields ONLY; legacy ItemID/Verbose never grant
   * decorations by accidental catalog equality. Vacant slot appends nothing. */
  MakeSlotAccessoryPacket(slot: number, packet: CSendPacket): void {
    const user = this.m_rgPlayer[slot];
    if (user)
      PutSlotAccessoryList(
        packet,
        user.CaptureUserInventory()?.Rows ?? [],
        slot,
      );
  }
  /**00419A6E. Capture one native read-side generation INCLUDING look/icon
   * fields before a caller codec can reload it. No new client equipment API. */
  MakeSetPlayerPacket(slot: number, self: boolean): CSendPacket {
    const user = this.m_rgPlayer[slot];
    if (!user) throw new CProtocolError("No player at slot");
    const native = user.CaptureUserInventory(),
      simpleUser = native ? user.CloneForResultCalculation() : user;
    const packet = new CSendPacket(
      ServerResponse.SetPlayer,
      undefined,
      this.text,
    )
      .Encode1(slot)
      .Encode4(user.GetGlobalSerialNo())
      .Encode1(self ? 1 : 0)
      .Encode1(user.GetCommunitySvr());
    if (self)
      packet.Encode1(
        native?.Rows.find(
          (r) =>
            r.Category === UserInventoryRule.SelfInfoCategory &&
            r.Slot !== UserInventoryRule.UnequippedSlot,
        )?.nAttr1 ?? UserInventoryRule.UnequippedSlot,
      );
    packet.EncodeBuffer(this.AssertSlot(slot));
    simpleUser.AppendSimpleInfoPacket(packet);
    PutSlotAccessoryList(packet, native?.Rows ?? [], slot);
    return packet;
  }
  MakeSetSlotStatePacket(slot: number): CSendPacket {
    return new CSendPacket(ServerResponse.SetSlotState, undefined, this.text)
      .Encode1(slot)
      .EncodeBuffer(this.AssertSlot(slot));
  }
  MakeSessionInfoPacket(socket: CClientSocket): void {
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      const user = this.m_rgPlayer[slot];
      socket.SendPacket(
        user
          ? this.MakeSetPlayerPacket(slot, user.m_pClientSocket === socket)
          : this.MakeSetSlotStatePacket(slot),
      );
    }
  }
  SendJoinPacket(socket: CClientSocket): void {
    for (const user of socket.m_aUser)
      this.SendPacket(
        this.MakeSetPlayerPacket(this.FindPlayerSlot(user), true),
        socket,
      );
  }
  protected AddUser(
    user: CUser,
    slot: number,
    bomber: number,
    color: number,
  ): void {
    const info = this.AssertSlot(slot);
    if (this.m_rgPlayer[slot]) throw new CProtocolError("Occupied slot");
    this.m_rgPlayer[slot] = user;
    info[0] = info[0]! & ~(SlotStateMask.Chief | SlotStateMask.Status);
    info[1] = (info[1]! & ~SlotStateMask.Bomber) | bomber;
    info[2] = (info[2]! & ~SlotStateMask.Color) | color;
    user.m_nSlotIdx = slot;
    user.m_nSessionIdx = this.m_nIdx;
    user.m_nSessionSerialNo = this.m_ulSerialNo;
  }
  /** 00419580 clears ONLY the player pointer and chief bit. Ready, bomber,
   * color and game-state bytes are NOT reset by leaving a native room. */
  protected DeleteUser(slot: number): void {
    this.AssertSlot(slot);
    this.m_rgPlayer[slot] = undefined;
    this.m_rgSlotInfo[slot]![0] =
      this.m_rgSlotInfo[slot]![0]! & ~SlotStateMask.Chief;
  }
  /** 00419E5E is the LOW-LEVEL pointer removal, not the full departure hook.
   * Modern whole-group validation prevents a corrupt second user half-removal. */
  DeleteAllUser(socket: CClientSocket): void {
    const slots = Array.from(socket.m_aUser, (user) =>
      user ? this.FindPlayerSlot(user) : SessionLimit.NoSlot,
    );
    if (
      !slots.length ||
      slots.some((slot) => slot < 0) ||
      new Set(slots).size !== slots.length
    )
      throw new CProtocolError("Invalid departing room group");
    for (const slot of slots) this.DeleteUser(slot);
  }
  /** 004194E3, separate from session IDX/serial clearing owned by the table. */
  DeleteAllSlotidx(socket: CClientSocket): void {
    for (const user of socket.m_aUser) user.m_nSlotIdx = SessionLimit.NoSlot;
  }
  /** 00419EE1: lookup uses the retained CUser+1960 slot after pointer deletion.
   * includeSelf sends ONLY the LAST reset to the leaving two-player TCP peer. */
  SendResetPlayer(socket: CClientSocket, includeSelf = false): void {
    let last: CSendPacket | undefined;
    for (const user of socket.m_aUser) {
      const slot = this.GetSlotidx(user);
      this.AssertSlot(slot);
      last = new CSendPacket(ServerResponse.ResetPlayer, undefined, this.text)
        .Encode1(slot)
        .Encode4(user.GetGlobalSerialNo());
      this.PutPacket(last);
    }
    if (includeSelf && last) this.QueuePacketTo(last, [socket]);
    this.FlushPacket();
  }
  /** 0041A723: deleting pointers also excludes the socket from derived targets.
   * Slotidx remains until CGameSession's later DeleteAllSlotidx. */
  DestroyPlayer(socket: CClientSocket, includeSelf = false): boolean {
    this.DeleteAllUser(socket);
    this.SendResetPlayer(socket, includeSelf);
    socket.m_nPoolType = "Lobby";
    return true;
  }
}
