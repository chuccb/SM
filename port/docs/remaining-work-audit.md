# 剩餘工作與官方差異清點

日期：2026-09-20。範圍：目前工作樹（含前兩輪尚未提交的地圖／RNG 修改）。

**續輪清點已完成：** [第二輪 A16–A23](remaining-work-audit-2.md) 新增 8 組，
合計 22 組待辦；A02 自動註冊依使用者要求保留，不列待修。兩份 harness 重跑共
38 個觀察：36 GAP、2 MATCH。以下 A01–A15 與原回歸時間保留作第一輪紀錄。

**最新修復進度：** [A01 共用 TCP 發送鏈](transport-compatibility-fix.md)、
[A11／A21 個人動態資料鏈](user-dyninfo-compatibility-fix.md)、
[A03 建帳交易與競爭](account-registration-compatibility-fix.md)、
[A04 Center 逾時與狀態清理](center-timeout-compatibility-fix.md)、
[A16 Taiwan billing transport](billing-transport-compatibility-fix.md)、
[A06 NexonClub ID](nexonclub-id-compatibility-fix.md) 已修復各輪列明差異。
A02 為保留需求，目前已列 A 待辦剩 **14 組**（不含 B 待全鏈追查工作）；兩份 probe 最新合計
**38 個觀察／12 GAP／26 MATCH**。全套最新 **601 pass／0 fail**。
另完成 [Practice 立即開局／練習選圖／UDP-loss 誤踢修復](practice-start-compatibility-fix.md)：
恢復普通房間空 stub 與 Practice override 的 vtable 分流；真實 TCP 不送 UDP 即收到150，普通房間 gate 保留。
另完成 [GS ↔ Shop 轉服修復](shop-transfer-compatibility-fix.md)：回覆 opcode、Shop request 寬度與整組使用者檢查；新增雙向 TCP 回歸。
另完成 [DigiQ 授權／餘額回覆](digiq-authorization-compatibility-fix.md) 的 224→341/342→209→301/302→203；後續新增[本機 billing](local-billing.md)，已驗證常駐商品／flat package 的原子結算及回 GS 的實際 inventory 回覆。
本機政策不等於 native backend；A08/A17 其餘 gift/coupon/cart、receipt/reset、外部 settlement 等仍待修，這些工作仍保留待辦。
另完成 [A20 GS 庫存／道具狀態／裝飾封包](user-inventory-compatibility-fix.md)，含原版道具登入／重入／201／71／105 TCP 回歸，三個 A20 probe 已為 MATCH。
另修復 [爆炸頭／category 購買限制與遊戲金錢發貨期限](shop-purchase-compatibility-fix.md)：原價6034實際TCP購入、回GS與重新登入；A18三項、A19商城三項及A07已建模coupon reset probe轉MATCH。
A07完整狀態、A18其餘交易／proc核對、A19預庫存與A13日期仍不宣稱完成，分組仍維持14。
原版 CAItem 定義資料也已[安全匯入](caitem-catalog.md)；A15 其餘資料／遷移範圍不因此宣稱完成。
工具鏈已固定為 npm 可用的最新預覽版，所有 src／test／tools 納入同一份 strict typecheck；
GitHub 更晚的 Bun canary 下載失敗，未宣稱已升級，詳見 [工具鏈說明](../README.md)。
上段數字與下文發現過程為清點時的歷史紀錄；有效 SQL schema／序號語意等仍列 B 待核實。

## 讀法與結論

本輪是**清點、查證與重現，不是修復輪次**；沒有把下列業務行為直接改掉。
不能把「六個服務都有入口」或「178 個測試通過」當成完整官方相容。

- **A：已確認的差異／缺實作**。保留 A01–A15 穩定編號，其中 A02 已依使用者要求改列需求差異；剩餘 14 組待辦。
  一組可能包含數個相關錯誤。
  A01–A11 原有共 14 個隔離 probe；A02 現為需求驗證，其餘 13 個重現差異；A12–A14 為靜態對照，A15 為資料部署缺口。
- **B：仍需核實**。只有風險或尚未完成的核對，不計入已確認錯誤數量。
- **C：不能誤列成缺功能**。官方自己就是空函式、停用流程，或刻意的安全邊界。
- P0：正式使用前應先處理，涉及封包完整性、帳號／資料一致性、付款／購買結果。
  P1：明確的協定／狀態差異。P2：其餘核對、部署或極端條件。

