# A20：GS 庫存載入、道具狀態與裝飾封包修復

日期：2026-09-21。範圍是**已存在的 live inventory → GS 登入載入 → 功能／外觀狀態 → 201、個人資料 71、入房 105 → 重新登入**。
不是完整商城交易／預庫存領取／裝備切換功能的完成聲明；A18、A19、A13 仍分別追蹤。

## 原生證據與修正

以提供的 `FXGS/FxServer.exe.c`、`.lst` 及 `FxServer.pdb` 公開符號核對；沒有執行 Windows EXE。

### 1. InitUserInventory 的完整 live-row 走訪規則

原生 `0040AF55`，特別是 `.lst:0040B09D`、`0040B192`：

- 找不到 FxItem 定義：ReportError 後繼續，不中止整位玩家登入；該筆留在 DB，且占一個計數。
- 已知且到期：嘗試刪除，不加入 inventory，也**不占計數**。
- 已知且未到期：載入並占一個計數。
- 達 400 即停止，之後的到期列也不繼續清理。這不是 `LIMIT 400`，也不是 `inventory.length < 400`。
- 此計數限於每次 rowset 走訪；原版沒有在這裡清空既有 vector。正常重新登入會建構新的 CUser。
- 查詢失敗回 false，走既有拒絕登入／close 路徑，不偽裝成成功的空庫存。
- DeleteInventory 的失敗結果被原版忽略，之後的有效列仍可載入。SQLite throw 同樣局部處理，不把刪除失敗變成整個 GS 登入中斷，也不假裝已刪掉 DB 列。

走訪依 DB 提供的列順序，不額外排序；沒有宣稱 SQLite 與 SQL Server 在未指定 ORDER BY 時具有相同實體列順序。

原生 `CRSUserInventory::OnReceiveRow` `00411FFF` 的 Slot 為 BYTE、LevelCreated 為 signed SHORT；已在載入邊界保持寬度。
日期只解析一次，known-row 時鐘每筆取樣；維持「等級 >= 到期等級」及「now > 到期時間」的分支方向。

**日期限制仍須區分：** 本輪測試使用有效、明確時區的 ISO 時間做分支驗證；
A13 的 Windows local-calendar OLE DATE／秒精度與 SQLite 時間域尚未完成。
NULL／無法解析的 SQLite 日期沿用既有到期處理政策，不把原生無效／未定義資料行為冒稱已等價還原。
未藉由關閉到期判斷來掩蓋 A19 上游寫入問題。

### 2. UserInventory 只保留一份正確欄位

| 原生 offset | 實際用途 | 本輪修正 |
| --- | --- | --- |
| +12 | 從 FxItem.strAttr 複製的資源／功能名稱 | 移除多餘的 display strName；功能查詢不再錯比中文商品名稱 |
| +24 | nAttr1 | SlotDecoration 圖樣編號等原始屬性 |
| +28 | nAttr2；也是裝飾種類索引 | 移除互不更新的另一個 Slot 欄位 |
| +32 | nAttr3 | CharDeco／Bomb 等附加屬性 |
| +36 | DB Slot BYTE | SlotByte，255 表示未裝備，與裝飾種類無關 |

`GetSlotDecorationLoaded` `00416BAE`／`GetCharDecoLoaded` `00416BDD` 按 category、nAttr2、SlotByte 選第一筆符合者。
原版 getter 本身不限制種類數；packet maker 才限制 9／5 種。重複種類不變成多筆封包資料。

`GetUserInventoryFromAll` `00416AB0`／`HasFunctionalItem` `00416AE5` 使用 +12 字串的 `_mbscmp` 相等判斷：
大小寫敏感、到 NUL 截止，不做 Unicode case folding；功能道具只要求 category 2 持有，不要求已裝備。
已用原版 `Item/SuperChief`、`Item/BanReflex`、`Item/RoomTicket` 核對，相關遊戲端呼叫共用這些資源識別常數。

### 3. 假等級／圖示不是 premium 授權

額外查到同一 loader 的狀態寫入與登入初始化也有錯置；並非只修原清單中的三個 fixture：

| offset | 原生函數／語意 | 原本 TS 的問題 |
| --- | --- | --- |
| user+1988 | GetFakeLevel／SetFakeLevel | 已裝備 category 6 寫到別的欄位，假等級未生效 |
| user+1992 | SetLevelIcon 的顯示 flag | 被當作 premium／Center auth 欄位 |
| user+1996 | GetLevelIconSn／SetLevelIcon 的 ItemSN | 名字誤導成 premium server index |
| user+2004 | GetAuthencode／SetAuthenCode | category 5 外觀道具竟寫成 premium ticket；真正 Center 回覆卻未寫到這裡 |

`.lst:0040B16D` 寫 +0x7C8=1，`0040B177` 寫 +0x7CC=ItemSN；`0040B18C` 寫 +0x7C4=nAttr1。
Center 回覆則寫 +2004 的 BYTE。三種狀態現已分離；外觀道具不再誤授 premium 權限。

