# 剩餘工作清點（二）：Billing、購入／領取／載入、戰績持久化

日期：2026-09-20。接續 [第一輪 A01–A15](remaining-work-audit.md)。

**後續修復更新：** [A01 共用 TCP 發送鏈](transport-compatibility-fix.md)、
[A11／A21 個人動態資料鏈](user-dyninfo-compatibility-fix.md)、
[A03 建帳交易與競爭](account-registration-compatibility-fix.md) 已完成各輪列明修復與回歸。
另有 [A04 Center 逾時與狀態清理](center-timeout-compatibility-fix.md)、
[A16 Taiwan billing transport](billing-transport-compatibility-fix.md)、
[A06 NexonClub ID](nexonclub-id-compatibility-fix.md) 已完成報告列明差異。
目前已列 A 待辦 **14 組**、兩輪 probes 最新合計 **11 GAP／27 MATCH**；全套 **653 pass／0 fail／26,475 assertions／32 files**。
另完成 [Practice 立即開局／練習選圖／UDP-loss 誤踢修復](practice-start-compatibility-fix.md)：
恢復普通房間空 stub 與 Practice override 的 vtable 分流；真實 TCP 不送 UDP 即收到150，普通房間 gate 保留。
另完成 [GS ↔ Shop 轉服修復](shop-transfer-compatibility-fix.md)：回覆 opcode、Shop request 寬度與整組使用者檢查；新增雙向 TCP 回歸。
另完成 [DigiQ 授權／餘額回覆](digiq-authorization-compatibility-fix.md) 的 224→341/342→209→301/302→203；後續新增[本機 billing](local-billing.md)，已驗證常駐商品／flat package 的原子結算及回 GS 的實際 inventory 回覆。
本機政策不等於 native backend；A08/A17 其餘 gift/coupon/cart、receipt/reset、外部 settlement 等仍待修，這些工作仍保留待辦。
另完成 [A20 GS 庫存／道具狀態／裝飾封包](user-inventory-compatibility-fix.md)，含原版道具登入／重入／201／71／105 TCP 回歸，三個 A20 probe 已為 MATCH。
另修復 [爆炸頭／category 購買限制與遊戲金錢發貨期限](shop-purchase-compatibility-fix.md)：原價6034實際TCP購入、回GS與重新登入；A18三項、A19商城三項及A07已建模coupon reset probe轉MATCH。
A07完整狀態、A18其餘交易／proc核對、A19預庫存與A13日期仍不宣稱完成，分組仍維持14。
原版 CAItem 定義資料也已[安全匯入](caitem-catalog.md)；A15 其餘資料／遷移範圍不因此宣稱完成。
原生 source-unit／class boundary 與 lifecycle ownership 亦已整理並由 audit 驗證：103 native units、23 port-only boundaries、112 classes，158 modules 無 static value-import cycle；Relay server／dispatcher ownership、monotonic DWORD clocks、CRC 單一來源與 fixed-width codecs 均已補回歸。
工具鏈統一與尚未取得的 GitHub Bun canary 限制見 [port README](../README.md)。
Center 全域 serial／SID、其餘建立回報與位置查詢另列第一輪 B，不含於上述完成範圍。
以下除已修項目的註記外，保留第二輪清點當時的結果。A16–A23 中 A16 transport、A20 live-row／裝飾鏈與 A21 個人資料範圍完成；
不能因此把 billing 業務 handler、商城、其餘庫存生命週期或公會結算視為已修復。

## 範圍、需求與結果

- **未知帳號登入自動註冊是使用者明確需要的功能，保留。** A02 改列已確認需求差異，
  不列待修；原本的自動註冊測試保留。A03 建帳失敗回滾為獨立缺陷，後續已修（見上方）。
- 本輪新增 **A16–A23，共 8 組工作**。加上第一輪 14 組待辦，合計 **22 組待辦**；
  穩定編號保留至 A23，A02 不計入。這是工作分組，不是 22 個單一 bug 或完整清單。
- 新增 `tools/compatibility-probe-2.ts`：**24 個隔離觀察，23 GAP、1 MATCH**。
  第一輪重跑為 **14 個觀察，13 GAP、1 MATCH**；兩輪共 **38 個，36 GAP、2 MATCH**。
  MATCH 分別是已確認的自動註冊需求及 ASCII shard 對照，不表示整個子系統相容。