查閱了 `port/src` 的全部檔案清單、關鍵標記／亂數／時鐘／singleton 使用，
再針對下列項目讀取對應 EXE 的 `.c/.lst`，部分另讀 PE 位元組。
**這不是 20,000 多行 TS 和全部原生函式均已逐行核對完畢的聲明。**
`.bak` 的 `strings -a` 只提供 SQL 殘片證據，會含舊版本、頁面切段或損傷；
沒有因此宣稱已還原 SQL Server 的完整、當前有效 catalog。

本輪沒有執行 Windows 官方服務，也沒有真實原版客戶端雙端差分。
以下的「官方應有結果」來自靜態指令／流程證據，不是捏造的官方執行紀錄。

## A. 已確認差異／缺實作

### A01 · 已修復（原 P0）· TCP 部分寫入會遺失未送資料

> 下列為修復前證據；現況與完整驗收見 [TCP 修復紀錄](transport-compatibility-fix.md)。

- TS：`src/core/CPacketSocket.ts::Flush` 在 `bunSocket.write(out)` 前將
  `m_nSndCnt` 清成 0，完全忽略回傳的已寫位元組數。listener 也沒有 TCP
  `drain` 接續送出處理。`CenterLink` 的 raw identification、Shop web raw
  reply 等直接 `write` 路徑須一起納入修復，不能只修主封包函式。
- 官方：FXGS `CPacketSocket::Flush` `0043B530`；實際 server override
  `CServerSocket::IssueSend` `0042EE9D`、`OnSendCompletionPacket` `0042EFCF`
  都按已送數扣除／搬移剩餘資料，而非一律清空。
- Bun 的專案內 `bun-types` `Socket.write` 契約明確允許 short write，關閉時
  可回傳 -1；不是 Bun 會自動保存所有 suffix。
- 重現：放入 5 bytes，模擬只送出 2 bytes；應保留 3，目前為 0。
- 驗收：0／部分／全寫、-1、連續 drain、close 時殘留、raw greeting 與加密
  frame 共用順序；慢速接收端實際 TCP 壓力測試。不重編碼已消耗 sequence 的 frame。

### A02 · 已確認需求差異（保留，不待修）· 未知帳號登入自動註冊

- **使用者於本輪明確確認需要此功能。** `DBMan.prCAAuthUser` 的自動註冊保留，
  不新增關閉開關、不改回官方未知帳號失敗行為。
- 與官方原生登入／註冊分流的差異仍有紀錄，但不再列缺陷或修復工作。
- `test/db.test.ts` 對新 ID 登入成功的預期符合目前需求，不應刪除或改成失敗。
  probe 也改成驗證「成功且帳號存在」，標記需求驗證而不是 GAP。
- A03 的帳號建立失敗回滾是獨立問題，後續已修復（見上方紀錄）；自動註冊不能留下半建立的帳號。

### A03 · 已修復（原 P0，交易與建帳競爭範圍）· 帳號建立缺少交易回滾

> 以下為修復前證據。已補齊 immediate transaction、各 INSERT／COMMIT 失敗回滾、
> 多程序取號與自動註冊競爭，並有真實加密 LS 註冊／登入回歸；見
> [建帳修復紀錄](account-registration-compatibility-fix.md)。
> 未把現有 SN/SID allocator 冒稱為原生 identity 等價，也未擅改未完整還原的 Tx companion 定義。

- TS：`DBMan.ts::prCreateUser` 連續 INSERT account／dynamic／TxDynamic，
  catch 後回傳 -1，沒有 transaction。`MAX(SN)+1` 也沒有與 INSERT 鎖在同一交易。
- 官方 SQL 證據：`UserInfo00.bak` 可辨識的 `prCreateUser` 版本都有
  `begin tran`、失敗 `rollback tran`、成功 `commit tran`。
  各版本是否仍插入 TxDynamic 應另作 catalog 還原，但不影響回滾缺失的判定。
- 重現：讓第二筆 INSERT 因既有 dynamic row 失敗，方法回 -1，第一筆 account
  仍留下。這不是只在多執行緒下才會發生的問題。
