/**
 * CIDFMan and CData — the FxServer fast-file owner and one loaded blob.
 * Native source unit: common/IDFMan.cpp (FxServer.map: IDFMan.obj).
 *
 * CData::Load/Unload, its RTTI, and CIDFMan are emitted by IDFMan.obj.
 * DataFile.cpp instead implements the unrelated CDataFile filesystem wrapper,
 * which this Bun port does not need.
 */
import { CFastFile } from "./FastFile.ts";

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

export class CIDFMan {
  static ms_pInstance: CIDFMan | null = null;
  m_FastFile = new CFastFile(); // +4

  constructor(base: string) {
    this.m_FastFile.FastFileInit(base, 64);
    CIDFMan.ms_pInstance = this;
  }
}
