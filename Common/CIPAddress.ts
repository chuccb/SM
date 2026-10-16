import { isIPv4 } from "node:net";
export function IPv4Number(ip: string): number {
  if (!isIPv4(ip)) throw new Error(`IPv4 address required: ${ip}`);
  return ip
    .split(".")
    .reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
}
/** inet_addr returns an x86 DWORD whose memory bytes already are in network order. */
export function InetAddr(ip: string): number {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(IPv4Number(ip));
  return b.readUInt32LE();
}
export function NormalizePeerIP(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
