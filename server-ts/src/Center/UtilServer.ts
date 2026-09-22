/**
 * Port-only module boundary for the native CUtilServer class.
 * CxCenter.map has no UtilServer.obj entry; the class is nevertheless present
 * in the executable and is kept separate here for readable imports.
 */
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { CM_ReceivedPacket, MC_ReceivedPacket } from "../protocol/CenterProtocol.ts";
import { CLocalServer, type LocalServerHost } from "./LocalServer.ts";

export class CUtilServer extends CLocalServer {
  override SendInitialAttr(center: LocalServerHost): void {
    const packet = new CSendPacket(CM_ReceivedPacket.OnInitialSvrAttr);
    packet.Encode1(center.GetGameDomain());
    packet.Encode1(0);
    this.socket?.SendPacket(packet);
  }

  override OnPacket(id: number, n: CReceivedPacket, center: LocalServerHost): void {
    switch (id) {
      case MC_ReceivedPacket.OnDeleteUser:
        CUtilServer.prototype.OnDeleteUser.call(this, n, center);
        return;
      case MC_ReceivedPacket.OnAdminNotifyMsg:
        center.OnAdminNotifyMsg(n);
        return;
      case MC_ReceivedPacket.OnAdminNotifyGameServerMsg:
        CUtilServer.prototype.OnAdminNotifyGameServerMsg.call(this, n, center);
        return;
      case MC_ReceivedPacket.OnRequestUserChannel:
        CUtilServer.prototype.OnRequestUserChannel.call(this, n, center);
        return;
      case MC_ReceivedPacket.OnSystemMsg:
        center.OnSystemMsg(n);
        return;
      case MC_ReceivedPacket.OnSystemCmd:
        center.OnSystemCmd(n);
        return;
      default:
        super.OnPacket(id, n, center);
    }
  }

  /**
   * CUtilServer::OnRequestUserChannel (CxCenter.exe.c:21654) — MC 7 from the
   * util: [E4 serial][EStr account] → CM 10 [E4 serial][EStr account]
   * [E1 the user's server class][E4 sessionIdx] (zeros on a miss).
   */
  OnRequestUserChannel(n: CReceivedPacket, center: LocalServerHost): void {
    const serial = n.Decode4();
    const account = n.DecodeStr();
    const user = center.globalUserTable.userTable.get(account);
    const packet = new CSendPacket(CM_ReceivedPacket.OnUserChannelResult);
    packet.Encode4(serial);
    packet.EncodeStr(account);
    if (user) {
      packet.Encode1(user.nChannel);
      packet.Encode4(user.nSessionIdx);
    } else {
      packet.Encode1(0);
      packet.Encode4(0);
    }
    this.socket?.SendPacket(packet);
  }

  /**
   * CUtilServer::OnDeleteUser (CxCenter.exe.c:21690) — [EStr name]; the CM 11
   * [E4 SN] goes to the server the user sits on, then the user is freed.
   */
  override OnDeleteUser(n: CReceivedPacket, center: LocalServerHost): void {
    const name = n.DecodeStr();
    const u = center.globalUserTable.userTable.get(name);
    if (!u) {
      console.error(`[Center] Try to delete nonresident user[${this.nServerClass}:${this.nSvrIdx}:${name}]`);
      return;
    }
    const target = center.GetSvr(u.nChannel, u.nSvrIdx);
    const packet = new CSendPacket(CM_ReceivedPacket.OnDeleteUser);
    packet.Encode4(u.nSID);
    target?.socket?.SendPacket(packet);
    // no residency check here (unlike the serial-keyed base handler) — the
    // util's delete means "kick the user from the world"
    u.SetFree(center);
    center.globalUserTable.ExtractUser(u.nSID);
    console.log(`[Center] Delete user by utilserver\`s rerquest[${name}].`);
  }

  /**
   * CUtilServer::OnAdminNotifyGameServerMsg (CxCenter.exe.c:21737) —
   * [E1 type][EStr] → CLocalServerMan::OnAdminNotifyGameServerMsg: CM 8
   * [EStr] to every server of that class (SendPacketServerType).
   */
  OnAdminNotifyGameServerMsg(n: CReceivedPacket, center: LocalServerHost): void {
    const type = n.Decode1();
    const str = n.DecodeStr();
    const packet = new CSendPacket(CM_ReceivedPacket.OnAdminNotifyMsg);
    packet.EncodeStr(str);
    center.SendPacketServerType(type, packet);
  }
}
