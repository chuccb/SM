# UTF-8 資料庫儲存與網路 MS950 (Big5) 邊界轉碼架構

日期：2026-09-22。
解決 CrazyArcade (BnB) 伺服器移轉至 SQLite 後，資料庫中文字串在 Navicat / DBeaver / CLI 檢視時的亂碼問題，並維持與官方原版 Client 端封包協定 100% 相容。

---

## 1. 背景與核心問題

原版 Windows 伺服器是以 Visual C++ / MFC 開發，運行在繁體中文 Windows 伺服器上，字串底層均為系統 ANSI（即 Code Page 950 / MS950 / Big5）：
- **Client 端通訊**：封包內的字串長度與字元資料均以 MS950/Big5 格式傳輸。
- **資料庫儲存**：原版 SQL Server 2000 的 `varchar` 欄位以 Big5 位元組存放。早期 Porting 若直接以 Latin-1/二進位寫入 SQLite，Navicat 打開資料表時會顯示為類似 `°w (15­Ó)` 或 `¶}¤ßªºµl¤l©f` 的亂碼。

若直接將資料庫全面改為原生 UTF-8 儲存：
- **解碼端**：現代 Web API 支援 `new TextDecoder("big5")`，可原生無損地將封包二進位解碼為 UTF-8。
- **編碼端**：**W3C `TextEncoder` 規範在所有現代 JavaScript 引擎（Node.js / Bun / 瀏覽器）中只支援輸出 UTF-8**，且 `Buffer.from(str, "big5")` 不受原生支援。伺服器若要發送封包給官方 Client，必須具備高效、零依賴的 UTF-8 $\to$ CP950 編碼能力。

---

## 2. 架構設計與實作

為保持代碼現代、一目了然、零第三方依賴且完全貼齊 Windows 官方規格，本專案採用「邊界轉碼（Boundary Transcoding）」架構：

```text
[ SQLite 核心資料庫 ]
  (永久儲存純淨、原生 UTF-8 字串，Navicat / CLI 直接閱讀繁體中文)
          ▲
          │
  [ 業務邏輯層 (LS / GS / SS / DBMan) ]
  (全邏輯處理標準 JavaScript/TypeScript UTF-8 字串)
          │
          ▼
  [ 封包網路邊界 (Packet.ts / SmartStream.ts) ]
  - 發送封包：EncodeStrAt / EncodeEncryptedStrAt 自動呼叫 EncodeCP950(str) 轉為 MS950 二進位
  - 接收封包：DecodeStr / DecodeEncryptedStrAt 自動呼叫 DecodeCP950(bytes) 轉為 UTF-8 字串
          ▼
[ 官方 Client 端 (MS950/Big5 協定) ]
```

### 2.1 零依賴 CP950 編解碼器 (`port/src/core/Encoding.ts`)
- **`DecodeCP950(bytes: Uint8Array): string`**：
  直接呼叫原生標準 Web API `new TextDecoder("big5").decode(bytes)`，零自製代碼、極致高效。
- **`EncodeCP950(str: string): Uint8Array`**：
  完全對齊 Windows 官方 `WideCharToMultiByte(950, ...)` 規格：
  1. **ASCII (0x00..0x7F)**：輸出單字節。
  2. **繁體中文 (BMP Unicode)**：直通 16-bit 查找表 `UNICODE_TO_CP950`，輸出雙字節（Lead + Trail）。
  3. **協定二進位位元組 (0x80..0xFF)**：保留原樣單字節（保障未轉碼之 raw binary token / 測試載體安全透過）。
  4. **未對映未知字元**：輸出 `0x3F` (`'?'`)，與 Windows API 預設行為完全一致。

### 2.2 緊湊壓縮查表 (`port/src/core/CP950Table.ts`)
- 包含官方 Windows CP950 完整對齊之 13,742 個繁體中文/符號映射（涵蓋倚天延伸字、常用字與特殊標點符號）。
- 原全量查表達 175 KB，為維持代碼美觀俐落，使用 Bun 內建 `node:zlib` (`inflateSync`) 壓制為 40 KB 的緊湊 Base64，模組載入時一次性解壓至 TypedArray，解壓耗時 <0.5ms，運行時查表 $O(1)$ 且零額外 GC 負擔。

### 2.3 核心元件整合

1. **網路封包 (`port/src/core/Packet.ts`)**：
   - `EncodeStrAt` / `EncodeEncryptedStrAt`：自動將傳入的 UTF-8 字串轉碼為 CP950 位元組後寫入 buffer。
   - `DecodeStr` / `DecodeEncryptedStrAt`：從二進位 buffer 讀取 raw bytes 後轉碼為 UTF-8 字串。
2. **壓縮子串流 (`port/src/core/SmartStream.ts`)**：
   - `COSmartStream::EncodeStr` 與 `CISmartStream::DecodeStr` 同樣對齊 CP950 邊界轉碼。
3. **CAItem 資料庫與 FxStock / FxItem 匯入 (`CAItemBak.ts` & `CAItemImport.ts`)**：
   - 從 `.bak` 讀取資料表欄位（如商品名稱 `Name`、道具名 `strName`、字串表 `String` 等）時，在解析階段即轉為純 UTF-8 寫入 SQLite。
   - Navicat 等資料庫管理工具開啟 `CAItem.db` 時即可直接閱讀正體中文（如「針 (15個)」、「耶誕節可愛毛帽」）。
4. **分表 Sharding 雜湊維持 (`port/src/db/DBMan.ts`)**：
   - `GetUserHashNo(id)` 檢查若帳號包含非 ASCII 字元，會先取出其在 CP950 協定中的第一位元組並以 ASCII 摺疊後執行 `% 6`，維持原版 6 台分庫的分配一致性。

---

## 3. 測試驗證

- **單元測試與整合測試**：全數通過（`705 pass, 0 fail`）。
- **E2E 完整端到端測試**：登入、選頻道、建立房間、進入遊戲、商城購買、道具穿戴完整通過（`57 pass, 0 fail`）。
- **工具鏈與邊界審計**：`check:toolchain`、`check:imports`、`check:boundaries`、`typecheck` 全數通過。
