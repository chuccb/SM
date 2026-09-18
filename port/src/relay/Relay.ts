/**
 * CxRelay — the UDP relay server (Relay/CXRELAY.EXE, Relay_000.cfg).
 *
 * The relay is the classic MTUDP library (Lewis Sellars) plus a forwarder:
 * clients and game servers address each other with 32-bit serial numbers
 * through it.  One wire datagram holds concatenated MTUDP frames
 *
 *   [u8 totalLen][E4 srcSn][E4 dstSn][body totalLen-9][u8 crc8]
 *
 * (crc8 over [totalLen][payload], the stored byte makes the running CRC 0).
 * The relay registers the srcSn → (addr) mapping on the first frame of every
 * datagram — moving clients are re-homed ("Different address..") — strips the
 * 9-byte addressing prefix and queues `body` for the dstSn; the dispatcher
 * thread then sends it to the peer as a fresh
 *
 *   [u8 totalLen][body][u8 crc8]
 *
 * frame.  Unknown senders are created on the spot; unknown targets just
 * bump the sender's miss counter (every 200th miss is logged).  A 120 s
 * sweeper drops hosts idle for more than 60 s.
 *
 * The original runs MTUDPServer / CUDPPacketDispatcher / CTimerThread as
 * threads around a 4 MB staging buffer and a Win32 dialog for the logs; here
 * the socket callbacks and three timers give the identical wire behaviour.
 * Report/ReportError strings are kept verbatim.
 */
import { CServerConfig } from "../core/Config.ts";
import { UpdateCRC8 } from "../gameserver/MTUDP.ts";

/** HOSTHANDLEEX — the MTUDPServer host table value (32 bytes in the original). */
export interface HOSTHANDLEEX {
  ip: number; // [0] host byte order address
  port: number; // [1] host byte order port
  sn: number; // [2] the MTUDP serial number (the map key)
  lastRecv: number; // [3] TickCount of the last received frame
  recv: number; // [4] frames received
  miss: number; // [5] frames whose target was unknown
  send: number; // [6] frames forwarded out
  createdLog: number; // [7] TickCount at create (the sweep log's age)
}

/** The 120 s sweeper period (MTUDPServer::Proc). */
const HOST_SWEEP_PERIOD = 0x1d4c0; // 120000 ms
/** A host idle longer than this is erased. */
const HOST_IDLE = 0xea60; // 60000 ms
/** The recvfrom buffer (MTUDPServer::Proc). */
const RECV_BUF_SIZE = 4096;
/** The dispatcher staging budget (CUDPPacketDispatcher::AddPacket). */
const DISPATCH_BUFFER_MAX = 0x3e8000; // 4096000 bytes
/** CUDPPacketDispatcher::Proc — "OffsetData" heartbeat stride. */
const DISPATCH_REPORT_STRIDE = 0x1388; // 5000
/** One MTUDP frame may carry at most 255 bytes (totalLen + crc). */
const MAX_FRAME_SIZE = 0xff;
/** CTimerThread::Proc tick, and the date-log stride (OnTimer). */
const TIMER_TICK = 0x190; // 400 ms
const TIMER_DATE_STRIDE = 750; // 750 × 400 ms = 5 min
/** MTUDPServer::Proc — the select sleep when no datagram is pending. */
const IDLE_SLEEP = 0xa; // 10 ms

const WEEK_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** CMainWindow::AddMessage — the dialog log; the port prints to the console. */
function Report(msg: string): void {
  console.log(`[Relay] ${msg}`);
}

/** ReportError. */
function ReportError(msg: string): void {
  console.error(`[Relay] ${msg}`);
}

/**
 * MTUDPServer — the listening socket, the sn → host table and the forward
 * queue feeding CUDPPacketDispatcher (FxServer.lst 402A20..403130).
 */
export class MTUDPServer {
  /** TSingleton<MTUDPServer>::ms_pInstance */
  static ms_pInstance: MTUDPServer | null = null;

