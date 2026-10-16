import { expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { MTUDPServer } from "../Relay/MTUDPServer.ts";
import { CCenterServer } from "../Center/CCenterServer.ts";
import { ServerType } from "../Common/OfficialValues.ts";
import { CCRC8 } from "../Common/CCRC.ts";
import { RelayFormat } from "../Relay/RelayProtocol.ts";
import { TestConfig, UserInfo } from "./helpers/Accounts.ts";
import { MemoryClient } from "./helpers/Clients.ts";
class UDPPeer {
  readonly socket = createSocket("udp4");
  readonly packets: Buffer[] = [];
  private changed: (() => void) | undefined;
  constructor() {
    this.socket.on("message", (p) => {
      this.packets.push(Buffer.from(p));
      this.changed?.();
    });
  }
  async Bind() {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(0, "127.0.0.1", () => {
        this.socket.off("error", reject);
        resolve();
      });
    });
  }
  async Send(
    port: number,
    source: number,
    destination: number,
    payload: Buffer,
  ) {
    const length = payload.length + 9;
    const frame = Buffer.alloc(length + 1);
    frame[0] = length;
    frame.writeUInt32BE(source, 1);
    frame.writeUInt32BE(destination, 5);
    frame.set(payload, 9);
    frame[length] = CCRC8.UpdateCRC(0, frame.subarray(0, length));
    await new Promise<void>((resolve, reject) =>
      this.socket.send(frame, port, "127.0.0.1", (e) =>
        e ? reject(e) : resolve(),
      ),
    );
  }
  async Read(timeout = 1000): Promise<Buffer> {
    if (!this.packets.length)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.changed = undefined;
          reject(new Error("No datagram"));
        }, timeout);
        this.changed = () => {
          clearTimeout(timer);
          this.changed = undefined;
          resolve();
        };
      });
    return this.packets.shift()!;
  }
  async Close() {
    await close(this.socket);
  }
}
function close(socket: Socket) {
  return new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
function forwarded(payload: Buffer) {
  const out = Buffer.alloc(payload.length + 2);
  out[0] = payload.length + 1;
  out.set(payload, 1);
  out[out.length - 1] = CCRC8.UpdateCRC(0, out.subarray(0, -1));
  return out;
}

test("real UDP: only TCP-authenticated same-room/channel/serial traffic is re-framed and forwarded", async () => {
  const config = TestConfig();
  const center = new CCenterServer(config);
  const server = center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!;
  server.m_bConnected = true;
  const tcp = [
    new MemoryClient(),
    new MemoryClient(),
    new MemoryClient(),
    new MemoryClient("127.0.0.2"),
  ];
  const users = tcp.map(
    (s, i) =>
      center.OnAddNewUser(s, server, [
        UserInfo(String.fromCharCode(65 + i)),
      ])[0]!,
  );
  for (const user of users) {
    user.m_nSessionIdx = 7;
    user.m_nSessionSerialNo = 42;
  }
  users[2]!.m_nSessionSerialNo = 43;
  let now = 1000;
  const relay = new MTUDPServer(center, () => now);
  const peers = [new UDPPeer(), new UDPPeer(), new UDPPeer(), new UDPPeer()];
  try {
    await relay.Startup("127.0.0.1", 0);
    for (const peer of peers) await peer.Bind();
    // Self-addressed authenticated frames serve as receive barriers, NOT invented
    // relay registration acks. They use exactly the normal forwarding path.
    for (let i = 0; i < 3; i++) {
      const payload = Buffer.from([0x90 + i]);
      const sn = users[i]!.GetGlobalSerialNo();
      await peers[i]!.Send(relay.port, sn, sn, payload);
      expect(await peers[i]!.Read()).toEqual(forwarded(payload));
    }
    const payload = Buffer.from([0x12, 0x34, 0x56]);
    await peers[0]!.Send(
      relay.port,
      users[0]!.GetGlobalSerialNo(),
      users[1]!.GetGlobalSerialNo(),
      payload,
    );
    expect(await peers[1]!.Read()).toEqual(forwarded(payload));
    await peers[2]!.Send(
      relay.port,
      users[2]!.GetGlobalSerialNo(),
      users[1]!.GetGlobalSerialNo(),
      payload,
    );
    await expect(peers[1]!.Read(50)).rejects.toThrow("No datagram");
    users[2]!.m_nSessionSerialNo = 42;
    users[2]!.m_nSessionIdx = 8;
    await peers[2]!.Send(
      relay.port,
      users[2]!.GetGlobalSerialNo(),
      users[1]!.GetGlobalSerialNo(),
      payload,
    );
    await expect(peers[1]!.Read(50)).rejects.toThrow("No datagram");
    await peers[3]!.Send(
      relay.port,
      users[3]!.GetGlobalSerialNo(),
      users[1]!.GetGlobalSerialNo(),
      payload,
    );
    await expect(peers[1]!.Read(50)).rejects.toThrow("No datagram");
    tcp[1]!.Close();
    await peers[0]!.Send(
      relay.port,
      users[0]!.GetGlobalSerialNo(),
      users[1]!.GetGlobalSerialNo(),
      payload,
    );
    await expect(peers[1]!.Read(50)).rejects.toThrow("No datagram");
    // A destination endpoint expires even though its TCP session is still live.
    users[2]!.m_nSessionIdx = 7;
    now += RelayFormat.HostTimeoutMs + 1;
    await peers[1]!.Send(
      relay.port,
      users[0]!.GetGlobalSerialNo(),
      users[0]!.GetGlobalSerialNo(),
      payload,
    );
    expect(await peers[1]!.Read()).toEqual(forwarded(payload));
    await peers[0]!.Send(
      relay.port,
      users[0]!.GetGlobalSerialNo(),
      users[2]!.GetGlobalSerialNo(),
      payload,
    );
    await expect(peers[2]!.Read(50)).rejects.toThrow("No datagram");
  } finally {
    for (const s of tcp) s.Close();
    await relay.Cleanup();
    for (const peer of peers) await peer.Close();
  }
});
