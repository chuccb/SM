# A11／A21：個人動態資料、等級、詳細封包與持久化修復

日期：2026-09-20。承接 [第一輪清點](remaining-work-audit.md)、[第二輪清點](remaining-work-audit-2.md)。

## 本輪完成範圍

修復已列 A11／A21 的**個人**資料鏈：

`SendGameResult／離房／預庫存經驗 → CUser.dyn → 等級與 71 → 延後／強制 flush → SQLite → LS／GS 重入`

同時修正與 flush counter 混用的 client-initialization gate。保留先前地圖、RNG、A01 transport 修改，以及使用者要求的**未知帳號登入自動註冊**。沒有更動 schema、依賴或 lockfile。

**不是完整伺服器相容宣告。** 獎勵公式的浮點精度、公會結算、A20 庫存載入／裝飾、A10 config 隔離等不由這次個人欄位修復推定完成；沒有執行 Windows EXE 或原版 client 雙端差分。

## 1. 單一動態資料來源與原生數值行為

- `_USERDYNINFO` 從 `FXGS/CUserItemMan.ts` 移至 `db/DBMan.ts`，不再讓資料庫契約歸屬物品管理器。
- 移除與 `dyn` 脫節的三個 W/D/L counter。`IncWin/IncDraw/IncLose` 直接修改同一份 `dyn`；詳細資料與 DB flush 都從這裡讀取。
- 原生證據：FXGS `0041D1C1 / 0041D1ED / 0041D219` 寫 user byte `+216/+220/+224`，正是 byte `+196` 起的 `_USERDYNINFO` 區塊。
- `IncDecMoney` `004090EC`：signed int32 ADD，然後夾至 `0..1,000,000`；以 `USER_MONEY_MAX` 命名上限。
- `IncDecExp` `00416A1D`：signed int32 ADD，負值歸零，再計算 level；回傳 `1/-1/0`。不是無限精度 Number 相加後才判斷。
- `GetLookLevel` `00416E47`：base level + bonus 的 signed32 結果夾至 `1..450`；不可拿 look level 取代詳細資料中的 base level。
- dirty flags 改用用途清楚的 TS 名稱：`m_fDynInfoModified`（byte +1976）、`m_fLevelModified`（byte +1980）。後者只在 level 改變時設置，且保持到 flush；零 delta 仍會標記 dynamic dirty。
- touched field 的 offset 註解改為 byte，避免混用反編譯 DWORD index。這些描述性 member 名稱不冒稱是已取得的原始 PDB member 名。

## 2. Flush 的次數、快照與失敗語意

`CUser::DeferFlushModifiedInfo` `00417603`、`IncGame` `0041D245`、`GetGame` `0041691C`：

1. 計數是**遊戲次數**，不是 timer poll 次數。只有 `IncGame` 增加 unsigned32 counter。
2. 非 force 且未達 25 時直接返回；24／25 邊界與 unsigned comparison 保留。
3. 達門檻或 force：有 dynamic dirty 才複製 `_USERDYNINFO`，清除 counter 與兩個 dirty flag，再寫 DB。
4. 沒有 dirty 時不寫 DB；已清旗標的失敗不自動重試。TS 同步執行不模擬不必要的原生鎖，但保留 snapshot/reset/write 順序。
5. 新增官方命名 `CDBMan::WriteUserDynInfo`，對應 `00408FD2`。BOOL 表示 SQL 執行成功，而非 stored procedure return value；SQLite 執行錯誤轉成 false。

### 刻意保留的 SQL 行為

提供的 `UserInfo00.bak` 可辨識 `prUpdateUserDynamic` 段落為：當 exp/win/draw/lose **全部為 0**，回 -1 而不 UPDATE，即使 money 非零亦然；其餘路徑 UPDATE 五個值，然後回 0。沒有把這個 guard 當成 TS bug 刪除。

原生 wrapper 未取這個 proc return value，只判斷 `ExecStoredProc` 執行狀態（`00409075..0040907E`）。因此 proc -1 或不存在的 row 不等於 wrapper false；真正 SQL 錯誤則為 false。呼叫方依原生行為忽略此 BOOL，不憑偏好加入 retry。備份 strings 僅作該 SQL 段落證據，不聲稱已還原完整有效 catalog。

## 3. 等級表與封包 71

共用表移至 `src/lib/LevelTable.ts`，LS、GS、Shop 不再反向依賴 Login service 目錄。保留已使用的 native-derived helper 名稱。

測試直接解析三份 PE 的 section、image base 與 initialized data，逐筆比對 **450 個值及 count**：

| EXE | Table VA | Count VA | 結果 |
|---|---|---|---|
| LS/CxLogin.exe | 0048E160 | 0048E868 | 全部一致 |
| FXGS/FxServer.exe | 004A84B8 | 004A8BC0 | 全部一致 |
| FXSS/FxShop.exe | 00492180 | 00492888 | 全部一致 |