- 驗收：每個 statement 的錯誤注入後不得有半建立帳號；再驗證多程序共用 SQLite
  的 serial 配發。庫存／預庫存等其他多 statement proc 也需逐一核對，不能由這一例
  推論官方所有跨 DB 動作都是單一大交易。

### A04 · 已修復（原 P1）· Center 轉服逾時與相關狀態／清理

- 原差異：31-bit epoch 與未做 unsigned wrap 的 subtraction，跨 bit31 不會正確逾時。
- 已改用 monotonic uint32 `GetTickCount`，保留 unsigned elapsed **>17,500ms**；
  原生 `.lst:00415617..00415625` 的 `cmp 445Ch`／`jbe` 為門檻依據。
- 同輪修復成功 gate 的 flag/time 副作用、move-only enqueue、獨立 serial `%6` list、
  preincrement 掃描、重複與 stale 節點、目前位置清理、SetFree 冪等／計數／ExtractUser。
  保留雙使用者 LAST-result 與不回滾副作用，沒有新增 timeout packet。
- 新增35項確定性回歸與1項真實 LS→Center→GS 遲到建立回報測試；A04 probe 已 MATCH。
- 詳見 [A04 有界修復報告](center-timeout-compatibility-fix.md)。不認證 Windows 排程、
  全域 serial 配發、整個 establishment handler 或位置查詢；這些另列 B 全鏈追查。

### A05 · P0 · 商城儲值 key、206 封包及 web 驗證三處不一致

- TS：`FXSS/Shop.ts::CUser.m_nChargeKey` 固定 0，constructor 未抽取；
  `OnRequestCharge` 在 206 最後寫的是 `m_nCash`；`OnVerifyKey` 成功後另寫
  `m_pChargeSocket`，導致第二次相同驗證進入 -4。
- 官方：`FxShop.exe.c:28158..28161` constructor 用 `rand()%100000+1`；
  `SetChargeKey` `0041EE90` 同式；`OnRequestCharge` `00415520` 寫的是
  user `+3044` 的 **charge key**，不是 money。
  `OnVerifyKey` `004158E0` 比對 key、回覆 raw int，沒有 TS 加入的成功綁定。
- 重現：新 user 的 key 不大於 0；設 key=321、cash=9000，206 寫 9000；
  相同合法驗證兩次，TS 為 `[1,-4]`，該原生流程應為 `[1,1]`。
- `test/shop.test.ts` 的「214 → 206 charge info echo」目前也把 cash 當正確答案。
- 驗收：獨立核對 FXSS 自己的 CRT／seed／上下文，再同時修 constructor、封包、
  web 驗證及測試；不可只把 key 改成另一種 host random。既有欄位 offset 註解也需重整。

### A06 · 已修復（原 P1）· NexonClub ID 的來源與 billing 傳遞

- 原差異：以 SN／CommunitySvr 配出 ID；原生 `0041FC60` 則在 email 做 byte search，
  命中 `@nexonclub.com` 後刪除尾端14bytes，不是一般 domain parser。
- 已按原生語意修復，pattern 與長度收斂為具名定義；未命中清空舊值，不做大小寫／email 正規化。
- 一併核對 `GetNexonClubId` `0041F000` 與 gift／coupon 的 C-string 使用：
  storage 保留原 bytes，billing view 在首個 NUL 結束；兩處編碼皆使用同名 getter。
- 新增32項專項回歸及1項 SQLite→加密 Shop 登入→coupon billing 邊界測試，A06 probe 已MATCH。
- 詳見 [A06 修復報告](nexonclub-id-compatibility-fix.md)。不延伸認證 SQL／ODBC charset、
  其餘 gift／coupon 交易、A05 charge key、A07 Reset 或 A08／A17 handler。

### A07 · P1 · ResetTranxInfo 幾乎未實作

**2026-09-21 部分修復：** [商城購入修復](shop-purchase-compatibility-fix.md) 清理目前已建模的 transaction／coupon／ID 字串、移除錯誤的2328映射，cash收尾呼叫接線已補；coupon reset probe為MATCH。
原生數值／lists、全體caller生命週期仍未結案。以下保留原始清點。

- TS：`Shop.ts::CUser.ResetTranxInfo` 只清 `m_nTranxSerial`。
- 官方：`0041F170` 清理 TranxInfo 多個數值／字串／list，並清空 coupon
  `+3008`、coupon ID `+3032` 及其相關狀態。它不是只清一個流水號。
