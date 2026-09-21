# FXGS CRT 隨機數與消耗順序核對

日期：2026-09-20

## 範圍與結論

接續 [地圖相容性核對](map-compatibility-audit.md)，核對隨附
`FXGS/FxServer.exe`、`.c`、`.lst`、`.h` 與 `FxServer.idx/.idd`：
CRT `rand/srand`、seed／執行緒狀態、選圖、gameVersion、出生點 shuffle、
隨機角色與 premium lucci，並補齊會決定隨機角色索引的 `CBomberAttr.Load`。

**已對齊同 seed、同一串序列化呼叫下的 CRT 數值與已測遊戲路徑消耗順序；
未重現 Windows 多 worker IOCP 排程，不宣稱整個官方伺服器等價。**
本輪沒有執行 Windows 官方 EXE 做雙端流量差分。測試讀取 EXE 指令位元組，
不等於執行原生程式；socket E2E 執行的是 TS 伺服器。

## 1. CRT 本體：直接讀取 PE，不猜測 folded function

`.lst` 將 `rand/srand` 顯示為 folded function，但 EXE 本身仍有完整指令。
使用 `objdump` 反組譯確認；`test/rand.test.ts` 透過 PE section table
將 VA 轉為檔案 offset，直接比對隨附 EXE 的指令位元組。

| VA | 證據／語意 |
| --- | --- |
| `0046EA52` | `srand` 呼叫 `__getptd`，把參數的全部 32 bits 寫入 thread data `+14h`；seed 0 不改成 1。 |
| `0046EA5F..0046EA80` | `rand` 呼叫 `__getptd`，取 `+14h`，乘 `343FDh`、加 `269EC3h`、寫回，右移 16，再 AND `7FFFh`。 |
| `004745FE..00474610` | CRT thread-data 初始化函式寫入預設 seed 1。 |
| `00474611`、`00474659` | `__getptd` 取得目前執行緒狀態；不存在時配置並寫入 seed 1。 |
| `004D2DC4`、`004D2DC8` | `_gpFlsGetValue/_gpFlsSetValue` 間接函式指標；套件亦有 Tls API import。不是一個全域 RNG 狀態。 |

實作於 `src/core/CRand.ts`：

```text
state = uint32(state * 0x343fd + 0x269ec3)
result = (state >>> 16) & 0x7fff
```

`Math.imul` 保留低 32 bits，最後 `>>> 0` 明確轉為 unsigned DWORD。
`RAND_MAX` 與 recurrence constants 集中定義；不委派 `Math.random()`，
不換成較均勻的 rejection sampling，不把 `% n` 改成浮點縮放。
這是相容性 PRNG，**不是密碼學安全亂數來源**。

固定向量（前十次）：

- seed 0：`38,7719,21238,2437,8855,11797,8365,32285,10450,30612`
- seed 1：`41,18467,6334,26500,19169,15724,11478,29358,26962,24464`

## 2. Seed、原生執行緒與 Bun 的明確界線

- `CApp::SetUp`（`00427575`）在 `004275BD` 呼叫 `srand(time(NULL))`。
- `CThread::ProcEntry`（`00436E00`）在 `00436EAD` 同樣呼叫
  `srand(time(NULL))`。單位是 Unix epoch **秒**，不是毫秒或 `timeGetTime()`。
  CRT 的預設 1 是尚未 `srand` 時的初值，不是上述 worker 的固定 seed。
- `CSockRcvMultiplexer::CreateWorkerThreads`（`0042F36E`）取得 CPU 數，
  worker 數為 `min(4 * CPU + 4, 16)`；啟動時建立 worker 的路徑見
  `0040B6EB`。`Init(..., 0, 0xC)` 的 12 是傳給
  `CreateIoCompletionPort` 的 concurrency，**不是 worker 數量**。
- 同一 socket 的工作序列化不代表永久綁定某一 worker。不同房間可能消耗
  同一條 thread-local stream，同一房間的後續工作也可能落在不同 worker。
  同秒啟動的多 worker 可能有相同 seed，但各自的後續狀態獨立。

Port 目前在 `CMainSystem.m_WorkerRandom` 持有一個長存的 `CRand`，
以建立此邏輯 request worker 當時的 epoch 秒 seed 一次。這是 **TS 新增的
執行上下文狀態，不是官方 CMainSystem 原生欄位**。房間／練習模式共用它，
不每次 request、socket、房間或每局重新 seed；其他服務與 normal timer
不消耗它。測試可明確 `srand`，不需更改 production seed 規則。

