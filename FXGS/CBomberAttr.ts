import { CDataReader } from "../Common/CDataReader.ts";
import type { CFastFile } from "../Common/CFastFile.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";

export interface BomberAttr {
  readonly TmplName: string;
  readonly Opaque256: number;
  readonly DefSpeed: number;
  readonly MaxSpeed: number;
  readonly DefBombCount: number;
  readonly MaxBombCount: number;
  readonly DefBombPower: number;
  readonly MaxBombPower: number;
  readonly Opaque284: number;
  readonly Opaque288: number;
  readonly Opaque292: number;
}
/** FXGS 0043084B; GetDef* at 0041ABE5/0041ABF9/0041AC0D addresses are relative
 * to the object, not the row: subtract the 12-byte object header before naming fields. */
export class CBomberAttr {
  readonly m_aBomberAttr: BomberAttr[] = [];
  Load(files: CFastFile): void {
    const reader = new CDataReader(files.Get("Attr/BomberAttr"));
    const rows: BomberAttr[] = [];
    while (reader.remaining) {
      const TmplName = reader.string(53);
      if (!TmplName.length)
        throw new CProtocolError("Empty bomber template name");
      rows.push(
        Object.freeze({
          TmplName,
          Opaque256: reader.i32(),
          DefSpeed: reader.i32(),
          MaxSpeed: reader.i32(),
          DefBombCount: reader.i32(),
          MaxBombCount: Math.min(reader.i32(), 10),
          DefBombPower: reader.i32(),
          MaxBombPower: reader.i32(),
          Opaque284: reader.i32(),
          Opaque288: reader.i32(),
          Opaque292: reader.i32(),
        }),
      );
    }
    this.m_aBomberAttr.splice(0, this.m_aBomberAttr.length, ...rows);
  }
  GetNormalCount(): number {
    return (
      this.m_aBomberAttr.length -
      this.m_aBomberAttr.filter((a) => a.Opaque256 !== 0).length
    );
  }
  GetTotalCount(): number {
    return this.m_aBomberAttr.length;
  }
  GetRandomBomberIdx(): number {
    return this.GetTotalCount();
  }
  IsValidSelectIdx(index: number): boolean {
    return (
      Number.isInteger(index) &&
      ((index >= 0 && index < this.GetNormalCount()) ||
        index === this.GetRandomBomberIdx())
    );
  }
  GetDefSpeed(index: number): number {
    return this.get(index).DefSpeed;
  }
  GetDefBombCount(index: number): number {
    return this.get(index).DefBombCount;
  }
  GetDefBombPower(index: number): number {
    return this.get(index).DefBombPower;
  }
  private get(index: number): BomberAttr {
    const row = this.m_aBomberAttr[index];
    if (!row) throw new CProtocolError("Invalid bomber index");
    return row;
  }
}
