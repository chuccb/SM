import { createSocket, type Socket as DatagramSocket } from "node:dgram";
import { createServer, type Server } from "node:net";

export class UDPPeer {
  readonly socket = createSocket("udp4");
  readonly packets: Buffer[] = [];
  constructor() {
    this.socket.on("message", (packet) =>
      this.packets.push(Buffer.from(packet)),
    );
  }
  get port(): number {
    const address = this.socket.address();
    return typeof address === "string" ? 0 : address.port;
  }
  async Bind(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(0, "127.0.0.1", () => {
        this.socket.off("error", reject);
        resolve();
      });
    });
  }
  async Send(port: number, bytes: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.socket.send(bytes, port, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
}
export function closeUDP(socket: DatagramSocket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
export function closeTCP(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
/** Reserve a TCP / UDP+1 pair without assuming neighboring ephemeral ports
 * are free. Reserve on the SAME wildcard interface as production (a loopback
 * reservation alone cannot establish wildcard bind availability). Both remain
 * held until the caller deliberately releases. */
export async function reservePair() {
  for (let attempt = 0; attempt < 16; attempt++) {
    const udp = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(0, "0.0.0.0", () => {
        udp.off("error", reject);
        resolve();
      });
    });
    const address = udp.address();
    const port = typeof address === "string" ? 0 : address.port - 1;
    const tcp = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        tcp.once("error", reject);
        tcp.listen(port, "0.0.0.0", () => {
          tcp.off("error", reject);
          resolve();
        });
      });
      return { port, tcp, udp };
    } catch {
      await closeUDP(udp);
      await closeTCP(tcp);
    }
  }
  throw new Error("Could not reserve adjacent TCP / UDP ports");
}
