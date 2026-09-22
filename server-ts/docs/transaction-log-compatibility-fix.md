# A12 FxShop 交易紀錄與 225→211 分頁協定修復

日期：2026-09-21

## 結論

`CTranxCtrl` 已由記憶體內假資料改為原版的日期檔案模型：

- `Log/TranxLog_YYYYMMDD.txt`；
- 每筆成功交易立即以原版MSVC text mode append／flush一行ASCII；
- 格式字串與client可見換行是CRLF，磁碟實體值依CRT轉換為CRCRLF；
- client 225 的前三個 E2 是年／月／日，E4 是text-stream byte offset；
- client 211 回傳最多500個CRT解碼後bytes及**更新後**offset，EOF回0；
- 檔案可在重啟後繼續讀取，並已接到可用的local-billing成功322路徑。

## 原版證據

Repository內 `FXSS/FxShop.exe`／`.lst`／`.c` 固定下列行為：

- `CTranxCtrl::GetData` `0041E600`
  - `%04d%02d%02d`組日期；
  - 路徑為`Log\\TranxLog_` + date + `.txt`；
  - 以caller傳入的`count`（handler固定500）從`int& offset`複製；
  - `offset + count >= fileSize`時把offset寫0，否則寫`offset + count`。
- `CMainPool::OnRequestTranxData` `00415610`
  - 依序Decode2 year/month/day及Decode4 offset；
  - 把offset位址傳入GetData；
  - client 211依序Encode2 length、raw bytes、更新後offset。
- `CreateNewLog` `0041E960`
  - 以local date選檔並用`a+`開啟；object只保存`SYSTEMTIME.wDay`供下一次AddTranx判斷換日。
- `AddTranx` `0041EAB0`
  - 格式字串為`%d:%d:%d,%d,%d,%d,%d,%d\r\n`；
  - 欄位依序為local hour/minute/second、kind、parent stock SN、item SN、amount、parent price；
  - `fprintf`後立即`fflush`；成功固定回1。
- 靜態連結MSVC CRT `_write_lk` `0046A55B`會在每個LF前插入CR；`a+`沒有`b`且使用text mode，
  因此上述顯式CRLF在磁碟是CRCRLF。`_read_lk` `00469D04`再把physical CRLF摺回LF，
  所以`GetData`的logical bytes與client看到的仍是格式字串所示CRLF，cursor也以logical bytes計。
- `CBillingProcess::OnPurchaseConfirmTw` `004048F4..004049CD`
  - 成功204 receipt之後建立`Transaction`、呼叫`AddTranx`，再`ResetTranxInfo`；
  - package保留parent stock／price，但item／amount是原生迴圈最後處理的child。

`test/tranx.test.ts`直接從PE section table讀取路徑、日期、mode、line format、CRT newline轉換及cursor更新指令bytes，避免把port自己的常數當成native oracle。

## 實作

### `src/FXSS/TranxCtrl.ts`

- `TRANSACTION_PAGE_BYTES=500`移回實際owner，不再放在泛用Shop constants。
- `Transaction`明確列出kind、stockSN、itemSN、amount、price。
- `CreateNewLog`建立目錄、選擇當日檔並以append模式touch；production預設仍是process working directory下的`Log`。
- `AddTranx`使用同步append且要求flush，使成功回覆後即使process終止也不只留在JS記憶體。
- 具名的Windows text-mode轉換函式重現write端LF→CRLF及read端CRLF→LF／Ctrl+Z EOF；
  不依賴Linux host的newline行為，也不把CRCRLF魔法字面值散落在業務碼。
- `GetData`回傳`{ length, nextOffset }`，讓TS caller不必模擬不清楚的out-parameter；wire semantics仍與原版`int&`相同。
- missing file回0 bytes並保留request offset；正常EOF把offset歸0。
- 原版對offset超出file size會形成無效`memcpy`。Port不複製native UB，而是安全回EOF；合法client cursor不受影響。

### Handler與成功交易

- `CMainPool::OnRequestTranxData`現使用year/month/day/offset具名欄位，client 211編碼`page.nextOffset`，不再原樣回送request值。
- local-billing成功322會依`CItemMan`產生原版欄位、寫檔後執行`ResetTranxInfo`。
- package依原版保留parent stock／price及最後child的item／units；focused regression固定此差異容易出錯的分支。
- 外部billing settlement、gift／coupon／cart等尚未實作的業務路徑仍屬A08／A17；本修復不假稱那些路徑已可用，也不虛構交易資料。

`CFxShopApp`保留production預設cwd下`Log`路徑，另提供具名options及`--tranx-log-dir`test seam，
讓in-process與production-process socket tests都把檔案放進temporary DB tree，避免測試污染repository。

## 回歸與Probe

`test/tranx.test.ts`涵蓋：

1. 原版PE constants、CRT write/read轉換指令與cursor更新指令；
2. exact ASCII logical CRLF／physical CRCRLF、append、flush、跨日rotation及只比較`wDay`的同日號跨月邊界；
3. CRT text解碼後的500-byte多頁、partial final page、EOF、空檔、缺檔、非法offset；
4. process-style reopen後append／讀取；
5. 225→211實際packet body與更新cursor；
6. local-billing package 322成功後的durable row與reset。

`tools/compatibility-probe.ts`新增`A12.transaction-log-cursor`，固定第一頁`500/500`及末頁`52/0`。第一份probe因此為 **19 MATCH / 0 GAP**，兩份合計 **43 MATCH / 0 GAP**。

最終驗證：

- toolchain：Bun 1.4.3（canary revision `26e7a4b`）、SQLite 3.53.4、TypeScript `7.1.0-dev.20260920.1`；
- import graph：159 modules、0 cycles；source boundary：103 native units、112 native classes；strict typecheck通過；
- `bun run check`：**693 pass / 0 fail / 26,693 expect() calls / 38 files**；
- `bun run probe`：**43 MATCH / 0 GAP**。