- 重現：放入前一筆 coupon／ID 後 Reset，TS 兩者均殘留，官方會清空。
- 驗收：逐一映射實際欄位與所有 caller 的生命週期；不要根據 TS 的
  `m_fTranxInProgress` 名稱或錯誤 offset 註解猜測哪些 native flags 要清。

### A08 · P0 · Billing 312 解析錯位、結果判斷相反；322／342 是空實作

**後續部分修復：** 342 授權與後續 301/302 餘額回覆已補實，含 guard、字串、wire 與 cache，
新增 25 個單元及 3 個 TCP 回歸，詳見 [DigiQ 修復](digiq-authorization-compatibility-fix.md)。
後續[本機 billing](local-billing.md) 已修 312 prefix 與 serial 查找，並提供本機模式 311→312→321→322 結算；
A08 prefix probe 已 MATCH（成功 fixture 移除多餘 tail；strict parser 安全限制另有說明）。
完整 native 外部給物補償、gift/coupon/cart、receipt/reset 仍未完成，A08 保留待辦；以下為原始清點結果。

- TS：`Shop.ts::CBillingProcess.OnPurchaseOKTw` 讀了 name length，卻沒消耗
  name bytes，就讀 serial；以 `result !== 1` 當失敗。其餘分支沒有完成交易。
  `OnPurchaseConfirmTw`、`OnDigiQAuthen` 只有註解。
- 官方：`00403C80`（312）明確 DecodeBuffer(length) 再讀 serial，
  **result 0** 進入後續處理／321，result 1 讀訊息後走失敗回覆；
  非 0 的其他結果也走相應失敗路徑。
  `004047B0`（322）有庫存／失敗補償、204 回覆、交易 log 與 Reset；
  `004044C0`（342）有 209 的 12／13 分支與成功後查詢餘額。
- 重現：312 放入 name bytes `ABCD`、serial 123，TS 拿 `0x41424344`
  （1094861636）查 user，而非 123。
- 不能把註解「需要 live billing server」當成不實作理由。可先用依原生格式
  編寫的假 billing peer 驗證協定與狀態；真實外部服務聯測是之後的另一道驗收。
- 驗收：301/302、311/312/321/322、341/342、gift／coupon 全 dispatch 與錯誤碼；
  使用者已離線、找不到 serial、DB 失敗、重複／延遲回覆、交易狀態 reset。
  本輪只證實以上列出的缺口，沒有把未讀完的其餘 billing handlers 認證為正確。

### A09 · P0 · 購物車起始索引及數量消耗錯誤

- TS：`Shop.ts::OnReqPurchaseCartList` 沒把 `m_nCartCount` 設成解碼 count，
  也沒做原生的第一筆預先 decrement；`PurchaseCartList` 還有最後一筆 fallback。
- 官方：`.c:19910..19960`，先寫 count；無 bonus 時 index 減一；
  先把當前項目 cnt 減一，才呼叫 `PurchaseCartList` `00416CF0` 從尾端走。
  完成時還有 `+3056=0`，TS 目前未清 `m_fCartProcessing`。
- 重現：兩筆 `(10,1),(20,1)`，無 bonus、皆非 billing item；攔截購買呼叫，
  TS 是 `[10,10]`，原生順序為 `[20,10]`。此 fixture 不實際扣款。
- 驗收：1／多筆、cnt、bonus、失敗、billing 暫停後續接、再次購買、結束旗標。
  不能只修索引而忽略 A07／A08 的交易狀態鏈。

### A10 · P1 · 六服務同 process 時，FXGS 仍讀取會被覆蓋的 config singleton

- TS：`main.ts` 順序啟動六服務，各自覆寫同一個 `CServerConfig.ms_pInstance`。
  `FXGS/System.ts::OnLocalServerInfo`、`Chat.ts::SendUserDetailInfo` 及
  `OnRequestUserLocation` 在後續事件仍由它取 ServerIndex。
- 官方：各 EXE 是各自的 process；FXGS `OnLocalServerInfo` `00402645`
  與使用者資訊流程讀取的是 **FXGS 自己的 config**。
- 重現：FXGS index=1，後續另一服務 index=0；再傳 channel types `[0,77]`，
  TS 把 FXGS type 設成 0，應為 77。71／68 的 server index 也有相同來源問題。
