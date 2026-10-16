import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CServerApp } from "../CServerApp.ts";
import { CServerConfig } from "../Common/CServerConfig.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import type { CSendPacketBase } from "../Common/CSendPacketBase.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CUser } from "../Common/CUser.ts";
import { CipherDegree, ServerType } from "../Common/OfficialValues.ts";
import { EncodeUnregisteredDatagram } from "../Common/MTUDPProtocol.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { TestConfig, UserInfo } from "./helpers/Accounts.ts";
import { UDPPeer, closeUDP, closeTCP, reservePair } from "./helpers/UDP.ts";

class ObservedClient extends MemoryClient {
  private readonly changed = new Set<() => void>();
  override SendPacket(packet: CSendPacketBase): void {
    super.SendPacket(packet);
    for (const changed of this.changed) changed();
  }
  async WaitFor(opcode: number): Promise<CReceivedPacketBase> {
    const take = () => {
      const index = this.packets.findIndex((p) => p.m_nPacketType === opcode);
      return index >= 0 ? this.packets.splice(index, 1)[0] : undefined;
    };
    const current = take();
    if (current) return current;
    return new Promise((resolve, reject) => {
      const ready = () => {
        const packet = take();
        if (!packet) return;
        clearTimeout(timer);
        this.changed.delete(ready);
        resolve(packet);
      };
      const timer = setTimeout(() => {
        this.changed.delete(ready);
        reject(new Error(`No TCP discovery response ${opcode}`));
      }, 2000);
      this.changed.add(ready);
    });
  }
}
function payload(user: CUser, type = 11): Buffer {
  const packet = new CSendPacket(type, CipherDegree.None)
    .Encode4(user.m_nGlobalSerialNo)
    .Encode2(user.m_nSessionIdx)
    .Encode4(user.m_nSessionSerialNo)
    .Encode4(0x0a010203)
    .Encode2(7777)
    .Encode4(0)
    .Encode2(0);
  if (type === 1)
    packet
      .Encode4(3618572696)
      .EncodeBuffer(Buffer.from([8, 3, 3, 6, 9, 3, 3, 5]));
  return packet.GetBuffer();
}
/** Authentication is SYNTHETIC trusted test setup here. Actual TCP login and
 * handoff have separate integration tests; this verifies REAL UDP and app glue,
 * not an official client or an independent full-protocol interoperability test. */
function members(app: CServerApp, a: ObservedClient, b: ObservedClient) {
  const server = app.m_center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!;
  app.m_center.OnAddNewUser(a, server, [UserInfo("A"), UserInfo("A2")]);
  app.m_center.OnAddNewUser(b, server, [UserInfo("B")]);
  const sessions = app.m_gameServers[0]!.m_gameSessionTable;
  sessions.OnPacket(
    Received(
      new CSendPacket(80)
        .EncodeStr("UDP integration")
        .EncodeStr("")
        .Encode1(0)
        .Encode1(2)
        .Encode1(10)
        .Encode1(10),
    ),
    a,
  );
  const room = sessions.GetSession(a)!;
  sessions.DoJoinSession(b, room.m_nIdx, room.m_ulSerialNo, "", [0]);
  a.Clear();
  b.Clear();
  return { room, server };
}

