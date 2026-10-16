import { CSendPacket } from "../Common/CSendPacket.ts";
import { CipherDegree, LoginVersion } from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { ServerConfig } from "../Common/CServerConfig.ts";

/** LS 00410B30 / FXGS 00411737: greeting is unencrypted, with table substitution. */
export class CMainSystem {
  private nextGreeting = 0;
  constructor(readonly config: ServerConfig) {}
  OnConnEstablished(socket: CClientSocket): void {
    const greeting =
      this.config.LS.Greetings[
        this.nextGreeting++ % this.config.LS.Greetings.length
      ]!;
    socket.SendPacket(
      new CSendPacket(ServerResponse.Initial, CipherDegree.None, socket.text)
        .Encode2(LoginVersion.Major)
        .Encode2(LoginVersion.Minor)
        .Encode4(socket.m_nHeaderType!)
        .EncodeStr(greeting),
    );
  }
}
