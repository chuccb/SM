# 商城爆炸頭購入、category 限制與遊戲金錢發貨修復

日期：2026-09-21。範圍：`OnReqPurchaseStockItem` 的限制／game-Money 發貨、
Shop `AddNewInventory` adapter，以及實際購入後回 GS／重新登入的庫存存留。
這不是外部 DigiQ、完整 SQL Server proc、A07/A08/A17/A18 或全服相容完成聲明。
本文件當時仍開放的 A19 pre-inventory 子鏈後續已完成，見[五組修復紀錄](five-gap-compatibility-fix.md)；A13日期時間域仍獨立保留。

## 實際故障與根因

使用者提供 client 206 payload `94 b2 fb`：`94 XOR 5a = 206`，
`b2fb XOR a569 = 6034`。從使用者選定的 **CAItem FILE 1 原價資料**取得：

| 欄位 | 原值 |
|---|---:|
| FxStock.SN / ItemSN | 6034 / 678 |
| Category / MoneyType | 12 / 1 |
| Price / FixedPrice / Unit | 130000 / 130000 / 1 |
| ValidityPeriod / ValidityLevel | 0 / 0 |
| FxItem.nAttr1 / nAttr2 / nAttr3 | -1 / 0 / 36 |

這是花 **130000 遊戲金幣**的爆炸頭，不是本機 billing 點數商品。
原 TS 對所有單品套用 `owned >= nAttr1`，因此即使沒有持有也會因 `0 >= -1`
回 204/code11，產生「已持有或收到此道具-1個以上」的錯誤。
正確修復是 category 分流，**不是更改 -1、改商品價格或取消 GS 到期檢查**。

## 原生依據與實作

### 1. 限制與重複持有

`FXSS/FxShop.exe.c`，`CMainPool::OnReqPurchaseStockItem` **00415EA0**：

- category **13** 才用 `nAttr1` 作持有上限；缺 FxItem 定義回1；
  inventory + preinventory 已達上限回11，單品附原生 Big5 格式化文字。
  原生比較「目前持有量」，不是預先加本次 Unit；沒有把本機點數政策移植過來。
- category **1 / 15** 不做上限／重複持有限制。
- 其他普通單品：已持有／收到回4；沒有持有即可繼續購買。
- **11** 才展開 package；散落在其他 category 的 map 不會使普通商品變套裝。
  缺子 stock 回5；子13達限回11，使用一般購買錯誤文字而非單品格式化文字。
- package 的重複持有判斷有一個容易誤譯的細節：原生比較 **parent.Category != 15**，
  此分支 parent 必為11，因此 child15 **不**享有單品15的重複持有豁免。

### 2. 遊戲金錢給物與到期欄位

- flat package 發 child.ItemSN、`PackageMap.Units × child.Unit`；保存 **parent.StockSN**、
  使用 **parent 的期限與售價**，不是把 parent 當一件普通物品發下去。
- **00408B00** 低階 `AddNewInventory` 依 **FxItem.Category**（不是 FxStock.Category）
  決定 Addable：1/13/15 可疊加；缺 FxItem 失敗。
- **00408CE0** user wrapper：ValidityPeriod=0 → **100000天**；
  ValidityLevel=0 → **2000**，其他值 → **目前等級+ValidityLevel**。
  使用既有具名預設定義；DateCreated 雖如此命名，在 loader 中實際代表到期日。
- SQLite adapter 一次 inventory grant 使用 immediate transaction。
  疊加只更新 Amount，保留原 StockSN、Slot、到期時間／等級；非 Addable 不覆蓋已有 row，
  並檢查 preinventory 的 row 是否存在（即使 Amount=0）。
  回傳 **1=new row / 2=stack update / 0=failure**；原生 wrapper 把 proc return10 映為2。
