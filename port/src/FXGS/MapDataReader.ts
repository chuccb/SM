/**
 * Port-only bounds-checked reader shared by the native GameMapTmpl.cpp and
 * GameMapTmplList.cpp adapters.  There is no MapDataReader.cpp or native
 * MapDataReader class; this replaces repeated pointer arithmetic only.
 */
const MAP_GROUP_NAME_LIMIT = 0x80;

export class MapDataReader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private Require(size: number): void {
    if (size > this.data.byteLength - this.at) throw new Error("! Invalid object description file.");
  }

  ReadInt(): number {
    this.Require(4);
    const value = this.view.getInt32(this.at, true);
    this.at += 4;
    return value;
  }

  ReadName(): string {
    const length = this.ReadInt() >>> 0;
    if (length >= MAP_GROUP_NAME_LIMIT) throw new Error("! Invalid object description file.");
    this.Require(length);
    const name = Buffer.from(this.data.subarray(this.at, this.at + length)).toString("latin1");
    this.at += length;
    return name.split("\0", 1)[0]!;
  }
}