- 這仍是清點輪，**沒有修改業務程式、DB schema、既有測試或依賴**。
  工作樹原有地圖／RNG 修改保留。沒有執行 Windows EXE、外部 billing 或原版 client。
- 原生預期由 `.c/.lst` 靜態證據建立，TS 的實際結果由隔離 probe 取得。
  下文另外標明同一工作組內尚只有靜態確認的分支，避免把它們算成已執行案例。

## A16 · 已修復（原 P0）· Taiwan billing transport 的 frame 與 opcode 寬度

- 原差異：誤將 `CSendPacket(opcode,4)` 的 4 當 cipher degree，送成遊戲三 byte 外框與一 byte opcode；
  正確 351／123 為 `00000005000000070000015f7b`，原 TS 卻送 `2900025f7b`，接收亦失敗。
- 已分離 `FXSS/Packet.ts`、`FXSS/BillingSocket.ts`，實作 native Tw raw frame、4-byte opcode、
  舊 gift／coupon 的 enum-family 前綴，以及長度／decode／FIFO／dispatch 接線。
- `.lst` 查證接收端不驗證 header 常數7；錯誤的 vtable +100 是 CloseAll，production flag=1
  時會 close 後 exit 0，不是只斷線重連。這些分支一併修正，沒有只補 happy path。
- 新增59項回歸（包含真實 TCP 與7個 fatal 子程序案例）；全套375pass，兩項A16 probe均MATCH。
- 詳見 [A16 修復報告](billing-transport-compatibility-fix.md)：保留 DWORD sentinel／signed 比較，
  對 native 超大 allocation／越界 copy 則安全拒絕，不聲稱複製 UB。
- A08／A17 的 handler、交易／body 欄位及其餘 retry／IOCP 排程仍未完成；
  codec 能收送正確外框，不等於購買成功、餘額回覆或整個 billing 系統已相容。

## A17 · P0 · Billing 302 解碼、成功／失敗語意及 311 correlation 欄位

**後續部分修復：** 302 精確 byte 解碼、結果分支、錯誤字串及獨立 user+3104 cache 已修；
probe `A17.billing-302-serial` 已為 MATCH，另有正反 wire／cash guard 與 TCP 回歸。
詳見 [DigiQ 授權與餘額修復](digiq-authorization-compatibility-fix.md)。
後續[本機 billing](local-billing.md) 已用 `.lst` 核實並修正 311 global-serial correlation，該 probe 亦為 MATCH；
本機 312/321/322 原子結算已通過 TCP/重送/rollback/E2E。這不是完整 native 外部 backend／補償語意，A17 保留待辦。
以下保留原始清點。

- TS `OnRemainCashTw` 讀完名字長度後使用 `DecodeRest()`；該函式會消耗**整個剩餘 body**，
  不是只取名字。因此後續 serial、balance、result 全從 EOF 讀成 0。
  官方 `004039F0` 使用 `DecodeBuffer(len)`，再依次 Decode4 三個欄位。
- **重現**：直接餵 handler 合法 body，名字 `abc`、serial=123、balance=500、result=0；
  實際查詢 user serial 0，而非 123。此例刻意繞過 A16，證明是獨立 parser 缺陷。
- **同函式靜態確認**：官方 result==1 是失敗，讀取 E1 長度的錯誤文字，回 client 203
  `[E1 0][EStr message]`；其他結果更新 user+3104 的 billing balance，回 `[E1 1][E4 balance]`。
  TS 把 result==1 當成功、沒有原樣轉送錯誤文字，也未更新該原生 billing balance 狀態。
  user+3104 與遊戲金錢 user+124 不同，不能看到「balance」就直接寫進 `m_nCash`。
- `RequestPurchaseTw` 官方 `00402860` 在 price、常數 1 後寫的是 user+3096 的 global serial，
  接著 stockSN、常數 1、IP。TS 在此再次寫 `m_nBID`。
  **重現**：SID=111、BID=222、global serial=333，該 correlation 欄實際為 222，應為 333。
  probe 從 body 尾端定位該欄，不讓 opcode 寬度錯誤掩蓋此差異。
- **驗收**：名字／IP／錯誤字串的 byte 長度、302 正反結果及 cache、未知或離線 serial、
  311 request 與 312 response 關聯。不得只改 EOF 問題卻留下成功條件反轉。

