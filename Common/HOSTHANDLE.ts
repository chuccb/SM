import { CProtocolError } from "./CProtocolError.ts";
import { IPv4Number } from "./CIPAddress.ts";

/** FXGS HOSTHANDLE: DWORD address + WORD port, then two bytes of native padding.
 * MTUDPServer::Proc 0042E367 applies ntohl/ntohs BEFORE constructing the handle:
 * these are host-order integers, NOT inet_addr's raw Win32 DWORD representation.
 * Only the six meaningful bytes are transmitted; padding is never serialized. */
export class HOSTHANDLE {
  constructor(
    readonly Address: number,
    readonly Port: number,
  ) {
    if (
      !Number.isInteger(Address) ||
      Address < 0 ||
      Address > 0xffffffff ||
      !Number.isInteger(Port) ||
      Port < 0 ||
      Port > 0xffff
    )
      throw new CProtocolError("Invalid HOSTHANDLE address/port");
    Object.freeze(this);
  }
  static FromAddress(address: string, port: number): HOSTHANDLE {
    return new HOSTHANDLE(IPv4Number(address), port);
  }
  /** HOSTHANDLE::operator== 0041B96C compares address and port, not padding. */
  Equals(other: HOSTHANDLE): boolean {
    return this.Address === other.Address && this.Port === other.Port;
  }
}
export const invalidHost = new HOSTHANDLE(0, 0);
