/** A16 fatal paths must be tested out of process, without mocking process.exit. */
import { CBillingSocketTw } from "../../src/FXSS/CBillingSocketTw.ts";
import { CSendPacket } from "../../src/FXSS/Packet.ts";
import { CBillingProcess } from "../../src/FXSS/Shop.ts";
import type { CDBMan } from "../../src/db/DBMan.ts";

const mode = process.argv[2];
const socket = new CBillingSocketTw(true, {
  onClose: s => console.log(`closed:${s.m_nSndCnt}:${s.m_nRcvCnt}`),
});
socket.m_bConnected = true;
socket.bunSocket = {
  write: () => {
    if (mode === "write-throw") throw new Error("fixture transport failure");
    return -1;
  },
  end: () => {},
} as unknown as Bun.Socket;

switch (mode) {
  case "overflow":
    socket.m_nSndCnt = socket.m_mbSndBuffer.length;
    socket.PutPacket(new CSendPacket(351));
    break;
  case "empty":
    socket.OnReceive(Buffer.from("0000000000000007", "hex"));
    break;
  case "too-long":
    socket.OnReceive(Buffer.from("0001000000000007", "hex"));
    break;
  case "receive-overflow":
    socket.m_nRcvCnt = socket.m_mbRcvBuffer.length;
    socket.OnReceive(Uint8Array.of(0));
    break;
  case "write-negative":
  case "write-throw":
    socket.SendPacket(new CSendPacket(351));
    break;
  case "hello-write": {
    const billing = new CBillingProcess({} as CDBMan);
    billing.m_aBillingSvr = [{ SN: 1, ip: "fixture", port: 1 }];
    Reflect.set(Bun, "connect", (options: { socket: Bun.SocketHandler }) => {
      const transport = {
        write: () => -1,
        end: () => console.log("hello-closed"),
      } as unknown as Bun.Socket;
      options.socket.open!(transport);
      return Promise.resolve(transport);
    });
    await billing.ConnectToSvr();
    break;
  }
  default:
    throw new Error(`unknown fatal fixture ${mode}`);
}
console.log("incorrectly returned from fatal path");
process.exit(23);
