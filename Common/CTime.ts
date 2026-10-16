import {
  CaptureSystemTime,
  StrictSystemTimeToVariantTime,
  type _SYSTEMTIME,
} from "./Calendar.ts";
import { CProtocolError } from "./CProtocolError.ts";

/** Explicit trusted ports, not a default host clock / Windows DLL. The result
 * separates API failure from a valid DATE0. Native ignores BOOL and can return
 * uninitialized stack on failure; modern code REFUSES that indeterminate value. */
export interface CTimeEnvironment {
  readonly GetLocalTime: () => Readonly<_SYSTEMTIME>;
  readonly SystemTimeToVariantTime: (
    time: Readonly<_SYSTEMTIME>,
  ) => Readonly<{ Success: boolean; Value?: number }>;
}
export function StrictCalendarEnvironment(
  GetLocalTime: CTimeEnvironment["GetLocalTime"],
): CTimeEnvironment {
  return Object.freeze({
    GetLocalTime,
    SystemTimeToVariantTime: (time: Readonly<_SYSTEMTIME>) =>
      Object.freeze({
        Success: true,
        Value: StrictSystemTimeToVariantTime(time),
      }),
  });
}
/** FXGS004337C0..00433930. Native names / field copies retained; default clock
 * and WinAPI are injected, not silently replaced by JS Date/Unix/timezone.
 * GetAsSystemTime returns a detached DTO, with null for unobserved words. */
export class CTime {
  private m_systemtime: Readonly<_SYSTEMTIME>;
  private readonly local: CTimeEnvironment["GetLocalTime"];
  private readonly variant: CTimeEnvironment["SystemTimeToVariantTime"];
  private m_bReading = false;
  private m_bConverting = false;
  constructor(environment: CTimeEnvironment, time?: Readonly<_SYSTEMTIME>) {
    if (!environment || typeof environment !== "object")
      throw new CProtocolError("CTime requires explicit calendar ports");
    const { GetLocalTime, SystemTimeToVariantTime } = environment;
    if (
      typeof GetLocalTime !== "function" ||
      typeof SystemTimeToVariantTime !== "function"
    )
      throw new CProtocolError("CTime requires explicit calendar ports");
    this.local = GetLocalTime;
    this.variant = SystemTimeToVariantTime;
    this.m_systemtime = CaptureSystemTime(
      time === undefined ? this.local() : time,
    );
  }
  SetCurrentTime(): void {
    if (this.m_bReading) throw new CProtocolError("Reentrant CTime clock read");
    this.m_bReading = true;
    try {
      const next = CaptureSystemTime(this.local());
      this.m_systemtime = next;
    } finally {
      this.m_bReading = false;
    }
  }
  SetTime(time: Readonly<_SYSTEMTIME>): void {
    if (this.m_bReading) throw new CProtocolError("Reentrant CTime mutation");
    this.m_bReading = true;
    try {
      const next = CaptureSystemTime(time);
      this.m_systemtime = next;
    } finally {
      this.m_bReading = false;
    }
  }
  GetVariantTime(): number {
    if (this.m_bConverting)
      throw new CProtocolError("Reentrant CTime conversion");
    const captured = this.m_systemtime;
    this.m_bConverting = true;
    try {
      const result = this.variant(captured);
      if (!result)
        throw new CProtocolError(
          "CTime variant conversion failed or indeterminate",
        );
      const { Success, Value } = result;
      if (
        Success !== true ||
        typeof Value !== "number" ||
        !Number.isFinite(Value)
      )
        throw new CProtocolError(
          "CTime variant conversion failed or indeterminate",
        );
      return Value;
    } finally {
      this.m_bConverting = false;
    }
  }
  GetAsSystemTime(): Readonly<_SYSTEMTIME> {
    return CaptureSystemTime(this.m_systemtime);
  }
  GetYear(): number {
    return this.m_systemtime.wYear;
  }
  GetMonth(): number {
    return this.m_systemtime.wMonth;
  }
  GetDay(): number {
    return this.m_systemtime.wDay;
  }
  GetHour(): number {
    return this.m_systemtime.wHour;
  }
  GetMinute(): number {
    return this.m_systemtime.wMinute;
  }
  GetSecond(): number {
    return this.m_systemtime.wSecond;
  }
  GetDayOfWeek(): number {
    if (this.m_systemtime.wDayOfWeek === null)
      throw new CProtocolError("CTime weekday was not observed");
    return this.m_systemtime.wDayOfWeek;
  }
  GetDayOfWeekString(): string {
    const day = this.GetDayOfWeek();
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day] ?? "";
  }
  FormatTimePlain(): string {
    return [
      this.GetMonth(),
      this.GetDay(),
      this.GetHour(),
      this.GetMinute(),
      this.GetSecond(),
    ]
      .map((n) => String(n).padStart(2, "0"))
      .join("");
  }
  /**00408DD5 is calendar current time, NOT a WinMM DWORD tick. Modern snapshot
   * avoids native's shared mutable ms_timeCurrent across unrelated servers. */
  static GetTickCount(environment: CTimeEnvironment): CTime {
    return new CTime(environment);
  }
}
