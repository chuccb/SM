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
 * The float-first FxUserOptions rows (LEVELLIMIT…/PRECH…, VALUE 1.0f) parse
 * through the dedicated gate in ParseCAConfigBak (their VALUE seeds as the
 * ODBC float→long truncation 1). The 3-column rows that look like old server
 * list entries (ports 7000/9898) still fail the CALoginSvr sanity gates and
 * are excluded.
 */
import * as FS from "node:fs";
import * as Path from "node:path";

/** the record tag every row-image log record starts with */
const LOG_RECORD_TAG = 0x0030;
/** the opcode of the live row images */
const LOG_RECORD_INSERT = 0x0010;
/** the opcode of the older row images. CAMultiSvr/CALoginSvr carry live
 *  0x0010 images that supersede their 0x000C ones, but the backup's only
 *  CAString row (ChargeUrl) exists solely as a 0x000C image — and the
 *  original server's AskMultiServer notice stream demonstrably carries it —
 *  so CAString accepts both. */
const LOG_RECORD_OLD = 0x000c;

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

export interface ICAStringRow {
  sn: number;
  type: number;
  value: string;
  strAttr: string;
}

export interface IFxUserOptionsRow {
  NAME: string;
  VALUE: number;
}

export interface ICAConfigBakRows {
  CAMultiSvr: ICAMultiSvrRow[];
  CALoginSvr: ICALoginSvrRow[];
  /** the CRSMultiServerNotice rows ("CAString", filter "type = 0 or type = 1",
   *  CxLogin.exe.c:29957-29960; OnReceiveRow binds sn/type long + value/strAttr
   *  text — CxLogin.exe.lst:411F90) that feed the AskMultiServer notice stream */
  CAString: ICAStringRow[];
  /** the FxUserOptions rows (CRSOptions::OnReceiveRow, CxLogin.exe.c:17512 —
   *  NAME text + VALUE). The backup stores VALUE as a float column image
   *  (leading 0x3F800000 = 1.0f); the original reads it through Get_FieldLong,
   *  whose ODBC float→long conversion truncates, so the seeded VALUE is the
   *  truncated float (1.0f → 1). LEVELLIMITMAX/MIN drive
   *  CCenterProcess::UpdateLevelLimit, PRECHMAPREWARD/PRECHLUCKPRO the
   *  premium-channel reward/luck readers. */
  FxUserOptions: IFxUserOptionsRow[];
}

function ReadCString(buf: Uint8Array, off: number, end: number): string {
  let s = "";
  for (let i = off; i < end; i++) s += String.fromCharCode(buf[i]!);
  return s;
}

/** ParseCAConfigBak — extract the CAMultiSvr / CALoginSvr rows. */
export function ParseCAConfigBak(buf: Uint8Array): ICAConfigBakRows {
  const out: ICAConfigBakRows = { CAMultiSvr: [], CALoginSvr: [], CAString: [], FxUserOptions: [] };
  const u16 = (o: number) => buf[o]! | (buf[o + 1]! << 8);
  const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  /** the IEEE-754 bits → float → Get_FieldLong's ODBC float→long truncation */
  const f32BitsToLong = (bits: number) => Math.trunc(new Float32Array(new Uint32Array([bits]).buffer)[0]!);

  for (let h = 0; h + 24 <= buf.length; h++) {
    if (u16(h) !== LOG_RECORD_TAG) continue;
    const op = u16(h + 2);
    if (op !== LOG_RECORD_INSERT && op !== LOG_RECORD_OLD) continue;
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
          if (fixedv.length === 3 && fixedv[0]! < 0x10000) {
            if (op === LOG_RECORD_INSERT) {
              // CAMultiSvr: fixed (SN, Param, Current) + Name, IP — only the
              // live image; the 0x000C ones are the rows it replaced
              out.CAMultiSvr.push({ SN: fixedv[0]!, Name: s1, IP: s2, Param: fixedv[1]!, Current: fixedv[2]! });
              h = strsAt + strLen - 1;
            }
          } else if (fixedv.length === 2 && fixedv[0]! < 0x10000 && fixedv[1]! < 0x10000) {
            // CAString: fixed (sn, type) + value, strAttr
            out.CAString.push({ sn: fixedv[0]!, type: fixedv[1]!, value: s1, strAttr: s2 });
            h = strsAt + strLen - 1;
          }
        } else {
          const s1 = ReadCString(buf, strsAt, strsAt + strLen);
          if (![...s1].every((c) => c >= " " && c < "\x7f")) continue;
          // FxUserOptions (CRSOptions::OnReceiveRow, CxLogin.exe.c:17512):
          // fixed (VALUE float, 0, 0) + NAME. The float leading image
          // (0x3F800000 = 1.0f) is what the CALoginSvr gate above rejects;
          // the operator's option identifiers are all-caps alphanumerics,
          // which also excludes the two same-shaped backup rows carrying
          // bare IP strings (no LS reader queries those names). The UTF-16
          // system-catalog rows the backup walk picked up fail the
          // printable gate above.
          if (
            op === LOG_RECORD_INSERT &&
            fixedv.length === 3 &&
            fixedv[1]! === 0 &&
            fixedv[2]! === 0 &&
            (fixedv[0]! & 0x7f800000) !== 0 &&
            (fixedv[0]! & 0x7f800000) !== 0x7f800000 &&
            /^[A-Z0-9]+$/.test(s1)
          ) {
            out.FxUserOptions.push({ NAME: s1, VALUE: f32BitsToLong(fixedv[0]!) });
            h = strsAt + strLen - 1;
          } else if (
            op === LOG_RECORD_INSERT &&
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
