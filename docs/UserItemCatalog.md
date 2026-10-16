# CUserItemMan／FxItem 定義目錄、202與轉服前置檢查

## 本輪範圍與仍未完成的部分

此處是 **UserItem 商品定義**，不是 ShopItem stock／價格／cart／billing，也不是 game resource `CItemAttr.Type`。已依所附FXGS原碼補齊原始欄名、unsigned-key map、明確reload、202與GS轉服的202／201 preflight。這是後續native inventory載入所需的前置依賴，**不宣稱完整庫存映射已接通**。

`completeOfficialRewrite`／`officialClientVerified`仍為false；未執行供給EXE／DAT，未連舊官方／billing服務。C++是我們人工模型，不是原程式execution oracle。

## 已核對的來源與命名修正

| 來源                                | VA／offset           | 實際證據                                                                                            |
| ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `CUserItemMan::UpdateUserItemTable` | `0040F9FA`           | `FxItem`，select **`SN , Category , strAttr , nAttr1, nAttr2 , nAttr3, strName`**；字串在`0048C9B8` |
| `CRSUserItem::OnReceiveRow`         | `00411EE1`           | DWORD、BYTE、string、三DWORD、string；44-byte UserItem中offset0／4／8／20／24／28／32               |
| map裝入                             | `0040FA62..0040FAB5` | SQL open成功才clear；unsigned RB-tree `insert_unique`，重複key保留第一筆                            |
| `CUserItemMan::GetUserItem`         | `0040F0EB`           | int參數的bits當unsigned key查找，不是SQL rowid／StockSn／name fallback                              |
| `CUserItemMan::PutUserItemList`     | `0040EFEE`           | WORD count，依unsigned key升序逐筆輸出七欄                                                          |
| 原始欄位橋接到resident inventory    | `0040B0BA..0040B18C` | 由ItemSn查UserItem；Category／strAttr／三nAttr複製到resident row；Type5／6有不同consumer            |

舊移植的欄名是現代猜測，現已改正：

| 舊欄名／v1 export | 原始欄名／v2 export | 已知／未知意義                                                              |
| ----------------- | ------------------- | --------------------------------------------------------------------------- |
| `ItemID`          | `SN`                | 定義key；wire為DWORD bits，map按unsigned排序                                |
| `Type`            | `Category`          | 商品category BYTE，**不是CItemAttr resource Type**                          |
| `TmplName`        | `strAttr`           | 原名就是strAttr；不能一律說成非空template name或resource index              |
| `OpaqueColumn3`   | `nAttr1`            | category-dependent DWORD；已知Category6載入到CUser fake-level，不是通用價格 |
| `OpaqueColumn4`   | `nAttr2`            | 原名已核對，完整category語意未還原，不猜成價格／時效                        |
| `OpaqueColumn5`   | `nAttr3`            | 同上；不能只因數值像某index就配對另一個namespace                            |
| `Verbose`         | `strName`           | 定義名稱字串，**不是inventory row的Verbose**                                |

`SN`以0..UINT32_MAX表示；`GetUserItem(-1)`等原生signed-int參數保留bits後查UINT32 key。三nAttr接受合法signed／unsigned DWORD spelling並在記憶體正規化為signed32，202仍輸出完全相同bits，不夾限為0、不套用任何價格／bonus計算。

## Schema6與明確匯入契約

`006_UserItemCatalog.sql`只做七個column renames：不drop／recreate／copy帳號、inventory、動態資料或四類gameplay receipts；原SQL欄位值連unsigned spelling也保留。schema5→6失敗會整個rollback，舊binary不支援自動降版，升級前應做一致SQLite備份。

新logical export版本2使用原名；**export版本不是DB schema版本**：

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

```sh
./node_modules/.bin/bun run db import-items DB/exports/FxItem.json
```

版本1仍由 **`UpgradeLegacyUserItem` 明確adapter**處理上述舊別名，不靜默猜column order；混用v1／v2 row keys、缺欄、多餘StockSn／price等欄、duplicate SN或無效row會拒絕。舊v1的TmplName仍保留1..255 encoded-byte限制；v2的strAttr可空。現代限制集中於 `RuntimePolicy`：4MiB輸入、65535 definitions、strAttr／strName各4096 encoded bytes，另受實際202 packet尺寸限制。不是聲稱原SQL varchar長度就是4096。

