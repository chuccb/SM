import { COSmartStream } from "../Common/COSmartStream.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";

/** LS 00409D80. Notice comes from SQLite/runtime configuration, not an external URL. */
export class CConfigDyn {
  private readonly stream: COSmartStream;
  constructor(
    notice: string,
    readonly text: CTextCodec,
  ) {
    this.stream = new COSmartStream(text).EncodeStr(notice);
  }
  GetNoticeHash(): number {
    return this.stream.GetHashValue();
  }
  GetNoticePacket(): CSendPacket {
    return new CSendPacket(
      ServerResponse.Notice,
      undefined,
      this.text,
    ).EncodeOSStream(this.stream);
  }
}
