# SQLite、資料匯入與備份限制

## 目前的資料模型

`Common/DB/Migrations/001_Initial.sql` 是根據原 LS／FXGS／FXSS 的 query／stored-procedure binding 所做的**邏輯重建**，不是還原後的官方 DDL。

- 原 `UserInfo00..05`、`UserInventory00..05` 的 shard 在一個 SQLite 內整合。仍保留 `UserHashNo`：ID **第一個 encoded byte** 的 ASCII 大寫轉小寫後 `% 6`，不是整個 ID 的雜湊。
- 已使用 `FxUserAccount`、`FxUserDynamic`、`FxUserInventory`、`FxItem` 與 options；也預留 `FxPreInventory`／guild logical tables，**後兩者不代表對應服務已完成**。
- `RuntimeAudit` 是本移植新增的本機管理日誌，不是冒充原始表。schema2引入的`RuntimeGameResult`與schema3的`RuntimeMoneyPickup`與schema4的`RuntimeHouseClaim`、schema5的`RuntimeSpecialItemUse`亦為現代durability extensions，不是從原stored procedure還原的表。
- `SID`／inventory `SN` 限於相應整數 wire／DB 範圍；money、exp、勝負計數不得 underflow／overflow。`SetMoney` 的參數為 signed delta。
- `ID` 唯一性與查找使用 SQLite ASCII `NOCASE`，不是完整 Windows multi-byte locale collation。
- WAL、foreign keys、`synchronous=FULL`、busy timeout；migration按 `001_Initial.sql`→`002_GameResult.sql`→`003_MoneyPickup.sql`→`004_HouseClaim.sql`→`005_SpecialItemUse.sql`→`006_UserItemCatalog.sql` 順序，在同一 immediate transaction內讀version／升級，失敗rollback；支援既有schema1／2／3／4／5，並測試兩個Bun程序同時開庫。新於本程式的 schema version 會拒絕開啟，不自動降版。
- `CDBSession` constructor的pragma／migration失敗會關閉handle；GS clean-up先停止受限game timer，server排空非同步handler後才關閉共用DB。timer下一tick的同plan重試不等於自動conflict修復或crash後room重建，見[GameUpdate](GameUpdate.md)。

`db init` 與 `db check` 都會經過正常的 open／migration；指定不存在的 DB 時會建立新庫，**check 不是純 read-only 檔案鑑識工具**。請先備份真正的資料，勿把 DB 當成可隨意覆蓋的測試檔。

## Schema2引入的結果回執：目前DB為6，不是商城帳本

`FXGS/CDBMan.CommitGameResult` 接受**伺服器建立**的 round UUID及可信計算結果；沒有對應client payout request。固定格式的canonical JSON、SHA-256、完整scalar-coded163 bytes與全部五欄Before／After在同一 immediate transaction提交。相同key+request回duplicate；不同request重用key拒絕。stale CAS／SQL失敗不留半筆receipt；invalid／no-op／空房仍記錄，防止僅靠before=after或恢復舊值的重放。

- 目前DB schema為6；四種gameplay receipts格式仍為version1，**FxItem logical export改為version2原欄名，version1以明確adapter支援**，兩者是不同格式。
- receipt不綁FK刪除帳號；immutable triggers阻止UPDATE／DELETE，避免把已結算key重新開放。存含玩家ID／before-after數值的資料，需同其他帳號資料一起保護及備份。
- **尚未設計retention／封存／隱私刪除政策**，長期運作會累積資料；不要任意清表，也不要將DB／logical result payload放入Git或公開log。這不是已可正式營運的帳本管理方案。
- digest是損壞檢查，**不是MAC、判勝授權或對具DB寫權管理者的安全防護**。storage idempotency不代表exactly-once TCP、crash後room恢復或商城／billing原子性。
- 一般result tail先durable commit才改live memory；不同於native async writer／25場flush。dirty flag／flush counter保留原算術，不能用它判斷DB是否尚未提交。

API時序／衝突與重試界線見 [ResultLifecycle](ResultLifecycle.md)。升級前用適當SQLite備份流程保存DB與一致的journal狀態，不以live main檔單獨複製冒充完整備份。

## Schema3金錢拾取收據：不是SetMoney或商城扣款

Type99網路144現已接`CommitMoneyPickup`／`ConfirmMoneyPickup`與live coordinator。`CUser.IncDecMoney004090EC`仍先signed32 ADD/wrap再clamp0..1,000,000，先前還有authencode-byte1的一次rand()%2+1與signed32 IMUL；不把SQL `SetMoney`的signed delta當native算術。

