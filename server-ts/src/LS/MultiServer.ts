/** Native source unit: common/MultiServer.cpp (CxLogin.pdb: MultiServer1.obj).
 *
 * CMultiServer (CxLogin.exe.c) — the login server list provider.
 *
 * Init reads three ConfigDB tables:
 *   CAMultiSvr  → m_vtMultiServer  (_MULTISERVER, 36B: SN, strName, strIp, dwParam, dwCurrent)
 *   CALoginSvr  → m_vtLoginServer  (_LOGINSERVER, 24B: SN, strIp, nPort, nFlag)
 *   CAString(type 0/1) → m_vtNotice (_MULTISERVERNOTICE, 32B: sn, nType, strValue, strAttr)
 *
 * It then pre-builds the four cached AskMultiServer response packets
 * (CMultiServer::GetInfoPacket returns this + 76 + 48*hashMismatch +
 * 24*versionMismatch):
 *
 *   P(0,0) = P(0,1) = [E1 0][E1 0]                       (both sections current)
 *   P(1,0) = [E1 1][EOS(info)][E1 0]                     (info changed)
 *   P(1,1) = [E1 1][EOS(info)][E1 1][EOS(notice)]        (both changed)
 *
 * The client recomputes both adler32 hashes from the embedded streams; the
 * server keeps its own copies for the comparison in CLoginPool::OnAskMultiServer.
 *
 * info stream   = E1 mCnt, mCnt×(EStr name, EStr ip, E4 param), E2 lCnt,
 *                 lCnt×(E4 inet_addr(ip), E2 port, E1 flag), E1 m_nCurrentServer
 * notice stream = E1 nCnt, nCnt×(E1 type, EStr value, EStr strAttr)
 */
import type { CDBMan } from "../db/DBMan.ts";
import { COSmartStream } from "../core/SmartStream.ts";
import { CSendPacket } from "../core/Packet.ts";
import { S2C_LoginResponsePacket } from "../core/protocol/PacketIDs.ts";
import type { _LOGINSERVER, _MULTISERVER, _MULTISERVERNOTICE } from "./Recordsets.ts";

export function inet_addr(cp: string): number {
  // the Windows inet_addr: the dotted octets packed in NETWORK byte order —
  // on little-endian x86 the returned u32 VALUE is (b3<<24)|(b2<<16)|(b1<<8)|b0,
  // so the stream's little-endian Encode4 puts the octets on the wire in their
  // written order (the original server's AskMultiServer stream carries
  // 127.0.0.1 as 7F 00 00 01).
  const parts = cp.split(".").map((x) => Number.parseInt(x, 10) & 0xff);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return 0;
  return ((parts[3]! << 24) | (parts[2]! << 16) | (parts[1]! << 8) | parts[0]!) >>> 0;
}

export class CMultiServer {
  m_vtMultiServer: _MULTISERVER[] = [];
  m_vtLoginServer: _LOGINSERVER[] = [];
  m_vtNotice: _MULTISERVERNOTICE[] = [];
  m_nCurrentServer = 0;
  m_nHashValue = 0; // adler32(info stream)
  m_nVersion = 0; // adler32(notice stream)
  /** the four pre-built packets, indexed [hashMismatch][versionMismatch] */
  m_packet: [CSendPacket[], CSendPacket[]] = [[], []];

