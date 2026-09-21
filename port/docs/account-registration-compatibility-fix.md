# A03：帳號建立交易、競爭與 LS 回覆驗證

日期：2026-09-20。承接 [差異清點 A03](remaining-work-audit.md)。

## 完成範圍

已修復 A03 列明的建帳原子性及序號配發競爭：

`LS 註冊／需求延伸的自動註冊 → prCreateUser → UserInfo shard 交易 → 成功／失敗回覆 → 重試／登入`

- **未知帳號登入自動註冊繼續保留**，不是改回官方拒絕未知帳號。
- 保留先前地圖、RNG、A01、A11／A21 工作，不變更依賴、schema 或既有帳號資料。
- 本輪不是整個帳號系統、有效 SQL catalog 或六個服務完全相容的宣告。沒有執行 Windows EXE／SQL Server，也沒有原版 client 雙端差分。

## 原生依據與不臆測的界線

### SQL 交易

提供的 `DB/UserInfo00.bak` 可辨識 `prCreateUser` 段落包含：

1. `begin tran`。
2. INSERT `FxUserAccount`，錯誤則 `rollback tran`、return -1。
3. INSERT `FxUserDynamic`，錯誤亦 rollback、return -1。
4. `commit tran`，return 0。

備份中有重複／損傷片段，不能把 strings 全部當作目前有效 catalog。`TxUserDynamic` 插入亦出現在相鄰的 `prCreateCommuUser`；**不據此聲稱每份普通 prCreateUser 都有第三筆 INSERT**。目前 TS 已有的第三筆 companion insert 保留，並一起納入交易；不憑殘片刪表、刪使用者或改動其他遊戲資料。

### LS 可觀測回覆

- `CDBMan::RegisterNewUser`：`LS/CxLogin.exe.lst` `0040A700`，編碼密碼、依原參數綁定 `prCreateUser`；SQL 執行成功回 0，失敗回 1。
- 該 wrapper 判斷 `ExecStoredProc` 的 HRESULT，沒有把所有 procedure return -1 都當作 HRESULT 失敗的通則。
- TS `prCreateUser` 的 -1 來自 SQLite 執行／交易例外，既有 LS wrapper 將此映射為 1；本輪沒有變更這個 wire mapping。
- `CLoginPool::OnNewUser` `0040ED40` 按原欄位順序解碼，回 packet 5 的單一結果 byte。
- 自動註冊是使用者要求的延伸。建帳失敗時維持現有 auth-failure 路徑，LS packet 3 為 `[1, failing-user-index]`；測試單使用者 index=0。不得將此延伸稱為官方原有的自動註冊流程。

### 序號不能虛稱等價

原 TS 註解把 `MAX(SN)+1`、`SID=SN` 稱為「matching original identity semantics」，證據不足，已修正。

本輪保留既有 SQLite 配發方式，只修復**取號與 INSERT 必須在同一 writer transaction** 的競爭。官方 SN/SID default、IDENTITY 的刪除／回滾留洞、資料型別上限，仍需完整有效 schema 才能決定遷移；沒有自行新增一套假裝官方的 sequence。這些未完成核對已加入第一輪清單 B，不用本輪測試替它背書。

## 實作

### `src/db/DBMan.ts::prCreateUser`

- 使用 Bun SQLite `db.transaction(callback).immediate()`，不手寫易漏掉 COMMIT 故障的半套 rollback。
- **BEGIN IMMEDIATE 在 `SELECT MAX(SN)` 前取得 writer lock**，避免不同程序同時讀到舊值，再互撞 unique index。
- Account、Fx dynamic、現有 Tx companion 全部成功才提交。任何 INSERT 或 COMMIT 失敗都回 -1；先回滾，再由外層 catch 映射結果。
- 重複 ID、預先存在的 dynamic orphan、SQL trigger 故障均保留交易前資料，不做 `REPLACE`／`IGNORE`／覆寫密碼。
- 六個 UserInfo 連線共用具名 `USER_DB_BUSY_TIMEOUT_MS = 5000`。短暫 writer contention 先有限等待，超過 budget 仍失敗，不做無限重試。
- 這個 busy timeout 是 SQLite 儲存政策，不冒稱與原生 SQL Server command timeout、IOCP 排程或整個 RPC 的耗時完全一致。沒有變動 Inventory／Config／Item／Guild 的等待設定。

### `prCAAuthUser`

- 將重複且帶斷言的帳號查詢整理為同一個具型別的 prepared statement。
- 未知 ID 才嘗試建帳；不改動既有帳號或憑證。
- 另一程序可能在「初次 credential lookup → 存在檢查」或「存在檢查 → INSERT」之間先建立帳號。
- 在這兩種情況下均重新查詢**已提交且密碼吻合**的帳號；不能因 ID 存在就認證成功，也不能因自己輸掉建帳競爭就拒絕正確密碼。
- 相同密碼的併發登入可各自成功、各自增加一次 TotalConn；不同密碼只有勝出帳號的密碼有效。

### 測試用 client 與可讀性

本輪對 E2E 做完整 strict 檢查時，也處理了原先被 Bun transpilation 掩蓋的問題：