`RuntimeMoneyPickup`以**server round UUID＋連續money claim sequence**為key，不以可重設的box當key。固定canonical JSON／SHA-256／exact156 bytes與該user全部五欄Before→After CAS在同一IMMEDIATE transaction提交；新claim須保持room／start descriptor、接續序號、尚未結算。先查exact duplicate再CAS，no-op／飽和／ABA亦不可重付。INSERT錯誤rollback錢包；immutable／closed-round triggers另防意外繞過。result commit會交叉核對已有money的room descriptor。

receipt commit／confirm必須在沒有外層SQL transaction的連線上執行；不能把savepoint release當durable commit。底層batch在receipt交易內仍是合法nested savepoint。controller還確認exact receipt、目前全部五欄stored After及live generation／snapshot，再改live wallet／claim、清pending後發156；失敗不改live、不發成功、不重抽或rebase。HTTP另有`pendingMoneyPickups`，不與pendingResults混為一談。

四類receipt都含user ID／數值及server metadata，需受相同個資／備份保護；尚無retention／封存／安全刪除或通用conflict／orphan／restart修復。stored read-back不等於對任意外部SQL寫者的memory＋SQL原子fence，也沒有exactly-once TCP。native163自身仍不加money；後來的result Before使用已同步的最新wallet，不能寫回launch舊餘額。

完整時序、810組既有C++ money cases及真TCP lost-ack／兩輪reopen測試見[MoneyPickup](MoneyPickup.md)。原始算術、34個PE錨點及8999組item images見[ItemPickup](ItemPickup.md)。

## Schema4 house receipts：不是Type99 item或完整world journal

`RuntimeHouseClaim`獨立保存161的board／color counts／generated-box allocator與5\*accepted的native wallet計算、全ordered request、exact178及root IMMEDIATE五欄CAS。house ordinal與money ordinal各自連續，已有house After必須接上下一Before；兩類與result交叉核對同一round descriptor，新house不得晚於結果。no-op仍有native dirty與獨立receipt；immutable／closed-round triggers、canonical revalidation、DDL rollback／v3保留升級與真Bun跨程序競爭已有測試。

native allocator耗盡的殘缺body不發布，先完整解碼後whole-request拒絕；durability／live全部完成才detached178，順序明示不同於native。HTTP有`pendingHouseClaims`；與pending money互斥、pre-clock重試、擋result／roster／dirty flush。不提供完整room restart、外部writer原子fence、通用conflict repair或receipt retention。詳細來源與wire見[HouseClaim](HouseClaim.md)。

## Schema5 special-item inventory receipts：不是ItemSn／StockSn原始資料還原

`RuntimeSpecialItemUse`只記正quantity的146/case0；獨立連續UseSequence、native request／effect／凍結time、全部inventory metadata Before／After及exact159，與SN／ID／ItemID／Slot／Amount／ExpireDate／Verbose／CreatedAt全欄CAS在同一root IMMEDIATE transaction提交。After0刪SQL，但live仍保留Amount0／dirty及201 row。qty0不產生收據、不設Shop／Nice；Type22只刷新state3 timer。

special／money／house ordinal獨立；四類receipt交叉核對round descriptor／closure。outer savepoint不是durability；COMMIT後確認exact receipt、目前stored After（耗盡須SN完全不存在）及完整live inventory／dirty／array／row identity，再安裝live／發布。HTTP另有`pendingSpecialItemUses`，所有gameplay pending互斥，pre-clock重試不重採timer／消耗delta。schema4→5升級保留既有三類receipt／庫存，late005 DDL失敗rollback；兩Bun程序競爭、file reopen與真TCP兩輪均有測試。

201已修正為SN／Slot／**Amount／Verbose／raw8-byte LE OLEdate**，不是ItemID／date／Verbose。native首DWORD實由ItemSn載入，StockSn另在+4；現代自增SN＋ItemID仍是**簡化模型**，CUserItemMan原生定義cache已另還原，但尚未接通StockSn／level／equipped的原生SQL持久化與載入。native DateCreated civil SYSTEMTIME／timezone也未還原；Unix-second／zero→DATE0是現代bridge，不冒稱原DB語意。來源、明示invalid-paid原子拒絕與完整界線見[SpecialItemUse](SpecialItemUse.md)。

所有receipt仍需個資保護／一致備份；無通用external-writer fence、退款／repair／restart journal／retention。open與`db check`會升級到6，舊binary不可自動降版。

## 密碼與個人資料

新密碼與安全問題答案採 Argon2id；新庫不儲存明文／可逆舊密碼，也沒有預設帳密。請以 `--password-stdin` 建立／重設，不透過 argv 傳密碼。

只有經人工確認、明確標為以下格式的舊匯入值，`InitUser` 才會用相應舊演算法比對：

```text
legacy-uu:<base64 of original encoded password bytes>
```

