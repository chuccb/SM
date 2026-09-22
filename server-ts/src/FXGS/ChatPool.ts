/** Native source unit: FX/FxServer/ChatPool.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { C2S_GameChatPacket, S2C_GamePacket } from "../core/protocol/PacketIDs.ts";
import { MC_GameServerSendPacket } from "../core/protocol/CenterProtocol.ts";
import {
  CHAT_MAX_PACKET_LEN,
  SESSION_IDX_NONE,
  AUTHORITY_SHOUT,
} from "./Defs.ts";
import { CUserPool } from "./UserPool.ts";
import { CGameSessionTable } from "./GameSessionTable.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";

const CHAT_MESSAGE_MAX_BYTES = 64;

/** CChatPool — the chat handlers (CChannelPool's base). */
export class CChatPool extends CUserPool {
  /** CChatPool::SendAll (FxServer.exe.c:7495) — fLobbyOnly selects the
   *  lobby-stage (poolType 1) sockets only.  No cleanup here: the official
   *  PutPackets blind, and a zombie dies through PutPacket's own case-1
   *  report.  (CChatPool::FlushAll's zombie sweep is the same story — the
   *  binary only ever calls it with 0, so its a2!=0 branch is dead code.) */
  SendAll(packet: CSendPacket, fLobbyOnly: number): void {
    for (const socket of this.m_setSocket) {
      if (fLobbyOnly !== 0 && socket.m_nPoolType !== 1) continue;
      socket.SendPacket(packet);
    }
  }

  /** CChatPool::FlushAll (:7644) — the timer passes 0: per-socket
   *  CServerSocket::Flush (vtbl+64).  TS sockets write through on PutPacket,
   *  so the flush is a no-op here; the fLobbyOnly!=0 zombie sweep lives in
   *  SendAll.  Native only ever calls it with 0, so the a2!=0 branch is dead. */
  FlushAll(_fLobbyOnly: number): void {}

