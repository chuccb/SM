import { createSocket, type Socket } from "node:dgram";
import { CRateLimiter } from "../Common/CRateLimiter.ts";
import { HOSTHANDLE } from "../Common/HOSTHANDLE.ts";
import { DecodeUnreliableDatagram } from "../Common/MTUDPProtocol.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import type { CUDPPacketDispatcher } from "./CUDPPacketDispatcher.ts";

/** FXGS discovery-only subset of MTUDPServer / MTUDPBase, NOT Relay/MTUDPServer.
 * The native default port is GS TCP+1 (0042E55A). This adapter deliberately has
 * no UDP replies, forwarding, per-host queue, or automatic host allocation; its
 * only side effect is same-channel TCP-session-bound peer publication over TCP.
 * Full MTUDP queue/reliability/clock synchronization is not claimed implemented.
 * Deployment must explicitly enable this optional listener. */
export class MTUDPServer {
  private socket: Socket | undefined;
  private readonly globalAdmission: CRateLimiter;
  private readonly sourceAdmission: CRateLimiter;
  constructor(
    readonly dispatcher: CUDPPacketDispatcher,
    clock: () => number = Date.now,
  ) {
    this.globalAdmission = new CRateLimiter(
      RuntimePolicy.MaxGameUDPDatagramsPerSecond,
      1000,
      1,
      clock,
    );
    this.sourceAdmission = new CRateLimiter(
      RuntimePolicy.MaxGameUDPDatagramsPerSecondPerIP,
      1000,
      RuntimePolicy.MaxGameUDPSourceIPs,
      clock,
    );
  }
  get port(): number {
    const address = this.socket?.address();
    return address && typeof address !== "string" ? address.port : 0;
  }
  async Startup(host: string, port: number): Promise<void> {
    if (this.socket) throw new Error("FXGS UDP already started");
    const socket = (this.socket = createSocket("udp4"));
    socket.on("error", () => {});
    socket.on("message", (bytes, peer) => {
      if (
        this.socket !== socket ||
        !this.globalAdmission.Admit("discovery") ||
        !this.sourceAdmission.Admit(peer.address)
      )
        return;
      try {
        const payloads = DecodeUnreliableDatagram(bytes);
        // Native queue: AddPacket 004284B9 skips empty payloads; GetPacket
        // 00428565 dequeues ONE; dispatcher 00416619 then HostDestroy 0042DB30
        // destroys the host and its remaining input queue. Do not accidentally
        // dispatch every valid frame from one datagram. Cross-datagram thread
        // batching/races are not emulated by this deliberately queue-free adapter.
        const payload = payloads.find((packet) => packet.length !== 0);
        if (payload)
          this.dispatcher.OnUDPPacket(
            payload,
            HOSTHANDLE.FromAddress(peer.address, peer.port),
          );
      } catch {
        // Malformed/untrusted UDP never reflects data or terminates a TCP user.
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(port, host, () => {
          socket.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.socket = undefined;
      await close(socket);
      throw error;
    }
  }
  async Cleanup(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) await close(socket);
  }
}
function close(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
