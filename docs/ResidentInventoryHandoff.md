# GS 原生 resident 背包／混合模式轉移

本輪從已推送 `d64812df3362c0204430933e65a0c162c165619e` 繼續，修正正式 `FXGS/CConnectPool` 轉移時一律指定 legacy `m_aInventory`、因而放棄已明示附掛 native owned 清單的問題。

**這是可信 resident 讀取端的轉移，不是原生 SQL 初始化完成。** Native 模式只能由先前可信 service-local caller 明示安裝；一般 SQLite 登入仍是 legacy。不把 SN／ItemID／Unix 日期轉成 ItemSn／StockSn／DATE，不執行 pre `After`、LoadOn、premium、Money／XP 給付、expiry refresh、flush 或 billing。完整 server／original-client 旗標仍為 `false`。

## 每個 local 分開決定資料來源

`CUser.CaptureUserInventoryInitialization()` 在同一次同步捕獲中增加 `OwnedGeneration` 與**儲存中的** `Presentation`；Center 的新 `ConnectionInventory` DTO 同時綁定授權 identity：

```text
ID, GlobalSerialNo, GuildSn
OwnedGeneration { Native, Revision }
Owned null | { Revision, Rows }
Pre { Revision, Rows }
Presentation { FakeLevel, LevelIconEnabled, LevelIconSN }
```

| 已明示模式      | Owned                       | GS 來源／成功後的 live 狀態                                                             |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| native empty    | `{ Revision, Rows: [] }`    | **不讀 legacy SQL**；空清單仍是 native，同一 live CUser 保留原本兩個 epochs             |
| native nonempty | `{ Revision, Rows: [...] }` | 不讀 legacy SQL；ItemSn／StockSn、order、dirty、copied attrs／equipment、raw DATE 保留  |
| legacy          | `null`                      | 只有這個 local 讀既有 `LoadInventory(ID)`；維持明示 legacy bridge，不由另一人的模式推論 |

Native→legacy 後的 revision 可以非零；不能以 `Revision === 0` 或 owned count0 猜模式。Native row 的 ItemSn 即使剛好等於 SQLite SN／ItemID，也沒有 fallback、轉換或付費權限。兩個 locals 可以採不同來源。

`LevelIconEnabled` 是原本儲存的 signed DWORD，不縮成 boolean；disabled／nonzero SN 也保留。Native 空清單不能觸發 equipment 重算或把原本 icon enable 強制設成1。FakeLevel 不是帳號 Exp、cached Level 或發獎依據。

## Lease-bound paired capture

`CCenterServer.CaptureAuthorizedInventory`／`CCenterProcess` façade 使用**既有同一份 whole-group exclusive guard**：

1. 在任何 pair getter 前驗 issuer／server／socket／exact group／issued pending／clock／原 deadline。
2. 同步讀取每個 local 的 pair、模式與兩個 epochs、presentation；檢查 revision 範圍、native 模式一致性、400／30 resident capacities 與 presentation signed32。
3. Native vector 必須是此 lease 原本捕獲的來源 vector，不能換成同形外來 rows。擷取 primitive rows 後再 detach／freeze 外層、各 local、各 array、每筆 row、epochs 與 presentation；raw negative-zero DATE 不經 JSON roundtrip。
4. getter 期間不能 nested paired／pre capture、release 或 consume；讀完後再驗 clock／expiry／**全部** source states。第二人的 getter 修改第一人、同值 reload／mode ABA 或過期，都不能交出混合 DTO。

DTO 不帶 live CUser／socket／issuer，也不能當成新 lease；既有 pre-only API 仍保留。Center 不執行 codec，避免把可信 UTF8 resident 資料在 Center 先用預設 Big5 錯誤轉碼。這是受控 event loop 內的資料一致性防護，不是任意 hostile JS monkeypatch 或外部 SQL writer 的通用交易隔離。

## 正式 GS：整組 preflight，native live 不重新安裝