命名按公開符號補回：

- `GetFakeLevel` `00403134`／`SetFakeLevel` `00408DF1`
- `GetLevelIconSn` `0040313B`／`SetLevelIcon` `00408DFE`
- `GetAuthencode` `00408E22`／`SetAuthenCode` `00408148`（保留原符號不對稱的大小寫）

外觀狀態改用 private 儲存與上述 API，避免兩套錯誤別名繼續分裂。
private member 的 TS 名稱依 offset／已確認語意命名，不宣稱 PDB 提供了未公開的完整成員名稱。
這不新增 premium 購買功能，也不替 A19 的 ticket 領取失敗路徑背書。

### 4. 真正修到個人資料與房間封包

原版全域 `SendGameSlotInfo` `0040335B`：

```
E1 decorationCount
  count × (E1 kind, E2 nAttr1)
E2 fakeLevel
E2 category3Count
  count × E2 ItemSN
```

原 TS 的 count 用 E2、圖樣用 ItemSN、fakeLevel 固定 0，皆已修正。
本地查詢與 DB-backed 遠端查詢現共用同名函數；遠端無 live CUser 時，尾端必須是 **E1 0 + E2 0 + E2 0**，不能多一個 byte。
保留 category-3 清單包含未裝備持有物的原版行為。

`CBaseSession::MakeSlotAccessoryPacket` `00419597`：

- SlotDecoration：E1 count；非空時 E1 玩家 slot，再按 0–8 順序 E1 種類／E2 nAttr1。
- CharDeco：E1 count；非空時 E1 玩家 slot，再按 0–4 順序 E4 nAttr1／E4 nAttr2／E4 nAttr3。
- Bomb：E4 nAttr3，沒有已裝備項時為 0。
- null 玩家分支完全不寫資料。
- `MakeSetPlayerPacket` 的 category-4 入場效果仍只出現在 self 分支，值為 nAttr1 的低 BYTE，沒有裝備時為 255。

改為先取同一份裝飾快照再計數／輸出，避免兩次查詢與重複硬編碼；9、5、400、未裝備值及已確認 category 集中於 `lib/Item.ts`。
其中 category 常數是 TS 語意標籤，不假稱找回了原版 enum 名稱。
本機 billing 共用 400 這個上限數值，但仍採「全部 DB row 都計數」的保守政策；不把它與 GS 的走訪規則混為一談。

## 驗證

- 新增 `test/user-inventory.test.ts`：**26 pass、0 fail、180 assertions**。
  涵蓋空庫、未知、399／400／401、混合到期與未知邊界、既有 vector、時間／等級門檻、signed SHORT／BYTE、DB 查詢失敗、刪除回傳失敗／throw、所有 9／5 種裝飾、重複與超界種類、NUL 字串、多人 Center 回覆、外觀與 auth 分離、201／71／105 欄位與完整長度。
- 封包讀取使用獨立 literal mask／BE reader，不用生產 CReceivedPacket 當回歸 oracle。
  原本 E2 裝飾 count 的舊測試也改為已核實的 E1；不是改預期來掩蓋其他未完成的 GAP。
- E2E 使用正式來源中的 ItemSN 3／16／95／169／549／20001 做**既有持有物 fixture**，不是假 catalog 或購買完成證明。
  透過真實 LS→GS 登入、201、71、建房 105、斷線再登入重複驗證；已知過期物刪除，未知物保留且不阻擋登入。
  原版 bomb 20001 沒有對應 FxStock，但有 FxItem；既有持有物仍依原生 loader 載入，不憑空補商店 SKU。
- 全套 `bun run check`：工具鏈核對、strict typecheck 通過；**545 pass、0 fail、25,586 assertions、24 files**。
- 兩份 `bun run probe` 共 38 個觀察：**19 GAP／19 MATCH**。A20 的三個 probe 全部 MATCH，未修改 probe 的預期。
- 2026-09-21 重查 npm：TypeScript next、Bun canary、bun-types canary 仍與專案精確固定版本相同。
  ESNext 與 Bun 內建 SQLite 沿用同一套驗證，沒有拿額外外部 compiler 冒充專案升級。

## 更新方式與剩餘界線

更新後重啟 GS，讓玩家重新登入即可使用新的 in-memory loader／封包行為；多台 GS 應一致更新。
不需重新匯入 CAItem、刪 DB、改價格或重發物品，沒有 DB schema migration。
未知帳號登入自動註冊與本機 billing 原子結算均保留，整套既有測試也已重跑。

A18 遊戲金錢購買、A19 預庫存／期限寫入、A13 本地日曆與 OLE DATE、A22 bonus、A23 shard／migration，以及裝備切換等其他尚未完整核對路徑仍未因此完成。
沒有宣稱所有道具功能／所有 GS packet 已與 Windows client 動態差分一致；本輪證據為靜態原生對照、SQLite 故障與狀態測試，以及 TS 服務的真實 TCP 回歸。
