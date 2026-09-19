/**
 * MTUDP — the unreliable UDP transport under the FXGS game stage
 * (FxServer.exe: MTUDPBase/MTUDPServer + CUDPPacketDispatcher).
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

/** CCRC8::GenCRCTable (434140) — the standard CRC-8, polynomial 0x07. */
const crc8_table = new Uint8Array(256);
(function GenCRCTable(): void {
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let round = 0; round < 8; round++) {
      c = c & 0x80 ? ((c << 1) ^ 0x107) & 0xff : (c << 1) & 0xff;
    }
    crc8_table[i] = c;
  }
})();

/** CCRC8::UpdateCRC (4341E0): crc = table[crc ^ byte] per byte. */
export function UpdateCRC8(dwCrcKey: number, p: Uint8Array, nSize: number): number {
  let crc = dwCrcKey & 0xff;
  for (let i = 0; i < nSize; i++) crc = crc8_table[crc ^ p[i]!]!;
  return crc;
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
    if (datagram.length - at < 2) {
      console.error(
        `${szReportPrefix} MTUDPBase::ProcessIncomingData - datagram length is less than len(sizeof(BYTE)) + FCS(sizeof(DWORD))`,
      );
      break;
    }
    const totalLen = datagram[at]!;
    if (totalLen + 1 > datagram.length - at) {
      console.error(`${szReportPrefix} MTUDPBase::ProcessIncomingData - datagram length is less than (total len) + (FCS size)`);
      break;
    }
    if (totalLen === 0) {
      console.error(`${szReportPrefix} MTUDPBase::ProcessIncomingData - datagram total len 0`);
      break;
    }
    if (UpdateCRC8(0, datagram.subarray(at, at + totalLen + 1), totalLen + 1) !== 0) {
      console.error(`${szReportPrefix} MTUDPBase::ProcessIncomingData - crc check failed!, discard remaining.`);
      break;
    }
    frames.push({ payload: datagram.subarray(at + 1, at + totalLen), host });
    at += totalLen + 1;
  }
  return frames;
}

/** Build one MTUDP frame (UnreliableSendTo: len, payload, crc). */
export function BuildFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 2);
  out[0] = payload.length + 1;
  out.set(payload, 1);
  // UnreliableSendTo: crc over [totalLen][payload] (n bytes), written at [n]
  out[payload.length + 1] = UpdateCRC8(0, out, payload.length + 1);
  return out;
}