- `GetLevel` `0040B252`：signed int argument、結果 1..450；以較簡潔 binary search 表達同一分界，測試所有 threshold 與 ±1。
- `GetMaxExpInLevel` `0040B284`：非法索引回 `LEVEL_EXP_SENTINEL = INT_MAX`，不是 0。
- `GetExpPercentage` `0040B29E`：**上、下界**任一為 sentinel 即回 0；其餘保留 signed subtraction、32-bit `imul 1000`、signed `idiv` 語意。測試採 BigInt 整數參考，避免和 production 共用浮點乘法 oracle。
- 本地 `CChannelPool::SendUserDetailInfo` 的 71 寫實際 base-level 上界；跨服務 `OnUserChannelResult` 的 DB-backed 回覆先從 DB exp 求 level，再寫同一上界。
- level 1 上界為 3000；最高門檻 13,815,000 對應 level 450，該級上界為 INT_MAX、進度回 0。
- 保留本地／遠端 location 差異（遠端 65534）、profile reveal 和既有封包欄位順序。原 e2e 中把 level-1 上界固定成 INT_MAX 的錯誤 assertion 已更正。

## 4. 連動 caller 與 gate

- `DeleteUser` `0041D297`：有效房間 phase 1 先 `OnBomberDie`，**再**檢查 `CDynInfoCalculator::IsInvalidGame`（session `+12276`）決定是否加敗；phase 0 加敗、phase 2 不加敗的原有差異保留。
- `SendGameResult` 的勝／和／敗與 `IsInvalidGame` 分支透過相同 dyn mutation 落地；level-up 更新排名與結果封包的鏈路亦測試。
- 正常 `DeferHandleGameEnd` 的 IncGame caller 保留；沒有為了規則看起來一致而改掉原生 disagreement branch 不增加該玩家 counter 的特例。
- byte +2008 官方 getter/setter 是 `IsClientInitialized`／`SetClientInitialized`（`00408155/0040815C`），不是 modified-client flag。
- packet 7 的末 byte 為 0 時 initialized=1，其餘為 0（`00408385..0040839C`）。入場是否傳 202 讀此值，與 `GetGame` 無關；socket hash 的 `m_fImpPoint` 仍獨立。
- 測試 cached client 不重傳 202；有預庫存領取時仍發 207／201。Type 101 經驗領取也走實際資料庫與強制 flush。

## 5. 驗證結果

### 新增 focused 回歸

`test/user-dyninfo.test.ts`：**43 pass／0 fail／3467 expect() calls**。

涵蓋 PE 表資料、所有等級分界、signed arithmetic、零 delta、sticky dirty flag、24/25 次門檻、100 次無遊戲 poll、force、clean flush、snapshot 順序、真實 SQLite trigger 故障、SQL guard、local/remote 71、缺少 DB row、client initialization、預庫存 exp、勝和敗／skip、離房 phase 與死亡 callback 順序。

其中一條 fixture 呼叫實際 game-end、detail、Close、entry handlers，驗證 2999→3001 升級、結果封包、排名、DB 與重入。為隔離狀態契約，該 fixture 的 reward calculator 輸出固定；**不拿它證明原生 reward formula 已完成**。

### 真實 TCP 與全套回歸

`test/e2e.test.ts` 原 live game result 增加 encrypted 71 的勝場驗證；另新增實際 LS→GS 再登入：第一局獲勝、第二局中途離開後，SQLite 與重新登入的 71 均為 **win=1 / draw=0 / lose=1 / exp=0**。不是只重新 new 一個 CUser。

- 全套：**248 pass／0 fail，5237 expect() calls，13 files，15.46 秒**。
- Bun：`1.4.3-canary.1 (26e7a4b36)`。
- TypeScript preview `7.1.0-dev.20260920.1` 與專案 `7.0.2`：source `tsc --noEmit` 均通過。
- 兩版 TS 的獨立 strict 檢查：新 dyninfo 測試、既有 socket-send 測試及兩個 probe 均通過。
- `git diff --check` 通過。

重跑方式（cwd `port`）：

```sh
bun test test/user-dyninfo.test.ts
bun test
tsc --noEmit
tsc --ignoreConfig --noEmit --strict --target ESNext --module ESNext \
  --moduleResolution Bundler --types bun-types --skipLibCheck \
  --allowImportingTsExtensions test/user-dyninfo.test.ts test/socket-send.test.ts \
  tools/compatibility-probe.ts tools/compatibility-probe-2.ts
bun tools/compatibility-probe.ts
bun tools/compatibility-probe-2.ts
```

### 差異清點的最新狀態

- probe 1：14 observations／10 GAP／4 MATCH。
- probe 2：24 observations／20 GAP／4 MATCH。
- 合計：**38 observations／30 GAP／8 MATCH**；A11 的兩個、A21 的三個原始重現已轉 MATCH，並有以上更廣回歸保護。
- A01、A11、A21 已修復本次列明的差異；A02 保留為需求。目前已列待辦剩 **19 組**。

GAP probe 是診斷，不算入 passing test 數字；19 組不是全專案剩餘 bug 的完整枚舉。未把未知 reward/guild 行為、未完成商城或庫存等列成已完成。
