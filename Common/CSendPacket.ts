import { CSendPacketBase } from "./CSendPacketBase.ts";
import { CipherDegree } from "./OfficialValues.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";

/** Client-facing CSendPacket overload @ LS 004118E0; local packets explicitly use None. */
export class CSendPacket extends CSendPacketBase {
  constructor(
    type?: number,
    cipher: CipherDegree = CipherDegree.CRC8,
    text: CTextCodec = DefaultTextCodec,
  ) {
    super(type, cipher, text);
  }
}
