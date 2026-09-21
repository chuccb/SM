# A13 日期時間與 A14 Login CRT RNG 相容性修復

日期：2026-09-21

## 結論

本輪關閉兩個可由 repository 內原版 PE／listing 完整固定的差異：

1. 商城及庫存的 `VARIANT DATE` 現在由 **local SYSTEMTIME calendar fields** 產生，不再把 UTC epoch instant 直接除以一天。SQLite 仍保存帶 `Z` 的明確 absolute instant；模擬 SQL Server `getdate() + N` 時則先加 local calendar days，再轉回 UTC ISO。
2. Login destroy-service 的 room code 現在使用 CxLogin 自己的持久 CRT TLS-compatible stream，執行原版的 `rand() & 3`，不再使用 `Math.random()`。

這些修改不把 Windows IOCP 排程虛構成可重播的順序。每個原版 process／thread 有自己的 CRT state；Bun port 的每個單事件迴圈服務各自擁有一條 logical-worker stream。

## A13 · 原版日期證據與實作

### 原版證據

- `FxShop.exe` 購買 receipt `0041673E..00416753`：依序呼叫 IAT `GetLocalTime` 與 `SystemTimeToVariantTime`。
- 另一條 receipt 路徑 `0040489A/004048AA` 使用同一組呼叫。
- `CTime::GetVariantTime` `00428710` 直接把物件內的 `SYSTEMTIME` 傳給 `SystemTimeToVariantTime`；沒有 UTC epoch 換算。
- `test/variant-time.test.ts` 從 `FxShop.exe` 的 PE section table 讀取上述 VA 並固定指令 bytes，避免只依註解或重新抄寫的 pseudo-C。

因此 client wire 上的 8 bytes 是 OLE Automation `DATE` 的 little-endian double，內容取決於服務所在時區的年月日／時分秒。同一個 absolute instant 在 UTC、Asia/Taipei、America/New_York 會得到不同值。原版 API 的 calendar conversion 使用 whole-second precision；`SYSTEMTIME.wMilliseconds` 不進入 `DATE`。

### Port 實作

- `src/core/VariantTime.ts`
  - 讀取 `Date` 的 local year/month/day/hour/minute/second；
  - 以 OLE epoch `1899-12-30` 計算 calendar day；
  - 保留 epoch 前日期的負 fractional-day 表示；
  - `null` 保留原有零值，invalid date 保留 `NaN`；
  - `EncodeVariantTime` 仍只負責 little-endian float64 wire encoding。
- `src/core/LocalTime.ts::AddLocalCalendarDays`
  - 以 `Date#setDate` 表達 SQL Server `getdate() + @days` 的 wall-calendar day semantics；
  - 不使用固定 `days * 86_400_000`，因此跨 DST spring-forward 的一天可以只有 23 elapsed hours。
- `src/db/DBMan.ts`
  - Shop inventory、pre-inventory claim 與 premium ticket expiry 均使用同一 local-calendar helper；
  - 儲存值仍為 UTC ISO，避免 SQLite 中出現無 offset 的歧義字串。
- `src/LocalBilling/Store.ts`
  - permanent inventory expiry 的 100,000 天同樣改用 local-calendar addition。

### A13 回歸

`test/variant-time.test.ts` 及其 child-process fixtures 驗證：

- 原版 PE 的兩條 Win32 conversion call path；
- 明確 `TZ=UTC`、`Asia/Taipei`、`America/New_York` 下同一 instant 的 OLE 值；
- whole-second precision、epoch 前負 fraction、null、little-endian wire 8 bytes；
- New York 2026 spring-forward 的 calendar day為 23 elapsed hours；
- 實際 `prAddInventoryShop`、`prSetPremiumTicket`、local-billing permanent grant 三個持久層 callsite 都保留 local wall time，而非只測 helper。

## A14 · CxLogin CRT stream

### 原版證據

- `CLoginPool::OnRequestDestoryService` 在 `0040EAFF` 呼叫 CxLogin 的 `_rand`，`0040EB08` 執行 `and edi,3`，再把結果寫入 socket room code 並回覆。
- CxLogin `_srand` 位於 `0045EEA4`；`_rand` 位於 `0045EEB1`。recurrence 為：

```text
state = uint32(state * 0x343fd + 0x269ec3)
result = (state >>> 16) & 0x7fff
```

- `__getptd` 路徑於 `00463F80` 將 TLS offset `+0x14` 初始化為 1，證實不是 process-global stream。
- `CApp::SetUp` 與 thread entry 都以 `time(nullptr)` 呼叫 `srand`；seed domain 是 Unix epoch seconds。
- `test/rand.test.ts` 直接固定 CxLogin PE 中 `srand`、`rand` 與預設 seed write 的 bytes，不借用 FxServer/FxShop 的位址來推論另一個 process。

### Port owner 與消耗規則

`CLoginPool` constructor 現在持有可注入的 `workerRandom: CRand`。production 預設只在建立 logical worker 時以 epoch seconds seed 一次；request、socket、room 都不重新 seed。測試可注入固定 seed，但 production 不使用固定 seed。

`OnRequestDestoryService` 只有通過 header-type 驗證後才消耗一次 stream，並執行精確的 `rand() & 3`。拒絕的 header 不得推進 RNG。`test/login-rand.test.ts` 以 seed 1 驗證前三個回覆 room code 為 `1,3,2`、socket state 同步更新，而且錯誤 header 消耗零次。

FXGS、FXSS、LS 各自持有不同 `CRand` instance；沒有 suite-global stream。Bun 單 event-loop 的 logical-worker owner 是明示的 port architecture boundary，不宣稱重播 Windows 多 IOCP worker 的非決定性排程。

## 回歸隔離修正

本輪以單檔執行既有 local-billing credential-redaction regression 時，發現它曾依賴另一個test先建立動態packet-name registry。`PACKET_NAME_TABLES`現補齊`LOCALBILL`的反向send/recv靜態context mapping；production server原有registration不變，單檔與全套執行都會把DigiQ credential payload遮蔽。這是log metadata／test-order修正，不改wire。

## Probe 與驗證

`tools/compatibility-probe.ts` 新增兩個 isolated observations：

- `A13.local-calendar-OLE-wire`：Asia/Taipei local fields 的固定 8-byte OLE wire。
- `A14.login-destroy-service-CRT-stream`：經 Login handler 的 seed-1 `1,3,2` room-code sequence。

兩項均為 `MATCH`；第一份 probe 現為 **18 MATCH / 0 GAP**。Probe 是靜態 native expectation 對 TS fixture，不是假裝執行 Windows binary。

最終驗證：

- `bun run check`：toolchain identity、159-module import-cycle、103-unit／112-class source-boundary、strict TypeScript全數通過；
- tests：**688 pass / 0 fail / 26,656 expect() calls / 37 files**；
- `bun run probe`：第一份 **18/18 MATCH**、第二份 **24/24 MATCH**，合計 **42 observations / 0 GAP**；
- `git diff --check`通過。
