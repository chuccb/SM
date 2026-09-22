# A06：NexonClub ID 來源、byte 語意與 billing 傳遞

日期：2026-09-20。同輪完成專案預覽工具鏈統一；使用方式見 [port README](../README.md)。

## 本輪完成

- A06：修復 `CUser::SetNexonClubId` 以 SN／CommunitySvr 配 ID 的錯誤。
- 核對 email 搜尋、尾端刪除、覆寫／清空、C-string view，以及 gift／check coupon／use coupon 的 ID 欄位。
- 工具鏈：將專案的 TypeScript、Bun、Bun types 固定至查詢當時 **npm 各預覽 channel 最新且可安裝驗證的版本**，更新 lockfile，並檢查真正執行的 Bun／SQLite 身分。
- 未知帳號登入自動註冊維持原需求；沒有變更 DB schema、帳號政策或真實金流服務。

不是整個商城、email／SQL collation、外部 billing 或原生 ABI 完整相容認證。預期來自提供的 `.c/.lst`，本輪沒有執行 Windows 原版服務／client。

## 原生查證

### SetNexonClubId：`FxShop.exe` `0041FC60`

`.lst:0041FC60..0041FCF2` 與 `.c` 對照：

1. 輸入來自 user +64 的 account email 字串，使用 start／finish 範圍，不是帳號 SN 或 CommunitySvr。
2. 長度小於 `0xE`，或者找不到 `@nexonclub.com`，將 user +188 的字串清成空值。
3. `_STL::search` 使用 char equality；大小寫敏感，不做 Unicode／email 正規化。
4. 找到時複製整份 email，然後 `erase(length - 14, 14)`。
5. **刪除的是尾端 14 bytes，不是搜尋結果的位置，也不要求命中處在尾端。**

因此以下結果不是「更合理的 email parser」可以代替的：

| 輸入 | 儲存的 ID |
| --- | --- |
| `audit@nexonclub.com` | `audit` |
| `audit@NEXONCLUB.COM` | 空值 |
| `@nexonclub.com` | 空值 |
| `abc@nexonclub.com.evil` | `abc@nexo` |
| `@nexonclub.comabc` | `@ne` |
| `a@nexonclub.com@nexonclub.com` | `a@nexonclub.com` |

在 TS 既有的 Latin-1 raw-byte string 表示下，使用具名 pattern 的 `includes` 與 `slice(0, -pattern.length)` 即可表達此流程；命中必然已滿足 pattern 長度，不再重複硬編碼 14。

### GetNexonClubId 與 NUL

- `CUser::GetNexonClubId`：`0041F000`，回傳 +188 字串的 `const char*`。
- `RequestGift` `00402BA0`、`RequestCheckCoupon` `00402E10`、`RequestUseCoupon` `00402FB0` 都由此 C pointer 建立 billing 用的暫時字串。
- 所以 stored ID 可以保留範圍搜尋得到的 NUL 及後續 bytes，但 billing 使用的 C-string view 必須停止於第一個 NUL。
- TS 新增同名 getter，回傳該 C-string view；不改壞 `m_strNexonClubId` 的完整儲存內容。
- 兩個實際編碼位置（gift、共用 coupon body）統一使用 getter，不只修正 assignment。

這是上述明確 C-string 呼叫點的語意；不是擅自把整個專案所有字串改成遇 NUL 就截斷。

## 實作範圍

- `src/FXSS/Defs.ts`：集中 `NEXONCLUB_EMAIL_DOMAIN` 的查證 pattern。
- `src/FXSS/User.ts`：Set／Get 方法及 gift／coupon 的相關欄位。
- 不依賴 SN／CommunitySvr，且每次未命中必定清空舊值。
- 沒有改變普通帳號名稱、DB charset、gift 對象、coupon 的其他欄位、付款成功條件或 transaction reset。

## 測試

### 專項：32 tests／995 assertions

`test/nexonclub-id.test.ts`：

- 正常、空值、短 pattern、domain-only、未命中、大小寫、前導空白、不在尾端命中、重複命中。
- raw Big5 byte prefix、NUL 前後的搜尋／儲存／getter。
- 不同 SN／CommunitySvr 組合，以及從先前有效值變成無效值時的清空。
- **全部 256 種 prefix byte**：storage 原樣保留；只有 NUL 會終止 C-string view。
- 每個案例均經正式 gift／check coupon／use coupon builder 及 Tw socket，捕捉完整 frame，驗證 family prefix、serial、ID 與後續欄位邊界，確保沒有多送 NUL 尾段或錯位。

