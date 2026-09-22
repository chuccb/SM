/** Native source unit: CX/CxCenter/ShopServer.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { CM_ReceivedPacket, MC_ReceivedPacket } from "../core/protocol/CenterProtocol.ts";
import { CLocalServer, type LocalServerHost } from "./LocalServer.ts";

export class CShopServer extends CLocalServer {
  override SendInitialAttr(center: LocalServerHost): void {
    const packet = new CSendPacket(CM_ReceivedPacket.OnInitialSvrAttr, CipherDegree.kPacketRaw);
    packet.Encode1(center.GetGameDomain());
    packet.Encode1(0);
    this.socket?.SendPacket(packet);
  }

  override OnPacket(id: number, n: CReceivedPacket, center: LocalServerHost): void {
    switch (id) {
      case MC_ReceivedPacket.OnAdminNotifyMsg:
        center.OnAdminNotifyMsg(n);
        return;
      case MC_ReceivedPacket.OnRequestUserChannel:
        CShopServer.prototype.OnRequestUserChannel.call(this, n, center);
        return;
      case MC_ReceivedPacket.OnSetAuthenCode:
        CShopServer.prototype.OnSetAuthenCode.call(this, n, center);
        return;
      default:
        super.OnPacket(id, n, center);
    }
  }

  /**
   * CGameServer::OnRequestUserChannel (CxCenter.exe.c:6508) — MC 7 from a GS:
   * [E1 type][E4 gSN][EStr name] → CM 10 [E1 type][E4 gSN][EStr name]
   * [E1 the user's current server class][E4 sessionIdx].
   */
  OnRequestUserChannel(n: CReceivedPacket, center: LocalServerHost): void {
    const type = n.Decode1();
    const gSN = n.Decode4();
    const name = n.DecodeStr();
    const user = center.globalUserTable.userTable.get(name);
    const packet = new CSendPacket(CM_ReceivedPacket.OnUserChannelResult, CipherDegree.kPacketRaw);
    packet.Encode1(type);
    packet.Encode4(gSN);
    packet.EncodeStr(name);
    if (user) {
      packet.Encode1(user.nChannel);
      packet.Encode4(user.nSessionIdx);
    } else {
      packet.Encode1(0);
      packet.Encode4(0);
    }
    this.socket?.SendPacket(packet);
  }

  /** CShopServer::OnSetAuthenCode (MC 9): [E4 global serial][E1 code]. */
  OnSetAuthenCode(n: CReceivedPacket, center: LocalServerHost): void {
    const user = center.globalUserTable.serialTable.get(n.Decode4());
    const code = n.Decode1();
    user?.SetAuthenCode(code);
  }
}
