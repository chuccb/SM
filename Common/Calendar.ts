import { CProtocolError } from "./CProtocolError.ts";
import { IntegerRange } from "./OfficialValues.ts";

/** Native WORD layout; null records an UNOBSERVED/UNWRITTEN word, NOT zero.
 * Get_FieldDate leaves weekday AND milliseconds unwritten; DBMan conversion
 * leaves weekday unwritten but explicitly zeros milliseconds. */
export interface _SYSTEMTIME {
  readonly wYear: number;
  readonly wMonth: number;
  readonly wDayOfWeek: number | null;
  readonly wDay: number;
  readonly wHour: number;
  readonly wMinute: number;
  readonly wSecond: number;
  readonly wMilliseconds: number | null;
}
/** Portable, explicitly STRICT Gregorian profile, not recovered OS policy.
 * No two-digit-year mapping, invalid-day rolling, timezone/DST, host Date or
 * Windows DLL/rounding oracle. Calendar primitives are mathematical units. */
export const CalendarProfile = {
  MinimumYear: 100,
  MaximumYear: 9999,
  MonthsPerYear: 12,
  DaysPerWeek: 7,
  HoursPerDay: 24,
  MinutesPerHour: 60,
  SecondsPerMinute: 60,
  MillisecondsPerSecond: 1000,
  SecondsPerDay: 86400,
  MillisecondsPerDay: 86400000,
  VariantEpoch: { Year: 1899, Month: 12, Day: 30 },
} as const;
const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const optionalWords = new Set(["wDayOfWeek", "wMilliseconds"]);
export function CaptureSystemTime(
  input: Readonly<_SYSTEMTIME>,
): Readonly<_SYSTEMTIME> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid SYSTEMTIME");
  const {
    wYear,
    wMonth,
    wDayOfWeek,
    wDay,
    wHour,
    wMinute,
    wSecond,
    wMilliseconds,
  } = input;
  const fields = {
    wYear,
    wMonth,
    wDayOfWeek,
    wDay,
    wHour,
    wMinute,
    wSecond,
    wMilliseconds,
  };
  for (const [name, value] of Object.entries(fields))
    if (
      !(value === null && optionalWords.has(name)) &&
      (typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > IntegerRange.UInt16Maximum)
    )
      throw new CProtocolError(`Invalid SYSTEMTIME ${name}`);
  return Object.freeze(fields);
}
export function IsGregorianLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function daysBeforeYear(year: number): number {
  const y = year - 1;
  return (
    y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400)
  );
}
function dayNumber(year: number, month: number, day: number): number {
  let days = daysBeforeYear(year) + day - 1;
  for (let m = 1; m < month; m++)
    days += monthDays[m - 1]! + (m === 2 && IsGregorianLeapYear(year) ? 1 : 0);
  return days;
}
function validCivil(input: Readonly<_SYSTEMTIME>): Readonly<_SYSTEMTIME> {
  const time = CaptureSystemTime(input),
    { wYear: y, wMonth: m, wDay: d, wHour: h, wMinute: min, wSecond: s } = time;
  if (
    y < CalendarProfile.MinimumYear ||
    y > CalendarProfile.MaximumYear ||
    m < 1 ||
    m > CalendarProfile.MonthsPerYear ||
    d < 1 ||
    d > monthDays[m - 1]! + (m === 2 && IsGregorianLeapYear(y) ? 1 : 0) ||
    h >= CalendarProfile.HoursPerDay ||
    min >= CalendarProfile.MinutesPerHour ||
    s >= CalendarProfile.SecondsPerMinute
  )
    throw new CProtocolError("Unsupported strict Gregorian civil time");
  return time;
}
const epochDay = dayNumber(
  CalendarProfile.VariantEpoch.Year,
  CalendarProfile.VariantEpoch.Month,
  CalendarProfile.VariantEpoch.Day,
);
/** Deterministic Gregorian subset of OLE DATE: seconds INCLUDED, ms ignored;
 * days BEFORE1899-12-30 subtract positive time fraction. Raw negative DATE must
 * NOT be treated as chronological day+fraction arithmetic or Unix seconds. */