- 預設 index 都為 0 的測試容易掩蓋差異；獨立子程序模式不會以相同方式串值。
- 驗收：不同 index 的 all-in-one 啟動、延遲 channel broadcast、71／68；
  盤點其他共享 singleton。選擇 service-owned context 或程序隔離，不猜測補特殊值。

### A11 · 已修復（原 P1）· 使用者詳細資訊的 max-exp 常數錯誤；共用 getter 邊界也錯

> 以下為修復前證據。已修本地／遠端 71、共用 getter、滿級進度與 signed arithmetic；
> 共用表已移至 `lib/LevelTable.ts`，三份 PE 全表比對及回歸見
> [個人動態資料修復紀錄](user-dyninfo-compatibility-fix.md)。

- TS：`FXGS/Chat.ts::SendUserDetailInfo` 無條件寫 `0x7fffffff`；
  `LS/LevelTable.ts::CDynInfoCalculator_GetMaxExpInLevel` 對越界 level 回 0。
- 官方：FXGS `.c:6001` 按實際 level 呼叫 getter；`0040B284` 的有效索引讀表，
  越界在 `0040B298` 回 `0x7fffffff`。
  本輪直接讀 PE：表 `004A84B8` 前四項 `0,3000,6000,10500`，
  `004A8BC0` count=450；越界指令為 `b8ffffff7fc3`。
- 重現：level 1 的 71 寫 2147483647，應 3000；getter(450) 得 0，應 2147483647。
- `test/e2e.test.ts` 現有 level-1 詳細資料 assertion 固定了錯誤的 max-int。
  `GameContext.ts` 的經驗百分比也會用此 getter，不能只修封包一行。
- 驗收：所有等級、最高／越界、零及負經驗、71 的本地／跨服務回覆、結算百分比。

### A12 · P1 · 交易紀錄目前不是原生的日期檔案與分頁協定

- TS：`Shop.ts::CTranxCtrl.CreateNewLog` 空實作；AddTranx 只 push 記憶體陣列，
  production source 沒有呼叫它的地方。GetData 把三個參數當相等鍵，忽略 `_serial`；
  `OnRequestTranxData` 又把輸入的 serial 原樣回送。
- 官方：`GetData` `0041E600` 的前三項是年／月／日，用
  `Log\\TranxLog_YYYYMMDD.txt`；最後指標參數是**可更新的 byte offset**，
  一頁最多 500 bytes，讀到底回 0 cursor，否則增加 offset。
  `CreateNewLog` `0041E960`／`AddTranx` `0041EAB0` 寫檔並 flush；
  `OnRequestTranxData` `00415610` 回傳更新後 offset。
- 影響不是僅少印 log：225→211 的資料內容、續頁值及重啟後可讀性均不同。
- 驗收：多頁、EOF、空／缺檔、指定日期、跨日、重啟、和 billing 成功寫入整合；
  可以用現代持久層實作，但 client 可讀 bytes／cursor 必須保留。

### A13 · P1 · 商城 OLE DATE 用 UTC instant 取代本地曆法時間

- TS：`Shop.ts::variantTime` 用 `date.getTime()/86400000+25569`。
- 官方：購買收據 `.c:19608..19609`、cart 收據 `.c:19893..19894` 使用
  GetLocalTime → SystemTimeToVariantTime；`CTime::GetVariantTime` `00428710`
  也從 SYSTEMTIME 轉換，不是把 UTC epoch 秒直接除一天。
- 以相同 instant、兩端都設 UTC+8 為例，TS 算出的收據日期比本地曆法值少
  8 小時（1/3 天）；UTC 環境測試會掩蓋它。毫秒／秒精度也需對照 API 行為。
- 驗收：明確設定 TZ 的 child-process 測試、日期／收據 wire 8 bytes、到期邊界。
  `FXGS/CUserItemMan.ts`、SQLite 日期字串的時間域要一起核對，不能只改顯示時區。

### A14 · P1 · LS 尚未遷移 rand；FXGS 併發限制仍存在

- `LS/Login.ts::OnRequestDestoryService` 仍 `Math.random()*0x8000 & 3`；
  官方 `CxLogin.exe.c:14793` 為 `rand() & 3`，同 seed 序列不相同。
