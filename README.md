# Crazy Arcade / BnB 伺服器移植

以這個儲存庫所附的官方執行檔、IDA 反編譯／組合語言、設定與資源為依據，移植到 **TypeScript `7.1.0-dev.20261014.1` + Bun `1.4.3` + SQLite**。原始證據檔案保留不動。

> **目前尚未完成使用者要求的「完整官方 server 重寫」。**
> 已能啟動 LS、五個 FXGS listener、行程內 Center、選用 Relay，並驗證登入→轉服→一般開局→SQLite結算→實際8秒回準備→第二次開局。已有對局時鐘、炸彈／同步物件核心、載入驗證、可選 GS UDP discovery，以及來源核對的獎勵計算／隊伍統計／純結果判定、163 結果預覽編碼、CUser 動態核心、SQLite 原子結算回執與一般結算／164 回準備尾段、cached-level 排名、受限一般Loading／Running／Result定時Update、來源對照的普通離房／UDP loss移除與195／pool4，以及151／152→166／167鬼魂請求、156→171飛機排程／box-item重設、144／145拾取與149原始公告、Type99金錢的native算術＋SQLite耐久收據／重試協調、Bula160／177、圈次155／170、146事件8、house161／178的board／allocator＋5money獨立收據、146 case0免費relay／paid inventory CAS＋receipt及201欄位修正，原欄名FxItem cached202／v2匯入與GS轉服202／201 preflight，與已核對為原版空操作的DeferResurrection及部分角色事件，但**仍無可玩的完整對局／結算、可用的 FXSS／FXUS 服務、完整公會／練習／任務，也沒有原版客戶端相容性驗證。** 不應部署為可正式遊玩的完整伺服器。詳細範圍見 [Coverage](docs/Coverage.md)。

後續已增加**原生持有道具讀取端**：ItemSn／StockSn 分離、signed16 validity-level／strict raw DATE 投影、可信 CUser resident generation、原生201／105與飾品查詢，以及 pending 重載／ABA fence；**尚未接通 native SQL loader／pre-inventory 正式效果及完整初始化／完整 Windows calendar／provider 整合／native paid persistence**。正式 SQLite 登入庫存仍採明示 legacy bridge，不暗改既有 receipts，見 [UserInventory](docs/UserInventory.md)。

本輪另完成**pre-inventory 的純觀測投影與可信 CUser 讀取端207**：54個固定PE anchors、2,587個獨立手譯C++ cases，保留prefix先於LoadOn、成功30而非SELECT LIMIT、catalog Category dispatch；pre-only reload／ABA已納入Center及pending財務／result fences。**不執行真實premium／XP／money／flush／SQL效果**；後續已接[整組讀取端handoff](docs/InventoryHandoff.md)的conditional207及forced201，含空local與整組預備／同catalog generation，不冒稱native SQL初始化，見[PreInventory](docs/PreInventory.md)。

另已補上**Center非消耗式、exclusive授權lease**：正式GS在任何account／inventory讀取前先驗證整組pending，讀取／codec後全組再驗、最後才single-use handoff。錯guild／serial／ID不會先read；失敗僅釋放preparation，原pending可在同期限內重試。native Center17500ms／DWORD auth1與現代30秒TTL／legacy TicketDate分開建模，不冒稱native財務SQL已接。見[ConnectionAuthorization](docs/ConnectionAuthorization.md)。

本輪新增[原生日期／CTime／隔離DB clock](docs/Calendar.md)：分清DB converter的ms0與rowset未寫weekday／ms，明示clock／API ports、嚴格Gregorian DATE子集及monotonic generation snapshot；不讀JS Date、不改host clock、不自動接入正式GS／SQLite日期或授權financial replay。第21份獨立模型30 anchors／2773 cases，另1680組clock advances；仍不是完整Windows API／native SQL初始化。

新增[pre→owned觀測協調／成對讀取端發布](docs/InventoryInitialization.md)：真CDBMan以同catalog／clock generation串接兩段投影，保留failed LoadOn後的XP前綴對owned level判斷；CUser兩清單全preflight後才一起換revision，不把After當Money／XP／premium給付。第22份模型24 anchors／131 cases，尚未接正式native SQL初始化。

後續[GS resident／混合模式轉移](docs/ResidentInventoryHandoff.md)已讓正式GS保留明示可信native owned／pre與presentation：native空清單也不fallback legacy SQL，每個local分開選來源；整組非空201／207用目標碼頁預備，成功在同一live CUser保留兩epochs／dirty。第23份模型33 anchors／254完整wire images，另有雙local真TCP與209；不宣稱native SQL freshness／expiry refresh／給付或原client已完成。

