import { NormalizeID } from "../Common/CIDCompare.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { CUserPool } from "../Common/CUserPool.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import {
  ClientRequest,
  ServerResponse,
} from "../Common/Protocol/PacketTypes.ts";
import {
  OpaqueOfficial,
  UserFieldSize,
  ChatFormat,
} from "../Common/OfficialValues.ts";
import type { CGameSessionTable } from "./CGameSessionTable.ts";

/** Local-channel chat. Privileged/system commands are deliberately not interpreted. */
export class CChatPool extends CUserPool {
  constructor(readonly sessions: CGameSessionTable) {
    super();
  }
  override async OnPacket(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): Promise<void> {
    switch (packet.Decode1()) {
      case ClientRequest.ChatMsg:
        this.OnChatMsg(packet, socket);
        return;
      case ClientRequest.Whisper:
        this.OnWhisper(packet, socket);
        return;
      case ClientRequest.EstimateRTT:
        this.OnEstimateRTT(packet, socket);
        return;
      default:
        throw new CUnsupportedOperation(
          `Game request ${packet.m_nPacketType}`,
          "CChatPool / CChannelPool protocol audit",
        );
    }
  }
  override OnEstimateRTT(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): void {
    const tick = packet.Decode4();
    const hash = packet.Decode4();
    packet.AssertEnd();
    if (!OpaqueOfficial.FxClientRTTIntegrity.includes(hash))
      throw new CProtocolError("Unrecognized client RTT integrity value");
    // Retain the wire hash check, not the original false-positive-prone speedhack heuristic.
    socket.SendPacket(
      new CSendPacket(ServerResponse.EstimateRTT, undefined, socket.text)
        .Encode4(tick)
        .Encode4(Math.floor(performance.now()) >>> 0),
    );
  }
  private FormatChat(socket: CClientSocket, message: string): string {
    const formatted = `${socket.m_aUser.map((u) => u.GetName()).join(", ")} : ${message}`;
    socket.text.AssertSize(formatted, ChatFormat.MaximumFormattedBytes, "chat");
    return formatted;
  }
  OnChatMsg(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireAuthenticated(socket);
    const message = packet.DecodeStr(RuntimePolicy.MaxChatInputBytes);
    packet.AssertEnd();
    if (!message) return;
    if (message.startsWith("/"))
      throw new CUnsupportedOperation(
        "chat slash commands",
        "original privileged command surface is not enabled",
      );
    const out = new CSendPacket(
      ServerResponse.ChatMsg,
      undefined,
      socket.text,
    ).EncodeStr(this.FormatChat(socket, message));
    const room = this.sessions.GetSession(socket);
    if (room) room.SendPacket(out);
    else
      for (const target of this.m_setSocket.values())
        if (target.m_nPoolType === "Lobby") target.SendPacket(out);
  }
  OnWhisper(packet: CReceivedPacketBase, socket: CClientSocket): void {
    this.RequireAuthenticated(socket);
    const id = packet.DecodeStr(UserFieldSize.ID);
    const message = packet.DecodeStr(RuntimePolicy.MaxChatInputBytes);
    packet.AssertEnd();
    const target = [...this.m_setSocket.values()].find(
      (s) =>
        s.IsConnected() &&
        s.m_aUser.some((u) => NormalizeID(u.GetName()) === NormalizeID(id)),
    );
    if (!target)
      socket.SendPacket(
        new CSendPacket(ServerResponse.WhisperFail, undefined, socket.text)
          .Encode1(0)
          .EncodeStr(id),
      );
    else
      target.SendPacket(
        new CSendPacket(
          ServerResponse.Whisper,
          undefined,
          socket.text,
        ).EncodeStr(this.FormatChat(socket, message)),
      );
  }
}