Bun 的單一邏輯 request worker 是本輪架構取捨：保留一條可核對的 CRT
序列，而非假裝能由連線 ID 推導 Windows 排程。沒有擅自加入 per-room RNG、
round-robin worker 或全 suite 共用 RNG。建立上下文的時刻也不是對官方 worker
啟動時刻的重播。若要求同時連線下逐次隨機結果重播，仍需取得原生工作執行緒、
seed 時刻及事件消耗 trace；僅有相同流量／啟動秒數不足以保證。

## 3. FXGS 的全部 12 個 rand call site

此處按 `.lst` 的呼叫指令列舉，不把模板 helper 和實際 inline shuffle 重複當成
同一次開局要消耗的兩份亂數。

| call VA | 所屬路徑 | 核對結果／Port 處理 |
| --- | --- | --- |
| `00408C65` | DB 負索引選擇 | `rand() % 6`。反編譯文字／函式 xref 未顯示呼叫者；不據此宣稱已證明不可達。本輪不新增這條原生 DB worker 路徑。 |
| `00408C83` | DB 負索引選擇 | 同上。Port 使用 SQLite 替代 DB 架構，仍須另案核對。 |
| `0040C79B` | `GetRandomMapIdx` | `rand() % eligibleCount`；零候選不抽、單一候選仍抽一次。候選順序與篩選沿用地圖核對結果。 |
| `004162AD` | `RegulateConnection`（`0041624D`） | `rand() % 10` 只決定 UDP 診斷 log 是否印出。已見呼叫鏈為 normal timer 的 session Update → DeferRegulateConnection；Port 省略此抽樣 log／draw，不消耗 request-worker stream。 |
| `0041AD4C` | 房間 `Init` | 一次原始 15-bit rand 作 gameVersion，範圍 `0..32767`。 |
| `0041B8F9` | STL `__random_number` | 一次 rand 後取餘的模板 helper；不是遊戲額外的一次抽取。 |
| `0041DB17` | STL `random_shuffle<int *>`（`0041DAFD`） | forward shuffle，見下一節。 |
| `0041EBA3` | `OnRequestEatItem` | 尚未吃過的 box、effect 99、premium ticket byte **等於 1** 時才抽；數量 `rand() % 2 + 1`。 |
| `00420C83` | `Launch`（`00420BB3`） | 隨機角色先抽 `% 30` 決定普通／隱藏分支。 |
| `00420C92` | `Launch` | 普通分支第二抽 `% normalCount`。 |
| `00420CBA` | `Launch` | 隱藏分支第二抽 `% 3`，結果非零選 `normalCount + 1`，零選 `normalCount`。 |
| `00425621` | 練習 `Init` | 與房間相同：一次 15-bit gameVersion；不能另建 per-practice RNG。 |

省略 timer draw 的依據是它原本使用另一執行緒的 TLS 狀態，且此處只影響 log；
不是一般性認定「看不見的 draw 都能刪除」。若日後增加 timer 的可觀測隨機行為，
必須重新核對其上下文及先前消耗。DB 兩處亦未接到 request-worker stream。

## 4. 遊戲中的精確消耗順序

1. 房間／練習初始化產生 gameVersion；不是每次 `Launch` 重抽。
2. 需要隨機地圖時，先建候選，再抽一次取餘。直接指定地圖不作此抽取。
3. `Launch` 先 `MakeGameContext`；建立 `0..map.maxPlayer-1` 的出生點陣列。
4. 按 `i = 1..n-1`，交換 `values[i]` 與 `values[rand() % (i+1)]`。
   **正向** shuffle 共 `n-1` 抽；不能換成常見的反向 Fisher–Yates。
5. 按 slot 遞增順序，僅處理 `IsPlayerSet` 的 slot（練習模式包含 AI）。
   選擇值等於 `CBomberAttr.GetTotalCount()` 才是隨機角色 sentinel。
   每個隨機角色恰好兩抽，指定角色不抽；從 shuffle 後陣列依序取出生點。
6. 封包 116 編碼上述 map、spawn、bomber；kickoff 150 使用
   `gameSerial XOR gameVersion`，其後 serial 遞增，不消耗 rand。
7. lucci 獎勵在吃道具當時繼續消耗此 worker stream。非 premium、ticket 2、
   非 effect 99、重複 box 均不額外抽取。156 的數量與 money 增量一起驗證。

