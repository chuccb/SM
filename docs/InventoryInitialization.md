# pre→owned 初始化：觀測協調與成對讀取端發布

新增 `FXGS/InventoryInitialization.ts` 與實際 `CDBMan.PlanInitUserInventory`，將已證實的 [PreInventory](PreInventory.md)、[UserInventory](UserInventory.md)、[Calendar](Calendar.md) 串成一份有來源邊界的觀測計畫；另新增 `CUser.InstallUserInventoryInitialization`／`CaptureUserInventoryInitialization`，提供成對讀取端更新／snapshot。

**不是完整 native SQL 初始化，不執行給付，不把計畫的 After 套用 live user。** 正式 GS 仍走原本明示的 legacy account／owned bridge與可信 pre read-side handoff；本輪沒有新 provider、migration、receipt／procedure／billing／collector，也不讀 supplied SQL／EXE 或修改主機時鐘。完成與原 client 驗證旗標仍 false。

## 原始順序與不能抹去的失敗前綴

FXGS `0040AF55 CDBMan::InitUserInventory`，交叉核對同 PE `.c`／`.lst`／bytes：

| VA                                 | 事實                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `0040AF6D`／`0040AF72..74`         | 先 InitPreInventory；回0立即結束，不開 owned rowset                                                          |
| `0040AEAB`／`0040AF0E`             | pre 的 SetLevel 已先於 LoadOn；procedure 失敗不回復之前 XP／Money／premium／flush 行為                       |
| `0040B040..4D`                     | pre 成功才開 owned；owned-open 失敗回0，沒有 pre rollback                                                    |
| `0040B0D5..E1`                     | owned LevelCreated 是 signed SHORT，與**經 pre 前綴更新後的 cached level**比較                               |
| `0040B0EF..0040B104`               | 每個有 definition 的 processed row 各sample current CTime／取得current與stored DATE；即使level-invalid也會做 |
| `0040B116..1D`                     | 保留 strict raw numeric DATE `>`；不擅改 pre-epoch chronology quirk                                          |
| `0040B192`／`0040B19B`／`0040B09D` | accepted／missing definition count toward400，expired不count；先fetch再測上限                                |

原生 pre 成功數30與 owned counted rows400是**兩個不同計數器**。不能把它們變成SQL LIMIT、只看前30／400 fetched rows、在任何 LoadOn失敗後提前結束，或用 initial account level 取代 after-prefix cached level。

新計畫保留 `Pre.Before`／`Pre.After`／events、成功 resident rows、missing／fetched／read counts；即使後段 owned-open failed，pre 的已觀測前綴仍存在於回傳值。這些數值和 events **不表示給付已提交、可安全重付或有 durable ACK**。

## 明示觀測邊界

`InventoryInitializationObservation`：`Initial`、`PreOpened`／`PreRows`、`OwnedOpened`／`OwnedRows`。PreRows含明示premium／ExecResult／procedure return observations；OwnedRows 的 DateCreated 已是 **finite raw OLE DATE**，不是Unix、DBTIMESTAMP文字或隱含永久道具 sentinel。

- pre-open false 不讀 PreRows、OwnedOpened／OwnedRows或任何clock method；owned-open false不讀OwnedRows／clock。未到達的資料不當作已觀測日期／malformed rows。
- 會到達的兩階段先latch primitive／array內容，再有codec／catalog callout。opened stage的modern whole-input limits仍為各65536，包含未處理tail的validation，不宣稱這是native SQL capacity。
- `CDBMan` instance guard涵蓋input getters、codecs與clock callouts；拒絕nested projection，任何例外後釋放。manager還要求`items.db === this`，不把其他DB owner的catalog拿來當本server資料；standalone觀測function不提供此issuer權限。
- 真 `CUserItemMan.CaptureSnapshot` 的**同一immutable generation**供pre與owned；前後檢查real manager revision，same-value reload／ABA也拒絕整份結果。
- owned-open true時pin `CDBClock` synchronization／revision；pre／owned callbacks、每個實際sample及最後都檢查。late同值sync、fault／range例外不交出混合候選。
- 每個known-definition row以atomic captured time建立CTime，明示time避免多sample一次；unknown-definition／empty owned不sample，甚至可以在未sync時計算純觀測空結果。`ClockRevision: 0`**不是有效時間或授權證明**。
- `Stage: "complete"`只表示**兩個opened rowsets的觀測投影完成**，不是SQL／financial／live初始化或server完成。其他stages為pre-open-failed／owned-open-failed，Owned與ClockRevision皆null。