使用configured codepage做可逆編碼驗證，拒絕NUL及不可表示字元，不用replacement `?`掩蓋資料錯誤。整批native-named bound INSERT和audit同一root IMMEDIATE transaction；既有SN、末筆錯誤或audit失敗全部rollback，不用upsert覆蓋。

**沒有附帶杜撰商品清單或價格。** 空catalog仍是合法空202。離線CLI匯入不會更新已在執行的GS snapshot，應受控重啟；不提供猜測的client refresh／GM HTTP API。

## CUserItemMan：不可變目錄generation

每個GS持有 `m_userItemMan`。constructor明確執行 `UpdateUserItemTable`，`GetUserItem`／`PutUserItemList`只讀同一已完成generation，不在202中途重新查SQL。

- 全部rows先detach、驗證、複製、排序，完成才一起換map／ordered rows／revision。
- SQL錯誤、末筆錯誤、duplicate、count overflow、重入或revision耗盡都保留舊generation；不把讀取失敗偽裝成空catalog。
- 與native `insert_unique` 的first-wins及open後clear不同，現代移植明示採**全批拒絕／保留舊snapshot**。
- 不允許在外層SQL transaction／savepoint內reload；callbacks若晚開transaction，亦在安裝前再拒絕，避免把未COMMIT的定義發布為新generation。
- rows及只含Count／Revision的診斷是frozen／detached；回傳值或transport Buffer污染不改cache。
- 202 serializer捕捉一個generation，以caller的cipher／codepage先建完整temporary body，再一次append。中途callback即使成功reload，該202仍為原generation；錯誤不留下半count／半row／被覆寫的caller prefix。

Bun單event-loop snapshot替代native CRWLock／RB-tree，不宣稱Win32 locks／workers已移植。任意受信任JS／DB writer也不在通用原子fence保證內。

## 202 wire與GS轉服：先建構，再消耗single-use token

202 body在opcode後依序是：

```text
u16 count
for each definition, ascending unsigned SN:
  u32 SN
  u8 Category
  str strAttr
  u32 nAttr1, nAttr2, nAttr3
  str strName
```

維持既有scalar XOR＋BE、字串長度scalar-coded但內容為raw codepage。native只讀WORD count，超65535會截斷但仍遍歷map；移植在界線前明確拒絕，不能送謊稱的count。

舊 `CConnectPool` 在讀完帳號／inventory後就 `ConfirmConnection`：即使第二名local的201編碼失敗，已消耗兩人的pending token、關閉LS、加入GS／rank並可能先送210／202。

現在順序為：完整request／account／inventory讀取 → detached210與所需202／201完全編碼 → Center驗整組及single-use handoff → 載入live users／rank →210／202／201 →既有room-list。

- catalog過大、201第二user不可編碼、字串或whole packet超限時，兩名locals都保留原LS owner／原pending token，GS沒有半attached group、rank或成功封包。
- 修正資料／trusted reload後可用**相同尚未消耗的transfer**重新連GS；沒有另造成功opcode。
- request的already-initialized旗標若為0，native本來就不送202／201；不為未發送的body新增encoding gate，但既有現代inventory讀取仍在handoff之前。
- 成功準備不是授權；guild／serial／group／IP／token／expiry仍由Center原有整組檢查。
- 這是**可預期編碼失敗的preflight**，不是handshake傳輸後的退款／重播／rollback：handoff後send失敗仍不復活single-use token，也不宣稱rank／room-list callback有通用transaction fence。

本機以修改前的CConnectPool重現兩種失敗：catalog只送210後消耗token；第二inventory送210／202後消耗token。現行相同輸入都在handoff前拒絕；另有真LS／GS TCP雙人、故障GS斷線、source仍持pending、修正snapshot後新TCP重用同token的測試。

## 遷移執行器修正：不讓中段DDL錯誤被掩蓋

固定Bun1.4.3／SQLite3.53.4上已重現：`db.exec('ALTER成功;ALTER欄名衝突;ALTER成功;PRAGMA user_version=6')` 可能未throw而繼續執行，留下「部分欄名＋新version」。不是把這種狀態當migration成功。

`Common/DB/SQLiteScript.ts`現在辨識quote／escaped quote／identifier／line與block comments、普通 `CREATE [TEMP|TEMPORARY] TRIGGER BEGIN..END`及nested CASE，先拆成完整statements，**逐條prepare／run／finalize**；任一錯誤傳回CDBSession的root IMMEDIATE，全部DDL／version rollback。不是直接`split(';')`拆壞trigger，也不是完整通用SQL parser／不受信任SQL的安全邊界。

