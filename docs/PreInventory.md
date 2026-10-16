# 原生預備道具：InitPreInventory 觀測投影、CUser 讀取端與 207

這是從所附 FXGS 反編譯、同 PE 的 `.lst`／固定 bytes **重新推導**的實作，不是回復先前缺失的檔案，也不是完成 native SQL、計費或完整 `InitUserInventory`。

- `FXGS/PreInventory.ts:PlanInitPreInventory`：**純觀測投影**。輸入明示的 rowset／premium／procedure 回傳，輸出 immutable 動態狀態投影、按順序的效果描述與成功清單。
- `Common/PreInventory.ts`、`Common/CUser.ts`：可信 service-local 清單替換、獨立 generation、`MakePreInventoryPacket` 的**單一使用者 body**。
- **不執行** premium、Center auth、金錢／經驗、flush 或 SQL callbacks；沒有把 `After` 套用到 live user 的 API，也沒有 Apply／Retry 財務入口。
- **後續已接線**：[整組讀取端handoff](InventoryHandoff.md)依原條件發布210／202／ALL-local207／forced201，空local仍保留。正式account／owned仍採legacy SQLite bridge，207只取可信既有resident清單，不讀取legacy pre表或執行原SQL loader／計費／durable effects。`completeOfficialRewrite`、`officialClientVerified` 仍為 `false`。

## 來源與欄位

| FXGS VA              | 證據                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| `0040ACF4`           | `CDBMan::InitPreInventory`，成功 counter、category 分支與先效果後 LoadOn             |
| `00409F05`           | `CDBMan::LoadOnUserInventory`／`prLoadInventory` 的九項 input 及兩項 signed 成功條件 |
| `00412108`           | `CRSPreInventory::OnReceiveRow`，十欄 getter 與位置                                  |
| `00416CA9`           | `CUser::MakePreInventoryPacket`，含 missing definition 的 malformed count 分支       |
| `00417603`           | `CUser::DeferFlushModifiedInfo`，force、counter／dirty reset 與 writer 順序          |
| `004089A0..00408A06` | native GS handoff 的 any-pre gate、207 opcode、ALL locals 與後續201                  |
| `0040AF55`           | 完整 `InitUserInventory` 先呼叫 pre，再載入 owned inventory；這個 composite 仍未接通 |

select 的原字串在 `0048C568`：

```text
SN, Type, ItemSn, StockSn, Slot, Amount, Description, ValidityPeriod, ValidityLevel, strAttr
```

原生 56-byte row 的位置只用於核對，不要求 JS 仿 Win32 layout：

| offset | 欄位           | 型別／角色                                                      |
| ------ | -------------- | --------------------------------------------------------------- |
| 0      | SN             | pre row key，DWORD bits；**不是 ItemSn／StockSn**               |
| 4      | Type           | source BYTE；**不是 dispatch Category**                         |
| 8      | ItemSn         | catalog identity，DWORD bits                                    |
| 12     | StockSn        | 獨立 stock key，DWORD bits                                      |
| 16     | Slot           | BYTE；procedure 接收到 zero-extended 值                         |
| 20     | Amount         | signed DWORD bits                                               |
| 24     | Description    | pre 字串；不是 catalog `strName`                                |
| 36     | ValidityPeriod | signed DWORD；不是 owned raw DATE，也不是 Unix timestamp        |
| 40     | ValidityLevel  | **signed DWORD**；不同於 owned definition 的 signed16 threshold |
| 44     | strAttr        | pre 字串；不是 catalog `strAttr`                                |

JS copy 保留 unsigned keys、BYTEs 與 LONG 的 signed interpretation；LONG 可由 signed32 或 unsigned32 spelling 輸入，之後正規化。既有 SQLite `FxPreInventory` 的 `SN/ID/ItemID/Amount/ValidityPeriod/Verbose/CreatedAt` 是**legacy schema**，不會因名稱相似自動改成這十欄，也沒有 schema migration／新 receipt。

## InitPreInventory 的順序

1. native `GetNextRow` **先於** success counter 檢查；只有「procedure 成功並 append」才計入30。
2. missing catalog definition 或 LoadOn failure **不計入30**。因此30不是 SELECT LIMIT、不是最多讀30列；達30後還可能多 fetch 一列，但不處理它。
3. dispatch 看 `FxItem.Category`，不是 pre `Type`、resource item type 或 catalog nAttr。
4. 先做下表的 prefix，再呼叫 LoadOn；procedure 失敗**不撤銷 prefix**。

