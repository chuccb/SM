import { readFileSync } from "node:fs";

/**
 * CServerConfig — the registered-attribute configuration store used by
 * every server.
 *
 * The original reads the .cfg named on the command line through
 * ParseConfigString — a token stream (GetToken), not a line parser: tokens
 * are runs of non-delimiter characters, `#` starts a comment that runs to
 * end of line, and `"..."` quotes a literal token.  Every key is validated
 * against the per-exe registered table (g_strKeys — the static inits fill
 * one per binary); an unknown key reports and a valueless key reports and
 * stores the empty string.  Array-style entries (`FXGSIP0`, `FXGSIP1`, ...)
 * validate against their count key (`FXGSNumber`), which must appear
 * earlier in the file.
 *
 * Values are raw ANSI bytes; server names may be Big5 (Traditional
 * Chinese).  They are stored as byte-exact latin1 strings here.
 */

/** ?g_strKeys@@3PAY01V?$basic_string@D...@@A — one registered-attribute
 *  entry: [key, numberKey], where numberKey is the count key of the key's
 *  digit-suffixed array ("" = not an array).  The orders below are the
 *  static inits' (extracted from each exe's registration block). */
export type ServerAttributeKeyEntry = readonly [strKey: string, strNumberKey: string];

/** FxServer.exe (g_nAttributeNo = 0x16). */
export const FXSERVER_STR_KEYS: readonly ServerAttributeKeyEntry[] = [
  ["ServerIP", ""],
  ["ServerPort", ""],
  ["ServerName", ""],
  ["ServerIndex", ""],
  ["CenterIP", ""],
  ["CenterPort", ""],
  ["UDBNumber", ""],
  ["UDBIP", "UDBNumber"],
  ["UDBCatalog", "UDBNumber"],
  ["UDBDomain", "UDBNumber"],
  ["UDBIdx", "UDBNumber"],
  ["InventoryDBNumber", ""],
  ["InventoryDBIP", "InventoryDBNumber"],
  ["InventoryDBCatalog", "InventoryDBNumber"],
  ["InventoryDBDomain", "InventoryDBNumber"],
  ["InventoryDBIdx", "InventoryDBNumber"],
  ["ItemDBIP", ""],
  ["ItemDBCatalog", ""],
  ["ConfigDBIP", ""],
  ["ConfigDBCatalog", ""],
  ["GuildDBIP", ""],
  ["GuildDBCatalog", ""],
];

/** CxCenter.exe (g_nAttributeNo = 0x1A). */
export const CXCENTER_STR_KEYS: readonly ServerAttributeKeyEntry[] = [
  ["CenterPort", ""],
  ["LSNumber", ""],
  ["LSIP", "LSNumber"],
  ["LSPort", "LSNumber"],
  ["FXSSNumber", ""],
  ["FXSSIP", "FXSSNumber"],
  ["FXSSPort", "FXSSNumber"],
  ["FXAttrShop", ""],
  ["FXAttrCommunity", ""],
  ["FXGSNumber", ""],
  ["FXGSName", "FXGSNumber"],
  ["FXGSIP", "FXGSNumber"],
  ["FXGSPort", "FXGSNumber"],
  ["FXGSMaxUser", "FXGSNumber"],
  ["FXGSType", "FXGSNumber"],
  ["FXGSCommunity", "FXGSNumber"],
  ["FXGSEnterableType", "FXGSNumber"],
  ["FXUSNumber", ""],
  ["FXUSIP", "FXUSNumber"],
  ["FXUSPort", "FXUSNumber"],
  ["WebLog", ""],
  ["TextLog", ""],
  ["CommunityLog", ""],
  ["AuthenIP", ""],
  ["AuthenPort", ""],
  ["GameDomain", ""],
];

/** FxShop.exe (g_nAttributeNo = 0x14). */
export const FXSHOP_STR_KEYS: readonly ServerAttributeKeyEntry[] = [
  ["ServerIP", ""],
  ["ServerPort", ""],
  ["ServerName", ""],
  ["ServerIndex", ""],
  ["CenterIP", ""],
  ["CenterPort", ""],
  ["UDBNumber", ""],
  ["UDBIP", "UDBNumber"],
  ["UDBCatalog", "UDBNumber"],
  ["UDBDomain", "UDBNumber"],
  ["UDBIdx", "UDBNumber"],
  ["InventoryDBNumber", ""],
  ["InventoryDBIP", "InventoryDBNumber"],
  ["InventoryDBCatalog", "InventoryDBNumber"],
  ["InventoryDBDomain", "InventoryDBNumber"],
  ["InventoryDBIdx", "InventoryDBNumber"],
  ["ItemDBIP", ""],
  ["ItemDBCatalog", ""],
  ["ConfigDBIP", ""],
  ["ConfigDBCatalog", ""],
];

