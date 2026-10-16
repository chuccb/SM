import { createServer, type Server } from "node:net";
import { CClientSocket, type ClientPacketHandler } from "./CClientSocket.ts";
import type { CTextCodec } from "./CTextCodec.ts";
import { RuntimePolicy } from "./RuntimePolicy.ts";
import { NormalizePeerIP } from "./CIPAddress.ts";
import { ClientSocketCode } from "./OfficialValues.ts";

export class CListenSocket {
  private server: Server | undefined;
  readonly sockets = new Set<CClientSocket>();
  private readonly ipCount = new Map<string, number>();
  // A disconnected socket can still be awaiting an Argon2/DB handler. Keep it
  // here until drained; it is no longer present in the live `sockets` set.
  private readonly draining = new Set<Promise<void>>();
  private closing = false;
  private sequence = 0;
  constructor(
    readonly name: string,
    readonly text: CTextCodec,
    readonly OnPacket: ClientPacketHandler,
    readonly OnConnEstablished: (socket: CClientSocket) => void,
    readonly OnDisconnect: (socket: CClientSocket) => void,
    readonly maxPacketLength?: number,
  ) {}
  get port(): number {
    const a = this.server?.address();
    return a && typeof a !== "string" ? a.port : 0;
  }
  async Listen(host: string, port: number): Promise<void> {
    if (this.server) throw new Error(`${this.name} already listening`);
    this.closing = false;
    this.server = createServer((socket) => {
      const address = NormalizePeerIP(socket.remoteAddress ?? "");
      const ipCount = this.ipCount.get(address) ?? 0;
      if (
        this.closing ||
        this.sockets.size >= RuntimePolicy.MaxConnectionsPerService ||
        ipCount >= RuntimePolicy.MaxConnectionsPerIP
      ) {
        socket.destroy();
        return;
      }
      const id = ++this.sequence;
      const client = new CClientSocket(
        socket,
        id,
        (id - 1) % ClientSocketCode.HeaderTypeCount,
        this.text,
        this.maxPacketLength,
      );
      this.sockets.add(client);
      this.ipCount.set(address, ipCount + 1);
      client.OnPacket = this.OnPacket;
      client.onClose = () => {
        this.sockets.delete(client);
        const left = (this.ipCount.get(address) ?? 1) - 1;
        if (left > 0) this.ipCount.set(address, left);
        else this.ipCount.delete(address);
        const done = client.WaitForHandlers();
        this.draining.add(done);
        void done.then(
          () => this.draining.delete(done),
          () => this.draining.delete(done),
        );
        try {
          this.OnDisconnect(client);
        } catch {
          console.error(
            JSON.stringify({
              event: "disconnect-handler-error",
              service: this.name,
            }),
          );
        }
      };
      try {
        this.OnConnEstablished(client);
      } catch {
        client.Close();
      }
    });
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (error) =>
      console.error(
        JSON.stringify({
          event: "listener-error",
          service: this.name,
          reason: error.message,
        }),
      ),
    );
  }
  async Close(): Promise<void> {
    this.closing = true;
    const server = this.server;
    this.server = undefined;
    const sockets = [...this.sockets];
    for (const s of sockets) s.Close();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    // Bun's server.close callback can run before the sockets' close events.
    // Waiting only for handlers let Center free users before room/rank cleanup.
    // A disconnected-but-running handler is still drained separately below.
    await Promise.all(sockets.map((s) => s.WaitForClose()));
    await Promise.all([
      ...sockets.map((s) => s.WaitForHandlers()),
      ...this.draining,
    ]);
  }
}
