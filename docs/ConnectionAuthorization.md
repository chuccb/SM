# Center非消耗式授權lease與GS讀取／轉服邊界

此處區分三件事：**原生Center CUser狀態核心、現代in-process授權lease、正式GS的legacy SQLite／明示可信native resident庫存**。本輪不新增native procedure成功回覆、商城交易或原版Center TCP。完整server／original-client旗標仍為`false`。

## 本工作樹的實際起點

本輪開始時可見程式為890項tests／17份C++模型的owned-inventory read-side階段。前文曾報告的pre-inventory／calendar／composite初始化新增檔，本輪開始時並不在checkout；它們**不列為這份工作樹已實作／已驗證項目**，也不直接沿用先前1020項數字。以程式、fixtures與本輪重新執行的結果為準。

**後續更新：** 本版已重新推導[PreInventory](PreInventory.md)純觀測投影／CUser讀取端207並將pre generation加入lease source fingerprint；同值reinstall／empty或changed ABA均會失效。這不表示舊缺失檔案已找回，也不表示financial effects／完整Windows calendar／provider與composite已完成。後續[整組讀取端207handoff](InventoryHandoff.md)已接正式GS，並新增下列lease-bound pre DTO API；它不是native SQL／給付完成。

已接線的是**現有legacy GS handler在讀取前先驗證、準備期間持有exclusive lease、成功後才消耗pending**。不是聲稱缺少的native財務流程已恢復或完成。

## 原碼核對：CHECK並不都是純檢查

| 來源VA（Center，另註者除外）       | 已確認角色                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `004153B0`                         | `CheckConnectingToSvr`：free／已connecting／相同server拒絕；type1／10／11與signed index／registered count；target online；premium channel41 |
| `004154F1`                         | premium需Center **DWORD Authencode+56恰好為1**，不是FXGS BYTE+2004，也不是TicketDate                                                        |
| `00415512`／`00415520`             | 此CHECK成功時**已寫connecting=1與GetTickCount**，不能當成純授權預檢                                                                         |
| `00415540`／`00415340`             | 後續`SetConnectingToSvr`才改server type／index、調整connection counters並插connecting list                                                  |
| `00415570`                         | `CheckConnectionEstablished`只檢查free／nonzero connecting／exact type＋index，本身不消耗也不檢查timeout                                    |
| `00415120`                         | `SetConnectionEstablished`只清connecting flag，保留tick／server／auth                                                                       |
| `004155F0`／`00415620`／`00415625` | separate timeout：unsigned DWORD tick subtraction，**嚴格大於0x445C＝17500ms**才SetFree                                                     |
| `004152C0`／`0041531C`             | first SetFree才設flag1與server index`0x80000000`；已free不再次重設                                                                          |
| `004098A2..004098BF`               | native caller逐人CHECK但保留**最後一次result**，以last==1決定Set-all；早期CHECK本身已可能變動                                               |
| FXGS `0040885B..004088AF`          | Center成功response後才reload／SetLevel及native `InitUserInventory`；不是原client request直接執行財務effects                                 |

`Center/NativeConnection.ts`提供**detached純投影**，保留原方法角色：`PlanCheckConnectingToSvr`、`PlanSetConnectingToSvr`、`CheckNativeConnectionEstablished`、`PlanSetConnectionEstablished`、`PlanDeferDisconnectTimeout`。不碰global user、service counters／lists、Windows clock、socket或SQL。`CenterConnectionRule`集中native17500ms／DWORD auth1／server-index sentinel；部署的`RuntimePolicy.SessionTransferTimeoutMs=30000`是**另外的現代政策**，沒有偷改成17500。

獨立manual C++：**3444 cases、36 fixed PE anchors、256個two-user內層迴圈組合**。後者包含15個early CHECK改了第一人但最後失敗、15個最後成功卻非全員成功的分支；不是256個都會出錯，也不是原EXE執行證據。現代實作故意保留whole-group hardening，不照搬這些native危險路徑。

## 現代權限：pending shape不是authority

`Center/ConnectionAuthorization.ts`定義bound identity與opaque `ConnectionAuthorization`。公開handle只有`UserCount`／`Expires`診斷；真正權限保存在**發行的CCenterServer private WeakMap**，不是ID／SN相等或可JSON重建的物件。

