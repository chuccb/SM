# A16：Taiwan billing 封包與 TCP 收送鏈

日期：2026-09-20。承接 [第二輪清點 A16](remaining-work-audit-2.md)。

## 完成範圍

修復 `FXSS / FxShop.exe` 的 billing **封包建構、Tw 外框、socket 收送、完整 opcode dispatch 與錯誤處理**。這是 transport 單元，不是購買交易或商城已完整相容的宣告。

- 先前把 `CSendPacket(opcode, 4)` 的 4 當 cipher degree，造成 opcode 截斷，並送出錯誤的遊戲外框。
- 本輪將專用 codec 與 `CBillingSocketTw` 從大型 `Shop.ts` 分離；保留原生名稱與普通 client／Center 協定。
- 保留自動註冊需求及先前地圖、RNG、A01、A03、A04、A11／A21 修改。
- 沒有接觸真實金流、外部 billing 服務或正式 DB。原生預期來自提供的 `.c/.lst`，沒有執行 Windows EXE／原版 client 雙端差分。

## 原生證據

以下地址皆為 `FXSS/FxShop.exe`。

| 路徑 | VA | 查證結果 |
| --- | --- | --- |
| `CSendPacket(int, int)` / `InitPacket(int, int)` | `00419280` / `00419170` | 第二參數是 opcode byte 寬度 1／2／4；設定 cipher degree 0，再 Encode1／2／4。此 InitPacket overload **append**，不像 base overload 會 reset。 |
| `BNB_TAIWAN::enBillingPacket` constructor | `00419040` | payload 前綴 `[E1 0][E1 opcode]`。RequestGift 的 `.lst:00402BF2` 呼叫此 overload。 |
| `BNB_TAIWAN::enCouponPacket` constructor | `004190A0` | payload 前綴 `[E1 1][E1 opcode]`。RequestCheckCoupon 的 `.lst:00402E49` 呼叫此 overload；RequestUseCoupon 同族。 |
| `GetOutgoingPacketLengthTw` | `004191E0` | 非 raw 回 0；raw 回 payload length + 8。 |
| `EncodePacketTw` | `004192E0` | `[BE32 payload length][BE32 7][payload]`；不套 game header converter／sequence／CRC。 |
| `GetIncomingPacketLengthTw` | `00419230` | 非 raw 回 0；不足完整 8-byte header 回 -1；DWORD length 加 8。 |
| `DecodePacketTw` | `00419350` | 僅 raw、payload 長度必須大於 0；略過 header 並複製 payload，cursor=0。**沒有檢查 header 的第二個 DWORD 是否為 7**。 |
| `CBillingSocketTw::PutPacket` | `00405550` | 連線、長度、send buffer 容量、encode 成功後才累加 send count。 |
| `CBillingSocketTw::GetPacket` | `004055E0` | 判斷完整長度與上限、decode、只消耗一個 frame、保留後續 bytes；不檢查 game code、不推進 game sequence。 |
| `CheckResult` / `CloseAll` | `00405360` / `00405080` | 接收 invalid／too-long／decode 等錯誤走 CloseAll；send overflow 先 Close 再依 flag 終止。invalid send 只回錯誤，不 CloseAll。 |
| `CBillingSocketTw` vtable | `0047D5C0` | `.lst:00405507` 呼叫 `+0x64`，槽 `0047D624` 是 **CloseAll**，不能只憑錯誤訊息的「close connection」猜成 PostClosePacket。 |
| `CMainSystem::TerminateProcess` | `00418790` | `ExitProcess(0)`。CBillingProcess constructor 傳給 billing socket 的 fatal flag 為 1。 |
| `CBillingSocket::IssueSend` / `OnReceiveCompletionPacket` | `00404F30` / `00404F90` | transport write failure、receive buffer overflow 走 CloseAll。 |
| `CBillingProcess::OnPacket` | `00404DB0` | Decode4 後 dispatch 302／312／322／342／352。 |

### Opcode 與外框是不同層

