const MILLISECONDS_PER_SECOND = 1_000;

/** C `time(nullptr)` seed domain used by the native server CRT streams. */
export function GetUnixTimeSeconds(timestamp = Date.now()): number {
  return Math.floor(timestamp / MILLISECONDS_PER_SECOND);
}

/** Port-only local-calendar helpers shared by the SQLite adapters.
 *
 * SQL Server's `getdate() + @ValidityPeriod` advances the local calendar,
 * rather than adding a fixed number of UTC milliseconds. `Date#setDate`
 * preserves that wall-clock behavior across daylight-saving transitions.
 */
export function AddLocalCalendarDays(timestamp: number | Date, days: number): Date {
  const result = new Date(timestamp instanceof Date ? timestamp.getTime() : timestamp);
  result.setDate(result.getDate() + days);
  return result;
}