## A18 · P0 · 普通商品與套裝的限制判斷、實際給物不一致

**2026-09-21 後續修復：** [商城購入修復](shop-purchase-compatibility-fix.md) 已修本組category matrix、game-Money package給物／父metadata、缺項、限制、modeled reset及cash子receipt，三個probe為MATCH。
涵蓋原版爆炸頭、premium／billing分流與DB錯誤注入；明確保留原生部分給物／最後結果／忽略debit return的非原子邊界。
尚未宣稱全體交易狀態、有效SQL proc及跨DB拋錯／補償已完成；本組保留待辦。以下為修復前紀錄。

- 官方 `CMainPool::OnReqPurchaseStockItem` `00415EA0`（`.c:19239..19671`）：
  category 1／15 不套用 category 13 的 `nAttr1` 數量上限；13 達上限回 11。
  TS 單品路徑對所有 category 都檢查 `owned >= nAttr1`。
  **重現**：未持有 category 1，nAttr1=0、遊戲金錢足夠，TS 回 11；官方流程應購入成功回 0。
- 套裝子項的 category 13 達限時，TS 的 `continue` 反而放行；官方會回 11。
  **重現**：子項 category 13、limit=1、已有一份，TS 最終回 0，應回 11。
- 官方 category 11 且 MoneyType!=0 的發貨迴圈，逐一把 transaction 的 ItemSN 設成
  子 stock 的 ItemSN，Unit 設成 `PackageMap.Units × childStock.Unit`，呼叫 AddNewInventory。
  TS 雖然走過子項驗證，實際卻只呼叫一次 `prAddInventoryShop(parent.ItemSN, parent.Unit, …)`。
  **重現**：兩個子 stock，Units×Unit 分別 2×3、1×5：
  TS 寫入 `[[200,1]]`（父商品），應寫入 `[[201,6],[202,5]]`。
- 此例是遊戲金錢購入，不是 A08 尚未完成的 Tw 付款成功 handler；即使 billing 不啟用也存在。
- **驗收**：依 category 的完整購買 matrix、一般物品重複持有、套裝空／缺子項、13 達限、
  子項 units、父 stock 的期限／計價來源、premium、billing 路徑、receipt 與 reset。
  官方此迴圈最後才依結果處理扣款，且不是可直接推論出的全域原子交易；
  子項中途失敗、回傳碼覆蓋、跨 DB 的完整語意還需依原生流程／有效 proc 逐一核實。

## A19 · P0 · 商城購入／預庫存領取的期限鏈斷裂，會刪掉新取得物品

### 商城直購 → SQLite → GS 載入

**2026-09-21 已修此子鏈：** game-Money caller及Shop adapter的期限、Addable／return10映射、疊加metadata已修；三個商城probe為MATCH，原版6034購入後回GS及完整重登入皆保留。見[修復與界線](shop-purchase-compatibility-fix.md)。
以下保留修復前的證據；預庫存與日期整體語意沒有一起冒稱完成。

- 官方 FXSS `AddNewInventory(user)` `00408CE0`：
  ValidityPeriod 非零用原值，0 使用 100000；ValidityLevel 非零用 **目前等級+ValidityLevel**，
  0 使用 **2000**。這些是原生預設，不是要散落新增的 magic numbers。
- 低階 `AddNewInventory` `00408B00` 將上述值傳給 `prAddInventory`。
  `UserInventory00.bak` 可辨識 SQL 殘片的 insert 使用 `getdate()+@ValidityPeriod,@UserLevel`。
  此 SQL 證據只支持期限用途，不代表已還原當前有效 catalog 或所有 proc 分支。
- TS caller 傳 bare `user.m_nLevel`；`prAddInventoryShop` 又完全忽略 validityPeriod，
  DateCreated 寫 `datetime('now')`。此欄雖叫 Created，原生 loader 把它當**到期時間**。
- GS `InitUserInventory` 官方 `0040AF55` 在目前等級>=LevelCreated 或 now>該時間時刪除，
  TS 也有此邏輯。不能反過來移除到期判斷來掩蓋上游寫錯資料。
- **重現**：等級10，商品 ValidityPeriod=30、ValidityLevel=6：
  期限剩餘天數 TS=0／應30；到期等級 TS=10／應16；隨後 GS 載入，DB 剩0筆／應1筆。

