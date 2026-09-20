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
  CENTER_GREETING_SIZE,
  LOCAL_SERVER_IDENTIFICATION_SIZE,
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
/** Existing port timeout for a peer that connects but never finishes its greeting. */
const CENTER_GREETING_TIMEOUT_MS = 10_000;

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

  /** "LocalSocket send buffer overflow, terminate process" — the original
   *  closes and kills the server; the port closes and lets the reconnect
   *  logic re-establish the link (infra-only deviation). */
  protected ReportSendOverflow(): void {
    console.error("LocalSocket send buffer overflow, terminate process");
  }

  /** CLocalSocket::GetPacket's local-link family (FxServer.exe.c:19114,
   *  CxCenter.exe.c:14936 — the monitor link shares the wording). */
  protected ReportInvalidPacketLine(addr: string): void {
    console.error(`Invalid( = NULL ) packet received from local socket, close connection: [${addr}]`);
  }
  protected ReportTooLongPacketLine(addr: string, id: number): void {
    console.error(`Too long packet length read from local socket, close connection: [${addr}], packet id[${id}]`);
  }
  protected ReportSequencingErrorLine(addr: string): void {
    console.error(`Error in local packet sequencing, close connection: [${addr}]`);
  }
  protected ReportDecodingErrorLine(addr: string): void {
    console.error(`Error in local packet decoding(Maybe CRC Mismatch), close connection: [${addr}]`);
  }

  /** CLocalSocket::PutPacket's wrapper switch (FxServer.exe.c:19180). */
  protected ReportPutError(err: EnSocket): void {
    if (err === enSocket.kioNotConnected) console.error("Not-connected local socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet to local socket");
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
      this.m_fIdentifying = true;
      this.greetingBuf = new Uint8Array(0);
      try {
        await Bun.connect({
          hostname: host,
          port,
          socket: {
            open: (t) => {
              this.bunSocket = t;
              this.m_bConnected = true;
            },
            data: (t, data) => {
              if (this.bunSocket === t) this.OnCenterData(new Uint8Array(data as Buffer));
            },
            drain: (t) => { if (this.bunSocket === t) this.Flush(); },
            close: (t) => { if (this.bunSocket === t) this.Close(); },
            error: (_t, err) => {
              console.error(`[CLocalSocket] ${String(err)}`);
              if (this.bunSocket === _t) this.Close();
            },
          },
        });
      } catch {
        this.Close();
        await Bun.sleep(CENTER_CONNECT_RETRY_MS);
        console.log("Connection failed. Try again.");
        continue;
      }
      // CServerSocket (center side) greets: [u2 version][u2 sd]; we read 4
      // raw bytes then identify (CLocalSocket::ConnectToCenter).  A drop
      // inside this window reports and restarts the whole connect
      // (FxServer.exe.c:3680); a version mismatch reports and terminates
      // (:3714, CxLogin.exe.c:4922).
      let greeting: Uint8Array;
      try {
        greeting = await this.waitGreeting();
      } catch {
        console.error("Center server disconnected while identifying");
        this.Close();
        continue; // LABEL_4 — back into the connect loop
      }
      const version = (greeting[0]! << 8) | greeting[1]!;
      this.centerVersion = version;
      this.serverType = (greeting[2]! << 8) | greeting[3]!;
      if (version !== CENTER_VERSION) {
        console.error("Version mismatch, terminate process");
        this.Close();
        // CMainSystem::TerminateProcess (FxServer.exe.c:20645)
        console.log("CMainSystem:TerminateProcess() called, ExitProcess();");
        process.exit(0);
      }
      // Identify: [class:1][idx^0x77:u32 LE][gameVersion:u16][clientVersion:u16]
      const id = new Uint8Array(LOCAL_SERVER_IDENTIFICATION_SIZE);
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
      if (this.SendBuffer(id) !== enSocket.kioOk || !this.m_bConnected) {
        this.Close();
        continue;
      }
      this.m_fIdentifying = false;
      // Any coalesced framed data must dispatch only AFTER identification
      // has joined the send FIFO; replies cannot overtake those raw bytes.
      if (this.m_nRcvCnt > 0) this.OnReceiveCompletionPacket();
      break;
    }
  }

  private m_fIdentifying = false;
  private greetingResolve: ((b: Uint8Array) => void) | null = null;
  private greetingReject: ((reason: Error) => void) | null = null;
  private greetingBuf = new Uint8Array(0);
  centerVersion = 0;
  serverType = 0;

  private waitGreeting(): Promise<Uint8Array> {
    if (!this.m_bConnected) return Promise.reject(new Error("center disconnected"));
    if (this.greetingBuf.length === CENTER_GREETING_SIZE) return Promise.resolve(this.greetingBuf);
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.greetingResolve = null;
        this.greetingReject = null;
      };
      const timer = setTimeout(() => this.greetingReject?.(new Error("center greeting timeout")), CENTER_GREETING_TIMEOUT_MS);
      this.greetingResolve = (bytes) => { finish(); resolve(bytes); };
      this.greetingReject = (error) => { finish(); reject(error); };
    });
  }

  protected OnClose(): void {
    if (this.m_fIdentifying) {
      // The official connect loop retries a drop during identification; only
      // an established center-link loss goes to the service's fatal hook.
      this.greetingReject?.(new Error("center disconnected while identifying"));
      return;
    }
    super.OnClose();
  }

  /** Collect the greeting even if Bun delivers data before connect resolves.
   *  Coalesced framed bytes stay in the ordinary bounded receive buffer. */
  OnCenterData(data: Uint8Array): void {
    if (!this.m_bConnected) return;
    if (!this.m_fIdentifying) {
      this.OnReceive(data);
      return;
    }
    const take = Math.min(CENTER_GREETING_SIZE - this.greetingBuf.length, data.length);
    if (take > 0) {
      const bytes = new Uint8Array(this.greetingBuf.length + take);
      bytes.set(this.greetingBuf);
      bytes.set(data.subarray(0, take), this.greetingBuf.length);
      this.greetingBuf = bytes;
    }
    const rest = data.subarray(take);
    if (this.m_nRcvCnt + rest.length > this.m_mbRcvBuffer.length) {
      this.ReportReceiveOverflow();
      this.PostClosePacket();
      return;
    }
    this.m_mbRcvBuffer.set(rest, this.m_nRcvCnt);
    this.m_nRcvCnt += rest.length;
    if (this.greetingBuf.length === CENTER_GREETING_SIZE) this.greetingResolve?.(this.greetingBuf);
  }

  /** CCenterProcess::SendPacket to center. */
  SendToCenter(packet: CSendPacket): EnSocket {
    return this.SendPacket(packet);
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
