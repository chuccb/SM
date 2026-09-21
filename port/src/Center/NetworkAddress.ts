/** Port-only host/network byte-order helpers for the Bun socket adapters. */
export function IpToU32(ip: string): number {
  // The center stores every local-server address the way CxCenter.exe does:
  // CLocalServer ctor does `this[+56] = ntohl(inet_addr(cfgIP))` for all four
  // classes (CxCenter.exe.c:10791 LSIP / :10823 FXGSIP / :10856 FXSSIP /
  // :10892 FXUSIP), and the connect-to-server response feeds that stored
  // dword straight into Encode4 (CxCenter.exe.c:10283, consumed by the client
  // as the byte-reversed S_addr).  So the value on this path is HOST order:
  // the first octet is the most significant byte — 127.0.0.1 → 0x7F000001.
  // (Sites that store raw inet_addr — LS NDAIP/RelayIP/JUMS/GS p11 fields —
  // keep login/MultiServer.ts inet_addr() instead; the two conventions must
  // not be mixed.)
  const parts = ip.split(".").map((x) => Number.parseInt(x, 10) & 0xff);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return 0;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function U32ToIp(v: number): string {
  // exact inverse of IpToU32 (host order).
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
}
