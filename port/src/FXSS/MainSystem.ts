/** Native source unit: FX/FxShop/MainSystem.cpp. */
import { CRand } from "../core/CRand.ts";
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { SC_SendPacket } from "../protocol/PacketIDs.ts";
import { CENTER_VERSION, CONN_HELLO_VERSION, SVRCLASS_SHOP } from "../protocol/CenterProtocol.ts";
import type { CClientSocket } from "./ClientSocket.ts";

/** CMainSystem::OnConnEstablished (FxShop.exe.c:21056) — the client patch URL. */
const CONN_PATCH_URL = "ftp://patch.nexon.co.kr/ca";

/** CMainSystem — the shop's system object; OnConnEstablished pushes the
 *  accept packet (FxShop.exe.c:21041):
 *  0: [E2 CENTER_VERSION][E2 CONN_HELLO_VERSION[class]][E4 headerType][EStr url]. */
export class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  /** Port execution-context state, not an original CMainSystem field.
   * CThread::ProcEntry (0042ABE0) seeds each native worker's CRT state with
   * time(NULL). Bun dispatches Shop requests on one logical worker, so its
   * users share this persistent stream rather than Math.random or per-user
   * reseeding. */
  readonly m_WorkerRandom = new CRand(Math.floor(Date.now() / 1_000));

  m_strChargeUrl = ""; // +2, InitChargeUrl
  m_nFXAttr = 0; // +4, OnInitialSvrAttr / GetDomain
  m_strAuthUrl = ""; // +5, InitAuthUrl

  constructor() {
    CMainSystem.ms_pInstance = this;
  }

  /** CMainSystem::OnInitialSvrAttr — CM 12 [E1 attr][E1 reserved]. */
  OnInitialSvrAttr(packet: CReceivedPacket): void {
    this.m_nFXAttr = packet.Decode1();
    packet.Decode1();
  }

  OnConnEstablished(socket: CClientSocket): void {
    const packet = new CSendPacket(SC_SendPacket.OnConnect);
    packet.Encode2(CENTER_VERSION);
    packet.Encode2(CONN_HELLO_VERSION[SVRCLASS_SHOP]);
    packet.Encode4(socket.m_nHeaderType);
    packet.EncodeStr(CONN_PATCH_URL);
    socket.SendPacket(packet);
  }
}