- 331 hello、301 餘額查詢、311 購買請求、341 DigiQ、351 RTT，使用 4-byte opcode。
- 舊 gift／coupon 使用自己的兩個 byte 前綴，但仍經目前的 `CBillingSocketTw` 外框。
- 不把所有 `new CSendPacket(..., 4)` 改成「cipher 4」，也不把所有 billing body 無差別補成四個 byte。
- 321 confirm 的業務產生路徑仍未完成，歸 A08；本輪 codec 可表達它，但沒有假裝已補上該交易流程。

獨立 golden vector：351／123 的完整 wire 必須為：

```text
00000005 00000007 0000015f 7b
```

原 port 的 `2900025f7b` 不是相同協定。

## 實作

### `src/FXSS/Packet.ts`

- 專用 `CSendPacket` 類別，以明確的 opcode width 參數對應 native overload；Shop 以 import alias 區分它與普通 client packet。
- 原本 core `CSendPacket` 的 cipher-degree constructor／InitPacket reset **不變**。
- `FromBillingPacket`／`FromCouponPacket` 是 TS 對 native enum overload 的具名表達，保留 family byte 與原 opcode metadata。
- Tw header 大小、輸出常數與 opcode 寬度集中定義。
- `GetOutgoingPacketLengthTw`／`EncodePacketTw`／`GetIncomingPacketLengthTw`／`DecodePacketTw` 保留官方函數名稱；以接受共用 packet storage 的函數實作，不另建一套 buffer 或用強制 cast 改 prototype。
- 接收端保留 payload 起點供 `OnPacket.Decode4()` 使用。native decoder 丟棄 Decode4 的回傳值；TS 另設完整 opcode 的 metadata **只供 trace**，不改動 wire 或 dispatch cursor。

### `src/FXSS/CBillingSocketTw.ts`

- 將類別從 `Shop.ts` 搬出，實作 Tw 專屬 PutPacket／GetPacket／CheckResult。
- 共用 A01 已修復的 bounded send FIFO／Flush／drain，部分或零寫入後不重編碼、不重複 opcode、不遺失後綴。
- Bun 一次 data callback 可能包含超過 receive buffer 大小的多個合法封包；依可用空間分段 feed／pump，避免將合法黏包誤判成 overflow。單個 frame 仍受原有 max packet bound 限制。
- 原生 fatal flag 保留；production billing socket 啟用。send overflow、接收協定錯誤、write failure 等按查證結果先關閉，再 exit 0；普通 peer EOF 則仍走斷線清理，不自行升格為 fatal。
- core `CPacketSocket.Flush` 只新增一個預設無作用的 `ReportSendFailure` hook，使 billing 的 fatal 分支不用複製整份共用 FIFO。
- logging 使用 BILL table 與完整 opcode；不再印出誤導的遊戲 sequence／CRC 錯誤 dump。

### `src/FXSS/Shop.ts`

- 所有既有 billing builders 改用對應的 packet constructor／family overload；包括原先漏掉 width 的 341，以及漏 family byte 的 gift／coupon。
- socket 的 packet hook 綁定擁有它的 `CBillingProcess`，不再從抽出的 socket 類別反向依賴全域 process singleton。
- 保留 export，既有 imports 不必因檔案拆分失效。
- 本輪不變動 302／312 等 handler 的交易／資料欄位語意；也不藉此宣稱 retry 排程已等同原生。

## 長度與安全界線

原生以 DWORD 做加法，呼叫端用 signed 比較（`.lst:00405635/0040564E/00405673`）。本輪亦保留：

| Header 的 payload length | 加 8／判斷結果 |
| --- | --- |
| 0 | frame 長 8；decode error，不能和「opcode 後 body 為空」混淆。 |
| 32,761（預設 buffer 32,768） | 超過 max frame length，too-long。 |
| `0x80000000` | signed 長度為負，decode error。 |
| `0xFFFFFFF7` | 加 8 得 native -1 sentinel，**not ready**，不擅自改成 too-long。 |
| `0xFFFFFFF8` | 加 8 得 0，invalid packet。 |
| `0xFFFFFFFF` | 加 8 得 7，decode error。 |

