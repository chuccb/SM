# Practice 房間啟動、練習地圖選擇與 UDP-loss 誤踢修復

日期：2026-09-21。範圍：`CGameSession::OnRequestStartGame` 的虛擬啟動尾端、
`CPracticeSession` 的立即開始與練習地圖選擇。普通房間的 TCP／MTUDP gate 沒有放寬。
這不是 FXGS 全部戰鬥、AI 行為、結算或原版 client 動態差分完成聲明。

## 實際故障

使用者在 Practice（與 AI 對戰）送出 106 後收到成功的 115 與地圖資料 116，
但沒有收到真正開局的 150。其後 client 仍送 TCP 109 與 MTUDP type 11，server 卻在
`<STARTING>` 狀態送出 195：

```text
Now:397   LaunchTime:259878
banned ... while <STARTING> by udp loss
```

普通房間正常，因為普通房間本來就要等待 TCP 109 與 UDP peer readiness；Practice 的
原生流程不同，不應進入這個等待狀態。

## 根因與原生依據

`FXGS/FxServer.exe` 的啟動鏈是：

1. `CGameSession::OnRequestStartGame` 在 **00421205** 透過 vtable `+0xC8`
   呼叫 `LaunchGameStageEx`。
2. 普通房間的 `CGameSession::LaunchGameStageEx` **004209B9** 是單一 `ret`；
   所以它保留 phase 0，等待 TCP 109 與 UDP readiness 後才送 150。
3. Practice override **004259AC** 跳到 vtable `+0x94` 的 `DeferStartGame`；
   **004259B4** 直接呼叫 `CGameSession::DoStartGame`、送 150、把 phase 改為 1，
   再清除 practice 不使用的 rebirth flag。

原 TS 在共用 `OnRequestStartGame` 只呼叫 `LaunchGameStage()`，並以註解把
`LaunchGameStageEx` 一律視為空函式，漏掉虛擬呼叫及 Practice override。
因此 Practice 留在 phase 0。Practice 的原生 `AddUser` 不寫普通房間使用的
`m_rgJoinTime`，該欄保持 0；server 運行已超過 25 秒時，launch-phase sweep 會把
`timeGetTime() - 0` 視為早已逾時。這就是為何紀錄中實際只過 **397 ms**，仍立即被 195 踢除。

修復不是延長 timeout、偽造 join time、讓 AI 假裝完成 UDP，或停用普通房間的
UDP-loss 保護；而是恢復原版的虛擬啟動分流。

## 一併補齊的 Practice 選圖分流

同一條虛擬 start path 還缺少 `CPracticeSession::SetMapIdxPlayingByLevel`
**0042605F**：

- random `-1` 與 theme random 負值都呼叫 `GetRandomMapIdx`；
- `practice=1`，只選 `PraticeMapGroup`（官方拼字）中的地圖；
- max-team 參數固定為 **2**，premium-ticket 參數固定為 **0**；
- 明確的非負 map index 原樣使用，不消耗 random draw。

已加入 override，避免立即開局修好後仍沿用普通房間選圖參數而隨機落到非練習地圖。

## 修正後的 client 可觀測流程

成功的 Practice 開始現在為：

```text
106 -> 115(result 0) -> 116 -> 173 -> 150
```

150 在 `LaunchGameStage` 尾端立即送出，**不以 TCP 109 或 MTUDP type 1/type 11 為前置條件**。
client 稍後仍送到的 109 依原版 Practice dispatch 靜默忽略；不會重複開始、增加 game serial，
也不會回到 phase 0。普通房間維持原流程，必須同時完成各玩家 TCP 109 與 UDP readiness。

## 驗證

使用專案固定的預覽版 Bun／TypeScript 工具鏈執行：

- 新增 `test/practice-start.test.ts` **10 項**：
  - 1P／2P 與各自 AI；
  - 模擬 25,001、259,878 與 uint32 wrap 邊界的 stale join stamp；
  - 106 的原始 degree-2 byte、115／116／173／150 順序與 150 欄位；
  - 使用者提供的 109 body 形狀、重複 109／106；
  - 驗證失敗不啟動；
  - Practice random／theme／explicit map 參數；
  - 反向確認普通房間仍需 TCP 109 **及**兩方 UDP readiness。
- 真實 TCP E2E：建立 Practice、1 human + 1 AI、由 `PraticeMapGroup` 選 map 1，
  不送任何 UDP 即收到 150；再送使用者紀錄的 109 欄位，900 ms 內沒有 195且 socket 仍連線。
  `test/e2e.test.ts` 維持 **57 pass／0 fail（862 assertions）**。
- `bun run check`：**601 pass／0 fail／26068 assertions（26 files）**，包含 toolchain identity、
  全部 strict typecheck 與全測試。
- 完整檢查也揭露既有 receive-flood fixture 依賴測試程序已運行超過一秒；fixture 改為明確植入
  stale ring stamp，production flood guard 未變動。

沒有執行 Windows 原版 client／server EXE；原生結果來自 `.c/.lst` 靜態流程，TCP E2E
使用本專案 client harness。AI 決策、完整戰鬥事件、斷線重入與 Practice 結算仍屬後續全鏈核對範圍。

## 套用

只需更新並重啟 **GS**，再重新登入／重建 Practice 房間；不需刪除或遷移 DB，
也不需修改 timeout、UDP port 或地圖資料。正式資料仍應保留原本 `Attr/MapGroup` 的
`PraticeMapGroup` 定義；修復會依該原版群組選圖，不硬編碼特定 map index。
