/** Native source unit: FX/FxServer/ListSession.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree, PACKET_TYPE_PLACEHOLDER } from "../core/Packet.ts";
import { S2C_GamePacket } from "../core/protocol/PacketIDs.ts";
import { FunctionalItem } from "../common/Item.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import {
  MAP_IDX_RANDOM,
  MAX_SESSION_SLOTS,
  SLOTSTATE_CHIEF,
  SLOTSTATE_CHIEF_CLEAR,
  SLOTSTATE_GROUP_CLEAR,
  SUPREME_ROOM_SWAP_COUNT,
} from "./Defs.ts";
import { CBaseSession } from "./BaseSession.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";
import { MoveToExchangeSession } from "./runtime/SessionTableRuntime.ts";

/** CListSession — lobby-visible room state layered over CBaseSession. */
export class CListSession extends CBaseSession {
  m_rgVoteMatrix = new Int32Array(MAX_SESSION_SLOTS * MAX_SESSION_SLOTS);
  m_nChiefSwapCount = 0;
  m_rgVote = new Int32Array(MAX_SESSION_SLOTS);
  m_nBanSerial = 0;
  m_nCurPlayerNum = 0;
  m_nMaxPlayerNum = MAX_SESSION_SLOTS;
  m_szPassword = "";
  m_nLevelLimit = 0;
  m_nGameType = 0;
  m_fHasPassword = 0;
  m_nMapIdx = MAP_IDX_RANDOM;
  m_fPlaying = 0;
  m_fModified = 0;
  m_dwCreateTime = 0;
  m_nChiefSlotidx = -2;
  m_fSupreme = 0;

  override Init(title: string | null, password: string | null = null, gameType?: number): void {
    super.Init(title, password, gameType);
    this.m_szPassword = password ?? "";
    this.m_fHasPassword = this.m_szPassword.length > 0 ? 1 : 0;
    this.m_nMapIdx = MAP_IDX_RANDOM;
    this.m_nCurPlayerNum = 0;
    this.m_nMaxPlayerNum = this.m_nMaxSlot;
    this.m_fPlaying = 0;
    this.m_fModified = 0;
    this.m_dwCreateTime = timeGetTime();
    if (gameType !== undefined) this.m_nGameType = gameType;
  }

  /** CListSession::GetChiefLevel. */
  GetChiefLevel(): number {
    const chief = this.m_nChiefSlotidx;
    return chief >= 0 ? (this.m_rgPlayer[chief]?.m_nLevel ?? 0) : 0;
  }

  /** CListSession::DoChangeTitle — native CBaseSession body plus modified bit. */
  /** CListSession::DestroyPlayer — native forwarding override. */
  override DestroyPlayer(socket: CClientSocket, fSendReset: number): number {
    return super.DestroyPlayer(socket, fSendReset);
  }

  /** CListSession::DoSelectColor — selections are locked while playing. */
  override DoSelectColor(slot: number, color: number): void {
    if (this.m_fPlaying === 0) super.DoSelectColor(slot, color);
  }

  /** CListSession::AddUser — base seat state plus list counters. */
  override AddUser(slot: number, user: CUser, bomber: number, color: number): void {
    super.AddUser(slot, user, bomber, color);
    this.SetCurPlayer(this.m_nCurPlayerNum + 1);
  }