`0x7FFFFFF8` 等 wrap 值可能讓原版走向超大 allocation／越界 copy。本輪在複製／配置前檢查實際 storage，回 decode error，**不複製 native UB，也不宣稱原版在該輸入下必定安全回覆相同錯誤**。1–3 byte 的非空 payload 仍按原 transport 接收，不自行加上「payload 至少四個 byte」的新拒絕規則；不足 DWORD 的 dispatch 讀取沿用既有 packet reader。

## 驗證

### 新增 `test/billing-transport.test.ts`：59 tests／275 assertions

- 獨立 hex golden vectors，1／2／4-byte opcode、legacy family 前綴、InitPacket overload 的 append 行為、普通 game packet 不受影響。
- 非 raw 拒絕、空 body／空 payload、FIFO offset encode、8-byte header 完整性、完整 opcode metadata。
- 13-byte RTT 的每一個切分位置；逐 byte 傳入；opcode-only frame；多封包合併；**單次 callback 6,000 個 frame**，包含尾端 partial frame。
- 個別 frame 恰等於 receive buffer 上限、超界與 DWORD 特殊值；不新增 header 常數驗證、不修改遊戲 sequence。
- write 接受 0／1／7／8／12／13 bytes 的兩封包 FIFO；exact send bound、overflow、invalid／encoding error 不破壞 queued prefix。
- 331 之外各既有 builder 的前綴與 frame；301／341／351 的完整測試 body；4-byte dispatch 與 unknown opcode。
- **真實 TCP**：331 hello golden bytes、分段 352 回覆、351 request、peer EOF 清理。
- **7 種獨立子程序 fatal 路徑**：send overflow、empty payload、too-long、receive overflow、negative write、thrown write、hello write failure。實際觀察「先 close、exit 0、沒有執行後續程式」，不 mock process.exit。

### 共用 TCP 回歸更新

原 A01 billing test 將 hello write failure 當成單純斷線；本輪查證 fatal flag／vtable 後，將該案例移至上述子程序驗證，**不是刪除失敗路徑覆蓋**。原本的 drain、reconnect、stale close 測試保留，hello 另改為精確 Tw golden bytes 驗證。共用 32 MiB 真實 TCP backpressure 測試亦在全套回歸內通過。

### 最終結果

在 `port/` 執行：

- 全套 `bun test`：**375 pass／0 fail／6,034 assertions／17 files／24.09s**。
- TypeScript **7.1.0-dev.20260920.1** 與 **7.0.2**：source `--noEmit`，及新測試／子程序 fixture／共用 socket 測試／兩份 probe 的獨立 strict 檢查均通過。
- `git diff --check` 通過。
- 第一份 probe：**14／8 GAP／6 MATCH**。
- 第二份 probe：**24／18 GAP／6 MATCH**；A16 的 wire／parse 兩項皆 MATCH。
- 合計 **38 observations／26 GAP／12 MATCH**。這些仍是診斷觀察，不是原生雙端相容證明。

## 未完成、不能延伸宣稱的部分

- A08 的 billing handler／交易流程，以及 A17 的 302 成功條件、body 解碼、balance cache、311 correlation 等 **仍待修復**。builder-prefix 測試不替其餘 body 欄位或購物結果背書。
- A05 charge key／web 驗證、A06 NexonClub ID、A07 transaction reset 等既有差異仍在。
- `ConnectToSvr` 的原生 server-index 起點、同步 retry／Sleep、OnTimer 併發排程及 native IOCP 資源不足分支未完成全鏈對照；本輪認證範圍是列明的 codec、FIFO、dispatch 接線與錯誤分支。
- 正常連線關閉與 stale callback 的 port 回歸，不等於完整 Win32 scheduling 差分。
- 沒有重建外部 Digicell 服務、金流交易的重試／冪等協定或 SQL catalog，也沒有產生或提交付款。

已列 A 待辦剩 **16 組**；B 的全鏈查證工作另計。
