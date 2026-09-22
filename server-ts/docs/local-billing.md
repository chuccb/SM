# 本機 Tw billing 替代服務

日期：2026-09-20。使用者確認沒有另外的 DigiQ／billing 服務，要求實作可供 Shop 實際連線的 backend。

**這是有持久化帳務的本機替代服務，不是測試假成功，也不是官方 DigiQ 後端的復原。** 原始 billing backend 不在提供的資料中；以下明確區分 native wire 與本機政策。不連接真實金流。

## 啟動與加點

在 `server-ts/` 使用專案預覽版 Bun：

```sh
# 一般部署：先啟動本機 billing，再啟動既有各服務
./node_modules/.bin/bun run start

# 已分程序執行其他服務時：另開此程序，再啟動／重啟 Shop
./node_modules/.bin/bun run billing
./node_modules/.bin/bun run shop

# 既有遊戲帳號的管理加點；帳號需先經遊戲登入／註冊建立
./node_modules/.bin/bun run billing:credit --account YOUR_ID --amount 1000 --reference admin-20260920-001
./node_modules/.bin/bun run billing:balance --account YOUR_ID
```

- 上面兩種啟動方式擇一；不要在 standalone billing 已佔用 port 時再執行全套 `start`。
- 預設資料目錄是 `server-ts/db`。如使用其他資料目錄，**全部服務與管理 CLI 都必須傳相同的 `--db /path/to/db`**。
- `config/local-billing.json` 預設 `enabled: true, host: "127.0.0.1", port: 9740`。9740 是本機選擇，不是查得的官方 port。可用 `--billing-config PATH` 指定另一份設定。
- Tw 沒有 TLS 或 server authentication，**只允許 loopback**，不能公開於 Internet。Game／Shop 與 billing 須在同一台主機／network namespace。
- `--only shop` 不會偷偷啟動 backend；`start` 或 `--only billing` 才會啟動。
- 僅在 `BillingSvr` 為空或已由相同 endpoint 的本機模式持有時註冊；先成功 bind，才在 `CAConfig.db` 同一交易寫 endpoint 與 `BillingConfig.LocalBillingMode=inventory-v1:127.0.0.1:PORT`。不能覆寫外部 endpoint。
- 已有外部設定時，全套啟動會記錄 skip；standalone billing 則報錯。即使 IP 相同，缺少精確 marker 也不接管。改 port／改回外部服務須由管理者同步調整 endpoint 與 marker，再重啟；不要只留下過時的 mode 標記。
- `enabled:false` 停止自動啟動，但不刪帳務或自動清除已登記 endpoint。
- 成功啟動可看到 `[Billing] local service listening ...`；Shop 應看到 `Connection to Billing Server established`。
- GS 必須啟用 Center 的 `FXAttrShop=1`，才能實際載入 inventory；隨附正式 `Center_000.cfg` 已為 1。各程序應載入一致的 `FxItem/FxStock/FxPackageMap` 商品資料，不會自動灌入測試 SKU。

在 DigiQ 授權視窗輸入**同一角色的既有遊戲 ID／密碼**，名稱須與儲存的角色 ID 一致。未知遊戲帳號登入自動註冊仍保留；billing 不另外建立任意帳號。
新錢包 **0 點**，不是遊戲 `FxUserDynamic.Money`。需要付費的商品必須先加點；加點後重新查餘額／進商城。
`--reference` 必須穩定且唯一：同帳號同 reference 同金額重跑不再加點，不同金額會拒絕。允許 1–80 個 ASCII 字母、數字、底線、點、冒號、連字號。CLI 沒有公開 HTTP/TCP 加點入口。

## 支援範圍（本機政策）