test("real optional GS UDP uses TCP+1, atomically rejects malformed datagrams, publishes TCP 120 without UDP replies or starting battle", async () => {
  const reserved = await reservePair();
  const config = TestConfig();
  config.FXGS.UDPEnabled = true;
  config.FXGS.Channels[0]!.Port = reserved.port;
  const app = new CServerApp(config);
  const a = new ObservedClient();
  const b = new ObservedClient();
  const udp = new UDPPeer();
  await closeTCP(reserved.tcp);
  await closeUDP(reserved.udp);
  try {
    await app.SetUp();
    const gs = app.m_gameServers[0]!;
    expect(gs.m_udpServer.port).toBe(gs.m_listenSocket.port + 1);
    expect(
      app
        .GetStatus()
        .listeners.some(
          (s) =>
            s.service === "FXGS-0 discovery UDP" &&
            s.port === gs.m_udpServer.port,
        ),
    ).toBe(true);
    const { room } = members(app, a, b);
    await udp.Bind();
    await udp.Send(
      gs.m_udpServer.port,
      Buffer.concat([
        EncodeUnregisteredDatagram(Buffer.alloc(0)),
        EncodeUnregisteredDatagram(payload(a.m_aUser[0]!, 1)),
        // Native HostDestroy drops the rest after handling the first nonempty
        // queued payload, EVEN WHEN that first payload was the type-1 no-op.
        EncodeUnregisteredDatagram(payload(a.m_aUser[0]!)),
      ]),
    );
    // Valid first frame followed by a truncated frame must publish NOTHING.
    await udp.Send(
      gs.m_udpServer.port,
      Buffer.concat([
        EncodeUnregisteredDatagram(payload(a.m_aUser[0]!)),
        Buffer.from([1]),
      ]),
    );
    // Same UDP socket/receive stream: B's normal publication is a barrier,
    // not an invented application ack or an arbitrary sleep/polling loop.
    await udp.Send(
      gs.m_udpServer.port,
      EncodeUnregisteredDatagram(payload(b.m_aUser[0]!)),
    );
    expect((await a.WaitFor(120)).m_nPacketType).toBe(120);
    expect((await b.WaitFor(120)).m_nPacketType).toBe(120);
    expect(room.HasUDPPeerInfo(0)).toBe(false);
    expect(room.HasUDPPeerInfo(1)).toBe(false);
    expect(room.HasUDPPeerInfo(2)).toBe(true);
    await udp.Send(
      gs.m_udpServer.port,
      Buffer.concat([
        // cUnreliableQueueIn::AddPacket does not queue an empty payload, so
        // an empty frame must NOT swallow the subsequent discovery message.
        EncodeUnregisteredDatagram(Buffer.alloc(0)),
        EncodeUnregisteredDatagram(payload(a.m_aUser[0]!)),
      ]),
    );
    await a.WaitFor(120);
    await b.WaitFor(120);
    expect(room.HasUDPPeerInfo(0)).toBe(true);
    expect(room.HasUDPPeerInfo(1)).toBe(true);
    expect(room.GetUDPPeerHosts(0).map((h) => [h.Address, h.Port])).toEqual([
      [0x7f000001, udp.port],
      [0x0a010203, 7777],
      [0, 0],
    ]);
    expect(room.GetUDPPeerHosts(1)).toEqual(room.GetUDPPeerHosts(0));
    expect(room.m_bPlaying).toBe(false);
    expect(udp.packets).toEqual([]);
    expect(
      [...a.packets, ...b.packets].some((p) => p.m_nPacketType === 150),
    ).toBe(false);
    await expect(gs.m_udpServer.Startup("127.0.0.1", 0)).rejects.toThrow(
      "already started",
    );
  } finally {
    a.Close();
    b.Close();
    await app.CleanUp();
    await closeUDP(udp.socket);
  }
  expect(app.GetStatus().listeners.every((s) => s.port === 0)).toBe(true);
});
test("real GS UDP rejects mismatched TCP IP and a pending/foreign/marked-free member of a local-player pair", async () => {
  for (const reason of [
    "TCP-IP",
    "paired-pending",
    "paired-other-server",
    "paired-marked-free",
  ]) {
    const reserved = await reservePair();
    const config = TestConfig();
    config.FXGS.UDPEnabled = true;
    config.FXGS.Channels[0]!.Port = reserved.port;
    const app = new CServerApp(config);
    const a = new ObservedClient(
      reason === "TCP-IP" ? "127.0.0.2" : "127.0.0.1",
    );
    const b = new ObservedClient();
    const udp = new UDPPeer();
    await closeTCP(reserved.tcp);
    await closeUDP(reserved.udp);
    try {
      await app.SetUp();
      const { room } = members(app, a, b);
      const partner = app.m_center.m_globalUserTable.GetUser(
        a.m_aUser[1]!.m_nGlobalSerialNo,
      )!;
      const login = app.m_center.m_localServerMan.GetSvr(ServerType.Login, 0)!;
      if (reason === "paired-pending")
        partner.m_pendingConnection = {
          source: a,
          // Synthetic rejection-only pending record, NOT an issued auth lease.
          sourceServer: partner.m_pLocalServer!,
          sourceGeneration: partner.m_pLocalServer!.GetConnectionGeneration(),
          target: login,
          targetGeneration: login.GetConnectionGeneration(),
          users: [partner],
          address: a.address,
          expires: Date.now() + 30000,
        };
      if (reason === "paired-other-server") partner.m_pLocalServer = login;
      if (reason === "paired-marked-free") partner.SetFree();
      await udp.Bind();
      await udp.Send(
        app.m_gameServers[0]!.m_udpServer.port,
        EncodeUnregisteredDatagram(payload(a.m_aUser[0]!)),
      );
      await udp.Send(
        app.m_gameServers[0]!.m_udpServer.port,
        EncodeUnregisteredDatagram(payload(b.m_aUser[0]!)),
      );
      await a.WaitFor(120);
      await b.WaitFor(120);
      expect(room.HasUDPPeerInfo(0)).toBe(false);
      expect(room.HasUDPPeerInfo(1)).toBe(false);
      expect(room.HasUDPPeerInfo(2)).toBe(true);
      expect(a.IsConnected()).toBe(true);
      expect(udp.packets).toEqual([]);
    } finally {
      a.Close();
      b.Close();
      await app.CleanUp();
      await closeUDP(udp.socket);
    }
  }
});
test("GS UDP bind failure rolls back its TCP listener, Center state and SQLite, leaving the occupied port alone", async () => {
  const reserved = await reservePair();
  const config = TestConfig();
  config.FXGS.UDPEnabled = true;
  config.FXGS.Channels[0]!.Port = reserved.port;
  const app = new CServerApp(config);
  await closeTCP(reserved.tcp);
  try {
    await expect(app.SetUp()).rejects.toThrow();
    expect(app.GetStatus().processReady).toBe(false);
    expect(app.GetStatus().listeners.every((s) => s.port === 0)).toBe(true);
    expect(
      app.m_center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!.m_bConnected,
    ).toBe(false);
    expect(() => app.m_dbSession.db.query("SELECT 1").get()).toThrow();
    expect(typeof reserved.udp.address()).toBe("object");
    await app.CleanUp();
  } finally {
    await app.CleanUp();
    await closeUDP(reserved.udp);
  }
});
test("GS UDP config defaults off, rejects non-boolean enablement, TCP+1 overflow and Relay UDP collisions", () => {
  mkdirSync(".analysis/test-configs", { recursive: true });
  const original = readFileSync("Config/Server.toml", "utf8");
  const load = (name: string, content: string) => {
    const path = `.analysis/test-configs/${name}.toml`;
    writeFileSync(path, content);
    return () => CServerConfig.Load(path);
  };
  expect(CServerConfig.Load().FXGS.UDPEnabled).toBe(false);
  expect(
    load("udp-unspecified", original.replace("UDPEnabled = false", ""))().FXGS
      .UDPEnabled,
  ).toBe(false);
  expect(() =>
    load(
      "udp-invalid",
      original.replace("UDPEnabled = false", 'UDPEnabled = "yes"'),
    )(),
  ).toThrow("boolean");
  const enabled = original.replace("UDPEnabled = false", "UDPEnabled = true");
  expect(load("udp-enabled", enabled)().FXGS.UDPEnabled).toBe(true);
  expect(
    load("udp-overflow", enabled.replace("Port = 4848", "Port = 65535")),
  ).toThrow("65534");
  expect(
    load(
      "udp-relay-collision",
      enabled
        .replace("Enabled = false", "Enabled = true")
        .replace("Port = 9520", "Port = 4849"),
    ),
  ).toThrow("UDP listening ports");
});
