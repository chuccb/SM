import { describe, expect, test } from "bun:test";
import { cUnreliableQueueIn } from "../src/LS/cUnreliableQueueIn.ts";

describe("cUnreliableQueueIn native record layout", () => {
  test("uses the byte store from index zero and drops a truncated record in full", () => {
    const queue = new cUnreliableQueueIn();
    queue.AddPacket(4, Uint8Array.of(1, 2, 3), 3, 100);
    queue.AddPacket(6, Uint8Array.of(4, 5), 2, 101);

    expect(queue.m_nPacketCount).toBe(7); // the native writes caller value + 1
    expect(queue.m_dwLastTick).toBe(101);

    const first = new Uint8Array(2);
    expect(queue.GetPacket(first, first.byteLength)).toBe(2);
    expect([...first]).toEqual([1, 2]);

    const second = new Uint8Array(2);
    expect(queue.GetPacket(second, second.byteLength)).toBe(2);
    expect([...second]).toEqual([4, 5]);
    expect(queue.GetPacket(second, second.byteLength)).toBe(0);
  });

  test("preserves the native +2 capacity gate without object-offset truncation", () => {
    const queue = new cUnreliableQueueIn();
    const fullPayload = new Uint8Array(cUnreliableQueueIn.MAX_PACKET);

    for (let i = 0; i < 47; i++) {
      fullPayload.fill(i);
      queue.AddPacket(0, fullPayload, fullPayload.byteLength, i);
    }

    const tailLength =
      cUnreliableQueueIn.CAPACITY -
      queue.m_nCount -
      2; // CxLogin.exe.c:26195 uses count + len + 2
    const tail = new Uint8Array(tailLength).fill(0xa5);
    queue.AddPacket(0, tail, tail.byteLength, 47);
    expect(queue.m_nCount).toBe(cUnreliableQueueIn.CAPACITY + 2);

    const out = new Uint8Array(cUnreliableQueueIn.MAX_PACKET);
    for (let i = 0; i < 47; i++) {
      expect(queue.GetPacket(out, out.byteLength)).toBe(out.byteLength);
      expect(out.every((value) => value === i)).toBe(true);
    }
    out.fill(0);
    expect(queue.GetPacket(out, out.byteLength)).toBe(tailLength);
    expect(out.subarray(0, tailLength).every((value) => value === 0xa5)).toBe(true);
    expect(queue.m_nCount).toBe(0);
  });

  test("Clear resets only queued bytes, like the native method", () => {
    const queue = new cUnreliableQueueIn();
    queue.AddPacket(8, Uint8Array.of(1), 1, 123);
    queue.Clear();
    expect(queue.m_nCount).toBe(0);
    expect(queue.m_nPacketCount).toBe(9);
    expect(queue.m_dwLastTick).toBe(123);
  });
});
