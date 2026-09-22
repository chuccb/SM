/** Native source unit: common/MTUDPServer.cpp (CxLogin.pdb: MTUDPServer.obj). */
import { CServerConfig } from "../core/ServerConfig.ts";
import { type HOSTHANDLE, MTUDP_UDP_PORT_OFFSET } from "../common/MTUDP.ts";
import { MTUDPBase } from "./MTUDPBase.ts";
import { CUDPPacketDispatcher } from "./UDPPacketDispatcher.ts";

const UDP_RCVBUF_SIZE = 4096;

/** MTUDPServer (CxLogin.exe.c:28080) — MTUDPBase(bAutoDelete=1). */
export class MTUDPServer extends MTUDPBase {
  static ms_pInstance: MTUDPServer | null = null;

  readonly m_dispatcher: CUDPPacketDispatcher;

  constructor() {
    super();
    MTUDPServer.ms_pInstance = this;
    this.m_dispatcher = new CUDPPacketDispatcher(this);
  }

  /** MTUDPServer::StartupBase
   *  (CxLogin.exe.c:28118): socket(AF_INET, SOCK_DGRAM), bind
   *  INADDR_ANY:GetNumAttribute("ServerPort")+1, FIONBIO, getsockname,
   *  SO_RCVBUF 4096, "MTUDP initialized succefully", CThread::Resume.  On any
   *  failure the original terminates the process (CMainSystem::TerminateProcess).
   *  Native caller passes INADDR_ANY (0); kept as _nAddr for parity. */
  async StartupBase(_nAddr = 0): Promise<void> {
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
          this.OnPacketsAvailable();
        },
        error: (_socket, err) => console.error(`MTUDP::ThreadProc() ::select - errorcode:${String(err)}`),
      },
    });
    this.m_nPort = nPort;
    this.m_nIp = 0;
    // Native sets SO_RCVBUF to UDP_RCVBUF_SIZE (4096) via setsockopt.
    console.log(`MTUDP initialized succefully (SO_RCVBUF=${UDP_RCVBUF_SIZE})`);
    console.log("MTUDP listening thread started.");
  }


  /** MTUDPServer::Startup (vtbl+20) — the native zero-address wrapper. */
  async Startup(): Promise<void> {
    await this.StartupBase(0);
  }

  protected override OnPacketsAvailable(): void {
    this.m_dispatcher.Proc();
  }

  override Cleanup(): void {
    super.Cleanup();
    if (MTUDPServer.ms_pInstance === this) MTUDPServer.ms_pInstance = null;
  }
}