獨立 seed 1 的八出生點 shuffle 為 `[4,1,6,2,0,5,7,3]`，下一抽 `29358`。
包含初始化與選圖的整條 seed 1 fixture 則為：

```text
Init gameVersion = 41
map draw = 18467; 18467 % 3 = 2
shuffle = [6,3,7,2,4,1,5,0]
occupied slots = 0(random), 2(explicit bomber 3), 5(random)
spawn = 6,3,7; bomber = 1,3,1
共 13 draws；下一抽必須是 16827
```

因此不能只比較每一步的值域或分佈。測試解碼實際產生的 116／150，並檢查
流程後下一抽，捕捉「結果剛好相同，但多抽／少抽」的錯誤。
seed 9／29 亦分別涵蓋隱藏角色兩個結果，不依賴概率性測試。

## 5. CBomberAttr：角色索引所依賴的資料

`CBomberAttr::Load`（`0043084B`）在嘗試讀檔前歸零計數；本輪改為回傳
boolean，保留載入失敗前的完整 record 前綴，而不把半筆資料納入索引。

- name length 為 signed LE DWORD，接受 `0 < length < 54`。
- 原始名稱以 latin1 保留位元組，NUL 截止；不錯當 UTF-8 解碼。
- 後續十個屬性均為 signed LE DWORD；第五欄只作 `min(value, 10)`，
  不擅自把負值 clamp 成 0。第一欄非零才計入 hidden。
- 原始資料順序：`C00,C01,C03,C05,C04,C06,C02,C07,C08,C09`。
  total 10、normal 8、hidden 2、random sentinel 10；普通可選索引為
  `0..7` 或 sentinel 10，不把 8／9 當普通選項。
- 第一筆 speed／bomb count／bomb power 為 `5/1/1`；hidden index 8
  為 `6/3/3`。不根據名稱中的數字重排資料。

截斷資料會安全拒絕，不複製原生越界讀取。Launch 原有的
`normalCount > 0` 保護、出生點數 cap／缺資料 fallback 仍保留；
這些是 malformed-state safeguards，**不宣稱任意損壞資料或非法房間狀態
也能和原生越界／除零行為等價**。

## 6. 回歸與工具鏈

新增 **36 個測試**：

- `test/rand.test.ts`：12 個；PE 指令、固定 seed vectors、五種邊界 seed
  共 50,000 draws 的獨立 BigInt 參考、reseed、stream isolation、不用 host
  RNG、forward shuffle 與消耗次數。
- `test/game-random.test.ts`：15 個；epoch 秒 seed、房間／練習共用、timer
  isolation、0／1／多候選、116／150 完整流程、隱藏角色兩分支、較少出生點、
  練習 AI 順序、premium 156／money／dedup 與其他 ticket 分支。
- `test/bomberattr.test.ts`：9 個；原始套件、reload／reset、signed clamp、
  名稱長度／位元組／NUL、第二筆 record 每一截斷位置、空檔與缺檔。

另補強既有 `test/e2e.test.ts`：兩個真實 socket 的第一局 150 還原相同
15-bit gameVersion；第二局驗證版本不變、serial 加一。移除原來假設 XOR
結果必定非零的 assertion（合法的 rand／XOR 結果可以為零）。

驗證工具：Bun `1.4.3-canary.1 (26e7a4b36)`；專案 TypeScript `7.0.2`；
preview TypeScript `7.1.0-dev.20260920.1`。preview 工具裝在 repository
外的工作區工具目錄，沒有更改 dependency／lockfile。

最終驗證：

- 完整 `bun test`：**178 pass / 0 fail，1583 assertions，11 files，15.52 秒**。
- 專案 TypeScript 與 preview TypeScript 的 `tsc --noEmit` 均通過。
- preview TypeScript 對上述三個新增 RNG／角色表測試檔的獨立 strict 檢查通過。
- `git diff --check` 通過。

單元／整合回歸與靜態核對不取代原生 Windows 併發差分。
LS 的既有 `Math.random()` 本輪未遷移；FXSS 的原生 RNG 消費點也尚未遷移。
後續[剩餘工作清點](remaining-work-audit.md) 查明 FXSS 目前不是呼叫
`Math.random()`，而是 charge key 固定為 0，並有相關封包欄位差異。
不能拿 FXGS 的 CRT 證據直接斷言其他 EXE 使用相同實作或執行緒邊界；
其餘服務與 SQLite 替代層也未因此取得全面等價認證。
