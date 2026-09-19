/**
 * MTUDPServer / CUDPPacketDispatcher — the login server's unreliable UDP
 * transport (CxLogin.exe.c:22580-22700 and 26148-28158).
 *
 * Boot order (CxLogin.exe.c:16086-16104): MTUDPServer ctor (MTUDPBase(1)) →
 * vtbl+20 = MTUDPServer::Startup → StartupBase(0) → CUDPPacketDispatcher
 * ctor + Resume → CListenThread.  StartupBase binds INADDR_ANY on
 * GetNumAttribute("ServerPort") + MTUDP_UDP_PORT_OFFSET, sets FIONBIO and
 * SO_RCVBUF 4096, stores the bound address and resumes the receive thread;
 * the thread (MTUDPServer::Proc) select/recvfrom-loops into
 * MTUDPBase::ProcessIncomingData, which finds-or-creates the cHost for the
 * peer address and chains every validated frame payload into the host's
 * cUnreliableQueueIn.  The dispatcher thread (CUDPPacketDispatcher::Proc)
 * drains MTUDPBase::GetUnreliableData across all hosts and runs
 * OnUDPPacket per frame — whose only payload on the login server is the
 * type-0 'check udp comm' handshake:
 *
 *   client → [E1 0][E4 globalSerialNo]        (payload length 5)
 *   server → [E1 2]                           (payload length 1)
 *
 * The client learns its global serial number from the OnLoginRes packet,
 * probes this port once, and the host is destroyed after every handled
 * datagram — the reply is one UnreliableSendTo and nothing more.
 *
 * The port keeps the original's two-thread shape as: the socket's data
 * event runs ProcessIncomingData (the receive thread), then one
 * CUDPPacketDispatcher::Proc drain (the dispatcher thread) — the same
 * call sequence, without the Sleep(5)/Sleep(10) polling.
 */
import { BuildFrame, HOSTHANDLE, MTUDP_UDP_PORT_OFFSET, SplitDatagram } from "../gameserver/MTUDP.ts";
import { CServerConfig } from "../core/Config.ts";
import { PacketLog } from "../core/PacketLog.ts";
import type { CUser } from "./Login.ts";

/** MTUDPBase::GetUnreliableData's drain buffer size (CUDPPacketDispatcher::Proc). */
const UDP_DRAIN_BUFFER_SIZE = 0x1000;
/** MTUDPServer::StartupBase's SO_RCVBUF (kept for the record; Bun fixes the
 *  socket buffer itself and offers no knob). */
const UDP_RCVBUF_SIZE = 4096;

/** cUnreliableQueueIn (CxLogin.exe.c:26148) — a growable record chain of
 *  [E4 len][payload] entries.  AddPacket drops with a report at the 0x3000
 *  capacity gate (`count + len + 2 <= 0x3000`, verbatim), GetPacket copies
 *  min(maxSize, len) and removes the whole record (the original's
 *  truncation semantics). */
class cUnreliableQueueIn {
  /** the AddPacket capacity gate (CxLogin.exe.c:26195) */
  static readonly CAPACITY = 0x3000;
  /** the longest packet AddPacket accepts (CxLogin.exe.c:26178) */
  static readonly MAX_PACKET = 0xff;

  m_anBuf = new Uint8Array(cUnreliableQueueIn.CAPACITY + 8);
  m_nCount = 0; // +12324: bytes queued
  m_nPacketCount = 0; // +12328: packets queued, ever
  m_dwLastTick = 0; // +12332

  /** cUnreliableQueueIn::AddPacket */
  AddPacket(a2: number, pSrc: Uint8Array, a4: number, a5: number): void {
    if (pSrc === null || a4 === 0 || a4 > cUnreliableQueueIn.MAX_PACKET) return;
    if (this.m_nCount + a4 + 2 > cUnreliableQueueIn.CAPACITY) {
      console.error(`CUnreliableQueueIn::AddPacket - rcv buffer overflow ${a4},${this.m_nCount}`);
      return;
    }
    const len = a4;
    const at = 36 + this.m_nCount;
    for (let k = 0; k < 4; k++) this.m_anBuf[at + k] = (len >>> (24 - 8 * k)) & 0xff; // Encode4 (BE)
    this.m_anBuf.set(pSrc.subarray(0, len), at + 4);
    this.m_nCount += 4 + len;
    this.m_nPacketCount += 1;
    this.m_dwLastTick = a5;
  }

  /** cUnreliableQueueIn::GetPacket — returns the bytes copied (0 = empty). */
  GetPacket(pDes: Uint8Array, a3: number): number {
    if (this.m_nCount === 0) return 0;
    const len =
      ((this.m_anBuf[36]! << 24) | (this.m_anBuf[37]! << 16) | (this.m_anBuf[38]! << 8) | this.m_anBuf[39]!) >>> 0;
    const n = Math.min(a3, len);
    pDes.set(this.m_anBuf.subarray(40, 40 + n), 0);
    const rest = this.m_nCount - len - 4;
    if (rest > 0) this.m_anBuf.copyWithin(36, 40 + len, 40 + len + rest);
    this.m_nCount = rest;
    return n;
  }

