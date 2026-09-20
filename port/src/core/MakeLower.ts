/**
 * MakeLower (shared server utility) — lowercase ASCII bytes while preserving
 * each Korean DBCS lead/trail pair verbatim. Protocol strings live in the
 * latin1 byte domain, so this mirrors the original Win32 helper rather than
 * applying Unicode case folding.
 */
export function MakeLower(source: string): string {
  let result = "";
  for (let i = 0; i < source.length;) {
    const value = source.charCodeAt(i);
    if (value === 0) break;
    // IsDBCSLeadByte under the shipped Korean ANSI code page (CP949).
    if (value >= 0x81 && value <= 0xfe) {
      result += source[i]!;
      i++;
      if (i < source.length && source.charCodeAt(i) !== 0) result += source[i]!;
      i++;
      continue;
    }
    result += value >= 0x41 && value <= 0x5a
      ? String.fromCharCode(value + 0x20)
      : source[i]!;
    i++;
  }
  return result;
}
