/** CGameMapTmplList. Native source unit: FX/FxServer/GameMapTmplList.cpp. */
import { CHANNEL_TYPE_GUILD, MAX_SESSION_SLOTS } from "./Defs.ts";
import { CData, CIDFMan } from "./IDFMan.ts";
import { CMainSystem } from "./MainSystem.ts";
import { CGameMapTmpl } from "./GameMapTmpl.ts";
import { RegisterGameMapGroupLookup } from "./runtime/GameMapTmplListRuntime.ts";
import { MapDataReader } from "../common/MapDataReader.ts";

/** CGameMapTmplList — the "Map/…" templates plus the theme groups. */
export class CGameMapTmplList {
  private static m_pInstance: CGameMapTmplList | null = null;

  static get ms_pInstance(): CGameMapTmplList | null {
    return CGameMapTmplList.m_pInstance;
  }

  static set ms_pInstance(list: CGameMapTmplList | null) {
    CGameMapTmplList.m_pInstance = list;
    RegisterGameMapGroupLookup(list);
  }

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
