# GS 整組預備清單發布：210／202／207／201

本輪把已存在的 [pre-inventory 讀取端](PreInventory.md) 接到真正的 `FXGS/CConnectPool.OnConnEstablished`，不是另造 client request 或固定成功 ACK。

**範圍是可信讀取端的發布，不是原生初始化／給付：** 207 只使用先前由可信 service-local caller 透過 `CUser.InstallPreInventory` 附掛的不可變清單，預設為空。正式 account／owned inventory 仍用明示 legacy SQLite bridge；不 SELECT／重解釋 legacy `FxPreInventory`，不呼叫 premium／Money／Exp／LoadOn／flush，也不套用 projection `After`。完整 native pre→owned SQL／calendar／durable effects 與原 client 驗證仍未完成；完成旗標保持 `false`。

後續[InventoryInitialization](InventoryInitialization.md)增加pre→owned觀測協調與CUser成對可信清單安裝；第二份失敗不半換owned，same-byte pair reload同時換兩個epochs，已由Center與pending financial fences實測。它沒有改本頁正式GS的legacy owned來源、207條件／lease preflight或新增給付／native SQL provider。

## 原始發布條件

`FXGS/FxServer.exe.c` 的 `CConnectPool::OnCenterResConnEstablished`（`0040860C`）與同 PE `.lst`：

| VA                     | 條件／動作                                            |
| ---------------------- | ----------------------------------------------------- |
| `004088FE`／`00408910` | 210、GameAttr 低 BYTE                                 |
| `0040895A..00408968`   | 只看**第一個 local** 的 initialized DWORD；為0才選202 |
| `0040896A`／`00408981` | 202、真 UserItem catalog body                         |
| `00408994`             | 發202即設後續201旗標                                  |
| `004089A0..004089B4`   | 遍歷全部 locals，看是否**任何人** pre count >0        |
| `004089BC`／`004089CF` | 207、BYTE local-user count                            |
| `004089E3..004089F1`   | 為**全部 locals**編 pre body，空者不能省略            |
| `00408A01..00408A06`   | 發207同樣強制201，與第一人已初始化無關                |
| `00408A19`／`00408A33` | 201、BYTE local-user count、每人的 owned body         |

既有 request7 的最後一個 BYTE 仍依原有方式解讀：`Decode1() === 0` 表示 initialized。不是 client request207（delete）變成查預備清單；207 在此是 server response。

| 第一個 local initialized | 任何 local 有pre | 這段發布順序          |
| ------------------------ | ---------------- | --------------------- |
| false                    | false            | 210 → 202 → 201       |
| false                    | true             | 210 → 202 → 207 → 201 |
| true                     | false            | 210                   |
| true                     | true             | 210 → 207 → 201       |

第二人的 initialized 值不決定202。只讓有pre的人進207，會讓 local index／count 錯位；只在發202時才發201，也會遺漏 initialized＋pre 的情境。

## 現代安全順序：先整組預備，再消耗權限

保留來源支持的成功發布順序，但**不照搬 native 的先送210、逐步改 pool／執行不可逆載入的時機**。現在的邊界為：

1. 完整 decode request／integrity，向 Center 取得 issuer／destination socket／server／exact group 綁定的 exclusive non-consuming lease。
2. `CaptureAuthorizedPreInventory` 在已驗證 lease 下擷取整組 pre DTO；**讀取前後**再驗 source／generation／clock／original TTL。
3. 每個 account／legacy owned read 前後 Check，重綁 loaded ID；分開 detached snapshots 與最終 mutable live copies。
4. 捕獲**一份** immutable catalog generation；以已載入 account 的 Exp 建立 detached CUser、SetLevel，安裝同組 pre 讀取端清單。這不變更 live user、不執行給付。
5. 依上表完成210／conditional202／conditional ALL-local207／conditional201；每個使用者 body 後再次 Check。所有 bytes 尚未發送。
6. 最終 whole-group Check／single-use Confirm，切換整組 owner，再重綁先前的 account／legacy owned copies、rank，依序 Send。
7. `finally`只 release preparation。消耗前的失敗保留原 pending／deadline／source，可在剩餘 TTL 內開新 lease 重試這個**讀取端發布**。

兩個各自小於65535的合法 user207 body，合起來仍可能超過 packet 上限；第二個201也可能失敗。因此不能因第一個 local 已編好，就先移動第一人或送210／202／207。缺定義／錯碼頁／整組 overflow 都在消耗前拒絕，不發 malformed-count image 或半套封包。

**消耗後沒有 rollback／exactly-once TCP：** rank callback、source-close 或 transport 失敗都不能讓已消耗 pending 復活。207 Send 失敗時可能已有210／202送出；保留已切換的 owner，不假裝已發送 bytes 可以撤回，也不據此重播金錢／SQL。

## Center DTO 與重入防護

`Center/ConnectionAuthorization.ts:ConnectionPreInventory` 只含：

