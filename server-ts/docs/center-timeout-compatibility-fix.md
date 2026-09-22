# A04：Center 轉服逾時、狀態與清理

日期：2026-09-20。承接 [差異清點 A04](remaining-work-audit.md)。

## 完成範圍

修復原 A04 的 31-bit wall-clock deadline，並連同直接相關的狀態所有權、connecting list、轉服檢查順序、計數與表格清理一起處理：

`CheckConnectingToSvr → SetConnectingToSvr → established／timeout → SetFree／ExtractUser → 正常狀態廣播`

這不是機械式替換 `Date.now()`，也不是整個 Center、全域身份配發或 Windows 排程相容認證。沒有執行 Windows EXE 或原版 client 雙端差分；預期結果來自提供的 `.c/.lst`，測試執行的是 TS port。

**未知帳號登入自動註冊照常保留**。本輪沒有改動 DB schema、帳號配發或認證政策；新網路測試也走這個保留需求。

## 原生依據

以下 VA 均屬 `Center/CxCenter.exe`；關鍵時間比較另核對 `.lst` 指令。

| 路徑 | VA | 可確認的語意 |
| --- | --- | --- |
| `CUser` constructor | `00415640` | 先設定目前伺服器及計數，connecting=0，timestamp=`GetTickCount()`。 |
| `CheckConnectingToSvr` | `004153B0` | 拒絕 free／connecting／同伺服器／未註冊／shutdown；type 41 的 authcode 非 1 回 2；成功時即設定 flag、時間並回 1。寫入位置為 `00415512..00415520`。 |
| `SetSvrIdx` | `00415340` | 扣舊伺服器計數，更新目前 class/index，加新伺服器計數。 |
| `SetConnectingToSvr` | `00415540` | 搬移後加入 connecting list；**不設定 flag，也不刷新 timestamp**。 |
| `CheckConnectionEstablished` | `00415570` | 非 free、connecting 非零，且回報的 class/index 等於目前位置。 |
| `SetConnectionEstablished` | `00415120` | 清除 connecting flag；不重新搬移或刷新時間。 |
| `DeferDisconnectTimeout` | `004155F0` | flag 非零才檢查。`00415617..00415625`：GetTickCount、DWORD subtraction、`cmp 445Ch`、`jbe`；必須 unsigned elapsed **>17,500ms** 才 SetFree。 |
| `InsertConnectingList` | `00408360` | unsigned serial `% 6` 選 list，尾端插入，允許重複。不是 DB 的名稱 hash。 |
| `DeleteConnectionTimeoutUser` | `00408940` | 先遞增 DWORD 掃描計數，再 `%6`；第一桶為 1。只處理選中 list 的 snapshot；missing、expired、established 分別按下述規則移除節點。 |
| `ExtractUser` | `00408640` | 移除 serial/name 對照；本身不 SetFree，也不送 CM11。原生另有 authen 條件分支，本 binary 的停用限制不因本輪改動。 |
| `DeleteAllUserOnSvr` | `004087D0` | 依目前 class/index 選使用者，SetFree 後 ExtractUser，不看建立時的舊 class。 |
| `OnReqConnectToSvr` | `004097B0` | 先解析所有 serial，再依輸入順序檢查，保留最後一個檢查結果及先前副作用。 |
| `CTimerThread::OnTimer/Proc` | `00414F20` / `00415020` | Sleep 400ms；每 4 tick 掃一桶，每 2 tick 廣播。共同發生時先清理再廣播。 |

### 雙使用者請求不能擅自改成交易

原生合法大小範圍內的順序與結果是：

1. 任一 serial 查無使用者：不進行任何使用者的 gate 或搬移，結果 0。
2. 按輸入順序檢查目前 index 是否屬於發送者；此處只比較 index，不補上 class 條件。
3. 後續 index 不符時回 0，但保留較早成功 gate 的 flag/time。
4. 否則執行每人的 `CheckConnectingToSvr`，**最後一次結果**決定是否搬移全部使用者。
5. 最後回 1 時，即使先前有人回 0／2，仍搬移並 enqueue 全部；最後回 0／2 時不搬移，但不撤銷已設定的 flag/time。
6. 重複 serial 可在第一次成功、第二次因 connecting 而拒絕，留下 armed flag 卻沒有新 list 節點。

本輪保留這些不直覺但有指令依據的行為；沒有自行加入 rollback、全員成功檢查或去重。也沒有以複製超量 count 導致的 native 越界行為作為驗收目標。

## 實作整理

### 狀態與時計

- 新增 `core/GetTickCount.ts`，以原 API 名稱重用 `timeGetTime` 的 monotonic uint32 process clock。
- 明確註明它不是 Windows 絕對開機時間、相同 timer resolution 或跨程序同步時鐘；亦修正 `timeGetTime.ts` 原先過度延伸的註解，未更改後者執行邏輯。
- elapsed 使用 `(now - stamp) >>> 0`，保留 strict `>` 門檻。
- 用單一 `m_fConnecting` 表達 native +68 flag，移除人工的 connecting type/index 與未使用的 established flag。位置只看目前 `nChannel/nSvrIdx`。
- 移除建立時留下、轉服後不更新的 `CUser.nServerClass` 副本，避免伺服器清理讀錯位置。
- `SetFree` 維持冪等：只扣一次目前連線數、設定 free 與 index sentinel，**不清 connecting flag**。
- 門檻、桶數、sentinel、timer 間隔與倍數收斂到 `Center/Defs.ts`，不依賴 DB shard 常數。

### List、表格與廣播

