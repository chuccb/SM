# 原生持有道具讀取端：ItemSn／StockSn、原始 DATE、CUser 與 201／105

本節是**有來源與邊界的讀取端實作**，不是宣稱原生庫存 SQL、商城或完整伺服器已完成。`CConnectPool` 的正式資料路徑仍讀取既有 SQLite `_USERINVENTORY`；不會把自增 `SN`／`ItemID` 或 Unix 日期偷偷改解釋成原生欄位。完成與原版客戶端相容旗標繼續為 `false`。

## 已接線與未接線

| 範圍                                                                          | 現況                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 已觀測到的 rowset／`CTime::GetVariantTime` 輸入 → detached 原生載入投影       | `FXGS/UserInventory.ts:PlanInitUserInventory`，無 SQL 或主機時鐘副作用                                 |
| 原生 resident row、不可變安裝／snapshot、原名查詢、trusted Amount／dirty 操作 | `Common/UserInventory.ts`、`Common/CUser.ts`                                                           |
| 原生 201、category WORD list、accessories、self／nonself 105                  | 實際 production builders；需**明確可信原生附掛**，不是自動授予／裝備                                   |
| inventory request **209** → 201                                               | 真正 `CChannelPool.OnPacket` 已以兩個 local users 測試；不是 request 50，也不只是直接呼叫純 serializer |
| pending money／house／legacy paid／result 的原生 generation drift fence       | 納入現代 frozen-plan 檢查，含同值重載／ABA／storage 回呼後再檢查                                       |
| 原生 SQL → GS loader、pre-inventory、SQL timestamp → Windows calendar／DATE   | **未接線／未完成**；不以純投影充當此流程                                                               |
| 原生正 quantity 的 paid durability                                            | **明確拒絕**，不送進既有 legacy SQLite CAS；quantity0 原生 relay 保留                                  |
| native deferred flush／collector、shop billing、crash recovery、原 client     | **未完成／未驗證**                                                                                     |

## 原程式來源

以附帶的 `FXGS/FxServer.exe.c`、同 PE 的 `.lst` 與 read-only PE bytes 交叉核對；位址屬於這一批 supplied FXGS，不套用舊 `.map` 的位址。

| VA                     | 行為                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `0040AF55`             | `CDBMan::InitUserInventory`，先呼叫 `InitPreInventory`，其成功才繼續讀取原生庫存               |
| `0040ACF4`／`00409F05` | pre-inventory／`prLoadInventory`，不只是 read-only SELECT                                      |
| `00411FFF`             | `CRSUserInventory::OnReceiveRow`，七欄原名與 resident 成員位置                                 |
| `0040A10E`             | `DeleteInventory`／`prDeleteInventory`，key 是 UserID + **ItemSN**，不是 StockSn 或現代自增 SN |
| `00433850`／`0043385B` | `CTime::GetVariantTime` 呼叫 Windows `SystemTimeToVariantTime`                                 |
| `00408CC1`／`00408D31` | DB clock 同步鏈，最終呼叫 **SetLocalTime**；只記錄證據，絕不在移植中改主機時間                 |
| `00416A8E..00416C0C`   | CUser resident 查詢、category list 與 201                                                      |
| `00419597`／`00419A6E` | accessory body／105                                                                            |
| `00417B7B`／`00417B7F` | `AddInventory`，新附加 row 的 dirty 設0                                                        |

loader 的 select 原字串在 `0048C604`：

```text
ItemSn,Slot,Amount,DateCreated,LevelCreated,StockSn,Verbose
```

### 原生 resident 的 84-byte 角色

這是用來理解原碼的 offset，不是要求 JS 模擬 Win32 object layout。

| offset     | 角色                                                    |
| ---------- | ------------------------------------------------------- |
| 0／4       | ItemSn／StockSn，兩者不同；首 DWORD 是 catalog identity |
| 8／12      | Category／strAttr，從匹配的 `UserItem` 定義複製         |
| 24／28／32 | nAttr1／nAttr2／nAttr3，從定義複製；不泛稱為價格        |
| 36／40     | Slot BYTE／Amount signed DWORD bits                     |
| 44／56     | owned Verbose／CTime；Verbose 不是 catalog strName      |
| 76／80     | LevelCreated signed SHORT／dirty                        |

`UserInventoryRecord` 是已通過 rowset／CTime 觀測後的邊界；`UserInventory` 再加入 resident metadata。ItemSn／StockSn 保留 unsigned DWORD，Amount 與三個 attrs 保留 signed DWORD bits，LevelCreated 的 unsigned16 拼法會正規化為相同 signed16 位元。

## 純載入投影：不是 SQL LIMIT400

呼叫端必須先捕獲 `CUserItemMan.CaptureSnapshot()`，並提供**已觀測的 finite raw OLE DATE doubles**及匹配 row 所需的 current DATE callback。不是傳 `Date.now()`、Unix expiry、DBTIMESTAMP 或本地時區字串來猜轉換。

