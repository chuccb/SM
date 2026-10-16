import { expect, test } from "bun:test";
import { once } from "node:events";
import { CListenSocket } from "../Common/CListenSocket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { WireClient } from "./helpers/Clients.ts";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("TCP listener serializes asynchronous handlers even for coalesced/fragmented packets", async () => {
  const order: number[] = [];
  const began = deferred();
  const release = deferred();
  const listener = new CListenSocket(
    "transport-test",
    new CTextCodec(),
    async (p, s) => {
      p.Decode1();
      const n = p.Decode4();
      p.AssertEnd();
      if (n === 1) {
        began.resolve();
        await release.promise;
      }
      order.push(n);
      s.SendPacket(new CSendPacket(20).Encode4(n));
    },
    (s) =>
      s.SendPacket(
        new CSendPacket(0, CipherDegree.None).Encode4(s.m_nHeaderType!),
      ),
    () => {},
  );
  let peer: WireClient | undefined;
  try {
    await listener.Listen("127.0.0.1", 0);
    peer = new WireClient(listener.port);
    await peer.Read(CipherDegree.None);
    const bytes = Buffer.concat([
      peer.codec.PutPacket(new CSendPacket(20).Encode4(1)),
      peer.codec.PutPacket(new CSendPacket(20).Encode4(2)),
    ]);
    peer.raw.write(bytes.subarray(0, 2));
    peer.raw.write(bytes.subarray(2));
    await began.promise;
    expect(order).toEqual([]);
    release.resolve();
    for (const n of [1, 2]) {
      const p = await peer.Read();
      expect(p.Decode1()).toBe(20);
      expect(p.Decode4()).toBe(n);
      p.AssertEnd();
    }
    expect(order).toEqual([1, 2]);
  } finally {
    release.resolve();
    peer?.Close();
    await listener.Close();
  }
});
test("shutdown drains an already-disconnected socket's in-flight handler before closing DB resources", async () => {
  const began = deferred();
  const release = deferred();
  const disconnected = deferred();
  let completed = false;
  const listener = new CListenSocket(
    "drain-test",
    new CTextCodec(),
    async () => {
      began.resolve();
      await release.promise;
      completed = true;
    },
    (s) =>
      s.SendPacket(
        new CSendPacket(0, CipherDegree.None).Encode4(s.m_nHeaderType!),
      ),
    () => disconnected.resolve(),
  );
  let peer: WireClient | undefined;
  try {
    await listener.Listen("127.0.0.1", 0);
    peer = new WireClient(listener.port);
    await peer.Read(CipherDegree.None);
    peer.Send(new CSendPacket(20).Encode4(1));
    await began.promise;
    peer.Close();
    await disconnected.promise;
    expect(listener.sockets.size).toBe(0);
    const shutdown = listener.Close();
    expect(
      await Promise.race([
        shutdown.then(() => "closed"),
        Bun.sleep(15).then(() => "pending"),
      ]),
    ).toBe("pending");
    release.resolve();
    await shutdown;
    expect(completed).toBe(true);
  } finally {
    release.resolve();
    peer?.Close();
    await listener.Close();
  }
});
test("TCP admission is bounded per IP; closed peers release capacity", async () => {
  const listener = new CListenSocket(
    "admission-test",
    new CTextCodec(),
    () => {},
    (s) =>
      s.SendPacket(
        new CSendPacket(0, CipherDegree.None).Encode4(s.m_nHeaderType!),
      ),
    () => {},
  );
  const peers: WireClient[] = [];
  try {
    await listener.Listen("127.0.0.1", 0);
    for (let i = 0; i < RuntimePolicy.MaxConnectionsPerIP; i++) {
      const peer = new WireClient(listener.port);
      peers.push(peer);
      await peer.Read(CipherDegree.None);
    }
    const extra = new WireClient(listener.port);
    peers.push(extra);
    await expect(extra.Read(CipherDegree.None)).rejects.toThrow("closed");
    const firstServerPeer = [...listener.sockets][0]!;
    const done = once(firstServerPeer.socket, "close");
    peers[0]!.Close();
    await done;
    const replacement = new WireClient(listener.port);
    peers.push(replacement);
    expect((await replacement.Read(CipherDegree.None)).Decode1()).toBe(0);
    expect(listener.sockets.size).toBe(RuntimePolicy.MaxConnectionsPerIP);
  } finally {
    for (const p of peers) p.Close();
    await listener.Close();
  }
});

test("shutdown waits for actual socket onClose ownership cleanup, not only server.close or an empty handler queue", async () => {
  let disconnected = 0,
    resourcesClosed = false;
  const seen: boolean[] = [];
  const listener = new CListenSocket(
    "close-order-test",
    new CTextCodec(),
    () => {},
    (s) =>
      s.SendPacket(
        new CSendPacket(0, CipherDegree.None).Encode4(s.m_nHeaderType!),
      ),
    () => {
      seen.push(resourcesClosed);
      disconnected++;
    },
  );
  let peer: WireClient | undefined;
  try {
    await listener.Listen("127.0.0.1", 0);
    peer = new WireClient(listener.port);
    await peer.Read(CipherDegree.None);
    expect(listener.sockets.size).toBe(1);
    await listener.Close();
    resourcesClosed = true;
    expect(disconnected).toBe(1);
    expect(seen).toEqual([false]);
    expect(listener.sockets.size).toBe(0);
  } finally {
    peer?.Close();
    await listener.Close();
  }
});
