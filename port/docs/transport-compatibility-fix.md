# 共用 TCP 發送鏈修復（A01）

日期：2026-09-20。承接兩輪 remaining-work audit；本輪已實作，不再只是列問題。

## 完成範圍

**A01 部分寫入遺失已修正，包含所有 9 個 TCP adapter、3 條 raw 發送路徑、
Center identification 的相鄰時序問題與斷線清理。**

不宣稱其他協定／商城／DB 問題一併解決。A02 自動註冊依需求保留；
A03、A04、A05–A23 等仍按原清單待辦。穩定編號23項中，A01已修、A02為需求，
現有已列待辦為21組；這不是整個程式只剩21個bug的聲明。

## 原生證據與實作選擇

| 原生位置 | 已核實語意 | TS 對應 |
| --- | --- | --- |
| FXGS CPacketSocket::Flush `0043B530` | 只扣除 Write 回傳數，搬移未送 suffix | Flush 按 Bun.write 回傳值更新同一 buffer |
| CServerSocket::IssueSend `0042EE9D` | 已完成 send 才依實際 byte count 扣除；未完成不能直接清空 | Bun.write 同步、非阻塞；短寫／0 保留，drain 再送 |
| OnSendCompletionPacket `0042EFCF` | 完成後搬移剩餘資料 | Bun drain 觸發同一 Flush，不重新 EncodePacket |
| CClientSocket::IssueSend `004077C9` | 非可重試的發送錯誤會關閉連線 | write -1／throw 進入既有 PostClosePacket 路徑 |
| FXGS ConnectToCenter `.c:3660..3718` | 累積4-byte greeting；辨識階段斷線重試；再送class/index/versions | 顯式 identification 階段；提早抵達／分段／合併均可處理 |
| Center OnConnEstablished `.c:14324` | raw E2 version + E2 descriptor | 原 bytes 不改，改經 SendBuffer FIFO |
| CSocket::Close `004348F0`、ForceSendAndClose `0042EE07` | explicit close 與 force-send-then-close，不是可靠投遞確認 | 保留 close 中止語意；不杜撰等對端ACK或無限drain |

Bun契約依專案 `bun-types` 的 `Socket.write`：unbuffered/non-blocking，可能短寫，
-1 表示 socket closed/shutting down。不是 Node stream 的 boolean write/backpressure API。
本輪沒有執行 Windows EXE；不宣稱已重現 IOCP worker 排程。

## 具體改動

### 一個有界、已編碼的 FIFO

- `core/CPacketSocket.ts::Flush` 不再發送前清零，亦不再額外 `.slice()` 複製整份 queue。
- 每次呼叫最多一次 write，沒有短寫後忙迴圈。0 byte 不減 count；部分寫入只搬移 suffix。
- 新進 frame／raw bytes 都排在 suffix 後面，採原本 send-buffer 容量上限；沒有新加無界 queue。
- `PutPacket` 仍只在編碼成功時推進 cipher/header sequence。Flush/drain 不碰編碼與sequence。
- 新增共用 `SendBuffer`（PutBuffer + Flush），不另造 raw write 路徑。
  `PutBuffer` 拒絕超出來源、非整數等無效長度，避免把未提供的記憶體內容算入 queue。
- SendPacket/SendBuffer 的回傳仍是 enqueue 結果；transport fatal error 由 Flush 關閉連線。
  enqueue成功不是對端已收到或處理的承諾。

### 所有 TCP adapter 接上 drain

1. Center local server listener。
2. Center monitor listener。
3. LS client listener。
4. FXGS client listener。
5. FXSS client listener。
6. FXSS web listener。
7. FXUS client listener。
8. 共用 CLocalSocket → Center outgoing connection。
9. CBillingProcess → billing outgoing connection。

`src` 中 TCP `.write()` 現只剩 CPacketSocket 的一處；UDP 不套用 byte-stream FIFO。
Center greeting、CLocalSocket identification、Shop web raw verify reply 都經同一發送鏈。
本輪沒有改它們的 payload、endianness、cipher、packet ID 或驗證結果。

### 一次性的 Close 邊界

- 先標成 disconnected、解除 Bun handle、清掉收發 count，才進入各連線的 OnClose cleanup。
- LS/GS/Shop 原本重寫 Close 的清理改為 protected OnClose，外部仍使用 Close/PostClosePacket。
  防止清理期間的 send failure 再遞迴做同一套 user/session/DB 清理。
