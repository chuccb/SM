import { COSmartStream } from "../Common/COSmartStream.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  CipherDegree,
  ServerType,
  OpaqueOfficial,
} from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import type { ServerConfig } from "../Common/CServerConfig.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import type { CCenterServer } from "../Center/CCenterServer.ts";
import { InetAddr } from "../Common/CIPAddress.ts";

export class CChannelCache {
  private readonly info: COSmartStream;
  constructor(
    readonly config: ServerConfig,
    readonly center: CCenterServer,
    readonly text: CTextCodec,
  ) {
    this.info = new COSmartStream(text).Encode2(config.FXGS.Channels.length);
    for (const c of config.FXGS.Channels)
      this.info
        .EncodeStr(c.Name)
        .Encode2(c.MaxUser)
        .Encode2(c.LevelLimit)
        .Encode1(c.Type)
        .Encode1(c.Community)
        .Encode2(0)
        .Encode1(c.EnterableType);
  }
  GetHashValue(): number {
    return this.info.GetHashValue();
  }
  GetInfoPacket(changed: boolean): CSendPacket {
    return changed
      ? new CSendPacket(
          ServerResponse.ChannelInfo,
          CipherDegree.CRC32,
          this.text,
        ).EncodeOSStream(this.info)
      : new CSendPacket(
          ServerResponse.ChannelInfo,
          CipherDegree.CRC8,
          this.text,
        ).Encode1(0);
  }
  GetStatePacket(): CSendPacket {
    const p = new CSendPacket(
      ServerResponse.ChannelState,
      CipherDegree.CRC8,
      this.text,
    ).Encode2(this.config.FXGS.Channels.length);
    for (const channel of this.config.FXGS.Channels) {
      const server = this.center.m_localServerMan.GetSvr(
        ServerType.FXGame,
        channel.Index,
      )!;
      p.Encode2(server.m_bConnected ? this.center.GetConnNo(server) : 0xffff);
    }
    return p;
  }
  /** LS 00405210: only channels with non-default game-event state are listed. */
  MakeChannelsGameStatePacket(): CSendPacket {
    return new CSendPacket(
      ServerResponse.ChannelGameState,
      CipherDegree.CRC8,
      this.text,
    ).Encode1(0);
  }
  /** LS 00405A20, with no advertisement, billing/NDA, guild-server/JUM entries.
   * Relay addresses are advertised only when the local relay is enabled. */
  MakeChannelsExtraInfoPacket(): CSendPacket {
    const p = new CSendPacket(
      ServerResponse.ChannelExtraInfo,
      CipherDegree.CRC8,
      this.text,
    )
      .EncodeStr("")
      .Encode2(0)
      .Encode2(0)
      .Encode2(OpaqueOfficial.AdvertisementInterval)
      .Encode1(0)
      .Encode1(0);
    p.Encode1(this.config.Relay.Enabled ? 1 : 0);
    if (this.config.Relay.Enabled)
      p.Encode4(InetAddr(this.config.Runtime.AdvertisedIP));
    return p.Encode2(0).Encode2(0).Encode1(0);
  }
}
