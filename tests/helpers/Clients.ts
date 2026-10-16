import { Socket, createConnection } from "node:net";
import { CClientSocket } from "../../Common/CClientSocket.ts";
import { CTextCodec } from "../../Common/CTextCodec.ts";
import { CReceivedPacketBase } from "../../Common/CReceivedPacketBase.ts";
import { CSendPacket } from "../../Common/CSendPacket.ts";
import type { CSendPacketBase } from "../../Common/CSendPacketBase.ts";
import { CPacketSocket } from "../../Common/CPacketSocket.ts";
import { CBufferManipulator as BM } from "../../Common/CBufferManipulator.ts";
import { CipherDegree } from "../../Common/OfficialValues.ts";

/** Unit-test transport, never used by the running server. */
export class MemoryClient extends CClientSocket {
  readonly packets: CReceivedPacketBase[] = [];
  constructor(address = "127.0.0.1") {
    const raw = new Socket();
    Object.defineProperty(raw, "remoteAddress", { value: address });
    super(raw, 1, 0, new CTextCodec());
  }
  override SendPacket(packet: CSendPacketBase): void {
    this.packets.push(
      new CReceivedPacketBase(
        packet.GetBuffer(),
        packet.GetCipherDegree(),
        this.text,
      ),
    );
  }
  Take(opcode?: number): CReceivedPacketBase {
    const p = this.packets.shift();
    if (!p || (opcode !== undefined && p.Decode1() !== opcode))
      throw new Error(`Expected packet ${opcode}; got ${p?.m_nPacketType}`);
    return p;
  }
  Clear(): void {
    this.packets.length = 0;
  }
}
export function Received(packet: CSendPacket): CReceivedPacketBase {
  return new CReceivedPacketBase(
    packet.GetBuffer(),
    packet.GetCipherDegree(),
    packet.text,
  );
}

/** Test peer uses the production codec for TCP integration ONLY; byte correctness
 * is separately covered by the frozen manually translated native fixtures. */
export class WireClient {
  readonly codec = new CPacketSocket({
    receiveBase: 102,
    sendBase: 192,
    cipherDegree: CipherDegree.None,
  });
  private buffer = Buffer.alloc(0);
  private changed: (() => void) | undefined;
  private closed = false;
  readonly raw: Socket;
  constructor(port: number) {
    this.raw = createConnection({ host: "127.0.0.1", port });
    this.raw.on("data", (b) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(b)]);
      this.changed?.();
    });
    this.raw.on("error", () => {
      this.closed = true;
      this.changed?.();
    });
    this.raw.on("close", () => {
      this.closed = true;
      this.changed?.();
    });
  }
  async Read(
    degree: CipherDegree = CipherDegree.CRC8,
    timeoutMilliseconds = 3000,
  ): Promise<CReceivedPacketBase> {
    const deadline = Date.now() + timeoutMilliseconds;
    for (;;) {
      if (this.buffer.length >= 3) {
        const body =
          degree === CipherDegree.None
            ? BM.Decode2(this.buffer, 1)
            : BM.Decrypt2(this.buffer, 1);
        const length =
          body +
          (degree === CipherDegree.None
            ? 3
            : degree === CipherDegree.CRC32
              ? 7
              : 4);
        if (length <= this.buffer.length) {
          const frame = this.buffer.subarray(0, length);
          this.buffer = Buffer.from(this.buffer.subarray(length));
          this.codec.m_nCipherDegree = degree;
          return this.codec.GetPackets(frame)[0]!;
        }
      }
      if (this.closed)
        throw new Error("Wire client closed before expected packet");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("Wire packet timeout");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.changed = undefined;
          reject(new Error("Wire packet timeout"));
        }, left);
        this.changed = () => {
          clearTimeout(timer);
          this.changed = undefined;
          resolve();
        };
      });
    }
  }
  Send(packet: CSendPacket, split = false): void {
    const frame = this.codec.PutPacket(packet);
    if (split) {
      this.raw.write(frame.subarray(0, 2));
      this.raw.write(frame.subarray(2));
    } else this.raw.write(frame);
  }
  Close(): void {
    this.raw.destroy();
  }
}
