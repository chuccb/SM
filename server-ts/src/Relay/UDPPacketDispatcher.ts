/** Native source unit: CX/CxRelay/UDPPacketDispatcher.cpp. */
import { DISPATCH_BUFFER_MAX, DISPATCH_REPORT_STRIDE, IDLE_SLEEP } from "./Defs.ts";
import { Report, ReportError } from "./Report.ts";
import type { MTUDPBase } from "./MTUDPBase.ts";

interface DispatchPacket {
  ip: number;
  port: number;
  data: Uint8Array;
}

export class CUDPPacketDispatcher {
  static ms_pInstance: CUDPPacketDispatcher | null = null;

  m_dwDispatchOffset = 0;
  m_rgDispatch: DispatchPacket[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly server: MTUDPBase) {
    CUDPPacketDispatcher.ms_pInstance = this;
  }

  /** CUDPPacketDispatcher::AddPacket — stage [len][ip][port][data]. */
  AddPacket(data: Uint8Array, ip: number, port: number): void {
    if (this.m_dwDispatchOffset + data.byteLength + 12 > DISPATCH_BUFFER_MAX) {
      ReportError(`UDPPacketDispatcher buffer overflow.. current offset:${this.m_dwDispatchOffset} , new packet:${data.byteLength}`);
      return;
    }
    this.m_dwDispatchOffset += data.byteLength + 12;
    this.m_rgDispatch.push({ ip, port, data });
  }

  /** CUDPPacketDispatcher::Proc. */
  Run(): void {
    if (this.timer !== null) return;
    let wakeups = 0;
    this.timer = setInterval(() => {
      wakeups++;
      if (wakeups % DISPATCH_REPORT_STRIDE === 0) Report(`OffsetData : ${this.m_dwDispatchOffset}`);
      const pending = this.m_rgDispatch;
      this.m_rgDispatch = [];
      this.m_dwDispatchOffset = 0;
      for (const { ip, port, data } of pending) {
        this.server.UnreliableSendToUnRegisteredHost(data, ip, port);
      }
    }, IDLE_SLEEP);
    this.timer.unref?.();
  }

  Terminate(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.m_rgDispatch = [];
    this.m_dwDispatchOffset = 0;
    if (CUDPPacketDispatcher.ms_pInstance === this) CUDPPacketDispatcher.ms_pInstance = null;
  }
}
