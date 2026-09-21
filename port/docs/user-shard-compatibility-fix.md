# A23 帳號分片與舊資料安全遷移

日期：2026-09-21

## 結果

A23 已完整收斂：

1. `CDBMan::GetUserHashNo` 現在直接讀取帳號的第一個 **unsigned ANSI byte**，只把
   ASCII `A..Z` 加 `0x20`，再 `% 6`；不再經過整串字串或 Unicode case folding。
2. UserInfo、UserInventory 與 port-only local billing 仍共用同一個 selector；未知帳號登入
   **仍會自動註冊**，且會直接建立在原版 shard。
3. 登入自動註冊及明示建帳前另查明確的舊port shard：若舊帳號仍在那裡，確認ID為已使用、
   拒絕建立空白同名帳號，並輸出不含帳號／密碼的migration提示；不把既有帳號當成「未知」。
4. 新增唯讀盤點及明示 offline 遷移工具，處理曾由舊 port 公式寫入錯誤 shard 的資料；
   不以直接換公式後「找不到就重建」掩蓋既有帳號。
5. 遷移涵蓋 account companion rows、孤立 child rows、inventory、pre-inventory、cart，及
   wallet／authorization／reservation／ledger；`Guild.db` 本身不分六 shard，故不搬動。
6. 所有已知衝突在第一筆寫入前停止；apply 前另建立十二份 SQLite 一致快照並逐檔
   `quick_check`，完成後再次掃描，必須為 clean 才回報成功。

## 原版證據

三份出貨 binary 的函式不是呼叫 locale／DBCS／Unicode lowercase helper，而是相同的直接機器碼：

| Binary | VA | 關鍵指令 |
|---|---:|---|
| `LS/CxLogin.exe` | `0040A280` | `movzx eax, byte ptr [ecx]`；比較 `41h/5Ah`；`add eax,20h`；除以6取餘數 |
| `FXGS/FxServer.exe` | `00408E41` | `movzx eax, byte ptr [eax]`；相同ASCII範圍與除數 |
| `FXSS/FxShop.exe` | `004081B0` | 與LS相同35 bytes |

回歸直接從repo內三份PE依section header取碼並鎖定完整函式bytes，不只依反編譯器輸出猜測。
`movzx byte`證明首值是unsigned；兩次比較證明只折疊`0x41..0x5A`。

帳號／封包字串在此port中是Latin-1 byte carrier。舊公式：

```text
id.toLowerCase().charCodeAt(0) & 0xff
```

會先把原始byte誤當Unicode字母。逐byte比較的差異恰為30個：

```text
0xC0..0xD6, 0xD8..0xDE
```

這些值同時可能是Big5首byte。例如`0xC0`原版為`192 % 6 = 0`，舊port先轉成
Unicode lowercase `0xE0`，錯進`224 % 6 = 2`。ASCII `Alpha/alpha`都進shard1，
只能作control，不能證明非ASCII相容。

先前boundary refactor引入的`MakeLower`恰好已避免上述Unicode轉換，因此當時A23 probe已MATCH；
本次仍把shard公式改為只處理第一byte的獨立實作，並補齊在更早版本已建立資料的遷移。

## Runtime caller

- `DBMan.ts`內所有UserInfo及UserInventory stored-procedure adapters均呼叫同一個
  `GetUserHashNo`（`invDB`亦只委派它）。`prCAAuthUser`／`prConfirmUnregisteredId`／`prCreateUser`
  只有在native與舊selector不同、native shard無帳號但舊shard仍有同ID時阻止空白重建；
  它們不以舊shard繼續寫入，也不記錄ID／password。
- `LocalBilling/Store.ts`直接匯入同一函式，wallet、hold、ledger與給物仍在同一inventory shard，
  沒有另造billing hash。
- `Guild.db`是集中式資料庫；其member／account表不依ID切成六檔。使用者登入所讀的`GuildSn`
  位於`FxUserAccount`，會隨該account family一起遷移；工具不擅自拆搬Guild資料。
- 空字串、首NUL及非Latin-1 JS code unit不是有效native account fixture。runtime helper為安全邊界回shard0；
  migration則把這類儲存資料列為衝突，絕不臆測後搬動。

## 遷移涵蓋範圍

