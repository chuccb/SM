/** Port-only protocol adapter for the local DigiQ-compatible billing substitute. */
import { CSendPacket } from "../FXSS/Packet.ts";
import { TW_BILLING_ReceivedPacket as Reply } from "../protocol/PacketIDs.ts";
import { BillingError } from "./Defs.ts";

/** Strict raw Tw body reader; invalid input never becomes zero/success. */
export class BillingReader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  private take(size: number): Uint8Array {
    if (this.offset + size > this.bytes.length) throw new BillingError("Truncated billing packet");
    const start = this.offset;
    this.offset += size;
    return this.bytes.subarray(start, this.offset);
  }
  u8(): number { return this.take(1)[0]; }
  u32(): number { return Buffer.from(this.take(4)).readUInt32BE(); }
  string(): string { return Buffer.from(this.take(this.u8())).toString("latin1"); }
  end(): void { if (this.offset !== this.bytes.length) throw new BillingError("Unexpected billing packet tail"); }
}
export function string8(packet: CSendPacket, value: string): void {
  const bytes = Buffer.from(value, "latin1");
  if (bytes.length > 255) throw new BillingError("Billing string exceeds byte length");
  packet.Encode1(bytes.length);
  packet.EncodeBuffer(bytes);
}
/** 312/321/322's string is opaque to Shop (00403C80/004047B0).
 * Local billing uses a 32-byte random reference, echoed verbatim by Shop.
 * This is a local correlation policy, not proof of the original field meaning.
 */
export function purchaseReply(id: typeof Reply.OnPurchaseOKTw | typeof Reply.OnPurchaseConfirmTw, reference: string, serial: number, error = "", stock = 0): CSendPacket {
  const p = new CSendPacket(id);
  if (id === Reply.OnPurchaseOKTw) { p.Encode4(0); p.Encode4(0); p.Encode4(0); }
  string8(p, reference);
  p.Encode4(serial);
  if (id === Reply.OnPurchaseOKTw) p.Encode4(stock);
  p.Encode4(error ? 1 : 0);
  if (error) string8(p, error);
  return p;
}
