# 投票踢人104／105：普通等待房接線與連鎖離房

## 現在可用的範圍

**普通 Normal、非 Guild／Mod／BangPok／practice 的等待房已接通104／105。** 不需要GS UDP／private launch token。真正room／table使用前輪已驗證的native policy，發113／114、執行TRUE whole-socket removal／pool4，普通離房及真TCP disconnect會在native位置重新計票，也能同步踢出另一整組。waiting-chief仍排程active vote，不會靠停止timer避開連鎖問題。

Playing／特殊模式仍拒絕；目前**投票中不接受加入、106開局或103轉Mod**。Native沒有同樣的統一限制，這是明確的現代availability／移植scope差異，不宣稱已完成所有native transitions。沒有新增vote TTL、每socket weighting、SQL角色、給付或自動Lobby成功；completion／original-client flags仍false。

前輪 `FXGS/BanPlayer.ts`、`CaptureBanPlayerObservation`／四個 `Prepare*`仍是純讀取端；`MakeBanPlayerPacket`仍只產生候選body。**Returned DTO／數字SocketKey／public target-vote fields都不能安裝active vote或授權table執行**。Live command有獨立JS-private issued state與constructor-bound opaque table issuer；它們不是財務／SQL replay權限。

SQLite schema6、四種v1 receipts、export v2、legacy owned-pre schema、GS conditional207／201與既有financial freeze維持不變。

## 來源與欄位

供給 `FXGS/FxServer.exe.c`／`.lst`／PE只讀：

| 原生函式／欄位                     | VA／offset                 | 已核對的意義                                                         |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `CListSession::OnHostAskBanPlayer` | `00424A3B`                 | chief request104、functional item分支、初始化、初次計票／113／114    |
| `OnRespondToBanPlayer`             | `00423C70`                 | 105、逐SELF寫入、遇非pending early return                            |
| `DeferBanPlayer`                   | `00424F78`                 | 逐PLAYER分母／多數／failed／missing target                           |
| vote array                         | session `+780`             | 每slot一個DWORD；不是每socket一票                                    |
| target                             | session `+828`             | target **GlobalSerialNo**，不是slot／room serial／ready count        |
| chief slot                         | session `+864`             | 可為同socket的secondary local                                        |
| `CClientSocket::HasAuthority`      | `00406C66`                 | PE `33c0c20400`，忽略this與ANY參數固定0                              |
| `CUser::HasAuthority`              | `0041688A`                 | 另外獨立核對的同樣zero stub，不能由它推斷前一函式                    |
| ordinary `DestroyPlayer`           | `0041BA8D`／`0041BBB2..BE` | 刪除／sync／chief／pool1／flush／清slotidx後，active vote再同步Defer |
| real game vtable+144               | `0048F69C`                 | 指向`00424F78`，不是猜測的額外game override                          |

這個build不能從SQLite `Authority21`杜撰socket immediate權限；22／23／25也不是補出的豁免。已新增真正 `CClientSocket.HasAuthority` zero-stub方法，但沒有因此開啟其他role／handler。

## 104：先驗chief、先busy、再讀request

1. 要求目前chief的socket；busy target非0時，**尚未讀request字段**便只向chief送114／1。
2. 才讀target DWORD與immediate BYTE；chief自己的**任何local**序號都是拒絕，不只primary。
3. occupied非target先設1、target／vacant設0；找不到target時target歸0、**不發113或114、不查functional items**。這不同於deferred missing target的114／4。
4. immediate **任意非0**且chief socket任一local有Category2／exact `Item/SuperChief`，先清target、描述整組target `DestroyPlayer(TRUE)`／pool4，再room114／4。此路徑**先於並略過BanReflex**，也先於target-secondary排除及chief auto-Yes。
5. 否則target socket任一local有Category2／exact `Item/BanReflex`：清target，描述整組chief `DestroyPlayer(TRUE)`／pool4，再room114／5＋**當前chief local名字**。
6. 普通投票：全部target locals設0、全部chief locals設2；存target serial後**先Defer**。若已立即判定，只發該結果，不再113／started0。
7. 仍pending時，113帶target DWORD＋target local名字；排除整個target／chief socket。native只記**最後一個eligible socket**，不是global Set：交錯slots可出現A、B、A重複發送。最後只向chief114／0。

functional query沿用已保留native owned vectors及其碼頁：只查Category2／exact encoded bytes，**不查Amount／Slot／expiry、不消耗、不重解目前catalog、不把legacy SN／ItemID／Verbose或pre rows轉成權利**。它不是native SQL freshness／grant證明。

## 105與deferred tally