| Category | LoadOn 之前的 native prefix                                                                                     | TruncateOnly             |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 9        | `SetPremiumTicket(ValidityPeriod)`；若觀測成功且 FXGS auth **BYTE != 1**，請求 `SendAuthenCode(globalSerial,1)` | **1，即使 premium 失敗** |
| 101      | `IncDecExp(Amount)`，再明確 `SetLevel`，然後 forced flush                                                       | 1                        |
| 100      | plain `IncDecMoney(Amount)`，然後 forced flush；**不是 money-pickup RNG multiplier**                            | 1                        |
| 其他     | 無上述 prefix                                                                                                   | 0                        |

`SendAuthenCode` 是 request；此函式**沒有**把本地 auth BYTE 改為1。重複 premium row 可再次請求。它也不是 Center exact DWORD auth 或 legacy `TicketDate` 的替代值。

XP／money 投影使用來源支持的 signed32 ADD wrap，再 floor0（money 再 cap1,000,000）。XP 透過 PE 等級表更新 cached level。forced flush 會先 reset games、dynamic／simple dirty flags，再呼叫 `WriteUserDynInfo`；trace 的 writer event **不是 SQL durability ACK**。

LoadOn 九項 input 依序為：

```text
PreInventorySn, UserID(16 bytes), ItemSN, StockSN, Slot,
Unit, ValidityPeriod, UserLevel, TruncateOnly
```

keys 傳入 SQL LONG 時保留 signed32 bits。`UserLevel` 是 **signed32 ValidityLevel + 當前 cached Level 的 signed32 ADD**；XP prefix 已先更新 level，不能先把 ValidityLevel 截成 SHORT。只有 `ExecResult >= 0 && ReturnValue >= 0`（兩者 signed）才 append；兩項零均可成功，unsigned `0xffffffff` spelling 仍代表失敗。

### 純投影的現代界線

`PreInventoryObservation` 的回傳值由可信測試／隔離 adapter **觀測提供**，不是由這個模組呼叫外部操作。plan 的 `Before/After/Rows/Events` 全部 detach／freeze，**不修改** CUser、catalog、原輸入或 DB。

輸入與所有 row primitives 在 codec callback 前擷取；整份 input（包括 native loop 未處理的 tail）會預先驗證。現代明示 work bound 為65,536，resident bound為native success30，Description／strAttr 各4096 encoded bytes；拒絕 embedded NUL／錯碼頁。這些 work／string policy **不是回復的 SQL 欄寬或 rowset 容量**。`rowsetOpened=false` 不產生效果／讀取 event，仍不跳過現代輸入驗證。

呼叫者必須傳入 `CUserItemMan.CaptureSnapshot()` 的單一不可變 generation；reload 不會改舊 snapshot。pre 只查 catalog SN／Category，不把與此 packet 無關的 catalog 名稱、nAttr 或字串拿來序列化／推定權限。

## CUser 與 207 body

`InstallPreInventory` 是**可信 read-side replacement**：複製並凍結最多30筆，成功才整份替換／遞增 revision；包括空替換及同值重新安裝。reentrant install、無效 row、錯碼頁／數量／revision exhaustion 失敗時不改舊清單或 revision。它不套用 plan `After`，也不變更 owned／legacy inventory、money／XP／auth 或 SQL。

`GetPreInventoryCount`、`CapturePreInventory`、`GetPreInventoryGeneration` 提供 detached／immutable 讀取。`MakePreInventoryPacket(packet,catalog)` 在 codec 前捕獲一份 vector 及 cached level；它只 append 使用者 body：

```text
BYTE count
repeat count:
  BYTE Type
  DWORD ItemSn
  WORD low16(Amount)
  WORD (definition.Category == 101 ? low16(cached Level) : 0)
  WORD (signed ValidityPeriod < 100000 ? low16(ValidityPeriod) : 0)
  string pre.strAttr
  string pre.Description
```

負的 ValidityPeriod 仍通過 signed `<100000`，WORD wrap；不是 validity-level gate。沒有 pre SN、StockSn、Slot、ValidityLevel、catalog 名稱或 fake/look-level。支援 caller 的 scalar／plain coding 與 Big5／CP949／UTF8。

