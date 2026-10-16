import { COSmartStream } from "../Common/COSmartStream.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import type { ServerConfig } from "../Common/CServerConfig.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import { InetAddr } from "../Common/CIPAddress.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";

/** LS CMultiServer::Init @ 0041EBB0. Data describes THIS local deployment,
 * not made-up restored CAConfig rows; no notice-message entries are configured. */
export class CMultiServer {
  private readonly stream: COSmartStream;
  constructor(
    config: ServerConfig,
    readonly text: CTextCodec,
  ) {
    this.stream = new COSmartStream(text)
      .Encode1(1)
      .EncodeStr("Local")
      .EncodeStr(config.Runtime.AdvertisedIP)
      .Encode4(0)
      .Encode2(1)
      .Encode4(InetAddr(config.Runtime.AdvertisedIP))
      .Encode2(config.LS.Port)
      .Encode1(0)
      .Encode1(0);
  }
  GetHashValue(): number {
    return this.stream.GetHashValue();
  }
  GetInfoPacket(changed: boolean): CSendPacket {
    if (!changed)
      return new CSendPacket(
        ServerResponse.MultiServer,
        CipherDegree.CRC8,
        this.text,
      )
        .Encode1(0)
        .Encode1(0);
    return new CSendPacket(
      ServerResponse.MultiServer,
      CipherDegree.CRC32,
      this.text,
    )
      .EncodeOSStream(this.stream)
      .Encode1(0);
  }
}
