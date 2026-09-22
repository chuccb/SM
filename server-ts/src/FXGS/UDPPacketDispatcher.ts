/** Native source unit: FX/FxServer/UDPPacketDispatcher.cpp. */
import { CReceivedPacket } from "../core/Packet.ts";
import {
  type HOSTHANDLE,
  MTUDP_TYPE_PEER_INFO,
  MTUDP_TYPE_READY_FOR_IMMEDIATE_START,
} from "../common/MTUDP.ts";
import { CGameSessionTable } from "./GameSessionTable.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";

export class CUDPPacketDispatcher {
  static ms_pInstance: CUDPPacketDispatcher | null = null;

  constructor() {
    CUDPPacketDispatcher.ms_pInstance = this;
  }

  /** CUDPPacketDispatcher::OnUDPPacket (00416619). */
  OnUDPPacket(payload: Uint8Array, host: HOSTHANDLE): void {
    const type = payload[0];
    if (type === MTUDP_TYPE_READY_FOR_IMMEDIATE_START) {
      if (payload.length !== 35) {
        console.error(`[GS] Invalid CheckUDPPacket from the Host ${host.ip},${host.port}`);
        return;
      }
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(view.getUint32(1, false));
      if (!user) return;
      const sessionIndex = view.getUint16(5, false);
      const serial = view.getUint32(7, false);
      const body = new CReceivedPacket();
      body.SetRcvPacket(payload.subarray(27), payload.length - 27);
      CGameSessionTable.ms_pInstance!.OnReadyForImmediateStart(sessionIndex, serial, user, body);
      return;
    }
    if (type === MTUDP_TYPE_PEER_INFO) {
      if (payload.length !== 23) {
        console.error(`[GS] Invalid CheckUDPPacket from the Host ${host.ip},${host.port}`);
        return;
      }
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(view.getUint32(1, false));
      if (!user) return;
      const sessionIndex = view.getUint16(5, false);
      const serial = view.getUint32(7, false);
      const hosts = [view.getUint32(11, false), view.getUint32(17, false)];
      const ports = [view.getUint16(15, false), view.getUint16(21, false)];
      CGameSessionTable.ms_pInstance!.OnUDPPeerInfo(sessionIndex, serial, user, host, hosts, ports);
      return;
    }
    console.error(`[GS] Invalid CheckUDPPacket from the Host ${host.ip},${host.port}`);
  }

  /** The Bun port dispatches synchronously, so termination only drops ownership. */
  Terminate(): void {
    if (CUDPPacketDispatcher.ms_pInstance === this) {
      CUDPPacketDispatcher.ms_pInstance = null;
    }
  }
}
