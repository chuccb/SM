# CAItem 商品庫還原與 Shop 核對

## 修正範圍

先前 `CDBMan` 只建立 CAItem 空表，沒有載入原版商品資料；Shop 能登入不代表商品表已有資料。
本次新增獨立來源解析器、僅限空庫的交易式匯入、啟動整合、唯讀來源審查工具與實際 TCP 整合測試。
沒有塞入幾筆示範商品，也沒有把全部商品改成上架或 1 點。

採用使用者指定的 `DB/CAItem.bak` **FILE=1**：

- 原檔大小：5,562,880 bytes。
- SHA-256：`28eb28c71bc6ccde2f01c0c7d4b98242a526453a95b1fe2f3362a15b59b10420`。
- 第二組備份有 1,452 筆 Price／FixedPrice 改為 1；**不使用、不混合**。
- 保留原始價格、IsValid、分類、數量、限制、文字 bytes、資源路徑及套裝關係。

| 表 | 第一組資料列 | 匯入 SQLite | 用途 |
| --- | ---: | ---: | --- |
| FxItem | 1,103 | 1,103 | GS／Shop 道具定義、GS 202 |
| FxStock | 1,453 | 1,453 | GS 全部商品；Shop 僅載入 IsValid>0 的 549 筆 |
| FxString | 189 | 112 | 77 筆完全相同的重複 SN 依原生 insert_unique 語意去重 |
| FxPackageMap | 988 | 988 | Shop 套裝對照、213 |
| FxCouponMap | 0 | 0 | 原版此組為空，不捏造兌換券 |
| FxBonusMap | 0 | 0 | 原版此組為空，不捏造贈品門檻 |

原始 FxStock `Usage` 是 varchar，不是 integer。共用 schema 已修正，並補入 `ExItemSN`、套裝／券 `DateCreated`、bonus `GameDomain`。
port 既有的額外 `FxItem.nLevel` 仍保留 default 0，不冒充備份欄位。
SQL datetime 以原本的未指定時區 wall-clock 儲存，不擅自把歷史時間認定為 UTC。

## 使用方式

在 `port/` 執行，使用 README 指定的專案預覽版 Bun；以下以 `bun` 簡寫。

```sh
# 只讀第一組來源，輸出列數、原始異常、Big5 商品示例、client 資源路徑
bun run caitem:inspect

# 額外唯讀查看已存在且具有 CAItem schema 的目的庫列數、上架數
bun run caitem:inspect --db ./db

# 可選：明確先匯入空商品庫，不需啟動全部服務
bun run caitem:import --db ./db

# 或照原本方式啟動；在 GS／Shop 建立 catalog cache 前自動匯入空庫
bun run start
# 分程序部署：所有程序必須指定同一個資料目錄
bun run game --db ./db
bun run shop --db ./db
```

`inspect` 的 `source` 是備份審查結果；`destination` 只報目標庫列數／上架數，**不是聲稱目的庫內容或價格與來源完全一致**。
未提供 `--db` 的 inspect 不開啟資料庫；提供時以 readonly 開啟，不建立缺失的 DB。
`--db` 指 SQLite **目錄**，不是檔案；參數採 `--db DIRECTORY`，未知、重複或缺值參數會失敗。
`--source FILE` 只允許相同 SHA 的這份備份搬到其他位置，並非支援任意 SQL Server 備份。

預設 DB 目錄為 `port/db`。自動匯入只在 `src/main.ts` 的全服務／game／shop 啟動發生：

- center/login/billing/util/relay 單獨啟動不觸發它。
- 直接建構 `CDBMan` 不會悄悄填滿商品庫，保留測試／嵌入式使用的明確控制。
- `bun run start --no-caitem-import` 可明確停用；game/shop 同樣接受此旗標。
- 匯入後請重啟 **GS 和 Shop**，避免任一程序仍持有空 cache。已登入 client 請重進 Shop。
- 應看到 `[CAItem] imported` 或 `already-imported`，成功原版資料的 FxStock 列數為 1,453、上架數為 549。

### 資料保護

匯入器只開啟 `CAItem.db`，不還原 UserInfo、UserInventory、CAConfig、Guild 或 billing 資料。
未知帳號登入自動註冊的既有需求也未更動。

- 六張商品表只要任一有資料且沒有本匯入紀錄，視為自訂／既有商品庫，**不合併、不覆蓋**。
  自動啟動保留它並繼續；明確 import 指令以非零 exit code 提醒拒絕匯入。
- 即使只有 FxItem 而沒有 FxStock，也不擅自推測哪些資料可刪除。這種情況 Shop 仍可能是空的，需先備份並人工審查。
- 完成後的 `CAItemImport` 紀錄固定第一組備份 SHA、來源列數與匯入時間。
  重啟不覆寫人工改價，也不重新填入管理員刻意清空的表。
- `BEGIN IMMEDIATE` 內重新檢查狀態；GS／Shop 同時啟動只會成功匯入一次。
  空舊版 schema 升級、所有列插入與成功紀錄在同一交易內；中途失敗回滾，可重試。
- WAL、busy timeout、synchronous FULL。沒有 `--force` 清庫選項。

**不要為了這次更新刪除整個 `db/`，那會包含玩家及錢包資料。**
如要替換已有商品庫，先停相關服務、妥善備份，再另行審查與制定遷移；本工具故意不替你做破壞性決策。
本輪開發只匯入暫存測試目錄，未直接修改使用者正式資料庫。

## 原始資料中已確認的問題

以下原樣保留並由 inspect 報告，不用自造資料掩蓋：