- FXSS 的 RNG 缺口是 A05：目前不是 Math.random，而是根本沒生成 charge key。
  已更正前一輪 RNG 紀錄的措辭，不把不存在的 TS 呼叫寫進清單。
- FXGS 的算法／序列化消耗已修，但 native IOCP worker TLS／seed 時刻與 Bun
  邏輯 worker 的映射仍是架構限制，詳見 [RNG 核對](rng-compatibility-audit.md)。
- 驗收：分別讀各 EXE 的 CRT 本體、消費點及 seed／執行緒邊界；不能把 FXGS
  的結論直接套到別的 process，也不能宣稱單一 PRNG 已重現併發結果。

### A15 · P1（交付完整套件）· 資料初始化只涵蓋部分 config，非完整官方資料還原

**後續部分完成：** 已提供 [CAItem 第一組原版價格還原](caitem-catalog.md)，六表來源／逐欄／封包／原子空庫匯入與 TCP 購買有回歸。
以下未提供 CAItem 的敘述是發現時的歷史狀態；其餘 config／舊站資料 migration 仍需另行審查，未擅自還原玩家個資。

- `DBMan.SeedConfigFromBak` 只灌入 CAMultiSvr、CALoginSvr、CAString、FxUserOptions。
  `tools/bakdump.ts` 也是 CAConfig 專用；`tools/seed.ts` 是建帳號／改兩張設定表。
- 未提供 CAItem 的 FxItem／FxStock／FxString／package／coupon／bonus 完整匯入；
  schema 存在不等於原始商品定義存在。乾淨 SQLite 會建空商品表。
- 同理沒有完整 UserInfo／Inventory／Guild 備份還原流程；不應擅自把備份中舊使用者
  的個資灌入新部署。需明確區分「官方定義資料」與「是否遷移舊站使用者資料」。
- 測試手工 INSERT 的小型商品資料只能驗證 fixture，不代表出廠商城完整可用。
- 驗收：可重複的匯入／migration、官方定義表 row counts／keys／內容校驗、
  明確的空白新站模式，並記錄缺失資料，不用猜測的假資料冒充官方資料。

## B. 高優先待核實；目前不當作已確認全部錯誤