**本機 billing 後續範圍：** 新給物路徑使用 native 常駐門檻（100000 天／2000），拒絕向已過期／限時 stack 疊加；
E2E 啟用 `FXAttrShop=1`，實測回 GS 的 201 及 DB 存留，不靠關閉 loader 掩蓋問題。
後續遊戲金錢商城 caller 三項 probe 已修為 MATCH；預庫存三項仍為 GAP，沒有宣稱修復全部 A19。

### 預庫存 → 領取 → GS 載入

- 官方 FXGS `InitPreInventory` `0040ACF4` 呼叫 LoadOnUserInventory 時傳
  **目前等級+該筆 ValidityLevel**；TS 傳 bare 目前等級。
  這裡不能直接套用商城的「0 → 2000」規則，兩個 caller 必須分別忠實核對。
- **重現**：等級10、ValidityLevel=6，領取後 LevelCreated=10／應16，
  隨後 live inventory loader 同樣把這件物品刪掉。
- 同函式的 premium ticket：官方僅 SetPremiumTicket 成功且原 authencode 非1才送 upgrade；
  TS 不檢查 DB 成功。**錯誤注入重現**：DB 回0，仍送 auth code 1；應不發送。
- **靜態補充**：官方低階 AddNewInventory 還傳 category 1／13／15 的 Addable，並把 proc
  return10 映為 wrapper return2；TS helper 是無條件 Amount upsert／return1。
  重疊擁有與錯誤碼的完整 SQL branch 尚須補足有效 catalog，不能只改日期就稱整個 proc 相容。
- **驗收**：從購買／贈送／套裝／coupon 到領取、重新登入、日期與等級到期的完整生命週期；
  0 預設、恰好等於門檻、跨日、疊加既有物品、DB 失敗與 premium 權限不得憑空成功。
  與 A13 本地日曆／variant time 一起處理，不能以「一律 UTC」替代官方 wire 日曆語意。

## A20 · 已修復（原 P1）· GS 庫存 loader 的缺項策略、400 上限、裝飾欄位別名

**2026-09-21 後續修復：** 已完成本組 live-row 載入／狀態／裝飾封包範圍，並額外修復功能名稱、假等級／圖示／auth 狀態混用、71 count／圖樣／fakeLevel 及遠端空尾端。
混合 400 邊界、9／5 種裝飾、DB failure、原版道具重入與 TCP 封包均有回歸；見[修復紀錄](user-inventory-compatibility-fix.md)。
A19 上游與 A13 日期仍開放；以下保留修復前證據。

- 官方 `InitUserInventory` `0040AF55` 找不到 UserItem definition 時 ReportError 後**繼續**；
  TS 立即回 false，中止後續載入。**重現**：未知501後接合法502，TS `{ok:false,loaded:[]}`，
  應 `{ok:true,loaded:[502]}`。
- 官方 loop 以400限制非到期處理計數，**未知 definition 也計數，到期刪除不計數**；
  TS 沒有限制。**重現**：401筆合法且未到期，TS 載入401筆，應400筆。
  此次沒有宣稱已測過混合未知／到期的400邊界，驗收仍須補上。
- 官方 `GetSlotDecorationLoaded` `00416BAE`／`GetCharDecoLoaded` `00416BDD` 檢查
  category 10／12、inventory+28 等於指定 slot、+36!=0xff。
  loader 把 UserItem 的 nAttr2 放在 **+28**；也就是同一個實體欄位。
  TS `UserInventory` 把 `nAttr2` 與 `Slot` 拆成不同欄位，loader 只寫 nAttr2，
  兩個 getter 卻比 `Slot`（一直為-1）。DB Slot byte 存於 `SlotByte`，不是此裝飾分類索引。
- **重現**：實際 DB 載入 category10/nAttr2=2、category12/nAttr2=3，皆已裝備；
  getter 返回 `[null,null]`，應取到 `[601,602]`。影響 user detail 和入房裝飾資料。
- **驗收**：失效 row 不阻斷其他物品、精確400邊界、所有裝飾 slot、未裝備／已裝備、
  角色與特殊功能物品的初始化；確認有別名的原生欄位只維持一個可信來源。

