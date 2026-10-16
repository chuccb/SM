import { createSocket, type Socket } from "node:dgram";
import type { CCenterServer } from "../Center/CCenterServer.ts";
import {
  DecodeRelayDatagram,
  EncodeUnregisteredDatagram,
  RelayFormat,
} from "./RelayProtocol.ts";
import { NormalizePeerIP } from "../Common/CIPAddress.ts";
import { SessionLimit, ServerType } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { CRateLimiter } from "../Common/CRateLimiter.ts";

interface HostHandle {
  address: string;
  port: number;
  last: number;
  start: number;
  bytes: number;
}
/** Original framing, hardened registration: only an authenticated user's TCP IP
 * may bind its serial, and forwarding requires the same live channel+room+serial.
 * Unlike the old automatic unauthenticated registration this is not an open relay. */
export class MTUDPServer {
  private socket: Socket | undefined;
  private readonly hosts = new Map<number, HostHandle>();
  private readonly admission = new CRateLimiter(
    RuntimePolicy.MaxRelayDatagramsPerSecond,
    1000,
    1,
  );
  constructor(
    readonly center: CCenterServer,
    readonly clock: () => number = Date.now,
  ) {}
  get port(): number {
    const address = this.socket?.address();
    return address && typeof address !== "string" ? address.port : 0;
  }
  async Startup(host: string, port: number): Promise<void> {
    if (this.socket) throw new Error("Relay already started");
    const socket = (this.socket = createSocket("udp4"));
    socket.on("message", (bytes, peer) => {
      if (!this.admission.Admit("relay")) return;
      try {
        const frames = DecodeRelayDatagram(bytes);
        const first = frames[0]!;
        const now = this.clock();
        const address = NormalizePeerIP(peer.address);
        const user = this.center.m_globalUserTable.GetUser(first.source);
        if (
          !user?.m_pClientSocket?.IsConnected() ||
          user.m_pClientSocket.address !== address ||
          user.m_pLocalServer?.m_nServerType !== ServerType.FXGame ||
          user.m_nSessionIdx === SessionLimit.NoSession
        )
          return;
        for (const [id, h] of this.hosts)
          if (
            now - h.last > RelayFormat.HostTimeoutMs ||
            !this.center.m_globalUserTable.GetUser(id)
          )
            this.hosts.delete(id);
        let handle = this.hosts.get(first.source);
        if (!handle) {
          if (this.hosts.size >= RuntimePolicy.MaxRelayHosts) return;
          handle = {
            address,
            port: peer.port,
            last: now,
            start: now,
            bytes: 0,
          };
          this.hosts.set(first.source, handle);
        }
        if (now - handle.start >= 1000) {
          handle.start = now;
          handle.bytes = 0;
        }
        handle.bytes += bytes.length;
        if (handle.bytes > RuntimePolicy.MaxRelayBytesPerSecondPerHost) return;
        handle.address = address;
        handle.port = peer.port;
        handle.last = now;
        for (const frame of frames) {
          const target = this.center.m_globalUserTable.GetUser(
            frame.destination,
          );
          const endpoint = this.hosts.get(frame.destination);
          if (
            !endpoint ||
            !target?.m_pClientSocket?.IsConnected() ||
            target.m_pLocalServer !== user.m_pLocalServer ||
            target.m_nSessionIdx !== user.m_nSessionIdx ||
            target.m_nSessionSerialNo !== user.m_nSessionSerialNo ||
            target.m_pendingConnection ||
            user.m_pendingConnection
          )
            continue;
          socket.send(
            EncodeUnregisteredDatagram(frame.payload),
            endpoint.port,
            endpoint.address,
            () => {},
          );
        }
      } catch {
        /* malformed unauthenticated UDP is silently discarded, not reflected */
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, host, () => {
        socket.off("error", reject);
        resolve();
      });
    });
    socket.on("error", () => {});
  }
  async Cleanup(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.hosts.clear();
    if (socket)
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      });
  }
}
