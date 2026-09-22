/** Native source unit: CX/CxUtil/ListenThread.cpp. */
import { CipherDegree } from "../core/Packet.ts";
import { CClientSocket } from "./ClientSocket.ts";
import type { CMainSystem } from "./MainSystem.ts";

/** CListenThread — accepts raw CxUtil operator-client connections. */
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
          const socket = new CClientSocket();
          this.sockets.set(transport, socket);
          socket.bunSocket = transport as Bun.Socket<any>;
          socket.m_bConnected = true;
          this.mainSystem.OnConnEstablished(socket);
          socket.SetCipherDegree(CipherDegree.kPacketRaw);
          console.log(`[Util] Connection establish[${transport.remoteAddress ?? ""}]`);
        },
        data: (transport, data) => {
          this.sockets.get(transport)?.OnReceive(new Uint8Array(data as Buffer));
        },
        drain: (transport) => this.sockets.get(transport)?.Flush(),
        close: (transport) => this.sockets.get(transport)?.Close(),
        error: (_transport, error) => console.error(`[FXUS] ${String(error)}`),
      },
    });
    console.log(`[FXUS] listening on :${this.port}`);
  }

  /** CThread::Terminate counterpart for the Bun listener adapter. */
  Stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }
}
