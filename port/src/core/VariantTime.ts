/** CTime::GetVariantTime — OLE Automation days since 1899-12-30. */
export function GetVariantTime(date: Date | null): number {
  return date ? date.getTime() / 86_400_000 + 25_569 : 0;
}

/** Encode CTime::GetVariantTime in its native little-endian wire form. */
export function EncodeVariantTime(date: Date | null): Uint8Array {
  const bytes = new Uint8Array(Float64Array.BYTES_PER_ELEMENT);
  new DataView(bytes.buffer).setFloat64(0, GetVariantTime(date), true);
  return bytes;
}