  /** CListSession::DeleteUser — base seat removal plus lobby counters. */
  override DeleteUser(slot: number): void {
    super.DeleteUser(slot);
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      this.m_rgVoteMatrix[slot * MAX_SESSION_SLOTS + i] = 0;
      this.m_rgVoteMatrix[i * MAX_SESSION_SLOTS + slot] = 0;
    }
    this.m_rgVote[slot] = 0;
    this.SetCurPlayer(this.m_nCurPlayerNum - 1);
  }

  /** CListSession::AddPlayer — reject active rooms and update the chief. */
  override AddPlayer(socket: CClientSocket, selects: number[]): number {
    if (this.m_fPlaying !== 0 || super.AddPlayer(socket, selects) === 0) return 0;
    if (socket.HasAuthority(24) !== 0) this.SetNewChief(this.GetSlotidx(socket.GetUser(0)));
    return 1;
  }

  override DoChangeTitle(title: string): void {
    super.DoChangeTitle(title);
    this.m_fModified |= 0x10;
  }

  override OnSelectBomber(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying !== 0) return;
    super.OnSelectBomber(n, socket);
  }

  /** Port-only call adapter; native ownership stays in CBaseSessionTable. */
  private MoveSocketToExchange(socket: CClientSocket): void {
    MoveToExchangeSession(socket, 0);
  }

  hasPassword(): boolean {
    return this.m_fHasPassword !== 0;
  }

  /** CListSession::IsChief — the socket owns the chief user. */
  IsChief(socket: CClientSocket): boolean {
    if (!socket) return false;
    const slot = this.m_nChiefSlotidx;
    if (slot < 0 || slot >= this.m_nMaxSlot) return false;
    const user = this.m_rgPlayer[slot];
    return user !== null && user.m_pSocket === socket;
  }

  /** CListSession::GetFirstSupremeChief — the first RoomTicket holder. */
  GetFirstSupremeChief(): number {
    if (this.m_nMaxSlot <= 0) return -2;
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      const user = this.m_rgPlayer[i];
      if (user && user.HasFunctionalItem(FunctionalItem.RoomTicket)) return i;
    }
    return -2;
  }

  /** CListSession::GetNextChiefSlot. */
  GetNextChiefSlot(): number {
    if (this.m_nChiefSwapCount >= SUPREME_ROOM_SWAP_COUNT) return this.GetFirstSupremeChief();
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      if (this.m_rgPlayer[i]) return i;
    }
    return -2;
  }

  /** CListSession::SetChiefSlotidx — byte0 0x02 marks the chief. */
  SetChiefSlotidx(next: number): void {
    this.m_fSupreme = next === -2 ? 1 : 0;
    const old = this.m_nChiefSlotidx;
    if (old >= 0 && old < this.m_nMaxSlot) this.m_rgSlotState[old * 3] &= SLOTSTATE_CHIEF_CLEAR;
    this.m_nChiefSlotidx = next;
    if (next >= 0 && next < this.m_nMaxSlot) {
      this.m_rgSlotState[next * 3] |= SLOTSTATE_CHIEF;
      const user = this.m_rgPlayer[next];
      if (user) {
        const socket = user.m_pSocket;
        if (socket) {
          if (this.m_fPlaying === 0) {
            for (const u of socket.m_apUser) {
              if (!u) continue;
              const slot = this.GetSlotidx(u);
              if (slot >= 0 && slot < this.m_nMaxSlot) this.m_rgSlotState[slot * 3] &= SLOTSTATE_GROUP_CLEAR; // clear ready
            }
          }
        } else {
          console.error("[GS] !pSocket, CListSession::SetChiefSlotidx");
        }
      } else {
        console.error("[GS] !pUser, CListSession::SetChiefSlotidx");
      }
    }
  }

  /** CListSession::SetNewChief — move the crown and queue the 107s. */
  SetNewChief(next: number): void {
    const old = this.m_nChiefSlotidx;
    let nextSlot = next;
    if (nextSlot < 0) nextSlot = this.GetNextChiefSlot();
    this.SetChiefSlotidx(nextSlot);
    if (this.m_nChiefSlotidx >= 0 && this.m_nMaxSlot > 0) {
      for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
        const user = this.m_rgPlayer[slot];
        if (user && slot !== this.m_nChiefSlotidx && this.IsChief(user.m_pSocket!)) {
          const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
          this.MakeSetSlotStatePacket(slot, packet);
          this.PutPacket(packet);
        }
      }
    }
    if (old >= 0) {
      const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
      this.MakeSetSlotStatePacket(old, packet);
      this.PutPacket(packet);
    }
    if (this.m_nChiefSlotidx >= 0) {
      const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
      this.MakeSetSlotStatePacket(this.m_nChiefSlotidx, packet);
      this.PutPacket(packet);
    }
  }

  /** CListSession::InitBangPok — decide the first chief. */
  InitBangPok(socket: CClientSocket): void {
    let chief = 0;
    this.m_fSupreme = 0;
    if (this.m_nChiefSwapCount < SUPREME_ROOM_SWAP_COUNT) {
      const maxLevelUser = socket.GetMaxLevelUser();
      let slot = 0;
      for (; slot < this.m_nMaxSlot && this.m_rgPlayer[slot] !== maxLevelUser; slot++);
      if (slot === this.m_nMaxSlot) {
        slot = 0;
        for (; slot < this.m_nMaxSlot; slot++) {
          const user = this.m_rgPlayer[slot];
          if (user && user.m_pSocket === socket) break;
        }
      }
      this.SetChiefSlotidx(slot);
    } else {
      for (; chief < this.m_nMaxSlot; chief++) {
        const user = this.m_rgPlayer[chief];
        if (user && user.HasFunctionalItem(FunctionalItem.RoomTicket)) break;
      }
      if (chief >= this.m_nMaxSlot) {
        this.m_nChiefSlotidx = -2;
        console.log("[GS] Spurious LadderSession Creation");
        return;
      }
      this.SetChiefSlotidx(chief);
    }
    this.m_nBanSerial = 0;
  }

  /** CListSession::DoBangPok — 122 to everyone, then out to the lobby. */
  DoBangPok(): void {
    for (const socket of [...this.m_setSocket]) {
      const p = new CSendPacket(S2C_GamePacket.OnBangPok, CipherDegree.kPacketEncryptedCRC8);
      socket.SendPacket(p);
      socket.m_nPoolType = 4; // CClientSocket+468 = 4 (MoveToExchangeSession)
      MoveToExchangeSession(socket, 0);
    }
  }

  /** CListSession::CanRequestChangeTitle (vtbl+108). */
  override CanRequestChangeTitle(socket: CClientSocket): boolean {
    if (this.IsChief(socket)) return true;
    console.error("[GS] !this->IsChief(pSocket), CListSession::CanRequestChangeTitle");
    return false;
  }

  /** CListSession::DoOpenCloseSlot (vtbl+124) — 110 + the open-slot count. */
  DoOpenCloseSlot(slot: number, close: number): void {
    if (slot < 0 || slot >= this.m_nMaxSlot) return;
    if (this.m_rgPlayer[slot]) close = 0;
    const packet = new CSendPacket(S2C_GamePacket.OnOpenCloseSlotRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(((slot << 4) | (close & 0xf)) & 0xff);
    this.SendPacket(packet);
    const p = slot * 3;
    const state = this.m_rgSlotState[p]!;
    const changing = (state & 1) === 0 !== (close === 0);
    this.m_rgSlotState[p] = state ^ ((close ^ state) & 1);
    if (changing) {
      let open = 0;
      for (let i = 0; i < this.m_nMaxSlot; i++) {
        if ((this.m_rgSlotState[i * 3]! & 1) === 0) open++;
      }
      if (open !== this.m_nMaxPlayerNum) {
        this.m_fModified |= 8;
        this.m_nMaxPlayerNum = open;
      }
    }
  }

  /** CListSession::SetPlaying. */
  SetPlaying(playing: number): void {
    this.m_fModified |= 1;
    this.m_fPlaying = playing;
  }

  /** CListSession::SetCurPlayer. */
  SetCurPlayer(cur: number): void {
    this.m_fModified |= 4;
    this.m_nCurPlayerNum = cur;
  }

  /** CListSession::MakeModifiedPacket — 86, or 0 when nothing changed. */
  /** CListSession::MakeSimpleInfoPacket — lobby packet 83. */
  MakeSimpleInfoPacket(packet: CSendPacket): void {
    packet.InitPacket(S2C_GamePacket.OnSessionSimpleInfo);
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.EncodeStr(this.m_strName);
    packet.Encode1(this.m_fHasPassword);
    packet.Encode1(this.m_nGameType);
    packet.Encode1(this.m_fPlaying);
    packet.Encode2(this.m_nMapIdx & 0xffff);
    packet.Encode1(this.m_nCurPlayerNum);
    packet.Encode1(this.m_nMaxPlayerNum);
  }

  /** CListSession::MakeCreatedPacket — lobby packet 85. */
  MakeCreatedPacket(packet: CSendPacket): void {
    packet.InitPacket(S2C_GamePacket.OnSessionCreated);
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.EncodeStr(this.m_strName);
    packet.Encode1(this.m_fHasPassword);
    packet.Encode1(this.m_nGameType);
    packet.Encode1(this.m_nCurPlayerNum);
    packet.Encode1(this.m_nMaxPlayerNum);
  }

  MakeModifiedPacket(packet: CSendPacket): number {
    if (this.m_fModified === 0) return 0;
    packet.InitPacket(S2C_GamePacket.OnSessionModified);
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.Encode1(this.m_fModified);
    if ((this.m_fModified & 1) !== 0) packet.Encode1(this.m_fPlaying);
    if ((this.m_fModified & 2) !== 0) packet.Encode2(this.m_nMapIdx & 0xffff);
    if ((this.m_fModified & 4) !== 0) packet.Encode1(this.m_nCurPlayerNum);
    if ((this.m_fModified & 8) !== 0) packet.Encode1(this.m_nMaxPlayerNum);
    if ((this.m_fModified & 0x10) !== 0) packet.EncodeStr(this.m_strName);
    this.m_fModified = 0; // CListSession::MakeModifiedPacket clears before returning
    return 1;
  }

  /** CListSession::MakeDestroyedPacket — 87 [E2 idx][E4 serial]. */
  MakeDestroyedPacket(packet: CSendPacket): void {
    packet.InitPacket(S2C_GamePacket.OnSessionDestroyed);
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
  }

  /** CListSession::OnOpenCloseSlot — 100 (chief only, FxServer.exe.c:40725). */
  OnOpenCloseSlot(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying !== 0) return;
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot < 0 || chiefSlot >= this.m_nMaxSlot) {
      console.error(`[GS] No Chief player exists.(Supreme Room) (SetSlotState). Disconnect [${socket.GetInfoStr()}].`);
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (!chiefUser) {
      console.error(`[GS] Chief player doesn't exists(SetSlotState). Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    if (chiefUser.m_pSocket !== socket) {
      console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: non-chief tried to open or close slot.`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const slot = b >> 4;
    const close = (b & 0xf) !== 0 ? 1 : 0;
    if (slot >= 0 && slot < this.m_nMaxSlot) {
      this.DoOpenCloseSlot(slot, close);
      return;
    }
    console.error(`[GS] Invalid slot idx (OnOpenCloseSlot). Disconnect [${socket.GetInfoStr()}].`);
    socket.PostClosePacket();
  }

  /** CListSession::OnHostAskBanPlayer (FxServer.exe.c:41110). */
  OnHostAskBanPlayer(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot < 0 || chiefSlot >= this.m_nMaxSlot) {
      console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: Non-chief player ask ban player (there is no chief player exists)`);
      socket.PostClosePacket();
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot]!;
    if (!chiefUser || chiefUser.m_pSocket !== socket) {
      console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: Non-chief player ask ban player`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_nBanSerial !== 0) {
      const p = new CSendPacket(S2C_GamePacket.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(1);
      socket.SendPacket(p);
      return;
    }
    const serial = n.Decode4();
    const superFlag = n.Decode1();
    let slot = this.GetSlotidxFromSerialNo(serial);
    if (socket.GetSelfidxFromSerialNo(serial) !== -1) {
      console.error(`[GS] Hacking suspected [${socket.GetInfoStr()}]: Chief player ask ban himself`);
      socket.PostClosePacket();
      return;
    }
    // the target's users record 0, everyone else 1 (asked)
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      const u = this.m_rgPlayer[i];
      if (u && u.GetGlobalSerialNo() === serial) {
        this.m_rgVote[i] = 0;
        slot = i;
      } else {
        this.m_rgVote[i] = 1;
      }
    }
    if (slot === -1) {
      this.m_nBanSerial = 0;
      return;
    }
    const targetUser = this.m_rgPlayer[slot]!;
    if (superFlag !== 0 || socket.HasAuthority(21) !== 0) {
      // a super chief (Item/SuperChief) or an operator kicks outright
      let hasSuper = false;
      for (const u of socket.m_apUser) {
        if (u && u.HasFunctionalItem(FunctionalItem.SuperChief)) {
          hasSuper = true;
          break;
        }
      }
      if (hasSuper || socket.HasAuthority(21) !== 0) {
        this.m_nBanSerial = 0;
        const targetSocket = targetUser.m_pSocket!;
        this.MoveSocketToExchange(targetSocket);
        const p = new CSendPacket(S2C_GamePacket.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(4);
        this.SendPacket(p);
        return;
      }
    }
    // Item/BanReflex bounces the ban onto the chief
    let reflex = false;
    for (const u of targetUser.m_pSocket?.m_apUser ?? []) {
      if (u && u.HasFunctionalItem(FunctionalItem.BanReflex)) {
        reflex = true;
        break;
      }
    }
    if (reflex) {
      this.m_nBanSerial = 0;
      const chief = this.m_rgPlayer[this.m_nChiefSlotidx]!;
      const chiefSocket = chief.m_pSocket!;
      this.MoveSocketToExchange(chiefSocket);
      const p = new CSendPacket(S2C_GamePacket.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(5);
      p.EncodeStr(chief.GetName());
      this.SendPacket(p);
      return;
    }
    // start the vote: the chief is a yes, the ask goes to the rest
    for (const u of targetUser.m_pSocket?.m_apUser ?? []) {
      const s = this.GetSlotidx(u);
      if (s >= 0) this.m_rgVote[s] = 0;
    }
    this.m_nBanSerial = serial;
    for (const u of socket.m_apUser) {
      const s = this.GetSlotidx(u);
      if (s >= 0) this.m_rgVote[s] = 2;
    }
    this.DeferBanPlayer();
    if (this.m_nBanSerial !== 0) {
      const ask = new CSendPacket(S2C_GamePacket.OnBanVoteRequest, CipherDegree.kPacketEncryptedCRC8);
      ask.Encode4(serial);
      ask.EncodeStr(targetUser.GetName());
      const chiefSocket = chiefUser.m_pSocket!;
      const targetSocket = targetUser.m_pSocket!;
      const sent = new Set<CClientSocket>();
      for (const u of this.m_rgPlayer) {
        if (!u || u === chiefUser) continue;
        if (u.GetGlobalSerialNo() === serial) continue;
        const member = u.m_pSocket;
        if (!member || member === targetSocket || member === chiefSocket) continue;
        if (sent.has(member)) continue;
        sent.add(member);
        member.SendPacket(ask);
      }
      const res = new CSendPacket(S2C_GamePacket.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      res.Encode1(0);
      socket.SendPacket(res);
    }
  }

  /** CListSession::GetSlotidxFromSerialNo. */
  GetSlotidxFromSerialNo(serial: number): number {
    return this.m_rgPlayer.findIndex((u) => u && u.GetGlobalSerialNo() === serial);
  }

  /** CListSession::OnRespondToBanPlayer — 105 (FxServer.exe.c:40232+). */
  OnRespondToBanPlayer(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_nBanSerial === 0 || this.m_nBanSerial !== (n.Decode4() >>> 0)) return;
    const yes = n.Decode1();
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const slot = this.GetSlotidx(socket.GetUser(i));
      if (this.m_rgVote[slot] !== 1) break;
      this.m_rgVote[slot] = yes !== 0 ? 2 : 3;
    }
    this.DeferBanPlayer();
  }

  /** CListSession::DeferBanPlayer (vtbl+144) — count and apply the votes. */
  DeferBanPlayer(): void {
    let targetSlot = -1;
    let total = 0;
    let yes = 0;
    let no = 0;
    for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user) continue;
      if (user.GetGlobalSerialNo() === this.m_nBanSerial) targetSlot = slot;
      const vote = this.m_rgVote[slot]!;
      if (vote !== 0) {
        total++;
        if (vote === 2) yes++;
        else if (vote === 3) no++;
      }
    }
    if (targetSlot === -1) {
      this.m_nBanSerial = 0;
      const p = new CSendPacket(S2C_GamePacket.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(4);
      this.SendPacket(p);
      return;
    }
    if (2 * yes > total) {
      // banned by majority
      this.m_nBanSerial = 0;
      const target = this.m_rgPlayer[targetSlot]!;
      const targetSocket = target.m_pSocket!;
      this.MoveSocketToExchange(targetSocket);
      targetSocket.m_nPoolType = 4;
      const p = new CSendPacket(S2C_GamePacket.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(2);
      p.EncodeStr(target.GetName());
      this.SendPacket(p);
      return;
    }
    if (2 * no >= total || yes + no >= total) {
      this.m_nBanSerial = 0;
      const target = this.m_rgPlayer[targetSlot]!;
      const p = new CSendPacket(S2C_GamePacket.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(3);
      p.EncodeStr(target.GetName());
      this.SendPacket(p);
    }
  }

  /** CListSession::OnTeamChat — 111 → 27 to the same color (424251E0). */
  OnTeamChat(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
      return;
    }
    if (socket.GetUserCount() !== 1) {
      console.error(`[GS] 2 Player requested Team Chat, NOT ALLOWED![${socket.GetInfoStr()}]`);
      return;
    }
    if (msg.length + user0.GetName().length + 10 > 0x400) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const text = `${user0.GetName()} : ${msg}`;
    const packet = new CSendPacket(S2C_GamePacket.OnWhisperRes, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(text);
    const slot = this.GetSlotidx(user0);
    const color = this.GetColor(slot);
    for (let s = 0; s < MAX_SESSION_SLOTS; s++) {
      const other = this.m_rgPlayer[s];
      if (other && s !== slot && this.GetColor(s) === color) {
        other.m_pSocket?.SendPacket(packet);
      }
    }
  }
}
