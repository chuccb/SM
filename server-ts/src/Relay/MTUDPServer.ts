/** Native source unit: CX/CxRelay/MTUDPServer.cpp. */
import { GetTickCount } from "../core/GetTickCount.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { CServerConfig } from "../core/ServerConfig.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import { MTUDP_CRC_BYTES, MTUDP_FRAME_OVERHEAD, UpdateCRC8 } from "../common/MTUDP.ts";
import {
  HOST_IDLE,
  HOST_SWEEP_PERIOD,
  RELAY_BODY_OFFSET,
  RELAY_DESTINATION_SERIAL_OFFSET,
  RELAY_SOURCE_SERIAL_OFFSET,
  TIMER_TICK,
} from "./Defs.ts";
import { Report, ReportError } from "./Report.ts";
import { ipToDword } from "./Utils.ts";
import { MTUDPBase } from "./MTUDPBase.ts";
import { CUDPPacketDispatcher } from "./UDPPacketDispatcher.ts";

const MISSED_PACKET_REPORT_INTERVAL = 200;

/** HOSTHANDLEEX — the MTUDPServer host-table value (32 native bytes). */
export interface HOSTHANDLEEX {
  ip: number;
  port: number;
  sn: number;
  lastRecv: number;
  recv: number;
  miss: number;
  send: number;
  createdLog: number;
}

/**
 * MTUDPServer — the listening socket, the sn → host table and the forward
 * queue feeding CUDPPacketDispatcher (FxServer.lst 402A20..403130).
 */
export class MTUDPServer extends MTUDPBase {
  /** TSingleton<MTUDPServer>::ms_pInstance */
  static ms_pInstance: MTUDPServer | null = null;

  constructor() {
    super();
    MTUDPServer.ms_pInstance = this;
  }

  /** MTUDPServer::Startup → MTUDPBase::StartupBase(0). */
  async Startup(cfg: CServerConfig): Promise<void> {
    await this.StartupBase(cfg, (socket, data, port, address) => {
      this.OnDatagram(socket, data, port, address);
    });
  }

  m_mapHost = new Map<number, HOSTHANDLEEX>(); // +88 map<unsigned int, HOSTHANDLEEX>
  m_dwHostCounter = 0; // the shared "missed" log counter (dword_45D45C)
  m_dwTotalConn = 0; // CMainWindow::UpdateTotalConn's value
  m_dwLastSweep = 0; // the 120 s mark (Proc's Time)
  m_fTerminated = 0; // +4 (the thread stop flag)
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** CThread::Resume → MTUDPServer::Proc — the receive/sweep loop. */
  Run(): void {
    if (this.sweepTimer !== null) return;
    this.m_fTerminated = 0;
    Report("MTUDP listening thread started.");
    // The native Proc keeps its sweep mark on the timeGetTime clock. Bun
    // drives receive callbacks, so this interval only performs that sweep.
    this.m_dwLastSweep = timeGetTime();
    const sweep = () => {
      const now = timeGetTime();
      if (((now - this.m_dwLastSweep) >>> 0) >= HOST_SWEEP_PERIOD) {
        this.m_dwLastSweep = now;
        let erased = 0;
        for (const [sn, host] of this.m_mapHost) {
          if (((now - host.lastRecv) >>> 0) > HOST_IDLE) {
            Report(
              `Host (SN:${host.sn} IP:${(host.ip >>> 24) & 0xff},${(host.ip >>> 16) & 0xff},${(host.ip >>> 8) & 0xff},${host.ip & 0xff} Port:${host.port}) recv:${host.recv} send:${host.send} miss:${host.miss} for ${(now - host.createdLog) >>> 0} msecs`,
            );
            this.m_mapHost.delete(sn);
            erased++;
            this.m_dwTotalConn--;
          }
        }
        Report(`Erase ${erased} hosts , ${this.m_dwTotalConn} hosts remain`);
      }
    };
    this.sweepTimer = setInterval(sweep, TIMER_TICK);
    this.sweepTimer.unref?.();
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
    let registered = false;
    let off = 0;
    let left = n2;
    while (left !== 0) {
      if (left < MTUDP_FRAME_OVERHEAD) {
        ReportError("MTUDPBase::ProcessIncomingData - datagram length is less than len(sizeof(BYTE)) + FCS(sizeof(DWORD))");
        return;
      }
      const totalLen = buf[off]!;
      if (totalLen + MTUDP_CRC_BYTES > left) {
        ReportError("MTUDPBase::ProcessIncomingData - datagram length is less than (total len) + (FCS size)");
        return;
      }
      if (UpdateCRC8(0, buf.subarray(off, off + totalLen + MTUDP_CRC_BYTES), totalLen + MTUDP_CRC_BYTES) !== 0) {
        ReportError("MTUDPBase::ProcessIncomingData - crc check failed!, discard remaining");
        return;
      }
      const srcSn = ((buf[off + RELAY_SOURCE_SERIAL_OFFSET]! << 24) | (buf[off + RELAY_SOURCE_SERIAL_OFFSET + 1]! << 16) | (buf[off + RELAY_SOURCE_SERIAL_OFFSET + 2]! << 8) | buf[off + RELAY_SOURCE_SERIAL_OFFSET + 3]!) >>> 0;
      const dstSn = ((buf[off + RELAY_DESTINATION_SERIAL_OFFSET]! << 24) | (buf[off + RELAY_DESTINATION_SERIAL_OFFSET + 1]! << 16) | (buf[off + RELAY_DESTINATION_SERIAL_OFFSET + 2]! << 8) | buf[off + RELAY_DESTINATION_SERIAL_OFFSET + 3]!) >>> 0;
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
        if (this.m_dwHostCounter % MISSED_PACKET_REPORT_INTERVAL === 0) Report(`missed from ${srcSn} to ${dstSn}`);
        this.m_dwHostCounter++;
        host.miss++;
      } else {
        const body = buf.slice(off + RELAY_BODY_OFFSET, off + totalLen);
        CUDPPacketDispatcher.ms_pInstance!.AddPacket(body, target.ip, target.port);
        target.send++;
      }
      off += totalLen + MTUDP_CRC_BYTES;
      left -= totalLen + MTUDP_CRC_BYTES;
    }
  }

  /** MTUDPServer::HostCreate — a zero address/port never becomes a host. */
  HostCreate(ip: number, port: number, sn: number): number {
    if (ip === 0 || port === 0) return 0;
    const now = timeGetTime();
    this.m_mapHost.set(sn, {
      ip,
      port,
      sn,
      lastRecv: now,
      recv: 0,
      miss: 0,
      send: 0,
      createdLog: now,
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
    if (PacketLog.ShowsInfra()) PacketLog.Datagram("recv", data, this.m_szLogTag);
    const ip = ipToDword(fromAddr);
    this.ProcessIncomingData(data, data.byteLength, ip, fromPort, GetTickCount());
  }

  /** CCxRelayApp::CleanUp — MTUDPBase::Cleanup + the singleton clears. */
  Cleanup(): void {
    this.m_fTerminated = 1;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      Report("MTUDP listening thread terminated.");
    }
    this.m_mapHost.clear();
    this.CleanupBase();
    if (MTUDPServer.ms_pInstance === this) MTUDPServer.ms_pInstance = null;
  }
}
