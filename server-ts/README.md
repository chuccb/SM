# CrazyArcade server port

## 獨立運行架構（Self-Contained in `server-ts`）

`server-ts/` 目錄現已完全自包含（Self-contained），不再依賴專案根目錄或其他 C++ 反編譯目錄的資源即可獨立啟動與測試：

- **組態檔目錄 (`server-ts/config/`)**：
  - 收錄全服務運行組態（`Center_000.cfg`、`FXGS_*.cfg`、`FXSS_*.cfg`、`LS_000.cfg`、`Relay_000.cfg`、`FXUS_000.cfg`、`Shop.cfg`、`SVR*.cfg`、`local-billing.json`）。
  - `src/main.ts` 啟動預設直接從 `server-ts/config/` 載入各服務組態。
- **資料封包與種子庫 (`server-ts/data/`)**：
  - **地圖與遊戲封包**：存放 `FxServer.idd` 與 `FxServer.idx`，`CFastFile` 載入時優先尋找指定路徑，並以 `server-ts/data/FxServer` 作為可靠本機備援。
  - **機率掉落檔**：`server-ts/data/iteminfo.txt` 支援飛機/道具掉落概率解析。
  - **SQL Server 備份資料 (`server-ts/data/db/`)**：完整收錄 `CAItem.bak`、`CAConfig.bak`、`Guild.bak`、`UserInfo*.bak`、`UserInventory*.bak` 與 `TB031117.DAT`，供資料庫初始化與自動種子導入使用。
- **執行時期輸出定位**：
  - Center 統計暫存與日誌預設輸出於 `server-ts/Log/`（或自訂 `WebLogDir`）。
  - Shop 交易日誌（`TranxLog_YYYYMMDD.txt`）預設錨定於 `server-ts/Log/`，杜絕任何暫存檔散落至 `src`。

## 原版 source unit 與 port 邊界

`src/Center`、`LS`、`FXGS`、`FXSS`、`FXUS`、`Relay` 分別對應六個原版 binary。服務目錄內的實作檔名以隨附 `.pdb`／`.map`／反編譯結果可證實的 `.cpp` source unit 為準；檔頭保留實際來源根目錄 `CX/CxCenter`、`CX/CxLogin`、`FX/FxServer`、`FX/FxShop`、`CX/CxUtil`、`CX/CxRelay` 或 `common`。例如 app、listener、timer、pool、recordset 各自保留原生 owner。`CxCenter.ts`、`CxLogin.ts`、`FxServer.ts`、`FxShop.ts`、`CxUtil.ts`、`CxRelay.ts` 只是每個 binary 的公開 façade，不重新宣稱 class ownership。

原生 blocking thread／socket API 不適合 Bun event loop；各 `ListenThread.ts` 的 `Start()` 與 timer 的 `Start()`／`Run()` 明示為非阻塞 port adapter，實際組裝及啟動順序仍由原生 app class 的 `SetUp()` 承擔。各 app 以 composition 保留自己建立的 listener、timer、UDP、center／billing transport 與 DB manager，`CleanUp()` 依原生前段終止順序釋放實際 Bun／SQLite 資源；suite entry 在 `SIGINT`、`SIGTERM` 與 process exit 走同一個冪等 cleanup stack。`CCxCenterApp` 尤其不是 `CLocalServerMan` subclass。沒有為了檔名好看而建立空 class，也不保留原版不存在的相容 alias。

| 目錄 | 邊界 |
| --- | --- |
| `src/<service>/` | 該 binary 的原生 class／source unit；`*Runtime.ts` 是為解除 ESM 初始化循環而明示的 port-only dependency adapter。 |
| `src/core/` | 多個 binary 各自編入、但 TS 集中維護的 packet、cipher、clock、config 等共用實作。不是聲稱原版有單一共享 binary。 |
| `src/protocol/` | 由各 binary wire table／dispatch 還原的 typed protocol metadata。 |
| `src/shared/` | 原版在多個 binary 重複、由 port 明確合併的 transport／常數；檔頭均標示 port-only。 |
| `src/db/` | 原生 recordset 行為的 Bun SQLite adapter，以及受限且有來源校驗的備份匯入工具。 |
| `src/LocalBilling/` | 明確的本機替代服務，原版不存在，不冒充 DigiQ backend。 |

`bun run check:imports` 解析實際 static value imports／re-exports 並拒絕 ESM 強連通循環。`bun run check:boundaries` 另外要求六個服務目錄的每個 TS unit 明示「可證實的 native `.cpp` owner」或「port-only／façade boundary」，拒絕重複 source owner、檔名偏離 source basename、未知 source root；owner path 必須能在該服務 PDB 找到，只有未保留 source records 的 Center／Relay 才退回同 basename 的 OBJ record（含已證實的數字 suffix），exported native class 名稱亦逐一對照同服務的反編譯 `.c`。兩者都已納入完整 `check`，避免後續重構只在檔名表面貼齊原版，卻重新引入隱藏 runtime cycle 或虛構 source ownership。

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

