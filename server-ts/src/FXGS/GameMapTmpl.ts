/** CGameMapTmpl. Native source unit: FX/FxServer/GameMapTmpl.cpp. */
import { MAP_VERSION_MIN, MAX_SESSION_SLOTS } from "./Defs.ts";
import { UpdateCRC32 } from "../core/CRC.ts";
import { CData } from "./IDFMan.ts";
import { IsMapInRegisteredGroup } from "./runtime/GameMapTmplListRuntime.ts";
import { MapDataReader } from "../common/MapDataReader.ts";

/** CGameMapTmpl — one entry of CGameMapTmplList (LoadMap, FxServer.exe.c:13640). */
export class CGameMapTmpl {
  m_nIdx = 0; // TS load-order index (the original uses the pointer-array position)
  m_strName = ""; // +16 (the "Map/…" path minus the prefix)
  m_nVersion = MAP_VERSION_MIN; // +28 (file dword 0, clamped up to 1000)
  m_nMaxTeam = MAX_SESSION_SLOTS; // +32 (GetMapMaxTeam; 8 when the file is pre-1000)
  m_nOld = 1; // +36
  m_nArg40 = 0; // +40 (the first file dword in pre-1000 maps)
  m_nArg44 = 0; // +44
  m_nLevelLimit = 0; // +52 (GetMapLevelLimit, minus the premium discount)
  m_nMaxPlayer = MAX_SESSION_SLOTS; // +48 (GetMapMaxPlayer)
  m_nPremiumOnly = 0; // +56 (GetMapPremiumOnly)
  m_dwCRC = 0; // +88 (CRC32 of the whole file)
  m_nThemeIdx = -1; // +80 (CheckGetThemeIdx)
  m_fLadderMap = 0; // +92
  m_fPracticeMap = 0; // +96 (IsPracticeMap; "PraticeMapGroup" in the original)
  m_fReBirthMap = 0; // +100
  m_fMissionMap = 0; // +104 (signed MissionInfo head > 0)
  m_nMissionType = 0; // +108 (MissionInfo head; > 0 → IsMissionMap)
  m_nLapTileCount = 0; // +112
  m_nLapTime = 0; // +116
  m_nLapBonus = 0; // +120
  m_nSyncGameObjCount = 0; // +84
  m_nGhostStart = 0; // +60
  m_nGhostFreq = 0; // +64
  m_nArg68 = 0; // +68
  m_dwAirplaneItemProb = 0; // +72 — SendAirplaneItemProb dword 1 (:36930); NOT a play time
  // (the old name was a misread — nothing ever uses it as a clock)
  m_dwArg76 = 0; // +76

  /** CGameMapTmpl::LoadMap — the template fields straight from the map file. */
  LoadMap(name: string, themeIdx: number): void {
    const cd = new CData();
    if (!cd.Load(name)) throw new Error(`Failed in loading map: ${name}`);
    const content = cd.GetPtr()!;
    this.m_strName = name.slice(4);
    this.m_nThemeIdx = themeIdx;
    this.m_fLadderMap = IsMapInRegisteredGroup("LadderMapGroup", this.m_strName) ? 1 : 0;
    this.m_fPracticeMap = IsMapInRegisteredGroup("PraticeMapGroup", this.m_strName) ? 1 : 0;
    this.m_fReBirthMap = IsMapInRegisteredGroup("ReBirthMapGroup", this.m_strName) ? 1 : 0;
    // +88 = CCRC32::UpdateCRC(0, file, size) over the WHOLE map file
    // (FxServer.exe.c:13710) — packet 109 compares the client's CRC of the
    // same file against this; MSB-first poly 0x04C11DB7, NOT zlib's reflected
    // crc32 (that mismatch tripped the "Hacking suspected: crc mismatch").
    this.m_dwCRC = UpdateCRC32(0, content, 0, content.byteLength) >>> 0;
    const reader = new MapDataReader(content);
    const version = reader.ReadInt();
    this.m_nVersion = Math.max(version, MAP_VERSION_MIN);
    if (version < MAP_VERSION_MIN) {
      this.m_nMaxTeam = MAX_SESSION_SLOTS;
      this.m_nOld = 1;
      this.m_nArg40 = version;
    } else {
      this.m_nMaxTeam = reader.ReadInt();
      this.m_nOld = reader.ReadInt();
      this.m_nArg40 = reader.ReadInt();
    }
    // 0040C2B5: BOTH formats consume +44 before +48 (max players).
    this.m_nArg44 = reader.ReadInt();
    this.m_nMaxPlayer = reader.ReadInt();
    this.m_nLevelLimit = reader.ReadInt();
    this.m_nPremiumOnly = reader.ReadInt();
    this.m_nGhostStart = reader.ReadInt();
    this.m_nGhostFreq = reader.ReadInt();
    this.m_nArg68 = reader.ReadInt();
    this.m_dwAirplaneItemProb = reader.ReadInt() >>> 0;
    this.m_dwArg76 = reader.ReadInt() >>> 0;
    this.m_nMissionType = reader.ReadInt();
    this.m_nLapTileCount = reader.ReadInt();
    this.m_nLapTime = reader.ReadInt();
    this.m_nLapBonus = reader.ReadInt();
    this.m_nSyncGameObjCount = reader.ReadInt();
    this.m_fMissionMap = this.m_nMissionType > 0 ? 1 : 0;
  }
}