  m_hSocket: IUDPSocket | null = null; // +20
  m_dwAddr = 0; // +48 (getsockname, host byte order)
  m_wPort = 0; // +52 (getsockname)
  m_dwBytesSend = 0; // +44 (UnreliableSendToUnRegisteredHost)
  m_mapHost = new Map<number, HOSTHANDLEEX>(); // +88 map<unsigned int, HOSTHANDLEEX>
  m_dwHostCounter = 0; // the shared "missed" log counter (dword_45D45C)
  m_dwTotalConn = 0; // CMainWindow::UpdateTotalConn's value
  m_dwLastSweep = 0; // the 120 s mark (Proc's Time)
  m_fTerminated = 0; // +4 (the thread stop flag)
  m_dwDispatchOffset = 0; // the dispatcher's staging offset (+1024005 dwords)
  m_rgDispatch: { ip: number; port: number; data: Uint8Array }[] = []; // the +20 staging buffer

  /** MTUDPServer::StartupBase(0) — bind INADDR_ANY:ServerPort. */
  async Startup(cfg: CServerConfig): Promise<void> {
    const port = cfg.GetNumAttribute("ServerPort");
    const socket = (await Bun.udpSocket({
      hostname: "0.0.0.0",
      port,
      socket: {
        data: (_socket, data, fromPort, fromAddr) => {
          this.OnDatagram(_socket, new Uint8Array(data as Buffer), fromPort, String(fromAddr));
        },
      },
    })) as unknown as IUDPSocket;
    this.m_hSocket = socket;
    this.m_dwAddr = 0; // INADDR_ANY
    this.m_wPort = socket.port; // getsockname's echo of the bound port
    Report("MTUDP initialized succefully");
    this.m_dwLastSweep = Date.now() & 0xffffffff;
    MTUDPServer.ms_pInstance = this;
  }

  /** CThread::Resume → MTUDPServer::Proc — the receive/sweep loop. */
  Run(): void {
    Report("MTUDP listening thread started.");
    // the original loops on select(0) + recvfrom and sleeps 10 ms when idle;
    // Bun drives the socket from the event loop, so only the sweeper runs here.
    const sweep = () => {
      if (this.m_fTerminated !== 0) {
        clearInterval(timer);
        Report("MTUDP listening thread terminated.");
        return;
      }
      const now = Date.now() & 0xffffffff;
      if (now - this.m_dwLastSweep >= HOST_SWEEP_PERIOD) {
        this.m_dwLastSweep = now;
        let erased = 0;
        for (const [sn, host] of this.m_mapHost) {
          if (now - host.lastRecv > HOST_IDLE) {
            Report(
              `Host (SN:${host.sn} IP:${(host.ip >>> 24) & 0xff},${(host.ip >>> 16) & 0xff},${(host.ip >>> 8) & 0xff},${host.ip & 0xff} Port:${host.port}) recv:${host.recv} send:${host.send} miss:${host.miss} for ${now - host.createdLog} msecs`,
            );
            this.m_mapHost.delete(sn);
            erased++;
            this.m_dwTotalConn--;
          }
        }
        Report(`Erase ${erased} hosts , ${this.m_dwTotalConn} hosts remain`);
      }
    };
    const timer = setInterval(sweep, TIMER_TICK);
    timer.unref?.();
  }

