import { CCRC8 } from "../Common/CCRC.ts";
import { MTUDPFormat } from "../Common/OfficialValues.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";

/** Relay MTUDPServer::ProcessIncomingData @ 00402B30. Raw BE DWORDs, no TCP
 * scalar XOR, substitution tables, encryption, or JSON. L excludes the CRC byte.
 * Bounds checks fix the original unchecked L-9 unsigned underflow. */
export const RelayFormat = {
  HeaderBytes: 9,
  MaxLength: MTUDPFormat.MaxFrameLength,
  MaxDatagram: MTUDPFormat.MaxDatagramBytes,
  HostTimeoutMs: 60_000,
} as const;
export interface RelayFrame {
  source: number;
  destination: number;
  payload: Buffer;
}
export function DecodeRelayDatagram(bytes: Uint8Array): RelayFrame[] {
  const data = Buffer.from(bytes);
  const out: RelayFrame[] = [];
  if (!data.length || data.length > RelayFormat.MaxDatagram)
    throw new CProtocolError("Invalid relay datagram size");
  let offset = 0;
  let source: number | undefined;
  while (offset < data.length) {
    const length = data[offset]!;
    if (length < RelayFormat.HeaderBytes || offset + length + 1 > data.length)
      throw new CProtocolError("Invalid relay frame length");
    const frame = data.subarray(offset, offset + length + 1);
    if (CCRC8.UpdateCRC(0, frame) !== 0)
      throw new CProtocolError("Invalid relay CRC", "crc-mismatch");
    const sn = frame.readUInt32BE(1);
    if (!sn || (source !== undefined && source !== sn))
      throw new CProtocolError("Mixed relay sources");
    source = sn;
    out.push({
      source: sn,
      destination: frame.readUInt32BE(5),
      payload: Buffer.from(frame.subarray(RelayFormat.HeaderBytes, length)),
    });
    offset += length + 1;
  }
  return out;
}
/** Shared with FXGS; Relay INPUT still has its distinct nine-byte header. */
export { EncodeUnregisteredDatagram } from "../Common/MTUDPProtocol.ts";