/** CxLogin.exe (g_nAttributeNo = 0x1A). */
export const CXLOGIN_STR_KEYS: readonly ServerAttributeKeyEntry[] = [
  ["ServerPort", ""],
  ["ServerName", ""],
  ["ServerIndex", ""],
  ["CenterIP", ""],
  ["CenterPort", ""],
  ["UrlPatchNumber", ""],
  ["UrlPatch", "UrlPatchNumber"],
  ["NDANumber", ""],
  ["NDAIP", "NDANumber"],
  ["RelayNumber", ""],
  ["RelayIP", "RelayNumber"],
  ["JUMSvrNumber", ""],
  ["JUMSvrIP", "JUMSvrNumber"],
  ["JUMSvrPort", "JUMSvrNumber"],
  ["UDBNumber", ""],
  ["UDBIP", "UDBNumber"],
  ["UDBCatalog", "UDBNumber"],
  ["UDBDomain", "UDBNumber"],
  ["UDBIdx", "UDBNumber"],
  ["InventoryDBNumber", ""],
  ["InventoryDBIP", "InventoryDBNumber"],
  ["InventoryDBCatalog", "InventoryDBNumber"],
  ["InventoryDBDomain", "InventoryDBNumber"],
  ["InventoryDBIdx", "InventoryDBNumber"],
  ["ConfigDBIP", ""],
  ["ConfigDBCatalog", ""],
];

/** CxUtil.exe (g_nAttributeNo = 3). */
export const CXUTIL_STR_KEYS: readonly ServerAttributeKeyEntry[] = [
  ["ServerIP", ""],
  ["CenterIP", ""],
  ["CenterPort", ""],
];

/** CXRELAY.EXE (g_nAttributeNo = 3). */
export const CXRELAY_STR_KEYS: readonly ServerAttributeKeyEntry[] = [
  ["ServerIP", ""],
  ["ServerPort", ""],
  ["ServerName", ""],
];

/** GetToken's character sets — the three runtime-built std::strings the
 *  static init fills before main (identical in every exe). */
const TOKEN_DELIMITERS = "= \t\r\n";
const TOKEN_EOL = "\r\n";
const TOKEN_COMMENT = "#";

export class CServerConfig {
  /** TSingleton<CServerConfig>::ms_pInstance */
  static ms_pInstance: CServerConfig;

  private attributes = new Map<string, string>();

  constructor(
    private readonly strKeys: readonly ServerAttributeKeyEntry[],
    /** CxCenter.exe.c:20287 — the center's copy of ParseConfigString skips
     *  `[`-prefixed tokens (the shipped Center_000.cfg is organized in
     *  `[CenterServer]`-style sections); the other exes' copies consume
     *  them like any key. */
    private readonly skipSectionHeaders = false,
  ) {}

  /** GetToken (CxLogin.exe.c:4879 shape; identical in every exe) — the
   *  tokenizer behind ParseConfigString.  Returns [token, nextFrom] or
   *  null at end of stream. */
  private static GetToken(str: string, from: number): [token: string, next: number] | null {
    let at = from;
    for (;;) {
      while (at < str.length && TOKEN_DELIMITERS.includes(str[at]!)) at++;
      if (at >= str.length) return null;
      if (str[at] !== TOKEN_COMMENT) break;
      let eol = at;
      while (eol < str.length && !TOKEN_EOL.includes(str[eol]!)) eol++;
      if (eol >= str.length) return null;
      at = eol; // the delimiter skip above eats the line end
    }
    if (str[at] === '"') {
      // a quoted literal: the closing quote may sit on a later line, and an
      // unterminated quote consumes the rest of the stream
      let end = at + 1;
      while (end < str.length && str[end] !== '"') end++;
      return [str.slice(at + 1, end), Math.min(end + 1, str.length)];
    }
    let end = at;
    while (end < str.length && !TOKEN_DELIMITERS.includes(str[end]!)) end++;
    return [str.slice(at, end), end];
  }

  /** CServerConfig::ParseConfigString — key token, then value token; an
   *  unregistered key reports (ReportError → the log) and a missing value
   *  reports (the empty value still lands in the map — GetAttribute reads
   *  unregistered keys fine).  The center's copy additionally skips
   *  `[`-prefixed tokens as section headers (CxCenter.exe.c:20287); the
   *  other exes consume them like any key. */
  ParseConfigString(strSrc: string): void {
    for (let got = CServerConfig.GetToken(strSrc, 0); got; ) {
      const [key, afterKey] = got;
      if (this.skipSectionHeaders && key.startsWith("[")) {
        got = CServerConfig.GetToken(strSrc, afterKey);
        continue;
      }
      if (!this.IsRegisteredKey(key)) console.error(`No registered server attribute key: ${key}`);
      const value = CServerConfig.GetToken(strSrc, afterKey);
      if (value === null) {
        console.error(`No attribute for [${key}]`);
        this.attributes.set(key, "");
        break; // the original's GetToken(-1) ends the loop here
      }
      this.attributes.set(key, value[0]);
      got = CServerConfig.GetToken(strSrc, value[1]);
    }
  }