- 只有`OnReqConnectToSvr`在source完整authenticated ownership、同source server、未入房、無pending、target online／容量及既有premium政策通過後，才將frozen pending與原users／opaque generations登記為issued。
- pending本身與users array frozen；copy同形pending、手動clear／restore、重掛相同pending、source-server ownership ABA或消耗後放回舊物件，不會重新取得authority。
- `CLocalServer.m_bConnected`保留原名，但offline→online產生新opaque epoch；相同物件／欄位值不是舊service registration。source／target restart都使舊pending無效。
- Native raw field predicate與`Center/CUser`舊local predicate都**不能取代**private issued-pending＋lease檢查。
- 不把相同TCP IP＋32-bit global serial描述為現代密碼學登入或原版協定安全性證明；原bearer-style轉服／同IP限制仍有其威脅模型。

## API與生命週期

`CCenterProcess`只把自己的server固定傳給Center，lease同時綁issuer／server／destination socket／exact group／original pending／deadline。

```text
AuthorizeConnection(socket, identities)
  → 全組驗證成功，取得exclusive、non-consuming lease
CheckConnectionAuthorization(socket, lease)
  → 再驗clock、owner／group／source state
CaptureAuthorizedPreInventory(socket, lease)
  → 同guard持續涵蓋讀取、前後全組再驗，只回傳frozen identity／revision／pre row DTOs
CaptureAuthorizedInventory(socket, lease)
  → 正式GS使用的paired resident DTO：identity／owned模式與epoch／pre epoch／兩vectors／儲存presentation，deep detach／freeze；不查SQL、不選碼頁
ConfirmAuthorizedConnection(socket, lease)
  → 最後全組檢查 → 原子logical consumption／owner切換
ReleaseConnectionAuthorization(socket, lease)
  → 只釋放準備；不消耗／不延長／不取消原pending
```

舊`ConfirmConnection`／`OnConnEstablished`仍存在，內部以authorize→confirm完成one-step操作；**不能偷走別人正在preflight的lease**。known released／invalidated／consumed handle的release是idempotent，fake／foreign handle則拒絕。

同一pending或destination同時只能有一份active preparation；不同群組可獨立準備，不多佔一份capacity。bound identities先整批capture一次，guards在lazy clock／getters前保護同socket及pending，不能靠nested failure誤清外層guard。check／commit／release期間的重入亦拒絕。

## Fence範圍與合法source斷線

lease捕獲每個source user的info reference、connection generation、dynamic／auth／session／slot、inventory generation／values、legacy array＋row refs及native immutable row refs。每次check全組重新驗證；同值native reload、connection ABA、第二人的漂移不能讓第一人先附掛。

**source TCP斷線不等於target失去原pending。** 只要原registered ownership／server generation／deadline仍合法，source可關閉並清attached array；users保留、不SetFree，target仍可完成。source TCP仍live時則必須保有exact group；不能偷偷清掉或替換成另一組。

target關閉會invalidate並釋放exclusive準備，但保留原pending供剩餘TTL內的新target嘗試。expiry維持`expires <= now`，不從lease發行時間重算30秒；closed source過期才terminal free。invalid／backwards／throwing Center clock會**取消全部outstanding pending與leases**，避免clock恢復後舊權限意外延命；live source仍authenticated，closed source會清理。部署maintenance callback隔離失敗、generic log並累計`centerMaintenanceFailures`，不是未處理例外退出或靜默成功。

fence是**現代in-process hardening**，不是任意JS monkeypatch／任意外部SQL writer／跨程序memory的通用transaction。原生DWORD tick profile與部署wall-ms clock／30秒TTL也不可混為一談。

## 正式GS目前如何使用

`FXGS/CConnectPool.OnConnEstablished`保持原request7 body／integrity／initialized語意，但改成：