所有六份repo migrations及初始化pragmas都使用此executor。原BAK中掃出的procedure片段**不會被傳入或執行**。測試另驗late006 conflict／reopen／修復重試／真正兩Bun程序競爭升級，並保留四類receipt BLOB與全部舊帳號／inventory值。

## Native inventory載入的新查明事項：尚未接到舊storage bridge

後續已將下列 signed16／strict DATE／400-counter 與 equipment 的**讀取端 kernel**、CUser原生 generation、201／105／飾品接到實際 consumers；72 PE anchors／1768 C++ cases 見 [UserInventory](UserInventory.md)。不是完成 native SQL loader；本節的 schema6 與 legacy owned-storage／receipt 界線仍保持。

`CDBMan::InitUserInventory 0040AF55`的真正前置還包括 `InitPreInventory`；之後select `ItemSn,Slot,Amount,DateCreated,LevelCreated,StockSn,Verbose`。這不是直接把現代 `_USERINVENTORY.SN`自增key換個名字即可完成。

- `CRSUserInventory::OnReceiveRow 00411FFF`：ItemSn→resident+0，StockSn→+4，Slot→+36，Amount→+40，Verbose→+44，CTime→+56，LevelCreated→+76；dirty→+80另由loader設0。
- `0040B0BA`用**ItemSn**查定義map。resident首DWORD及201／146的SN因此是catalog-domain ItemSn，而非現代storage自增SN，也不是+4的StockSn。
- `0040B0D5`用 **signed16** 讀LevelCreated，若cached CUser level **≥ threshold**就進刪除路徑；欄名不能直接推論成「純記錄建立時等級」。目前沒有把現代CreatedAt／Level誤填成此threshold。
- `0040B0EA..0040B11D`即使level已失效仍採current CTime，再比較raw VariantTime；**current > stored才expired，等於仍保留**。不是現代bridge `ExpireDate > now`的相同邊界，也沒有由此證明DATE0為永久。
- `0040B15F..0040B18C`：Category5且Slot≠255啟用level-icon並使用definition SN；Category6且Slot≠255將nAttr1寫fake-level。現代legacy ItemID即使剛好對上catalog SN，**仍不因此假造equipped state**。
- `0040B09D`的400不是簡單 `SELECT LIMIT400`：missing definition與成功resident各遞增counter，expired/deleted路徑跳回GetNextRow而**不遞增**。native rowset順序、刪除／pre-inventory副作用及永久值仍須處理。

只讀掃描BAK的SQL文字片段提供 `getdate()+ValidityPeriod` 與UserID＋ItemSN key的進一步線索，但不同副本有字元／內容差異，**未完成SQL Server restore／完整module重組／約束／collation核對**，不據此執行或拼成新的stored procedure。

後續仍需native ItemSn／StockSn／UserID key持久化、pre-inventory、Windows日期／DB clock adapter、validity-level／裝備的SQL載入與flush／collector的完整storage設計；既有special-item receipt仍以明示現代full-metadata CAS工作，不在schema6暗中重解舊收據。

## 驗證與重建

- `tests/reference/user-item-catalog.cpp`：獨立人工map／scalar／string模型；25 PE anchors＋select字串，1542 catalog images、8 key probes與5 count probes。涵蓋全部256 Category、signed／unsigned DWORD edges、空／Big5／CP949／UTF8 strings、unsigned順序與native first-wins／modern refusal差異。
- `UserItemCatalog.test.ts`：17項，所有images消費、snapshot／SQL／重入／buffer／transaction／revision邊界、v1／v2 CLI與rollback、schema5→6四receipt保留／lateDDL／兩程序競爭。
- `ConnectionInventory.test.ts`：8項，整組202／201 preflight、初始化flag與無假equipment、錯guild仍拒絕、reload callback generation、真TCP失敗／修復／同token重連。
- `SQLiteScript.test.ts`：7項，script lexical邊界、trigger／CASE、未完成構造拒絕、中間DDL root rollback與全部真migrations。

```sh
./node_modules/.bin/bun run vectors:user-item-catalog
./node_modules/.bin/bun test tests/UserItemCatalog.test.ts tests/ConnectionInventory.test.ts tests/SQLiteScript.test.ts
./node_modules/.bin/bun run verify
```

最新全套、重複測試、原始98檔完整性與證據界線見 [Coverage](Coverage.md)。
