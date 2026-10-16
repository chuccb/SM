import { CDataReader } from "../Common/CDataReader.ts";
import type { CFastFile } from "../Common/CFastFile.ts";

/** Original CTileInfo is 44 bytes. Unknown fields are preserved, not relabeled as physics. */
export interface CTileInfo {
  readonly words: readonly number[];
}
// FXGS CMapObjToTileInfo::Load @ 004311C2: count + (u32 string, 11 native DWORDs).
export class CMapObjToTileInfo {
  private readonly m_mapAssoc = new Map<string, CTileInfo>();
  Load(files: CFastFile): void {
    const reader = new CDataReader(files.Get("TileInfo/TileInfo"));
    const count = reader.u32();
    const rows = new Map<string, CTileInfo>();
    for (let i = 0; i < count; i++) {
      const name = reader.string(255);
      rows.set(name, {
        words: Object.freeze(Array.from({ length: 11 }, () => reader.i32())),
      });
    }
    reader.end();
    this.m_mapAssoc.clear();
    for (const [key, val] of rows) this.m_mapAssoc.set(key, val);
  }
  GetAssoc(name: string): CTileInfo | undefined {
    return this.m_mapAssoc.get(name);
  }
  GetCount(): number {
    return this.m_mapAssoc.size;
  }
}