| Family | 資料表 | owner／主要衝突鍵 |
|---|---|---|
| UserInfo | `FxUserAccount` | `ID`；另驗證shard-local unique `SN` |
| UserInfo | `FxUserDynamic`、`TxUserDynamic` | `ID`，即使account row缺失仍獨立搬移 |
| UserInventory | `FxUserInventory` | `UserID,ItemSN` |
| UserInventory | `FxPreInventory` | `SN`；碰撞即停止，不重編可見identity |
| UserInventory | `FxCart` | `UserID` |
| local billing | wallet／authorization／reservation／ledger | 各正式PK；另驗證每帳號最多一筆`held` reservation |

工具掃描十二個既有DB檔，不會建立缺少的shard或猜測不相容schema。local-billing資料表為optional；
若來源有待搬資料但目標缺表／欄位不同，視為衝突。

## 操作方式

先在服務仍可讀的維護規劃階段執行唯讀盤點：

```sh
bun tools/user-shards.ts inspect --db /path/to/db
# 或
bun run db:shards -- inspect --db /path/to/db
```

`clean`表示目前掃描範圍全在native shard；`ready`表示可無衝突遷移；`conflict`會以帳號
Latin-1 hex、table、key、source/target shard及原因回報，不輸出password或完整row。

真正遷移必須先停止Center／LS／GS／Shop／Util及local billing等所有會使用這批DB的程序，
並提供一個**尚不存在**且磁碟空間足夠的backup目錄：

```sh
bun tools/user-shards.ts migrate \
  --db /path/to/db \
  --backup /safe/path/user-shards-before-a23 \
  --confirm-services-stopped
```

成功後再執行一次`inspect`，確認`status: clean`，才重啟服務。backup內含：

- `UserInfo00..05.db`及`UserInventory00..05.db`十二份由SQLite snapshot API產生的完整image；
- 每份image重新開啟後的`quick_check`；
- `manifest.json`中的byte size、SHA-256、公式版本與建立時間。

不要只備份主`.db`而漏掉live WAL；工具的snapshot已包含連線當下已提交內容。外部既有營運備份
仍應保留，不能只依賴本工具建立的一份副本。

## 衝突、失敗與重入語意

- inspect先掃完所有family，並比較來源重複PK、目標PK、`FxUserAccount.SN`、pre-inventory SN、
  local billing keys及partial held constraint。任何已知衝突都在backup／寫入前停止，全體資料不動。
- apply另使用migration lock、短writer-lock檢查及`PRAGMA data_version`，在盤點後有其他connection
  commit時停止。這是額外保護，不替代「先停服務」。
- 每個帳號family先以目標DB的一個`BEGIN IMMEDIATE` transaction完整copy，再以來源DB transaction
  做**全欄位exact-match DELETE**。絕不先刪來源。
- SQLite WAL無法提供跨多DB crash-atomic commit，本實作沒有虛稱可以。若程序在copy commit後、
  delete commit前終止，會留下兩份相同row；下一次run辨認目標exact copy，`destinationCopies=0`，
  只完成來源清理。若row被外部修改，exact delete失敗，目標copy保留，要求operator檢查，
  不會發生「來源已刪、目標未寫」的資料遺失。
- 遷移成功後逐檔`quick_check`並重新建plan；仍有misplaced row或conflict即不回報clean。

## 回歸與probe

`test/user-shard-migration.test.ts`涵蓋：

- 三份PE函式bytes及首byte `1..255`全域；
- 30-byte舊公式差異集合與ASCII control；
- raw-byte自動註冊、account read、inventory write、local billing wallet的同shard caller；
- 舊shard帳號不會被auto-registration遮成native shard的新空白帳號；
- 十種row跨兩family遷移、完整backup、reopen登入／inventory／billing／集中式guild metadata；
- 缺account的dynamic與缺UserInfo的cart獨立搬移；
- 不同target row、account SN及pre-inventory SN衝突時零寫入；
- copy完成／delete未完成的重入清理；clean second run冪等且不建立多餘backup。

`tools/compatibility-probe-2.ts`保留逐byte native結果，並新增舊formula migration scope觀察。
最終完整check與probe數字見`remaining-work-audit-2.md`最新更新。

## 明示界線

- 本修復只處理六份UserInfo／UserInventory SQLite port資料；不宣稱已還原SQL Server collation、
  trailing-space、varchar byte limit或完整`.bak` restore語意。
- 自動工具不合併不同內容、不重編account SN或pre-inventory SN，也不以「較新時間」猜winner；
  conflict需要operator從backup及業務來源決定。
- `Guild.db`、`CAConfig.db`、`CAItem.db`不按帳號首byte分片，故不在十二份搬移／backup清單內。
- 本輪是靜態PE證據、真實SQLite fault/reopen回歸與TS caller驗證；沒有執行Windows服務或原版client。
