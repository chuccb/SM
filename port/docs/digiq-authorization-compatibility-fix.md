# DigiQ 授權與後續餘額回覆修復

日期：2026-09-20。接續使用者確認 GS → Shop 已能正常進入後，回報 client 224 沒有後續回覆。

> 後續：使用者確認沒有外部 backend，現已新增[本機 billing 替代服務](local-billing.md)。
> 下文測試數字為上一輪歷史紀錄。另更正本文件原先的 packet 7 欄位解讀：三 DWORD 是 serial/SID/BID，並沒有 cash；已補 distinct-value 回歸。

## 診斷與範圍

使用者提供的 21-byte log payload 解碼為 opcode **224** 加兩個 EStr，長度均為 8 bytes。
這是 DigiQ billing 授權，不是遊戲 LS 登入；不應以自動註冊或假造成功取代外部授權。

原版不是直接回 client 224：

```text
client 224 → Shop → billing 341
billing 342 → Shop → client 209
  result == 0: 209 [E1 12][E4 SID][E4 BID]，然後 billing 301 查餘額
  result != 0: 209 [E1 13][EStr billing error]
billing 302 → Shop → client 203（餘額或錯誤）
```

TS 原本已能產生 341，但 `OnDigiQAuthen` 是空函式，即使收到 342 也不會回 client。
另一獨立情況是沒有 billing 連線：`Send` 在 socket 為 null 時不會發送。
單憑 client 224 log 無法知道使用者當時屬於哪一種情況。

本次完成 Shop 端以上回應鏈，**沒有新增 production 假 billing、offline 自動授權或付款成功模式**。
未知遊戲帳號自動註冊的既有需求仍保留，與 DigiQ 授權分開。

## Native 證據與實作

來源為 `FXSS/FxShop.exe.c/.lst`，未執行 Windows EXE。

| 函式／地址 | 行為 |
|---|---|
| `CMainPool::OnReqDigiQAuthorization` 00416B80 | 先取得 selected user、檢查 user+20==0，再讀兩個 EStr；第三欄是角色名稱的 C-string 複本 |
| `CBillingProcess::RequestDigiQAuthorization` 00401DF0 | billing 341 為 E4 opcode，三個 `[E1 byte length][raw bytes]`，不帶 user serial；保留 native 的完整 range 寫入 |
| `CBillingProcess::OnDigiQAuthen` 004044C0 | 讀兩個 DWORD、E1-length name、DWORD result；依角色名稱查 user，user+20 非零則不回覆；0 成功、其他失敗 |
| `CBillingProcess::RequestRemainCashTw` 00402690 | 要求 billing 已連線且 user socket 存在；使用 **user 既有 SID／BID**，不是 342 回傳的兩個 DWORD |
| `CBillingProcess::OnRemainCashTw` 004039F0 | 跳過第一 DWORD，讀 E1-length name，接著 serial/cash/result；**僅 result==1 是錯誤**；其他結果更新 cash 並回 203/1 |
| `CUser::SetCash` 00401460 | 寫入 user+3104；與遊戲金錢 `FxUserDynamic.Money` 不同 |

重要細節：

- 342 成功先送 209，再送 301。原版沒有把回傳 SID/BID 指派給 user，未自行新增這種行為。
- 342 非零錯誤與 302 的 result==1 錯誤都原樣轉送 billing 字串；不改成空字串或 UTF-8 replacement 字元。
- 原 `OnRemainCashTw` 用 `DecodeRest()` 吞掉 serial/cash/result，且判反結果，現一併修正。
- 新增共用 `DecodeBillingString`：E1 長度、Latin-1 byte mapping，保留高位 bytes 和內嵌 NUL。
  明確限制為封包內有效範圍，截斷封包安全忽略，不仿製 native stack buffer overflow／未初始化資料讀取。
- 原 user+20 被重複命名為 `m_fConnEstablished`，但沒有建立連線時的寫入；移除誤名，統一用既有 `m_fTranxInProgress` guard。
- 新增 `m_nBillingCash`／官方名稱 `SetCash`，由 302 更新，不修改遊戲金錢 `m_nCash` 或 SQLite Money。
  **後續更正：** packet 7 的第二 DWORD 是 SID、第三是 BID，不寫 cash；本文件原先說第二欄是 cash 有誤（詳見後續報告的 `.lst` 地址）。
