/** Native source unit: CX/CxUtil/MainPool.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { MC_UtilServerSendPacket } from "../core/protocol/CenterProtocol.ts";
import { C2S_UtilPacket, S2C_UtilPacket } from "../core/protocol/PacketIDs.ts";
import { CUserPool } from "./UserPool.ts";
import { CUser } from "./User.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { RegisterUtilMainPool } from "./runtime/MainPoolRuntime.ts";

/** CMainPool — the tool pool and the whole client-side dispatch. */
export class CMainPool extends CUserPool {
  private static m_pInstance: CMainPool | null = null;

  static get ms_pInstance(): CMainPool | null {
    return CMainPool.m_pInstance;
  }

  static set ms_pInstance(pool: CMainPool | null) {
    CMainPool.m_pInstance = pool;
    RegisterUtilMainPool(pool, CMainPool.SendUserDetailInfo);
  }

  /** CMainPool::OnPacket (CxUtil.exe.c:21528) — the relay dispatch. */
  override OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    switch (n.Decode1()) {
      case C2S_UtilPacket.OnConnEstablished:
        this.OnConnEstablished(n, socket);
        break;
      case C2S_UtilPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n, socket);
        break;
      case C2S_UtilPacket.OnAdminNotifyGameServerMsg:
        this.OnAdminNotifyGameServerMsg(n, socket);
        break;
      case C2S_UtilPacket.OnSystemMsg:
        this.OnSystemMsg(n, socket);
        break;
      case C2S_UtilPacket.OnKickoffUser:
        this.OnKickoffUser(n, socket);
        break;
      case C2S_UtilPacket.OnReqUserInfo:
        this.OnReqUserInfo(n, socket);
        break;
      case C2S_UtilPacket.OnUpdateItem:
        this.OnUpdateItem(n, socket);
        break;
      default:
        n.m_uOffset = 0;
        super.OnPacket(n, socket);
        break;
    }
  }

  /**
   * CMainPool::OnConnEstablished (packet 7) — the tool login:
   * [E1 n][n × (EStr name, E4 serial)]; any duplicate name rolls back the
   * whole batch and disconnects (the lst: SetGlobalSerialNo is the mov to
   * +276 between the two decodes).
   */
  OnConnEstablished(n: CReceivedPacket, User: CClientSocket): void {
    const nCount = n.Decode1();
    User.AddNewUsers(nCount);
    this.AddNewSocket(User); // the result gates nothing at the call site
    let i = 0;
    for (; i < nCount; i++) {
      const u = User.GetUser(i)!;
      const name = n.DecodeStr();
      const serial = n.Decode4();
      u.SetName(name);
      u.SetGlobalSerialNo(serial);
      if (CLocalUserTable.ms_pInstance?.Insert(u) === 0) break;
    }
    if (i < nCount) {
      // rollback the batch, then drop the connection
      for (let j = 0; j < i; j++) CLocalUserTable.ms_pInstance?.Remove(User.GetUser(j)!);
      User.PostClosePacket();
    }
  }

  /** CMainPool::OnAdminNotifyMsg (25) — CSendPacket(4) [EStr] to the center. */
  OnAdminNotifyMsg(n: CReceivedPacket, _a3: CClientSocket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_UtilServerSendPacket.OnAdminNotifyMsg, CipherDegree.kPacketRaw);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnAdminNotifyGameServerMsg (26) — CSendPacket(5) [E1][EStr]. */
  OnAdminNotifyGameServerMsg(n: CReceivedPacket, _a3: CClientSocket): void {
    const b = n.Decode1();
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_UtilServerSendPacket.OnAdminNotifyGameServerMsg, CipherDegree.kPacketRaw);
    packet.Encode1(b);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnSystemMsg (31) — CSendPacket(10) [EStr] to the center. */
  OnSystemMsg(n: CReceivedPacket, _a3: CClientSocket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_UtilServerSendPacket.OnSystemMsg, CipherDegree.kPacketRaw);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnKickoffUser (32) — CSendPacket(1) [EStr name] to the center. */
  OnKickoffUser(n: CReceivedPacket, _a3: CClientSocket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_UtilServerSendPacket.OnDeleteUser, CipherDegree.kPacketRaw);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnReqUserInfo (64) — CSendPacket(7) [E4 serial][EStr account]. */
  OnReqUserInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_UtilServerSendPacket.OnRequestUserChannel, CipherDegree.kPacketRaw);
    const User = socket.GetUser(0);
    console.error("OnReqUserInfo called");
    packet.Encode4(User ? User.m_dwGlobalSerialNo : 0);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnUpdateItem (66) — CSendPacket(11) [EStr] ("UpdateFxItem"). */
  OnUpdateItem(n: CReceivedPacket, _a3: CClientSocket): void {
    const packet = new CSendPacket(MC_UtilServerSendPacket.OnSystemCmd, CipherDegree.kPacketRaw);
    let str = "";
    if (n.Decode1() === MC_UtilServerSendPacket.OnSystemCmd) str = "UpdateFxItem";
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /**
   * CMainPool::SendUserDetailInfo (static) — the CM 10 answer as packet 64
   * [E1 userType][E4 sessionIdx] to the tool that owns the serial.
   */
  static SendUserDetailInfo(User: CUser, _p_str: string, userType: number, sessionIdx: number): void {
    const socket = User.GetSocket();
    if (!socket.m_bConnected) return;
    const packet = new CSendPacket(S2C_UtilPacket.OnUserDetailInfo);
    packet.Encode1(userType);
    packet.Encode4(sessionIdx);
    socket.SendPacket(packet);
  }
}