## A21 · 已修復（原 P1，個人資料範圍）· 戰績更新／持久化分裂，flush 計數及 int32 邊界亦不一致

> 以下為修復前證據。已統一 dyn、修正 game counter／數值邊界與離房 gate，
> 補上 DB fault、detail、force flush 與真實 LS／GS 重入測試；
> 見 [個人動態資料修復紀錄](user-dyninfo-compatibility-fix.md)。
> DB 失敗行為已核實：原生先清旗標，不自動 retry；公會與 reward float 仍未因此完成。

- 官方 `IncWin/Draw/Lose` `0041D1C1/0041D1ED/0041D219` 更新 user+216/+220/+224，
  這些正是 `_USERDYNINFO` +196 區塊內的 win/draw/lose。
  `WriteUserDynInfo` `00408FD2` 與 `DeferFlushModifiedInfo` `00417603` 使用同一區塊。
- TS Inc* 更新 `m_nWinCount/m_nDrawCount/m_nLoseCount`，但讀取、detail、DB flush
  用的是 `dyn.win/draw/lose`。真正 SendGameResult 與離房判敗均會呼叫這組 Inc*。
  **重現**：原戰績[4,5,6]，各加一次再 force flush，DB仍[4,5,6]，應[5,6,7]。
- 原生只有 `IncGame` `0041D245` 增加 user+2000，DeferFlush 沒達25且非force時不改它。
  TS 在未flush的 else 又增加 `m_nFlushCount`；Boot 的定時 ForEach 確實會呼叫非force版本。
  **重現**：沒玩遊戲，只呼叫一次 nonforced defer，counter從0變1，應保持0。
- **邊界差異**：IncDecExp 原生 `.lst:00416A41..00416A45` 為32-bit `add`、`jns`，
  結果負值則清0；TS 使用不截斷的 Number 加法。
  **重現**：exp=0x7fffffff，加1，TS為2147483648，該 binary 應為0。
  此項是極端數值邊界，不代表一般玩家每次加經驗都錯；其他 reward float 精度尚未完成驗證。
- **驗收**：勝／和／敗／離房→detail→flush→斷線重入一致；24/25次 IncGame，
  nonforced定時檢查、force、modified flag、數值上下界。別再保留互不更新的雙份戰績。
  DB失敗後重試及guild路徑需另外按原生查證，不把個人欄位結論直接套到公會。

## A22 · P1 · BonusMap 應以 Price 排序、同 key 唯一，不是 StockSN／row order

- 已核實樹的 key，**不是因為看見 RB-tree 就猜排序**：
  FXSS `UpdateBonusMapTable` `00410B20` 選取 Price,StockSN；CRSBonusMap `004194D0`
  解出兩欄後，插入 `{key=Price,value={Price,StockSN}}`，使用 unsigned key 的 `insert_unique`。
  `AddBonusCartItem` `0040EB70` 與 `MakeBonusMap` `0040EBD0` 依該 map 升序走訪。
- TS DB `GetFxBonusMapRows` 按 StockSN 排序，CItemMan 直接存 array；符合門檻就覆寫 bonus，
  因而不一定選到最高達標的 Price。wire 表與重複 key 也不一致。
- **重現**：Price200→Stock10，Price100→Stock20，total250：
  TS bonus選20／應10；wire Price順序[200,100]／應[100,200]。
- **重現**：固定 row 供給順序，兩筆 Price100、Stock20/30：
  TS保留兩筆／原生insert_unique僅保留第一筆。此例不假定未指定ORDER BY的SQL row順序穩定。
- **驗收**：低於／等於／介於／超過門檻、空表、重複 Price、unsigned key，
  同一快照下選贈品與 wire table 的順序／count 一致。尚未解決其他 hash_map 的迭代問題。

## A23 · P1 · 帳號 shard 應只折疊 ASCII A–Z，不能用 Unicode toLowerCase

- 官方 LS `GetUserHashNo` `0040A280`、FXGS `00408E41`：取第一個 **unsigned byte**，
  只在0x41..0x5a加32，再%6；FXSS低階DB路徑也可見同式。
- TS `DBMan.ts::GetUserHashNo` 呼叫 `id.toLowerCase().charCodeAt(0)&0xff`；
  這會把原始 ANSI／Big5 byte 映入 JS字串後的0xc0等值當成Unicode字母，錯誤變成0xe0。