這些測試驗證該欄位及其已存在的序列化路徑，不將尚未修復的 gift／coupon 業務 gate 當成已完成。

### 新增 1 項 Shop 網路回歸

`test/shop.test.ts`：

`SQLite email → 真實加密 Shop 登入 → Center 確認 → profile 載入 → client 219 → coupon billing Send 邊界`

先用有效 email，再改成未命中的 email 並重新登入，核對實際 ID 與 billing payload；不能回到錯誤的 SN 值，也不能殘留上次的 ID。測試會恢復 DB fixture 的 email，不接觸外部 billing。

此測試在 billing Send 邊界擷取，沒有宣稱本輪連到真實金流；Tw 外框的獨立真實 TCP 驗證由前輪 A16 持續覆蓋。

## 預覽工具鏈

### 已固定並實測

| 項目 | 版本 |
| --- | --- |
| TypeScript `next` | `7.1.0-dev.20260920.1` |
| Bun npm `canary` | `1.4.2-canary.20260919.1` |
| Bun 實際 binary | `1.4.3-canary.1+26e7a4b36` |
| Bun 完整 revision | `26e7a4b3690dce60d4dcd7f47a12b531deb00837` |
| bun-types `canary` | `1.4.3-canary.20260919T141209` |
| ES | `target`／`module`／`lib` 為 ESNext |
| Bun SQLite | `3.53.4`，source ID 固定在 `toolchain.json` |

- `package.json` 移除 stable TypeScript／Bun types 的範圍依賴；Bun runtime 也改為專案依賴，不再只靠 sandbox 的工具目錄。
- `bun.lock` 由 Bun 重建；乾淨目錄以 `--frozen-lockfile` 安裝，lockfile 不變，版本檢查與編譯器執行成功。
- TypeScript 的 project include 從只有 src 擴充至 **所有 src／test／tools**；不再逐輪用外加 standalone 指令補漏測試檔案。
- `tools/check-toolchain.ts`：核對三個 direct packages、Bun version／revision、SQLite version／source ID；SQLite 查詢在記憶體 DB，使用 `using` 明確釋放。
- 新增 5 項 guard 測試：wrapper build suffix、同版不同 revision、stable／missing packages、SQLite identity，以及實際跨 cwd 執行。
- `bun run check` 統一版本核對、專案內 typecheck 與全套測試。沒有再使用一套 global stable TS 與另一套 project preview TS 作為平行標準。

### 尚未取得的更新版，不宣稱已完成

GitHub rolling canary 的 release body 當時指向 `fc297d4658ebfba68e9810e60ba7e0cb719a6f22`，比 npm canary 新。
直接 release download、GitHub asset API 與 curl 均在 asset host 遇到 EOF／TLS 失敗，**未取得／安裝／測試該 binary**。

因此本輪是「npm 最新可用預覽版統一」，不是所有來源中的 Bun 絕對最新 build。沒有把未執行過的 revision 寫成已驗證版本。
SQLite 使用 Bun 隨附版本，不宣稱已換成 SQLite upstream trunk；ESNext 亦不是可獨立安裝的套件。

## 最終結果

使用專案內 `./node_modules/.bin/bun run check`：

- 工具鏈核對通過。
- 預覽 TypeScript 對所有 src／test／tools 的 strict project check 通過。
- **413 pass／0 fail／7,054 assertions／19 files／21.32s**。
- 第一份 probe：**14 observations／7 GAP／7 MATCH**，A06 已 MATCH。
- 第二份 probe：**24 observations／18 GAP／6 MATCH**。
- 合計 **38 observations／25 GAP／13 MATCH**；仍是靜態 native 預期與 TS 觀察，不是 Windows 差分執行。
- `git diff --check` 通過。

已列 A 待辦剩 **15 組**。A05、A07、A08、A17 等仍未完成；SQL collation／ODBC 字串讀取、Unicode 與 Big5 的完整邊界仍沿用 B 類限制。沒有將此處的 raw-byte helper 測試推論成整個帳號或 email 系統相容。
