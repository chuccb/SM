/** Native source unit: CX/CxRelay/MTUDPBase.cpp. */
import { CServerConfig } from "../core/ServerConfig.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { BuildFrame } from "../common/MTUDP.ts";
import { MAX_FRAME_SIZE } from "./Defs.ts";
import { Report, ReportError } from "./Report.ts";
import { dwordToIp } from "./Utils.ts";

export interface IUDPSocket {
  readonly port: number;
  send(data: Uint8Array, port: number, address: string): boolean | Promise<boolean>;
  close?(): void;
}

export type DatagramHandler = (
  socket: unknown,
  data: Uint8Array,
  port: number,
  address: string,
) => void;

export class MTUDPBase {
  m_szLogTag = PacketLog.tag;
  m_hSocket: IUDPSocket | null = null;
  m_dwAddr = 0;
  m_wPort = 0;
  m_dwBytesSend = 0;

  async StartupBase(cfg: CServerConfig, onDatagram: DatagramHandler): Promise<void> {
    const socket = (await Bun.udpSocket({
      hostname: "0.0.0.0",
      port: cfg.GetNumAttribute("ServerPort"),
      socket: {
        data: (udpSocket, data, port, address) => {
          onDatagram(udpSocket, new Uint8Array(data as Buffer), port, String(address));
        },
      },
    })) as unknown as IUDPSocket;
    this.m_hSocket = socket;
    this.m_dwAddr = 0;
    this.m_wPort = socket.port;
    Report("MTUDP initialized succefully");
  }

  /** MTUDPBase::UnreliableSendToUnRegisteredHost. */
  UnreliableSendToUnRegisteredHost(src: Uint8Array, hostlong: number, hostshort: number): number {
    const frameLength = src.byteLength + 1;
    if (frameLength > MAX_FRAME_SIZE) {
      ReportError("Request to send too long udp packet");
      return 2;
    }
    const frame = BuildFrame(src);
    this.m_dwBytesSend = (this.m_dwBytesSend + frame.byteLength) >>> 0;
    this.m_hSocket?.send(frame, hostshort, dwordToIp(hostlong));
    if (PacketLog.ShowsInfra()) PacketLog.Datagram("send", frame, this.m_szLogTag);
    return 0;
  }

  CleanupBase(): void {
    this.m_hSocket?.close?.();
    this.m_hSocket = null;
  }
}
