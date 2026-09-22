/** Native source unit: common/MTUDPServer.cpp (FxServer.map: MTUDPServer.obj). */
import type { CServerConfig } from "../core/ServerConfig.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { MTUDP_UDP_PORT_OFFSET, type HOSTHANDLE } from "../common/MTUDP.ts";
import { MTUDPBase, type MTUDPFrameHandler } from "./MTUDPBase.ts";

function ParseIPv4(address: string): number {
  const parts = address.split(".");
  if (parts.length !== 4) return 0;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 0xff) return 0;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

/** FxServer's MTUDPServer singleton.  Bun's UDP callback replaces the native
 * listening CThread, while StartupBase and Proc retain their native owners. */
export class MTUDPServer extends MTUDPBase {
  static ms_pInstance: MTUDPServer | null = null;

  private readonly logTag = PacketLog.tag;

  constructor(
    onFrame: MTUDPFrameHandler,
    private readonly cfg: CServerConfig,
  ) {
    super(onFrame, true);
    MTUDPServer.ms_pInstance = this;
  }

  /** MTUDPServer::StartupBase — bind INADDR_ANY to ServerPort + 1. */
  async StartupBase(nAddr = 0): Promise<void> {
    void nAddr; // the native caller passes INADDR_ANY (zero)
    const port = this.cfg.GetNumAttribute("ServerPort") + MTUDP_UDP_PORT_OFFSET;

    this.m_nSocket = await Bun.udpSocket({
      hostname: "0.0.0.0",
      port,
      socket: {
        data: (_socket, data, remotePort, address) => {
          this.Proc(new Uint8Array(data as Buffer), Number(remotePort), String(address));
        },
      },
    });
    this.m_nIp = 0;
    this.m_nPort = port;
    console.log(`[GS] MTUDP initialized succefully (udp :${port})`);
  }

  /** MTUDPServer::Proc — recvfrom, form HOSTHANDLE, then ProcessIncomingData. */
  Proc(data: Uint8Array, port: number, address: string): void {
    if (PacketLog.ShowsClient()) PacketLog.Datagram("recv", data, this.logTag);
    const host: HOSTHANDLE = { ip: ParseIPv4(address), port };
    this.ProcessIncomingData(data, host);
  }

  override Cleanup(): void {
    super.Cleanup();
    if (MTUDPServer.ms_pInstance === this) MTUDPServer.ms_pInstance = null;
  }
}
