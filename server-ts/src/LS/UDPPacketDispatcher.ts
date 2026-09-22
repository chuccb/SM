/** Native source unit: CX/CxLogin/UDPPacketDispatcher.cpp. */
import type { HOSTHANDLE } from "../common/MTUDP.ts";
import type { CUser } from "./User.ts";
import type { MTUDPServer } from "./MTUDPServer.ts";

export const LOGIN_MTUDP_CHECK_UDP_COMM_REQUEST = 0;
export const LOGIN_MTUDP_CHECK_UDP_COMM_RESPONSE = 2;
export const LOGIN_MTUDP_CHECK_UDP_COMM_REQUEST_BYTES = 5;
const UDP_DRAIN_BUFFER_SIZE = 0x1000;

/** CUDPPacketDispatcher (CxLogin.exe.c:22580) — the drain thread. */
export class CUDPPacketDispatcher {
  static ms_pInstance: CUDPPacketDispatcher | null = null;

  constructor(private readonly pServer: MTUDPServer) {
    CUDPPacketDispatcher.ms_pInstance = this;
  }

  /** CUDPPacketDispatcher::Proc (22655) — drain every queued record. */
  Proc(): void {
    const pServer = this.pServer;
    const pBuf = new Uint8Array(UDP_DRAIN_BUFFER_SIZE);
    let got = pServer.GetUnreliableData(pBuf, UDP_DRAIN_BUFFER_SIZE);
    while (got !== null) {
      this.OnUDPPacket(pBuf.subarray(0, got.nLen), got.handle);
      got = pServer.GetUnreliableData(pBuf, UDP_DRAIN_BUFFER_SIZE);
    }
  }

  /** CUDPPacketDispatcher::OnUDPPacket (22617) — the login server's only
   *  UDP payload: the type-0 'check udp comm' handshake. */
  OnUDPPacket(datagram: Uint8Array, host: HOSTHANDLE): void {
    if (datagram[0] !== LOGIN_MTUDP_CHECK_UDP_COMM_REQUEST) return;
    const pServer = this.pServer;
    if (datagram.length !== LOGIN_MTUDP_CHECK_UDP_COMM_REQUEST_BYTES) {
      pServer.HostDestroy(host.ip, host.port);
      return;
    }
    const serial = ((datagram[1]! << 24) | (datagram[2]! << 16) | (datagram[3]! << 8) | datagram[4]!) >>> 0; // Decode4 (BE)
    const user = FindUserFromGlobalSerialNo(serial);
    if (user === null) {
      pServer.HostDestroy(host.ip, host.port);
      return;
    }
    if (user.GetGlobalSerialNo() === 0) {
      console.error(`Unauthenticated user try to send 'check udp comm' packet(${user.GetName()})`);
      user.socket.Close(); // the user's CSocket, vtbl+72(0)
      pServer.HostDestroy(host.ip, host.port);
      return;
    }
    const response = Uint8Array.of(LOGIN_MTUDP_CHECK_UDP_COMM_RESPONSE);
    pServer.UnreliableSendTo(response, response.length, host.ip, host.port);
    pServer.HostDestroy(host.ip, host.port);
  }

  /** The Bun port dispatches synchronously, so termination only drops ownership. */
  Terminate(): void {
    if (CUDPPacketDispatcher.ms_pInstance === this) {
      CUDPPacketDispatcher.ms_pInstance = null;
    }
  }
}

/** CLocalUserTable::FindUserFromGlobalSerialNo — resolved through the login
 *  pool's table (the original reaches TSingleton<CLocalUserTable>).  Wired
 *  by LoginServerApp.ts at startup to keep the import cycle one-way. */
export let FindUserFromGlobalSerialNo: (sn: number) => CUser | null = () => null;
export function SetLocalUserTableFinder(fn: (sn: number) => CUser | null): void {
  FindUserFromGlobalSerialNo = fn;
}