| 項目 | 本機行為 |
|---|---|
| 331／341→342／301→302／351→352 | hello、實際帳密驗證、餘額、RTT |
| 311→312／321→322 | 保留額度 → 原子扣點與給物 → 可重播結果 |
| MoneyType=0 常駐一般商品 | 驗證有效 stock、後端價格、單次數量、等級、庫存限制；成功才結算 |
| 常駐 flat package | 同 shard 一次給所有子項；拒絕巢狀套裝／重複 ItemSN／不支援的子項 |
| 有效期、Premium ticket、LimitEx、exp/money 特殊物品 | 拒絕，不假造權限或跨檔案原子性 |
| gift、coupon、購物車 | 本機模式在 Shop 明確拒絕；不轉送也不扣款。gift/cart 回 204/1；coupon 使用既有 208/7 拒絕碼，並非原版新增的「不支援」碼 |
| MoneyType!=0 既有遊戲金錢路徑 | 不由此 backend 結算，既有 A18/A19 缺陷仍另列；不是本次完整修復範圍 |
| 外部 billing 的 purchase settlement | 未完成 native 給物／補償；312 成功採取消而非假成功。授權／餘額原有路徑保留 |

購買時的 `LimitLevel` 對套裝及各子項檢查；`ValidityPeriod/ValidityLevel` 非零、`LimitEx` 非零皆不支援。
庫存最多 400 rows 是保守本機限制：未知／到期 row 也計數，不宣稱等同 native loader 的計數規則。
已過期、期限不明或限時的舊 stack 不接受新的常駐購入，不偷偷延長舊權益。

## 帳務、重送與失敗

- 每個角色的 `LocalBillingWallet/Authorization/Reservation/Ledger` 與其 `FxUserInventory` **放在同一 inventory shard**。不把 WAL `ATTACH` 誤當跨檔案 crash-atomic transaction。
- `BEGIN IMMEDIATE`、WAL、`synchronous=FULL`；321 成功時，扣點、全部物品、ledger、committed 狀態同一 transaction。任一步失敗全部 rollback；失敗結果可持久化時才回最終錯誤，否則關閉 peer 留待相同 reference 重試。
- 成功不由 Shop 再給一次物品。不存在「扣款成功之後再異步嘗試寫庫存」的正常路徑。
- 一個帳號只有一筆有效 hold；相同 active tuple 重送 311 回相同 reference，另一筆訂單拒絕。hold 120 秒，尚未確認不扣款、不給物；可用餘額扣除有效 hold。
- reference 為 32 字元 hex 字串；321 綁 world／serial／stock，取消與過期不能轉為成功。terminal result 重送／重連／DB reopen 不再扣款或給物。
- Shop 每 2 秒重試原 request：拿到 reference 後只重試相同 321，不回頭新建 311。未收到 312 的等待最長 120 秒；321 已送出則不能猜測「沒有扣款」，持續詢問結果。
- Shop restart 不持久化前端 pending map：未確認 hold 會到期；已確認的 inventory/ledger 仍在。下一次入場重新載入庫存與餘額，不能保證已斷線 client 還收到先前的 204。
- **不是任意重送全域 exactly-once**：native 311 沒有客戶端 nonce；已完成後又送相同商品 311 視為新購買。防重覆限於同一 active hold／同一 durable 321 reference。
- authorize 有效 1 小時；每帳號跨連線每分鐘最多 10 次失敗，成功不占額度；失敗 key table 上限 1024。SID 綁遊戲帳號 SN，重建同名帳號不能繼承舊授權或扣舊錢包，需管理者處理。
- 最多 16 peers、4096-byte frame，10 秒 hello deadline，hello 後 idle 15 分鐘（native RTT 間隔 10 分鐘）。非法／截斷／未知 family 關閉該 peer，不終止本機 backend。
- 開啟 `CA_PACKET_LOG=1 CA_PACKET_LOG_SCOPE=all` 可追 ID／順序；Shop 224 與兩端 billing 341 payload 會隱藏帳密。這不表示所有歷史 log 或其他協定都沒有敏感資料。
- 備份／還原必須包含 inventory shard 中完整帳務與給物狀態，不能只還原 wallet。停相關服務後使用 SQLite backup；不要在 WAL 寫入中只複製 `.db` 主檔。此版不自動刪除財務 ledger。

## Native 交叉確認與重要修正