  /**
   * MTUDPServer::ProcessIncomingData — validate, home the sender (first frame
   * only) and queue each frame's body for its target.
   */
  ProcessIncomingData(
    buf: Uint8Array,
    n2: number,
    ip: number,
    port: number,
    TickCount: number,
  ): void {
    let sender: HOSTHANDLEEX | null = null;
    let registered = false; // v31
    let off = 0;
    let left = n2;
    while (left !== 0) {
      if (left < 2) {
        ReportError("MTUDPBase::ProcessIncomingData - datagram length is less than len(sizeof(BYTE)) + FCS(sizeof(DWORD))");
        return;
      }
      const totalLen = buf[off]!;
      if (totalLen + 1 > left) {
        ReportError("MTUDPBase::ProcessIncomingData - datagram length is less than (total len) + (FCS size)");
        return;
      }
      if (UpdateCRC8(0, buf.subarray(off, off + totalLen + 1), totalLen + 1) !== 0) {
        ReportError("MTUDPBase::ProcessIncomingData - crc check failed!, discard remaining");
        return;
      }
      const srcSn = ((buf[off + 1]! << 24) | (buf[off + 2]! << 16) | (buf[off + 3]! << 8) | buf[off + 4]!) >>> 0;
      const dstSn = ((buf[off + 5]! << 24) | (buf[off + 6]! << 16) | (buf[off + 7]! << 8) | buf[off + 8]!) >>> 0;
      if (!registered) {
        // the registration phase — home (or re-home) the sender
        const host = this.m_mapHost.get(srcSn);
        if (host) {
          if (host.ip !== ip || host.port !== port) {
            const oldIp = host.ip;
            const oldPort = host.port;
            this.HostDestroy(srcSn);
            if (this.HostCreate(ip, port, srcSn) === 0) {
              ReportError("HostCreate failed for nonexistent host");
              return;
            }
            sender = this.m_mapHost.get(srcSn) ?? null;
            Report(`Different address.. sn:${srcSn} from ${oldIp}:${oldPort} to ${ip}:${port}`);
          } else {
            sender = host;
          }
        } else {
          if (this.HostCreate(ip, port, srcSn) === 0) {
            ReportError("HostCreate failed for nonexistent host");
            return;
          }
          sender = this.m_mapHost.get(srcSn) ?? null;
          this.UpdateTotalConn(this.m_mapHost.size);
        }
        registered = true;
        if (sender === null) {
          ReportError("Fail !!!  HostCreate failed for nonexistent host");
          return;
        }
      }
      // the forward phase — sender is always set: the first frame registers
      // it (or the handler returned), later frames inherit it
      const host = sender as HOSTHANDLEEX;
      host.lastRecv = TickCount;
      host.recv++;
      const target = this.m_mapHost.get(dstSn);
      if (!target) {
        if (this.m_dwHostCounter % 200 === 0) Report(`missed from ${srcSn} to ${dstSn}`);
        this.m_dwHostCounter++;
        host.miss++;
      } else {
        const body = buf.slice(off + 9, off + totalLen);
        this.AddPacket(body, target.ip, target.port);
        target.send++;
      }
      off += totalLen + 1;
      left -= totalLen + 1;
    }
  }

  /** MTUDPServer::HostCreate — a zero address/port never becomes a host. */
  HostCreate(ip: number, port: number, sn: number): number {
    if (ip === 0 || port === 0) return 0;
    this.m_mapHost.set(sn, {
      ip,
      port,
      sn,
      lastRecv: Date.now() & 0xffffffff,
      recv: 0,
      miss: 0,
      send: 0,
      createdLog: Date.now() & 0xffffffff,
    });
    return 1;
  }

  /** MTUDPServer::HostDestroy. */
  HostDestroy(sn: number): void {
    this.m_mapHost.delete(sn);
  }

  /** CMainWindow::UpdateTotalConn — the dialog's connection counter. */
  UpdateTotalConn(val: number): void {
    this.m_dwTotalConn = val;
  }

  /** The Bun socket callback — one datagram. */
  private OnDatagram(_socket: unknown, data: Uint8Array, fromPort: number, fromAddr: string): void {
    const ip = ipToDword(fromAddr);
    this.ProcessIncomingData(data, data.byteLength, ip, fromPort, Date.now() & 0xffffffff);
  }

  /**
   * CUDPPacketDispatcher::AddPacket — stage [len][ip][port][data] for the
   * dispatcher thread (the 4 MB budget overflows with the same report).
   */
  AddPacket(data: Uint8Array, ip: number, port: number): void {
    if (this.m_dwDispatchOffset + data.byteLength + 12 > DISPATCH_BUFFER_MAX) {
      ReportError(`UDPPacketDispatcher buffer overflow.. current offset:${this.m_dwDispatchOffset} , new packet:${data.byteLength}`);
      return;
    }
    this.m_dwDispatchOffset += data.byteLength + 12;
    this.m_rgDispatch.push({ ip, port, data });
  }

