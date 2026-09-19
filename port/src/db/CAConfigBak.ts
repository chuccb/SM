/**
 * CAConfigBak — reader for DB/CAConfig.bak, the original deployment's
 * SQL Server backup ("TAPE" media) of the CAConfig database.
 *
 * The backup embeds the database log as self-delimiting row-image records.
 * Layout (reverse-engineered from DB/CAConfig.bak, validated against all 13
 * records the file carries — every length/offset field cross-checks):
 *
 *   [0x0030 u16]              record tag
 *   [op u16]                  0x0010 = live row image, 0x000C = other op
 *   [fixed u32 × k]           the fixed-length column values, in table
 *                             column order, variable-length columns skipped
 *   [nValues u16]             total column count (fixed + variable)
 *   [u8][strCount u8][0x00]   strCount = number of variable-length values
 *   [(str2off u16)]           offset of the 2nd string from record start,
 *                             present only when strCount == 2
 *   [totalLen u16]            whole record size, counted from the tag
 *   [strings]                 the variable-length values, concatenated
 *
 * Table attribution used here (evidence in parentheses):
 *   CALoginSvr (CRSLoginServer::OnReceiveRow, CxLogin.exe.lst:411BE3 —
 *   columns SN long, IP text, Port long, Flag long): op 0x0010, nValues 4,
 *   strCount 1 → fixed (SN, Port, Flag) + "IP".  The two rows in the backup
 *   carry Port 3838 — the original login port.
 *   CAMultiSvr (CRSMultiServer::OnReceiveRow, CxLogin.exe.lst:411DF0 —
 *   columns SN long, Name text, IP text, Param long, Current long): op
 *   0x0010, nValues 5, strCount 2 → fixed (SN, Param, Current) +
 *   "Name", "IP".  The backup's single row is the operator's test row
 *   ("world name" @ "123", Current = 1 = the selected server).
 * The float-first rows (FxUserOptions LEVELLIMIT…, value 1.0f) and the
 * 3-column rows (old server list entries with ports 7000/9898) fail the
 * sanity gates below and are excluded.
 */
import * as FS from "node:fs";
import * as Path from "node:path";

/** the record tag every row-image log record starts with */
const LOG_RECORD_TAG = 0x0030;
/** the opcode of the live row images (the deleted/stale images are 0x000C) */
const LOG_RECORD_INSERT = 0x0010;

/** the bind address every IP-bearing row seeded from the .bak is rewritten
 *  to (the backup's IPs belong to the original site) */
export const CA_CONFIG_SEED_IP = "127.0.0.1";

export interface ICAMultiSvrRow {
  SN: number;
  Name: string;
  IP: string;
  Param: number;
  Current: number;
}

export interface ICALoginSvrRow {
  SN: number;
  IP: string;
  Port: number;
  Flag: number;
}

export interface ICAConfigBakRows {
  CAMultiSvr: ICAMultiSvrRow[];
  CALoginSvr: ICALoginSvrRow[];
}

function ReadCString(buf: Uint8Array, off: number, end: number): string {
  let s = "";
  for (let i = off; i < end; i++) s += String.fromCharCode(buf[i]!);
  return s;
}

/** ParseCAConfigBak — extract the CAMultiSvr / CALoginSvr rows. */
export function ParseCAConfigBak(buf: Uint8Array): ICAConfigBakRows {
  const out: ICAConfigBakRows = { CAMultiSvr: [], CALoginSvr: [] };
  const u16 = (o: number) => buf[o]! | (buf[o + 1]! << 8);
  const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;

  for (let h = 0; h + 24 <= buf.length; h++) {
    if (u16(h) !== LOG_RECORD_TAG) continue;
    const op = u16(h + 2);
    if (op !== LOG_RECORD_INSERT) continue;
    for (let strCount = 1; strCount <= 2; strCount++) {
      for (let nValues = strCount + 1; nValues <= 8; nValues++) {
        const fixed = nValues - strCount;
        const p = h + 4 + 4 * fixed;
        if (p + 9 > buf.length) continue;
        if (u16(p) !== nValues) continue;
        if (buf[p + 3] !== strCount || buf[p + 4] !== 0) continue;
        let str2off = 0;
        let lenAt = p + 5;
        if (strCount === 2) {
          str2off = u16(p + 5);
          lenAt = p + 7;
        }
        const totalLen = u16(lenAt);
        const strsAt = lenAt + 2;
        if (totalLen < strsAt - h) continue;
        const strLen = totalLen - (strsAt - h);
        if (strLen < 0 || strsAt + strLen > buf.length) continue;
        const fixedv: number[] = [];
        for (let k = 0; k < fixed; k++) fixedv.push(u32(h + 4 + 4 * k));
        const str1off = strsAt - h;
        if (strCount === 2) {
          if (str2off < str1off || str2off > totalLen) continue;
          const s1 = ReadCString(buf, strsAt, strsAt + (str2off - str1off));
          const s2 = ReadCString(buf, strsAt + (str2off - str1off), strsAt + strLen);
          if (![s1, s2].every((s) => [...s].every((c) => c >= " " && c < "\x7f"))) continue;
          // CAMultiSvr: fixed (SN, Param, Current) + Name, IP
          if (fixedv.length === 3 && fixedv[0]! < 0x10000) {
            out.CAMultiSvr.push({ SN: fixedv[0]!, Name: s1, IP: s2, Param: fixedv[1]!, Current: fixedv[2]! });
            h = strsAt + strLen - 1;
          }
        } else {
          const s1 = ReadCString(buf, strsAt, strsAt + strLen);
          if (![...s1].every((c) => c >= " " && c < "\x7f")) continue;
          // CALoginSvr: fixed (SN, Port, Flag) + IP — the sanity gates also
          // exclude the float-first FxUserOptions rows (0x3F800000).
          if (
            fixedv.length === 3 &&
            fixedv[0]! < 0x10000 &&
            fixedv[1]! > 0 &&
            fixedv[1]! <= 0xffff &&
            (fixedv[2]! & ~1) === 0
          ) {
            out.CALoginSvr.push({ SN: fixedv[0]!, IP: s1, Port: fixedv[1]!, Flag: fixedv[2]! });
            h = strsAt + strLen - 1;
          }
        }
        break;
      }
    }
  }
  return out;
}

/** LocateCAConfigBak — the original backup shipped in the repository's DB/
 *  directory (port/src/db → ../../../DB/CAConfig.bak), overridable with
 *  CA_CONFIG_BAK. Resolved from this module so the deployment layout (the
 *  db directory, the cwd) never matters. */
export function LocateCAConfigBak(): string | null {
  if (process.env.CA_CONFIG_BAK) return Path.resolve(process.env.CA_CONFIG_BAK);
  const candidate = Path.resolve(import.meta.dir, "..", "..", "..", "DB", "CAConfig.bak");
  return FS.existsSync(candidate) ? candidate : null;
}
