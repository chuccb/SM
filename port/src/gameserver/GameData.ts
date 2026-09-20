/** the FxServer.idx/.idd game-data tables — CBomberAttr and the map
 *  template list. */

import { CHANNEL_TYPE_GUILD, MAP_VERSION_MIN } from "./Defs";
import { UpdateCRC32 } from "../core/CRC.ts";
import { CData, CIDFMan } from "./CData.ts";
import { CMainSystem } from "./System";

// ============================ game data tables ============================

/**
 * SimpleCipher (FxServer.exe.c:16189) — the self-inverse byte chain that
 * obfuscates the names inside Attr/ItemAttr: byte i is XORed with a key that
 * starts at 0xA5 and then becomes (key * (i+1) + key / (i+1)) & 0xFF.
 */
function SimpleCipher(buf: Uint8Array, n64: number): void {
  let key = 0xa5;
  for (let i = 0; i < n64; i++) {
    buf[i] = (buf[i] ^ key) & 0xff;
    key = (key * (i + 1) + Math.floor(key / (i + 1))) & 0xff;
  }
}

/** CItemAttr (Attr/ItemAttr) — the name table SendAirplaneItemProb needs. */
export class CItemAttr {
  static ms_pInstance: CItemAttr | null = null;

  /** index → the decoded "Item/..." name (CItemAttr +12, stride 164). */
  m_vtName: string[] = [];
  /** entry+140 (dword 35) — the effect class (99 = the lucci/gem item). */
  m_vtEffect: number[] = [];
  /** entry+144 (dword 36) — the per-use amount (the lucci payout). */
  m_vtAmount: number[] = [];

  constructor() {
    CItemAttr.ms_pInstance = this;
  }

  Load(): void {
    const cd = new CData();
    if (!cd.Load("Attr/ItemAttr")) return; // "Data File Not Found" — the table stays empty
    const data = cd.GetPtr()!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;
    at += 8; // two header dwords (+102428 / +102432)
    const mapCount = dv.getUint32(at, true);
    at += 4;
    at += mapCount * 60; // the id→item map section (15 dwords each)
    // the main section: [E4 len][ciphered name][E4 len][ciphered image]…, idx = load order
    let idx = 0;
    while (at + 8 <= data.byteLength) {
      const len = dv.getUint32(at, true);
      at += 4;
      if (len <= 0 || len >= 64 || at + len > data.byteLength) break;
      const name = data.subarray(at, at + len);
      SimpleCipher(name, 64 <= len ? 64 : len);
      this.m_vtName[idx] = new TextDecoder().decode(name).replace(/\0.*$/, "");
      at += len;
      at += 4;
      const len2 = dv.getUint32(at, true);
      at += 4 + len2;
      at += 2 * 4; // +132 (string-id count) / +136
      this.m_vtEffect[idx] = dv.getInt32(at, true);
      at += 4;
      this.m_vtAmount[idx] = dv.getInt32(at, true);
      at += 4 + 4 * 4; // +148..+160
      idx++;
    }
  }

  /** CItemAttr::GetItemidx — the "Item/" prefix is stripped before comparing. */
  GetItemidx(name: string): number {
    let s = name;
    if (s.toLowerCase().startsWith("item/item")) s = s.slice(9);
    else if (s.toLowerCase().startsWith("item/")) s = s.slice(5);
    const lower = s.toLowerCase();
    return this.m_vtName.findIndex((n) => n.toLowerCase() === lower);
  }
}

/** CBomberAttr (Attr/BomberAttr) — 296 bytes per bomber, FxServer.exe.c:54336. */
export interface BomberAttrEntry {
  strName: string; // +0 (Load also builds the +64 "_Display", +128 "_Portrait"
  // and +192 "_Emotion" copies; FXGS itself only reads the +192 one through
  // the never-called GetEmotionTmplName :54457)
  nAttr1: number; // +256 — != 0 marks a hidden bomber (Load bumps m_nHiddenCount)
  nCurrentSpeed: number; // +260 — the 109 "currentspeed" wire compare
  nAttr3: number; // +264
  nBombCount: number; // +268 — the 109 "bombcount" wire compare
  nAttr5Clamped: number; // +272 — clamped to 10 at load; no reader in FXGS
  nBombPower: number; // +276 — the 109 "bombpower" wire compare
  nAttr7: number; // +280
  nAttr8: number; // +284
  nAttr9: number; // +288
  nAttr10: number; // +292
}

