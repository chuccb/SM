# A05／A09／A10／A19／A22 相容性修復

日期：2026-09-21。範圍是前兩輪 probes 仍明示的 11 個 GAP：Shop charge key、購物車 cursor、FXGS service-owned config、GS pre-inventory，以及 Shop BonusMap。

本輪只以 repository 隨附的 `FxShop.exe`／`FxServer.exe` 反編譯、listing、map/PDB 符號與 PE bytes 作原生依據；沒有執行 Windows EXE，也沒有把 TS 自己的舊行為當 oracle。未知帳號登入自動註冊與使用者選定的第一組 CAItem 原價均未改動。

## A05：charge key、206 與重複 web verify

### 原生依據

- `FxShop.exe.c` 的 `CUser` constructor 在 `004200E8` 消耗 `rand() % 100000 + 1`；`CUser::SetChargeKey` `0041EE90` 使用同式。
- Shop PE 的 `srand` `00462800`、`rand` `0046280D` 與 CRT thread-data 初值 `00467650` 已直接讀 bytes：state 乘 `0x343fd`、加 `0x269ec3`、右移 16 並 mask `0x7fff`，預設 state 為 1。它與 FXGS 演算法相同，但仍是 Shop 自己的 process／worker stream。
- `OnRequestCharge` `00415520` 的 206 body 是 `[E1 FXAttr][E4 global serial][E4 user+0xBE4]`；最後欄是 charge key，不是遊戲金錢或 billing cash。
- `OnVerifyKey` `004158E0` 只以「找不到 user 或 user+20 非零」回 `-4`、key 不符回 `-3`、相符回 `1`。成功不綁 socket、不消耗 key；回覆是 raw 4-byte little-endian int，之後 flush。
- Shop worker dispatch `00422B7D` 對每個完整 packet 都再呼叫 verify，不存在 port 原先加入的 one-shot verified gate。

### 實作

- `FXSS/CMainSystem` 持有一次以 epoch 秒 seed 的長存 `CRand`；constructor 與 `SetChargeKey` 都消耗同一邏輯 worker stream，不使用 `Math.random()`，也不按 user／request 重 seed。
- 具名常數保留原式的 modulo operand `100000` 與 base `1`。因該 CRT 的 `RAND_MAX=32767`，實際輸出為 `1..32768`，文件與測試沒有誤稱可到 100000。
- 206 改送 charge key；verify 改讀真正的 user+20 transaction guard，移除虛構的 charge-socket binding；raw result 用 `DataView.setInt32(..., true)` 明示 endian。
- `CWebSocket` 每個完整 frame 都 dispatch `OnVerifyKey`。

## A09：購物車最高索引、數量與完成狀態

### 原生依據

`FxShop.exe.c`：

- `OnReqPurchaseCartList` `00416E30` 把 client count 存在 user+3052；該欄在載入後代表「下一個空 slot」。
- bonus 寫在該 index；bonus miss 才將 index 減一。接著在第一次呼叫 `PurchaseCartList` 前，先將目前 row 的 count 減一。
- `PurchaseCartList` `00416CF0` 從最高 index 反向走。每次先購買；MoneyType 非 0 才 reset 並繼續；目前 count `<=0` 時換到前一 row，再預減下一 row。
- index 小於 0 時先清 user+3056，再送 client 215 `[E1 9][E1 0][8-byte VARIANT date]` 並 reset。
- MoneyType 0 會停在當前 transaction、不自行發 cart receipt；若購入後再次 lookup 時 definition 消失也直接返回。初始 cart decode 遇到不存在的 StockSN 則更早發生 null dereference，屬原生未定義路徑。

### 實作與安全界線

- 移除舊的「最後一列 fallback」，按原生 cursor／預減／反向消耗。
- cash fixture `(10,2),(20,3)` 的呼叫順序為 `20,20,20,10,10`；bonus 在 next-empty slot，billing row 會暫停；正常結束清 cart-processing flag 並只送一次 215。
- billing total 依原版每個 cart row 只加一次 Price，不乘該 row 的 count；遊戲金錢子購入失敗仍由原生 cart cursor 消耗，最後依原流程送 cart completion receipt。
- 原生 count=0 或不存在的 StockSN 會對固定陣列／null ShopItem 作未定義存取。Port 對這些 malformed input 在任何購入副作用前安全拒絕、不送成功 receipt，並清 busy flag；不宣稱重現 access violation。
- 外部 DigiQ 的完整 312／321／322 補償與 cart continuation 仍屬 A08/A17 的較大交易鏈；本輪不把 cursor 修復冒稱整個 billing backend 完成。

## A10：FXGS service-owned config

官方六個服務是六個 EXE／process；FXGS 的 `OnLocalServerInfo`、detail 71、location response 都只可能讀自己的 `CServerConfig::GetServerIdx()`。Port 的 all-in-one 模式原先讓六服務依次覆寫同一 static singleton，延遲事件因此可能讀到其他服務的 index；`MTUDPServer::StartupBase` 的延遲 bind 也有同類風險。