1. 依原 rowset 順序取 row。`GetNextRow` **先於**400-counter 判斷，所以有額外輸入時可能已 fetched 第401筆；EOF 也算一次 rowset read。
2. 用 **ItemSn** 查同一 catalog generation。找不到定義：計入400、不採 clock、不發出 delete attempt。
3. 定義存在時，signed cached level **≥ signed16 LevelCreated** 代表失效；即使此時已知失效，native 仍採 current CTime／DATE。
4. raw current DATE **嚴格大於** stored DATE 才日期失效；相等保留。不能推論 DATE0 是永久，也沒有隱含 Unix 對照。
5. 失效時記錄 `DeleteAttempts`，**不增加400-counter**。原 loader 不使用刪除回傳值；本投影更不執行 SQL，因此它不是已刪除／已提交的回執。
6. 成功 row 複製 metadata、dirty0，再增加 counter。Category5 且 Slot≠255：level-icon enable1、icon 為 definition SN；Category6 且 equipped：fake-level 為 nAttr1。同類 hook 後來者覆蓋先前值。

輸出包含 Rows、Equipment、DeleteAttempts、MissingDefinitionRows、RowsetReads、FetchedRows、CountedRows、ClockReads 與 CatalogRevision。全部 detached／frozen；clock callback 中成功 reload catalog 也不會混用新舊 metadata。

### 刻意的現代 hardening

- 整批預先複製與驗證，連 native 可能不再處理的尾部 bad row 也拒絕；不安裝半份。
- `RuntimePolicy.MaxNativeInventoryLoadRows=65536` 是 trusted work cap，不是 recovered SQL 上限，也不假稱完整 native rowset 可達性。
- 可信 resident install 限400，是這個**受限讀取端 API**的容量政策；native 初始 loader 的400-counter 不等於 native 所有 append／grant 路徑都只允許400。
- 非有限 DATE、不可編碼／NUL／超限字串、catalog identity 不匹配、revision exhaustion、重入與非空 legacy 混用均拒絕。

## CUser 原生 mode 與既有 SQLite mode 分開

`InstallUserInventory(plan.Rows, plan.Equipment, text)` 是**可信內部附掛**，不授權 SQL grant、client request 或 durable ACK。安裝先完整驗證再發布；reload／consume 推進 revision。設備由明確 Equipment 投影附掛，並非看到任意 Category／相等 ItemID 就自動猜出裝備。

- 原生 mode 選擇 immutable native vector；舊 `m_aInventory` view 是 detached／sealed 的空陣列，舊 array 的持有者或 accidental push/splice 不能建立影子 legacy layout。
- `m_aInventory = authoritativeLegacyRows` 明確離開原生 mode、推進世代並清掉原生 fake-level／icon。這是現代 mode replacement，不是原伺服器 service-local object 的逐位元復刻。
- `GetUserInventory` 首個 ItemSn；signed int key 保留 unsigned DWORD bits。沒有 StockSn fallback。
- `GetUserInventoryFromAll` 首個 strAttr byte-equal match；`HasFunctionalItem` 另要求 Category2。**不增加 Amount、Slot 或日期 predicate**。
- `GetInventoryLoaded(category)` 首個該 Category 且 Slot≠255；category 查詢不因 BYTE 存放就把 -1／256 自動 wrap。
- slot decoration：Category10、nAttr2==position、equipped；character decoration：Category12、同 predicate；均 first match。
- `AddInventory` 只清新 row dirty0；trusted consume 替換首個 ItemSn 的 Amount／dirty1，Amount0 保留 resident，舊 snapshots 不變。這**不是原生 paid SQL 或完整 flush**。

## 201／category list／105

201 每 user body 是 **DWORD count → ItemSn DWORD → Slot BYTE → Amount DWORD → Verbose string → raw8-byte LE DATE**。一般 scalar 仍走 caller degree 的既有 obfuscation；DATE bytes 不走 scalar XOR。signed zero 的 DATE bits 保留，不擅自 canonicalize 成正零。

category list：WORD count，再列出所有該 Category 的 **low WORD ItemSn**，包含 Slot255／Amount0；不是 StockSn、nAttr1 或 only-equipped list。

accessories：

- slot positions0..8：BYTE count，非空才附 player slot BYTE，再逐筆 position BYTE＋nAttr1 low WORD；
- character positions0..4：BYTE count，非空才附 player slot BYTE，再逐筆三個 DWORD attrs；
- tail：首個 equipped Category14 的 nAttr3 DWORD，否則0。

105 self-only BYTE 是首個 equipped Category4 的 nAttr1 low BYTE；缺少時255。然後保留原 state／simple-info 與 accessory body。每份105捕獲**一份**原生 rows generation＋simple-info clone，避免字串 codec callback 重載後得到舊 self BYTE／新 icon／新 accessory 的混合。201 同樣捕獲一份 immutable vector；serializer detached 完成才 append，錯碼頁／whole-body overflow／caller-prefix overflow 不損壞 prefix 或先送第一個 local user。