- 使用六個 number array 保留原生 list 的插入順序和重複值；snapshot 處理後移除所有被標記 serial 的節點。
- missing：刪 list 節點；expired：SetFree、ExtractUser、刪節點；established：只刪節點；尚在等待：保留節點。
- 不再掃描整張名稱表。僅 armed、但未 enqueue 的使用者，不會被此 sweep 自行找到。
- `ExtractUser` 共用於逾時、一般刪除、Util 刪除及伺服器清理。正常刪除保留 residency gate，已 free 的使用者則可走原生的 gate 外 extraction。
- 沒有新增「逾時封包」。計數改變由既有的 CM4 狀態廣播呈現；Util 原本的 CM11 kick 流程仍保留。
- nominal 每桶週期為 `400 × 4 × 6 = 9,600ms`。17,500ms 是判斷門檻，**不是保證在 17,501ms 當下清除**；仍須等該桶下一次被掃到。Bun event loop 不等同 Win32 Sleep／IOCP 排程。

既有 Shop／Util 測試若直接注入使用者、繞過真實 gate，現在明確補上該前置狀態與 enqueue。Shop constructor fixture 亦正常計入連線數。Util inbox 的舊未定義型別 `CReceived` 改為實際收到的 `CReceivedPacket`；沒有放寬 strict 檢查。

## 驗收

### 確定性回歸：35 tests／281 assertions

`test/center-timeout.test.ts`：

- clock 截斷、bit 31、uint32 rollover、wall-clock 不得被讀取。
- 三種起點各檢查 17,499／17,500／17,501／20,000ms。
- constructor、成功／拒絕 gate、搬移、establishment 各自對 flag/time/count 的權責。
- exact-threshold sweep 保留節點，下輪真正過期才移除。
- serial 分桶、第一桶 1、counter uint32 wrap、high-bit serial。
- 未 enqueue 的 armed 使用者、pending duplicates 的次序、expired／established／missing 的全匹配刪除。
- 同一使用者在 lazy cleanup 前再次轉服，以最新 deadline 為準，不以舊節點提前逾時。
- SetFree 冪等、ExtractUser 不代替 SetFree、搬移後的伺服器清理、一般刪除 residency 與 free-state extraction。
- 雙使用者的 missing／index mismatch／0、1、2 最後結果／重複 serial；回覆中的 serial、結果、目標及位址。
- 不新增逾時封包；400ms timer 的 nominal 倍數與先清理、後廣播順序。

Timer 測試攔截 interval callback，以確定性 tick 驗證控制流；不是實際 Sleep 精度測試。

### 真實網路回歸：新增 1 test

`test/e2e.test.ts`：

1. 透過真實加密 LS client 登入未知帳號，自動註冊成功。
2. 透過 LS→Center 請求 GS 轉服，收到正常目標位址，核對 connecting 狀態。
3. 僅將該使用者 timestamp 回推到逾時，呼叫正式 sweep；不修改全域 clock，也不以 18 秒 sleep 取代邊界測試。
4. 核對兩張表刪除、free 與 GS 計數恰減一。
5. 真實 GS client 送遲到的建立連線封包；Center 拒絕後 GS 關閉 client，而非接受進場。
6. 使用者不復活、計數不再重複扣除。

### 最終執行結果

在 `server-ts/` 執行：

- `bun test`：**317 pass／0 fail／5,763 assertions／16 files／22.01s**。
- 第一份 probe：**14 observations／8 GAP／6 MATCH**，A04 已 MATCH。
- 第二份 probe：**24 observations／20 GAP／4 MATCH**。
- 合計 **38 observations／28 GAP／10 MATCH**。probe 是診斷觀察，不是原生雙端相容認證。
- TypeScript **7.1.0-dev.20260920.1** 與 **7.0.2**：各自通過 source `tsc --noEmit`，以及本輪四份測試、兩份 probe 的獨立 strict 檢查。
- `git diff --check` 通過。

曾誤從 repository root 執行 E2E，兩項既有遊戲測試等待 packet 173 逾時。查明 `SendAirplaneItemProb` 按既有原生流程讀取工作目錄的 `iteminfo.txt`，root 沒有該檔；沒有為讓錯誤工作目錄通過而改動 production loader。回到專案要求的 `server-ts/` 後 focused E2E 與全套均通過；新增的 late-establishment 測試在兩種執行中均通過。

## 明確未完成的界線

- 原生 CUser 的 **全域 serial (+28)** 與 **帳號 SID (+80)** 是不同欄位；現有 port 仍以 `nSID` 同時供 serial table 等路徑使用。本輪修正分桶／list 演算法，**沒有完成全域 serial 配發、跨 shard 身份及所有 wire 傳遞的整條修復**。因此不能宣稱實際 serial 值或每位使用者的絕對掃描相位已與 native 一致。
- `OnConnEstablished` 的完整多人／名稱不符／auth 回覆分支未在此輪重寫或認證；本輪驗證 CUser state gate、有效 matching establishment、以及已逾時移除的單人遲到回報。
- 現有 `nSessionIdx` 查詢欄位與 native 目前 index (+64) 的關係仍待清理。沒有以 timeout 修復冒稱所有位置查詢都正確。
- 上述 Center 身份／回報／查詢工作明列於清點 B 待全鏈追查；A04 已完成的是本報告列出的 clock、狀態與清理差異。
- 不保證 Windows timer resolution、絕對 uptime、IOCP worker interleaving 或整個 CGlobalUserTable 的字串、identity、map 語意。
- 先前 A03 的有效 SQL catalog／IDENTITY／collation／冷啟動競爭等限制仍有效。已列 A 待辦剩 **17 組**，不包含 B 的未完成全鏈核對工作。
