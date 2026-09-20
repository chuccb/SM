/** Map templates, theme groups and random-map eligibility from FxServer. */
import { CHANNEL_TYPE_GUILD, MAP_VERSION_MIN, MAX_SESSION_SLOTS } from "./Defs.ts";
import { UpdateCRC32 } from "../core/CRC.ts";
import { CData, CIDFMan } from "./CData.ts";
import { CMainSystem } from "./System.ts";

/** Attr/MapGroup's two string lengths must be < 128 (0040D0DA).
 * Map names are byte strings, like the rest of the original ANSI protocol. */
const MAP_GROUP_NAME_LIMIT = 0x80;

/** Sequential reads make the old/new map layouts explicit. Truncated assets
 * are rejected rather than publishing a partially defaulted template. */
class MapDataReader {
  private at = 0;
  private view: DataView;

  constructor(private data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private Require(size: number): void {
    if (size > this.data.byteLength - this.at) throw new Error("! Invalid object description file.");
  }

  ReadInt(): number {
    this.Require(4);
    const value = this.view.getInt32(this.at, true);
    this.at += 4;
    return value;
  }

  ReadName(): string {
    const length = this.ReadInt() >>> 0;
    if (length >= MAP_GROUP_NAME_LIMIT) throw new Error("! Invalid object description file.");
    this.Require(length);
    const name = Buffer.from(this.data.subarray(this.at, this.at + length)).toString("latin1");
    this.at += length;
    return name.split("\0", 1)[0]!;
  }
}

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
    const maps = CGameMapTmplList.ms_pInstance!;
    this.m_strName = name.slice(4);
    this.m_nThemeIdx = themeIdx;
    this.m_fLadderMap = maps.IsMapInGroup("LadderMapGroup", this.m_strName) ? 1 : 0;
    this.m_fPracticeMap = maps.IsMapInGroup("PraticeMapGroup", this.m_strName) ? 1 : 0;
    this.m_fReBirthMap = maps.IsMapInGroup("ReBirthMapGroup", this.m_strName) ? 1 : 0;
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

/** CGameMapTmplList — the "Map/…" templates plus the theme groups. */
export class CGameMapTmplList {
  static ms_pInstance: CGameMapTmplList | null = null;

  m_nMapCount = 0; // +4 (GetMapCount)
  m_apGameMapTmpl: CGameMapTmpl[] = []; // +8 (the tmpl pointers)
  m_apTheme: { strName: string; m_nMaxTeam: number }[] = []; // +1292 (CheckGetThemeIdx)
  m_mapMapGroup = new Map<string, string[]>(); // +2572 (multimap of group → pattern)

  constructor() {
    CGameMapTmplList.ms_pInstance = this;
  }

  /** CGameMapTmplList::LoadMapGroupInfo (Attr/MapGroup). */
  LoadMapGroupInfo(): void {
    const cd = new CData();
    if (!cd.Load("Attr/MapGroup")) return;
    const reader = new MapDataReader(cd.GetPtr()!);
    const groupCount = reader.ReadInt();
    for (let g = 0; g < groupCount; g++) {
      const groupName = reader.ReadName();
      const mapCount = reader.ReadInt();
      // The official uses multimap::insert_equal: repeated groups accumulate,
      // including repeated entries, rather than replacing earlier patterns.
      for (let m = 0; m < mapCount; m++) {
        const name = reader.ReadName();
        const maps = this.m_mapMapGroup.get(groupName) ?? [];
        maps.push(name);
        this.m_mapMapGroup.set(groupName, maps);
      }
    }
  }

  /** CGameMapTmplList::CreateTmplList — every "Map/…" entry of the package. */
  CreateTmplList(): void {
    this.Dispose();
    this.LoadMapGroupInfo();
    const fastFile = CIDFMan.ms_pInstance?.m_FastFile;
    if (!fastFile) return;
    for (let i = 0; i < fastFile.GetDataCount(); i++) {
      const name = fastFile.GetDataName(i);
      if (name.slice(0, 4).toLowerCase() !== "map/") continue; // _mbsnbicmp(entry, "Map/", 4)
      const themeIdx = this.CheckGetThemeIdx(name);
      const tmpl = new CGameMapTmpl();
      tmpl.LoadMap(name, themeIdx);
      // the theme's +12 keeps the widest max team of its maps
      if (themeIdx >= 0) {
        const theme = this.m_apTheme[themeIdx]!;
        if (theme.m_nMaxTeam < tmpl.m_nMaxTeam) theme.m_nMaxTeam = tmpl.m_nMaxTeam;
      }
      tmpl.m_nIdx = this.m_nMapCount++;
      this.m_apGameMapTmpl.push(tmpl);
    }
    if (this.m_nMapCount > 0) console.log(`[GS] Game map template list created.`);
  }

