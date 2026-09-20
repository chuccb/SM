/**
 * timeGetTime — the winmm stamp the original servers use for every 32-bit
 * timestamp that reaches the wire or a field: milliseconds of machine
 * uptime, wrapping at 2^32 (FxServer imports it for CGameClock, the RTT
 * echoes, the launch handshakes and the idle sweeps alike).  The clients
 * read these stamps with their own timeGetTime, so the values must live in
 * an uptime domain — a masked epoch (Date.now()) reads as tens of days and
 * deranges every client-side clock math.  performance.now() is the running
 * process's monotonic ms clock; >>> 0 reproduces the u32 wrap.
 */
export function timeGetTime(): number {
  return performance.now() >>> 0;
}