- billing 不可用時，224 路徑會發出不含帳密的診斷；仍不偽造 client 授權成功或原版沒有的錯誤回覆。

## 測試

新增 `test/digiq-authorization.test.ts` **25 個回歸**：

- 保留使用者封包形狀、改用合成帳密的 21-byte 224 fixture → 獨立固定 341 hex 預期；不得立即回覆 client。
- selected user／交易 guard 在解碼前執行。
- 342 的 0／1／2／FFFFFFFF、未知使用者、交易中、空錯誤字串、原始高位 byte／NUL。
- 固定 client 209/12 hex、送出順序，以及不竄改 user SID/BID。
- 302 的 0／1／2／FFFFFFFF、正確 serial 查找、成功／失敗 wire、獨立 cash cache。
- 255-byte 錯誤訊息、signed DWORD cash、角色 C-string 與 credential range 的不同處理。
- 每個合法 342／302 範例的所有截斷前綴均不產生假成功、查餘額或修改 cache。
- 無 billing 不授權、診斷無密碼；授權回覆到達時 billing 已斷線則不發 301。

最初 20 個回歸在修復前為 **9 pass／11 fail**；修復後再補 5 個邊界案例，全部通過。

`test/shop.test.ts` 新增 **3 個 TCP 測試**，使用測試程式內的本機 billing peer：

1. client 224 → 實際 billing 341／342 → client 209/12 → 301／302 → client 203/1。
2. billing 授權拒絕 → client 209/13，沒有後續 301。
3. 授權成功但查餘額失敗 → client 209/12，之後 client 203/0 與原始錯誤字串。

沒有將測試 peer 放入 production 啟動路徑，亦未修改實際部署的 BillingSvr 資料。
既有 Shop 測試的入場 fixture 仍手動設定 Center connecting 狀態；GS ↔ Shop 的真實轉服驗證由上一輪 E2E 保持覆蓋。

從 `port/` 執行：

```sh
./node_modules/.bin/bun test test/digiq-authorization.test.ts test/shop.test.ts test/billing-transport.test.ts
./node_modules/.bin/bun run check
./node_modules/.bin/bun run probe
```

- 聚焦：**100 pass／0 fail／899 assertions**。
- 全套 toolchain guard、strict typecheck 與測試：**465 pass／0 fail／7713 assertions／21 files**。
- 原 diagnostic probes：14 個 7 GAP／7 MATCH；24 個 17 GAP／7 MATCH。
  合計 **38 observations／24 GAP／14 MATCH**，其中 `A17.billing-302-serial` 現為 MATCH。
- A08／A17 **部分完成**，仍保留於 15 組待辦；311 correlation、312／321／322 購買交易等沒有因此完成。

## 使用者端重測與必要條件

1. 更新程式並重啟 Shop。
2. 確認啟動 log 是否有 `Connection to Billing Server established`。
   若是 `No billing server information!`，表示實際 DB 目錄中的 `CAConfig.db`／`BillingSvr` 沒有 endpoint。
   資料欄位為 `SN, ip, port`；需要的是能實作此 Tw billing 協定的服務，不是任意 TCP listener。
3. 重新授權；成功應收到 209/12，拒絕為 209/13。成功後 203 是餘額結果。
4. 若顯示 `DigiQ authorization: billing link is unavailable`，先處理 billing 服務／設定／連通性；
   這項修復不會令「沒有 billing server」自動授權成功。
5. PacketLog 預設只記 client links；要觀察 billing packet ID 需使用 `CA_PACKET_LOG_SCOPE=all`。
   後續本機版本已遮蔽 224/341 credential payload；其他 raw dump／歷史 log 仍可能敏感，分享時遮掉 payload。

尚未以使用者實際 client 或真實外部 DigiQ 服務聯測；目前不能宣稱其部署已完成授權。
