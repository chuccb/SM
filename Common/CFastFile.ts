import { readFileSync } from "node:fs";
import { CProtocolError } from "./CProtocolError.ts";

export interface _DATAENTRY {
  readonly name: string;
  readonly offset: number;
  readonly length: number;
}
export interface _FILEHANDLE {
  readonly entry: _DATAENTRY;
  position: number;
}
/** Read-only resource archive, FXGS CFastFile::LoadIdx @ 0042A0A1 and FastFileRead.
 * Resource names are archive keys, NEVER paths to open on the host filesystem. */
export class CFastFile {
  private data: Buffer = Buffer.alloc(0);
  private readonly entries = new Map<string, _DATAENTRY>();
  readonly m_aDataEntry: _DATAENTRY[] = [];
  FastFileInit(base: string): void {
    this.LoadIdx(readFileSync(`${base}.idx`), readFileSync(`${base}.idd`));
  }
  LoadIdx(idx: Uint8Array, idd: Uint8Array): void {
    const index = Buffer.from(idx);
    if (index.length < 4) throw new CProtocolError("Truncated archive index");
    const count = index.readUInt32LE(0);
    if (count > index.length / 13)
      throw new CProtocolError("Invalid archive entry count");
    let p = 4;
    const entries: _DATAENTRY[] = [];
    const names = new Set<string>();
    for (let i = 0; i < count; i++) {
      if (p + 4 > index.length)
        throw new CProtocolError("Truncated archive record");
      const length = index.readUInt32LE(p);
      p += 4;
      if (length === 0 || length >= 128 || p + length + 8 > index.length)
        throw new CProtocolError("Invalid archive key length");
      const name = index.subarray(p, p + length).toString("ascii");
      p += length;
      const offset = index.readUInt32LE(p);
      const size = index.readUInt32LE(p + 4);
      p += 8;
      if (
        name.includes("\0") ||
        names.has(name.toLowerCase()) ||
        offset + size > idd.length
      )
        throw new CProtocolError(`Invalid archive entry: ${name}`);
      names.add(name.toLowerCase());
      entries.push(Object.freeze({ name, offset, length: size }));
    }
    if (p !== index.length)
      throw new CProtocolError("Trailing archive index data");
    // Commit only after all entries were validated.
    this.entries.clear();
    this.m_aDataEntry.length = 0;
    this.data = Buffer.from(idd);
    for (const entry of entries) {
      this.entries.set(entry.name.toLowerCase(), entry);
      this.m_aDataEntry.push(entry);
    }
  }
  GetDataCount(): number {
    return this.m_aDataEntry.length;
  }
  GetDataEntry(index: number): _DATAENTRY {
    const e = this.m_aDataEntry[index];
    if (!e) throw new RangeError("Archive index");
    return e;
  }
  FastFileOpen(name: string): _FILEHANDLE | undefined {
    const entry = this.entries.get(name.toLowerCase());
    return entry ? { entry, position: 0 } : undefined;
  }
  FastFileRead(handle: _FILEHANDLE, length: number): Buffer {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      handle.position + length > handle.entry.length
    )
      throw new CProtocolError("Archive read out of bounds");
    const start = handle.entry.offset + handle.position;
    handle.position += length;
    return Buffer.from(this.data.subarray(start, start + length));
  }
  FastFileSeek(
    handle: _FILEHANDLE,
    offset: number,
    origin: 0 | 1 | 2 = 0,
  ): number {
    const next =
      offset +
      (origin === 1 ? handle.position : origin === 2 ? handle.entry.length : 0);
    if (!Number.isSafeInteger(next) || next < 0 || next > handle.entry.length)
      throw new CProtocolError("Archive seek out of bounds");
    handle.position = next;
    return next;
  }
  FastFileSize(handle: _FILEHANDLE): number {
    return handle.entry.length;
  }
  Get(name: string): Buffer {
    const handle = this.FastFileOpen(name);
    if (!handle) throw new CProtocolError(`Data file not found: ${name}`);
    return this.FastFileRead(handle, handle.entry.length);
  }
}
