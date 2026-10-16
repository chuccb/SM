import { CFastFile } from "./CFastFile.ts";

/** FXGS CData::Load @ 0042D181: a direct, unencrypted read from the IDD archive. */
export class CData {
  private data: Buffer = Buffer.alloc(0);
  constructor(readonly files: CFastFile) {}
  Load(name: string): boolean {
    this.data = this.files.Get(name);
    return true;
  }
  Unload(): void {
    this.data = Buffer.alloc(0);
  }
  GetPtr(): Buffer {
    return Buffer.from(this.data);
  }
  GetSize(): number {
    return this.data.length;
  }
}
