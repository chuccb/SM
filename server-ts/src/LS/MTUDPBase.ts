/** Native source unit: common/MTUDPBase.cpp (CxLogin.pdb: MTUDPBase.obj). */
import {
  BuildFrame,
  type HOSTHANDLE,
  MTUDP_MAX_PAYLOAD_LENGTH,
  SplitDatagram,
} from "../shared/MTUDP.ts";
import { GetTickCount } from "../core/GetTickCount.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { cHost } from "./cHost.ts";

const ipPortKey = (ip: number, port: number): string => `${ip}:${port}`;

export class MTUDPBase {
  /** Virtual dispatcher wakeup; MTUDPServer supplies the derived hook. */
  protected OnPacketsAvailable(): void {}
  m_nSocket: import("bun").udp.Socket<"buffer"> | null = null; // +20
  m_nBytesRecv = 0; // +40
  m_nBytesSend = 0; // +44
  m_mpHost = new Map<string, cHost>(); // +28 — the (ip, port) host map
  m_nIp = 0; // +48 — the bound address (INADDR_ANY)
  m_nPort = 0; // +52 — the bound port (getsockname)

  /** MTUDPBase::ProcessIncomingData (27821) — find-or-create the cHost and
   *  chain every CRC-valid frame into its in-queue.  A CRC failure discards
   *  the rest of the datagram, exactly like the original. */
  /** PacketLog server tag — snapshotted at construction (single-process mode). */
  m_szLogTag = PacketLog.tag;

  ProcessIncomingData(pSrc: Uint8Array, host: HOSTHANDLE): void {
    if (PacketLog.ShowsClient()) PacketLog.Datagram("recv", pSrc, this.m_szLogTag);
    let pHost = this.m_mpHost.get(ipPortKey(host.ip, host.port));
    if (pHost === undefined) {
      const pCreated = this.HostCreate(host.ip, host.port);
      if (pCreated === null) {
        console.error("HostCreate failed for nonexistent host");
        return;
      }
      pHost = pCreated;
    }
    const frames = SplitDatagram(pSrc, host, "[LS]");
    const tick = GetTickCount();
    for (const frame of frames) {
      pHost.m_queueIn.AddPacket(0, frame.payload, frame.payload.length, tick);
    }
  }

  /** MTUDPBase::HostCreate (27745) */
  HostCreate(ip: number, port: number): cHost | null {
    const host = new cHost(ip, port);
    this.m_mpHost.set(ipPortKey(ip, port), host);
    return host;
  }

  /** MTUDPBase::GetUnreliableData (26966) — pull one record from the hosts
   *  in map order; fills the HOSTHANDLE of the owning host. */
  GetUnreliableData(buf: Uint8Array, maxSize: number): { nLen: number; handle: HOSTHANDLE } | null {
    for (const host of this.m_mpHost.values()) {
      const nLen = host.m_queueIn.GetPacket(buf, maxSize);
      if (nLen !== 0) return { nLen, handle: { ip: host.m_addrIp, port: host.m_nPort } };
    }
    return null;
  }

  /** MTUDPBase::UnreliableSendTo (27157) — [len][payload][crc8] out through
   *  the socket to the registered host. */
  UnreliableSendTo(buf: Uint8Array, len: number, ip: number, port: number): number {
    const pHost = this.m_mpHost.get(ipPortKey(ip, port));
    if (pHost === null || pHost === undefined) {
      console.error(`MTUDPBase::ReliableSendTo - Invalid parameters. ${ip}, ${port}`);
      return 1;
    }
    if (buf !== null && len > MTUDP_MAX_PAYLOAD_LENGTH) {
      console.error("Request to send too long udp packet");
      return 2;
    }
    const frame = BuildFrame(buf.subarray(0, len));
    const fSent = this.m_nSocket!.send(frame, port, u32ToAddress(ip));
    this.m_nBytesSend += frame.length;
    if (PacketLog.ShowsClient()) PacketLog.Datagram("send", frame, this.m_szLogTag);
    if (!fSent) {
      console.error(`MTUDPBase::ResendData() - Sent 0 of ${frame.length} bytes.`);
    }
    pHost.m_nUnreliableSendCount += 1;
    return 0;
  }

  /** MTUDPBase::HostDestroy (27235) */
  HostDestroy(ip: number, port: number): void {
    this.m_mpHost.delete(ipPortKey(ip, port));
  }

  /** MTUDPBase::HostDestroyAll (27267) */
  HostDestroyAll(): void {
    this.m_mpHost.clear();
  }

  /** MTUDPBase::Cleanup (26302) — "MTUDPBase cleaning up." + closesocket +
   *  CThread::Terminate; the MTUDPServer dtor runs HostDestroyAll first. */
  Cleanup(): void {
    console.log("MTUDPBase cleaning up.");
    this.m_nSocket?.close();
    this.m_nSocket = null;
    this.HostDestroyAll();
  }
}

/** u32 → dotted quad (the host-order in_addr the hosts are keyed by). */
function u32ToAddress(v: number): string {
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
}
