/** Native source unit: CX/CxRelay/Utils.cpp. */
export function ipToDword(address: string): number {
  const [a, b, c, d] = address.split(".").map((part) => Number.parseInt(part, 10) & 0xff);
  return (((a ?? 0) << 24) | ((b ?? 0) << 16) | ((c ?? 0) << 8) | (d ?? 0)) >>> 0;
}

export function dwordToIp(value: number): string {
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}
