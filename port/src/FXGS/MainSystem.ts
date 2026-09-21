/** Native source unit: FX/FxServer/MainSystem.cpp. */
import { CRand } from "../core/CRand.ts";
import { GetUnixTimeSeconds } from "../core/LocalTime.ts";
import { CServerConfig } from "../core/ServerConfig.ts";
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { GS_ClientSend } from "../protocol/PacketIDs.ts";
import { CENTER_VERSION, CONN_HELLO_VERSION, SVRCLASS_GAME } from "../protocol/CenterProtocol.ts";
import { CONN_PATCH_URL } from "./Defs.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import { DispatchClientPacket } from "./ClientSocketRuntime.ts";

/** CMainSystem — config-derived globals + the client dispatch hook. */
export class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  /** TS execution-context state, not an original CMainSystem field.
   * CThread::ProcEntry (00436E00) seeds each worker with time(NULL), in
   * epoch SECONDS. Bun has one logical request worker, shared by its rooms;
   * other services and the normal timer must not consume this stream.
   * Native IOCP worker scheduling is not emulated (see the RNG audit). */
  readonly m_WorkerRandom = new CRand(GetUnixTimeSeconds());

  m_nGameDomain = 0; // +4
  m_nChannelType = 0; // +8 (MainSystem+8 — chByteType[ServerIndex])
  m_fInventoryDB = 0; // +27 (the entry path's InitUserInventory gate)
  m_nPremiumSvrReward = 0; // CChannelPool ctor fill
  m_nPremiumSvrLuckPro = 30000;
  m_nPremiumLv = 0; // +12 (GetMapLevelLimit's premium-channel discount)

  constructor(cfg: CServerConfig) {
    CMainSystem.ms_pInstance = this;
    this.m_nGameDomain = cfg.GetNumAttribute("GameDomain");
  }

  /** CMainSystem::OnInitialSvrAttr — CM 12 [E1 domain][E1 inventory flag]. */
  OnInitialSvrAttr(packet: CReceivedPacket): void {
    this.m_nGameDomain = packet.Decode1();
    this.m_fInventoryDB = packet.Decode1();
  }

  /** CMainSystem::IsPremiumChannel — the channel type is 41. */
  static IsPremiumChannel(): boolean {
    return CMainSystem.ms_pInstance!.m_nChannelType === 41;
  }

  /** CMainSystem::OnConnEstablished — the connect-time packet 0
   *  a default-constructed (plain) CSendPacket on every server). */
  OnConnEstablished(socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnConnect, CipherDegree.kPacketRaw);
    packet.Encode2(CENTER_VERSION);
    packet.Encode2(CONN_HELLO_VERSION[SVRCLASS_GAME]);
    packet.Encode4(socket.m_nHeaderType);
    packet.EncodeStr(CONN_PATCH_URL);
    socket.SendPacket(packet);
  }

  /** The worker-thread dispatch: connect/channel pool by the socket stage. */
  DispatchClient(n: CReceivedPacket, socket: CClientSocket): void {
    DispatchClientPacket(n, socket);
  }
}
