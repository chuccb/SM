import type { CClientSocket } from "../Common/CClientSocket.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  ChannelType,
  CipherDegree,
  FirstInfoURL,
  LoginVersion,
} from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";

/** FXGS CMainSystem. Unlike LS, the original GS greeting is a fixed literal;
 * it does not rotate through the login server's configurable greeting list. */
export class CMainSystem {
  constructor(
    private m_nChannelType: number,
    private m_nGameAttr: number,
  ) {}
  SetChannelType(type: number): void {
    this.m_nChannelType = type;
  }
  GetChannelType(): number {
    return this.m_nChannelType;
  }
  GetGameAttr(): number {
    return this.m_nGameAttr;
  }
  IsPremiumChannel(): boolean {
    return this.m_nChannelType === ChannelType.Premium;
  }
  OnConnEstablished(socket: CClientSocket): void {
    // FXGS 00411737; degree zero still has header substitution tables.
    socket.SendPacket(
      new CSendPacket(ServerResponse.Initial, CipherDegree.None, socket.text)
        .Encode2(LoginVersion.Major)
        .Encode2(LoginVersion.Minor)
        .Encode4(socket.m_nHeaderType!)
        .EncodeStr(FirstInfoURL.Greeting),
    );
  }
}