  /** CMultiServer::Init — the three recordsets report their own open
   *  failure lines and the init aborts (CxLogin.exe.c:30142/:30134/:29996 —
   *  the "mutlserver" typo is the original's). */
  Init(db: CDBMan): void {
    let rowsMulti: ReturnType<CDBMan["GetMultiServers"]>;
    try {
      rowsMulti = db.GetMultiServers();
    } catch {
      console.error("Fail to open MultiServer recordset");
      throw new Error("MultiServer init failed"); // the original returns 0 and the app aborts
    }
    this.m_vtMultiServer = rowsMulti.map((r) => ({
      SN: r.SN,
      strName: r.Name,
      strIp: r.IP,
      dwParam: r.Param,
      dwCurrent: r.Current,
    }));
    for (const m of this.m_vtMultiServer) if (m.dwCurrent !== 0) this.m_nCurrentServer = m.SN;

    let rowsLogin: ReturnType<CDBMan["GetLoginServers"]>;
    try {
      rowsLogin = db.GetLoginServers();
    } catch {
      console.error("Fail to open LoginServer recordset");
      throw new Error("MultiServer init failed");
    }
    this.m_vtLoginServer = rowsLogin.map((r) => ({
      SN: r.SN,
      strIp: r.IP,
      nPort: r.Port,
      nFlag: r.Flag,
    }));

    let rowsNotice: ReturnType<CDBMan["GetMultiServerNotices"]>;
    try {
      rowsNotice = db.GetMultiServerNotices();
    } catch {
      console.error("Fail to open mutlserver-notice recordset");
      throw new Error("MultiServer init failed");
    }
    this.m_vtNotice = rowsNotice.map((r) => ({
      sn: r.sn,
      nType: r.type,
      strValue: r.value,
      strAttr: r.strAttr,
    }));

    this.MakeInfoPackets();
    console.log(
      `MultiServer: m(${this.m_vtMultiServer.length}) l(${this.m_vtLoginServer.length}) d(${this.m_nCurrentServer}) hash(0x${this.m_nHashValue.toString(16).toUpperCase()})`,
    );
  }

  /** The stream/packet construction of CMultiServer::Init's tail. */
  private MakeInfoPackets(): void {
    const info = new COSmartStream();
    info.Encode1(this.m_vtMultiServer.length);
    for (const m of this.m_vtMultiServer) {
      info.EncodeStr(m.strName);
      info.EncodeStr(m.strIp);
      info.Encode4(m.dwParam);
    }
    info.Encode2(this.m_vtLoginServer.length);
    for (const l of this.m_vtLoginServer) {
      info.Encode4(inet_addr(l.strIp));
      info.Encode2(l.nPort);
      info.Encode1(l.nFlag);
    }
    info.Encode1(this.m_nCurrentServer & 0xff);
    this.m_nHashValue = info.GetHashValue();

    const notice = new COSmartStream();
    notice.Encode1(this.m_vtNotice.length);
    for (const n of this.m_vtNotice) {
      notice.Encode1(n.nType);
      notice.EncodeStr(n.strValue);
      notice.EncodeStr(n.strAttr);
    }
    this.m_nVersion = notice.GetHashValue();

    // P(0,0) / P(0,1): both sections current.
    for (const vm of [0, 1]) {
      const p = new CSendPacket(S2C_LoginResponsePacket.OnAskMultiServerRes) // InitPacket(1) — the degree-2 (type) overload;
      p.Encode1(0);
      p.Encode1(0);
      this.m_packet[0][vm] = p;
    }
    // P(1,0): info changed.
    {
      const p = new CSendPacket(S2C_LoginResponsePacket.OnAskMultiServerRes) // InitPacket(1) — the degree-2 (type) overload;
      p.Encode1(1);
      p.EncodeOSStream(info);
      p.Encode1(0);
      this.m_packet[1][0] = p;
    }
    // P(1,1): both changed.
    {
      const p = new CSendPacket(S2C_LoginResponsePacket.OnAskMultiServerRes) // InitPacket(1) — the degree-2 (type) overload;
      p.Encode1(1);
      p.EncodeOSStream(info);
      p.Encode1(1);
      p.EncodeOSStream(notice);
      this.m_packet[1][1] = p;
    }
  }

  /** CMultiServer::GetInfoPacket — this + 76 + 48*hashMismatch + 24*versionMismatch. */
  GetInfoPacket(fHashMismatch: number, fVersionMismatch: number): CSendPacket {
    return this.m_packet[fHashMismatch ? 1 : 0][fVersionMismatch ? 1 : 0];
  }

  /** CMultiServer::GetHashValue */
  GetHashValue(): number {
    return this.m_nHashValue;
  }
}