## 帳號 shard 盤點／遷移

A23已恢復原版「第一個unsigned byte、只折疊ASCII `A–Z`、再 `%6`」的UserInfo／
UserInventory selector。曾使用舊Unicode公式的DB必須先以唯讀模式盤點；不要直接啟動新版後把
找不到的非ASCII帳號當成新帳號：

```sh
bun run db:shards -- inspect --db ./db
```

真正遷移須停止所有server及local billing，並指定不存在的backup目錄及明示確認參數。
完整table範圍、衝突停止、copy-before-delete crash recovery及操作指令見
[A23帳號分片與舊資料安全遷移](docs/user-shard-compatibility-fix.md)。

## 統一的預覽版工具鏈

2026-09-21 再次查詢並固定 **npm `typescript@next`／`bun@canary`／`bun-types@canary`**：

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

**「最新」的範圍限制：** 2026-09-20 另查到 GitHub rolling canary 指向較新的
`fc297d4658ebfba68e9810e60ba7e0cb719a6f22`，但下載 release asset 時遇到 EOF／TLS 連線失敗，尚未安裝或測試該 build。
本次統一的是 npm 當時最新且可安裝驗證的預覽版，不冒稱已使用所有發佈管道中最新的 Bun。
SQLite 使用 Bun 隨附實作，沒有另裝不相容的 npm SQLite driver，也沒有宣稱它是 SQLite upstream trunk。

### 安裝與驗證

在 `server-ts/` 執行；現有 Bun 可先作為一次性 bootstrap installer：

```sh
bun install --frozen-lockfile
./node_modules/.bin/bun run check
```

Windows 請使用專案 `node_modules/.bin` 下的 Bun executable/shim。
Bun npm wrapper 的安裝 script 使用 `node install.js`；其餘 server／測試執行使用 Bun。
只允許 `bun` 這個 dependency 執行安裝 script，沒有開放所有 dependency scripts。

`check` 依序執行：

1. 核對專案套件、Bun version／revision、SQLite version／source ID。
2. 檢查 `src/` static value-import graph，不允許 ESM cycle。
3. 核對六個服務目錄的 native source-unit／port-only boundary 與反編譯 class identity。
4. 使用專案內的預覽版 `tsc` 檢查 **全部 `src/**/*.ts`、`test/**/*.ts`、`tools/**/*.ts`**。
5. 全套 `bun test`。

其他指令：

```sh
./node_modules/.bin/bun run check:toolchain
./node_modules/.bin/bun run check:imports
./node_modules/.bin/bun run check:boundaries
./node_modules/.bin/bun run typecheck
./node_modules/.bin/bun run probe
./node_modules/.bin/bun run start
# 或 center / login / game / shop / util / relay / billing
```

`probe` 的 GAP 是尚未修復的診斷觀察，不是測試通過證明。
不要改回使用全域 stable `tsc`，也不要以 `bunx` 臨時下載另一套編譯器。
`check` 應在 `server-ts/` 執行：部分原生相容資料載入（例如 `iteminfo.txt`）依工作目錄運作。
版本檢查本身不依賴 cwd，也不接觸正式 DB；SQLite 查詢只使用記憶體資料庫。

### 後續更新原則

1. 重新查詢各 channel，確認 Bun binary 的實際 revision；不要只比較 wrapper 的 semver。
2. 明確更新 `package.json` 的精確版本，重新產生 `bun.lock`。
3. 實測新 runtime 的 `Bun.version`／`Bun.revision` 及 SQLite source identity，再更新 `toolchain.json`。
4. 從乾淨安裝執行 `check`、兩份 probe，記錄結果；不能只更新期望版本來隱藏不相符。

ESNext 是 compiler/runtime 提供的語言與標準庫目標，不是另一個可安裝的「ES 預覽套件」。
目前版本驗證在 Linux x64 完成；其他平台若有不同的 SQLite source identity，必須先核實，不能靜默略過檢查。

## 核心手冊與相容性文件

- [本機 Billing 服務營運與加點指南](docs/local-billing.md)
- [CAItem 商品庫還原與商城商品核對](docs/caitem-catalog.md)
- [UTF-8 資料庫儲存與 MS950 (Big5) 邊界轉碼架構](docs/utf8-database-and-cp950-transcoding.md)
- [A23 帳號首 Byte 分片演算法與安全遷移指引](docs/user-shard-compatibility-fix.md)
- [官方差異與未完成工作清點一](docs/remaining-work-audit.md)
- [官方差異與未完成工作清點二](docs/remaining-work-audit-2.md)

保留「未知帳號登入自動註冊」的明確需求。其餘 client 可觀測行為以提供的原生 EXE／PDB／反組譯為依據；未完成的項目仍列在清單，不宣稱整個 server 已完全相容。