  /** CGameMapTmplList::Dispose (0040CA4C) — reset both index spaces. */
  Dispose(): void {
    this.m_nMapCount = 0;
    this.m_apGameMapTmpl = [];
    this.m_apTheme = [];
  }

  /** CGameMapTmplList::CheckGetThemeIdx — "Map/_…" has no theme (-1). */
  CheckGetThemeIdx(name: string): number {
    if (name[4] === "_") return -1;
    const themeName = `Theme/${name.slice(4, name.length - 2)}`;
    const at = this.m_apTheme.findIndex((t) => t.strName.toLowerCase() === themeName.toLowerCase());
    if (at >= 0) return at;
    this.m_apTheme.push({ strName: themeName, m_nMaxTeam: -1 });
    return this.m_apTheme.length - 1;
  }

  /** CGameMapTmplList::IsMapInGroup — exact or trailing-'?' wildcard match. */
  IsMapInGroup(groupName: string, mapName: string): boolean {
    const maps = this.m_mapMapGroup.get(groupName);
    if (!maps) return false;
    const lower = mapName.toLowerCase();
    for (const m of maps) {
      if (m.endsWith("?")) {
        const stem = m.slice(0, -1).toLowerCase();
        if (lower.startsWith(stem)) return true;
      } else if (m.toLowerCase() === lower) {
        return true;
      }
    }
    return false;
  }

  GetMapCount(): number {
    return this.m_nMapCount;
  }

  GetMapMaxPlayer(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_nMaxPlayer ?? 0;
  }

  GetMapMaxTeam(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_nMaxTeam ?? 0;
  }

  /** Official spelling (0041AC72): theme +12 is the maximum TEAM count. */
  GetThemeMaxMaxPlayer(idx: number): number {
    return this.m_apTheme[idx]?.m_nMaxTeam ?? 0;
  }

  GetMapThemeIdx(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_nThemeIdx ?? -1;
  }

  GetMapPremiumOnly(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_nPremiumOnly ?? 0;
  }

  IsPracticeMap(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_fPracticeMap ?? 0;
  }

  IsMissionMap(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_fMissionMap ?? 0;
  }

  /** CGameMapTmplList::GetMapLevelLimit — the premium channel discount. */
  GetMapLevelLimit(idx: number): number {
    const limit = this.m_apGameMapTmpl[idx]?.m_nLevelLimit ?? 0;
    return CMainSystem.IsPremiumChannel() ? limit - CMainSystem.ms_pInstance!.m_nPremiumLv : limit;
  }

  /** CGameMapTmplList::GetRandomMapIdx (FxServer.exe.c:14179). */
  GetRandomMapIdx(nPlayers: number, level: number, theme: number, practice: number, gm: number, premiumTicket: number): number {
    if (nPlayers <= 0 || nPlayers > MAX_SESSION_SLOTS || this.m_nMapCount <= 0) return -1;
    const isLadder = CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD;
    const fits: number[] = [];
    for (let i = 0; i < this.m_nMapCount; i++) {
      const tmpl = this.m_apGameMapTmpl[i]!;
      if (tmpl.m_nMaxPlayer < nPlayers) continue;
      if (theme !== -1 && tmpl.m_nThemeIdx !== theme) continue;
      if (isLadder && this.IsMissionMap(i) !== 0) continue;
      if (premiumTicket === 0) {
        if (this.GetMapLevelLimit(i) > level) continue;
        if (!CMainSystem.IsPremiumChannel() && tmpl.m_nPremiumOnly === 1) continue;
        if (practice !== 0 && practice !== tmpl.m_fPracticeMap) continue;
      }
      if (gm > tmpl.m_nMaxTeam) continue;
      fits.push(i);
    }
    if (fits.length === 0) return -1;
    // 0040C79B..0040C7A7: rand() % candidateCount, even for ONE candidate.
    return fits[CMainSystem.ms_pInstance!.m_WorkerRandom.rand() % fits.length]!;
  }
}