export class CBomberAttr {
  static ms_pInstance: CBomberAttr | null = null;

  m_nTotalCount = 0; // +4 (GetTotalCount; GetRandomBomberIdx returns it too)
  m_nHiddenCount = 0; // +8 (GetNormalCount = TotalCount - HiddenCount)
  m_vtAttr: BomberAttrEntry[] = []; // 296-byte records from +12

  constructor() {
    CBomberAttr.ms_pInstance = this;
  }

  Load(): void {
    const cd = new CData();
    if (!cd.Load("Attr/BomberAttr")) return; // "Data File Not Found" — the table stays empty
    const data = cd.GetPtr()!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;
    const decoder = new TextDecoder();
    while (at + 4 <= data.byteLength) {
      const len = dv.getUint32(at, true);
      at += 4;
      // 40 = the 10 trailing dwords (+256..+292) — the record needs them all
      if (len <= 0 || len >= 54 || at + len + 40 > data.byteLength) break;
      const name = decoder.decode(data.subarray(at, at + len)).replace(/\0.*$/, "");
      at += len;
      const attr: BomberAttrEntry = {
        strName: name,
        nAttr1: dv.getUint32(at, true),
        nCurrentSpeed: dv.getUint32(at + 4, true),
        nAttr3: dv.getUint32(at + 8, true),
        nBombCount: dv.getUint32(at + 12, true),
        nAttr5Clamped: Math.min(dv.getUint32(at + 16, true), 10), // the load-time clamp (FxServer.exe.c:54407)
        nBombPower: dv.getUint32(at + 20, true),
        nAttr7: dv.getUint32(at + 24, true),
        nAttr8: dv.getUint32(at + 28, true),
        nAttr9: dv.getUint32(at + 32, true),
        nAttr10: dv.getUint32(at + 36, true),
      };
      at += 40;
      if (attr.nAttr1 !== 0) this.m_nHiddenCount++;
      this.m_nTotalCount++;
      this.m_vtAttr.push(attr);
    }
  }

  GetNormalCount(): number {
    return this.m_nTotalCount - this.m_nHiddenCount;
  }

  GetTotalCount(): number {
    return this.m_nTotalCount;
  }

  GetRandomBomberIdx(): number {
    return this.m_nTotalCount;
  }

  /** CBomberAttr::IsValidSelectIdx — [0, NormalCount) plus the random index. */
  IsValidSelectIdx(idx: number): boolean {
    return (idx >= 0 && idx < this.GetNormalCount()) || idx === this.m_nTotalCount;
  }

  /**
   * The three attr reads of OnReadyForImmediateStart (:34441, v10 =
   * ms_pInstance + 296*idx, i.e. the record payload minus 12): the wire
   * bytes compare against record dwords 1 / 3 / 5 (+260/+268/+276).
   */
  GetCurrentSpeed(idx: number): number {
    return this.m_vtAttr[idx]?.nCurrentSpeed ?? 0;
  }

  GetBombCount(idx: number): number {
    return this.m_vtAttr[idx]?.nBombCount ?? 0;
  }

  GetBombPower(idx: number): number {
    return this.m_vtAttr[idx]?.nBombPower ?? 0;
  }
}

/** CGameMapTmpl — one entry of CGameMapTmplList (LoadMap, FxServer.exe.c:13640). */
export class CGameMapTmpl {
  m_nIdx = 0; // +0 (the load order)
  m_strName = ""; // +16 (the "Map/…" path minus the prefix)
  m_nVersion = 1000; // +28 (file dword 0, clamped up to 1000)
  m_nMaxTeam = 8; // +32 (GetMapMaxTeam; 8 when the file is pre-1000)
  m_nOld = 1; // +36
  m_nLevelLimit = 0; // +52 (GetMapLevelLimit, minus the premium discount)
  m_nMaxPlayer = 8; // +48 (GetMapMaxPlayer)
  m_nPremiumOnly = 0; // +56 (GetMapPremiumOnly)
  m_dwCRC = 0; // +88 (CRC32 of the whole file)
  m_nThemeIdx = -1; // +80 (CheckGetThemeIdx)
  m_fLadderMap = 0; // +92
  m_fPracticeMap = 0; // +96 (IsPracticeMap; "PraticeMapGroup" in the original)
  m_fReBirthMap = 0; // +100
  m_nMissionType = 0; // +108 (MissionInfo head; > 0 → IsMissionMap)
  m_nLapTileCount = 0; // +112
  m_nLapTime = 0; // +116
  m_nLapBonus = 0; // +120
  m_nArg84 = 0; // +84
  m_nArg60 = 0; // +60
  m_nArg64 = 0; // +64
  m_dwAirplaneItemProb = 0; // +72 — SendAirplaneItemProb dword 1 (:36930); NOT a play time
  // (the old name was a misread — nothing ever uses it as a clock)
  m_dwArg76 = 0; // +76
}

