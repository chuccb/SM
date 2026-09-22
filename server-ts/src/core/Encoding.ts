/**
 * Official Windows Code Page 950 (Traditional Chinese Big5) & UTF-8 boundary codec.
 *
 * Windows MFC 原版伺服器以 ANSI (CP950) 系統字元編碼進行網路通訊，
 * 資料庫則使用 SQLite 原生純 UTF-8 儲存（方便 Navicat / CLI 直接閱讀與維護）。
 * 本模組在網路封包邊界提供零外部依賴、高效無損的雙向轉碼能力。
 */
import { UNICODE_TO_CP950 } from "./CP950Table.ts";

/** 原生 Web API Big5 解碼器（解碼網路封包 CP950 位元組至 JS/TS UTF-8 字串） */
const BIG5_DECODER = new TextDecoder("big5");

/**
 * 將標準 UTF-8 字串編碼為官方 Client 所需之 CP950 / Big5 二進位位元組。
 *
 * - ASCII 字元 (0x00..0x7F)：發射 1 位元組。
 * - 繁體中文字元 (BMP Unicode)：以 13,742 字 CP950 對照表查表發射 2 位元組（Lead + Trail）。
 * - 原始 Latin-1 載體位元組 (0x80..0xFF)：保留原始 1 位元組（相容二進位協定 Token）。
 * - 未對映之未知字元：發射 '?' (0x3F)，貼齊 Windows WideCharToMultiByte 原版預設行為。
 */
export function EncodeCP950(str: string): Uint8Array {
  const bytes: number[] = [];
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes.push(code);
    } else {
      const mapped = UNICODE_TO_CP950[code] ?? 0;
      if (mapped !== 0) {
        bytes.push((mapped >> 8) & 0xff, mapped & 0xff);
      } else if (code <= 0xff) {
        bytes.push(code);
      } else {
        bytes.push(0x3f);
      }
    }
  }
  return new Uint8Array(bytes);
}

/**
 * 將官方 Client 發送之 CP950 / Big5 二進位位元組解碼為原生 UTF-8 字串。
 */
export function DecodeCP950(bytes: Uint8Array): string {
  return BIG5_DECODER.decode(bytes);
}