| 項目 | 現有證據／疑點 | 尚需完成的工作 |
| --- | --- | --- |
| SQL 完整語意 | TS schema 沒有原生 collation／varchar byte limits；`.bak` 出現 Chinese_Taiwan collation 與 reverse(ID) 條件。 | 先可靠重建有效 proc/schema；驗證大小寫、Big5、尾端空白、NULL、長度、錯誤碼、rowcount、int overflow、跨 shard。不能只用 SQLite NOCASE 代替全部 SQL Server collation。 |
| 帳號序號與 companion 定義 | A03 已修取號與 INSERT 的原子性，但原註解宣稱 `MAX(SN)+1`／`SID=SN` 等同原生 identity 缺乏依據；備份 `prCreateUser` 與 `prCreateCommuUser` 的 Tx companion 片段不同。 | 可靠還原有效 defaults／identity／constraints／proc，核對刪除、回滾留洞及 int 邊界，再決定既有資料 migration；不可先猜 sequence、刪表或刪除舊 orphan。 |
| Center 身份／建立回報／位置查詢 | 已觀察 native global serial (+28) 與 account SID (+80) 分離，而 port 仍混用 `nSID`；另有 `OnConnEstablished` 多人／名稱不符分支及獨立 `nSessionIdx` query 欄位。A04 不涵蓋這些全鏈差異。 | 追完 allocator、跨 shard、登入與轉服 wire 的 serial/SID 傳遞，核對重複／missing／name mismatch 的建立回報與目前位置查詢；不可把 A04 的 list 演算法修正推論為實際 serial 值、掃描相位及整個 Center 均相容。 |
| 其餘 DB transaction／錯誤處理 | 多個庫存方法是多 statement、不同 SQLite 連線；未全部 fault-injection。 | 按原生 DB 呼叫和有效 proc transaction 邊界分組，驗證 partial failure、SQLITE_BUSY、multi-process、重試與持久化。 |
| STL hash_map／map 迭代順序 | `FXSS/CItemMan.ts` 以 JS Map 直接產生 item／string stream 與 hash；原生使用 STL hash_map。BonusMap 的 Price key／insert_unique 已另於第二輪 A22 確認。 | 核對 buckets、rehash、碰撞鏈、插入／刪除後順序、table hash；不能假設「SELECT ORDER BY SN」就是原生輸出次序。其他 user table／MTUDP host traversal 也列入。 |
| 非 ASCII／字串比較 | 多處 `.toLowerCase()`；GameData ItemAttr 與 billing message 有 TextDecoder UTF-8。首 byte shard 已在第二輪 A23 確認差異，其餘仍待核實。 | 對照原生 byte string／MBCS／locale；原始樣本＋合成 Big5／NUL／長度 fixture，判斷哪些路徑真有非 ASCII 可見差異。 |
| CItemAttr 與其餘 loader | CBomberAttr／map 已有較完整測試；CItemAttr 仍有直接 DataView 讀取、不同 return／reset 模型。 | 逐欄與 lifecycle／失敗前綴、截斷位置、table caps 核對；不把本輪 bomber 結論延伸成所有 loader 都完成。 |
| Billing 其餘 lifecycle／排程 | A16 已修 Tw codec、FIFO 接線與列明的 fatal 錯誤；原生 ConnectToSvr 另有 server-index 起點、1s Sleep 的同步 retry loop，OnTimer 及 IOCP 資源不足也有獨立語意。 | 對照 server 選擇、重試、同時 reconnect／OnTimer、異常斷線與 native worker 排程；A16 不替整個 CBillingProcess 或 A08／A17 業務 handler 背書。 |
| TCP 收包／斷線／greeting | Bun data callback 一批資料的大小不等於 Windows 一次 IOCP receive；ReceiveFlood 計數依 callback，接收 buffer overflow 亦受分段影響。 | 相同 bytes 任意分段／合併、超過 buffer 的多個合法 frames、首 greeting 提前到達、half-close、最後回覆與 close 先後。short-write A01 不代表 receive path 也已查完。 |
| 其餘時間與 wrap | Relay 仍有 Date.now；LS queue、FXGS／Shop timer 各有不同時間域，`timeGetTime` 是 process uptime 而不是 machine uptime。 | 依「wire／elapsed／日曆／僅 log」分類；驗證 2^31／2^32 邊界、process 重啟、跨程序 clock，不把不同起點本身一概判為 client bug。 |
| FXGS 房間／戰鬥／結算 | 地圖及 RNG 是局部核對；仍有 3,000 多行 Session、Practice、GameContext、Strategy 與封包 gate。 | 建立每個 dispatch 的合法 stage／user／slot／body contract；覆核炸彈／同步物件／死亡／復活／勝負／獎勵／離房／斷線與重入；用多玩家與 timer interleaving fixtures，不能只依 1–2 人 happy path。 |
| Relay／Util／Monitor | 現有 E2E 不等於所有 relay opcodes、管理指令與畸形輸入已覆蓋。 | 從各 EXE dispatcher 建 request→response／state inventory；核對重複 host／serial、重新註冊、TTL、異常長度、權限與執行緒語意。 |
| 啟動與部署 | main.ts 的 --cfg 不是所有 --only 分支都使用；--ip 只改部分 cfg IP，不涵蓋 SQLite 公告／NDA／Relay 全部位址。 | 整理 CLI contract；用獨立主機／非零 index／fresh DB 驗收。這些是 port 提供的新介面，不應誤稱官方 wire 必然同樣有該 CLI。 |
| 原生差分與 coverage | 現有 178 tests 幾乎全為 TS 端預期；沒有 native 同輸入 trace replay。 | 建每種服務／狀態的 coverage matrix；標示原生指令、資料與 oracle 來源；準備可執行的 Windows 參照環境，先比單 worker 可控場景，再比可觀測不變量及併發 trace。 |

## C. 本輪排除的誤判與需保留界線

1. **不能看到 stub 字樣就列缺功能。** `FXGS/Chat.ts::OnSpecialCommand`、
   base session strategy 的若干方法、FXGS `MoveToExchangeSession` 等有原生
   空函式／ReportError 路徑依據。核對 virtual dispatch 後才能決定要不要實作。