/** CGameMapTmplList — the "Map/…" templates plus the theme groups. */
export class CGameMapTmplList {
  static ms_pInstance: CGameMapTmplList | null = null;

  m_nMapCount = 0; // +4 (GetMapCount)
  m_apGameMapTmpl: CGameMapTmpl[] = []; // +8 (the tmpl pointers)
  m_apTheme: { strName: string; m_nMaxTeam: number }[] = []; // +1292 (CheckGetThemeIdx)

  constructor() {
    CGameMapTmplList.ms_pInstance = this;
  }

  /** CGameMapTmplList::LoadMapGroupInfo (Attr/MapGroup). */
  LoadMapGroupInfo(groups: Map<string, string[]>): void {
    const cd = new CData();
    if (!cd.Load("Attr/MapGroup")) return;
    const data = cd.GetPtr()!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;
    const decoder = new TextDecoder();
    const groupCount = dv.getUint32(at, true);
    at += 4;
    for (let g = 0; g < groupCount && at + 4 <= data.byteLength; g++) {
      const nameLen = dv.getUint32(at, true);
      at += 4;
      if (nameLen >= 0x80) break;
      const groupName = decoder.decode(data.subarray(at, at + nameLen)).replace(/\0.*$/, "");
      at += nameLen;
      const mapCount = dv.getUint32(at, true);
      at += 4;
      const maps: string[] = [];
      for (let m = 0; m < mapCount && at + 4 <= data.byteLength; m++) {
        const len = dv.getUint32(at, true);
        at += 4;
        if (len >= 0x80) break;
        maps.push(decoder.decode(data.subarray(at, at + len)).replace(/\0.*$/, ""));
        at += len;
      }
      groups.set(groupName, maps);
    }
  }

