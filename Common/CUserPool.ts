import type { CClientSocket } from "./CClientSocket.ts";
import type { CReceivedPacketBase } from "./CReceivedPacketBase.ts";
import { CSendPacket } from "./CSendPacket.ts";
import { ClientRequest, ServerResponse } from "./Protocol/PacketTypes.ts";
import { CProtocolError } from "./CProtocolError.ts";

export class CUserPool {
  protected readonly m_setSocket = new Set<CClientSocket>();
  AddNewSocket(socket: CClientSocket): void {
    this.m_setSocket.add(socket);
  }
  DeleteSocket(socket: CClientSocket): void {
    this.m_setSocket.delete(socket);
  }
  OnEstimateRTT(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const time = packet.Decode4();
    packet.AssertEnd();
    socket.SendPacket(
      new CSendPacket(ServerResponse.EstimateRTT, undefined, socket.text)
        .Encode4(time)
        .Encode4(Math.floor(performance.now()) >>> 0),
    );
  }
  RequireAuthenticated(socket: CClientSocket): void {
    if (!socket.GetUserCount())
      throw new CProtocolError("Unauthenticated packet", "not-authenticated");
  }
  async OnPacket(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): Promise<void> {
    if (packet.Decode1() === ClientRequest.EstimateRTT)
      this.OnEstimateRTT(packet, socket);
    else throw new CProtocolError("Unimplemented opcode", "unsupported-packet");
  }
}