105沒有active target時不讀serial；wrong serial不讀answer。matching後，BYTE非0→Yes2、0→No3，按socket **SELF順序**逐local處理。每個local必須仍為pending1；遇第一個非1即return且**不Defer**，已修改的prefix保留。移植沒有把它偷偷改成all-local atomic答票。

Defer只計occupied且vote非0的locals；2是Yes、3是No，1及其他未知非0值只進分母。vacant slot的vote垃圾不進分母：

- target不存在：target0，room114／4，不附名字。
- `2*Yes > Total`：嚴格多數，target0、整組target移除intent／pool4、room114／2＋target名字。
- 否則 `2*No >= Total` **或** `Yes+No >= Total`：target0、room114／3＋target名字，不移除。
- 否則pending。這三個原生body未見vote deadline；**沒有自創TTL／每socket weighting／額外success ACK**。

| response | body（opcode之後）                   | 意義                                       |
| -------- | ------------------------------------ | ------------------------------------------ |
| 113      | DWORD target serial、str target name | 提問                                       |
| 114／0   | BYTE0                                | started，chief only                        |
| 114／1   | BYTE1                                | busy，chief only                           |
| 114／2   | BYTE2、str target name               | 通過                                       |
| 114／3   | BYTE3、str target name               | 失敗                                       |
| 114／4   | BYTE4                                | missing **或** immediate success，沒有name |
| 114／5   | BYTE5、str chief name                | BanReflex                                  |

body沿原scalar encoding與str byte長度，預設CRC8 degree；不是完整TCP framing／stream／CRC的另一個oracle。Big5中文及plain／scalar已逐case比較，UTF8只作明示選項。body／碼頁／長度錯誤在候選內拒絕，不向live socket發半包。

## 普通等待房的同步cascade與native時計

ordinary離房不只刪自己的票。Native刪除整個socket、交接chief／reset helper之後，再重新計票；分母縮小可能**同步移除另一整組socket**。若該target恰為新chief，會在outer `DeferBanChief`最後setter之前再有一次 **CBanChief.Init**。

新增 `PlanBanPlayerCascade`只在detached helper上組合native departure／tally及零／一／兩次Init，保留原capture的socket labels。Live table在清ID前，先完成所有policy、result名字／碼頁、ghost validation與distinct時計preflight：

- 普通chief departure：Init的`SetOdd(false)`不讀clock，`SetCanStart(false)`讀一次。
- 若deferred ejection再移除繼任chief，再獨立Init一次。
- waiting ready121／2：ENTRY → IsBanChief自己的sample → first Init → conditional second Init → **最終SetCanStart(false)**自己的sample。
- waiting odd121／3：ENTRY → first Init → conditional second Init；最後`SetOdd(false)`**不再讀clock**。

所有fallible clocks／name codecs在首個roster consumption或121之前完成；clock錯誤不半清ID、不中途安裝helper或發121。這保留native的sample**順序與角色**，但現代預備把讀取提前，仍不是native callback timing／Windows API oracle。

Root與nested removal各有private table scope，nested退出恢復**原先的removing bool**與batch ownership。Root106／sync／107 → deferred nested106／sync／107 →114的per-recipient順序保留，body和收件者在enqueue時detach；被後續踢出的target仍可能先收到outer departure的106，自己的雙local reset則只收到**最後一個106**。這不是保證收到、client ACK或exactly-once TCP。

現代publication在整條狀態完成後才flush，callbacks看final state；121仍先送給舊chief，post121 whole-owner fence通過才允許消耗。完整final helper在121前先發布、移除中按已預備Init snapshots安裝，並在root flush前恢復final setter state。Transport錯誤只計數／不重播，不假裝外部drift或已完成移除能rollback。Nested table不提早清modified flags或發中途86；root再發當前86／87。

`After`仍特指policy在table destruction前的票／target，不是最終roster。Pure Eject是資料intent、其recipients是假設成功移除的候選；只有Live dispatcher與目前table issuer的stack-bound entry能實際執行。

## Issuance／不開放的範圍

JS-private live state綁target、exact votes與actual player refs；讀取端DTO複製到public fields、同值field drift或reflecting modern flags都不會產生issued state。Critical publish／eject methods也是JS-private。Table issuer identity不從封包／plan回傳；沒有service／room generation不開104／105。每次ejection一用即消耗、返回即退役，retained callback不能在日後踢另一人。Actual native owned-pre refs／epochs與Center opaque generation亦在最後table service前再驗，晚期drift不回覆假成功。