  /** CChatPool::OnPacket — dispatch the same top-level opcode after the
   * derived CChannelPool rewinds it, then rewind again for CUserPool's tail. */
  override OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const id = n.Decode1();
    switch (id) {
      case C2S_GameChatPacket.OnChatMsg:
        this.OnChatMsg(n, socket);
        break;
      case C2S_GameChatPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n, socket);
        break;
      case C2S_GameChatPacket.OnWhisper:
        this.OnWhisper(n, socket);
        break;
      case C2S_GameChatPacket.OnItemMsg:
        this.OnItemMsg(n, socket);
        break;
      case C2S_GameChatPacket.OnKickoffUser:
        this.OnKickoffUser(n, socket);
        break;
      case C2S_GameChatPacket.OnSystemMsg:
        this.OnSystemMsg(n, socket);
        break;
      case C2S_GameChatPacket.OnShoutMsg:
        this.OnShoutMsg(n, socket);
        break;
      case C2S_GameChatPacket.OnSystemCmd:
        this.OnSystemCmd(n, socket);
        break;
    }
    n.m_uOffset = 0;
    super.OnPacket(n, socket);
  }

  /** CChatPool::OnChatMsg — packet 25 [EStr msg]; '/' = a special command. */
  OnChatMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    if (msg.startsWith("/")) {
      this.OnSpecialCommand(msg, socket);
      return;
    }
    if (msg.length === 0) {
      const p = new CSendPacket(S2C_GamePacket.OnSystemMsg);
      p.EncodeStr(" ");
      socket.SendPacket(p);
      return;
    }
    const senders = socket.m_apUser.filter((u): u is CUser => u !== null).map((u) => u.GetName());
    if (senders.join(", ").length + msg.length + 3 > CHAT_MAX_PACKET_LEN) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const text = `${senders.join(", ")} : ${msg}`;
    const p = new CSendPacket(S2C_GamePacket.OnChatMsg);
    if (socket.GetUser(0)!.GetSessionIdx() === SESSION_IDX_NONE) p.EncodeStr("//");
    p.EncodeStr(text);
    const idx = socket.GetUser(0)!.GetSessionIdx();
    if (idx === SESSION_IDX_NONE) this.SendAll(p, 1);
    else CGameSessionTable.ms_pInstance!.SendPacket(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnSpecialCommand — a stub in the original (`retn 8`). */
  OnSpecialCommand(_command: string, _socket: CClientSocket): void {}

  /** CChatPool::OnWhisper — packet 27 [EStr to][EStr msg]. */
  OnWhisper(n: CReceivedPacket, socket: CClientSocket): void {
    const to = n.DecodeStr();
    const msg = n.DecodeStr();
    const target = CLocalUserTable.ms_pInstance!.FindUserFromId(to);
    if (!target) {
      const p = new CSendPacket(S2C_GamePacket.OnWhisperFail);
      p.Encode1(0);
      p.EncodeStr(to);
      socket.SendPacket(p);
      return;
    }
    const senders = socket.m_apUser.filter((u): u is CUser => u !== null).map((u) => u.GetName());
    if (senders.join(", ").length + msg.length + 2 > CHAT_MAX_PACKET_LEN) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const p = new CSendPacket(S2C_GamePacket.OnWhisperRes);
    p.EncodeStr(`${senders.join(", ")} : ${msg}`);
    target.m_pSocket?.SendPacket(p);
  }

  /** CChatPool::OnItemMsg — packet 29 [E1 bomber][EStr msg] (in-session). */
  OnItemMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const bomber = n.Decode1();
    const msg = n.DecodeStr();
    const user = socket.GetUser(bomber);
    if (bomber >= socket.GetUserCount() || !user) {
      console.error("[GS] Invalid item msg: from invalid bomber");
      return;
    }
    if (msg.length + user.GetName().length + 10 > CHAT_MAX_PACKET_LEN) {
      console.error("[GS] Too long item msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const p = new CSendPacket(S2C_GamePacket.OnItemMsg);
    p.EncodeStr(`${user.GetName()} : ${msg}`);
    const idx = socket.GetUser(0)!.GetSessionIdx();
    if (idx === SESSION_IDX_NONE) {
      console.error("[GS] Invalid item msg: tried to send to all in the session");
      return;
    }
    CGameSessionTable.ms_pInstance!.SendPacket(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnSystemMsg — packet 31 to the session or the lobby. */
  OnSystemMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(S2C_GamePacket.OnSystemMsg);
    p.EncodeStr(msg);
    const idx = socket.GetUser(0)?.GetSessionIdx() ?? SESSION_IDX_NONE;
    if (idx === SESSION_IDX_NONE) this.SendAll(p, 1);
    else CGameSessionTable.ms_pInstance!.SendPacket(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnAdminNotifyMsg — packet 26 from an operator client. */
  OnAdminNotifyMsg(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() === 1 && (socket.GetUser(0)!.GetSessionIdx() === SESSION_IDX_NONE)) {
      this.SendAdminMsg(n.DecodeStr());
    }
  }

  /** CChatPool::OnSystemCmd — packet 216 from an operator client. */
  OnSystemCmd(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() === 1 && (socket.GetUser(0)!.GetSessionIdx() === SESSION_IDX_NONE)) {
      this.SendSystemCmd(n.DecodeStr());
    }
  }

  /** CChatPool::SendAdminMsg — to the center (MC 4). */
  SendAdminMsg(msg: string): void {
    const p = new CSendPacket(MC_GameServerSendPacket.OnAdminNotifyMsg, CipherDegree.kPacketRaw);
    p.EncodeStr(msg);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CChatPool::SendSystemCmd — to the center (MC 11). */
  SendSystemCmd(msg: string): void {
    const p = new CSendPacket(MC_GameServerSendPacket.OnSystemCmd, CipherDegree.kPacketRaw);
    p.EncodeStr(msg);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CChatPool::OnShoutMsg — packet 71; costs an Item/ItemSpeaker. */
  OnShoutMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode1();
    let msg = n.DecodeStr();
    if (Buffer.byteLength(msg, "latin1") > CHAT_MESSAGE_MAX_BYTES) {
      msg = msg.slice(0, CHAT_MESSAGE_MAX_BYTES);
    }
    if (idx < 0 || idx >= socket.GetUserCount()) {
      console.error("[GS] KIN shout e sir~ self idx jal mot doit er yo!");
      return;
    }
    const user = socket.GetUser(idx)!;
    if (msg.length + user.GetName().length + 10 > CHAT_MAX_PACKET_LEN) {
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
    const p = new CSendPacket(S2C_GamePacket.OnShoutMsg);
    p.EncodeStr(`${user.GetName()} : ${msg}`);
    this.SendAll(p, 0);
  }

  /** CChatPool::OnKickoffUser — packet 30; authority-gated (always fails). */
  OnKickoffUser(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() !== 1) return;
    n.DecodeStr(); // the target name
    if (socket.HasAuthority(AUTHORITY_SHOUT) === 0) return;
    // unreachable without the operator link
  }
}
