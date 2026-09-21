/** Native source unit: FX/FxShop/ListenThread.cpp. */
import { CipherDegree } from "../core/Packet.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import { CClientSocket } from "./ClientSocket.ts";
import type { CMainSystem } from "./MainSystem.ts";

/** CListenThread — accepts encrypted shop-client connections. */
export class CListenThread {
  private listener: Bun.TCPSocketListener | null = null;
  private readonly sockets = new WeakMap<object, CClientSocket>();

  constructor(
    private readonly port: number,
    private readonly mainSystem: CMainSystem,
  ) {}

  /** CListenThread::Proc, represented by Bun's socket listener. */
  Start(): void {
    if (this.listener !== null) return;
    this.listener = Bun.listen({
      hostname: "0.0.0.0",
      port: this.port,
      socket: {
        open: (transport) => {
          try {
            const socket = new CClientSocket();
            this.sockets.set(transport, socket);
            socket.bunSocket = transport as Bun.Socket<any>;
            socket.m_bConnected = true;
            socket.m_strPeerAddress = transport.remoteAddress;
            this.mainSystem.OnConnEstablished(socket);
            socket.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8);
          } catch (error) {
            console.error("[Shop] client accept failed", error);
          }
        },
        data: (transport, data) => {
          const socket = this.sockets.get(transport);
          if (!socket) return;
          socket.m_dwIdleTime = timeGetTime();
          socket.OnReceive(new Uint8Array(data as Buffer));
        },
        drain: (transport) => this.sockets.get(transport)?.Flush(),
        close: (transport) => this.sockets.get(transport)?.Close(),
        error: (_transport, error) => console.error(`[Shop] ${String(error)}`),
      },
    });
    console.log(`[Shop] listening on :${this.port}`);
  }

  /** CThread::Terminate counterpart for the Bun listener adapter. */
  Stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }
}
