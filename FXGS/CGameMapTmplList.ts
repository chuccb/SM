import { randomInt } from "node:crypto";
import { CDataReader } from "../Common/CDataReader.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import type { CFastFile } from "../Common/CFastFile.ts";
import {
  MapSelection,
  TeamLimit,
  SessionLimit,
  BomberRandomRule,
  ChannelType,
} from "../Common/OfficialValues.ts";
import { CGameMapTmpl } from "./CGameMapTmpl.ts";

export class CGameMapTmplList {
  readonly m_aMapTmpl: CGameMapTmpl[] = [];
  readonly m_aThemeInfo: { name: string; MaxTeam: number }[] = [];
  readonly m_mapMapGroup = new Map<string, string[]>();
  // Preserve original misspelling PraticeMapGroup; changing the key silently loses membership.
  LoadMapGroupInfo(files: CFastFile): void {
    const reader = new CDataReader(files.Get("Attr/MapGroup"));
    const count = reader.u32();
    const groups = new Map<string, string[]>();
    for (let i = 0; i < count; i++) {
      const name = reader.string();
      const n = reader.u32();
      const maps: string[] = [];
      for (let j = 0; j < n; j++) maps.push(reader.string());
      groups.set(name, maps);
    }
    reader.end();
    this.m_mapMapGroup.clear();
    for (const [k, v] of groups) this.m_mapMapGroup.set(k, v);
  }
  IsMapInGroup(group: string, name: string): boolean {
    name = name.toLowerCase();
    return (
      this.m_mapMapGroup
        .get(group)
        ?.some((pattern) =>
          pattern.endsWith("?")
            ? name.startsWith(pattern.slice(0, -1).toLowerCase())
            : name === pattern.toLowerCase(),
        ) ?? false
    );
  }
  CheckGetThemeIdx(name: string): number {
    if (name[4] === "_") return -1;
    const theme = `Theme/${name.slice(4, -2)}`;
    let index = this.m_aThemeInfo.findIndex(
      (a) => a.name.toLowerCase() === theme.toLowerCase(),
    );
    if (index < 0) {
      index = this.m_aThemeInfo.length;
      this.m_aThemeInfo.push({ name: theme, MaxTeam: -1 });
    }
    return index;
  }
  CreateTmplList(files: CFastFile): void {
    this.m_aMapTmpl.length = 0;
    this.m_aThemeInfo.length = 0;
    this.LoadMapGroupInfo(files);
    for (const entry of files.m_aDataEntry) {
      if (!entry.name.toLowerCase().startsWith("map/")) continue;
      const mapName = entry.name.slice(4);
      const theme = this.CheckGetThemeIdx(entry.name);
      const map = new CGameMapTmpl(
        entry.name,
        files.Get(entry.name),
        theme,
        this.IsMapInGroup("LadderMapGroup", mapName),
        this.IsMapInGroup("PraticeMapGroup", mapName),
        this.IsMapInGroup("ReBirthMapGroup", mapName),
      );
      this.m_aMapTmpl.push(map);
      if (theme >= 0)
        this.m_aThemeInfo[theme]!.MaxTeam = Math.max(
          this.m_aThemeInfo[theme]!.MaxTeam,
          map.m_nMaxTeam,
        );
    }
    if (!this.m_aMapTmpl.length)
      throw new CProtocolError("Official archive has no maps");
  }
  /** Waiting-room selection: -1=random; -2-themeIndex=theme; nonnegative=map. */
  GetSelectionMaxTeam(selection: number): number {
    if (!Number.isInteger(selection))
      throw new CProtocolError("Invalid map selection");
    if (selection === MapSelection.Random) return TeamLimit.Colors;
    if (selection >= 0) return this.GetMapMaxTeam(selection);
    const theme = this.m_aThemeInfo[MapSelection.FirstTheme - selection];
    if (!theme) throw new CProtocolError("Theme index out of bounds");
    return theme.MaxTeam;
  }
  GetMapCount(): number {
    return this.m_aMapTmpl.length;
  }
  GetMapTmpl(index: number): CGameMapTmpl {
    const m = this.m_aMapTmpl[index];
    if (!m) throw new CProtocolError("Map index out of bounds");
    return m;
  }
  GetCRC(index: number): number {
    return this.GetMapTmpl(index).m_nCRC;
  }
  GetMapMaxPlayer(index: number): number {
    return this.GetMapTmpl(index).m_nMaxPlayer;
  }
  GetMapMaxTeam(index: number): number {
    return this.GetMapTmpl(index).m_nMaxTeam;
  }
  GetMapLevelLimit(index: number): number {
    return this.GetMapTmpl(index).m_nLevelLimit;
  }
  GetMapThemeIdx(index: number): number {
    return this.GetMapTmpl(index).m_nThemeIdx;
  }
  GetMapPremiumOnly(index: number): number {
    return this.GetMapTmpl(index).m_nPremiumOnly;
  }
  GetMapGhostStart(index: number): number {
    return this.GetMapTmpl(index).m_nGhostStart;
  }
  GetMapGhostFreq(index: number): number {
    return this.GetMapTmpl(index).m_nGhostFreq;
  }
  GetSyncGameObjCount(index: number): number {
    return this.GetMapTmpl(index).m_nSyncGameObjCount;
  }
  IsRebirthMap(index: number): boolean {
    return this.GetMapTmpl(index).m_bRebirthMap;
  }
  IsPracticeMap(index: number): boolean {
    return this.GetMapTmpl(index).m_bPracticeMap;
  }
  IsMissionMap(index: number): boolean {
    return this.GetMapTmpl(index).IsMissionMap();
  }
  /** 0040C6D1. Source argument7 is the chief authencode==1 test, NOT
   * HasAuthority: it bypasses random-map level/premium/practice filters, while
   * CanStartGame STILL checks the selected map's level afterward. */
  GetRandomMapIdx(
    playerCount: number,
    level: number,
    theme: number,
    practice: number,
    minimumTeams: number,
    authencodeOne: boolean,
    channelType: number,
    random: () => number = () => randomInt(BomberRandomRule.NativeRandomRange),
  ): number {
    if (
      !Number.isInteger(playerCount) ||
      playerCount <= 0 ||
      playerCount > SessionLimit.Players
    )
      return -1;
    const candidates = this.m_aMapTmpl.flatMap((map, index) =>
      map.m_nMaxPlayer >= playerCount &&
      (theme === -1 || map.m_nThemeIdx === theme) &&
      (channelType !== ChannelType.Guild || !map.IsMissionMap()) &&
      (authencodeOne ||
        (map.m_nLevelLimit <= level &&
          (channelType === ChannelType.Premium || map.m_nPremiumOnly !== 1) &&
          (!practice || Number(map.m_bPracticeMap) === practice))) &&
      minimumTeams <= map.m_nMaxTeam
        ? [index]
        : [],
    );
    if (!candidates.length) return -1;
    const draw = random();
    if (
      !Number.isInteger(draw) ||
      draw < 0 ||
      draw >= BomberRandomRule.NativeRandomRange
    )
      throw new CProtocolError("Invalid native-range random map draw");
    return candidates[draw % candidates.length]!;
  }
  /** Runtime CSPRNG instead of CRT rand(); eligibility rules are explicit at the caller. */
  PickEligibleMap(predicate: (map: CGameMapTmpl) => boolean): CGameMapTmpl {
    const candidates = this.m_aMapTmpl.filter(predicate);
    if (!candidates.length)
      throw new CProtocolError("No eligible official map");
    return candidates[randomInt(candidates.length)]!;
  }
}
