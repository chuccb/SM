/** Native source unit: CX/CxCenter/ListenThread.cpp. */
import type { CLocalServer } from "./LocalServer.ts";
import { CLocalSocket, type LocalSocketHost } from "./LocalSocket.ts";

/** Port-only narrow dependency replacing the native app/singleton lookups. */
export interface CenterListenHost extends LocalSocketHost {
  readonly servers: CLocalServer[];
}

/** CListenThread — accepts links from configured local servers. */
export class CListenThread {
  private listener: Bun.TCPSocketListener | null = null;
  private readonly sockets = new WeakMap<object, CLocalSocket>();

  constructor(
    private readonly host: CenterListenHost,
    private readonly port: number,
  ) {}

  /** CListenThread::Proc, represented by Bun's socket listener. */
  Start(): void {
    if (this.listener !== null) return;
    this.listener = Bun.listen({
      hostname: "0.0.0.0",
      port: this.port,
      socket: {
        open: (transport) => {
          const address = transport.remoteAddress ?? "";
          if (!this.host.servers.some((server) => server.strIP === address)) {
            console.error(`[Center] Unregistered host tried to connect[${address}]`);
            transport.end();
            return;
          }
          const socket = new CLocalSocket(this.host);
          this.sockets.set(transport, socket);
          socket.bunSocket = transport as Bun.Socket<any>;
          socket.m_bConnected = true;
          socket.SendGreeting();
        },
        data: (transport, data) => {
          this.sockets.get(transport)?.OnData(new Uint8Array(data as Buffer));
        },
        drain: (transport) => this.sockets.get(transport)?.Flush(),
        close: (transport) => this.sockets.get(transport)?.Close(),
        error: (_transport, error) => console.error(`[Center] ${String(error)}`),
      },
    });
    console.log(`[Center] listening on :${this.port}`);
  }

  /** CThread::Terminate counterpart for the Bun listener adapter. */
  Stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }
}