  /** CGameMapTmplList::CreateTmplList — every "Map/…" entry of the package. */
  CreateTmplList(): void {
    this.m_apGameMapTmpl = [];
    this.m_apTheme = [];
    const groups = new Map<string, string[]>();
    this.LoadMapGroupInfo(groups);
    const fastFile = CIDFMan.ms_pInstance?.m_FastFile;
    if (!fastFile) return;
    for (let i = 0; i < fastFile.GetDataCount(); i++) {
      const name = fastFile.GetDataName(i);
      if (name.slice(0, 4).toLowerCase() !== "map/") continue; // _mbsnbicmp(entry, "Map/", 4)
      const content = fastFile.FFReadFileSize(name)?.buf;
      if (!content) continue;
      const themeIdx = this.CheckGetThemeIdx(name);
      const tmpl = new CGameMapTmpl();
      this.LoadMap(tmpl, name, content, themeIdx, groups);
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

  /** CGameMapTmpl::LoadMap — the template fields straight from the map file. */
  LoadMap(tmpl: CGameMapTmpl, name: string, content: Uint8Array, themeIdx: number, groups: Map<string, string[]>): void {
    tmpl.m_strName = name.slice(4);
    tmpl.m_nThemeIdx = themeIdx;
    tmpl.m_fLadderMap = this.IsMapInGroup("LadderMapGroup", tmpl.m_strName, groups) ? 1 : 0;
    tmpl.m_fPracticeMap = this.IsMapInGroup("PraticeMapGroup", tmpl.m_strName, groups) ? 1 : 0;
    tmpl.m_fReBirthMap = this.IsMapInGroup("ReBirthMapGroup", tmpl.m_strName, groups) ? 1 : 0;
    // +88 = CCRC32::UpdateCRC(0, file, size) over the WHOLE map file
    // (FxServer.exe.c:13710) — packet 109 compares the client's CRC of the
    // same file against this; MSB-first poly 0x04C11DB7, NOT zlib's reflected
    // crc32 (that mismatch tripped the "Hacking suspected: crc mismatch").
    tmpl.m_dwCRC = UpdateCRC32(0, content, 0, content.byteLength) >>> 0;
    const dv = new DataView(content.buffer, content.byteOffset, content.byteLength);
    if (content.byteLength < 8) return;
    const version = dv.getUint32(0, true);
    tmpl.m_nVersion = version < MAP_VERSION_MIN ? MAP_VERSION_MIN : version;
    let at = 4;
    if (version < MAP_VERSION_MIN) {
      tmpl.m_nMaxTeam = 8;
      tmpl.m_nOld = 1;
    } else {
      if (at + 16 > content.byteLength) return;
      tmpl.m_nMaxTeam = dv.getUint32(at, true);
      tmpl.m_nOld = dv.getUint32(at + 4, true);
      at += 8;
      at += 8; // dwords 3 and 4 → +40 / +44
    }
    const need = at + 8 * 4 + 4 * 4 + 4;
    if (content.byteLength < need) return;
    tmpl.m_nMaxPlayer = dv.getUint32(at, true);
    tmpl.m_nLevelLimit = dv.getUint32(at + 4, true);
    tmpl.m_nPremiumOnly = dv.getUint32(at + 8, true);
    tmpl.m_nArg60 = dv.getUint32(at + 12, true);
    tmpl.m_nArg64 = dv.getUint32(at + 16, true);
    tmpl.m_dwAirplaneItemProb = dv.getUint32(at + 24, true);
    tmpl.m_dwArg76 = dv.getUint32(at + 28, true);
    tmpl.m_nMissionType = dv.getUint32(at + 32, true);
    tmpl.m_nLapTileCount = dv.getUint32(at + 36, true);
    tmpl.m_nLapTime = dv.getUint32(at + 40, true);
    tmpl.m_nLapBonus = dv.getUint32(at + 44, true);
    tmpl.m_nArg84 = dv.getUint32(at + 48, true);
  }

  /** CGameMapTmplList::CheckGetThemeIdx — "Map/xx_y" has no theme (-1). */
  CheckGetThemeIdx(name: string): number {
    if (name[4] === "_") return -1;
    const themeName = `Theme/${name.slice(4, name.length - 2)}`;
    const at = this.m_apTheme.findIndex((t) => t.strName.toLowerCase() === themeName.toLowerCase());
    if (at >= 0) return at;
    this.m_apTheme.push({ strName: themeName, m_nMaxTeam: 0 });
    return this.m_apTheme.length - 1;
  }

  /** CGameMapTmplList::IsMapInGroup — exact or trailing-'?' wildcard match. */
  IsMapInGroup(groupName: string, mapName: string, groups: Map<string, string[]>): boolean {
    const maps = groups.get(groupName);
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
    return this.m_apGameMapTmpl[idx]?.m_nMissionType ?? 0;
  }

  /** CGameMapTmplList::GetMapLevelLimit — the premium channel discount. */
  GetMapLevelLimit(idx: number): number {
    const limit = this.m_apGameMapTmpl[idx]?.m_nLevelLimit ?? 0;
    return CMainSystem.IsPremiumChannel() ? limit - CMainSystem.ms_pInstance!.m_nPremiumLv : limit;
  }

  /** CGameMapTmplList::GetRandomMapIdx (FxServer.exe.c:14179). */
  GetRandomMapIdx(nPlayers: number, level: number, theme: number, practice: number, gm: number, premiumTicket: number): number {
    if (nPlayers <= 0 || nPlayers > 8 || this.m_nMapCount <= 0) return -1;
    const isLadder = CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD;
    const fits: number[] = [];
    for (let i = 0; i < this.m_nMapCount; i++) {
      const tmpl = this.m_apGameMapTmpl[i]!;
      if (tmpl.m_nMaxPlayer < nPlayers) continue;
      if (theme !== -1 && tmpl.m_nThemeIdx !== theme) continue;
      if (isLadder && (tmpl.m_nMissionType > 0 ? 1 : 0) !== 0) continue;
      if (premiumTicket === 0) {
        if (this.GetMapLevelLimit(i) > level) continue;
        if (!CMainSystem.IsPremiumChannel() && tmpl.m_nPremiumOnly === 1) continue;
        if (practice !== 0 && practice !== (tmpl.m_fPracticeMap !== 0 ? 1 : 0)) continue;
      }
      if (gm > tmpl.m_nMaxTeam) continue;
      fits.push(i);
    }
    if (fits.length === 0) return -1;
    return fits[Math.floor(Math.random() * fits.length) % fits.length]!;
  }
}
