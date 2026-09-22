/** Native source unit: CX/CxCenter/LocalServer.cpp. */
import type { CLocalSocket } from "./LocalSocket.ts";
import { MakeLower } from "../core/MakeLower.ts";
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { CM_ReceivedPacket, MC_ReceivedPacket, SVRCLASS_SHOP } from "../core/protocol/CenterProtocol.ts";
import { IpToU32 } from "./NetworkAddress.ts";
import { CUser, type CenterUserContext } from "./User.ts";
import type { CGlobalUserTable } from "./GlobalUserTable.ts";

/** Narrow port-side service view used in place of native singletons. */
export interface LocalServerHost extends CenterUserContext {
  readonly globalUserTable: CGlobalUserTable;
  GetSmallLoadedSvrIdx(nServerClass: number): number;
  OnAdminNotifyMsg(n: CReceivedPacket): void;
  OnSystemMsg(n: CReceivedPacket): void;
  OnSystemCmd(n: CReceivedPacket): void;
  SendPacketServerType(nServerClass: number, packet: CSendPacket): void;
  GetGameDomain(): number;
  GetGameShopAttribute(): number;
}

/** One attached local server (CLocalServer, 100 bytes, on the center side). */
export class CLocalServer {
  m_strName: string;
  nServerClass: number; // +20 (the class byte, Init's 3rd arg)
  nSvrIdx: number; // +16 (the table slot, Init's 2nd arg)
  strIP: string;
  nPort: number;
  m_nMaxUser = 0; // +28 : cfg FXGSMaxUser (CM 3's E4 field)
  nType = 0; // +32 : cfg FXGSType
  nCommunity = 0; // +96 low byte : cfg FXGSCommunity
  nFXAttrShopFlag = 0; // +97 bit0 : set when cfg FXAttrShop != 0 (CGameServer::Init 4061BA)
  nEnterableType = 0; // +98 : cfg FXGSEnterableType
  nConnNo = 0; // +48 : connected user count (IncConn / DecConn)
  socket: CLocalSocket | null = null; // +52

  constructor(strName: string, nServerClass: number, nSvrIdx: number, strIP: string, nPort: number) {
    this.m_strName = strName;
    this.nServerClass = nServerClass;
    this.nSvrIdx = nSvrIdx;
    this.strIP = strIP;
    this.nPort = nPort;
  }

  /** CLocalServer::SendInitialAttr — base vtable thunk is a no-op. */
  SendInitialAttr(_center: LocalServerHost): void {}

  /** CLocalServer::OnPacket — opcodes shared by derived server classes. */
  OnPacket(id: number, n: CReceivedPacket, center: LocalServerHost): void {
    switch (id) {
      case MC_ReceivedPacket.OnDeleteUser:
        this.OnDeleteUser(n, center);
        return;
      case MC_ReceivedPacket.OnReqConnectToSvr:
        this.OnReqConnectToSvr(n, center);
        return;
      case MC_ReceivedPacket.OnConnEstablished:
        this.OnConnEstablished(n, center);
        return;
    }
  }

  /** CLocalServer::OnDeleteUser (center side). */
  OnDeleteUser(n: CReceivedPacket, center: LocalServerHost): void {
    const serial = n.Decode4();
    const u = center.globalUserTable.serialTable.get(serial);
    if (!u) {
      console.error(`[Center] Try to delete nonresident user[${this.nServerClass}:${this.nSvrIdx}:${serial}]`);
      return;
    }
    // CUser::SetFree only when the user really sits on this server (+60/+64)
    if (u.nChannel === this.nServerClass && u.nSvrIdx === this.nSvrIdx) {
      u.SetFree(center);
    }
    if (u.fFree !== 0) center.globalUserTable.ExtractUser(serial);
  }