```text
ID, GlobalSerialNo, GuildSn, Revision, Rows
```

外層、每個 local、Rows array 與每筆 primitive row 均 detach／freeze，不回傳 live CUser／socket／issuer。它是**資料，不是另一份授權**；copy shape 或持有 DTO 不能通過 Center private WeakMap。

`CCenterServer.CaptureAuthorizedPreInventory`／`CCenterProcess` façade：

- issuer／server／socket／group 不符或 stale 時，在任何 pre getter 前拒絕。
- 擷取期間維持同一份 `Checking` guard；getter 不能 nested capture／consume／release，亦不能讓 old one-step confirm 搶走 active lease。
- 擷取後再讀 clock／expire／全組檢查；第二人 getter 內對第一人做同值 reinstall／empty ABA，或推進過期時鐘，不能返回看似合法的混合 DTO。
- getter error 使 preparation retire，原 pending 尚合法時仍可取得新 lease；不延長 deadline。
- Center **不選碼頁**。例如可信 UTF8 清單可保留 emoji，接收 GS 依 outgoing codec 在 detached packet preflight 檢查可表示性，不能在 Center 以預設 Big5 誤拒合法資料。

這是可信單一 event loop 內的 hardening，不是對任意 hostile JS monkeypatch／外部 SQL writer 的全域交易權限。

## 202／207 必須共用 catalog generation

`UserItemPacketSnapshot extends UserItemSnapshot` 增加 immutable `Rows`，與 `GetUserItem` closure 指向**相同 generation**。`CUserItemMan.CaptureSnapshot()` 一次取得排序好的凍結 definitions；`PutUserItemList(packet, snapshot)` 可明確使用那一代，而不重新抓 live map。

GS 在任何 outgoing codec callback 之前捕獲一次 snapshot：

- 202從此 snapshot.Rows編碼。
- 第一／第二 local 的207都依此 snapshot 查 Category。
- pre候選驗證時、202編碼時、第一個207完成後發生 live catalog reload，都不會出現新版202／舊版207，或舊第一人／新第二人的混合。

207 的 level WORD 來自**detached 已載入帳號的 cached Level**；不是 source stale cache、fake/look-level、ValidityLevel，亦不是純 pre projection 的 `After`。現有 owned201仍採 legacy橋接；沒有把 pre SN／ItemSn／StockSn當成 owned SN／ItemID 或 paid authorization。

清單與 generation 在成功發布後**不自動清空／遞增**，發布不是給付／SQL消費／耐久收據。再次使用同一可信 read-side 清單可能再發布相同顯示資料；不可把它當成可以再執行 financial effects 的證明。完成原生初始化前仍須另建可核對的 SQL key／durable effect／recovery 邊界。

## 測試證據與限制

- 第20份獨立人工 C++ reference：**24固定 PE anchors／288 cases**，獨立讀取並核對 LS／GS450項 level table，不 import TS calculator／codec。
- 全288 cases驅動**真正 CConnectPool handler**，逐筆比對完整210／202／207／**empty owned201** scalar bytes；含1／2 locals、0／1／29／30 pre rows、第一與第二人 initialized組合、GameAttr BYTE邊界、signed amounts／period gates。非空 native owned201由既有獨立 inventory reference覆蓋；本模型不聲稱還原 legacy/nonempty/native SQL 對應。
- 新 `InventoryHandoff.test.ts`13項＋`InventoryHandoffLifecycle.test.ts`15項，**28 pass／0 fail／3210 assertions**：auth-before-pre-read、deep DTO／reentry／expiry／ABA、同generation202207、第二人缺定義／碼頁／whole-group overflow、後段201 overflow、同 pending修復重試、post-consume失敗與legacy pre不隱式給付。
- 新**真 TCP** case：LS雙人登入／reserve後，明示可信fixture把第二人的pre附掛；207 overflow使GS TCP被拒絕且**連210都未送**、LS仍持有原pending；修正可信清單後新TCP以同pending成功讀210207201，第一人的207 count0不省略，SQL／money／XP／auth／owned／四種receipts均不被當成pre給付。測試peer共用本實作codec，**不是原client oracle**。
- 三種我們的 TS regression controls：舊handler為0 pass／2 fail→新版2／0；省略202 snapshot綁定為0／1→1／0；省略pre讀取後check為0／2→2／0。測完 exact bytes還原，不執行supplied EXE。

```sh
./node_modules/.bin/bun run vectors:inventory-handoff
./node_modules/.bin/bun test tests/InventoryHandoff.test.ts tests/InventoryHandoffLifecycle.test.ts
./node_modules/.bin/bun run verify
```

一般測試讀取已版本化 fixtures；g++僅在opt-in builder使用，執行的是我們的C++。原EXE／DAT／carved SQL／Windows API不執行，不改host clock，不連舊官方／billing端點。最新整合／重複／完整性數字見 [Coverage](Coverage.md)。