此格式**不是 import CLI 會自行從 .bak 抽出的資料**。舊演算法存在截斷與可逆性限制；登入成功才升級為 Argon2id。驗證／upgrade hash 期間若被改密碼或封鎖，最後的 conditional UPDATE 會再次核對舊 hash 與當下封鎖狀態，避免 stale authorization。

伺服器和 HTTP 狀態不會列印帳密／個資。`list-users` 僅為有本機檔案權限的管理者輸出識別碼、動態／封鎖等資料；請保護終端輸出與 DB 備份。`var/`、SQLite journals 與 `DB/exports/` 在 `.gitignore`。

## FxItem 邏輯匯入

```sh
./node_modules/.bin/bun run db import-items DB/exports/FxItem.json
# 自訂部署設定／DB，選項需在子命令之前：
./node_modules/.bin/bun run db --config Config/Server.toml --db var/test.sqlite import-items DB/exports/FxItem.json
```

必須是明確的 UTF-8 JSON logical export，不接受任意 JSON 或 SQL 指令：

```ts
interface FxItemExport {
  schemaVersion: 2;
  kind: "FxItem";
  rows: Array<{
    SN: number; // unsigned DWORD spelling
    Category: number; // BYTE
    strAttr: string; // may be empty; no fabricated template requirement
    nAttr1: number; // signed32 or equivalent unsigned DWORD spelling
    nAttr2: number;
    nAttr3: number;
    strName: string;
  }>;
}
```

目前每次輸入至多 4 MiB／65535 rows，另外受 string／wire packet 尺寸約束。使用 bound SQL，整批 immediate transaction；重複 SN 或任一無效 row 不能留下半批資料。**不使用 replace/upsert 靜默覆寫既有 item 定義**。

新庫中的 `FxItem` 預設是空的；GS `202` 將送空定義清單。沒有杜撰SN／商品屬性／價格。`FxItem` 定義也**不是** FXSS stock／pricing／package／coupon／transaction data；匯入它不會自動得到商城、裝備邏輯或 billing。

## 原始 SQL Server 備份：尚未還原

`DB/CAConfig.bak`、`CAItem.bak`、`Guild.bak` 與十二份 user／inventory `.bak` 保留原樣；**目前沒有完成 SQL Server restore 或與 SQLite 的資料比對**。

從備份中掃到 ASCII procedure 名稱／SQL 片段不能當成完整 schema，更不能據此保證頁面、table constraints、column order、collation、日期／money 單位與跨庫 procedure 正確。不要把 `.bak` 直接交給 SQLite，也不要執行 `TB031117.DAT`。

完整遷移至少還需要：

1. 在隔離、合適版本的 SQL Server 環境確認備份格式／版本並還原，保存原檔 hash；不要對外連線至舊官方端點。
2. 匯出 DDL、完整 stored procedures、column metadata、必要且經核對的非敏感商品／stock 資料。
3. 核對 `prCAAuthUser`、`prGetUserInfo`、`prLoadInventory`、`prAddInventory`、`prUpdateUserDynamic`、`prSetMoney` 等的實際語意、交易與欄位序。
4. 對價格、現金／bonus、package／cart／gift／coupon、到期／OLE DATE、SID／BID／global serial 分開建模與測試，不用同一個未證實的 number 互代。
5. 設計有明確 transaction id／重放防護與不變量的 SQLite 帳本，再接通購買／billing。現在不應聲稱已有扣款原子性或原商店資料。
6. 帳號／個資應另行受控遷移、脫敏驗證；不要將還原資料、密碼、舊 DB 連線資訊放入公開 log、Git 或對話。

上述是**仍需執行的步驟**，不是這次已還原的操作紀錄。工具並未假裝完成 `.bak`→SQLite 自動轉換。

### Schema6：FxItem原名與安全執行DDL

`006_UserItemCatalog.sql`只rename七欄、不重建／重編碼既有data／四receipt。原始select、v2／v1 mapping、strict批次／audit rollback及GS immutable cache／顯式reload見[UserItemCatalog](UserItemCatalog.md)。CLI不自動reload執行中的GS；空catalog仍合法，需受控重啟或trusted `m_userItemMan.UpdateUserItemTable()`。

Bun1.4.3的multi-statement exec已重現中間ALTER衝突被後續成功掩蓋；`SQLiteScript`先正確識別quote／comment／trigger／CASE邊界，再逐條prepare／run／finalize。所有六份migrations與初始pragmas共用這個executor；錯誤傳回原root IMMEDIATE，避免「半套欄名＋新schema version」。不是執行BAK中的SQL，也不是通用untrusted-SQL parser。schema5→6 late failure／repair retry、舊帳號／inventory／四種receipt原值及真兩程序migration競爭均有測試。

