/** CChatPool and CChannelPool — the lobby: chat routing, the room
 *  broadcasts and the enter-channel flow. */

import { Decode1, Decode2, Decode4, Encode1, Encode2, Encode4 } from "../core/BufferManipulator.ts";
import { CServerConfig } from "../core/Config.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, kPacketEncryptedCRC8 } from "../core/Packet.ts";
import { CDBMan } from "../db/DBMan.ts";
import { GS_ClientSend, GS_ReceivedPacket } from "../lib/PacketIDs.ts";
import { MC_ReceivedPacket } from "../lib/S2S.ts";
import { SESSION_IDX_NONE } from "./Defs";
import { CUserPool } from "./Pools";
import { CUserItemMan } from "./Rows";
import { CGameSessionTable } from "./SessionTable";
import { CCenterProcess, CMainSystem } from "./System";
import { CGuildTable, CLocalUserTable } from "./Tables";
import { CClientSocket, CUser } from "./User";

// ============================ CChatPool ============================

/** CChatPool — the chat handlers (CChannelPool's base). */
export class CChatPool extends CUserPool {
  /** CChatPool::SendAll — fLobbyOnly selects the lobby-stage sockets only. */
  SendAll(packet: CSendPacket, fLobbyOnly: number): void {
    for (const socket of [...this.m_setSocket]) {
      if (!socket.m_bConnected) {
        console.error(`[GS] CChatPool::FlushAll:: Not connected socket. Post Close Packet.`);
        socket.PostClosePacket();
        this.m_setSocket.delete(socket);
        continue;
      }
      if (fLobbyOnly !== 0 && socket.m_nPoolType !== 1) continue;
      socket.SendPacket(packet);
    }
  }

  /** CChatPool::FlushAll (:7644) — the timer passes 0: per-socket
   *  CServerSocket::Flush (vtbl+64).  TS sockets write through on PutPacket,
   *  so the flush is a no-op here; the fLobbyOnly!=0 zombie sweep lives in
   *  SendAll. */
  FlushAll(fLobbyOnly: number): void {
    void fLobbyOnly;
  }

