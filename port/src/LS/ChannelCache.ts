/** Native source unit: common/ChannelCache.cpp (CxLogin.pdb: ChannelCache1.obj).
 *
 * CChannelCache (CxLogin.exe.c) — the per-login-server channel list cache.
 *
 * Fed by CCenterProcess::OnLocalServerInfo (p3 from the center) and
 * OnLocalServerState (p4).  Builds the two cached client packets:
 *
 *   info  (id 10): full = [E1 1][EOS: E2 n, n×(EStr name, E2 chNo, E2 levelLimit,
 *                          E1 type, E1 attr, E2 community, E1 enterable)]
 *                  match = [E1 0]
 *   state (id 13): [E2 n, n×E2 userCount]
 *
 * The client compares its cached adler32 (CChannelCache::GetHashValue) against
 * the packet to decide which variant to request (CLoginPool::OnRequestEnterChannelStage).
 */
import { COSmartStream } from "../core/SmartStream.ts";
import { CipherDegree, CSendPacket } from "../core/Packet.ts";
import { LS_ClientSend } from "../protocol/PacketIDs.ts";

export class CChannelCache {
  m_nChannelNo = 0;
  m_strChannelName: string[] = []; // char[33] each
  m_nUserCount: number[] = [];
  m_nMaxUser: number[] = []; // CM 3's E4 = cfg FXGSMaxUser (the +37896 bank)
  m_nLevelLimit: number[] = [];
  m_nType: number[] = [];
  m_nBattleType: number[] = []; // p3 field b (svr class)
  m_nCommunity: number[] = [];
  m_nEnterableType: number[] = []; // p3 field c
  m_nHashValue = 0;
  /** cached packets: full / match / state */
  m_packetFull = new CSendPacket(LS_ClientSend.OnChannelInfo, CipherDegree.kPacketEncryptedCRC8);
  m_packetMatch = new CSendPacket(LS_ClientSend.OnChannelInfo, CipherDegree.kPacketEncryptedCRC8);
  m_packetState = new CSendPacket(LS_ClientSend.OnChannelState, CipherDegree.kPacketEncryptedCRC8);

  /** CChannelCache::SetChannelNo */
  SetChannelNo(channelNo: number): void {
    this.m_nChannelNo = channelNo;
  }

  /** CChannelCache::SetChannelInfo(idx, userCount) — the state-packet variant. */
  SetChannelInfo(idx: number, userCount: number): void;
  /** CChannelCache::SetChannelInfo(idx, name, userCount, maxUser, levelLimit,
   *  type, attr, community, enterableType) — the CM3 per-channel columns. */
  SetChannelInfo(
    idx: number,
    strName: string,
    userCount: number,
    maxUser: number,
    levelLimit: number,
    type: number,
    attr: number,
    community: number,
    enterableType: number,
  ): void;
  SetChannelInfo(...args: unknown[]): void {
    const idx = args[0] as number;
    if (args.length === 2) {
      this.m_nUserCount[idx] = args[1] as number;
      return;
    }
    const [strName, userCount, maxUser, levelLimit, type, attr, community, enterableType] = args.slice(1) as [
      string,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    this.m_strChannelName[idx] = strName;
    this.m_nUserCount[idx] = userCount;
    // the original guards every non-name field on maxUser != -1
    if (maxUser !== -1) {
      this.m_nMaxUser[idx] = maxUser;
      this.m_nLevelLimit[idx] = levelLimit;
      this.m_nType[idx] = type;
      this.m_nBattleType[idx] = attr;
      this.m_nCommunity[idx] = community;
      this.m_nEnterableType[idx] = enterableType;
    }
  }

  /** CChannelCache::MakeInfoPacket */
  MakeInfoPacket(): void {
    if (this.m_nChannelNo === 0) console.error("call MakeInfoPacket. but m_nChannelNo = 0");
    const full = new CSendPacket(LS_ClientSend.OnChannelInfo, CipherDegree.kPacketEncryptedCRC8);
    full.Encode1(1);
    const os = new COSmartStream();
    os.Encode2(this.m_nChannelNo & 0xffff);
    for (let i = 0; i < this.m_nChannelNo; i++) {
      os.EncodeStr(this.m_strChannelName[i] ?? "");
      os.Encode2(this.m_nMaxUser[i] ?? 0);
      os.Encode2(this.m_nLevelLimit[i] ?? 0);
      os.Encode1(this.m_nType[i] ?? 0);
      os.Encode1(this.m_nBattleType[i] ?? 0);
      os.Encode2(this.m_nCommunity[i] ?? 0);
      os.Encode1(this.m_nEnterableType[i] ?? 0);
    }
    this.m_nHashValue = os.GetHashValue();
    full.EncodeOSStream(os);
    this.m_packetFull = full;
    console.log(`ChannelCache: n(${this.m_nChannelNo}) hash(0x${this.m_nHashValue.toString(16).toUpperCase()})`);

    const match = new CSendPacket(LS_ClientSend.OnChannelInfo, CipherDegree.kPacketEncryptedCRC8);
    match.Encode1(0);
    this.m_packetMatch = match;
  }

  /** CChannelCache::MakeStatePacket */
  MakeStatePacket(): void {
    if (this.m_nChannelNo === 0) console.error("call MakeStatePacket. but m_nChannelNo = 0");
    const state = new CSendPacket(LS_ClientSend.OnChannelState, CipherDegree.kPacketEncryptedCRC8);
    state.Encode2(this.m_nChannelNo & 0xffff);
    for (let i = 0; i < this.m_nChannelNo; i++) state.Encode2(this.m_nUserCount[i] ?? 0);
    this.m_packetState = state;
  }

  /** CChannelCache::GetInfoPacket(fFull) — fFull != 0 → the full variant. */
  GetInfoPacket(fFull: number): CSendPacket {
    return fFull === 0 ? this.m_packetMatch : this.m_packetFull;
  }

  /** CChannelCache::GetStatePacket */
  GetStatePacket(): CSendPacket {
    return this.m_packetState;
  }

  /** CChannelCache::GetHashValue */
  GetHashValue(): number {
    return this.m_nHashValue;
  }
}