  /** CLocalServer::OnReqConnectToSvr (center side). */
  OnReqConnectToSvr(n: CReceivedPacket, center: LocalServerHost): void {
    const count = n.Decode1();
    const serials: number[] = [];
    for (let i = 0; i < count; i++) serials.push(n.Decode4());
    const serverType = n.Decode1();
    let smallLoadedSvrIdx = n.Decode4();
    if (serverType === SVRCLASS_SHOP) smallLoadedSvrIdx = center.GetSmallLoadedSvrIdx(SVRCLASS_SHOP);
    let result = 0;
    const users: (CUser | undefined)[] = serials.map((s) => center.globalUserTable.serialTable.get(s));
    if (users.every((u): u is CUser => u !== undefined)) {
      // 004097B0: resolve all serials first, then check residency in order.
      // Preserve earlier checks' side effects if a later residency check fails.
      for (const user of users) {
        if (user.nSvrIdx !== this.nSvrIdx) {
          result = 0;
          break;
        }
        // Native keeps the LAST result, even if an earlier check refused.
        result = user.CheckConnectingToSvr(center, serverType, smallLoadedSvrIdx);
      }
      if (result === 1) for (const user of users) user.SetConnectingToSvr(serverType, smallLoadedSvrIdx, center);
    }
    const packet = new CSendPacket(CM_ReceivedPacket.OnCenterResConnectToSvr);
    packet.Encode1(count);
    for (const s of serials) packet.Encode4(s);
    packet.Encode1(result);
    if (result === 1) {
      packet.Encode1(serverType);
      packet.Encode4(smallLoadedSvrIdx);
      const target = center.GetSvr(serverType, smallLoadedSvrIdx);
      if (target && target.socket) {
        packet.Encode4(IpToU32(target.strIP));
        packet.Encode2(target.nPort);
      } else {
        packet.Encode4(0);
        packet.Encode2(0);
      }
    }
    this.socket?.SendPacket(packet);
  }

  /**
   * CLocalServer::OnConnEstablished (center side) — class dependent.  The
   * generic servers (CxCenter.exe.c:10365) decode
   * [E1 n][n×(EStr, E4 serial)] and answer [E1 n][n×(E4 serial, E1 auth)][E1
   * result]; the shop class (CShopServer::OnConnEstablished 00414B80) reads one
   * extra E4 per user inbound — the shop's CUser::GetSID (+3108, always -1) —
   * matches it against the SID the login server registered (MC 0's per-user E4,
   * stored at CUser+80; SID==1 skips the match) and answers an extra E1 per
   * user: the 0/1 match flag (FXSS's billingFlags — it triggers
   * RequestRemainCashTw and rides inside client 18).
   */
  OnConnEstablished(n: CReceivedPacket, center: LocalServerHost): void {
    const count = n.Decode1();
    const names: string[] = [];
    const serials: number[] = [];
    const sids: number[] = [];
    const fShop = this.nServerClass === SVRCLASS_SHOP;
    for (let i = 0; i < count; i++) {
      names.push(n.DecodeStr());
      serials.push(n.Decode4());
      if (fShop) sids.push(n.Decode4());
    }
    let result = 0;
    // CLocalServer::OnConnEstablished (CxCenter.exe.c:10365) looks the user up
    // BY SERIAL in CGlobalUserTable and matches the name with _mbsicmp —
    // case-insensitively; a serial miss or an already-connected user skips
    // the match and the reply carries result 0.
    const users: (CUser | undefined)[] = serials.map((sn, i) => {
      const u = center.globalUserTable.serialTable.get(sn >>> 0);
      return u !== undefined && MakeLower(u.m_strName) === MakeLower(names[i]!) ? u : undefined;
    });
    // the per-user match flags (CShopServer::OnConnEstablished's entry[2])
    const flags: number[] = users.map(() => 0);
    if (fShop) {
      for (let i = 0; i < count; i++) {
        const u = users[i];
        if (u !== undefined && sids[i] !== 1 && sids[i] === u.nSID) flags[i] = 1;
      }
    }
    // the name/serial match above stands in for the original's per-user
    // _mbsicmp gate; CheckConnectionEstablished is the real class/idx gate
    if (users.every((u) => u !== undefined)) {
      result = 1;
      for (const u of users) {
        if (u!.CheckConnectionEstablished(this.nServerClass, this.nSvrIdx) === 0) {
          result = 0;
          break;
        }
      }
      if (result === 1) for (const u of users) u!.SetConnectionEstablished();
    } else {
      result = 0;
    }
    // CxCenter.exe.c:10454 / CShopServer::OnConnEstablished —
    // [E1 n][n×(E4 serial, E1 authencode(, E1 inbound flag))][E1 flag]
    const packet = new CSendPacket(CM_ReceivedPacket.OnCenterResConnEstablished);
    packet.Encode1(count);
    for (let i = 0; i < count; i++) {
      packet.Encode4(serials[i]!);
      packet.Encode1(users[i]?.GetAuthencode() ?? 0);
      if (fShop) packet.Encode1(flags[i]!);
    }
    packet.Encode1(result);
    this.socket?.SendPacket(packet);
  }

}