  /** CChatPool::OnPacket — 25/26/27/28/30/31/71/74/216, then the RTT tail. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const id = n.Decode1();
    switch (id) {
      case 25:
        this.OnChatMsg(n, socket);
        break;
      case 26:
        this.OnSpecialCommand(n, socket);
        break;
      case 27:
        this.OnWhisper(n, socket);
        break;
      case 28:
        this.OnItemMsg(n, socket);
        break;
      case 30:
        this.OnSystemMsg(n, socket);
        break;
      case 31:
        this.OnAdminNotifyMsg(n, socket);
        break;
      case 71:
        this.OnSystemCmd(n, socket);
        break;
      case 74:
        this.OnShoutMsg(n, socket);
        break;
      case 216:
        this.OnKickoffUser(n, socket);
        break;
      default:
        break;
    }
    n.m_uOffset = 0;
    super.OnPacket(n, socket);
  }

  /** CChatPool::OnChatMsg — packet 25 [EStr msg]; '/' = a special command. */
  OnChatMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    if (msg.startsWith("/")) {
      this.OnSpecialCommand(n, socket);
      return;
    }
    if (msg.length === 0) {
      const p = new CSendPacket(GS_ClientSend.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8);
      p.EncodeStr(" ");
      socket.SendPacket(p);
      return;
    }
    const senders = socket.m_apUser.filter((u): u is CUser => u !== null).map((u) => u.GetName());
    if (senders.join(", ").length + msg.length + 3 > 0x400) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const text = `${senders.join(", ")} : ${msg}`;
    const p = new CSendPacket(GS_ClientSend.OnChatMsg, CipherDegree.kPacketEncryptedCRC8);
    if (socket.GetUser(0)!.GetSessionIdx() === 0xffff) p.EncodeStr("//");
    p.EncodeStr(text);
    const idx = socket.GetUser(0)!.GetSessionIdx();
    if (idx === 0xffff) this.SendAll(p, 1);
    else CGameSessionTable.ms_pInstance!.SendPacket(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnSpecialCommand — a stub in the original (`retn 8`). */
  OnSpecialCommand(_n: CReceivedPacket, _socket: CClientSocket): void {}

  /** CChatPool::OnWhisper — packet 27/28 [EStr to][EStr msg]. */
  OnWhisper(n: CReceivedPacket, socket: CClientSocket): void {
    const to = n.DecodeStr();
    const msg = n.DecodeStr();
    const target = CLocalUserTable.ms_pInstance!.FindUserFromId(to);
    if (!target) {
      const p = new CSendPacket(GS_ClientSend.OnWhisperFail, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(0);
      p.EncodeStr(to);
      socket.SendPacket(p);
      return;
    }
    const senders = socket.m_apUser.filter((u): u is CUser => u !== null).map((u) => u.GetName());
    if (senders.join(", ").length + msg.length + 2 > 0x400) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const p = new CSendPacket(GS_ClientSend.OnWhisperRes, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(`${senders.join(", ")} : ${msg}`);
    target.m_pSocket?.SendPacket(p);
  }

  /** CChatPool::OnItemMsg — packet 28 [E1 bomber][EStr msg] (in-session). */
  OnItemMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const bomber = n.Decode1();
    const msg = n.DecodeStr();
    const user = socket.GetUser(bomber);
    if (bomber >= socket.GetUserCount() || !user) {
      console.error("[GS] Invalid item msg: from invalid bomber");
      return;
    }
    if (msg.length + user.GetName().length + 10 > 0x400) {
      console.error("[GS] Too long item msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const p = new CSendPacket(GS_ClientSend.OnItemMsg, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(`${user.GetName()} : ${msg}`);
    const idx = socket.GetUser(0)!.GetSessionIdx();
    if (idx === 0xffff) {
      console.error("[GS] Invalid item msg: tried to send to all in the session");
      return;
    }
    CGameSessionTable.ms_pInstance!.SendPacket(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnSystemMsg — packet 30 to the session or the lobby. */
  OnSystemMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(GS_ClientSend.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(msg);
    const idx = socket.GetUser(0)?.GetSessionIdx() ?? SESSION_IDX_NONE;
    if (idx === 0xffff) this.SendAll(p, 1);
    else CGameSessionTable.ms_pInstance!.SendPacket(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnAdminNotifyMsg — packet 31 from an operator client. */
  OnAdminNotifyMsg(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() === 1 && (socket.GetUser(0)!.GetSessionIdx() === 0xffff)) {
      this.SendAdminMsg(n.DecodeStr());
    }
  }

  /** CChatPool::OnSystemCmd — packet 71 from an operator client. */
  OnSystemCmd(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() === 1 && (socket.GetUser(0)!.GetSessionIdx() === 0xffff)) {
      this.SendSystemCmd(n.DecodeStr());
    }
  }

  /** CChatPool::SendAdminMsg — to the center (MC 4). */
  SendAdminMsg(msg: string): void {
    const p = new CSendPacket(MC_ReceivedPacket.OnAdminNotifyMsg);
    p.EncodeStr(msg);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CChatPool::SendSystemCmd — to the center (MC 11). */
  SendSystemCmd(msg: string): void {
    const p = new CSendPacket(MC_ReceivedPacket.OnSystemCmd);
    p.EncodeStr(msg);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CChatPool::OnShoutMsg — packet 74; costs an Item/ItemSpeaker. */
  OnShoutMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode1();
    let msg = n.DecodeStr();
    if (Buffer.byteLength(msg, "latin1") > 64) msg = msg.slice(0, 64);
    if (idx < 0 || idx >= socket.GetUserCount()) {
      console.error("[GS] KIN shout e sir~ self idx jal mot doit er yo!");
      return;
    }
    const user = socket.GetUser(idx)!;
    if (msg.length + user.GetName().length + 10 > 0x400) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const speaker = user.GetUserInventoryFromAll("Item/ItemSpeaker");
    if (!speaker) {
      console.error("[GS] Tried to use nonresident Item..Disconnect user");
      socket.PostClosePacket();
      return;
    }
    speaker.Amount--;
    speaker.fModified = 1;
    if (speaker.Amount < 0) {
      speaker.Amount = 0;
      console.error("[GS] Tried to use nonresident Item..Disconnect user");
      socket.PostClosePacket();
      return;
    }
    const p = new CSendPacket(GS_ClientSend.OnShoutMsg, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(`${user.GetName()} : ${msg}`);
    this.SendAll(p, 0);
  }

  /** CChatPool::OnKickoffUser — packet 216; authority-gated (always fails). */
  OnKickoffUser(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() !== 1) return;
    n.DecodeStr(); // the target name
    if (CClientSocket.HasAuthority(7) === 0) return;
    // unreachable without the operator link
  }
}

// ============================ CChannelPool ============================

/** CChannelPool — the lobby (CChannelPool::OnPacket, FxServer.exe.c:6942). */
export class CChannelPool extends CChatPool {
  static ms_pInstance: CChannelPool | null = null;

  m_vtRankList: CUser[] = []; // +76 (the level-sorted lobby list)
  m_vtGuildMember = new Map<number, CUser[]>(); // +120

  /** CChannelPool::UpdateRankList (:6643) — after a level-up, re-sort the
   *  level-sorted lobby list (level desc, serial asc) inside the pool's
   *  critical section; the original sends nothing from here. */
  UpdateRankList(user: CUser): void {
    const idx = this.m_vtRankList.indexOf(user);
    if (idx === -1) return;
    this.m_vtRankList.splice(idx, 1);
    let at = this.m_vtRankList.length;
    for (let i = 0; i < this.m_vtRankList.length; i++) {
      const u = this.m_vtRankList[i]!;
      if (user.m_nLevel > u.m_nLevel || (user.m_nLevel === u.m_nLevel && user.GetGlobalSerialNo() < u.GetGlobalSerialNo())) {
        at = i;
        break;
      }
    }
    this.m_vtRankList.splice(at, 0, user);
  }

  constructor(public db: CDBMan) {
    super();
    CChannelPool.ms_pInstance = this;
    CMainSystem.ms_pInstance!.m_nPremiumSvrReward = db.GetPremiumSvrReward();
    CMainSystem.ms_pInstance!.m_nPremiumSvrLuckPro = db.GetPremiumSvrLuckPro();
  }

  /** CChannelPool::OnPacket — the lobby dispatch. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const id = n.Decode1();
    switch (id) {
      case GS_ReceivedPacket.OnReqConnectToSvr:
        this.OnReqConnectToSvr(n, socket);
        return;
      case GS_ReceivedPacket.OnReqChannelsState:
        this.OnReqChannelsState(socket);
        return;
      case GS_ReceivedPacket.OnEnterChannelStage:
        this.OnEnterChannelStage(socket);
        return;
      case GS_ReceivedPacket.OnInviteUser:
        this.OnInviteUser(n, socket);
        return;
      case GS_ReceivedPacket.OnGuildMarkRevision:
        this.OnGuildMarkRevision(n);
        return;
      case GS_ReceivedPacket.OnEstimateRTT:
        n.m_uOffset = 0;
        super.OnPacket(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestUserSimpleInfo:
        this.OnRequestUserSimpleInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestMyInfo:
        this.OnRequestMyInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestModifyUserInfo:
        this.OnRequestModifyUserInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestUserInfoDetail:
        this.OnRequestUserInfoDetail(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestSessionInfoDetail:
        this.OnRequestSessionInfoDetail(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestUserLocation:
        this.OnRequestUserLocation(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestGuildInfo:
        this.OnRequestGuildInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnCreateSession:
        CGameSessionTable.ms_pInstance!.CreateSession(n, socket);
        return;
      case GS_ReceivedPacket.OnEnterSession:
        CGameSessionTable.ms_pInstance!.JoinSession(n, socket);
        return;
      case GS_ReceivedPacket.OnJoinFreeSession:
        CGameSessionTable.ms_pInstance!.JoinFreeSession(n, socket);
        return;
      case GS_ReceivedPacket.OnEnterLobbyStage:
        this.OnEnterLobbyStage(socket);
        return;
      case GS_ReceivedPacket.OnRequestGuildMemberInfo:
        this.OnRequestGuildMemberInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestCreatePracticeSession:
        // vtbl+60 = CreateSessionPractice — the practice rooms live in the
        // table's second half (+1320), invisible to the lobby lists
        CGameSessionTable.ms_pInstance!.CreateSessionPractice(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestUserInventory:
        this.OnRequestUserItemList(socket);
        return;
      case GS_ReceivedPacket.Chat:
        n.m_uOffset = 0;
        super.OnPacket(n, socket);
        return;
      default:
        if (id > 95 && id < 190) {
          n.m_uOffset = 0;
          CGameSessionTable.ms_pInstance!.OnPacket(n, socket);
          return;
        }
        n.m_uOffset = 0;
        super.OnPacket(n, socket);
        return;
    }
  }

  /** CChannelPool::OnAddNewSocket — packet 15 + the rank/guild lists. */
  OnAddNewSocket(socket: CClientSocket): void {
    const p = new CSendPacket(GS_ClientSend.OnChannelAnnounce, CipherDegree.kPacketEncryptedCRC8);
    socket.SendPacket(p);
    this.InsertRankList(socket);
    this.PutUserSimpleInfoPacket(socket, 0);
    this.InsertGuildMember(socket);
    this.PutGuildMemberListPacket(socket, 0);
  }

  /** CChannelPool::OnDeleteSocket */
  OnDeleteSocket(socket: CClientSocket): void {
    this.DeleteRankList(socket);
    this.DeleteGuildMember(socket);
  }

  /** CChannelPool::InsertRankList — level desc, gSN asc tiebreak. */
  InsertRankList(socket: CClientSocket): void {
    for (const user of socket.m_apUser) {
      if (!user) continue;
      let at = this.m_vtRankList.length;
      for (let i = 0; i < this.m_vtRankList.length; i++) {
        const other = this.m_vtRankList[i]!;
        if (user.m_nLevel > other.m_nLevel || (user.m_nLevel === other.m_nLevel && user.GetGlobalSerialNo() < other.GetGlobalSerialNo())) {
          at = i;
          break;
        }
      }
      this.m_vtRankList.splice(at, 0, user);
    }
  }

  /** CChannelPool::DeleteRankList */
  DeleteRankList(socket: CClientSocket): void {
    for (const user of socket.m_apUser) {
      if (!user) continue;
      const i = this.m_vtRankList.indexOf(user);
      if (i >= 0) this.m_vtRankList.splice(i, 1);
    }
  }

  /** CChannelPool::InsertGuildMember */
  InsertGuildMember(socket: CClientSocket): void {
    for (const user of socket.m_apUser) {
      if (!user || user.m_nGuildSN === 0) continue;
      const list = this.m_vtGuildMember.get(user.m_nGuildSN) ?? [];
      list.push(user);
      this.m_vtGuildMember.set(user.m_nGuildSN, list);
    }
  }

  /** CChannelPool::DeleteGuildMember */
  DeleteGuildMember(socket: CClientSocket): void {
    for (const user of socket.m_apUser) {
      if (!user || user.m_nGuildSN === 0) continue;
      const list = this.m_vtGuildMember.get(user.m_nGuildSN);
      if (!list) continue;
      const i = list.indexOf(user);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) CGuildTable.ms_pInstance?.Remove(user.m_nGuildSN);
    }
  }

  /** CChannelPool::PutUserSimpleInfoPacket — packet 70 (9 per page). */
  PutUserSimpleInfoPacket(socket: CClientSocket, n: number): void {
    const packet = new CSendPacket(GS_ClientSend.OnRequestUserSimpleInfoRes, CipherDegree.kPacketEncryptedCRC8);
    const total = this.m_vtRankList.length;
    const pages = total <= 0 ? 0 : Math.floor((total - 1) / 9) + 1;
    let page = n < 0 ? 0 : n;
    if (page > pages - 1) page = pages - 1;
    if (page < 0) page = 0;
    packet.Encode2(page);
    const from = 9 * page;
    const to = Math.min(from + 9, total);
    packet.Encode1(to - from);
    for (let i = from; i < to; i++) this.m_vtRankList[i]!.AppendSimpleInfoPacket(packet);
    socket.SendPacket(packet);
  }

  /** CChannelPool::PutGuildMemberListPacket — packet 67 for a guild page. */
  PutGuildMemberListPacket(socket: CClientSocket, n: number): void {
    const user = socket.GetUser(0);
    if (!user || user.m_nGuildSN === 0) return;
    const list = this.m_vtGuildMember.get(user.m_nGuildSN) ?? [];
    const packet = new CSendPacket(GS_ClientSend.OnGuildMemberListRes, CipherDegree.kPacketEncryptedCRC8);
    const pages = list.length <= 0 ? 0 : Math.floor((list.length - 1) / 9) + 1;
    let page = n < 0 ? 0 : n;
    if (page > pages - 1) page = pages - 1;
    if (page < 0) page = 0;
    packet.Encode2(page);
    const from = 9 * page;
    const to = Math.min(from + 9, list.length);
    packet.Encode1(to - from);
    for (let i = from; i < to; i++) list[i]!.AppendSimpleInfoPacket(packet);
    socket.SendPacket(packet);
  }

  /** the MakeChannelsStatePacket/MakeChannelsGameStatePacket carrier pair */
  private SendChannelsState(socket: CClientSocket): void {
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    CCenterProcess.ms_pInstance!.MakeChannelsStatePacket(packet);
    socket.SendPacket(packet);
    CCenterProcess.ms_pInstance!.MakeChannelsGameStatePacket(packet);
    socket.SendPacket(packet);
  }

  /**
   * CChannelPool::OnRequestSessionInfoDetail (FxServer.exe.c:4854) — lobby
   * packet 68: decode [E2 idx][E4 serial] and hand them to the session
   * table's vtbl+88 (the per-room detail request; reachable from the lobby).
   */
  OnRequestSessionInfoDetail(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode2();
    const serial = n.Decode4();
    CGameSessionTable.ms_pInstance!.OnRequestSessionInfoDetail(idx, serial, socket);
  }

  /** CChannelPool::OnEnterLobbyStage — packet 83; back to the lobby. */
  OnEnterLobbyStage(socket: CClientSocket): void {
    CGameSessionTable.ms_pInstance!.DestroyPlayer(socket, 0);
    socket.m_nPoolType = 1;
    const p = new CSendPacket(GS_ClientSend.OnChannelAnnounce, CipherDegree.kPacketEncryptedCRC8);
    socket.SendPacket(p);
    CGameSessionTable.ms_pInstance!.PutAllSessionInfo(socket);
  }

  /** CChannelPool::OnEnterChannelStage — packet 16. */
  OnEnterChannelStage(socket: CClientSocket): void {
    if (socket.m_nPoolType === 3) {
      console.error(
        `[GS] Front-stage user want to enter channel stage. Disconnect. CurrentPoolType=${socket.m_nPoolType} [${socket.GetUser(0)?.GetName() ?? "NULL"}]`,
      );
      socket.PostClosePacket();
      return;
    }
    if (socket.m_nPoolType !== 1) CGameSessionTable.ms_pInstance!.DestroyPlayer(socket, 0);
    socket.m_nPoolType = 3;
    this.SendChannelsState(socket);
  }

  /** CChannelPool::OnReqChannelsState — packet 15 (channel stage only). */
  OnReqChannelsState(socket: CClientSocket): void {
    if (socket.m_nPoolType !== 3) return;
    this.SendChannelsState(socket);
  }

  /**
   * CChannelPool::OnReqConnectToSvr — packet 6:
   * [E1 type][E4 target][E2 version]; ok → center p2, else client 6 with the
   * CCenterProcess::CheckEnterGame code.
   */
  OnReqConnectToSvr(n: CReceivedPacket, socket: CClientSocket): void {
    const type = n.Decode1();
    if (type !== 11 && socket.m_nPoolType !== 3) {
      console.error("[GS] Non-front user try to connect server. Disconnect");
      socket.PostClosePacket();
      return;
    }
    const target = n.Decode4();
    if (type !== 11) {
      const version = n.Decode2();
      const r = CCenterProcess.ms_pInstance!.CheckEnterGame(type, target, version);
      if (r !== 1) {
        const p = new CSendPacket(GS_ClientSend.OnReqConnectToSvrFail, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(r);
        socket.SendPacket(p);
        return;
      }
    }
    // ok → center p2 [E1 n][n×E4 serial][E1 type][E4 target]
    const p = new CSendPacket(MC_ReceivedPacket.OnReqConnectToSvr);
    p.Encode1(socket.GetUserCount());
    for (const u of socket.m_apUser) p.Encode4(u!.GetGlobalSerialNo());
    p.Encode1(type);
    p.Encode4(target);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CChannelPool::OnCenterResConnectToSvr — CM 1 → client 6. */
  OnCenterResConnectToSvr(n: CReceivedPacket): void {
    const count = n.Decode1();
    let user: CUser | null = null;
    for (let i = 0; i < count; i++) {
      user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(n.Decode4());
      if (!user) break;
    }
    const result = n.Decode1();
    const p = new CSendPacket(GS_ClientSend.OnReqConnectToSvrRes, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(result);
    if (result === 1) {
      p.Encode1(n.Decode1()); // the target server class
      p.Encode4(n.Decode4()); // the target server idx
      p.Encode4(n.Decode4()); // ip
      p.Encode2(n.Decode2()); // port
    }
    user?.m_pSocket?.SendPacket(p);
  }

  /** CChannelPool::OnRequestUserSimpleInfo — packet 64. */
  OnRequestUserSimpleInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const page = n.Decode2();
    this.PutUserSimpleInfoPacket(socket, page);
  }

  /** CChannelPool::OnRequestMyInfo — packet 65. */
  OnRequestMyInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode1();
    if (idx >= socket.GetUserCount()) return;
    const user = socket.GetUser(idx)!;
    const packet = new CSendPacket(GS_ClientSend.OnRequestMyInfoRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(idx);
    packet.EncodeStr(user.account.strName);
    packet.Encode1(user.account.Gender);
    packet.EncodeStr(user.account.Address);
    packet.EncodeStr(user.account.Profile);
    packet.EncodeStr(user.account.Birthday);
    packet.Encode1(user.account.Reveal);
    socket.SendPacket(packet);
  }

  /**
   * CChannelPool::OnRequestModifyUserInfo — packet 66 (FxServer.exe.c:5856).
   * Wire: [E1 slot][EStr name][E1 gender][EStr address][EStr profile]
   *       [EStr birthday][E1 reveal]
   * → CDBMan::ModifyUserInfo (prUpdateUserAccount @ID/@Name/@Gender/@Address/
   *   @Reveal/@Profile/@Birthday, FxServer.exe.c:11993) and reply
   *   65 [E1 result] — 1 when the stored proc ran, 0 on failure.
   */
  OnRequestModifyUserInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const user = socket.GetUser(slot);
    if (!user) return;
    const strName = n.DecodeStr();
    const gender = n.Decode1();
    const address = n.DecodeStr();
    const profile = n.DecodeStr();
    const birthday = n.DecodeStr();
    const reveal = n.Decode1();
    const result =
      this.db.prUpdateUserAccount(
        user.account.strID,
        strName,
        gender,
        address,
        reveal,
        profile,
        birthday,
      ) === 0
        ? 1
        : 0;
    if (result === 1) {
      // CDBMan::ModifyUserInfo success path: mirror onto the live account
      user.account.strName = strName;
      user.account.Gender = gender;
      user.account.Address = address;
      user.account.Profile = profile;
      user.account.Birthday = birthday;
      user.account.Reveal = reveal;
    }
    const packet = new CSendPacket(GS_ClientSend.OnRequestModifyUserInfoRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(result);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnRequestUserInfoDetail — packet 67. */
  OnRequestUserInfoDetail(n: CReceivedPacket, socket: CClientSocket): void {
    const name = n.DecodeStr();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromId(name);
    if (!user) {
      // ask the center (MC 7 [E1 0|1][E4 asker][EStr name])
      const p = new CSendPacket(MC_ReceivedPacket.OnSvrReservedMsg);
      p.Encode1(0);
      p.Encode4(socket.GetUser(0)!.GetGlobalSerialNo());
      p.EncodeStr(name);
      CCenterProcess.ms_pInstance?.SendPacket(p);
      return;
    }
    this.SendUserDetailInfo(socket, user);
  }

  /** CChannelPool::SendUserDetailInfo — the local-user 71 body. */
  SendUserDetailInfo(socket: CClientSocket, user: CUser): void {
    const packet = new CSendPacket(GS_ClientSend.OnRequestUserInfoDetailRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(1);
    packet.EncodeStr(user.GetName());
    packet.EncodeStr(user.account.strName);
    const guild = CGuildTable.ms_pInstance!.FindGuildFromSerialNo(user.m_nGuildSN);
    packet.EncodeStr(guild ? guild.strName : "");
    packet.Encode1(user.account.Gender);
    packet.Encode4(user.dyn.win);
    packet.Encode4(user.dyn.draw);
    packet.Encode4(user.dyn.lose);
    packet.Encode4(user.dyn.exp);
    packet.Encode4(0x7fffffff); // GetMaxExpInLevel (the top level)
    packet.Encode2(user.m_nLevel);
    packet.Encode4(user.dyn.money);
    packet.Encode1(10);
    packet.Encode4(CServerConfig.ms_pInstance!.GetNumAttribute("ServerIndex"));
    packet.Encode2(user.GetSessionIdx() & 0xffff);
    packet.Encode1(user.account.Reveal);
    if (user.account.Reveal !== 0) {
      packet.EncodeStr(user.account.Address);
      packet.EncodeStr(user.account.Tel);
      packet.EncodeStr(user.account.Profile);
      packet.EncodeStr(user.account.Birthday);
    }
    packet.Encode4(user.m_nPremiumSvrIdx);
    packet.Encode1(user.account.CommunitySvr);
    // SendGameSlotInfo (the 9 decoration slots)
    let slots = 0;
    for (let i = 0; i < 9; i++) if (user.GetSlotDecorationLoaded(i)) slots++;
    packet.Encode2(slots);
    for (let i = 0; i < 9; i++) {
      const deco = user.GetSlotDecorationLoaded(i);
      if (deco) {
        packet.Encode1(i);
        packet.Encode2(deco.ItemSN);
      }
    }
    packet.Encode2(0);
    user.MakeInventoryPacket(packet, 3);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnRequestUserLocation — packet 69. */
  OnRequestUserLocation(n: CReceivedPacket, socket: CClientSocket): void {
    const name = n.DecodeStr();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromId(name);
    if (!user) {
      const p = new CSendPacket(MC_ReceivedPacket.OnSvrReservedMsg);
      p.Encode1(1);
      p.Encode4(socket.GetUser(0)!.GetGlobalSerialNo());
      p.EncodeStr(name);
      CCenterProcess.ms_pInstance?.SendPacket(p);
      return;
    }
    const packet = new CSendPacket(GS_ClientSend.OnRequestUserLocationRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(1);
    packet.EncodeStr(user.GetName());
    packet.Encode1(10);
    packet.Encode4(CServerConfig.ms_pInstance!.GetNumAttribute("ServerIndex"));
    packet.Encode2(user.GetSessionIdx() & 0xffff);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnRequestGuildInfo — packet 70 request → 66. */
  OnRequestGuildInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const sn = n.Decode4();
    const guild = CGuildTable.ms_pInstance!.FindGuildFromSerialNo(sn);
    if (!guild) return;
    const packet = new CSendPacket(GS_ClientSend.OnRequestGuildInfoRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode4(guild.m_nGuildSN);
    packet.EncodeStr(guild.strName);
    packet.Encode2(guild.m_nMarkRevision);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnGuildMarkRevision — packet 38. */
  OnGuildMarkRevision(n: CReceivedPacket): void {
    const sn = n.Decode4();
    const rev = n.Decode2();
    const guild = CGuildTable.ms_pInstance!.FindGuildFromSerialNo(sn);
    if (guild && guild.m_nMarkRevision < rev) guild.m_nMarkRevision = rev;
  }

  /** CChannelPool::OnInviteUser — packet 28. */
  OnInviteUser(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode2();
    const serial = n.Decode4();
    const name = n.DecodeStr();
    const target = CLocalUserTable.ms_pInstance!.FindUserFromId(name);
    if (!target) return;
    const packet = new CSendPacket(GS_ClientSend.OnInviteUser, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(idx);
    packet.Encode4(serial);
    packet.EncodeStr(socket.GetUser(0)!.GetName());
    packet.EncodeStr(""); // CopySessionPasswd — no password echo
    target.m_pSocket?.SendPacket(packet);
  }

  /** CChannelPool::OnRequestGuildMemberInfo — packet 85. */
  OnRequestGuildMemberInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const page = n.Decode2();
    this.PutGuildMemberListPacket(socket, page);
  }

  /** CChannelPool::OnRequestUserItemList — packet 209. */
  OnRequestUserItemList(socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnUserItemList, CipherDegree.kPacketEncryptedCRC8);
    CUserItemMan.ms_pInstance!.PutUserItemList(packet);
    socket.SendPacket(packet);
  }
}
