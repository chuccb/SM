import { readFileSync } from "node:fs";

/**
 * CFastFile — the FxServer.idx/FxServer.idd package reader.
 * Native source unit: common/FastFile.cpp (FxServer.map: FastFile.obj).
 */

/** _DATAENTRY — one .idx record, 0x88 bytes in the original. */
export interface _DATAENTRY {
  strName: string; // +0 (char[128])
  offset: number; // +128
  length: number; // +132
}

/** The minimum/maximum name length LoadIdx accepts (42A1A1: <=0 or >=0x80 skips). */
const IDX_NAME_MIN = 1;
const IDX_NAME_MAX = 0x80;

export class CFastFile {
  m_pData: Uint8Array | null = null; // +16 (the MapViewOfFile of "%s.idd")
  m_nDataCount = 0; // +28 (the "%s.idx" entry count)
  m_vtEntry: _DATAENTRY[] = []; // +32 (the vector<_DATAENTRY>)

  /** CFastFile::FastFileInit — map "%s.idd" and load "%s.idx". */
  FastFileInit(base: string, _n64: number): boolean {
    try {
      this.m_pData = new Uint8Array(readFileSync(`${base}.idd`));
    } catch {
      this.m_pData = null;
      return false;
    }
    this.LoadIdx(base);
    return true;
  }

  /** CFastFile::LoadIdx — [u32 count]{[u32 nameLen][name][u32 offset][u32 length]}. */
  LoadIdx(base: string): void {
    let idx: Uint8Array;
    try {
      idx = new Uint8Array(readFileSync(`${base}.idx`));
    } catch {
      return;
    }
    const dv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    let at = 0;
    if (at + 4 > idx.byteLength) return;
    const count = dv.getUint32(at, true);
    at += 4;
    this.m_vtEntry = [];
    for (let i = 0; i < count; i++) {
      if (at + 4 > idx.byteLength) break;
      const nameLen = dv.getUint32(at, true);
      at += 4;
      if (nameLen < IDX_NAME_MIN || nameLen >= IDX_NAME_MAX) continue;
      if (at + nameLen + 8 > idx.byteLength) break;
      const name = Buffer.from(idx.subarray(at, at + nameLen)).toString("latin1");
      at += nameLen;
      const offset = dv.getUint32(at, true);
      at += 4;
      const length = dv.getUint32(at, true);
      at += 4;
      this.m_vtEntry.push({ strName: name, offset, length });
    }
    this.m_nDataCount = this.m_vtEntry.length;
  }

  /** CFastFile::FastFileOpen — resolve a name to {offset, length} (the bsearch). */
  FastFileOpen(name: string): _DATAENTRY | null {
    if (this.m_nDataCount === 0 || !name) return null;
    return this.m_vtEntry.find((e) => e.strName === name) ?? null;
  }

  /** CFastFile::FFReadFileSize — a private copy of the blob. */
  FFReadFileSize(name: string): { buf: Uint8Array; size: number } | null {
    const entry = this.FastFileOpen(name);
    if (!entry || !this.m_pData) return null;
    const end = Math.min(entry.offset + entry.length, this.m_pData.byteLength);
    return { buf: this.m_pData.subarray(entry.offset, end), size: entry.length };
  }

  /** CFastFile::GetDataCount / GetDataName. */
  GetDataCount(): number {
    return this.m_nDataCount;
  }

  GetDataName(i: number): string {
    return this.m_vtEntry[i]?.strName ?? "";
  }
}