2. **Center 的 CAuthenThread 要看這份 binary，不是看類名。** 它確實被建立，
   但這份 `CxCenter.exe.c` 的 `CAuthenThread::Proc` `00405440` 只有 report、
   等待 terminate 的 Sleep loop 和 PostMessage；constructor `00404C30` 又把
   authen 分支使用的狀態初始化為 0。這次沒有把「未串外部 Nexon 認證」直接列為
   一個已證實的現役功能缺口。其他 helper 的可達性仍需獨立查 xrefs，不能反過來
   宣稱所有版本的 billing/authen 都不需要。
3. **安全拒絕不等於必須複製 native UB。** 地圖／bomber 截斷檔案的越界讀取、
   malformed room 的 spawn cap／normalCount guard 已在前兩輪記錄。保留並列明，
   不以重現 access violation／除零當成修復目標。
4. **診斷開關須區分預設。** `CA_CIPHER_LIBERAL=1` 是刻意允許 CRC 失敗的非相容
   模式；預設關閉。額外 log、本地現代 API、SQLite 替代本身不自動構成 client 差異，
   但丟資料、回覆 bytes 或交易邊界改變就構成差異。

## 可重現 probe 與測試證據

```sh
cd port
bun tools/compatibility-probe.ts
```

- 使用全新臨時 SQLite、模擬 socket／billing input，不連網、不啟動服務、不接觸正式 DB。
  finally 關閉並刪除臨時 DB。Date.now override 也會復原。
- 這是 standalone audit harness，不是把錯誤固定成正確行為的 regression tests；
  不加入 `bun test`。輸出 GAP 表示觀察到差異，MATCH 僅表示該 fixture 已一致。
  **exit 0 只表示 probe 執行成功，不表示相容性通過。**
- 第一輪歷史結果：**14 probes，14 GAP**；A02 需求確認後已重跑為 **14 probes，13 GAP、1 MATCH**（涵蓋 A01–A11 的 11 個編號，A02 為需求驗證，A05／A11 含多個 probe）。
- 例如：partial-write pending `0 vs 3`；rollback 後 account 仍存在；
  charge reply `9000 vs 321`；billing user lookup `1094861636 vs 123`；
  cart `[10,10] vs [20,10]`；channel type `0 vs 77`；level 1 max-exp
  `2147483647 vs 3000`。
- 既有 `shop.test.ts` charge cash、`e2e.test.ts` max-exp
  兩個 oracle 明確需要一起改正；`db.test.ts` 自動註冊符合已確認需求，保留。不能用目前全綠的結果否定上述證據。

### 本輪回歸結果

- Bun `1.4.3-canary.1 (26e7a4b36)`：**178 pass / 0 fail，1583 assertions，11 files，15.22 秒**。
- 專案 TypeScript `7.0.2` 與 preview `7.1.0-dev.20260920.1` 的專案型別檢查通過。
- 新 probe 的獨立 strict 型別檢查、`git diff --check` 通過。
- 本輪新增此清單與 probe，並更正 RNG 文件的 FXSS 措辭；沒有變更業務程式、
  dependency／lockfile，也沒有把 probe 的 GAP 加進「178 通過」的數字。

## 建議修復順序與完成標準

> 此清點時的順序保留；A01、A03 與下列第 4 項 A11／A21 個人資料鏈已有上述修復紀錄。

1. **共用基礎層**：A01 發送佇列／backpressure → A10 service-owned config →
   A04 時鐘／wrap。先確保後續 wire 測試不被資料遺失或串 config 汙染。
2. **帳號與持久層**：A03、有效 SQL 還原與 oracle 調整；保留 A02 自動註冊需求，一起補資料失敗測試。
3. **完整商城垂直流程**：A05–A09 ＋ A12／A13，串起 user 初始化→儲值驗證→
   gift／coupon／單品／cart→billing 回覆→庫存→receipt／Reset。
   不把它拆成幾個空 handler 填完就宣稱商城完成。
4. **等級／結算鏈**：A11，補所有 caller 與本地／遠端 user-info 差分。
5. **資料與其餘 audit**：A15、A14，再逐項完成 B 的 service／packet coverage matrix。

每組完成至少須有：native evidence → 明確輸入與狀態 → wire／DB／後續狀態預期 →
正向與錯誤分支測試 → 既有套件回歸。新實作的內部命名沿用已核實原生用途，
重用有意義的常數，且把被證實錯誤的舊 offset／註解同步修正。

前兩輪詳見 [地圖核對](map-compatibility-audit.md) 與 [RNG 核對](rng-compatibility-audit.md)。