## 原生 owned inventory：本輪沒有新 migration／receipt 格式

`Common/UserInventory.ts`／`FXGS/UserInventory.ts` 已實作原生 read-side row與載入投影，`CUser`／201／105可消費可信 immutable generation；不會自動從這個 SQLite schema 推導它。正式 `LoadInventory`／handoff 仍用 legacy layout；schema6、logical export v2與四類version1 receipts不變。

原生 DateCreated 是已觀測的 raw OLE DATE；不是這個schema的Unix expiry。projection的DeleteAttempts只描述native loader會嘗試的UserID＋ItemSN刪除，完全不執行SQL／不確認刪除。正quantity native row在legacy paid CAS前明確拒絕；同值reload／native mode ABA也會凍結pending plans。native pre-inventory有premium／Exp／Money等副作用，不能以純SELECT取代；Windows calendar轉換、隔離的DB clock adapter、原生paid／flush／collector與native SQL key仍待設計。來源、72 anchors／1768 models與測試界線見[UserInventory](UserInventory.md)。

## 原生持有道具read-side與明確storage邊界

`CUserItemMan.CaptureSnapshot` 提供穩定的 immutable definition generation，`PlanInitUserInventory` 以已觀測raw DATE／signed16 threshold依原順序投影，不碰SQL／host clock。`CUser.InstallUserInventory` 明確附掛immutable native vector，與legacy `m_aInventory`分開；原生mode封住空legacy view，舊array alias不能混入新layout。201／105與飾品讀取同一generation，105另clone simple-info抵抗codec callback混代。

money／house／legacy paid與result的frozen fingerprints涵蓋native mode＋revision，byte-identical reload／ABA也不能重試舊plan；storage callback後再次檢查，若已root COMMIT但native generation改變，保留durable receipt並凍結live publication，不自動rebase／重付。這是現代可信內部防護，不是native paid SQL已完成或任意JS／外部SQL writer的全域原子fence。正式GS inventory loader仍是legacy SQLite bridge，native positive paid明確拒絕；pre-inventory／calendar conversion／native persistence／flush／collector未完成。詳見[UserInventory](UserInventory.md)。

## 原生持有道具／equipment consumers（可信read-side附掛）

request `209` → response `201` 已使用真正channel handler消費兩個native local users；201為DWORD count、ItemSn DWORD、Slot BYTE、Amount DWORD、Verbose、raw8-byte LE DATE，不是StockSn／ItemID或Unix time。105 self BYTE來自首個equipped Category4的nAttr1 low BYTE（無則255），accessory採Category10 positions0..8、Category12 positions0..4及Category14 tail。capture同一native generation＋simple-info，不混codec callback重載前後資料。

這些原生consumers需可信內部`InstallUserInventory`，不是已接native SQL→GS、裝備request／商城或授予endpoint。既有正式handoff仍讀legacy SQLite；正quantity native paid暫時fail-closed，quantity0仍relay。72 PE anchors／1768獨立C++模型、完整wire順序、400-counter／DATE與未完成界線見[UserInventory](UserInventory.md)。

## Native inventory generation也是結果來源，不只比rows JSON

可信原生read-side附掛已加入per-player result fingerprint；shared money／house／legacy paid world fingerprint也包含mode＋revision。同值reload、native→legacy→native或consume後裝回相同rows都要求凍結舊pending，不可因JSON相同而換generation繼續。result storage callback返回後再驗fingerprint／occupants，才准進入counter／native stats／stage／163。

若callback在root COMMIT後換generation，receipt與SQL After不假裝回滾，但live After／成功封包不發布；明確recovery尚未完成。不變的原生generation仍可正常lost-ACK／duplicate結算，也不禁止其他玩家的legacy paid CAS。`UserInventoryLifecycle.test.ts`用真106／discovery／109／150及claims驗這些分支；不是native stock persistence或crash重建證據。詳見[UserInventory](UserInventory.md)。

## Ordinary native carried vote

[VoteLifecycle](VoteLifecycle.md)現讓native private vote從waiting／Loading保留到Running與durable Result。Undurable result conflict、Applying／Returning仍在105／membership mutation／clock／SQL之前拒絕；恢復後原receipt／duration不因投票重建。Durable Result的非financial105／ordinary table removal不改commit payload；普通164清target及modern issued state，**不重設票**。Synthetic `BeginResultLifecycle` hook仍不能提供private native launch token，不能因此開native vote或financial replay。

Waiting mode103只改metadata不代表Mod result可用：[GameTypeTransition](GameTypeTransition.md)仍先拒絕Mod106及已commit ordinary round的網路103，active vote的result conflict亦在mode revision／92／93之前拒絕。原普通receipt／five-field CAS／timing及private native generation不因waiting Mod機能而改變。