- FxString 的 77 筆重複資料均 byte-identical；不是遺失 77 個不同的字串。
- 商品 6203、6205 的 StringUsage 204、207 不存在，但兩筆都未上架。
- FxPackageMap 有 21 筆找不到 parent 的對照，parent 為 4024–4030，各三筆。
- 22 個已上架套裝共有 36 筆對照指向未上架子商品，例如 6349 → 6192／6193。
  不私自上架子商品；本機 billing 對這類不受支援的交易可能拒絕。
- 所有 FxStock.ItemSN 都能對到 FxItem；沒有藉由跳過無效外鍵來縮水商品數。

原版 IsValid=0 的 904 筆仍存在 SQLite／GS 商品表，但不出現在 Shop 的商品清單。
**完整匯入 ≠ 所有功能可購買。** 本機 billing 仍只支援已實作的常駐普通商品／平面套裝；
premium、限時、LimitEx、gift、coupon、cart 等限制詳見 [local-billing.md](local-billing.md)。
既有 native 相容性 GAP 也不因這次匯入而宣稱已修正。

## 文字、資源與實際 loader

- `FXSS/CItemMan` 從六張 CAItem 表載入，產生 200／205／213 cache；GS 的 `CUserItemMan` 從 FxItem／FxStock 載入、發送 202。
- 按 `FXSS/FxShop.exe.c` 的 UpdateShopItemPacket／UpdateStringPacket／UpdatePackageMapPacket 核對欄位順序、寬度及原始 ANSI 字串。
- SQLite／TS 字串保留 **Latin-1 byte carrier**；網路編碼器取每個字元低 8 bits，送回原始 Big5 bytes。
  不先轉成 Unicode 中文再塞回現有 byte-oriented encoder。inspect 只在顯示商品名稱時解碼 Big5。
- 例如商品 1102：`b07720283135add329` → **針 (15個)**，ItemSN=1、Unit=15、Price=FixedPrice=29、DataFile=`Item/Niddle`。
  商品 1103 的 50 個針為 79 點，而非一律 1 點。
- `FXGS/iteminfo.txt`／`port/iteminfo.txt` 是遊戲機率／掉落設定，不是 Shop 商品目錄，不應拿來代替 CAItem。
- `FXGS/FxServer.idx`／`.idd` 已存在；GS Boot 透過 `CIDFMan` 從 **GS cfg 旁的 FxServer** 載入。
  索引共 256 筆（226 Map、3 Attr 及其他條目），全部 offset/length 均落在 5,180,245-byte `.idd` 範圍內。
  `Attr/ItemAttr` 有 71 個遊戲道具項；原版 prefix 比對能將 `Item/Niddle` 對到第 46 項（0-based）`Item/ItemNiddle`。
- 這些是已在使用的 server-side 遊戲資源，不是匯入 SQL 就能生成的 client 商城圖檔。
  549 筆上架商品使用 64 個唯一 DataFile 路徑；本次保留全部路徑，沒有造假圖片或替換成現代素材。
  **未取得並執行使用者的完整 Windows client 資源包，不能宣稱已驗證全部圖片、動畫或 UI 顯示。**
  若文字與價格出現但圖像缺失，仍須核對 client 版本及相應封裝資源，不應改商品價格或 IsValid 來處理。

## 解析方法與驗證界線

`CAItemBak.ts` 是**這份已知 SQL Server 2000 備份的受限抽取器**，不是通用 `.bak` RESTORE：

- SHA 鎖定檔案，只讀第一組 SSET 範圍，不合併兩組重用的 page IDs。
- 先還原 torn-page sector bits 再解 row slots；核對 sysobjects、syscolumns 物理 offset、sysindexes row counts、clustered leaf links。
- 僅選六個明確的原生 table identities，不誤收歷史／管理用表。
- 依 null bitmap、variable offsets、SQL physical types 解欄位；datetime on-page 為 ticks 在前、days 在後。
- Heap 的審查依來源 checksum、table identity、列數與逐值核對約束；不宣稱完整 SQL Server allocation/log recovery。
- **沒有執行 Microsoft SQL Server 原生還原、transaction-log redo/undo 或 Windows EXE 動態差分。**

### 自動化驗證

- 全部解碼值以獨立 Python 抽取結果的 canonical SHA-256 鎖定：
  `7ebbccdb94bd07cba069da3ae6dd8b69d970b7724db2903889422366dece66a3`。
  規範：六表固定順序、每列 key 排序、每表按 compact JSON 排列，Big5 bytes 作 Latin-1、datetime 為毫秒 ISO wall-clock、相同 FxString SN 去重，再以 UTF-8 compact JSON hash。
- 逐筆／逐欄比較來源與匯入後 SQLite；測試截斷／改動檔案拒絕、空舊 schema、既有資料保護、失敗回滾、兩個真實 CLI 程序競爭及重啟冪等。
- 獨立解壓、解欄位驗證 **549 筆 stock、112 筆 string、988 筆 package、1,103 筆 GS item** 的實際 packet bytes；不只驗列數，也不用同一個 SmartStream reader 自我證明。
- E2E 啟動正式 `src/main.ts --only shop` 自動匯入，以真實 TCP 請求 200／205／213，再登入本機 billing，購買原版 1102。
  100 點 → **71 點**，獲得 ItemSN 1 × 15，離開 Shop 回到 GS 後 201 庫存封包仍為 15 個，沒有被到期處理刪除。
- 可重跑：`bun run check`、`bun run probe`。probe 是既有差異診斷，不是全部相容性已通過的證明。

本輪最終結果：專案 toolchain identity 檢查與 TypeScript 檢查通過；全套 **518 pass / 0 fail / 25,332 assertions / 23 files**。
其中 CAItem 專項 **12 pass / 0 fail / 17,190 assertions**。
兩份 probe 合計 38 個觀察，維持 **22 GAP / 16 MATCH**；沒有宣稱這些既有缺口已完成。
