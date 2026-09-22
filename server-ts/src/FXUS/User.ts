/** Native source unit: CX/CxUtil/User.cpp. */
import type { CClientSocket } from "./ClientSocket.ts";

/**
 * CUser (CxUtil.exe.c) — a tool identity.  m_pSocket (+272) and
 * m_dwGlobalSerialNo (+276, SetGlobalSerialNo) are the only fields the
 * handlers touch; the name lives in the CNamedObject base.
 */
export class CUser {
  m_pSocket: CClientSocket;
  m_dwGlobalSerialNo = 0; // +276
  m_strName = "";

  constructor(socket: CClientSocket) {
    this.m_pSocket = socket;
  }

  /** CNamedObject::SetName */
  SetName(strName: string): void {
    this.m_strName = strName;
  }

  GetName(): string {
    return this.m_strName;
  }

  /** CUser::SetGlobalSerialNo (+276). */
  SetGlobalSerialNo(serial: number): void {
    this.m_dwGlobalSerialNo = serial >>> 0;
  }

  GetSocket(): CClientSocket {
    return this.m_pSocket;
  }
}
