/**
 * timeGetTime — the original winmm API returns uint32 milliseconds since
 * Windows boot. The port uses performance.now(): monotonic milliseconds
 * since this process's time origin, truncated and wrapped to a DWORD.
 * This preserves local elapsed-time arithmetic, not a shared machine uptime,
 * Windows timer resolution or cross-process/client clock synchronization.
 */
export function timeGetTime(): number {
  return performance.now() >>> 0;
}
