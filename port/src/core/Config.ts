/**
 * CServerConfig — the `Key = Value` configuration store used by every server.
 *
 * The original reads a .cfg passed on the command line (ParseConfigString) and
 * exposes GetAttribute(name) / GetNumAttribute(name).  Array-style entries use
 * a numeric suffix (`FXGSName0`, `FXGSName1`, ...) and a companion
 * `...Number` key; GetAttribute is expected to resolve those as well.
 *
 * Values are raw ANSI bytes; server names may be Big5 (Traditional Chinese).
 * They are stored as byte-exact latin1 strings here.
 */

export class CServerConfig {
  /** TSingleton<CServerConfig>::ms_pInstance */
  static ms_pInstance: CServerConfig;

  private attributes = new Map<string, string>();

  /** CServerConfig::ParseConfigString — one `Key = Value` per line, `#` comments. */
  ParseConfigString(strSrc: string): void {
    for (const rawLine of strSrc.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key.length === 0) continue;
      this.attributes.set(key, value);
    }
  }

  Init(cfgFileName: string): void {
    const text = require("node:fs").readFileSync(cfgFileName, "latin1") as string;
    this.ParseConfigString(text);
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

  /** CServerConfig::GetNumAttribute */
  GetNumAttribute(name: string): number {
    return Number.parseInt(this.attributes.get(name) ?? "", 10) || 0;
  }

  IsRegisteredKey(name: string): boolean {
    return this.attributes.has(name);
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