已回傳plan是detached／frozen資料，不是lease或financial capability。之後catalog／clock可能變動、同一revision下時間仍會前進；不得因此宣稱一份舊plan永久有效。沒有 Apply、Retry 或自動授權publication的方法，亦不將 Center lease或DB clock snapshot當作給付權限。

## CUser 成對發布

現代可信API `InstallUserInventoryInitialization(owned, pre, equipment, text)`：

1. 先驗兩個revision budget；任一exhausted就兩者都拒絕，不wrap。
2. guard覆蓋array length getter、兩份輸入capture／codec、native／legacy setter、Add／Consume／單份Install及nested pair。
3. 非空legacy拒絕，不丟棄或重解釋SN／ItemID。owned≤400、pre≤30；兩份ALL rows primitives先capture，才開始codec callbacks。
4. 預備完整owned／pre frozen lists與equipment、detached frozen legacy空view。第二份bad string／row或任何copy例外時，**不更新第一份vector／revision或本次equipment**；不承諾rollback caller自行造成的任意外部副作用。
5. 所有fallible validation完成後，沒有callback／getter穿插地同步更新兩份vector、各revision＋1與明示presentation equipment。empty／byte-identical reinstall也換兩個generations。
6. 不改Money／Exp／auth／dirty flush state，不讀SQL、不執行pre After、不給receipt、不標為client initialized。omitted fake／icon保留既有值，與原生loader沒有implicit清除的邊界一致。

`CaptureUserInventoryInitialization`不呼叫ports，原子capture frozen `{Owned, Pre}`；Owned=null表示legacy mode，native empty與legacy不同。snapshot含各自revision／immutable rows，不含live user、apply方法或financial權限。現有單份安裝API仍獨立；新pair不是讓所有歷史單份更新自動變transaction。

`CaptureUserInventoryRecord`／`CaptureUserInventory`也補上primitive latch：DateCreated／derived attrs getters只讀一次，codec不能在validation後偷偷換成NaN／未驗證字串。這是read-side資料一致性防護，不是對任意hostile JS／外部SQL的通用隔離。

## 真consumer與pending fences

- 模型35個成功候選以可信既有account觀測建立CUser，再成對附掛清單，比對**非空201與207、plain／scalar完整bytes**。顯式建立account不表示initializer自動給付。
- 真 `CChannelPool` request209、兩個local users發布native201；pre SN／StockSn不混成owned ItemSn。既有 GS210202207201條件／whole-group preflight與正式legacy owned路徑不改。
- 成對same-byte reload換兩個epochs，現有Center lease與pending money／house／legacy paid／result fences皆會拒絕舊計畫；invalid第二份preflight不換epoch，原lease仍可single-use整組完成。
- 若trusted callback在真SQL COMMIT**之後**才成對reload，durable receipt／SQL仍保留，但live After／success packet被擋；不假裝rollback、不rebase或重付。
- 正quantity native paid仍在legacy CAS前fail-closed，qty0 relay不讀stock／pre、不新增receipt；舊schema6／export v2／四類version1 receipts與Unix bridge格式不改。

## 重建與界線

第**22份**我們的獨立C++ model：**24固定PE anchors、131 composite cases**，獨立讀取／核對LS-GS450項level input；涵蓋open短路、XP success／failure、prefix混合、30／400分開counter、410-row輸入／expired不count、per-row time、negativeDATE、equipment、201207完整bytes。未執行supplied binary、Windows API、SQL procedure或original client，不是native financial oracle。

`InventoryInitialization.test.ts`22項＋`InventoryInitializationLifecycle.test.ts`11項：**33 pass／0 fail／2781 assertions**。五種TS regression controls先red→復原exact source後green：誤用initial level、移除catalog fence、移除clock fence、把pair改成兩次sequential installs、跳過primitive capture。

```sh
./node_modules/.bin/bun run vectors:inventory-initialization
./node_modules/.bin/bun test tests/InventoryInitialization.test.ts tests/InventoryInitializationLifecycle.test.ts
./node_modules/.bin/bun run verify
```

最新全套與重複驗證見[Coverage](Coverage.md)。真正native provider／SQL constraints、pre財務effects的durable idempotency／recovery、正式pre→owned初始化、完整Windows calendar／DST、paid persistence／flush／collector、restart／特殊模式與原client端到端驗證仍未完成。