- `TestClient` waiter 缺少 reject，斷線時會呼叫不存在的函式；現在統一清 timer 並 reject。
- 同 opcode 的短逾時會刪掉另一個較早 waiter；改以 waiter 身分移除。
- queue 維持 private，提供 `discardPending`／`hasPending` 給測試使用，不為型別檢查把內部陣列公開。
- E2E notice reader 改用具名 offset、DataView 與 Latin-1 解碼，移除不合法的 `o2++!` 和無作用的 `e.u16be ? null : null`。
- 修正 GS cipher-degree 的舊註解；保留原封包編碼。這是測試設施修復，不算成新的 production server 相容項目。

## 驗收

### 帳號專項：27 tests／195 assertions

`test/account-registration.test.ts` 與獨立程序 fixture：

- 六個 shard 的完整 account 欄位、dynamic default、SN/SID 與重新開啟 DB 後登入。
- 每一筆 INSERT 的 BEFORE／AFTER 錯誤注入；失敗後可用同一 ID 重試。
- 既有帳號、Fx／Tx orphan 不被覆寫；其他帳號保持不變。
- SQL `RAISE(ROLLBACK)`、序號 SELECT 失敗、真正的 deferred-FK COMMIT 失敗。
- 另一條真實 SQLite 連線在每次 INSERT 後觀察，提交前始終看不到中間狀態。
- 自動註冊三個 INSERT 各自失敗時都不產生可登入的半套帳號。
- 兩個競爭空窗的確定性 interleaving，以及正確／錯誤密碼的保護。
- 持鎖程序提交後才取號；縮短至 40ms 的 timeout 故障測試、另一 shard 可繼續寫入、釋鎖後重試成功。
- 終止持有未提交帳號資料的程序，資料不會變成半套已提交帳號。
- **四個獨立 Bun 程序共同建立 80 個帳號**：全部成功，shard-local SN 唯一且 companion 完整。
- 四程序同 ID 註冊、相同密碼自動註冊、不同密碼競爭。

多程序 fixture 在已初始化的臨時 DB 上執行，沒有據此宣稱冷啟動時 Config seeding 的跨程序競爭亦已修復。沒有清理或「自動修復」正式 DB 中已有的 orphan。

### 真實 TCP：新增 2 tests

`test/e2e.test.ts` 使用實際 LS、Center 與加密 TestClient：

- 註冊／自動註冊時，server 可見的第三筆 AFTER INSERT trigger 故障，回失敗且三張表皆無該 ID。
- 移除故障後在同一連線重試，成功且帳號資料完整。
- 重複註冊／錯誤密碼仍被拒絕；Password 與 TotalConn 不被錯誤修改。
- 測試使用符合已知參數長度的 ASCII fixture；不將其擴大解讀成 Big5、collation 或 varchar 邊界已全數相容。

### 測試設施：新增 4 tests／14 assertions

`test/test-client.test.ts`：buffered packet queue、local close、transport error、同 opcode 不同 deadline。

### 最終結果

| 驗證 | 結果 |
|---|---|
| 全套 `bun test` | **281 pass／0 fail，5467 expect() calls，15 files，21.83s** |
| 帳號＋TestClient 專項 | **31 pass／0 fail，209 expect() calls** |
| 另一次獨立程序競爭重跑 | **7 pass／0 fail，55 expect() calls** |
| Preview TS `7.1.0-dev.20260920.1` source check | 通過 |
| 專案 TS `7.0.2` source check | 通過 |
| 兩版 TS 獨立 strict：新測試、worker、完整 E2E、dyninfo、socket-send、兩個 probes | 通過 |
| `git diff --check` | 通過 |

Bun：`1.4.3-canary.1 (26e7a4b36)`。沒有提交或推送，變更保留於目前工作分支。

可重跑（cwd `port`）：

```sh
bun test test/account-registration.test.ts test/test-client.test.ts
bun test
tsc --noEmit
tsc --ignoreConfig --noEmit --strict --target ESNext --module ESNext \
  --moduleResolution Bundler --types bun-types --skipLibCheck \
  --allowImportingTsExtensions test/account-registration.test.ts \
  test/fixtures/account-registration-worker.ts test/test-client.test.ts \
  test/e2e.test.ts test/user-dyninfo.test.ts test/socket-send.test.ts \
  tools/compatibility-probe.ts tools/compatibility-probe-2.ts
bun tools/compatibility-probe.ts
bun tools/compatibility-probe-2.ts
```

## 最新清點狀態

- A03 原始 failed-create rollback probe 已轉 MATCH；A02 自動註冊需求仍為 MATCH。
- 第一份：14 observations／9 GAP／5 MATCH；第二份：24／20／4。
- 合計 **38 observations／29 GAP／9 MATCH**。
- A01、A03、A11、A21 的已列修復範圍完成；A02 為保留需求。已列待辦剩 **18 組**，另有 B 類待核實事項。

Probe 的 exit 0 只表示診斷完成，GAP 不算 passing tests；沒有把剩餘 18 組或未核實的 SQL／帳號行為算成已完成。