新增[普通等待房房主警告／移除](docs/WaitingChief.md)：正式400ms排程接上CBanChief與可信native `Item/SuperChief`，核對**capacity+833不是current count+832**、本build固定0的HasAuthority、strict DWORD期限、121 reason0..3、雙local整組移除／pool4與無195。第24份模型48 anchors／2356 cases，另以**未加速真TCP計時器**驗證SuperChief的實際15秒＋30秒；不新增道具／SQL／權限／financial replay或自動lobby成功，特殊模式waiting recovery仍缺。

## 安裝與執行

從儲存庫根目錄執行；需要能安裝 npm 套件的 Node/npm，或已安裝的相同版本 Bun：

```sh
npm ci
./node_modules/.bin/bun --version       # 1.4.3
./node_modules/.bin/tsc --version       # Version 7.1.0-dev.20261014.1
./node_modules/.bin/bun run verify
./node_modules/.bin/bun run db init
./node_modules/.bin/bun run start
```

已有 Bun **1.4.3** 時，可改用 `bun install --frozen-lockfile`，再以 `bun run ...` 執行。不是安裝任意最新版；指定的 TypeScript `next` build 已固定於 manifest 與兩份 lockfile。`Main.ts` 會拒絕不同版本的 Bun。

- 部署設定在 [`Config/Server.toml`](Config/Server.toml)。路徑以啟動時的工作目錄為基準；`:memory:` 可供測試使用。
- 自訂設定：`./node_modules/.bin/bun run start --config Config/Server.toml`。
- 預設綁定 `0.0.0.0`；提供給原版 TCP 客戶端的 `AdvertisedIP` 預設為 `127.0.0.1`。跨機器測試必須改為實際可達的 IPv4。
- SQLite 預設為 `var/CA.sqlite`；首次開啟會建立重建的 schema 6；既有 schema 1／2／3／4／5 會以交易式 migration 升級，請先備份。檔案庫明確確認 WAL、記憶體庫確認 memory mode；多程序首次開庫的 WAL `SQLITE_BUSY` 僅在單一 5 秒預算內重試該 pragma，**不重播 migration／財務 SQL**。不是從 `.bak` 自動還原帳號或商城。
- 註冊預設關閉，沒有預設帳密。GS UDP discovery（`FXGS.UDPEnabled`）及 Relay 都預設關閉；開啟前請先讀 [安全與部署差異](docs/Architecture.md#安全與部署差異)。
- `SIGINT`／`SIGTERM` 停止遊戲timer與 listener，排空仍在執行的 handler，再關閉 SQLite。

### 本機建立帳號

在**自己的互動式 Bash** 輸入密碼，不要將真正的密碼放進命令列、Git 或聊天：

```bash
read -r -s -p 'Password: ' SM_PASSWORD; printf '\n'
printf '%s\n' "$SM_PASSWORD" | ./node_modules/.bin/bun run db create-user MyID --password-stdin
unset SM_PASSWORD
```

密碼從 UTF-8 stdin 讀取，移除最後一個換行，再依設定編碼驗證 byte 長度；儲存為 Argon2id。輸入過程勿開啟 shell tracing（`set -x`）。其餘本機管理指令：

```sh
./node_modules/.bin/bun run db --help
./node_modules/.bin/bun run db check
./node_modules/.bin/bun run db list-users 20
./node_modules/.bin/bun run db money MyID 100    # 增加 100；不是設為 100
./node_modules/.bin/bun run db money MyID -20
./node_modules/.bin/bun run db ban MyID forever
./node_modules/.bin/bun run db ban MyID off
./node_modules/.bin/bun run db notice '維護公告'
```

工具也支援 `--config path`、`--db path`（放在子命令之前）、`set-password ID --password-stdin`、絕對經驗值 `exp ID value`。沒有網路管理／GM HTTP API。公告須重啟載入；封鎖不會踢除既有連線。資料與備份限制見 [Database](docs/Database.md)。

### Listener 與診斷

| 用途   | 預設 port                            | 現況                                                       |
| ------ | ------------------------------------ | ---------------------------------------------------------- |
| LS     | TCP 3838                             | 實作部分原始登入協定                                       |
| FXGS   | TCP 4848 / 5858 / 6868 / 7888 / 8888 | 一般等待房間；不是完整遊戲                                 |
| GS UDP | UDP 4849 / 5859 / 6869 / 7889 / 8889 | `FXGS.UDPEnabled` 開啟後的discovery／一般開局；非完整MTUDP |
| Center | 原始 TCP 2828                        | **沒有開啟**；目前為行程內物件                             |
| FXSS   | 設定中的 9801 / 9811 / 9821 / 9831   | **沒有商城 listener**                                      |
| FXUS   | 原始 TCP 8128                        | **未實作**                                                 |
| Relay  | UDP 9520                             | 明確開啟後才監聽；有額外限制                               |
| 診斷   | HTTP 8080                            | 唯讀狀態頁、`/healthz`、`/readyz`；設 0 關閉               |

HTTP另有`centerMaintenanceFailures`記錄被隔離的Center maintenance錯誤（不含帳密／SQL）；invalid／倒退clock會取消outstanding轉服權限。

HTTP 的 `processReady` 只代表這批已實作的 listener 已啟動，**不代表可開局或官方相容**；狀態同時回報 `completeOfficialRewrite: false`、`officialClientVerified: false` 與缺漏功能。`gameUpdate`明示`ordinary-waiting-chief-loading-running-result` scope、`launchEnabled`／`loadingRooms`／`waitingChiefRooms`／`waitingChiefWarningFailures`、`pendingMoneyPickups`／`pendingHouseClaims`／`pendingSpecialItemUses`／`pendingResults`／failure及移除publication計數；launch opt-in不代表所有模式可玩或listener一定已ready。Arena 的 HTTP 預覽只供診斷，**不是原版客戶端需要的原生 TCP／UDP 通道**，也不是 Web 遊戲客戶端。

## 結構與證據

- [`docs/Architecture.md`](docs/Architecture.md)：原始類別對照、生命週期、移植／安全差異。
- [`docs/Protocol.md`](docs/Protocol.md)：已確認的數值、wire format、來源 VA 與仍未知的欄位。
- [`docs/Gameplay.md`](docs/Gameplay.md)：對局 metadata／事件裁決架構、context／clock／載入／UDP／loss graph／炸彈／sync／game items 的來源與未接通部分。
- [`docs/Database.md`](docs/Database.md)：SQLite、匯入契約與尚未還原的 SQL Server 備份。
- [`docs/Coverage.md`](docs/Coverage.md)：實作、測試與未實作的範圍，不能用函式數推算完成率。
- [`docs/GameLaunch.md`](docs/GameLaunch.md)：106／116／173／109／discovery／150、Loading移除、room key／sequence與真正TCP+UDP連續兩輪驗證。
- [`docs/GameUpdate.md`](docs/GameUpdate.md)：400ms timer、一般waiting-chief／Loading／Running／Result時序、6／10秒死亡／grouped159與未接通的特殊流程。
- [`docs/Ghost.md`](docs/Ghost.md)：151／152與兩種166格式、unsigned時間／signed count、非owner銷毀、離房count及不捏造復活規則的界線。
- [`docs/ItemPickup.md`](docs/ItemPickup.md)：144／145 claim仲裁、149完整CP949公告、未捏造153入口的throw核心，以及money signed32／cap來源。
- [`docs/GameClaims.md`](docs/GameClaims.md)：Bula160／177的flat aliases、圈次155／170的unsigned64排名、case8兩個opaque bytes、真正C3復活hook與不捏造復活規則的界線。
- [`docs/UserItemCatalog.md`](docs/UserItemCatalog.md)：原始FxItem七欄名／不可變catalog snapshot與reload／202、v2 export＋明確v1 adapter、schema6 rename-only migration與DDL error guard、GS雙人202／201 handoff前preflight；native ItemSn／StockSn／日期與equipment仍明示未接通。
- [`docs/InventoryHandoff.md`](docs/InventoryHandoff.md)：正式GS210／conditional202／ALL-local207／forced201、授權DTO讀取／同catalog generation、完整preflight後才consume，以及未執行原生給付／SQL的界線。
- [`docs/ResidentInventoryHandoff.md`](docs/ResidentInventoryHandoff.md)：明示native empty／nonempty及混合模式的GS轉移、paired DTO／非空201、原epochs／dirty保留與post-consume界線，不是native SQL初始化。
- [`docs/PreInventory.md`](docs/PreInventory.md)：原生十欄pre row、先效果後LoadOn的純觀測投影、單人207 body／missing-definition原子拒絕、獨立generation fences及未接財務／SQL；整組讀取端handoff見獨立頁。
- [`docs/ConnectionAuthorization.md`](docs/ConnectionAuthorization.md)：Center issued-pending／non-consuming lease、GS auth-before-read／rebind、native CHECK與17500ms timeout、modern recovery與未完範圍。
- [`docs/UserInventory.md`](docs/UserInventory.md)：原生持有道具 read-side、1768人工C++ cases／72 PE anchors、209／201／105、generation fences與未接原生SQL／paid的界線。
- [`docs/SpecialItemUse.md`](docs/SpecialItemUse.md)：146 case0、Type22 timer、獨立schema5 inventory receipt／耗盡刪除／frozen retry及201修正；明示legacy persistence不冒稱原生ItemSn／StockSn／native日期映射。
- [`docs/HouseClaim.md`](docs/HouseClaim.md)：house161／178、5金錢／board／allocator獨立schema4 receipt、凍結重試、native殘缺body的明示安全差異。
- [`docs/MoneyPickup.md`](docs/MoneyPickup.md)：Type99 durable144／156、schema3引入並由目前schema6保留的wallet CAS＋收據、一次RNG／lost-ack重試、box reset／結算協調與明確未完成的恢復。
- [`docs/Airplane.md`](docs/Airplane.md)：156／171的absolute時間、future marker、opaque records、count0與>3的明示安全差異。
- [`docs/WaitingChief.md`](docs/WaitingChief.md)：普通等待房的capacity／Manner、原版zero authority、native SuperChief×3、121與stack-bound整組移除、未加速真TCP及非financial界線。
- [`docs/PlayerRemoval.md`](docs/PlayerRemoval.md)：原版DestroyPlayer分層、ghost／sync／chief、195／pool4、凍結結果與斷線安全界線。
- [`docs/ResultLifecycle.md`](docs/ResultLifecycle.md)：結算尾段、原版時序與現代 receipt／失敗重試差異；不是完整對局。
- `Common/OfficialValues.ts`、`Common/Protocol/PacketTypes.ts`：已辨識的協定數值及方向；`Common/RuntimePolicy.ts`：明確區分的現代操作限制。
- `Common/Protocol/OfficialMessages.ts`：保留所附PE的原始公告bytes；CP949後綴不因部署Big5而擅自翻譯／轉碼。
- `Common/Protocol/OfficialTables.ts`：由原 PE 擷取的替換表及等級表，附來源 hash／VA，不手工重建表格。

```sh
./node_modules/.bin/bun run analyze index
./node_modules/.bin/bun run analyze find 'CGameContext::'
./node_modules/.bin/bun run analyze show '0x00411737'
./node_modules/.bin/bun run Tools/ExtractProtocolTables.ts
```

`bun run analyze index` 會在 ignored `docs/generated/` 重建六個服務共 **21,780 個反編譯函式標記**與 hash（衍生索引不入 Git，測試所需的固定 fixtures 仍保留）；包含 CRT／STL、重複與未辨識函式，**不是 21,780 個已移植功能**。必要時交叉查閱同一 PE 的 `.lst`；舊 `.map` 位址不一定吻合這批執行檔。

## 驗證界線

```sh
./node_modules/.bin/bun run check
./node_modules/.bin/bun test --timeout 10000
./node_modules/.bin/bun run format:check
# 單獨重建特殊道具／201的人工C++參考（需g++）
./node_modules/.bin/bun run vectors:special-item-use
# 原FxItem定義／202的人工參考
./node_modules/.bin/bun run vectors:user-item-catalog
# Native Center CHECK／route／established／timeout參考（不執行原程式）
./node_modules/.bin/bun run vectors:center-connection
# 原生持有道具read-side／201／105的人工參考
./node_modules/.bin/bun run vectors:user-inventory
# 原生pre觀測投影與單人207 body；不執行financial／SQL effects
./node_modules/.bin/bun run vectors:pre-inventory
# 整組讀取端210202207201與條件／bytes的人工參考
./node_modules/.bin/bun run vectors:inventory-handoff
# Timestamp／CTime支援子集與隔離clock；不執行Windows API／SetLocalTime
./node_modules/.bin/bun run vectors:calendar
# pre→owned觀測順序／獨立30與400計數／非空201207；不執行給付
./node_modules/.bin/bun run vectors:inventory-initialization
```

全部24份獨立參考builder位於 `Tools/Build*Vectors.ts`；最新實測數字與完整性紀錄見 [Coverage](docs/Coverage.md)。

測試包含手工由反編譯轉寫的固定寬度 C++ 參考向量、實際資源檔、SQLite、真實 TCP／UDP、CLI 與啟動失敗清理。**C++ 參考不是執行原始官方程式，也不是原版客戶端錄包**；TCP 測試端使用本實作的 codec，不能單獨當作相容性的證明。

不執行舊官方二進位或 `DB/TB031117.DAT`、不更改主機時間、不連線至舊官方／收費端點，也不製造未證實的商城價格、扣款結果或開局成功封包。