  Clear(): void {
    this.m_nCount = 0;
  }
}

/** cHost — MTUDPBase's per-peer record.  The login server only exercises
 *  the unreliable-in queue (+120) and the unreliable-send counter (+12460);
 *  the rest of the original's ~12 KB (net clocks, reliable windows) never
 *  runs on this link. */
class cHost {
  m_addrIp: number; // +4, host byte order (ntohl(sin_addr))
  m_nPort: number; // +8
  m_nUnreliableSendCount = 0; // +12460
  m_queueIn = new cUnreliableQueueIn(); // +120

  constructor(a2: number, a3: number) {
    this.m_addrIp = a2;
    this.m_nPort = a3;
  }
}

const ipPortKey = (ip: number, port: number): string => `${ip}:${port}`;

/** MTUDPServer (CxLogin.exe.c:28080) — MTUDPBase(bAutoDelete=1). */
export class MTUDPServer {
  static ms_pInstance: MTUDPServer | null = null;

  m_nSocket: import("bun").udp.Socket<"buffer"> | null = null; // +20
  m_nBytesRecv = 0; // +40
  m_nBytesSend = 0; // +44
  m_mpHost = new Map<string, cHost>(); // +28 — the (ip, port) host map
  m_nIp = 0; // +48 — the bound address (INADDR_ANY)
  m_nPort = 0; // +52 — the bound port (getsockname)
  m_dispatcher: CUDPPacketDispatcher;

  constructor() {
    MTUDPServer.ms_pInstance = this;
    this.m_dispatcher = new CUDPPacketDispatcher();
  }

  /** MTUDPServer::Startup (vtbl+20) → MTUDPBase::StartupBase(0)
   *  (CxLogin.exe.c:28118): socket(AF_INET, SOCK_DGRAM), bind
   *  INADDR_ANY:GetNumAttribute("ServerPort")+1, FIONBIO, getsockname,
   *  SO_RCVBUF, "MTUDP initialized succefully", CThread::Resume.  On any
   *  failure the original terminates the process (CMainSystem::TerminateProcess). */
  async StartupBase(nAddr = 0): Promise<void> {
    void nAddr; // the bind address; 0 = INADDR_ANY (the original's only caller)
    // (async: Bun's UDP socket opens asynchronously; the original's bind is
    // synchronous — the await preserves the boot ORDER, which is what the
    // original's sequence actually pins down.)
    const nServerPort = CServerConfig.ms_pInstance!.GetNumAttribute("ServerPort");
    const nPort = nServerPort + MTUDP_UDP_PORT_OFFSET;
    this.m_nSocket = await Bun.udpSocket({
      hostname: "0.0.0.0",
      port: nPort,
      socket: {
        data: (_socket, data, port, address) => {
          // MTUDPServer::Proc (27994): recvfrom → ntohl/ntohs →
          // ProcessIncomingData; then the dispatcher drain (CUDPPacketDispatcher::Proc).
          const host: HOSTHANDLE = {
            ip: String(address)
              .split(".")
              .reduce((acc: number, o) => ((acc << 8) | (Number(o) & 0xff)) >>> 0, 0),
            port: Number(port),
          };
          this.ProcessIncomingData(new Uint8Array(data as Buffer), host);
          this.m_dispatcher.Proc();
        },
        error: (_socket, err) => console.error(`MTUDP::ThreadProc() ::select - errorcode:${String(err)}`),
      },
    });
    this.m_nPort = nPort;
    this.m_nIp = 0;
    void UDP_RCVBUF_SIZE;
    console.log("MTUDP initialized succefully");
    console.log("MTUDP listening thread started.");
  }

  /** MTUDPBase::ProcessIncomingData (27821) — find-or-create the cHost and
   *  chain every CRC-valid frame into its in-queue.  A CRC failure discards
   *  the rest of the datagram, exactly like the original. */
  /** PacketLog server tag — snapshotted at construction (single-process mode). */
  m_szLogTag = PacketLog.tag;

  ProcessIncomingData(pSrc: Uint8Array, host: HOSTHANDLE): void {
    if (PacketLog.Enabled()) PacketLog.Datagram("recv", pSrc, this.m_szLogTag);
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
    const tick = Date.now() >>> 0;
    for (const frame of frames) {
      pHost.m_queueIn.AddPacket(0, frame.payload, frame.payload.length, tick);
    }
  }

