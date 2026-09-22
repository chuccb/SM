/** Native source unit: CX/CxLogin/ListenThread.cpp. */
import { CipherDegree } from "../core/Packet.ts";
import { CClientSocket } from "./ClientSocket.ts";
import type { CLoginPool } from "./LoginPool.ts";
import type { CMainSystem } from "./MainSystem.ts";

/** CListenThread — accepts encrypted login-client connections. */
export class CListenThread {
  private listener: Bun.TCPSocketListener | null = null;
  private readonly sockets = new WeakMap<object, CClientSocket>();

  constructor(
    private readonly port: number,
    private readonly mainSystem: CMainSystem,
    private readonly loginPool: CLoginPool,
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
          transport.setNoDelay?.(true);
          this.mainSystem.OnConnEstablished(socket);
          socket.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8);
          this.loginPool.AddSocket(socket);
        },
        data: (transport, data) => {
          const bytes = new Uint8Array(data as Buffer);
          if (process.env.LS_DEBUG) {
            const preview = Array.from(bytes.subarray(0, 64), (value) => value.toString(16).padStart(2, "0")).join(" ");
            console.error(`[LS_DEBUG] recv ${bytes.length}B: ${preview}`);
          }
          this.sockets.get(transport)?.OnReceive(bytes);
        },
        drain: (transport) => this.sockets.get(transport)?.Flush(),
        close: (transport) => this.sockets.get(transport)?.Close(),
        error: (_transport, error) => console.error(`[LS] ${String(error)}`),
      },
    });
    console.log(`[LS] listening on :${this.port}`);
  }

  /** CThread::Terminate counterpart for the Bun listener adapter. */
  Stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }
}
