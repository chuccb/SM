import {
  CivilTimeMilliseconds,
  SystemTimeFromCivilMilliseconds,
  type _SYSTEMTIME,
} from "../Calendar.ts";
import { IntegerRange } from "../OfficialValues.ts";
import { CProtocolError } from "../CProtocolError.ts";
import {
  ConvertDBTimeToSystemTime,
  CaptureDBTimestamp,
  type tagDBTIMESTAMP,
} from "./NativeCalendar.ts";

/** Explicit MODERN per-server replacement for dangerous SyncLocalTimeFromDB.
 * No SQL calls and NEVER SetLocalTime / host Date / process.env.TZ. A trusted
 * observed nonnegative ExecResult anchors a STRICT valid DB civil timestamp
 * to injected monotonic milliseconds. This fixed-civil clock does NOT emulate
 * Windows timezone/DST, financial authority, SQL freshness or durable ACK. */
export class CDBClock {
  private m_anchor:
    | Readonly<{ CivilMilliseconds: number; Monotonic: number }>
    | undefined;
  private m_nRevision = 0;
  private m_lastMonotonic: number | undefined;
  private m_bBusy = false;
  constructor(
    private readonly monotonicMs: () => number = () =>
      Math.floor(performance.now()),
  ) {}
  GetState(): Readonly<{ Synchronized: boolean; Revision: number }> {
    return Object.freeze({
      Synchronized: this.m_anchor !== undefined,
      Revision: this.m_nRevision,
    });
  }
  private Sample(): number {
    const now = this.monotonicMs();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      (this.m_lastMonotonic !== undefined && now < this.m_lastMonotonic)
    )
      throw new CProtocolError("Invalid or backwards DB monotonic clock");
    this.m_lastMonotonic = now;
    return now;
  }
  private Fault(): void {
    this.m_anchor = undefined;
    // Exhausted generations can never be synchronized again; do not wrap.
    if (this.m_nRevision < IntegerRange.UInt32Maximum) this.m_nRevision++;
  }
  SyncLocalTimeFromDB(
    execResult: number,
    input: Readonly<tagDBTIMESTAMP>,
  ): boolean {
    if (this.m_bBusy) throw new CProtocolError("Reentrant DB calendar clock");
    if (
      !Number.isInteger(execResult) ||
      execResult < IntegerRange.Int32Minimum ||
      execResult > IntegerRange.UInt32Maximum
    )
      throw new CProtocolError("Invalid observed DB clock ExecResult");
    if ((execResult | 0) < 0) return false; // native does NOT inspect time on failure
    if (this.m_nRevision >= IntegerRange.UInt32Maximum)
      throw new CProtocolError("DB clock revision exhausted");
    this.m_bBusy = true;
    try {
      // All input copy/strict validation BEFORE sampling. A bad replacement
      // timestamp leaves the previous valid anchor/revision intact.
      const time = ConvertDBTimeToSystemTime(CaptureDBTimestamp(input)),
        civil = CivilTimeMilliseconds(time);
      let now: number;
      try {
        now = this.Sample();
      } catch (error) {
        this.Fault();
        throw error;
      }
      this.m_anchor = Object.freeze({
        CivilMilliseconds: civil,
        Monotonic: now,
      });
      this.m_nRevision++;
      return true;
    } finally {
      this.m_bBusy = false;
    }
  }
  GetLocalTime(): Readonly<_SYSTEMTIME> {
    return this.CaptureLocalTime().Time;
  }
  /** Modern atomic read-side time+generation snapshot, NOT financial authority.
   * Resync/fault generations cannot be confused with this captured time. */
  CaptureLocalTime(): Readonly<{
    Time: Readonly<_SYSTEMTIME>;
    Revision: number;
  }> {
    if (this.m_bBusy) throw new CProtocolError("Reentrant DB calendar clock");
    const anchor = this.m_anchor;
    if (!anchor)
      throw new CProtocolError("DB calendar clock is not synchronized");
    this.m_bBusy = true;
    try {
      const now = this.Sample(),
        current = anchor.CivilMilliseconds + (now - anchor.Monotonic);
      const time = SystemTimeFromCivilMilliseconds(current);
      return Object.freeze({ Time: time, Revision: this.m_nRevision });
    } catch (error) {
      // Do not let a later clock recovery resurrect an old eligibility sample.
      // A NEW explicit trusted DB observation is needed after any clock fault.
      this.Fault();
      throw error;
    } finally {
      this.m_bBusy = false;
    }
  }
}
