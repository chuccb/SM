/** The test-only peer's packet queue/waiters, not server protocol parity.
 * Inject at the decoded-packet boundary; e2e.test.ts exercises real TCP.
 */
import { expect, test } from "bun:test";
import { TestClient } from "./TestClient.ts";

function deliver(client: TestClient, opcode: number, value: number) {
  Reflect.apply(Reflect.get(client, "dispatch"), client, [opcode, Uint8Array.of(opcode, value), 1, 0]);
}

test("TestClient: inspect/discard buffered packets without exposing the queue", async () => {
  const client = new TestClient();
  deliver(client, 5, 42);
  expect(client.hasPending(5)).toBe(true);
  const packet = await client.recv(5);
  expect(packet.buf[packet.off]).toBe(42);
  expect(client.hasPending(5)).toBe(false);
  deliver(client, 5, 99);
  deliver(client, 71, 1);
  client.discardPending();
  expect(client.hasPending(5)).toBe(false);
  expect(client.hasPending(71)).toBe(false);
  client.close();
});

test("TestClient: local close rejects pending reads immediately and is idempotent", async () => {
  const client = new TestClient();
  const first = client.recv(5, 1000).catch((error: Error) => error);
  const second = client.recv(71, 1000).catch((error: Error) => error);
  client.close();
  client.close();
  expect(client.closed).toBe(true);
  expect(await first).toMatchObject({ message: "client closed" });
  expect(await second).toMatchObject({ message: "client closed" });
  await expect(client.recv(5)).rejects.toThrow("socket closed");
});

test("TestClient: peer close/error rejects with the actual transport failure", async () => {
  const client = new TestClient();
  const read = client.recv(5, 1000).catch((error: Error) => error);
  Reflect.apply(Reflect.get(client, "rejectWaiters"), client, [new Error("socket error: fixture")]);
  expect(await read).toMatchObject({ message: "socket error: fixture" });
  expect(client.closed).toBe(true);
});

test("TestClient: a shorter second timeout must not remove the older same-opcode waiter", async () => {
  const client = new TestClient();
  const older = client.recv(5, 1000);
  try {
    await expect(client.recv(5, 10)).rejects.toThrow("timeout waiting for packet 5");
    deliver(client, 5, 77);
    const packet = await older;
    expect(packet.buf[packet.off]).toBe(77);
    expect(client.hasPending(5)).toBe(false);
  } finally { client.close(); }
});
