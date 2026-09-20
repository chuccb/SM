# CrazyArcade server port

## 本機 billing

已加入可實際連線、驗證帳密及原子結算常駐商品／套裝的本機 Tw billing 服務。
`bun run start` 會在 Shop 前啟動它；分程序部署可用 `bun run billing`。
點數初始為 0，使用管理 CLI 加點，與遊戲 Money 分開。不是官方 DigiQ 或真實金流。

**啟動、加點、資料目錄、支援限制與驗證：** [本機 billing 操作及實作說明](docs/local-billing.md)。
Gift/coupon/cart、premium、限時等未完成路徑明確拒絕，不以假成功替代。

## 原版 CAItem／Shop 商品資料

`bun run start`、`bun run game`、`bun run shop` 現在會在啟動時檢查 `CAItem.db`：
只有整個商品庫為空且未曾匯入時，才補入 `DB/CAItem.bak` 的 **第一組備份、原版價格**。
保留既有商品、玩家、庫存和 billing 資料；不使用第二組幾乎全為 1 點的價格。

原版共 1,103 個道具定義、1,453 筆商品，其中 **549 筆上架**；另有 112 筆唯一文字及 988 筆套裝對照。
更新後請重啟 **GS 和 Shop**，並讓兩者使用相同的 `--db` 目錄。
可用 `bun run caitem:inspect` 檢查來源，或 `bun run caitem:import --db ./db` 明確匯入空庫。
自訂或部分商品庫不會強制合併；`--no-caitem-import` 可停用啟動匯入。

**來源核對、操作、原始資料問題與 client 資源限制：** [CAItem 商品庫還原](docs/caitem-catalog.md)。
匯入完整商品資料不等於所有商品的交易功能都已支援，billing 限制仍如上。

## 統一的預覽版工具鏈

2026-09-20 查詢並固定 **npm `typescript@next`／`bun@canary`／`bun-types@canary`**：

| 項目 | 固定版本 |
| --- | --- |
| TypeScript | `7.1.0-dev.20260920.1` |
| Bun npm wrapper | `1.4.2-canary.20260919.1` |
| Bun binary | `1.4.3-canary.1+26e7a4b36` |
| Bun 型別 | `1.4.3-canary.20260919T141209` |
| ECMAScript | compiler `target`／`module`／`lib` 使用 `ESNext` |
| SQLite | 上述 Bun 提供的 `bun:sqlite`，實測 `3.53.4` |

npm wrapper 的版本與 binary 自報版本不同，**不是混裝兩套 Bun**。
`package.json` 使用精確版本，不用 `^` 或浮動 `next`／`canary`；`bun.lock` 固定 transitive dependencies。
Bun 完整 revision 與 SQLite source ID 在 `toolchain.json`；`tools/check-toolchain.ts` 會檢查真正執行中的 runtime，不只看套件名稱。

**「最新」的範圍限制：** 同日查到 GitHub rolling canary 指向較新的
`fc297d4658ebfba68e9810e60ba7e0cb719a6f22`，但下載 release asset 時遇到 EOF／TLS 連線失敗，尚未安裝或測試該 build。
本次統一的是 npm 當時最新且可安裝驗證的預覽版，不冒稱已使用所有發佈管道中最新的 Bun。
SQLite 使用 Bun 隨附實作，沒有另裝不相容的 npm SQLite driver，也沒有宣稱它是 SQLite upstream trunk。

### 安裝與驗證

在 `port/` 執行；現有 Bun 可先作為一次性 bootstrap installer：

```sh
bun install --frozen-lockfile
./node_modules/.bin/bun run check
```

Windows 請使用專案 `node_modules/.bin` 下的 Bun executable/shim。
Bun npm wrapper 的安裝 script 使用 `node install.js`；其餘 server／測試執行使用 Bun。
只允許 `bun` 這個 dependency 執行安裝 script，沒有開放所有 dependency scripts。

`check` 依序執行：

1. 核對專案套件、Bun version／revision、SQLite version／source ID。
2. 使用專案內的預覽版 `tsc` 檢查 **全部 `src/**/*.ts`、`test/**/*.ts`、`tools/**/*.ts`**。
3. 全套 `bun test`。

其他指令：

```sh
./node_modules/.bin/bun run check:toolchain
./node_modules/.bin/bun run typecheck
./node_modules/.bin/bun run probe
./node_modules/.bin/bun run start
# 或 center / login / game / shop / util / relay / billing
```

`probe` 的 GAP 是尚未修復的診斷觀察，不是測試通過證明。
不要改回使用全域 stable `tsc`，也不要以 `bunx` 臨時下載另一套編譯器。
`check` 應在 `port/` 執行：部分原生相容資料載入（例如 `iteminfo.txt`）依工作目錄運作。
版本檢查本身不依賴 cwd，也不接觸正式 DB；SQLite 查詢只使用記憶體資料庫。

### 後續更新原則

1. 重新查詢各 channel，確認 Bun binary 的實際 revision；不要只比較 wrapper 的 semver。
2. 明確更新 `package.json` 的精確版本，重新產生 `bun.lock`。
3. 實測新 runtime 的 `Bun.version`／`Bun.revision` 及 SQLite source identity，再更新 `toolchain.json`。
4. 從乾淨安裝執行 `check`、兩份 probe，記錄結果；不能只更新期望版本來隱藏不相符。

ESNext 是 compiler/runtime 提供的語言與標準庫目標，不是另一個可安裝的「ES 預覽套件」。
目前版本驗證在 Linux x64 完成；其他平台若有不同的 SQLite source identity，必須先核實，不能靜默略過檢查。

## 相容性工作紀錄

- [差異清點一](docs/remaining-work-audit.md)
- [差異清點二](docs/remaining-work-audit-2.md)
- [A06：NexonClub ID 與本輪工具鏈驗證](docs/nexonclub-id-compatibility-fix.md)
- [A20：GS 庫存、功能／外觀狀態與裝飾封包修復](docs/user-inventory-compatibility-fix.md)

保留「未知帳號登入自動註冊」的明確需求。其餘 client 可觀測行為以提供的原生 EXE／PDB／反組譯為依據；未完成的項目仍列在清單，不宣稱整個 server 已完全相容。
