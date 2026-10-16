import { CProtocolError } from "../Common/CProtocolError.ts";
import type { ServerType } from "../Common/OfficialValues.ts";

export class CLocalServer {
  private m_connected = false;
  private m_connectionGeneration: object = Object.freeze({});
  get m_bConnected(): boolean {
    return this.m_connected;
  }
  set m_bConnected(value: boolean) {
    if (typeof value !== "boolean")
      throw new CProtocolError("Invalid server connection state");
    if (value !== this.m_connected) {
      this.m_connected = value;
      this.m_connectionGeneration = Object.freeze({});
    }
  }
  /** Modern opaque epoch: offline->online is not the same registration. */
  GetConnectionGeneration(): object {
    return this.m_connectionGeneration;
  }
  constructor(
    readonly m_nServerType: ServerType,
    readonly m_nIdx: number,
    readonly m_strName: string,
    public m_nListenPort: number,
    readonly m_nMaxUser: number,
    readonly m_nChannelType = 0,
  ) {}
  GetIdx(): number {
    return this.m_nIdx;
  }
  GetServerType(): ServerType {
    return this.m_nServerType;
  }
  GetListenPort(): number {
    return this.m_nListenPort;
  }
  GetMaxUser(): number {
    return this.m_nMaxUser;
  }
  GetChannelType(): number {
    return this.m_nChannelType;
  }
}
