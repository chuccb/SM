import { CDataReader } from "../Common/CDataReader.ts";
import { CCRC32 } from "../Common/CCRC.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";

/** Header-only reader matching CGameMapTmpl::LoadMap @ FXGS 0040C15A.
 * The opaque mission words sometimes contain stale x86 pointers in the official IDD;
 * never dereference them or treat the remaining serialized map body as an address. */
export class CGameMapTmpl {
  readonly m_strName: string;
  readonly m_nCRC: number;
  readonly m_nVersion: number;
  readonly m_nMaxTeam: number;
  readonly m_nLevelLimit: number;
  readonly m_nOpaque36: number;
  readonly m_nAirplaneInitialTime: number;
  readonly m_nAirplaneFrequency: number;
  readonly m_nWidth: number;
  readonly m_nHeight: number;
  readonly m_nMaxPlayer: number;
  readonly m_nPremiumOnly: number;
  readonly m_nGhostStart: number;
  readonly m_nGhostFreq: number;
  readonly m_nSyncGameObjCount: number;
  readonly m_aOpaqueHeader: readonly number[];
  readonly m_aMissionInfo: readonly number[];
  readonly m_pMapBody: Buffer;
  constructor(
    readonly resourceName: string,
    bytes: Uint8Array,
    readonly m_nThemeIdx: number,
    readonly m_bLadderMap: boolean,
    readonly m_bPracticeMap: boolean,
    readonly m_bRebirthMap: boolean,
  ) {
    this.m_strName = resourceName.slice(4);
    this.m_nCRC = CCRC32.UpdateCRC(0, bytes);
    const reader = new CDataReader(bytes);
    let width = reader.i32();
    if (width < 1000) {
      this.m_nVersion = 1000;
      this.m_nMaxTeam = 8;
      this.m_nOpaque36 = 1;
    } else {
      this.m_nVersion = width;
      this.m_nMaxTeam = reader.i32();
      this.m_nOpaque36 = reader.i32();
      width = reader.i32();
    }
    this.m_nWidth = width;
    this.m_nHeight = reader.i32();
    this.m_nMaxPlayer = reader.i32();
    // GetMapLevelLimit 0040C5CD reads CGameMapTmpl+52, NOT +36.
    this.m_nLevelLimit = reader.i32();
    this.m_nPremiumOnly = reader.i32();
    this.m_nGhostStart = reader.i32();
    this.m_nGhostFreq = reader.i32();
    const opaque68 = reader.i32();
    // LaunchGameStage -> SendAirplaneItemProb (004204EB), values transmitted as ms.
    this.m_nAirplaneInitialTime = reader.i32();
    this.m_nAirplaneFrequency = reader.i32();
    this.m_aOpaqueHeader = Object.freeze([this.m_nOpaque36, opaque68]);
    this.m_aMissionInfo = Object.freeze(
      Array.from({ length: 4 }, () => reader.i32()),
    );
    this.m_nSyncGameObjCount = reader.i32();
    if (
      width <= 0 ||
      this.m_nHeight <= 0 ||
      this.m_nMaxPlayer < 0 ||
      this.m_nMaxPlayer > 8
    )
      throw new CProtocolError(`Invalid map header: ${resourceName}`);
    this.m_pMapBody = Buffer.from(reader.bytes(reader.remaining));
  }
  IsMissionMap(): boolean {
    return this.m_aMissionInfo[0]! > 0;
  }
}
