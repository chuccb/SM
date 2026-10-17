# 投票踢人104／105：唯讀規則與113／114封包準備

## 現在可用的範圍

**目前未放行104／105網路入口，也未接通live vote／departure cascade。** `CGameSession.OnPacket`仍fail-closed；準備出的DTO沒有Apply／Commit／Retry執行API、socket pointer、callback、lease或financial權限。`CServerApp.unported`明列此限制，completion／original-client flags仍false。

已新增 `FXGS/BanPlayer.ts` 的immutable純規則，以及真正 `CListSession` 的 `CaptureBanPlayerObservation`／四個 `Prepare*`讀取端。可準備host、respond、deferred tally與ordinary整組離房後的重新計票；`MakeBanPlayerPacket`只建立113／114 scalar body，不傳送。**不把準備成功當作native vote已安裝、已移除玩家或client已收到回覆。**

沒有改SQLite schema6、四種v1 receipts、export v2、legacy owned-pre schema、GS conditional207／201、現有waiting-chief／removal／financial guards或任何給付。沒有新增道具、SQL角色、期限／timeout、財務重放或自動Lobby成功。

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

## 為何還不能放行live104／105

ordinary離房不只刪除自己的票。native刪除整個socket、交接chief／reset helper之後，再重新計票；分母縮小可能**同步移除另一整組socket**。若新chief恰在該組，會在outer `DeferBanChief`最後setter之前出現**兩次不同的CBanChief.Init**。不能只預備一次reset、提前sample最終clock，或保留現有pending-vote removal拒絕卻開啟新vote——否則真斷線會留下無法清理的房間。

`PlanBanPlayerAfterDeparture`只做ordinary first-occupied chief預測、移除observed actors／votes後的計票及可歸因的Init**次數觀測**，不執行clock／ghost／sync／strategy／pool／ID／table mutation。Guild／Mod／BangPok／practice succession不由此宣稱完成。現有live removal、launch與waiting eligibility對pending vote的拒絕保留。

現有TS packet batching雖有nested depth，removal boolean／table generation／group ownership與one-shot callback仍須真正支援nested cascade。`After`特指**policy在table destruction前**的票／target，不是移除後roster；Eject是資料intent、其後收件者是**假設整組成功移除**的候選，不代表table一定成功或fault可rollback。數字SocketKey只在本次capture內標示identity，**不得在未來房間重新解析成移除權限**。

## 現代觀測防護與驗證界線

先primitive-capture／freeze八個actor、票、serial／name／socket-local labels，再查item或codec；duplicate serial、非法DWORD、缺失local／self gaps屬現代structural拒絕，不是原生corruption／UB模擬。

真 `CListSession.Prepare*`另檢查dense1..2 locals、actual stored-slot／room tuple／nonfree owner、全組actor／socket array identity、native owned-pre refs與兩epochs、Info／legacy-mode refs、actual Center opaque connection generation、room index／serial及phase／strategy context、transport pool／connected狀態和**整份votes**。同步guard拒絕nested preparation，throw後退役；同bytes reload、Center同值pending ABA及票陣列單獨drift皆拒絕。這些是當下觀測一致性fences，**不是table execution lease、native financial freshness或對任意JS／外部SQL的全域隔離**；故意注入的外部變動不假裝rollback。

第**25份**獨立手譯C++模型，builder先核對**68個固定PE anchors**，再只編譯／執行我們的程式；不import TS policy／user／codec。**2,625 cases／5,193,241-byte fixture**涵蓋全部≤7投票者的Yes／No／pending／unknown分布、missing target、1／2 locals、secondary chief／target、interleaved SELF、三種immediate／answer bytes、item查詢順序、prefix early-return、113重複recipient、ordinary離房重新計票／double Init觀測及113／114 exact plain／scalar bodies。

```sh
./node_modules/.bin/bun run vectors:ban-player
./node_modules/.bin/bun test tests/BanPlayer.test.ts tests/BanPlayerPreparation.test.ts
```

新增**41 tests／32,405 assertions**：18個pure／packet／PE units與23個真正room read-side／fence／status案例。80／81／96由既有正式handlers建立；active vote狀態在少數觀測案例是**顯式可信fixture**，不是網路vote已接通。native item rows亦是可信讀取端fixture，不是SQL初始化。新案例沒有增加TCP投票成功證據；既有真TCP／UDP與未加速waiting timer另由全套回歸保留，不借用為live vote證明。

C++是我們的人工reference，不是執行官方EXE／Windows API／原client oracle；測試peer共用codec，也不是相容性證明。完整驗證／controls／fresh-export結果見[Coverage](Coverage.md)。後續仍須完成nested removal、distinct clock timing、callback revocation、financial pending／disconnect／ownership fences、真104／105 TCP cascade，以及完整server其餘缺口。