Request7 的 identity／integrity／initialized 語意與 [210／202／207／201 條件](InventoryHandoff.md#原始發布條件) 不變：first-local initialized 決定202；**ANY pre → ALL-local207（包含空者）→ 強制201**。已 initialized 且無 pre 仍只有210，不因 native 非空自行新增 ACK／201。

正式流程：

1. 完整 decode → Authorize → paired DTO。Loaded identity／DTO 模式不一致，在 account／inventory reads 前拒絕。
2. 全部帳號仍由既有 SQLite account bridge 重讀／驗 owner 與 availability；每個 callback 前後 Check。只有 legacy locals 讀 legacy owned；native empty／nonempty 都略過。
3. 捕獲一份 catalog snapshot，建立 detached account／native pair 或 legacy owned＋pre 候選；**用目標 socket codepage** 驗證 native copied strings／pre rows。兩份清單全部 primitive 先捕獲，不能在 codec 中途偷換尚未捕獲的另一份清單。
4. 整組完成 conditional202／207／201 packet 容量／encoding，所有 bytes 尚未送出。Native 候選也會在 initialized 無201時驗證明示 resident rows；legacy unsent201行為不偷改。第二人201超長或錯碼頁，不能先送第一人／210／202／207或消耗任何 owner。
5. Final Check／whole-group single-use Confirm，交付**同一組 live CUser**。重綁已捕獲的 account copies／SetLevel；只有 legacy local 指定新的 `m_aInventory`。Native live 不重新 install、不增加任一 epoch、不清 dirty／pre、不重算裝備，也不受 native revision 已達上限而被誤降級。
6. Source close 後、account publication 前檢查 resident 模式／兩 epochs／三個 presentation 值；rank callback 後、第一個 packet 前再檢查一次，才開始發送 prepared bundle。

202 與全部207依**同一份** catalog generation；native owned 已複製的 Category／attrs 不會由這份新 catalog 重建。207 的 category 查詢仍依 catalog，level WORD 仍用 loaded account 的 cached Level；不是 fake/look-level、source stale cache 或 pre projection.After。

## 時間／效果／失敗界線

- Resident DATE 是可信 caller 已附掛的觀測值，**不是本次 SQL freshness／expiry revalidation**。Handoff 不重新抽樣 CDBClock、不用目前帳號 Level 重新過濾 owned，也不把 DATE0／負零／負日期改成 Unix expiry／永久道具。
- Native 201 是 ItemSn、BYTE Slot、DWORD Amount、Verbose、raw little-endian binary64 DATE；StockSn／copied attrs／Modified 並非這份201的額外 wire 欄位，但同一 live vector 仍保留它們。
- 消耗前的 encoding／getter 錯誤只 retire／release preparation；pending 尚合法時，可修正**可信來源**後以原 pending／deadline 取得新 lease。這是讀取端發布重試，**不是允許重放 Money／XP／LoadOn**。
- Center 消耗後才 source-close，callback 可能改資料。若此時或 rank callback 換 epochs／presentation，擋住 prepared success bundle，但 ownership **已消耗，不 rollback／重發 pending**。Rank／account／callback 已產生的副作用不假裝可撤回。
- Send201 失敗時可能已有210／202／207；不聲稱 exactly-once TCP、可撤回已送 bytes，或能防止第一個 Send 開始後的所有 mutation。
- Native positive paid 在既有消耗／legacy CAS 前仍 fail-closed；quantity0 的免費 relay 不變。Schema6、export v2、四類 version1 receipts 與 legacy owned／pre schemas 不變，不新增 grant／initialization receipt。

## 來源與獨立模型

第 **23份**我們的人工 C++ reference：`tests/reference/resident-inventory-handoff.cpp`。Builder 只編譯／執行我們的模型，獨立讀取並核對 LS／GS450項 level table；不 import production calculator／codec。

**33 fixed PE anchors**：24個既有發布／207 anchors，加上下列9個 native201 layout anchors：

| FXGS VA    | 核對角色                           |
| ---------- | ---------------------------------- |
| `00416C33` | resident stride84                  |
| `00416C41` | owned count DWORD                  |
| `00416C4C` | ItemSn，不是 StockSn／legacy rowid |
| `00416C59` | Slot BYTE                          |
| `00416C62` | Amount DWORD                       |
| `00416C6E` | resident Verbose                   |
| `00416C77` | 儲存 CTime                         |
| `00416C84` | raw8-byte DATE，不做 scalar XOR    |
| `00416C8F` | resident order／stride             |

**254 complete GS wire images**：252個1／2 locals、legacy／native empty／native2rows、GameAttr0／1／255、initialized、pre0／1組合，再加30-row pre capacities。Native ItemSn7／0x80000000、不同 StockSn、Amount−1／3、DATE−1.75／negative zero、dirty／copied Category／attrs 與 icon enable0／2；legacy SQL 即使為 native locals 也刻意 seed 碰撞資料。全部 cases 驅動真正 GS handler，核對完整 conditional210／202／207／**非空 native201** scalar bytes，以及每個 local 的 SQL read 選擇與 live pair 未變。

**模型的 resident／mixed-mode source policy 明確是 MODERN。** PE anchors 支持 native wire roles／條件，並不證明原生程式本來就快取轉移 owned、不重新跑 InitUserInventory；不是 original binary／native SQL／Windows DLL／financial／client oracle。

## 測試與重建

- `ResidentInventoryHandoff.test.ts` **13項**，`ResidentInventoryHandoffLifecycle.test.ts` **17項**；共 **30 pass／0 fail／3360 assertions**。涵蓋254個 handler images、deep DTO、guard／forgery／expiry／paired ABA、native epoch exhaustion、malformed snapshots、mode selection、目標碼頁、第二人201 overflow／原pending修復、同catalog202207、no-pre initialized gate、source disconnect、post-consume close／rank／presentation drift、transport failure與真channel209。
- 新 **real LS→GS TCP**：雙人登入／reserve；可信 fixture 附掛 native，第二份超長201使新 GS TCP 被拒絕、沒有任何210，原 LS／pending 留下；可信修復後新 TCP 以同 pending 接收210202207與非空 native201，再用209取得相同完整201。Native rows／兩epochs保留、沒有 legacy SQL fallback／寫入或四種 receipts。Peer 共用本實作 codec，**不是原版 client 相容證明**。
- 五種我們的 TS controls：錯讀 native 的 legacy SQL **0／1→1／0**、native empty誤 fallback **0／1→1／0**、移除 capture 後全組 fence **0／2→2／0**、handoff誤重裝 live native **0／1→1／0**、移除 post-consume fences **0／3→3／0**。每次測後 exact source bytes 還原，最後 compiler 再通過；不是執行 supplied 程式。

```sh
./node_modules/.bin/bun run vectors:resident-inventory-handoff
./node_modules/.bin/bun test tests/ResidentInventoryHandoff.test.ts tests/ResidentInventoryHandoffLifecycle.test.ts
./node_modules/.bin/bun run verify
```

一般 suite 只讀版本化 fixtures，g++ 僅 opt-in builders 使用。完整回歸／重複／fresh export 證據見 [Coverage](Coverage.md)。原EXE／DAT／carved SQL／Windows API不執行，不改 host clock、不連舊官方或 billing 端點。Native SQL 初始化／irreversible effects recovery、完整 calendar／DST、paid persistence／flush／collector／restart、獨立 Center TCP／其他未完服務與原版 client 尚未完成。

## 已接的resident功能使用者

[WaitingChief](WaitingChief.md)已在ordinary正式400ms等待房排程使用`HasFunctionalItem("Item/SuperChief")`，只查當下chief local的已保留native vector，不從legacy ItemID／Verbose或現在catalog猜屬性。獨立新增的未加速真TCP測試，明示native row從LS→GS保留後，觀察實際15秒warning＋30秒expiry／121、整組移除／pool4，再209仍為相同201；沒有SQL changes或四類receipt。這是carried read-side的具體consumer，**不是native SQL初始化／expiry refresh／道具消耗／grant／原client已完成**。
