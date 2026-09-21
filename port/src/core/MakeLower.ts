const ASCII_UPPERCASE_A = 0x41;
const ASCII_UPPERCASE_Z = 0x5a;
const ASCII_CASE_OFFSET = 0x20;

/** Fold one ASCII uppercase value without applying Unicode case conversion. */
export function MakeLowerAscii(value: number): number {
  return value >= ASCII_UPPERCASE_A && value <= ASCII_UPPERCASE_Z
    ? value + ASCII_CASE_OFFSET
    : value;
}

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
    result += String.fromCharCode(MakeLowerAscii(value));
    i++;
  }
  return result;
}