- `UserInventory00.bak` 的 ASCII proc 殘片（245038、798762、802742）可辨識 update Amount、
  非 Addable preinventory 拒絕與後期 return10。但有 torn-byte 損壞與多版本，
  **不能視為完整還原且當前有效的 procedure**。未執行這些殘片或還原玩家資料。
- 單品 category9 仍走 PremiumTicket helper，成功才通知 auth；package 判斷的是 parent category，
  子9不會自行轉成票券分支。一般物品 expiry 修復不冒稱已完成所有 premium 生命週期。

### 3. 收尾與界線

- game-Money 完成／拒絕依原生呼叫 ResetTranxInfo；cart 執行時不送每個現金子項的204。
- **0041F170** 已建模的 transaction string（+2904）、coupon（+3008）、coupon ID（+3032）
  清空；刪除舊的無讀寫、錯誤映射為 +2328 的 `m_nTranxSerial`。
  不猜測清除 native cart/connection guards，也不擅自取消本機 billing 的獨立結算 marker。
  原生尚未建模的數值／lists 與全體 caller 生命週期仍屬 A07 等待辦。
- **保留而不是「修正」原生 game-Money 特性**：package 各次給物可部分成功，最後一次結果
  決定總體成功；空 package 不發 parent row、仍走成功扣款；SetMoney 的失敗 return 值被忽略。
  有錯誤注入回歸明確保留這些行為。**這不是跨 DB 原子交易或財務安全保證。**
  SQLite debit SQL 直接拋錯的通用處理／全域補償仍未完成，不宣稱僅靠 adapter transaction 已解決。
- 本機 **MoneyType=0** 的 durable billing settlement、獨立錢包與拒絕不支援商品政策沒有改動。
  不能把遊戲金錢的 legacy partial-grant 行為套到點數扣款。

## 驗證

在既有精確預覽工具鏈執行，沒有換 stable compiler 或臨時外部 compiler。

- 新增 `test/shop-purchase.test.ts` **46項**：原版6034及原始三byte request、category matrix、
  preinventory、13的邊界、缺定義、map分類、package units／父metadata、空／缺子項、
  child15、部分給物／最後結果、期限預設組合、疊加metadata、DB失敗重試、
  premium、billing分流、cart子receipt與modeled reset、負值debit return。
- 原本 `shop.test.ts` 錯把 category1 當有 nAttr1 上限的 fixture 已改為真正的13，
  1/15 無上限另有獨立回歸，不是刪掉 category1 coverage。
- 真實 TCP：**GS → Shop → 本機點數購入針 → 原價遊戲金幣購入爆炸頭 → GS → 完整登出再登入**。
  遊戲金幣200000→70000；點數100→71、不因爆炸頭改動；重複購入回4不再扣錢；
  兩次 GS 201 與持久庫存皆有針15／爆炸頭1，沒有關閉 loader 或重種資料。
- `bun run check`：**591 pass / 0 fail**（25 files）；包含工具鏈身分檢查與全部 strict typecheck。
- `bun run probe`：**38 observations / 12 GAP / 26 MATCH**。
  A18三項、A19商城購入三項、A07已建模coupon reset由GAP轉MATCH。
  當時預庫存領取、其餘交易／日期問題仍開放、待辦分組為14；後續預庫存已修、目前總表為9組，仍不以probe全綠冒稱全部結案。

沒有執行 Windows 原版 client／server EXE、外部 DigiQ，也不是原版執行結果的動態差分或畫面認證。

## 套用

更新程式後重啟使用中的服務，重新登入再購買；保留所有現有 DB 和 FILE 1 商品價格。
帳號需有足夠的 **遊戲金幣**，加本機點數不能替代它。爆炸頭已持有／在待領取資料中時仍按原生拒絕重買。
此次不修改既有玩家日期或做資料清空：舊版本已錯寫為過期、甚至已被刪除的物品，
不能在沒有交易證據的情況下盲目延長或補發；這次修復的是後續給物與持有鏈。
