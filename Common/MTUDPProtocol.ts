import { CCRC8 } from "./CCRC.ts";
import { CProtocolError } from "./CProtocolError.ts";
import { MTUDPFormat } from "./OfficialValues.ts";

/** FXGS MTUDPBase::ProcessIncomingData 0042E122, cHost::ProcessIncomingUnreliable
 * 00427AB3: [one-byte length | raw payload | CRC8]. Length includes itself but
 * not the CRC. No TCP scalar XOR, serial header, encryption or registration ack.
 * Unlike Relay's INPUT format there are no source/destination DWORDs here.
 * Modern hardening: validate the WHOLE datagram before exposing any payload. */
export function DecodeUnreliableDatagram(bytes: Uint8Array): Buffer[] {
  if (!bytes.length || bytes.length > MTUDPFormat.MaxDatagramBytes)
    throw new CProtocolError("Invalid MTUDP datagram size");
  const data = Buffer.from(bytes);
  const payloads: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const length = data[offset]!;
    if (length < 1 || offset + length + 1 > data.length)
      throw new CProtocolError("Invalid MTUDP frame length");
    const frame = data.subarray(offset, offset + length + 1);
    if (CCRC8.UpdateCRC(0, frame) !== 0)
      throw new CProtocolError("Invalid MTUDP CRC", "crc-mismatch");
    payloads.push(Buffer.from(frame.subarray(1, length)));
    offset += length + 1;
  }
  return payloads;
}

/** FXGS MTUDPBase::UnreliableSendToUnRegisteredHost 0042D2BF (also present in
 * Relay at 0040A6A0). Shared framing only; this does NOT implement a full MTUDP
 * host/queue/reliability engine or Relay's authenticated forwarding policy. */
export function EncodeUnregisteredDatagram(payload: Uint8Array): Buffer {
  const length = payload.length + 1;
  if (length > MTUDPFormat.MaxFrameLength)
    throw new CProtocolError("MTUDP payload too long");
  const out = Buffer.alloc(length + 1);
  out[0] = length;
  out.set(payload, 1);
  out[length] = CCRC8.UpdateCRC(0, out.subarray(0, length));
  return out;
}
