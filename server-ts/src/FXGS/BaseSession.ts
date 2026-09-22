/** Native source unit: FX/FxServer/BaseSession.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree, PACKET_TYPE_PLACEHOLDER } from "../core/Packet.ts";
import { S2C_GamePacket } from "../core/protocol/PacketIDs.ts";
import { CHAR_DECO_COUNT, ItemCategory, SLOT_DECORATION_COUNT } from "../common/Item.ts";
import {
  CHANNEL_TYPE_GUILD,
  MAX_SESSION_SLOTS,
  SLOTSTATE_BOMBER_CLEAR,
  SLOTSTATE_BOMBER_MASK,
  SLOTSTATE_CHIEF_CLEAR,
  SLOTSTATE_CHIEF_GROUP_CLEAR,
  SLOTSTATE_CLOSED,
  SLOTSTATE_CLOSED_CLEAR,
  SLOTSTATE_COLOR_CLEAR,
  SLOTSTATE_COLOR_MASK,
  SLOTSTATE_GROUP_MASK,
  SLOTSTATE_READY,
  ROOM_TITLE_TRUNCATION_THRESHOLD,
  ROOM_TITLE_TRUNCATED_LENGTH,
} from "./Defs.ts";
import { CBomberAttr } from "./BomberAttr.ts";
import { CMainSystem } from "./MainSystem.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";


/** CBaseSession — native room-slot, player, socket, and common packet owner. */
export class CBaseSession {
  private static m_ulSerialNo = 0;

  static get ms_ulSerialNo(): number {
    return CBaseSession.m_ulSerialNo;
  }

  static set ms_ulSerialNo(value: number) {
    CBaseSession.m_ulSerialNo = value >>> 0;
  }

  /** Native lock-group boundary; Bun executes each process on one JS thread. */
  static LockBaseSessions(_slot: number): void {}
  static UnlockBaseSessions(_slot: number): void {}

  m_strName = "";
  m_setSocket = new Set<CClientSocket>();
  fValid = 0;
  m_nIdx = 0;
  m_nSerialNo = 0;
  m_rgPlayer: (CUser | null)[];
  m_nMaxSlot: number;
  m_rgSlotState: Uint8Array;

  constructor(maxSlot = MAX_SESSION_SLOTS) {
    this.m_nMaxSlot = maxSlot;
    this.m_rgPlayer = new Array<CUser | null>(maxSlot).fill(null);
    this.m_rgSlotState = new Uint8Array(maxSlot * 3);
  }

  /** Shared head of CBaseSession::Init; practice sessions deliberately call
   * this without running CListSession/CGameSession initialization. */
  protected InitBase(title: string | null): void {
    this.fValid = 1;
    this.m_nSerialNo = ++CBaseSession.ms_ulSerialNo >>> 0;
    this.m_strName = title ?? "";
    this.m_rgPlayer.fill(null);
    this.m_rgSlotState.fill(0);
  }

  Init(title: string | null, _password: string | null = null, _gameType?: number): void {
    this.InitBase(title);
  }

  SetValid(valid: number): void {
    this.fValid = valid;
  }

  Destroy(): void {
    this.fValid = 0;
  }

  /** CBaseSession::SetColor — packed slot-state helper. */
  SetColor(slot: number, color: number): void {
    this.SetColorBits(slot, color);
  }

  /** CBaseSession::DoSelectColor — virtual selection hook. */
  DoSelectColor(slot: number, color: number): void {
    this.SetColor(slot, color);
  }

  CanRequestChangeTitle(_socket: CClientSocket): boolean {
    return true;
  }

