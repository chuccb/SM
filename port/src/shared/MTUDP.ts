/**
 * Port-only shared MTUDP wire primitives used by the native-unit adapters in
 * LS/, FXGS/, and Relay/.  This module is not presented as an original class
 * or source unit; ownership of server, base, and dispatcher methods remains
 * in each executable's MTUDPBase.ts, MTUDPServer.ts, and
 * UDPPacketDispatcher.ts.
 *
 * Wire format (MTUDPBase::ProcessIncomingData 42E122): one datagram is a
 * chain of frames `[u8 totalLen][payload: totalLen-1 bytes][u8 crc8]` where
 * CCRC8::UpdateCRC(0, totalLen byte ‖ payload ‖ crc8) must be 0 — the crc
 * byte is the running CRC-8 (poly 0x07, MSB-first, init 0) of the bytes
 * before it.  A bad CRC discards the rest of the datagram.
 *
 * The only payloads the game server understands are the two "check" packets
 * of the launch handshake (CUDPPacketDispatcher::OnUDPPacket 416619):
 *   type 1  (35 bytes): OnReadyForImmediateStart — [E1 1][E4 globalSerial]
 *     [E2 sessionIdx][E4 sessionSerial][2 × (E4 ip][E2 port)][E4 x]
 *     [E4 mapCRC][bomber][bombCount][bombPower][speed]
 *   type 11 (23 bytes): OnUDPPeerInfo — [E1 11][E4 globalSerial]
 *     [E2 sessionIdx][E4 sessionSerial][2 × (E4 ip][E2 port)]
 * Anything else: "Invalid CheckUDPPacket from the Host %d,%d".
 *
 * MTUDPBase::StartupBase (42E828) binds INADDR_ANY on
 * GetNumAttribute("ServerPort") + 1.
 */
import { UpdateCRC8 as UpdateCoreCRC8 } from "../core/CRC.ts";

const BITS_PER_BYTE = 8;
const BYTE_VALUE_COUNT = 2 ** BITS_PER_BYTE;
const BYTE_MASK = BYTE_VALUE_COUNT - 1;

/** Shared MTUDP frame widths (`[E1 totalLen][payload][E1 CRC8]`). */
export const MTUDP_LENGTH_BYTES = Uint8Array.BYTES_PER_ELEMENT;
export const MTUDP_CRC_BYTES = Uint8Array.BYTES_PER_ELEMENT;
export const MTUDP_FRAME_OVERHEAD = MTUDP_LENGTH_BYTES + MTUDP_CRC_BYTES;
/** Largest value representable by the MTUDP E1 total-length field. */
export const MTUDP_MAX_TOTAL_LENGTH = BYTE_MASK;
/** The total-length field includes the trailing CRC but not itself. */
export const MTUDP_MAX_PAYLOAD_LENGTH = MTUDP_MAX_TOTAL_LENGTH - MTUDP_CRC_BYTES;

/**
 * MTUDPBase::StartupBase's UDP port offset from "ServerPort" — every exe's
 * MTUDP binds ServerPort+1 (CxLogin.exe.c:28168 `htons(NumAttribute + 1)`,
 * FxServer.exe 42E828), so the login server's UDP peer of TCP 3838 is 3839.
 */
export const MTUDP_UDP_PORT_OFFSET = 1;

/** CUDPPacketDispatcher::OnUDPPacket (FxServer.exe.c:26301) — the first body
 *  byte is the frame type: type 1 wraps the OnReadyForImmediateStart check
 *  (35 bytes), type 11 the OnUDPPeerInfo peer info (23 bytes); the rest
 *  report and drop. */
export const MTUDP_TYPE_READY_FOR_IMMEDIATE_START = 1;
export const MTUDP_TYPE_PEER_INFO = 11;

/** CCRC8::UpdateCRC (4341E0), retaining MTUDP's three-argument call shape. */
export function UpdateCRC8(dwCrcKey: number, p: Uint8Array, nSize: number): number {
  return UpdateCoreCRC8(dwCrcKey, p, 0, nSize);
}

export interface HOSTHANDLE {
  ip: number; // u32, network byte order as received
  port: number; // u16
}

/** A parsed MTUDP frame body (the payload between the len and crc bytes). */
export interface UdpFrame {
  payload: Uint8Array;
  host: HOSTHANDLE;
}

/**
 * Split one datagram into validated frame payloads (the Proc/ProcessIncoming
 * pair).  Returns the frames received before the first CRC failure; a bad
 * frame reports and discards the remainder, exactly like the original.
 */
export function SplitDatagram(datagram: Uint8Array, host: HOSTHANDLE, szReportPrefix = "[GS]"): UdpFrame[] {
  const frames: UdpFrame[] = [];
  let at = 0;
  while (at < datagram.length) {
    if (datagram.length - at < MTUDP_FRAME_OVERHEAD) {
      console.error(
        `${szReportPrefix} MTUDPBase::ProcessIncomingData - datagram length is less than len(sizeof(BYTE)) + FCS(sizeof(DWORD))`,
      );
      break;
    }
    const totalLen = datagram[at]!;
    const frameLength = totalLen + MTUDP_LENGTH_BYTES;
    if (frameLength > datagram.length - at) {
      console.error(`${szReportPrefix} MTUDPBase::ProcessIncomingData - datagram length is less than (total len) + (FCS size)`);
      break;
    }
    if (totalLen === 0) {
      console.error(`${szReportPrefix} MTUDPBase::ProcessIncomingData - datagram total len 0`);
      break;
    }
    if (UpdateCRC8(0, datagram.subarray(at, at + frameLength), frameLength) !== 0) {
      console.error(`${szReportPrefix} MTUDPBase::ProcessIncomingData - crc check failed!, discard remaining.`);
      break;
    }
    frames.push({
      payload: datagram.subarray(
        at + MTUDP_LENGTH_BYTES,
        at + frameLength - MTUDP_CRC_BYTES,
      ),
      host,
    });
    at += frameLength;
  }
  return frames;
}

/** Build one MTUDP frame (UnreliableSendTo: len, payload, crc). */
export function BuildFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > MTUDP_MAX_PAYLOAD_LENGTH) {
    throw new RangeError(`MTUDP payload exceeds ${MTUDP_MAX_PAYLOAD_LENGTH} bytes`);
  }
  const out = new Uint8Array(payload.length + MTUDP_FRAME_OVERHEAD);
  out[0] = payload.length + MTUDP_CRC_BYTES;
  out.set(payload, MTUDP_LENGTH_BYTES);
  // UnreliableSendTo: crc over [totalLen][payload] (n bytes), written at [n]
  out[payload.length + MTUDP_LENGTH_BYTES] = UpdateCRC8(0, out, payload.length + MTUDP_LENGTH_BYTES);
  return out;
}