  /** MTUDPBase::HostCreate (27745) */
  HostCreate(a2: number, a3: number): cHost | null {
    const host = new cHost(a2, a3);
    this.m_mpHost.set(ipPortKey(a2, a3), host);
    return host;
  }

  /** MTUDPBase::GetUnreliableData (26966) — pull one record from the hosts
   *  in map order; fills the HOSTHANDLE of the owning host. */
  GetUnreliableData(a2: Uint8Array, a3: number): { nLen: number; handle: HOSTHANDLE } | null {
    for (const host of this.m_mpHost.values()) {
      const nLen = host.m_queueIn.GetPacket(a2, a3);
      if (nLen !== 0) return { nLen, handle: { ip: host.m_addrIp, port: host.m_nPort } };
    }
    return null;
  }

  /** MTUDPBase::UnreliableSendTo (27157) — [len][payload][crc8] out through
   *  the socket to the registered host. */
  UnreliableSendTo(a2: Uint8Array, a3: number, a4: number, a5: number): number {
    const pHost = this.m_mpHost.get(ipPortKey(a4, a5));
    if (pHost === null || pHost === undefined) {
      console.error(`MTUDPBase::ReliableSendTo - Invalid parameters. ${a4}, ${a5}`);
      return 1;
    }
    if (a2 !== null && a3 + 1 > 0xff) {
      console.error("Request to send too long udp packet");
      return 2;
    }
    const frame = BuildFrame(a2.subarray(0, a3));
    const fSent = this.m_nSocket!.send(frame, a5, u32ToAddress(a4));
    this.m_nBytesSend += frame.length;
    if (PacketLog.Enabled()) PacketLog.Datagram("send", a2.subarray(0, a3), this.m_szLogTag);
    if (!fSent) {
      console.error(`MTUDPBase::ResendData() - Sent 0 of ${frame.length} bytes.`);
    }
    pHost.m_nUnreliableSendCount += 1;
    return 0;
  }

  /** MTUDPBase::HostDestroy (27235) */
  HostDestroy(a2: number, a3: number): void {
    this.m_mpHost.delete(ipPortKey(a2, a3));
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

/** CUDPPacketDispatcher (CxLogin.exe.c:22580) — the drain thread. */
export class CUDPPacketDispatcher {
  static ms_pInstance: CUDPPacketDispatcher | null = null;

  constructor() {
    CUDPPacketDispatcher.ms_pInstance = this;
  }

  /** CUDPPacketDispatcher::Proc (22655) — drain every queued record. */
  Proc(): void {
    const pServer = MTUDPServer.ms_pInstance!;
    const pBuf = new Uint8Array(UDP_DRAIN_BUFFER_SIZE);
    let got = pServer.GetUnreliableData(pBuf, UDP_DRAIN_BUFFER_SIZE);
    while (got !== null) {
      this.OnUDPPacket(pBuf.subarray(0, got.nLen), got.handle);
      got = pServer.GetUnreliableData(pBuf, UDP_DRAIN_BUFFER_SIZE);
    }
  }

  /** CUDPPacketDispatcher::OnUDPPacket (22617) — the login server's only
   *  UDP payload: the type-0 'check udp comm' handshake. */
  OnUDPPacket(a2: Uint8Array, a3: HOSTHANDLE): void {
    if (a2[0] !== 0) return; // CReceivedPacketBase::Decode1(a2)
    const pServer = MTUDPServer.ms_pInstance!;
    if (a2.length !== 5) {
      pServer.HostDestroy(a3.ip, a3.port);
      return;
    }
    const v3 = ((a2[1]! << 24) | (a2[2]! << 16) | (a2[3]! << 8) | a2[4]!) >>> 0; // Decode4 (BE)
    const v5 = FindUserFromGlobalSerialNo(v3);
    if (v5 === null) {
      pServer.HostDestroy(a3.ip, a3.port);
      return;
    }
    if (v5.GetGlobalSerialNo() === 0) {
      console.error(`Unauthenticated user try to send 'check udp comm' packet(${v5.GetName()})`);
      v5.socket.Close(); // the user's CSocket, vtbl+72(0)
      pServer.HostDestroy(a3.ip, a3.port);
      return;
    }
    pServer.UnreliableSendTo(Uint8Array.of(2), 1, a3.ip, a3.port);
    pServer.HostDestroy(a3.ip, a3.port);
  }
}

/** CLocalUserTable::FindUserFromGlobalSerialNo — resolved through the login
 *  pool's table (the original reaches TSingleton<CLocalUserTable>).  Wired
 *  by Login.ts at startup to keep the import cycle one-way. */
export let FindUserFromGlobalSerialNo: (sn: number) => CUser | null = () => null;
export function SetLocalUserTableFinder(fn: (sn: number) => CUser | null): void {
  FindUserFromGlobalSerialNo = fn;
}