  /** CBaseSession::DoChangeTitle. */
  DoChangeTitle(title: string): void {
    this.m_strName = title;
    const packet = new CSendPacket(S2C_GamePacket.OnChangeTitle, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(title);
    this.SendPacket(packet);
  }

  GetName(): string {
    return this.m_strName;
  }

  IsClosed(slot: number): boolean {
    return (this.m_rgSlotState[slot * 3]! & 1) !== 0;
  }

  SetClosed(slot: number, closed: boolean): void {
    const p = slot * 3;
    this.m_rgSlotState[p] = closed ? (this.m_rgSlotState[p]! | SLOTSTATE_CLOSED) : (this.m_rgSlotState[p]! & SLOTSTATE_CLOSED_CLEAR);
  }

  IsReady(slot: number): boolean {
    return (this.m_rgSlotState[slot * 3]! & SLOTSTATE_READY) !== 0;
  }

  /** CanStartGame's stand-by probe — the whole 0x1C group. */
  GetReadyGroup(slot: number): number {
    return this.m_rgSlotState[slot * 3]! & SLOTSTATE_GROUP_MASK;
  }

  GetColor(slot: number): number {
    return this.m_rgSlotState[slot * 3 + 2]! & SLOTSTATE_COLOR_MASK;
  }

  /** Shared packed-state write, WITHOUT the game-strategy colour hook.
   * Original: dst ^= (dst ^ color) & 0x1F (AddUser / map fold / start). */
  protected SetColorBits(slot: number, color: number): void {
    const at = slot * 3 + 2;
    this.m_rgSlotState[at] = (this.m_rgSlotState[at]! & SLOTSTATE_COLOR_CLEAR) | (color & SLOTSTATE_COLOR_MASK);
  }

  GetBomber(slot: number): number {
    return this.m_rgSlotState[slot * 3 + 1]! & SLOTSTATE_BOMBER_MASK;
  }

  SetBomber(slot: number, bomber: number): void {
    const p = slot * 3 + 1;
    this.m_rgSlotState[p] = (this.m_rgSlotState[p]! & SLOTSTATE_BOMBER_CLEAR) | (bomber & SLOTSTATE_BOMBER_MASK);
  }

  /** CBaseSession::IsEmptySlot — nobody seated and the slot open. */
  IsEmptySlot(slot: number): boolean {
    return this.m_rgPlayer[slot] === null && !this.IsClosed(slot);
  }

  IsNullSlot(slot: number): boolean {
    return this.m_rgPlayer[slot] === null;
  }

  GetEmptySlotCount(): number {
    let n = 0;
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsEmptySlot(i)) n++;
    return n;
  }