Opaque issuer是現代行程內的constructor-bound信任邊界，不是對任意惡意in-process JavaScript的sandbox。既有unbound trusted kernel fixtures只在**沒有active／issued vote**時沿原table adapter，不因此得到vote權限。

Private active vote的ordinary departure已開通，包括closed socket在Center／rank／global detach前的清理；undurable result／money／house／paid freeze仍先拒絕membership mutation。**沒有新增offline financial settlement／restart repair或provider freshness**。Active waiting vote無法合法進入Playing／financial round；相關freeze測試明示scope fixture，不冒充實際financial-pending TCP。

## 現代觀測防護與驗證界線

先primitive-capture／freeze八個actor、票、serial／name／socket-local labels，再查item或codec；duplicate serial、非法DWORD、缺失local／self gaps屬現代structural拒絕，不是原生corruption／UB模擬。

真 `CListSession.Prepare*`另檢查dense1..2 locals、actual stored-slot／room tuple／nonfree owner、全組actor／socket array identity、native owned-pre refs與兩epochs、Info／legacy-mode refs、actual Center opaque connection generation、room index／serial及phase／strategy context、transport pool／connected狀態和**整份votes**。同步guard拒絕nested preparation，throw後退役；同bytes reload、Center同值pending ABA及票陣列單獨drift皆拒絕。這些是當下觀測一致性fences，**不是table execution lease、native financial freshness或對任意JS／外部SQL的全域隔離**；故意注入的外部變動不假裝rollback。

第**25份**獨立手譯C++模型，builder先核對**68個固定PE anchors**，再只編譯／執行我們的程式；不import TS policy／user／codec。**2,625 cases／5,193,241-byte fixture**涵蓋全部≤7投票者的Yes／No／pending／unknown分布、missing target、1／2 locals、secondary chief／target、interleaved SELF、三種immediate／answer bytes、item查詢順序、prefix early-return、113重複recipient、ordinary離房重新計票／double Init觀測及113／114 exact plain／scalar bodies。

```sh
./node_modules/.bin/bun run vectors:ban-player
./node_modules/.bin/bun test tests/BanPlayer.test.ts tests/BanPlayerPreparation.test.ts
```

新增**41 tests／32,405 assertions**：18個pure／packet／PE units與23個真正room read-side／fence／status案例。80／81／96由既有正式handlers建立；active vote狀態在少數觀測案例是**顯式可信fixture**，不是網路vote已接通。native item rows亦是可信讀取端fixture，不是SQL初始化。這是前輪讀取端的驗證範圍；後續新增的live／TCP證據見下一節。

C++是我們的人工reference，不是執行官方EXE／Windows API／原client oracle；測試peer共用codec，也不是相容性證明。完整驗證／controls／fresh-export結果見[Coverage](Coverage.md)。後續仍須完成Playing／特殊模式、active-vote join／launch／mode transitions、durable restoration與完整server其餘缺口。

## Live／cascade新增驗證

第**26份**人工C++ composition model：**25固定PE anchors／1792 cases／1397971-byte fixture**，比對remaining roster／votes／chief、missing／pass／fail／pending、原socket labels、reset對象與分開時計／unsigned rollover、helper所有DWORD角色。Observed states含network不一定可達的ballot組合，不把模型當網路可達性或原EXE證明；原25份fixtures不改。

```sh
./node_modules/.bin/bun run vectors:ban-player-cascade
./node_modules/.bin/bun test tests/BanPlayerCascade.test.ts tests/BanPlayerLifecycle.test.ts tests/BanPlayerIntegration.test.ts
```

新增**35 tests**：5 pure composition／clock、28 live lifecycle／ownership與fault、2真正LS→GS TCP。合法104／105／ordinary table departure建立two-stage succession，**沒有直接注入active votes／Running／ready bits**，驗證new chief再被踢及native121兩分支的double Init／final setter。另驗codec／last-clock fault、private issuance、服務retention／重用、late epoch／Center ABA、coherent ghost-image drift、raw outer bool、publication重入／transport失敗與no financial mutation。

真TCP第一例由105的同socket209作順序barrier，不以sleep猜測；pending vote中真正關閉另一條TCP，驗證同步踢target雙local、outer106先於target-own last106／survivor114／2，closed peer確實釋放Center／rank／global，而target保留TCP／pool4、209且沒有195／15、SQL changes或四類receipt。第二例target secondary帶**顯式可信native BanReflex row**，真正104使chief雙local離房、107交接／114／5、pool4與209不變；該row不是native SQL／client grant。

測試peer仍共用codec；沒有原client、原binary oracle、完整可玩整場或金融restart證據。最新full／controls／fresh proof見[Coverage](Coverage.md)。
