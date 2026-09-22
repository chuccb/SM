/** Native source unit: CX/CxCenter/MonitorListenThread.cpp. */
import { CMonitorSocket, type MonitorHost } from "./MonitorSocket.ts";

/** CMonitorListenThread — accepts operator-monitor connections. */
export class CMonitorListenThread {
  private listener: Bun.TCPSocketListener | null = null;
  private readonly sockets = new WeakMap<object, CMonitorSocket>();
  private readonly liveSockets = new Set<CMonitorSocket>();

  constructor(
    private readonly host: MonitorHost,
    private readonly port: number,
  ) {}

  /** CMonitorListenThread::Proc, represented by Bun's socket listener. */
  Start(): void {
    if (this.listener !== null) return;
    console.log("[Center] Monitor Listen socket thread created.");
    this.listener = Bun.listen({
      hostname: "0.0.0.0",
      port: this.port,
      socket: {
        open: (transport) => {
          const socket = new CMonitorSocket(this.host);
          this.sockets.set(transport, socket);
          socket.bunSocket = transport as Bun.Socket<any>;
          socket.m_bConnected = true;
          this.liveSockets.add(socket);
          socket.hooks.onClose = () => this.liveSockets.delete(socket);
        },
        data: (transport, data) => {
          this.sockets.get(transport)?.OnReceive(new Uint8Array(data as Buffer));
        },
        drain: (transport) => this.sockets.get(transport)?.Flush(),
        close: (transport) => this.sockets.get(transport)?.Close(),
        error: (_transport, error) => console.error(`[Center:monitor] ${String(error)}`),
      },
    });
    console.log(`[Center] monitor listening on :${this.port}`);
  }

  /** CThread::Terminate counterpart for the Bun listener adapter. */
  Stop(): void {
    this.listener?.stop(true);
    this.listener = null;
    this.liveSockets.clear();
  }
}
