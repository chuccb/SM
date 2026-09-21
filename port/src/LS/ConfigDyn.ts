/** Native source unit: CX/CxLogin/ConfigDyn.cpp.
 * CConfigDyn — the login server's periodically refreshed dynamic notice. */
import { CipherDegree, CSendPacket } from "../core/Packet.ts";
import { COSmartStream } from "../core/SmartStream.ts";
import type { CDBMan } from "../db/DBMan.ts";
import { LS_ClientSend } from "../protocol/PacketIDs.ts";

/** CConfigDyn::OnTimer refresh cadence (400 ms login timer ticks). */
export const CONFIG_DYN_NOTICE_UPDATE_TICKS = 0x1194; // 4500

export class CConfigDyn {
  static ms_pInstance: CConfigDyn | null = null;

  /** CConfigDyn +4/+16/+52 in the native object. */
  private m_strNotice = "";
  private m_nNoticeHash = 0;
  private m_nTimerCount = 0;
  // Native CConfigDyn starts with CSendPacket(), i.e. no sendable opcode;
  // the first successful UpdateNotice atomically installs packet 7.
  private m_packetNotice = new CSendPacket();

  constructor(private readonly m_db: CDBMan) {
    CConfigDyn.ms_pInstance = this;
  }

  /** CConfigDyn::UpdateNotice (CxLogin.exe.c:10178): select the first type-2
   * CAString row, encode its value as one COSmartStream EStr, cache hash and
   * packet 7 atomically.  A missing row leaves the prior cache untouched. */
  UpdateNotice(): void {
    const row = this.m_db.GetNotice();
    if (row === null) return;

    const stream = new COSmartStream();
    stream.EncodeStr(row.value);
    const hash = stream.GetHashValue();
    const packet = new CSendPacket(LS_ClientSend.OnNotice, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeOSStream(stream);

    this.m_strNotice = row.value;
    this.m_nNoticeHash = hash;
    this.m_packetNotice = packet;
  }

  /** CConfigDyn::OnTimer — tick zero refreshes immediately, then every 4500. */
  OnTimer(): void {
    if (this.m_nTimerCount % CONFIG_DYN_NOTICE_UPDATE_TICKS === 0) this.UpdateNotice();
    this.m_nTimerCount++;
  }

  /** CConfigDyn::GetNoticePacket. */
  GetNoticePacket(): CSendPacket {
    return this.m_packetNotice;
  }

  /** CConfigDyn::GetNoticeHash. */
  GetNoticeHash(): number {
    return this.m_nNoticeHash;
  }

  /** Exposed for diagnostics/tests; not part of the wire protocol. */
  GetNotice(): string {
    return this.m_strNotice;
  }
}