  Init(cfgFileName: string): void {
    // CServerConfig::Init (FxServer.exe.c:13596): a name without a '.' gets
    // ".cfg" appended
    if (!cfgFileName.includes(".")) cfgFileName += ".cfg";
    let text: string;
    try {
      text = readFileSync(cfgFileName, "latin1");
    } catch {
      // the original's CAppException (FxServer.exe.c:13604)
      throw new Error("Can't find server configuration file");
    }
    this.ParseConfigString(text);
    // CServerConfig::Init's registered-value audit (CxCenter.exe.c:20360,
    // Relay :13616): every entry must carry a value — non-array entries
    // directly, array entries index by index up to their count — or Init
    // throws the original's CAppException.
    for (const [strKey, strNumberKey] of this.strKeys) {
      if (strNumberKey === "") {
        if (this.GetAttribute(strKey) === "") {
          throw new Error(`! attribute for (${strKey}) missed in server configuration file`);
        }
        continue;
      }
      const count = this.GetNumAttribute(strNumberKey);
      for (let i = 0; i < count; i++) {
        if (this.GetAttribute(`${strKey}${i}`) === "") {
          throw new Error(`! attribute for (${strKey}${i}) missed in server configuration file`);
        }
      }
    }
    // Deployment hook: the shipped cfgs carry 127.0.0.1 (originally the
    // operator's public IP). `--ip` (main.ts) re-points the
    // topology at another address without touching the files: each server's
    // ServerIP/CenterIP and the center's expected-host table LSIP*/FXSSIP*/
    // FXGSIP*/FXUSIP* (RegisterConnection compares the peer address against
    // them).
    // Client-facing data (NDAIP*/RelayIP*/UrlPatch*) stays as shipped.
    if (CServerConfig.ms_strIpOverride !== null) {
      for (const key of this.attributes.keys()) {
        if (/^(?:ServerIP|CenterIP|LSIP\d*|FXSSIP\d*|FXGSIP\d*|FXUSIP\d*)$/.test(key)) {
          this.attributes.set(key, CServerConfig.ms_strIpOverride);
        }
      }
    }
  }

  /** the `--ip <addr>` deployment override (see Init). */
  static ms_strIpOverride: string | null = null;

  /** CServerConfig::GetAttribute */
  GetAttribute(name: string): string {
    return this.attributes.get(name) ?? "";
  }

  /** CServerConfig::GetNumAttribute — GetAttribute + atoi (StrToNum). */
  GetNumAttribute(name: string): number {
    return Number.parseInt(this.attributes.get(name) ?? "", 10) || 0;
  }

  /** CServerConfig::IsRegisteredKey — an exact entry name, or a digit-
   *  suffixed element of an entry whose numberKey has been parsed already
   *  with the index inside its count.  A prefix match whose number key is
   *  missing throws the original's CAppException ("... item number(key:...)
   *  must be preceded in configuration file"). */
  IsRegisteredKey(name: string): boolean {
    for (const [strKey, strNumberKey] of this.strKeys) {
      if (name === strKey) return true;
      if (strNumberKey === "" || !name.startsWith(strKey)) continue;
      const count = this.attributes.get(strNumberKey);
      if (count === undefined || count === "") {
        throw new Error(`${strKey} item number(key:${strNumberKey}) must be preceded in configuration file`);
      }
      const idx = Number.parseInt(name.slice(strKey.length), 10) || 0; // atoi
      if (idx >= 0 && idx < (Number.parseInt(count, 10) || 0)) return true;
    }
    return false;
  }

  /** the parsed cfg keys (for the CServerConfig::Init registered-key check) */
  GetKeys(): string[] {
    return [...this.attributes.keys()];
  }

  /** Read `<prefix><i>` for i in [0, n) — the indexed cfg entries. */
  GetIndexed(prefix: string, n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(this.GetAttribute(`${prefix}${i}`));
    return out;
  }

  GetIndexedNum(prefix: string, n: number): number[] {
    return this.GetIndexed(prefix, n).map((v) => Number.parseInt(v, 10) || 0);
  }
}

/** Decode a DBInfo.inf file — plain uuencode body without begin/end lines. */
export function DecodeDBInfo(data: Buffer): string {
  const raw = data.toString("latin1");
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code > 0x60) continue;
    if (ch === "`") continue; // uuencode pad char
    const sextet = code - 0x20;
    acc = ((acc << 6) | sextet) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}