- `CFxServerApp` 現在持有自己建立的 config，並明確傳入 FXGS `CCenterProcess`、`CChannelPool`、`MTUDPServer`。
- 三個 owner 在 constructor 捕獲該 config；後續 channel broadcast、71、location response 與 UDP bind 不再讀會被覆寫的 singleton。
- `CServerConfig::GetServerIdx()` 收斂已核實的 typed getter 名稱，其他服務的立即連線路徑也改用此 getter，值與 wire 不變。
- 回歸會先建 index 2 的 FXGS owner，再把 process-wide singleton 換成 index 9：channel type、71、location 仍輸出 2；MTUDP 仍 bind FXGS 的 `ServerPort+1`。

這只修已辨識的 config ownership；不宣稱所有跨服務 static singleton 都已完成逐一動態差分。

## A19：pre-inventory 領取期限、premium gate 與 30 筆 budget

### 原生依據

FXGS `CDBMan::InitPreInventory` `0040ACF4`：

- rowset open 失敗回 0；成功才走 rows。
- `LoadOnUserInventory` 在 `0040AEFD` 傳 `current user level + row.ValidityLevel`。此 caller 的 zero 不套 Shop 購買用的 level-2000 sentinel。
- category 9 只有 `SetPremiumTicket(...)` 成功且 user+2004 authencode 不等於 1 才送 auth upgrade。
- native type 100／101 分別是 money／experience；experience 先改 exp 並重算 level，所以期限基準是該筆處理後的 current level。
- `n30` 只在 `LoadOnUserInventory` 成功、PreInventory 被寫入 user table後增加；未知 item、DB false 與單筆 failure 不吃掉 30 筆成功額度。

### 實作

- `ItemCategory` owner 增加 `Money=100`、`Experience=101`，移除散落 raw number；pre-inventory packet 對 101 的 level 欄也共用此語意名稱。
- rowset query 例外回 false，讓既有登入拒絕／close 路徑處理；單筆 claim return failure 或 throw 只略過該 row，後續仍可領取；money／experience 的前置 side effect 仍保留原生 call order，不以 claim failure 虛構 rollback。
- expiry level 使用處理當下 level 加 `ValidityLevel`；premium auth 通知依 DB BOOL 成功與既有 auth gate。
- 30 筆限制只計成功 claim。32-row fixture 中第一筆失敗時，後 30 筆仍全部領取；失敗 row 與第 32 筆未處理 row 都留待下次。
- packet regression 覆蓋 type 100／101 的 money／exp side effects、101 level 欄、期限與字串順序。

A13 的 Windows local-calendar OLE DATE 仍是獨立工作；本輪不以改掉 loader expiry 判斷掩蓋時間域差異。

## A22：Price-keyed BonusMap

### 原生依據

- `UpdateBonusMapTable` `00410B20` 選 `Price, StockSN`，以 `{key=Price,value=BonusMap}` 插入 `map<unsigned int,...>::insert_unique`。
- rowset 沒有 `ORDER BY StockSN`。duplicate unsigned Price 保留 rowset 先遇到的第一筆；樹 traversal 再按 unsigned key 升序。
- `AddBonusCartItem` `0040EB70` 與 `MakeBonusMap` `0040EBD0` 都走同一 map。門檻 compare 的 value 是 signed compare，而 tree key ordering 是 unsigned。
- rowset open failure 在清 map 之前回 0，因此保留先前已發布 snapshot。

### 實作

- `CItemMan` 改持有 `Map<number, BonusMap>`：先按 rowset 順序 dedupe，再按 `Price >>> 0` 排序重建，並將 `StockSN` 保留為 unsigned DWORD，清楚表達 native tree 的 observable semantics。
- DB query 移除錯誤的 `ORDER BY StockSN`。
- 選 bonus 與 client table 共用同一 snapshot；覆蓋低於／等於／介於／超過門檻、duplicate、negative／`0xffffffff` unsigned key、signed eligibility 與 rowset failure。
- 沒有擅自把 BonusMap reload 加進 native 沒呼叫的 startup／Center packet 路徑；其他 STL `hash_map` 的 iteration audit 仍獨立保留。

## 驗證與限制

- Focused regressions：Shop CRT PE bytes、charge 206／raw verify、cart counts／bonus／billing pause／receipt、service config、pre-inventory DB failure／30 cap／premium、BonusMap ordering／failure。
- `bun run probe`：第一份 **16/16 MATCH**，第二份 **24/24 MATCH**，合計 **40 observations / 0 GAP**。這些是 static-native expectations 對 isolated TS observations，不是 Windows differential execution。
- 完整 `bun run check` 通過：toolchain identity、158-module import-cycle audit、103-unit／112-class source-boundary audit、strict TypeScript，以及 **681 pass / 0 fail / 26,609 expect() calls / 35 files**。
- 未搜尋 web；所有新結論只來自 repository 內原版 binary artifacts 與可重現測試。

仍開放的主要分組包括 A07/A08/A12/A13/A14/A15/A17/A18/A23 及兩份 audit 的 B 類全鏈核對。40 個 probe 全 MATCH 不代表六服務或完整商城已取得全面相容認證。