1. 完整解碼與integrity檢查，**先Authorize**，不先查帳號／庫存或編catalog。
2. 先在同一guard下capture paired resident DTO；每個DB read前後Check lease，處理既有account availability／ban檢查。Native owned（包括empty）略過legacy SQL，只有明示legacy local讀LoadInventory。
3. loaded account／legacy inventory必須重新對上authorized ID，不能把trusted adapter誤回的另一個row授予此user。
4. capture detached account／inventory primitives，另備live mutable copies；之後codec不能修改adapter回傳reference而偷換已編201與待發布值。
5. 捕獲一份catalog generation，預先完成210／conditional202／conditional ALL-local207／conditional201，每個body後再Check；initialized且沒有pre才不編202／201。owned／pre來自paired lease-bound DTO讀取，讀前後整組再驗且getter期間不能nested capture／consume／release；native copied strings依目標codec驗證，不重算expiry／metadata。
6. Confirm lease、整組重綁account values／SetLevel，只有legacy local指定legacy owned；native live pair／dirty／兩epochs／presentation不重裝。source detach／close發生在全組owner切換後；close後與rank後再驗resident狀態，才發prepared packets。
7. `finally`釋放preparation；read／encoding error不消耗pending。重試仍是同期限的transfer；207只發布可信pre清單，不新增native grant或SQL效果。

source transport close exception在logical commit之後，以generic事件報告，不改成可再次消耗。rank／send失敗也**沒有handoff後rollback／exactly-once TCP保證**；已消耗的transfer不能因沒收到包而重播。

## 這不是財務副作用授權或native接線完成

lease只處理Center身份／ownership。不證明SQL current ban／premium／stock／價格，不消費native rows、不實作stored procedures、不提供durable effects idempotency。即使identity合法，**Release後另開lease也不能當成可以重跑已發生money／XP／LoadOn的依據**。

目前已有重新推導的[pre觀測投影](PreInventory.md)與[整組read-side207發布](InventoryHandoff.md)，但沒有把legacy SN／ItemID／Unix expiry換成native ItemSn／StockSn／DATE。後續另有[Calendar](Calendar.md)重新推導的timestamp-copy／CTime嚴格子集與隔離clock，非找回舊缺檔、不自動接GS／financial effects，也不取代此lease registry。正式account與一般owned SQL初始化仍legacy；已明示可信native rows可由[ResidentInventoryHandoff](ResidentInventoryHandoff.md)保留模式轉移，但不是native SQL初始化／freshness；不執行native pre效果、billing或native paid成功。後續[InventoryInitialization](InventoryInitialization.md)已有同catalog／DB clock generation的pre→owned觀測協調與CUser成對清單發布；paired ABA使lease失效，而failed第二份preflight不換epoch、原lease可正常single-use。它不是給付權限，也不是找回舊缺檔或native SQL整合。後續還需native provider／SQL／完整Windows calendar證據、真正SQL／financial初始化candidate到live user的rebind、不可逆effects的durable replay／recovery策略與原版client測試；現有resident轉移不取代這些邊界。

## 驗證與重建

- `ConnectionAuthorization.test.ts`23項：non-consuming／single-use、issuer／server／socket／forgery、exclusive／reentry／private issued registry、expiry／legitimate source close／service ABA、source values／row identity／generation、clock、whole-group與post-commit close。
- `ConnectionAuthorizationLifecycle.test.ts`16項：actual GS auth-before-read、read／encoding retry、bad account／wrong loaded owner、callback expiry／reentry／source drift／whole-group encoding、adapter reference capture、legitimate disconnect、initialized、post-commit failure、maintenance隔離與**真LS→GS TCP** bad guild零DB reads後新TCP合法完成。
- `NativeCenterConnection.test.ts`9項：3444／256模型、PE anchors、native17500與部署30000分離、exact DWORD auth／byte區別、strict unsigned wrap／one-shot free、getter capture／invalid-input hardening、native predicate不是authority。
- 三個舊TS `CConnectPool` regressions已先在舊handler重現**0 pass／3 fail**：未驗證先read、preflight重入可搶handoff、codec能改adapter rows造成live／201不符；新handler **3 pass／0 fail**。不是原EXE執行測試。

```sh
./node_modules/.bin/bun run vectors:center-connection  # optional g++；只跑我們的C++
./node_modules/.bin/bun test tests/ConnectionAuthorization.test.ts tests/ConnectionAuthorizationLifecycle.test.ts tests/NativeCenterConnection.test.ts
./node_modules/.bin/bun run verify
```

metadata／數值與全套結果見[Coverage](Coverage.md)；既有庫存邊界見[UserInventory](UserInventory.md)，storage／receipts仍見[Database](Database.md)。