export function StrictSystemTimeToVariantTime(
  input: Readonly<_SYSTEMTIME>,
): number {
  const t = validCivil(input),
    days = dayNumber(t.wYear, t.wMonth, t.wDay) - epochDay,
    seconds =
      (t.wHour * CalendarProfile.MinutesPerHour + t.wMinute) *
        CalendarProfile.SecondsPerMinute +
      t.wSecond,
    fraction = seconds / CalendarProfile.SecondsPerDay;
  return days < 0 ? days - fraction : days + fraction;
}
/** Mathematical civil milliseconds since Gregorian0001-01-01, NOT Unix/UTC.
 * Used ONLY by the isolated fixed-civil clock, never persisted in legacy rows. */
export function CivilTimeMilliseconds(input: Readonly<_SYSTEMTIME>): number {
  const t = validCivil(input);
  if (
    t.wMilliseconds === null ||
    t.wMilliseconds >= CalendarProfile.MillisecondsPerSecond
  )
    throw new CProtocolError(
      "Civil clock requires observed milliseconds0..999",
    );
  return (
    dayNumber(t.wYear, t.wMonth, t.wDay) * CalendarProfile.MillisecondsPerDay +
    ((t.wHour * CalendarProfile.MinutesPerHour + t.wMinute) *
      CalendarProfile.SecondsPerMinute +
      t.wSecond) *
      CalendarProfile.MillisecondsPerSecond +
    t.wMilliseconds
  );
}
const firstCivil =
    daysBeforeYear(CalendarProfile.MinimumYear) *
    CalendarProfile.MillisecondsPerDay,
  lastCivilExclusive =
    daysBeforeYear(CalendarProfile.MaximumYear + 1) *
    CalendarProfile.MillisecondsPerDay;
export function SystemTimeFromCivilMilliseconds(
  value: number,
): Readonly<_SYSTEMTIME> {
  if (
    !Number.isSafeInteger(value) ||
    value < firstCivil ||
    value >= lastCivilExclusive
  )
    throw new CProtocolError("Civil clock outside supported Gregorian range");
  const day = Math.floor(value / CalendarProfile.MillisecondsPerDay);
  let remainder = value % CalendarProfile.MillisecondsPerDay;
  let low = CalendarProfile.MinimumYear as number,
    high = CalendarProfile.MaximumYear as number;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (daysBeforeYear(mid) <= day) low = mid;
    else high = mid - 1;
  }
  const wYear = low;
  let remainingDays = day - daysBeforeYear(wYear),
    wMonth = 1;
  while (true) {
    const size =
      monthDays[wMonth - 1]! +
      (wMonth === 2 && IsGregorianLeapYear(wYear) ? 1 : 0);
    if (remainingDays < size) break;
    remainingDays -= size;
    wMonth++;
  }
  const wHour = Math.floor(
    remainder /
      (CalendarProfile.MillisecondsPerSecond *
        CalendarProfile.SecondsPerMinute *
        CalendarProfile.MinutesPerHour),
  );
  remainder %=
    CalendarProfile.MillisecondsPerSecond *
    CalendarProfile.SecondsPerMinute *
    CalendarProfile.MinutesPerHour;
  const wMinute = Math.floor(
    remainder /
      (CalendarProfile.MillisecondsPerSecond *
        CalendarProfile.SecondsPerMinute),
  );
  remainder %=
    CalendarProfile.MillisecondsPerSecond * CalendarProfile.SecondsPerMinute;
  return Object.freeze({
    wYear,
    wMonth,
    wDayOfWeek: (day + 1) % CalendarProfile.DaysPerWeek,
    wDay: remainingDays + 1,
    wHour,
    wMinute,
    wSecond: Math.floor(remainder / CalendarProfile.MillisecondsPerSecond),
    wMilliseconds: remainder % CalendarProfile.MillisecondsPerSecond,
  });
}
