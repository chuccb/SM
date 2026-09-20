/**
 * CLocalSocket / CCenterProcess — the client side of the center link, shared
 * by the login / game / shop / util servers.
 */
import { CPacketSocket, type IPacketSocketHooks } from "../core/CPacketSocket.ts";
import { CipherDegree,
  CReceivedPacket,
  CSendPacket,
  enSocket,
  type enSocket as EnSocket,
} from "../core/Packet.ts";
import {
  CLIENT_VERSION,
  CM_ReceivedPacket,
  CENTER_VERSION,
  GAME_VERSION,
  LOCALSOCKET_HEADER_CODE_MODIFIER,
  LOCALSOCKET_HEADER_CODE_RCV,
  LOCALSOCKET_HEADER_CODE_SND,
  LOCALSOCKET_SEQ,
  LOCALSOCKET_SEQ_DELTA,
  MC_ReceivedPacket,
  SVRIDX_IDENTIFY_XOR,
} from "./S2S.ts";
import { PacketLog } from "../core/PacketLog.ts";

/** CCenterProcess::ConnectToCenter retry loop — Sleep(0xBB8) between
 *  attempts (CxLogin.exe.c:4885). */
export const CENTER_CONNECT_RETRY_MS = 0xbb8;

// the S2S link namespaces: a local server receives CM_* (center → local) and
// sends MC_* (local → center) — the mirror image of CxCenter's own tables.
PacketLog.Register("S2S", "recv", CM_ReceivedPacket);
PacketLog.Register("S2S", "send", MC_ReceivedPacket);

export class CLocalSocket extends CPacketSocket {
  /** "Socket receive buffer overflow on LocalSocket" — the S2S link has no
   *  receive-flood ring (FxServer.exe.c:19062, CxLogin.exe.c:12181). */
  protected ReportReceiveOverflow(): void {
    console.error("Socket receive buffer overflow on LocalSocket");
  }
  constructor(hooks: Partial<IPacketSocketHooks>) {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, hooks);
    this.m_szLogTable = "S2S";
    this.SetHeaderCode(
      LOCALSOCKET_HEADER_CODE_RCV,
      LOCALSOCKET_HEADER_CODE_SND,
      LOCALSOCKET_HEADER_CODE_MODIFIER,
    );
    this.SetSequence(LOCALSOCKET_SEQ, LOCALSOCKET_SEQ, LOCALSOCKET_SEQ_DELTA, LOCALSOCKET_SEQ_DELTA);
  }

  /** CCenterProcess::ConnectToCenter — connect, exchange the identification bytes.
   *  The original loops forever on a refused connect: Sleep(0xBB8) +
   *  Report("Connection failed. Try again.") between attempts (CxLogin.exe.c:4885). */
  async ConnectToCenter(
    host: string,
    port: number,
    nServerClass: number,
    nSvrIdx: number,
    // the identify versions default from the per-class tables (S2S.ts) —
    // callers only pass them to override (tests, fake servers)
    gameVersion = GAME_VERSION[nServerClass] ?? 0,
    clientVersion = CLIENT_VERSION[nServerClass] ?? 0,
  ): Promise<void> {
    console.log("Try to connect center server.");
    for (;;) {
      try {
        await Bun.connect({
          hostname: host,
          port,
          socket: {
            open: (t) => {
              this.bunSocket = t;
              this.m_bConnected = true;
            },
            data: (_t, data) => this.OnCenterData(new Uint8Array(data as Buffer)),
            close: () => {
              this.m_bConnected = false;
              this.hooks.onClose(this);
            },
            error: (_t, err) => {
              console.error(`[CLocalSocket] ${String(err)}`);
            },
          },
        });
        break;
      } catch {
        await Bun.sleep(CENTER_CONNECT_RETRY_MS);
        console.log("Connection failed. Try again.");
      }
    }
    // CServerSocket (center side) greets: [u2 version][u2 sd]; we read 4 raw
    // bytes then identify (CLocalSocket::ConnectToCenter, CxLogin.exe.c).
    const greeting = await this.waitGreeting();
    const version = (greeting[0]! << 8) | greeting[1]!;
    this.centerVersion = version;
    this.serverType = (greeting[2]! << 8) | greeting[3]!;
    if (version !== CENTER_VERSION) throw new Error("Version mismatch, terminate process");
    // Identify: [class:1][idx^0x77:u32 LE][gameVersion:u16][clientVersion:u16]
    const id = new Uint8Array(9);
    id[0] = nServerClass;
    const x = (nSvrIdx ^ SVRIDX_IDENTIFY_XOR) >>> 0;
    id[1] = x & 0xff;
    id[2] = (x >>> 8) & 0xff;
    id[3] = (x >>> 16) & 0xff;
    id[4] = (x >>> 24) & 0xff;
    id[5] = gameVersion & 0xff;
    id[6] = (gameVersion >>> 8) & 0xff;
    id[7] = clientVersion & 0xff;
    id[8] = (clientVersion >>> 8) & 0xff;
    this.bunSocket!.write(id);
  }

  private greetingResolve: ((b: Uint8Array) => void) | null = null;
  private greetingBuf = new Uint8Array(0);
  centerVersion = 0;
  serverType = 0;

  private waitGreeting(): Promise<Uint8Array> {
    if (this.greetingBuf.length >= 4) return Promise.resolve(this.greetingBuf);
    return new Promise((resolve, reject) => {
      this.greetingResolve = resolve;
      setTimeout(() => reject(new Error("center greeting timeout")), 10_000);
    });
  }

  /** The center link speaks the same framed protocol after the 4-byte greeting. */
  OnCenterData(data: Uint8Array): void {
    if (this.greetingResolve) {
      const need = 4 - this.greetingBuf.length;
      const take = data.subarray(0, need);
      const nb = new Uint8Array(this.greetingBuf.length + take.length);
      nb.set(this.greetingBuf);
      nb.set(take, this.greetingBuf.length);
      this.greetingBuf = nb;
      if (this.greetingBuf.length >= 4) {
        const r = this.greetingResolve;
        this.greetingResolve = null;
        r(this.greetingBuf);
      }
      data = data.subarray(need);
      if (data.length === 0) return;
    }
    this.OnReceive(data);
  }

  /** CCenterProcess::SendPacket to center. */
  SendToCenter(packet: CSendPacket): EnSocket {
    return this.SendPacket(packet);
  }

  PostClosePacket(): void {
    this.Close();
  }

  static makeReceived(): CReceivedPacket {
    const p = new CReceivedPacket();
    p.SetCipherDegree(CipherDegree.kPacketRaw);
    return p;
  }
}

export function enSocketName(v: EnSocket): string {
  for (const [k, n] of Object.entries(enSocket)) if (n === v) return k;
  return String(v);
}
