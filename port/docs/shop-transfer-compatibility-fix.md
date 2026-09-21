# GS ↔ Shop 轉服相容性修復

日期：2026-09-20。

## 使用者回報與直接原因

使用者按下進入 Shop 後沒有反應，提供的 GS log：

```text
<- OnReqConnectToSvr(6) deg2 len=6  | 5c 51 96 ca 53 95
-> OnReqConnectToSvrRes(2) deg2 len=13 | 58 5b 51 96 ca 53 95 e9 ca 53 94 83 20
```

這是 log 中的欄位編碼資料，不是包含傳輸 header／stream cipher／CRC 的完整 TCP frame。
按 `BufferManipulator.ts` 的 E1／E2／E4 規則解碼：

| 封包 | 解碼 |
|---|---|
| 請求 | id=6、server type=11（Shop）、index=0；無 version 欄位 |
| 回覆 | **id=2（錯誤）**、result=1、type=11、index=0、IP=127.0.0.1、port=9801 |

`FXGS/FxServer.exe.lst:004036E6` 明確 `push 6`，隨後呼叫 `CSendPacket` 建構子。
`00411DDE` 建構子保留傳入 packet ID，另將 cipher degree 設為 2；不能把 degree 2 當成回覆 ID。
TS 的 `GS_ClientSend.OnReqConnectToSvrRes` 原本誤設為 2，現改為 **6**。
同一個定義用於 Center 成功／失敗回覆及 GS 本機 `CheckEnterGame` 拒絕，移除重複的 Fail 別名。

在相同結果與位址下，修正後 log 的 payload 應為：

```text
5c 5b 51 96 ca 53 95 e9 ca 53 94 83 20
```

只有第一個 byte 從 `58` 改為 `5c`。這證明 port 有協定差異；尚未收到使用者真實 client 的重測結果。

## 完整轉服路徑追查時一起修正的差異

1. **GS Center 回覆**：`CChannelPool::OnCenterResConnectToSvr`（00403699）依序查找全部 serial；
   遇到不存在使用者立即 return，不再錯位讀取 result。全部成功後只送給最後查得使用者的 socket。
2. **Shop 返回 GS 的 request 寬度**：`FxShop.exe` 的 `CMainPool::OnReqConnectToSvr`（00415210），
   listing `00415232` 呼叫 **Decode1**，`0041523D` 呼叫 Decode4。
   格式為 `[E1 type][E4 index]`，沒有 version。原 TS 用 Decode2，造成 type 與 index 均錯位。
   同時移除原版沒有的 SelectedUserIdx gate，按 socket 的 user count 轉送所有 serial。
3. **Shop Center 回覆的整組檢查**：004152E0，listing `00415327` 遇到缺少使用者直接離開，
   `00415332` 遇到該使用者交易進行中也直接離開；0041533B 繼續查找下一個。
   必須全部合格，才使用最後查得的使用者送 client 6。原 TS 是挑第一個可用使用者，
   會忽略另一使用者缺失或交易中的情況。

兩端零使用者回覆的原版行為涉及無效／未初始化 target；port 保持安全不送出，不仿製記憶體未定義行為。
GS 的 Shop 類型判斷改用既有 `SVRCLASS_SHOP`，不新增另一組硬編碼常數。

## 測試與原本的覆蓋缺口

原 `shop.test.ts` 手動建立 Center 使用者並設定 connecting 狀態，能測 Shop 服務，
但沒有經過 GS 的轉服回覆。因此先前 413 個測試通過，仍無法驗證玩家按 Shop 的真實跳轉路徑。

新增 `test/game-transfer.test.ts` 的 **23 個單元回歸**：

- 用固定的 native opcode **6** 和使用者的原始 log bytes 作預期，不從待測 PacketIDs 常數產生預期。
- GS 成功、Center 拒絕、本機拒絕、Shop request 無 version，以及單／雙使用者、缺失 serial、空群組。
- Shop request 的 E1/E4 寬度、0/1/2 個使用者與無 selected-user gate。
- Shop 回覆的最後使用者、任一使用者缺失／交易中立即中止、共用 socket 只送一次。
- 修改 GS 前：11 個 GS 測試 **5 pass／6 fail**；修改 Shop 前：23 個測試 **13 pass／10 fail**。
  修正後全部通過。

`test/e2e.test.ts` 新增 **1 個真正的雙向 TCP 回歸**：

```text
LS 建帳／登入 → GS 建立連線 → client 6 請求 Shop
→ Center 核准 → GS 回覆 6 → 中斷來源 GS
→ 連向回覆中的 Shop port → client 7 → Shop 18 初始資料
→ client 213 → Shop 200 商品列表
→ Shop client 6 返回 GS → Shop 回覆 6 → 中斷來源 Shop
→ GS client 7 → 210／202／201 → Center 確認已建立
```

不手動寫入使用者或修改 connecting 狀態。Shop 使用獨立子程序，與 GS／LS 共用測試 DB；
新 fixture 使用 19811，避免碰撞既有隔離 Shop 測試的 19801。
子程序以 `process.execPath` 啟動，使用相同的已固定 Bun，不依賴 shell PATH 另有 `bun`。

從 `port/` 執行：

```sh
./node_modules/.bin/bun test test/game-transfer.test.ts test/e2e.test.ts
./node_modules/.bin/bun run check
./node_modules/.bin/bun run probe
```

- 聚焦回歸：**79 pass／0 fail／847 assertions**。
- 完整 toolchain guard、strict typecheck、測試：**437 pass／0 fail／7208 assertions／20 files**。
- 原兩輪 diagnostic probes：仍為 **38 observations／25 GAP／13 MATCH**；本次不是把其餘差異宣告修復。
- 沒有執行 Windows EXE 或原版 client；TCP 回歸使用 TS protocol peer。

## 部署重測

- 更新程式後重新啟動 **GS 與 Shop**（兩邊都有修正）。
- 使用者這筆回覆的目標是 `127.0.0.1:9801`。若 client 和 server 在同一台主機，loopback 可以合理；
  若在不同主機，請檢查 **Center 設定的 `FXSSIP0`／`FXSSPort0`**，需提供 client 可到達的 Shop 位址。
  Shop listener、TCP 防火牆與必要的 NAT 轉送也需匹配。沒有在本次修改中猜測或更動部署 IP。
- 重新按 Shop，應先看到 GS 回覆 `(6)`，再有 Shop 連線／client 7 與 Shop 18。
  若 GS 已回 6 但 Shop 完全沒有新連線，下一步是確認 advertised address 和 client 到 Shop 的可達性。
- 此修復不代表 billing、購買交易、Center serial／SID 等其他稽核待辦已完成。
