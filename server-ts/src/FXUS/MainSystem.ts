/** Native source unit: CX/CxUtil/MainSystem.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { CENTER_VERSION, CONN_HELLO_VERSION, SVRCLASS_UTIL } from "../protocol/CenterProtocol.ts";
import { S2C_UtilPacket } from "../protocol/PacketIDs.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";

/** CMainSystem::OnConnEstablished (CxUtil.exe.c:21701) — the tool hello's
 *  patch URL. */
const CONN_PATCH_URL = "ftp://patch.nexon.co.kr/ca";

/** CMainSystem — the FXAttr byte (CM 12) and the user serial counter (+32). */
export class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  m_nFXAttr = -1; // +4 (OnInitialSvrAttr)
  m_nConnNo = 0; // +32 — the ++ source for accept-time serials

  /** CMainSystem::OnInitialSvrAttr — [E1 attr][E1 ?] keeps the first byte. */
  OnInitialSvrAttr(n: CReceivedPacket): void {
    const attr = n.Decode1();
    n.Decode1();
    this.m_nFXAttr = attr;
  }

  /**
   * CMainSystem::OnConnEstablished — accept-time: one placeholder user with
   * a counter serial, the table insert, then the plain hello
   * [E2 3][E2 5][E4 headerType][EStr url].
   */
  OnConnEstablished(rConnectedSocket: CClientSocket): void {
    rConnectedSocket.ClearAttachedUsers();
    rConnectedSocket.AddNewUsers(1);
    const User = rConnectedSocket.GetUser(0)!;
    User.SetGlobalSerialNo(++this.m_nConnNo);
    if (CLocalUserTable.ms_pInstance?.Insert(User) === 0) console.error("Error! Failed to Add User");
    const packet = new CSendPacket(S2C_UtilPacket.OnConnect, CipherDegree.kPacketRaw);
    packet.Encode2(CENTER_VERSION);
    packet.Encode2(CONN_HELLO_VERSION[SVRCLASS_UTIL]);
    packet.Encode4(rConnectedSocket.m_nHeaderType);
    packet.EncodeStr(CONN_PATCH_URL);
    rConnectedSocket.SendPacket(packet);
  }
}
