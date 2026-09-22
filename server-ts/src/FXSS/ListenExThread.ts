/** Native source unit: FX/FxShop/ListenExThread.cpp. */
import { CWebSocket } from "./WebSocket.ts";

const ACCEPT_COUNT_REPORT_INTERVAL = 100;

/** CListenExThread — accepts web-mall verification connections. */
export class CListenExThread {
  private listener: Bun.TCPSocketListener | null = null;
  private readonly sockets = new WeakMap<object, CWebSocket>();
  private m_nAcceptCount = 0;

  constructor(private readonly port: number) {}

  /** CListenExThread::Proc, represented by Bun's socket listener. */
  Start(): void {
    if (this.listener !== null || process.env.TC_NOWEB) {
      console.log(`[Shop] web listener on :${this.port}`);
      return;
    }
    this.listener = Bun.listen({
      hostname: "0.0.0.0",
      port: this.port,
      socket: {
        open: (transport) => {
          const socket = new CWebSocket();
          this.sockets.set(transport, socket);
          socket.bunSocket = transport as Bun.Socket<any>;
          socket.m_bConnected = true;
          console.log(`[Shop] (Web) Connection establish[${transport.remoteAddress ?? ""}]`);
          if (++this.m_nAcceptCount % ACCEPT_COUNT_REPORT_INTERVAL === 0) {
            console.log(`[Shop] VerifyKey Connection Count:${this.m_nAcceptCount}`);
          }
        },
        data: (transport, data) => {
          this.sockets.get(transport)?.OnReceive(new Uint8Array(data as Buffer));
        },
        drain: (transport) => this.sockets.get(transport)?.Flush(),
        close: (transport) => {
          const socket = this.sockets.get(transport);
          if (!socket) return;
          console.log(`[Shop] (WebSocket)End of file, close connection(${socket.bunSocket?.remoteAddress ?? ""})`);
          socket.Close();
        },
        error: (_transport, error) => console.error(`[Shop web] ${String(error)}`),
      },
    });
    console.log(`[Shop] web listener on :${this.port}`);
  }

  /** CThread::Terminate counterpart for the Bun listener adapter. */
  Stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }
}
