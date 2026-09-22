/** Native source unit: common/cUnreliableQueueIn.cpp (CxLogin.pdb: cUnreliableQueueIn.obj). */
import { timeGetTime } from "../core/timeGetTime.ts";
import { MTUDP_MAX_TOTAL_LENGTH } from "../shared/MTUDP.ts";

/** cUnreliableQueueIn (CxLogin.exe.c:26148) — a growable record chain of
 *  [E4 len][payload] entries.  AddPacket drops with a report at the 0x3000
 *  capacity gate (`count + len + 2 <= 0x3000`, verbatim), GetPacket copies
 *  min(maxSize, len) and removes the whole record (the original's
 *  truncation semantics). */
export class cUnreliableQueueIn {
  /** the AddPacket capacity gate (CxLogin.exe.c:26195) */
  static readonly CAPACITY = 0x3000;
  /** the longest packet AddPacket accepts (CxLogin.exe.c:26178) */
  static readonly MAX_PACKET = MTUDP_MAX_TOTAL_LENGTH;
  static readonly RECORD_LENGTH_BYTES = 4;
  private static readonly CAPACITY_GATE_OVERHEAD = 2;

  /** The C++ byte store starts at object offset +36.  The TS array represents
   * only that store, so its first record starts at zero, not at object +36.
   * Two safe tail bytes preserve the native `count + len + 2` admission gate. */
  m_anBuf = new Uint8Array(
    cUnreliableQueueIn.CAPACITY + cUnreliableQueueIn.CAPACITY_GATE_OVERHEAD,
  );
  private readonly m_view = new DataView(
    this.m_anBuf.buffer,
    this.m_anBuf.byteOffset,
    this.m_anBuf.byteLength,
  );
  m_nCount = 0; // +12324: bytes queued
  m_nPacketCount = 0; // +12328: caller sequence + 1
  m_dwLastTick = timeGetTime(); // +12332

  /** cUnreliableQueueIn::AddPacket (CxLogin.exe.c:26173) — the original's
   *  second argument is a sequence/flag the two call sites pass as literal 0.
   *  Records are [E4 len][payload]; the admission test nevertheless uses the
   *  native `count + len + 2` expression documented above. */
  AddPacket(flags: number, pSrc: Uint8Array | null, len: number, tick: number): void {
    if (pSrc === null || len === 0 || len > cUnreliableQueueIn.MAX_PACKET) return;
    this.m_dwLastTick = tick;
    if (
      this.m_nCount + len + cUnreliableQueueIn.CAPACITY_GATE_OVERHEAD >
      cUnreliableQueueIn.CAPACITY
    ) {
      console.error(`CUnreliableQueueIn::AddPacket - rcv buffer overflow ${len},${this.m_nCount}`);
      return;
    }
    const at = this.m_nCount;
    this.m_view.setUint32(at, len, false); // CBufferManipulator::Encode4 (BE)
    this.m_anBuf.set(pSrc.subarray(0, len), at + cUnreliableQueueIn.RECORD_LENGTH_BYTES);
    this.m_nCount += cUnreliableQueueIn.RECORD_LENGTH_BYTES + len;
    this.m_nPacketCount = flags + 1;
  }

  /** cUnreliableQueueIn::GetPacket — returns the bytes copied (0 = empty). */
  GetPacket(pDes: Uint8Array, maxSize: number): number {
    if (this.m_nCount === 0) return 0;
    const len = this.m_view.getUint32(0, false); // CBufferManipulator::Decode4 (BE)
    const dataAt = cUnreliableQueueIn.RECORD_LENGTH_BYTES;
    const n = Math.min(maxSize, len);
    pDes.set(this.m_anBuf.subarray(dataAt, dataAt + n), 0);
    const nextAt = dataAt + len;
    const rest = this.m_nCount - nextAt;
    if (rest > 0) this.m_anBuf.copyWithin(0, nextAt, nextAt + rest);
    this.m_nCount = rest;
    return n;
  }

  Clear(): void {
    this.m_nCount = 0;
  }
}
