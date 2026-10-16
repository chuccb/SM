import { CaptureSystemTime, type _SYSTEMTIME } from "../Calendar.ts";
import { CProtocolError } from "../CProtocolError.ts";
import { IntegerRange, NativeTimeFormat } from "../OfficialValues.ts";

/** OLE DB DBTYPE_DBTIMESTAMP observations, NOT SQLite/Unix/JSON date strings.
 * year is signed SHORT; other components WORD; fraction DWORD. Native copies
 * discard fraction entirely, NOT nanoseconds -> milliseconds conversion. */
export interface tagDBTIMESTAMP {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: number;
}
export function CaptureDBTimestamp(
  input: Readonly<tagDBTIMESTAMP>,
): Readonly<tagDBTIMESTAMP> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid native DBTIMESTAMP");
  const { year, month, day, hour, minute, second, fraction } = input;
  const values = { year, month, day, hour, minute, second, fraction };
  for (const [name, value] of Object.entries(values)) {
    const min = name === "year" ? IntegerRange.Int16Minimum : 0,
      max =
        name === "fraction"
          ? IntegerRange.UInt32Maximum
          : IntegerRange.UInt16Maximum;
    if (!Number.isInteger(value) || value < min || value > max)
      throw new CProtocolError(`Invalid DBTIMESTAMP ${name}`);
  }
  // Accept signed OR unsigned SHORT spelling, expose identical signed bits.
  return Object.freeze({ ...values, year: (year << 16) >> 16 });
}
export function ReadDBTimestamp(input: Uint8Array): Readonly<tagDBTIMESTAMP> {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength !== NativeTimeFormat.DBTimestampBytes
  )
    throw new CProtocolError("Native DBTIMESTAMP requires exactly16 bytes");
  const b = Buffer.from(input),
    offsets = NativeTimeFormat.DBTimestamp;
  return Object.freeze({
    year: b.readInt16LE(offsets.Year),
    month: b.readUInt16LE(offsets.Month),
    day: b.readUInt16LE(offsets.Day),
    hour: b.readUInt16LE(offsets.Hour),
    minute: b.readUInt16LE(offsets.Minute),
    second: b.readUInt16LE(offsets.Second),
    fraction: b.readUInt32LE(offsets.Fraction),
  });
}
/**004404D0: all six components copied, ms ZEROED; weekday NOT written.
 * observedWeekday is an explicit observation of that destination word only;
 * absent observation stays null, never invented from host Date/old CTime. */
export function ConvertDBTimeToSystemTime(
  input: Readonly<tagDBTIMESTAMP>,
  observedWeekday: number | null = null,
): Readonly<_SYSTEMTIME> {
  const r = CaptureDBTimestamp(input);
  return CaptureSystemTime({
    wYear: r.year & IntegerRange.UInt16Maximum,
    wMonth: r.month,
    wDayOfWeek: observedWeekday,
    wDay: r.day,
    wHour: r.hour,
    wMinute: r.minute,
    wSecond: r.second,
    wMilliseconds: 0,
  });
}
/**00440F00: the same six fields, but BOTH weekday and ms are UNWRITTEN.
 * This is the field-conversion core only, NOT an OLE DB connection/NULL/status
 * decoder. Explicitly observed stack words may be supplied; never read memory. */
export function Get_FieldDate(
  input: Readonly<tagDBTIMESTAMP>,
  unwritten: Readonly<{
    wDayOfWeek: number | null;
    wMilliseconds: number | null;
  }> = { wDayOfWeek: null, wMilliseconds: null },
): Readonly<_SYSTEMTIME> {
  const r = CaptureDBTimestamp(input),
    { wDayOfWeek, wMilliseconds } = unwritten;
  return CaptureSystemTime({
    wYear: r.year & IntegerRange.UInt16Maximum,
    wMonth: r.month,
    wDayOfWeek,
    wDay: r.day,
    wHour: r.hour,
    wMinute: r.minute,
    wSecond: r.second,
    wMilliseconds,
  });
}
/**00440520: six WORD copies, signed year bits, fraction ALWAYS zero. */
export function ConvertSystemTimeToDBTime(
  input: Readonly<_SYSTEMTIME>,
): Readonly<tagDBTIMESTAMP> {
  const r = CaptureSystemTime(input);
  return Object.freeze({
    year: (r.wYear << 16) >> 16,
    month: r.wMonth,
    day: r.wDay,
    hour: r.wHour,
    minute: r.wMinute,
    second: r.wSecond,
    fraction: 0,
  });
}