來源為 `FXSS/FxShop.exe.c/.lst`、`FXGS/FxServer.exe.c/.lst` 及可辨識的 SQL 備份片段，未執行 Windows EXE。

1. **更正上一輪 packet 7 解讀**：00415980 的三 DWORD 是 `serial/SID/BID`，不是 `serial/cash/SID`。`.lst` 00415A52/00415A5C/00415A68 分別落到 +3112/+3108/+3096，cash +3104 獨立。現在用不同數值測試，避免全 FFFFFFFF 遮住錯位。
2. 311 的 correlation 由 `.lst` 00402975..00402980 確認讀 user+3096/global serial，**不是 BID**。
3. 312（00403C80）：三個忽略 DWORD、string8、serial、忽略 DWORD、result；0 成功；1 才有 error string。321 為 string8／serial／stock／result；missing/busy user 的 native 取消為 stock FFFFFFFF、result 2。
4. 322（004047B0）：string8／serial／result；非零附 error string。正常成功回 client 204/0 + 8-byte variant time，錯誤一般為 204/1、gift 為 204/5。
5. **原版先給物，再送 321，322 失敗可補償；本機改在 backend 的 321 原子給物扣點**。這是明示的內部結算政策差異，不是官方 backend 證據。312 的 opaque string 作為本機 reference，不宣稱已證明原欄位商業意義。
6. **DateCreated/LevelCreated 是到期門檻**。Shop 00408D10/00408D26 對零 validity 使用 100000 天／2000；GS 0040AF55 依日期／等級刪除到期物品。新本機給物遵守這些門檻，沒有移除 GS 到期檢查。非本機 A19 caller、預庫存領取、A13 時區／variant time 的其餘差異未因此完成。
7. 新 312/322 reader 拒絕截斷與多餘尾隨資料；這是安全收斂，不仿製 native 的寬鬆消費／越界讀取。

## 驗證與仍未完成的工作

```sh
./node_modules/.bin/bun run check
./node_modules/.bin/bun run probe
```

- 最終全套：**506 pass／0 fail／8131 assertions／22 files**，包含工具鏈核對及 strict typecheck。
- `test/local-billing.test.ts`：41 個案例。驗證真實帳密、CLI、啟動及 bind 失敗不留 endpoint、外部模式隔離、credits、hold/cancel/expire、套裝原子性、兩個實際程序競爭、DB reopen、截斷、RTT、斷線重送與 credentials redaction。
- 注入第二件給物／ledger 寫入錯誤：確認先前給物與扣點全部 rollback。實際 TCP 在提交後刻意丟掉 322、斷線重連重播，只扣一次；不是假定所有網路寫入都成功。
- `test/e2e.test.ts`：56 pass。LS→GS→Shop→實際 backend 授權／購買→GS：100 點購買 25 點、餘額 75、inventory amount 2；回 GS 的 201 也必須帶這件物品，且 DB 不被載入過程刪除。
- E2E 使用與正式配置一致的 `FXAttrShop=1`，經 Center 的 CM12 啟用真正 GS loader，不只檢查 DB row。暫時回復錯誤的 now/current-level 給物值時，此 E2E 會失敗（55 pass/1 fail）；修正後全部通過。
- Probes：14 個 6 GAP/8 MATCH；24 個 16 GAP/8 MATCH；合計 **38 observations、22 GAP/16 MATCH**。A08 prefix／A17 311 correlation 轉 MATCH。
- A08 probe 移除成功 result 後原本多餘的 E1(0)，採 native 成功必要欄位；並補正常組裝應注入的 `pool.billingProcess`。沒有把 strict parser 的拒絕改成成功，也沒有用 MATCH 宣告完整 purchase parity。

**A08／A17 仍僅部分完成，既有 15 組待辦不減。** Gift/coupon/cart、receipt/reset、premium、timed entitlements、外部 native 給物補償、A18/A19/A20 的其餘路徑仍未完成。未做 Windows client／原版 EXE／外部 DigiQ 聯測，也未做實際斷電或 kill-midcommit 測試；SQLite rollback 注入和 reopen 測試不能冒稱硬體故障驗證。
