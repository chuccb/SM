import {
  gsConvertTableDecode,
  gsConvertTableEncode,
} from "./Protocol/OfficialTables.ts";
import { CProtocolError } from "./CProtocolError.ts";

// LS 0042C470 / 0042C490. Only degree-0 packets use the substitution table.
export class CPacketHeaderConverter {
  static EncodeHeader(nType: number, nPacketType: number): number {
    return this.lookup(gsConvertTableEncode, nType, nPacketType);
  }
  static DecodeHeader(nType: number, nPacketType: number): number {
    return this.lookup(gsConvertTableDecode, nType, nPacketType);
  }
  private static lookup(
    table: readonly Buffer[],
    row: number,
    value: number,
  ): number {
    const n = table[row]?.[value];
    if (n === undefined)
      throw new CProtocolError("Header conversion index out of range");
    return n;
  }
}