- **重現**：逐一餵非NUL首byte 1..255，30種首byte的shard不一致：
  `0xc0..0xd6`、`0xd8..0xde`。例如0xc0應進shard0，目前進shard2。
  同時ASCII `Alpha/alpha` 均為1，MATCH作對照。未把空字串／NUL的原生不安全輸入列入預期。
- 這會影響與官方既有資料分片的相容性，**不是要取消自動註冊**。
  新站若所有caller都用相同錯誤hash仍可能自洽，不能因此否定與原生分片不同；
  也不能推論所有非ASCII帳號都失敗、或直接聲稱SQL collation問題已解完。
- **驗收**：原始byte fixture、Big5多byteID、讀寫／inventory／guild全部caller一致，
  修復前先處理已按舊公式建立資料的遷移／衝突，避免直接改公式造成帳號表面消失。

## 保留的未完成核對與排除項

1. **302錯誤／成功wire與cache**清點當時只有靜態確認，後續已補回歸並修復（見 A17 更新）；
   A19 的商城 zero/default、Addable／return10 後續已修並回歸；預庫存與完整 proc 語意仍待完成。A20 混合 400 邊界後續已補測，見修復紀錄。沒有灌水成 probe 數。
2. 購物車的未完成handler仍歸A08/A09；普通遊戲金錢套裝的實際給物問題歸A18，
   framing歸A16。這是分層定位，不是把同一個錯誤重新編號。
3. 原生 Shop `MakePreInventoryPacket` `0041EBD0` 是 `retn 4`，不能因GS版本有內容，
   就自動替Shop補一份。其原生庫存初始化路徑還有stub／可達性問題，暫不把死分支當正常登入缺陷。
4. `CDynInfoCalculator` 的x87／float取整、guild delta flush、其他字串與hash_map順序、
   其餘DB失敗邊界仍待核實；沒有因本輪8 組完成清點而宣稱整個商城／GS已完整覆核。
5. Relay／Util／Monitor與其他服務仍沿用第一輪B表待核實清單；此次沒有新增其逐opcode
   coverage或Windows雙端trace，不能把本輪回歸綠燈解讀成六服務全相容認證。

## 重現與回歸

在 `port/` 執行（各probe使用獨立process）：

```sh
bun tools/compatibility-probe.ts
bun tools/compatibility-probe-2.ts
bun test
```

- 全新臨時SQLite、capture sockets與明確的fixture/failure injection；沒有listener／外網連線。
  DB在finally關閉及刪除；不讀寫正式使用者資料。單例只在該standalone process中使用。
- probe的GAP是差異報告，不是刻意把錯誤當正解的測試；exit0只表示harness完成。
- 第二輪：**24 probes / 23 GAP / 1 MATCH**；第一輪重跑：**14 / 13 / 1**。
- Bun **1.4.3-canary.1 (26e7a4b36)**：**178 pass / 0 fail，1583 expect() calls，11 files，17.50s**。
- TypeScript **7.0.2**與preview **7.1.0-dev.20260920.1**的`tsc --noEmit`通過；
  兩個probe另以`--ignoreConfig --strict --target ESNext --module ESNext --moduleResolution Bundler
  --types bun-types --skipLibCheck --allowImportingTsExtensions --noEmit`一起檢查通過。
- 既有全綠測試仍未攔住上述差異；它們與38個diagnostic observations分開計算。

## 建議下一輪工作界線

> 此清點時的順序保留；A01、A03 與第 3 項 A11／A21 個人資料鏈已有上述修復紀錄。

先承接第一輪A01/A10基礎層，再以**完整垂直流程**安排修復或繼續核對：

1. Tw transport A16 → 301/302/311/312及相關handler A08/A17 → 付款、贈送、coupon、receipt/reset。
2. 遊戲金錢單品／套裝 A18 → DB期限／預庫存 A19 → GS庫存／裝飾 A20，連同A22贈品及A13日期。
3. 結算／離房 → dyn state → detail A11 → DB flush／重入 A21。
4. A23分片與SQL／編碼一起規劃migration；A02自動註冊持續保留，A03補交易回滾。

每條鏈都需要正常／拒絕／故障／重入及wire/DB/狀態驗收，不能只消除本輪固定fixture的GAP。
