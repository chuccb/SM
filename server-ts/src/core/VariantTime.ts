/** Win32 `SystemTimeToVariantTime` compatibility.
 *
 * The original servers first call `GetLocalTime`, then convert those local
 * SYSTEMTIME calendar fields. A JavaScript Date is an instant, so converting
 * its UTC epoch directly would incorrectly omit the service timezone.
 */
const OLE_AUTOMATION_EPOCH_MS = Date.UTC(1899, 11, 30);
const MILLISECONDS_PER_DAY = 86_400_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECONDS_PER_DAY = SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;

/** CTime::GetVariantTime — local SYSTEMTIME as OLE Automation DATE.
 * Win32's conversion has whole-second precision; SYSTEMTIME.wMilliseconds is
 * not part of the resulting value. Null is the native empty CTime sentinel.
 */
export function GetVariantTime(date: Date | null): number {
  if (date === null) return 0;
  if (Number.isNaN(date.getTime())) return Number.NaN;

  // Interpret local wall-clock fields as a timezone-free Gregorian calendar.
  // setUTCFullYear avoids Date.UTC's special 1900 offset for years 0..99.
  const localMidnight = new Date(0);
  localMidnight.setUTCHours(0, 0, 0, 0);
  localMidnight.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());

  const wholeDays = (localMidnight.getTime() - OLE_AUTOMATION_EPOCH_MS) / MILLISECONDS_PER_DAY;
  const seconds = (date.getHours() * MINUTES_PER_HOUR + date.getMinutes()) * SECONDS_PER_MINUTE
    + date.getSeconds();
  const fraction = seconds / SECONDS_PER_DAY;

  // OLE DATE stores the pre-epoch time-of-day fraction with a negative sign.
  return wholeDays < 0 ? wholeDays - fraction : wholeDays + fraction;
}

/** Encode CTime::GetVariantTime in its native little-endian wire form. */
export function EncodeVariantTime(date: Date | null): Uint8Array {
  const bytes = new Uint8Array(Float64Array.BYTES_PER_ELEMENT);
  new DataView(bytes.buffer).setFloat64(0, GetVariantTime(date), true);
  return bytes;
}