native missing definition 會保留原 count 卻跳過 body；我們**明確拒絕**這個 malformed image。全 body detached 成功才 append一次；missing／identity mismatch、wrong encoding、整個 body 或 caller prefix overflow 都不留半個 count／第一筆。

**後續整組發布已接線：** 原手順為210→conditional202→若任何 local 有pre則207（包含**所有 locals**，空者仍有 count0）→conditional201。[CConnectPool整組preflight](InventoryHandoff.md)現在補上opcode／local-count prefix、同catalog snapshot及全部packets預備後才consume。此處的CUser API仍只是單人body，發布不是native SQL載入／給付或durable送達證明。client request207是delete，與server response207分開。

## 現代授權與 pending fences

pre generation 已加入 Center source fingerprint 與 game result／world frozen fingerprints：

- second local 的同值 reinstall、清空後裝回、不同值後裝回，舊 lease 都失效，不先消耗／移動第一人。
- Center check 偵測 drift 後會 retire issued lease；後續使用為 stale。新的 identity lease 可觀測新 generation，但**不授權重播金融 prefix**。
- pending money／house／legacy paid／result 不因 byte-identical pre ABA 自動 retry／rebase。
- storage callback 已 root COMMIT 後才 drift，保留 durable SQL／receipt，但凍結 live After／成功 publication；不假裝 rollback 或 exactly-once TCP。

這些是可信單一 event loop 內的防護，不是任意 hostile JS／外部 SQL writer 的全域交易權限，也不是 candidate-to-live full initialization 已完成。

## 可重建的測試證據

- 第19份獨立手譯 C++ reference：**54固定 PE anchors、2,587 cases**；獨立讀取並核對 LS／GS 的450項等級表，沒有 import TS calculator／codec。
- 逐筆比對全部投影、prefix event order／參數／結果、成功計數及真正 CUser 207 scalar／plain bytes；缺定義的 native malformed packet 與現代拒絕分開。
- 覆蓋全部256 categories／auth BYTEs／source Type BYTEs、signed wrap／cap、成功30／大量 missing-failed／extra fetch、period threshold／DWORD level addition、三種key、duplicate premium、rowset failure、catalog reload與三種codepage。
- `PreInventory.test.ts`19項＋`PreInventoryLifecycle.test.ts`13項，共**32 pass／0 fail／34366 assertions**。包含真 SQLite schema6 不變、native/legacy key碰撞無mutation、Center整組lease、真106／discovery／109／150開局的pending／after-storage fences。讀取端 fixtures 不冒稱正式native loader。
- 僅拿掉兩個新增 pre-generation fingerprint entries 的**我們的 TS control**，Center／frozen-result兩項為 **0 pass／2 fail**；恢復後為 **2 pass／0 fail／78 assertions**。不是 supplied binary oracle。

```sh
./node_modules/.bin/bun run vectors:pre-inventory
./node_modules/.bin/bun test tests/PreInventory.test.ts tests/PreInventoryLifecycle.test.ts
./node_modules/.bin/bun run verify
```

builder需要g++，只在明確執行時編譯／執行**我們的 C++**；一般測試消費已版本化的 JSON。沒有執行所附 EXE／DAT／carved SQL／Windows API，沒有更動主機時間或連線至舊官方／收費端點。獨立模型與共用 codec TCP peer 都不是原 client／原程式相容性證明。

後續[InventoryInitialization](InventoryInitialization.md)以真CDBMan將此觀測投影接到owned投影，使用同catalog／clock generation與**After.Level**（即使XP row的LoadOn失敗）；owned-open失敗仍保留pre trace。另有CUser可信成對list install／capture，兩份全驗才換revision，仍不套用After／執行financial effects或native SQL。

完整整合與重複驗證數字見 [Coverage](Coverage.md)。仍需補 native SQL schema／procedure parity、完整Windows calendar／native DB provider整合（[嚴格子集與隔離clock](Calendar.md)已有）、premium／financial effect 的 durable idempotency／recovery、完整 pre→owned initialization、整組read-side發布後的native初始化與durable送達／重啟策略、paid／flush／collector／restart 與原 client 實測。