## paid 邊界與 frozen plan

native row 不能送進 `_USERINVENTORY` 版 `CopySpecialItemInventory`；正 quantity146 在 legacy persistence 前明確拒絕，即使 ItemSn 剛好等於舊 SQL SN／ItemID，也不扣錯庫存。quantity0 保留免費159 relay及 whole-sender-TCP exclusion，不查 stock／設 Shop／Nice／寫 receipt；type22 只有 state3 的 elapsed timestamp 行為保留。

money／house／legacy paid 的 shared world fingerprint 加入各 user **mode＋revision**；result fingerprint也加入。光比 rows JSON 不夠：同值 reload、native→legacy→native、consume 後裝回原值都必須凍結原 plan。result storage 回呼後也再次驗 fingerprint／occupants，才可進入 counters／stage／163。

若 trusted storage callback 在 root COMMIT **之後**重載 native generation：SQL／receipt 已 durable，不假裝回滾；live After／成功封包仍不發布，原 plan 留下等待明確 recovery，不能自動重付／rebase。這不是對任意 JS 欄位或外部 SQL writers 的通用原子 fence，亦不代表 native stock 已有持久化。

## 為何尚未接原生 SQL loader

- `InitPreInventory` 包含 premium／auth、Exp＋SetLevel、Money、procedure return、延後 flush 等副作用；30是成功處理數，不可替成單純 SELECT LIMIT30。某些副作用在 procedure 最終成功以前發生。
- `prLoadInventory` 使用 PreInventorySn／UserID／ItemSN／StockSN／Slot／Unit／ValidityPeriod／UserLevel／TruncateOnly，需核對真實 SQL module、constraints／defaults／key／collation。
- `Get_FieldDate` 的 civil SYSTEMTIME、CTime local calendar、`SystemTimeToVariantTime` 無效日期／fraction／timezone／range 行為尚未完整實證。不能把現代 Unix bridge 搬過來充當 Windows 轉換。
- DB clock 同步涉及 `prGetTime` → `ConvertDBTimeToSystemTime` → **SetLocalTime**；絕不修改 host clock。未來須設計隔離的 per-server 時鐘 adapter，不能把危險副作用照搬。
- BAK 的只讀 ASCII 片段不是 SQL Server restore；沒有執行 supplied EXE／DAT 或拼接出的 SQL procedures。
- native paid metadata CAS／receipt 版本、耗盡處理、deferred flush／collector、reload／handoff 和 restart recovery 都需要獨立設計。schema6／legacy inventory／四類 receipts 本輪完全不改格式。

## 驗證與重建

- `tests/reference/user-inventory.cpp` 是**我們人工轉寫的獨立 C++ 模型**，不 import TypeScript／production codec；只編譯執行這個模型。
- **72個 fixed PE instruction anchors＋原 select 字串、1768 cases**：全部256 Category、Slot／signed Amount、signed16 threshold、strict raw DATE／負零、400與missing／expired／extra-fetch boundaries、order／first-match／hook overwrite、Big5／CP949／UTF8、queries／201／category／accessory／full self與nonself105。
- `UserInventory.test.ts`：15項；所有1768投影與實際 CUser／packet consumers、atomic／immutable／codepage／callback／work bounds／revision／legacy-separation。
- `UserInventoryLifecycle.test.ts`：16項；request209的雙local非空201與第二筆overflow、無SQL副作用、正quantity拒絕／quantity0、真106／discovery／109／150後pending ABA、storage callback後檢查、lost result ACK與不阻擋無drift的legacy paid。
- **不是 supplied 原程式 execution oracle、真 native SQL→GS路徑或原版 client 可玩性證明**。兩local209測試是 production handler＋memory transport，不能誤稱原生庫存的 TCP／SQL 端到端測試。

```sh
./node_modules/.bin/bun run vectors:user-inventory
./node_modules/.bin/bun test tests/UserInventory.test.ts tests/UserInventoryLifecycle.test.ts
./node_modules/.bin/bun run verify
```

全套結果、17份模型重建／穩定性、重複測試與98個供給原檔完整性見 [Coverage](Coverage.md)。

## 後續Center lease：正式資料仍是legacy

新增[ConnectionAuthorization](ConnectionAuthorization.md)將正式GS的Center驗證移到account／inventory讀取之前，以private issued-pending registry、exclusive non-consuming lease與全組post-callback fence完成single-use handoff；DB rows先capture並重綁authorized ID，不alias待編201／live資料。native read-side與正quantity fail-closed不變。這一輪沒有把缺少的pre／calendar／native初始化或paid SQL假裝接上，schema6／四receipts與完整／原client旗標不變。
