/** Native source unit: FX/FxServer/BaseSessionTable.cpp. */
import type { CClientSocket } from "./ClientSocket.ts";
import type { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import type { CUser } from "./User.ts";
import type { HOSTHANDLE } from "../common/MTUDP.ts";

/** Native polymorphic base for the game/practice session table. */
export class CBaseSessionTable {
  /** The FXGS implementation is the original ReportError stub. */
  MoveToExchangeSession(_socket: CClientSocket, _target: number): void {
    console.error("[GS] CBaseSessionTable::MoveToExchangeSession(CClientSocket* pSocket1, CClientSocket* pSocket2)");
  }

  SendPacketIntoSession(_socket: CClientSocket, _packet: CSendPacket): void {}

  OnUDPPeerInfo(
    _idx: number,
    _serial: number,
    _user: CUser,
    _host: HOSTHANDLE,
    _hosts: number[],
    _ports: number[],
  ): void {}

  OnRequestExchange(_packet: CReceivedPacket, _socket: CClientSocket): void {}
  InviteUser(_packet: CReceivedPacket, _socket: CClientSocket): void {}
}
