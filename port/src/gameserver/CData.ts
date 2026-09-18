/**
 * CFastFile / CIDFMan / CData — the game-data package reader
 * (FxServer.exe.lst:42A25D FastFileInit, 42A10E LoadIdx, 429D72 FFReadFile).
 *
 * The original resolves every CData::Load("Attr/BomberAttr")-style name
 * against the "FxServer.idd" memory map using the "FxServer.idx" entry
 * table (CIDFMan::CIDFMan hardcodes the "FxServer" base, 42D079).  The
 * port keeps the base next to the .cfg, which is where FxServer.idd
 * ships (FXGS_000.cfg… sit in the server directory).
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
    const fs = require("node:fs") as typeof import("node:fs");
    try {
      this.m_pData = new Uint8Array(fs.readFileSync(`${base}.idd`));
    } catch {
      this.m_pData = null;
      return false;
    }
    this.LoadIdx(base);
    return true;
  }

  /** CFastFile::LoadIdx — [u32 count]{[u32 nameLen][name][u32 offset][u32 length]}. */
  LoadIdx(base: string): void {
    const fs = require("node:fs") as typeof import("node:fs");
    let idx: Uint8Array;
    try {
      idx = new Uint8Array(fs.readFileSync(`${base}.idx`));
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

/** CIDFMan — the CFastFile owner (TSingleton; the base name is "FxServer"). */
export class CIDFMan {
  static ms_pInstance: CIDFMan | null = null;
  m_FastFile = new CFastFile(); // +4

  constructor(base: string) {
    this.m_FastFile.FastFileInit(base, 64);
    CIDFMan.ms_pInstance = this;
  }
}

/** CData — one loaded blob (CData::Load, FxServer.exe.c:50131). */
export class CData {
  m_strName = ""; // +0
  m_nLength = 0; // +16 (GetSize)
  m_pData: Uint8Array | null = null; // +20 (GetPtr)

  /** CData::Load — a missing entry is the original's "Data File Not Found". */
  Load(name: string): boolean {
    this.Unload();
    const man = CIDFMan.ms_pInstance;
    const got = man ? man.m_FastFile.FFReadFileSize(name) : null;
    if (!got) {
      console.error(`[GS] Data File Not Found: ${name}`);
      return false;
    }
    this.m_strName = name;
    this.m_nLength = got.size;
    this.m_pData = got.buf;
    return true;
  }

  /** CData::Unload. */
  Unload(): void {
    this.m_pData = null;
    this.m_nLength = 0;
    this.m_strName = "";
  }

  GetSize(): number {
    return this.m_nLength;
  }
  GetPtr(): Uint8Array | null {
    return this.m_pData;
  }
}