  /**
   * CUDPPacketDispatcher::Proc — drain the staging buffer through
   * MTUDPBase::UnreliableSendToUnRegisteredHost; the original logs the offset
   * every 5000th wakeup and sleeps 10 ms when idle, so the port drains on a
   * 10 ms timer.
   */
  RunDispatcher(): void {
    let wakeups = 0;
    const drain = () => {
      if (this.m_fTerminated !== 0) {
        clearInterval(timer);
        return;
      }
      wakeups++;
      if (wakeups % DISPATCH_REPORT_STRIDE === 0) Report(`OffsetData : ${this.m_dwDispatchOffset}`);
      const pending = this.m_rgDispatch;
      this.m_rgDispatch = [];
      this.m_dwDispatchOffset = 0;
      for (const { ip, port, data } of pending) {
        this.UnreliableSendToUnRegisteredHost(data, ip, port);
      }
    };
    const timer = setInterval(drain, IDLE_SLEEP);
    timer.unref?.();
  }

  /**
   * MTUDPBase::UnreliableSendToUnRegisteredHost — send [totalLen][data][crc8]
   * to a raw address; > 255 total is refused.
   */
  UnreliableSendToUnRegisteredHost(src: Uint8Array, hostlong: number, hostshort: number): number {
    const n2 = src.byteLength + 1;
    if (n2 > MAX_FRAME_SIZE) {
      ReportError("Request to send too long udp packet");
      return 2;
    }
    const buf = new Uint8Array(n2 + 1);
    buf[0] = n2;
    buf.set(src, 1);
    buf[n2] = UpdateCRC8(0, buf, n2);
    this.m_dwBytesSend = (this.m_dwBytesSend + n2 + 1) >>> 0;
    this.m_hSocket?.send(buf, hostshort, dwordToIp(hostlong));
    return 0;
  }

  /** CCxRelayApp::CleanUp — MTUDPBase::Cleanup + the singleton clears. */
  Cleanup(): void {
    this.m_fTerminated = 1;
    this.m_mapHost.clear();
    this.m_hSocket?.close?.();
    this.m_hSocket = null;
    MTUDPServer.ms_pInstance = null;
  }
}

/** The slice of Bun's UDP socket the relay uses (bun 1.4 runtime shape). */
interface IUDPSocket {
  readonly port: number; // the real bound port (the getsockname echo)
  send(data: Uint8Array, port: number, address: string): boolean | Promise<boolean>;
  close?(): void;
}

/** dotted quad → host-order dword (the recvfrom path's ntohl). */
function ipToDword(addr: string): number {
  const [a, b, c, d] = addr.split(".").map((x) => Number.parseInt(x, 10) & 0xff);
  return (((a ?? 0) << 24) | ((b ?? 0) << 16) | ((c ?? 0) << 8) | (d ?? 0)) >>> 0;
}

/** host-order dword → dotted quad (the sendto path). */
function dwordToIp(dw: number): string {
  return `${(dw >>> 24) & 0xff}.${(dw >>> 16) & 0xff}.${(dw >>> 8) & 0xff}.${dw & 0xff}`;
}

/**
 * CTimerThread — the 400 ms tick; every 750th tick logs the current time
 * (CTimerThread::OnTimer).
 */
export class CTimerThread {
  m_dwTick = 0; // dword_45D4B0

  Run(): void {
    Report("TimerThread started.");
    const timer = setInterval(() => {
      this.OnTimer();
    }, TIMER_TICK);
    timer.unref?.();
  }

  /** CTimerThread::OnTimer — "%d/%02d/%02d (%s) %02d:%02d". */
  OnTimer(): void {
    this.m_dwTick++;
    if (this.m_dwTick % TIMER_DATE_STRIDE !== 0) return;
    const now = new Date();
    Report(
      `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} (${WEEK_DAYS[now.getDay()]}) ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    );
  }
}

/**
 * CCxRelayApp — WinMain → SetUp → Run → DoMessageLoop.  The CSharedContext
 * single-instance guard and the Win32 dialog have no server-side behaviour.
 */
export async function main(cfgFile: string): Promise<void> {
  const cfg = new CServerConfig();
  cfg.Init(cfgFile);
  CServerConfig.ms_pInstance = cfg;

  const server = new MTUDPServer();
  await server.Startup(cfg); // CCxRelayApp::SetUp — MTUDPServer vtbl+24 (Startup)
  server.Run(); // the listening thread
  server.RunDispatcher(); // CUDPPacketDispatcher::Resume
  new CTimerThread().Run(); // CTimerThread::Resume
}
