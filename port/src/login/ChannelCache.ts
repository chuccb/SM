/**
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
import { CSendPacket } from "../core/Packet.ts";

export class CChannelCache {
  m_nChannelNo = 0;
  m_strChannelName: string[] = []; // char[33] each
  m_nUserCount: number[] = [];
  m_nChannelId: number[] = []; // the center-side svr idx
  m_nLevelLimit: number[] = [];
  m_nType: number[] = [];
  m_nBattleType: number[] = []; // p3 field b (svr class)
  m_nCommunity: number[] = [];
  m_nEnterableType: number[] = []; // p3 field c
  m_nHashValue = 0;
  /** cached packets: full / match / state */
  m_packetFull = new CSendPacket(10, 2);
  m_packetMatch = new CSendPacket(10, 2);
  m_packetState = new CSendPacket(13, 2);

  /** CChannelCache::SetChannelNo */
  SetChannelNo(a2: number): void {
    this.m_nChannelNo = a2;
  }

  /** CChannelCache::SetChannelInfo(idx, userCount) — the state-packet variant. */
  SetChannelInfo(a2: number, a3: number): void;
  /** CChannelCache::SetChannelInfo(idx, name, 0, chNo, levelLimit, type, attr, community, enterable) */
  SetChannelInfo(
    a2: number,
    _M_start: string,
    a4: number,
    a5: number,
    LevelLimit: number,
    a7: number,
    a8: number,
    a9: number,
    a10: number,
  ): void;
  SetChannelInfo(...args: unknown[]): void {
    const a2 = args[0] as number;
    if (args.length === 2) {
      this.m_nUserCount[a2] = args[1] as number;
      return;
    }
    const [_M_start, a4, a5, LevelLimit, a7, a8, a9, a10] = args.slice(1) as [
      string,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    this.m_strChannelName[a2] = _M_start;
    this.m_nUserCount[a2] = a4;
    if (a5 !== -1) this.m_nChannelId[a2] = a5;
    this.m_nLevelLimit[a2] = LevelLimit;
    this.m_nType[a2] = a7;
    this.m_nBattleType[a2] = a8;
    this.m_nCommunity[a2] = a9;
    this.m_nEnterableType[a2] = a10;
  }

  /** CChannelCache::MakeInfoPacket */
  MakeInfoPacket(): void {
    if (this.m_nChannelNo === 0) console.error("call MakeInfoPacket. but m_nChannelNo = 0");
    const full = new CSendPacket(10, 2);
    full.Encode1(1);
    const os = new COSmartStream();
    os.Encode2(this.m_nChannelNo & 0xffff);
    for (let i = 0; i < this.m_nChannelNo; i++) {
      os.EncodeStr(this.m_strChannelName[i] ?? "");
      os.Encode2(this.m_nChannelId[i] ?? 0);
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

    const match = new CSendPacket(10, 2);
    match.Encode1(0);
    this.m_packetMatch = match;
  }

  /** CChannelCache::MakeStatePacket */
  MakeStatePacket(): void {
    if (this.m_nChannelNo === 0) console.error("call MakeStatePacket. but m_nChannelNo = 0");
    const state = new CSendPacket(13, 2);
    state.Encode2(this.m_nChannelNo & 0xffff);
    for (let i = 0; i < this.m_nChannelNo; i++) state.Encode2(this.m_nUserCount[i] ?? 0);
    this.m_packetState = state;
  }

  /** CChannelCache::GetInfoPacket(a2) — a2 != 0 → the full variant. */
  GetInfoPacket(a2: number): CSendPacket {
    return a2 === 0 ? this.m_packetMatch : this.m_packetFull;
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
