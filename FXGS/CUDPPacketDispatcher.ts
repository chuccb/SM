import { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import type { CUser } from "../Common/CUser.ts";
import { IPv4Number } from "../Common/CIPAddress.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import type { HOSTHANDLE } from "../Common/HOSTHANDLE.ts";
import { CipherDegree, GameUDPFormat } from "../Common/OfficialValues.ts";
import { GameUDPRequest } from "../Common/Protocol/PacketTypes.ts";
import type { CGameSessionTable } from "./CGameSessionTable.ts";

/** FXGS 00416619. Only the game's raw UDP discovery payloads, not Relay inputs.
 * Native's stack CReceivedPacketBase has cipher degree ZERO (00439D40).
 * Modern security: the resolver must supply a currently authenticated user on
 * THIS channel; observed UDP IP must equal its live TCP IP. Room generation and
 * complete socket membership are checked again at the table/session boundary.
 * These are bounds/scope checks, NOT a cryptographic proof of UDP ownership. */
export class CUDPPacketDispatcher {
  constructor(
    readonly sessions: CGameSessionTable,
    private readonly FindUserFromGlobalSerialNo: (
      serial: number,
    ) => CUser | undefined,
  ) {}
  OnUDPPacket(bytes: Uint8Array, observed: HOSTHANDLE): boolean {
    if (
      bytes.length !== GameUDPFormat.PeerInfoBytes &&
      bytes.length !== GameUDPFormat.LegacyReadyBytes
    )
      return false;
    const packet = new CReceivedPacketBase(bytes, CipherDegree.None);
    const type = packet.Decode1();
    if (
      (type !== GameUDPRequest.UDPPeerInfo ||
        bytes.length !== GameUDPFormat.PeerInfoBytes) &&
      (type !== GameUDPRequest.ReadyForImmediateStart ||
        bytes.length !== GameUDPFormat.LegacyReadyBytes)
    )
      return false;
    const user = this.FindUserFromGlobalSerialNo(packet.Decode4());
    const roomIndex = packet.Decode2();
    const roomSerial = packet.Decode4();
    const addresses: number[] = [];
    const ports: number[] = [];
    for (let i = 0; i < GameUDPFormat.AdvertisedHostCount; i++) {
      addresses.push(packet.Decode4());
      ports.push(packet.Decode2());
    }
    if (type === GameUDPRequest.ReadyForImmediateStart) {
      packet.Decode4(); // native forwards this word, but callee is a no-op
      packet.DecodeBuffer(packet.remaining); // remaining eight bytes are unused
    }
    packet.AssertEnd();
    if (
      !user ||
      user.IsSetFree() !== 0 ||
      !user.m_pClientSocket?.IsConnected() ||
      !observed.Address ||
      !observed.Port ||
      IPv4Number(user.m_pClientSocket.address) !== observed.Address
    )
      return false;
    if (type === GameUDPRequest.ReadyForImmediateStart) {
      // IMPORTANT: CGameSession's UDP overload at 0041B506 is just `retn 18h`.
      // Do NOT call the DIFFERENT TCP 109 overload at 0041D431, mark ready, or
      // record peer endpoints merely because this payload has a 'ready' name.
      return false;
    }
    try {
      return this.sessions.OnUDPPeerInfo(
        roomIndex,
        roomSerial,
        user,
        observed,
        addresses,
        ports,
      );
    } catch (error) {
      // Reject stale/forged discovery without disconnecting an innocent TCP
      // user; native's index-error disconnect was unsafe on unauthenticated UDP.
      if (error instanceof CProtocolError) return false;
      throw error;
    }
  }
}
