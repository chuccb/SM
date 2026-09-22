/** Native source unit: CX/CxLogin/User.cpp. */
import type { CClientSocket } from "./ClientSocket.ts";
import { AddLoginUser, FreeLoginUser } from "./LoginRuntime.ts";

/** _USERACCOUNT + CUser of CxLogin (0x114 bytes). */
export class CUser {
  socket: CClientSocket;
  strId = ""; // UA +0  (CUser +24)
  strSSN1 = ""; // UA +36 (CUser +60, GetSSN1)
  strSSN2 = ""; // UA +48 (CUser +72, GetSSN2)
  strEmail = ""; // UA +60 (CUser +84)
  nSID = 0; // UA +152 (CUser +176, GetSID)
  nCommunitySvr = 0; // UA +148 (byte)
  nFxMoney = 0; // UA +168 (CUser +192)
  nFxexp = 0; // UA +172 (CUser +196)
  nTxexp = 0; // UA +224 (CUser +224)
  nGuildSerialNo = 0; // UA +244 (CUser +268)
  nGlobalSerialNo = 0; // CUser +264
  nPremiumTicket = 0; // CUser +272

  constructor(socket: CClientSocket) {
    this.socket = socket;
    // CUserPool::AddNewUser (CUser ctor) — a duplicate name logs in on the
    // same pool row in practice; the refusal return gates nothing here.
    AddLoginUser(this);
  }

  GetId(): string {
    return this.strId;
  }

  GetName(): string {
    return this.strId; // CNamedObject name — set to the login id by CDBMan::InitUser
  }

  GetSID(): number {
    return this.nSID;
  }

  GetGlobalSerialNo(): number {
    return this.nGlobalSerialNo;
  }

  SetGlobalSerialNo(serial: number): void {
    this.nGlobalSerialNo = serial >>> 0;
  }

  SetGuildSerialNo(serial: number): void {
    this.nGuildSerialNo = serial;
  }

  GetPremiumTicket(): number {
    return this.nPremiumTicket;
  }

  SetPremiumTicket(ticket: number): void {
    this.nPremiumTicket = ticket;
  }

  GetSocket(): CClientSocket {
    return this.socket;
  }

  /** CUser::SafeFree (004177F0) — unregister this user's own center serial,
   * then remove the exact object from the login pool and local lookup table. */
  SafeFree(): void {
    FreeLoginUser(this);
    this.nGlobalSerialNo = 0;
  }
}
