/** FxShop packet overloads and Taiwan billing codec (00419040..004193AC).
 * These are NOT the game's 3-byte frames or a new cipher degree.
 */
import { CSendPacket as CSendPacketBase, CReceivedPacket, CipherDegree } from "../core/Packet.ts";
import { Decode4, Encode4 } from "../core/BufferManipulator.ts";

export const TW_HEADER_SIZE = 8;
/** Emitted at +4; the native decoder does not validate it. */
export const TW_HEADER_CODE = 7;
export const TW_PACKET_TYPE_SIZE = 4;
const BNB_TAIWAN_PACKET_FAMILY = { Billing: 0, Coupon: 1 } as const;
export type PacketTypeSize = 1 | 2 | 4;

/** CSendPacket(int, int) (00419280): second argument is opcode width.
 * Keep this separate from core CSendPacket's cipher-degree constructor.
 */
export class CSendPacket extends CSendPacketBase {
  constructor(nPacketType: number, nPacketTypeSize: PacketTypeSize = TW_PACKET_TYPE_SIZE) {
    super();
    this.m_uOffset = 0; // native CSendPacketBase() starts with no opcode
    this.InitPacket(nPacketType, nPacketTypeSize);
  }

  /** 00419170: sets raw degree and APPENDS the opcode, unlike the base
   * InitPacket overload which resets the packet. No implicit buffer reset. */
  override InitPacket(nPacketType: number, nPacketTypeSize: PacketTypeSize = TW_PACKET_TYPE_SIZE): this {
    this.SetCipherDegree(CipherDegree.kPacketRaw);
    switch (nPacketTypeSize) {
      case 1: this.Encode1(nPacketType); break;
      case 2: this.Encode2(nPacketType); break;
      case 4: this.Encode4(nPacketType); break;
    }
    this.m_nPacketType = nPacketType;
    return this;
  }

  /** BNB_TAIWAN::enBillingPacket constructor (00419040): [E1 0][E1 id]. */
  static FromBillingPacket(nPacketType: number): CSendPacket {
    return this.FromFamilyPacket(BNB_TAIWAN_PACKET_FAMILY.Billing, nPacketType);
  }

  /** BNB_TAIWAN::enCouponPacket constructor (004190A0): [E1 1][E1 id]. */
  static FromCouponPacket(nPacketType: number): CSendPacket {
    return this.FromFamilyPacket(BNB_TAIWAN_PACKET_FAMILY.Coupon, nPacketType);
  }

  private static FromFamilyPacket(family: number, nPacketType: number): CSendPacket {
    const packet = new CSendPacket(family, 1);
    packet.Encode1(nPacketType);
    packet.m_nPacketType = nPacketType;
    return packet;
  }
}

/** CSendPacket::GetOutgoingPacketLengthTw (004191E0).
 * Functions accept the common packet storage; no cast or duplicate buffers
 * are needed to use the core socket FIFO/pump with this specialized codec.
 */
export function GetOutgoingPacketLengthTw(packet: CSendPacketBase): number {
  return packet.m_nCipherDegree === CipherDegree.kPacketRaw ? ((packet.m_uOffset + TW_HEADER_SIZE) | 0) : 0;
}

/** CSendPacket::EncodePacketTw (004192E0). */
export function EncodePacketTw(packet: CSendPacketBase, destination: Uint8Array, offset = 0): boolean {
  if (packet.m_nCipherDegree !== CipherDegree.kPacketRaw) return false;
  const length = GetOutgoingPacketLengthTw(packet);
  if (length < TW_HEADER_SIZE || packet.m_uOffset > packet.m_pBlock.length ||
      offset < 0 || offset + length > destination.length) return false;
  Encode4(destination, offset, packet.m_uOffset);
  Encode4(destination, offset + 4, TW_HEADER_CODE);
  destination.set(packet.m_pBlock.subarray(0, packet.m_uOffset), offset + TW_HEADER_SIZE);
  return true;
}

/** CReceivedPacket::GetIncomingPacketLengthTw (00419230).
 * DWORD addition followed by the caller's signed comparisons (00405635,
 * 0040564E, 00405673). In particular 0xFFFFFFF7 + 8 is the -1 sentinel;
 * do not turn it into an invented too-long rejection. DecodePacketTw below
 * bounds actual storage before allocation instead of reproducing unsafe reads.
 */
export function GetIncomingPacketLengthTw(packet: CReceivedPacket, source: Uint8Array, length: number): number {
  if (packet.m_nCipherDegree !== CipherDegree.kPacketRaw) return 0;
  if (length < TW_HEADER_SIZE) return -1;
  return (Decode4(source, 0) + TW_HEADER_SIZE) | 0;
}

/** CReceivedPacket::DecodePacketTw (00419350): nonempty raw payload;
 * skip the header without checking +4, leave the read cursor at opcode.
 * Native discards its Decode4 return; m_nPacketType here is trace metadata
 * only. Dispatch still calls Decode4 on the unmodified payload.
 */
export function DecodePacketTw(packet: CReceivedPacket, source: Uint8Array, length: number): boolean {
  if (packet.m_nCipherDegree !== CipherDegree.kPacketRaw || length <= TW_HEADER_SIZE || length > source.length) return false;
  packet.SetRcvPacket(source.subarray(TW_HEADER_SIZE, length), length - TW_HEADER_SIZE);
  packet.m_nPacketType = packet.Decode4At(0);
  return true;
}

/** Billing's [E1 byte count][raw ANSI bytes], NOT the client's EStr/u16.
 * Native uses DecodeBuffer into stack storage. Bound the read and preserve
 * every byte (including NUL), without reproducing stack overflow/overread UB.
 */
export function DecodeBillingString(packet: CReceivedPacket): string | null {
  if (packet.IsEOS()) return null;
  const length = packet.Decode1();
  if (packet.m_uLength - packet.m_uOffset < length) return null;
  const start = packet.m_uOffset;
  packet.m_uOffset += length;
  return Buffer.from(packet.m_pBlock.subarray(start, packet.m_uOffset)).toString("latin1");
}
