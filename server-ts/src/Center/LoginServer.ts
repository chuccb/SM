/** Native source unit: CX/CxCenter/LoginServer.cpp. */
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { CM_ReceivedPacket, MC_ReceivedPacket, SVRCLASS_LOGIN } from "../core/protocol/CenterProtocol.ts";
import { CLocalServer, type LocalServerHost } from "./LocalServer.ts";
import { CUser } from "./User.ts";

export class CLoginServer extends CLocalServer {
  override OnPacket(id: number, n: CReceivedPacket, center: LocalServerHost): void {
    switch (id) {
      case MC_ReceivedPacket.OnAddNewUser:
        CLoginServer.prototype.OnAddNewUser.call(this, n, center);
        return;
      case MC_ReceivedPacket.OnDestructCenterSvr:
        CLoginServer.prototype.OnDestructCenterSvr.call(this, center);
        return;
      default:
        super.OnPacket(id, n, center);
    }
  }

  /** CLoginServer::OnPacket MC 100.  The native marks the reserved
   * global-user entry 0xFFFFFFFF free; installations without that sentinel
   * simply have no work to do. */
  OnDestructCenterSvr(center: LocalServerHost): void {
    center.globalUserTable.serialTable.get(0xffffffff)?.SetFree(center);
  }

  /**
   * CLoginServer::OnAddNewUser (center side, CxCenter.exe.c:15163).
   *
   * The shipped binary's optional AuthenThread branch is unreachable:
   * CAuthenThread's constructor writes its +0xFAC0B0 gate to zero, the only
   * other references read that gate, and AuthenSocket::Connect has no caller
   * (CxCenter.exe.lst:00404CDD, 0040878C, 0040EB42). The port therefore keeps
   * the native immediate response path rather than inventing an auth service.
   */
  OnAddNewUser(n: CReceivedPacket, center: LocalServerHost): void {
    const nIP = n.Decode4(); // the client's in_addr (the LS reads CClientSocket+12)
    n.m_uOffset += 16; // machine id (DecodeBuffer into a scratch buffer)
    n.Decode4(); // game room code
    const count = n.Decode1();
    const users: CUser[] = [];
    let fAllAdded = 1;
    for (let i = 0; i < count; i++) {
      const name = n.DecodeStr();
      const sn = n.Decode4();
      const fAuthencode = n.Decode1();
      const communitySvr = n.Decode1();
      const u = new CUser(name, SVRCLASS_LOGIN, this.nSvrIdx, sn, 0, nIP, center);
      if (fAuthencode !== 0) u.nAuthencode = 1; // CUser+56 — the LS GetPremiumTicket byte
      u.nCommunitySvr = communitySvr;
      u.nLocalSerialNo = 0; // filled from the packet tail below
      // Native stops calling AddNewUser after the first failure, while still
      // decoding/constructing the rest of the batch for the rollback below.
      if (fAllAdded !== 0) fAllAdded = center.globalUserTable.AddNewUser(u);
      users.push(u);
    }
    const nb = n.Decode4();
    for (const u of users) u.nLocalSerialNo = nb;
    const packet = new CSendPacket(CM_ReceivedPacket.OnCenterResAddNewUser);
    packet.Encode4(nb);
    packet.Encode4(fAllAdded);
    packet.Encode1(users.length);
    for (const u of users) {
      if (fAllAdded) {
        packet.Encode4(u.m_nGlobalSerial);
        packet.Encode1(u.GetAuthencode());
      } else {
        packet.Encode4(0);
      }
    }
    this.socket?.SendPacket(packet);
    if (!fAllAdded) {
      for (const user of users) {
        // Native calls ExtractUser(newGlobalSerial) and SetFree for every
        // constructed row. Even when AddNewUser refused due to duplicate name,
        // the newly constructed rows still need cleanup.
        if (center.globalUserTable.serialTable.get(user.m_nGlobalSerial) === user) center.globalUserTable.ExtractUser(user.m_nGlobalSerial);
        else if (center.globalUserTable.userTable.get(user.m_strName) === user) center.globalUserTable.userTable.delete(user.m_strName);
        user.SetFree(center);
      }
    }
  }
}
