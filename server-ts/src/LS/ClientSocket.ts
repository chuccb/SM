/** Native source unit: CX/CxLogin/ClientSocket.cpp. */
import { timeGetTime } from "../core/timeGetTime.ts";
import { CPacketSocket } from "../core/PacketSocket.ts";
import { PACKET_HEADER_TYPE_COUNT } from "../core/PacketHeaderConverter.ts";
import { enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
} from "../core/PacketSocket.ts";
import { CUser } from "./User.ts";
import { DeleteLoginSocket, DispatchLoginPacket } from "./runtime/LoginRuntime.ts";

export const MACHINE_ID_BYTES = 16;

const INITIAL_RTT_AGE_MS = 5_000;
const LOGIN_ATTEMPT_LIMIT = 30;
const LOGIN_BURST_WINDOW_MS = 3_000;
const LOGIN_BURST_LIMIT = 10;

/** The client's IPv4 as the raw in_addr dword (CClientSocket+12). */
export function PeerAddressDword(socket: CClientSocket): number {
  let addr = socket.bunSocket?.remoteAddress ?? "";
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (!m) return 0;
  return ((Number(m[1]) | (Number(m[2]) << 8) | (Number(m[3]) << 16) | (Number(m[4]) << 24)) >>> 0);
}

/** CClientSocket — one connected game client (CxLogin.exe.c:9880). */
export class CClientSocket extends CPacketSocket {
  /** CClientSocket::OnReceiveCompletionPacket guards the client links only
   *  (CxLogin.exe.c:9753). */
  override m_fReceiveFloodGuard = true;
  protected override ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), disconnected.`);
  }

  protected override ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CClientSocket::PutPacket's wrapper switch (CxLogin.exe.c:9568). */
  protected override ReportPutError(err: EnSocket): void {
    if (err === enSocket.kioNotConnected) console.error("Not-connected client socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet");
  }
  static ms_nLocalSerialNo = 1;
  /** dword_49F968 — the per-connection header-type counter. It starts at 0
   *  and is separate from the serial: the first client connection gets
   *  header type 0 (CxLogin.exe.c:9898, CxUtil.exe.c:17717). */
  static override ms_nHeaderTypeCounter = 0;
  /** CClientSocket::ms_tblSN2Obj — local serial → socket. */
  static ms_tblSN2Obj = new Map<number, CClientSocket>();

  m_nLocalSerialNo = 0; // +236
  m_nNoticeHash = 0; // +248 — the client's cached CConfigDyn notice hash
  m_nGameRoomCode = 0; // +472
  m_apUser: (CUser | null)[] = []; // +480
  m_nUserCount = 0; // +476
  m_machineId = new Uint8Array(MACHINE_ID_BYTES); // +456
  m_nFlushCount = 0; // +492
  m_nLoginCount = 0; // +496
  m_dwFlushTime = 0; // +500
  m_dwLastRTT = (timeGetTime() - INITIAL_RTT_AGE_MS) >>> 0; // +488

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      // the original's vtable routes completed packets into CLoginPool::OnPacket
      onPacket: (_sock, packet) => DispatchLoginPacket(packet, this),
    });
    this.m_szLogTag = "LS";
    this.m_fClientLink = true;
    // dword_49F968: the header type comes from the counter's PRE-increment
    // value (read the counter, THEN increment; SetHeaderType(counter % 16)) — the
    // first client connection gets header type 0.
    this.SetHeaderType(CClientSocket.ms_nHeaderTypeCounter % PACKET_HEADER_TYPE_COUNT);
    CClientSocket.ms_nHeaderTypeCounter++;
    this.m_nLocalSerialNo = CClientSocket.ms_nLocalSerialNo++;
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
    this.m_dwFlushTime = timeGetTime();
    CClientSocket.ms_tblSN2Obj.set(this.m_nLocalSerialNo, this);
  }

  /** CClientSocket::GetSocketFromLocalSerialNo */
  static GetSocketFromLocalSerialNo(serialNo: number): CClientSocket | null {
    return CClientSocket.ms_tblSN2Obj.get(serialNo) ?? null;
  }

  /** CClientSocket::GetLocalSerialNo */
  GetLocalSerialNo(): number {
    return this.m_nLocalSerialNo;
  }

  /** CClientSocket::SetGameRoomCode */
  SetGameRoomCode(code: number): void {
    this.m_nGameRoomCode = code;
  }

  GetGameRoomCode(): number {
    return this.m_nGameRoomCode;
  }

  /** CClientSocket::SetMachineId */
  SetMachineId(machineId: Uint8Array): void {
    this.m_machineId.set(machineId.subarray(0, MACHINE_ID_BYTES));
  }

  GetMachineId(): Uint8Array {
    return this.m_machineId;
  }

  /** CClientSocket::AddNewUsers */
  AddNewUsers(count: number): void {
    this.m_apUser = [];
    for (let i = 0; i < count; i++) this.m_apUser.push(new CUser(this));
    this.m_nUserCount = count;
  }

  GetUser(i: number): CUser | null {
    return this.m_apUser[i] ?? null;
  }

  GetUserCount(): number {
    return this.m_nUserCount;
  }

  /** CClientSocket::ClearAttachedUsers — native SetFree reaches
   * CUser::SafeFree for every attached user before the pointers are cleared. */
  ClearAttachedUsers(): void {
    for (const user of this.m_apUser) user?.SafeFree();
    this.m_apUser = [];
    this.m_nUserCount = 0;
  }

  /**
   * CClientSocket::CheckLoginFlush — anti-flood (CxLogin.exe.c:8309): at
   * most 30 logins per socket; a login within 3 s of the previous one
   * increments the burst counter, and the 10th burst login fails.
   */
  CheckLoginFlush(): boolean {
    this.m_nLoginCount++;
    if (this.m_nLoginCount > LOGIN_ATTEMPT_LIMIT) return false;
    const now = timeGetTime();
    if (((now - this.m_dwFlushTime) >>> 0) < LOGIN_BURST_WINDOW_MS) {
      this.m_nFlushCount++;
      if (this.m_nFlushCount >= LOGIN_BURST_LIMIT) return false;
    }
    this.m_dwFlushTime = now;
    return true;
  }

  /** CClientSocket::SafeFree seats each CUser for its own SafeFree path.
   * The +248 dword is only the notice hash; center deletion uses each user's
   * global serial (CUser::SafeFree, 004177F0). */
  protected override OnClose(): void {
    this.ClearAttachedUsers();
    DeleteLoginSocket(this);
    CClientSocket.ms_tblSN2Obj.delete(this.m_nLocalSerialNo);
    this.m_nLocalSerialNo = 0;
    super.OnClose();
  }
}