  GetNullSlotCount(): number {
    let n = 0;
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsNullSlot(i)) n++;
    return n;
  }

  GetEmptySlot(): number {
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsEmptySlot(i)) return i;
    return -1;
  }

  GetNullSlot(): number {
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsNullSlot(i)) return i;
    return -1;
  }

  /** CBaseSession::GetSlotidx — the user's +490. */
  GetSlotidx(user: CUser | null): number {
    return user ? user.m_nSlotIdx : -1;
  }

  /** CBaseSession::SetSlotidx. */
  SetSlotidx(user: CUser | null, slot: number): void {
    if (user) user.m_nSlotIdx = slot;
  }

  /** CBaseSession::GetColorForNewComer — default slot-colour mapping. */
  GetColorForNewComer(slot: number): number {
    return slot % MAX_SESSION_SLOTS;
  }

  /** Shared implementation of CBaseSession::AddUser(int, CUser *, int, int). */
  protected AddUserBase(slot: number, user: CUser, bomber: number, color: number): void {
    if (this.m_rgPlayer[slot]) {
      // Native reports this invariant violation but still replaces the seat.
      console.error("[GS] m_rgPlayer[slotidx], CBaseSession::AddUser(int slotidx, CUser* pUser), not return");
    }
    this.m_rgPlayer[slot] = user;
    user.SetSessionIdx(this.m_nIdx);
    user.SetSessionSerialNo(this.m_nSerialNo);
    this.SetSlotidx(user, slot);
    user.SetPoolType(2);
    this.SetBomber(slot, bomber);
    this.m_rgSlotState[slot * 3] &= SLOTSTATE_CHIEF_GROUP_CLEAR;
    this.SetColor(slot, color);
  }

  /** CBaseSession::AddUser(int, CUser *, int, int). */
  AddUser(slot: number, user: CUser, bomber: number, color: number): void {
    this.AddUserBase(slot, user, bomber, color);
  }

  /**
   * CBaseSession::AddUser(CClientSocket *, int *, int). TypeScript cannot
   * express the native overload independently of the virtual four-argument
   * AddUser above, so this source-local helper carries that overload body.
   */
  protected AddUserFromSocket(socket: CClientSocket, selects: number[], index: number): void {
    const user = socket.GetUser(index)!;
    const slot = socket.HasAuthority(1) !== 0 ? this.GetNullSlot() : this.GetEmptySlot();
    let bomber = selects[index] ?? 0;
    const bomberAttr = CBomberAttr.ms_pInstance!;
    if (!bomberAttr.IsValidSelectIdx(bomber)) bomber = bomberAttr.GetRandomBomberIdx();

    let color: number;
    if (index <= 0) {
      color = this.GetColorForNewComer(slot);
    } else {
      color = this.GetColor(this.GetSlotidx(socket.GetUser(0)));
    }

    if (CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD) {
      for (let i = 0; i < this.m_nMaxSlot; i++) {
        const seated = this.m_rgPlayer[i];
        if (seated && seated.GetGuildSerialNo() === user.GetGuildSerialNo()) {
          color = this.GetColor(i);
          break;
        }
      }
    }
    this.AddUser(slot, user, bomber, color);
  }

  /** CBaseSession::AddAllUser. */
  AddAllUser(socket: CClientSocket, selects: number[]): void {
    for (let i = 0; i < socket.GetUserCount(); i++) this.AddUserFromSocket(socket, selects, i);
  }

  /** CBaseSession::AddSocket. */
  AddSocket(socket: CClientSocket): void {
    this.m_setSocket.add(socket);
  }

  /** Shared body used by CBaseSession::AddPlayer and its practice thunk. */
  protected AddPlayerBase(socket: CClientSocket, selects: number[]): number {
    const freeSlots = socket.HasAuthority(1) !== 0 ? this.GetNullSlotCount() : this.GetEmptySlotCount();
    if (freeSlots < socket.GetUserCount()) return 0;
    this.AddAllUser(socket, selects);
    this.AddSocket(socket);
    return 1;
  }

  /** CBaseSession::AddPlayer. */
  AddPlayer(socket: CClientSocket, selects: number[]): number {
    return this.AddPlayerBase(socket, selects);
  }

  /** CBaseSession::CheckValidPlayer (vtbl+96). */
  CheckValidPlayer(user: CUser | null): boolean {
    const slot = this.GetSlotidx(user);
    return slot >= 0 && slot < this.m_nMaxSlot && this.m_rgPlayer[slot] === user;
  }

  /** CBaseSession::CheckValidSocket (vtbl+100). */
  CheckValidSocket(socket: CClientSocket): boolean {
    const n = socket.GetUserCount();
    if (n <= 0) return false;
    for (let i = 0; i < n; i++) {
      if (!this.CheckValidPlayer(socket.GetUser(i))) return false;
    }
    return true;
  }

  /** CBaseSession::SendPacket — every socket of the room. */
  SendPacket(packet: CSendPacket): void {
    for (const socket of this.m_setSocket) socket.SendPacket(packet);
  }

  /** CBaseSession::SendPacketExclude. */
  SendPacketExclude(packet: CSendPacket, except: CClientSocket): void {
    for (const socket of this.m_setSocket) {
      if (socket !== except) socket.SendPacket(packet);
    }
  }

  /** CBaseSession::PutPacket — queue for everyone (optionally minus one). */
  PutPacket(packet: CSendPacket, except: CClientSocket | null = null): void {
    for (const socket of this.m_setSocket) {
      if (socket !== except) socket.PutPacketQueued(packet);
    }
  }

  /** CBaseSession::FlushPacket — drain the queues, close dead sockets. */
  FlushPacket(): void {
    for (const socket of [...this.m_setSocket]) {
      if (socket.m_bConnected) socket.FlushQueued();
      else {
        console.error(`[GS] Not connected socket (${socket.GetUser(0)?.GetName() ?? "NULL"}) in game session. Post Close Packet.`);
        socket.PostClosePacket();
      }
    }
  }

  /** CBaseSession::MakeSetSlotStatePacket — 107 [E1 slot][EBuffer 3]. */
  MakeSetSlotStatePacket(slot: number, packet: CSendPacket): void {
    packet.InitPacket(S2C_GamePacket.OnSetSlotState);
    packet.Encode1(slot);
    packet.EncodeBuffer(this.m_rgSlotState.subarray(slot * 3, slot * 3 + 3));
  }

  /** CBaseSession::MakeSlotAccessoryPacket — the tail of packet 105. */
  MakeSlotAccessoryPacket(slot: number, packet: CSendPacket): void {
    const user = this.m_rgPlayer[slot];
    if (!user) return; // native null-user branch writes nothing
    const decorations = Array.from({ length: SLOT_DECORATION_COUNT }, (_, i) => user.GetSlotDecorationLoaded(i));
    const decorationCount = decorations.filter(Boolean).length;
    packet.Encode1(decorationCount);
    if (decorationCount > 0) {
      packet.Encode1(slot);
      decorations.forEach((item, i) => {
        if (item) { packet.Encode1(i); packet.Encode2(item.nAttr1); }
      });
    }
    const charDecos = Array.from({ length: CHAR_DECO_COUNT }, (_, i) => user.GetCharDecoLoaded(i));
    const charDecoCount = charDecos.filter(Boolean).length;
    packet.Encode1(charDecoCount);
    if (charDecoCount > 0) {
      packet.Encode1(slot);
      for (const item of charDecos) {
        if (item) {
          packet.Encode4(item.nAttr1);
          packet.Encode4(item.nAttr2);
          packet.Encode4(item.nAttr3);
        }
      }
    }
    packet.Encode4(user.GetInventoryLoaded(ItemCategory.Bomb)?.nAttr3 ?? 0);
  }

  /** CBaseSession::MakeSetPlayerPacket — 105 [slot][serial][self][community]
   *  [deco?][state 3B][simple info][accessory]. */
  MakeSetPlayerPacket(slot: number, fSelf: number, packet: CSendPacket): void {
    const user = this.m_rgPlayer[slot];
    if (!user) return;
    packet.InitPacket(S2C_GamePacket.OnSetPlayer);
    packet.Encode1(slot);
    packet.Encode4(user.GetGlobalSerialNo());
    packet.Encode1(fSelf);
    packet.Encode1(user.account.CommunitySvr);
    if (fSelf !== 0) {
      const deco = user.GetInventoryLoaded(ItemCategory.EnterEffect);
      packet.Encode1(deco ? deco.nAttr1 & 0xff : 255); // UserInventory+24
    }
    packet.EncodeBuffer(this.m_rgSlotState.subarray(slot * 3, slot * 3 + 3));
    user.AppendSimpleInfoPacket(packet);
    this.MakeSlotAccessoryPacket(slot, packet);
  }

  /** CBaseSession::MakeSessionInfoPacket — 105/107 for every slot. */
  MakeSessionInfoPacket(socket: CClientSocket): void {
    const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
    for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
      if (this.m_rgPlayer[slot]) this.MakeSetPlayerPacket(slot, socket === this.m_rgPlayer[slot]!.m_pSocket ? 1 : 0, packet);
      else this.MakeSetSlotStatePacket(slot, packet);
      socket.PutPacketQueued(packet);
    }
  }

  /** CBaseSession::SendSessionInfoPacket. */
  SendSessionInfoPacket(socket: CClientSocket): void {
    this.MakeSessionInfoPacket(socket);
    socket.FlushQueued();
  }

  /** CBaseSession::SendJoinPacket — announce the new users to prior sockets. */
  SendJoinPacket(socket: CClientSocket): void {
    const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
    const userCount = socket.GetUserCount();
    if (userCount <= 0) {
      this.FlushPacket();
      return;
    }
    for (let i = 0; i < userCount; i++) {
      const user = socket.GetUser(i);
      if (!this.CheckValidPlayer(user)) {
        console.error(`[GS] Wrong session player send session packet(SendJoinPacket). Disconnect user[${user?.GetName() ?? "NULL"}].`);
        socket.PostClosePacket();
        return;
      }
      this.MakeSetPlayerPacket(this.GetSlotidx(user), 1, packet);
      this.PutPacket(packet, socket);
    }
    this.FlushPacket();
  }

  /** CBaseSession::DeleteUser(int) — clear the seat and chief bit. */
  DeleteUser(slot: number): void {
    this.m_rgPlayer[slot] = null;
    this.m_rgSlotState[slot * 3] &= SLOTSTATE_CHIEF_CLEAR;
  }

  /** CBaseSession::DeleteAllUser — virtual DeleteUser for every resident. */
  DeleteAllUser(socket: CClientSocket): void {
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i);
      if (this.CheckValidPlayer(user)) this.DeleteUser(this.GetSlotidx(user));
      else console.error(`[GS] Invalid User try to destory, socket [${user?.GetName() ?? "NULL"}]`);
    }
  }

  /** CBaseSession::SendResetPlayer — 106 for the leaver's users. */
  SendResetPlayer(socket: CClientSocket, fSendReset: number): void {
    const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
    const n = socket.GetUserCount();
    for (let i = 0; i < n; i++) {
      const user = socket.GetUser(i);
      if (user && this.GetSlotidx(user) >= 0) {
        packet.InitPacket(S2C_GamePacket.OnResetPlayer);
        packet.Encode1(this.GetSlotidx(user));
        packet.Encode4(user.GetGlobalSerialNo());
        this.PutPacket(packet);
      }
    }
    if (fSendReset !== 0) socket.SendPacket(packet);
    this.FlushPacket();
  }

  /** CBaseSession::DestroyPlayer — remove users, reset peers, return to lobby. */
  DestroyPlayer(socket: CClientSocket, fSendReset: number): number {
    this.DeleteSocket(socket);
    this.DeleteAllUser(socket);
    this.SendResetPlayer(socket, fSendReset);
    socket.m_nPoolType = 1;
    return 1;
  }

  /** CBaseSession::DeleteAllSlotidx — SetSlotidx(-1) for the socket's users. */
  DeleteAllSlotidx(socket: CClientSocket): void {
    if (!socket) return;
    for (let i = 0; i < socket.GetUserCount(); i++) this.SetSlotidx(socket.GetUser(i), -1);
  }

  /** CBaseSession::DeleteSocket (vtbl+68, FxServer.exe.c:30705) — the set
   *  erase; erasing a socket that never joined reports. */
  DeleteSocket(socket: CClientSocket): void {
    if (!this.m_setSocket.delete(socket)) console.error("[GS] Try to delete Invalid Socket");
  }

  /** CBaseSession::OnSelectColor — 98 → 108 (FxServer.exe.c:30993). */
  OnSelectColor(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const selfIdx = b >> 4;
    const colorIdx = b & 0xf;
    const target = socket.GetUser(selfIdx);
    const slot = this.GetSlotidx(target);
    if (selfIdx < 0 || selfIdx >= socket.GetUserCount()) {
      console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: selfidx is out of range.`);
      socket.PostClosePacket();
      return;
    }
    if (colorIdx >= MAX_SESSION_SLOTS) {
      console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: coloridx is out of range.`);
      socket.PostClosePacket();
      return;
    }
    if (slot >= 0 && slot < this.m_nMaxSlot) {
      this.DoSelectColor(slot, colorIdx);
      const packet = new CSendPacket(S2C_GamePacket.OnSelectColorRes, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(((slot << 4) | (colorIdx & 0xf)) & 0xff);
      this.SendPacket(packet);
      return;
    }
    console.error(`[GS] Invalid slot idx (OnSelectColor). Disconnect [${socket.GetInfoStr()}].`);
    socket.PostClosePacket();
  }

  /** CBaseSession::OnRequestChangeTitle — 107 (FxServer.exe.c:41978A). */
  OnRequestChangeTitle(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.CanRequestChangeTitle(socket)) {
      let title = n.DecodeStr();
      if (title.length > ROOM_TITLE_TRUNCATION_THRESHOLD) {
        title = title.slice(0, ROOM_TITLE_TRUNCATED_LENGTH);
      }
      this.DoChangeTitle(title);
    } else {
      console.error("[GS] !this->CanRequestChangeTitle(pSocket), CBaseSession::CanRequestChangeTitle");
    }
  }

  /** CBaseSession::OnPlayEmotion — 108 → 118 minus the sender. */
  OnPlayEmotion(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const a = n.Decode1();
    const b = n.Decode1();
    const c = n.Decode2();
    const user = this.m_rgPlayer[slot];
    if (user && user.m_pSocket === socket) {
      const packet = new CSendPacket(S2C_GamePacket.OnPlayEmotion, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(slot);
      packet.Encode1(a);
      packet.Encode1(b);
      packet.Encode2(c);
      this.SendPacketExclude(packet, socket);
    } else {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
    }
  }

  /** CBaseSession::OnSelectBomber — 99 → 109. */
  OnSelectBomber(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const selfIdx = b >> 4;
    const bomberIdx = b & 0xf;
    const target = socket.GetUser(selfIdx);
    const slot = this.GetSlotidx(target);
    if (selfIdx < 0 || selfIdx >= socket.GetUserCount()) {
      console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: selfidx is out of range(OnSelectBomber).`);
      socket.PostClosePacket();
      return;
    }
    const attr = CBomberAttr.ms_pInstance!;
    if (bomberIdx < attr.GetNormalCount() || bomberIdx === attr.GetTotalCount()) {
      if (slot >= 0 && slot < this.m_nMaxSlot) {
        const p = slot * 3 + 1;
        this.m_rgSlotState[p] = (this.m_rgSlotState[p]! ^ ((bomberIdx ^ this.m_rgSlotState[p]!) & SLOTSTATE_BOMBER_MASK));
        const packet = new CSendPacket(S2C_GamePacket.OnSelectBomberRes, CipherDegree.kPacketEncryptedCRC8);
        packet.Encode1(((slot << 4) | (bomberIdx & 0xf)) & 0xff);
        this.SendPacket(packet);
        return;
      }
      console.error(`[GS] Invalid slot idx (OnSelectBomber). Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: bomberidx is out of range(OnSelectBomber).`);
    socket.PostClosePacket();
  }
}