- 移除完全重複的 PostClosePacket override 和 Shop 的自我呼叫 onClose hook。
- GS 的尚未編碼 session packet queue 也在清理時釋放。
- Monitor、FXUS 的 socket 集合移除走相同邊界，不只依賴稍後的 Bun close callback。
- Billing 的本地主動關閉與遠端關閉都清掉目前 link；舊 socket 不可把新 link 標成斷線。
  hello write 已失敗時不回報 ConnectToSvr 成功。
- Receive-flood 若已關閉，立即停止該次 OnReceive，不在已清理的 buffer 再塞資料。

**刻意不改的邊界：** Close/PostClosePacket 是中止，不是「務必送完」；未被transport接受的
suffix在close時丟棄，且永不帶到下一條連線。GS ForceSendAndClose 仍是嘗試發送後關閉，
沒有改成持續等待drain而延後房間／user移除。正常開啟的連線短寫才由drain繼續送。

### Center raw handshake 的完整前後順序

- 不再只在 greetingResolve 存在時收 greeting；Bun.connect 尚未resolve時到達的資料也會收集。
- 共用 `CENTER_GREETING_SIZE` 與 `LOCAL_SERVER_IDENTIFICATION_SIZE` 明確標示欄位寬度，
  Center與local兩端使用同一組長度常數。
- greeting之後同批到達的frame先存於原有有界receive buffer；identification進send FIFO後才dispatch，
  保證handler產生的回覆不會插到raw identification之前。
- 成功、斷線、timeout都清除等待器／timer。辨識中的斷線重試，不誤觸已建立連線的fatal hook。
- data/drain/close/error callback都核對Bun socket身分，拒絕舊連線的晚到callback。
- 保留port原有10秒greeting timeout，另命名說明其用途；**它不是新發現的官方常數**。
  既有S2S header/sequence variant與其他timeout政策未在本輪宣稱完成官方相容核對。

## 回歸與重現

新增 `test/socket-send.test.ts`，**26 tests / 168 assertions**：

- 0至8／8 bytes每個write邊界；後續drain只送suffix；空queue無write。
- cipher 0/1/2的raw + 兩個frame順序、byte-by-byte收包、decode後的ID/body、sequence只增加一次。
- 來源buffer被修改不影響已排入資料；短寫後追加與反覆0-byte flush。
- write -1、throw、end throw、重入／重複close、晚到drain、重新attach不帶舊bytes。
- raw/frame容量溢位、無效raw長度。
- 實際Center greeting、Shop raw verification的短寫與web索引移除。
- early／fragmented／coalesced greeting、identification短寫、辨識前後斷線重試、識別write失敗、舊callback隔離。
- 實際billing TCP adapter的hello短寫/drain、write失敗、重連後舊close隔離。
  **此測試明確不把錯誤的Tw frame當作正確wire oracle；A16仍未修。**
- 真實TCP：`0.0.0.0`隨機port listener，暫停Node接收端直到實際產生背壓，再恢復。
  發送 **32 MiB**，驗證實際drain發生、總長度及SHA-256完全一致，應用send queue維持原上限。
  無listener、檔案或背景程序留在測試結束後。

最終驗證：

- Bun **1.4.3-canary.1 (26e7a4b36)** 全套：**204 pass / 0 fail，1751 expect() calls，12 files，15.82s**。
- TypeScript **7.0.2**與preview **7.1.0-dev.20260920.1**專案檢查均通過。
- 新測試與兩個probe另做strict型別檢查通過；`git diff --check`通過。
- 第一輪probe：**14 observations / 12 GAP / 2 MATCH**，A01由GAP變MATCH；A02自動註冊仍MATCH。
- 第二輪probe：**24 / 23 GAP / 1 MATCH**，沒有把尚未處理的billing、庫存、戰績差異改成假通過。
- 合計 **38 observations / 35 GAP / 3 MATCH**。這些diagnostics與204個回歸測試分開計數。

未變更依賴、DB schema、自動註冊需求、購買／獎勵商業邏輯，也未改掉上一輪列出的錯誤oracle。
工作樹原有地圖／RNG改動保留。後續仍需依完整垂直流程修復A16/A17/A08以及購入、領取、庫存、結算鏈。
