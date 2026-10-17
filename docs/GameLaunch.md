# FXGS 一般開局、Loading 恢復與連續兩輪

## 實作範圍

已接通所附 FXGS build 的一般 Normal 房間：**106 → 115／116／選用173 → TCP109 與 UDP discovery → 150 → 既有 Running／SQLite163／延遲164 → 下一輪**。不再靠測試專用的 `BeginResultLifecycle()` 才能從網路建立 round。

這**不是完整遊戲或原版 client 相容證明**：剩餘角色／其他道具事件、practice／Mod／Guild／BangPok／特殊模式waiting-chief 自動恢復、crash 後房間重建等仍缺。151／152→166／167已另接真native Running，並未擅加死亡／map限制；見[Ghost](Ghost.md)。`173` 本身只設定飛機道具機率；`156／171`另已接排程／box-item state重設，仍不是完整飛機／道具引擎，見[Airplane](Airplane.md)。144／145拾取與149原始CP949公告已另接線，Type99 money耐久協調見[MoneyPickup](MoneyPickup.md)；153未猜成throw，來源見[ItemPickup](ItemPickup.md)；載入 mission metadata 不表示任務引擎已完成。Bula160／177、155／170與case8亦已接；DeferResurrection已核對為C3空操作，原client復活玩法不能憑名稱推論，見[GameClaims](GameClaims.md)。`completeOfficialRewrite`、`officialClientVerified` 仍為 false。

Production 只在 `FXGS.UDPEnabled = true` 時供給開局所需的 discovery／資源／durable-result service；預設 false 時106仍先拒絕，不發成功115／116。這是**現代部署界線**，不是原版的 feature switch。即使開啟，也只應在隔離環境測試，不應作可玩的公網服務。

## 來源與集中常數

以下 VA 指向儲存庫所附 `FXGS/FxServer.exe.c`／`.lst`／PE；原 `.exe`、`.DAT` 沒有執行。

| 來源                             | VA                     | 已核對內容                                                                            |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `OnRequestStartGame`             | `00420F19`             | chief-only；先選 playing map，再 `CanStartGame(0)`；115回覆；成功後才 remap／launch   |
| `LaunchGameStage`                | `00420BB3`             | 116、calculator／隊伍、context／shop／player／ghost、mission／airplane、masks等初始化 |
| normal `LaunchGameStageEx`       | `004209B9`             | 實際為 ret，不杜撰 extension                                                          |
| `SendAirplaneItemProb`           | `004204EB`             | 173、兩組 item weights、mission type1 選 alternate；ordinary `IsLadderGame` 固定0     |
| iteminfo讀檔（同一函式內）       | `004204EB`             | 讀兩組 count／name／weight；未知 item lookup 的−1以 byte FF 寫出                      |
| `DoStartGame`                    | `0041BDCF`             | sync／clock／Running／150／sequence／rebirth／vacant peer clear／CBanChief            |
| TCP `OnReadyForImmediateStart`   | `0041D431`             | 109的 selected-map CRC及各 local actual-bomber／屬性                                  |
| `IsAllPlayerReadyForStart`       | `0041AFFE`             | 至少一人；每 occupied slot 都要 peer flag及 status08（mask1C）                        |
| `OnUDPPeerInfo`                  | `0041CE45`             | 同 socket 各 local 保存相同三組 candidate；120後嘗試 start                            |
| Loading `Update` tail            | `0041DF66..0041E0C0`   | join-relative strict25s／mid-loop 非playing30s；table removal後195／pool4             |
| `DoSelectColor`／`SelectBomber`  | `00423B69`／`00423B7A` | playing 不改 stored color；bomber整個 request被忽略                                   |
| `OnSelectMap`／`OnOpenCloseSlot` | `0041C47D`／`004241E6` | playing 的 map只echo原waiting selection，slot request整包忽略                         |

`Common/OfficialValues.ts` 集中 `GameLaunchRule`、`GameMapSelection`、`AirplaneItemRule`／`AirplaneRequestRule`、`SessionNegotiation` 與既有 slot／calculator layouts；`FXGS/MissionInfo.ts` 保存四個 signed DWORD 的 opaque snapshot。新診斷 getters、transition guards、private generation tokens不是聲稱取得了原 member symbols。

## 106：選圖、檢查與 launch commit

1. 驗證完整 socket group／generation、chief、request body、支援的 ordinary scope與所需 services。
2. 先決定 `m_nMapIdxPlaying`。固定 map、random-any−1、theme−2等按原 15-bit draw／modulo；authencode1可略過**候選過濾**，不可略過最後 selected-map level檢查。Guild77的 random filter排除mission，並不表示Guild launch已支援。
3. `CanStartGame(0)` 失敗只回115錯誤；不初始化 calculator、playing、context或round UUID。
4. 原 `MaxTeam <8` 的 launch color remap與 waiting map change的 normalization不同；保留 color byte高位，只對實際改色 slots送107。用**remap後隊色**建立統計／MyTeamNo／OtherTeamNo。
5. 116按 map capacity做 forward shuffle，然後按 occupied slot分配 spawn／actual bomber。其 header與raw draw順序見[Gameplay](Gameplay.md#角色與出生點的硬編碼)。不是只shuffle當前人數。
6. 清 loss regulator、context應清欄位、shop-attempt flags、ghost mapping／count／last time，occupied state設Active0、vacant設Inactive1；記錄launch tick、map ghost seconds、mission、airplane times、每slot native mask／prefix。**不清 ready、join timestamps、peer discovery、context既有 state timestamps／positions**。
7. 發布115成功、changed-only107、116、若有iteminfo則173。room transition在同一同步邊界commit；預先固定 packet bytes／recipients，發送時callback已看到最終狀態。

步驟7的detached publication／whole-group preflight／reentry rejection是**現代安全與時序差異**，不是原Put／Flush中途callback的逐指令重現。可預期的scope／identity／resource／wire範圍錯誤先檢查；transport失敗不回滾已commit的狀態或自動重送。

### 173與原始資源

`CServerApp`從資源prefix相鄰的 `FXGS/iteminfo.txt` 載入兩組 name／weight，`CItemAttr`先解析全部再發布 frozen tables：

- base：`0:50, 1:40, 2:5, 5:5`。
- alternate：`24:60, 69:10, 70:10, 54:10, 0:5, 1:3, 2:1, 5:1`；只在mission第一個DWORD為**1**時選用。
- 權重**不正規化**、不杜撰均分；每組native容量100。未知名稱經lookup得到−1，wire item byte為FF。明確空表仍可送count0；檔案缺少則**不送173**，不替它發明default table。
- payload：`u32 initialMilliseconds, u32 frequencyMilliseconds, u8 count, (u8 itemIndex, u8 weight)*count`，皆為TCP scalar coding。ordinary ladder=false，因此不套ladder-only30000ms上限；FFFFFFFF保持DWORD值，不當成負秒數。
- metadata的mission words即使看似pointer，也只保存原值；不解引用、不把它們當本機位址。

Native在每次`SendAirplaneItemProb`內`fopen("iteminfo.txt")`；移植改成startup snapshot，不在live room做filesystem IO，故也不自動跟隨途中改檔。startup factoring與reload的嚴格numeric／count／trailing-data／atomic驗證都是明確的現代差異，不宣稱native parser或動態改檔時序相同。

## 109／discovery：真正 DoStartGame

TCP109與raw UDP11可先後任一順序到達；每個local player都需CRC／actual-bomber／default attributes正確，**每個occupied slot**都需已知peer與status08。只設`playing=true`或手動準備統計，不能偽造本次private launch token。

最後一包109／discovery，及Loading移除後可能開始的survivors，都先驗證可開始的人員／generation／統計／sync範圍，再改ready／peer／removal等狀態，避免可預期錯誤留下半個local group。Native沒有相同整批rollback保證。

真正start會初始化sync與map initial object count（175若適用先於150）、native+11612／+11616兩個opaque DWORD設−1（目前只確認init writer，不猜成winner欄）、啟動clock、清native cache hook／opaque counter、設Running，接著150：

```text
u32 clockStartTick
u32 (roomGameSequence XOR roomGameSequenceKey)
u32 ghostStartSeconds
u32 ghostFrequencySeconds
```

key是room初始化時的一次15-bit draw；sequence從room serial起算，每次start以DWORD+1，FFFFFFFF後回0。它們**不是server settlement UUID，也不是密碼學anti-cheat token**。傳出150後，ghost內存倒數才轉毫秒；複製map `ReBirthMapGroup`旗標、清vacant slot hosts、初始化CBanChief與airplane request marker。occupied peers被保留，可用於下一輪。

現代server UUID由同一次完成的native start私下綁定既有durable result lifecycle；client不能提供UUID。正式start保留先前Update tick，不套測試專用`BeginResultLifecycle`的start-time seed。164回準備清掉native launch token；**不重抽room key、不重設game sequence**。下一輪取得新UUID，前一份receipt不重複。

## Loading timeout與移除

`Update`在已commit的ordinary Loading traversal按slot檢查**join time**，不是launch／116時間：unsigned(now−join)>25000才移除。恰好25000仍保留；DWORD wrap／underflow按原比較。所有候選先preflight，且逐筆重新檢查membership、peer與當下playing門檻；若移除callback改成非playing，本次後續slot改用30000。普通waiting-chief已另由[WaitingChief](WaitingChief.md)接通121／整組移除，與本25s Loading分支分開；BangPok／特殊recovery仍未完成。

移除經真正table-owned `DestroyPlayer`；可能讓其餘ready survivors當場start，再接195／native pool4。Loading傳給notice guard的是**遇到的第一位未peer user**，不強行改成primary；Running loss regulator則仍選primary。普通network discovery對雙local原子發布，所以partial-peer secondary案例是明示的trusted狀態邊界測試，不宣稱正常client一定能到達。

最後一組移除會關房87，不在失效generation後補送舊86；不捏造150。frame正常完成才記錄entry tick，錯誤隔離／publication counters／frozen-result限制見[GameUpdate](GameUpdate.md)／[PlayerRemoval](PlayerRemoval.md)。

## Playing期間房間設定的特殊語意

| request                | 本build行為                                                                        | 移植界線                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 97 select map          | 仍decode；不換waiting／playing map，不dirty或normalize；回目前waiting selection112 | 保留現代chief ownership／嚴格body驗證                                                                                     |
| 98 select color        | 不改stored color，但Base caller仍向全房發**requested byte**108                     | 不能誤修成完全不回包；保持完整group／self-index範圍防護                                                                   |
| 99 select bomber       | playing時整個request忽略，無回包                                                   | body-less request亦忽略，不先decode                                                                                       |
| 100 open/close slot    | 同上                                                                               | common group／generation驗證仍先做                                                                                        |
| 96 ready、title change | 原碼沒有通用playing blanket guard；title仍chief-only                               | 不套用99／100規則到全部房間命令                                                                                           |
| 103 normal/mod toggle  | Native setter允許playing時切換                                                     | **移植明確差異**：已有native launch／result binding時，網路不得進入未移植Mod cascade／result，先回unsupported，不先改mode |

公開trusted mode／map／statistics adapters在transition／Update／removal／result callback期間也拒絕重入，避免publication中途另換世代。這些guards不是native授權模型。

## 證據、重建與限制

`tests/reference/game-launch.cpp` 是我們按原碼另寫的fixed-width C++模型，**不是執行官方程式的oracle**。`Tools/BuildGameLaunchVectors.ts`先read-only核對**25個PE instruction anchors**，再只編譯／執行自己的模型。fixture：510組color subsets、2160組random-map filters、24組start150／173、48組join/deadline、6組sequence wrap、8組mission／airplane；合計2756組。全部被production unit tests消費。

```sh
./node_modules/.bin/bun run Tools/BuildGameLaunchVectors.ts
./node_modules/.bin/bun test tests/GameLaunch.test.ts tests/ItemAttr.test.ts
./node_modules/.bin/bun test tests/GameLaunchIntegration.test.ts
```

`GameLaunchIntegration.test.ts`使用**真LS／GS TCP、真UDP listener、file SQLite、實際400ms timer與strict8s回準備**：三個帳號、2+1 locals，96／106／109、RTT barrier後仍等待discovery、解析完整8-slot120、收到150、secondary151→166／另一socket152→167／再次151、146 claims／death、同一163、全房同交易receipt、164、第二次96／106／109→新150／新UUID／相同key且sequence+1，下一次106／150另驗ghost maps／count／last已重設；第二輪nonchief156→171、完整opaque／duplicate records、throttled count255及RTT barriers，最後reopen SQLite核對。現在亦驗第一輪144／145的shared claim／alias與149完整CP949 bytes、invalid-local-self早退／RTT barriers、164保留／下一106已清claim arrays、第二輪先真144 claim0／249再由171清除，非金錢／公告不誤改wallet；Type99另只注入真COMMIT後SQL ACK遺失／可用性gate，真400ms重試後確認live／156、163保留money、下一輪新UUID／reset新claim，五筆receipt與餘額reopen，見[MoneyPickup](MoneyPickup.md)。house161另驗真COMMIT／ACK loss／400ms重試、exact178、zero新格、163保留／164 retained／下一106清board與allocator、第二輪新UUID／新claim與3筆獨立receipt reopen；final Alice10／Partner10000／Bob15，見[HouseClaim](HouseClaim.md)。測試**未呼叫trusted Running、手動Update、手動clock、指定UUID或payout endpoint**。它不驗完整戰鬥或原client授權；測試端仍與server共用codec，不能排除雙方同錯。

實際socket close callbacks也必須先於Center／DB teardown完成；新增Transport regression先重現舊Bun關閉順序失敗，再修正。完整兩輪整合另檢查shutdown後房間已移除、rank／global users及socket sets皆清空，不以延遲或隱藏disconnect錯誤通過。

最終full regression、十六份reference穩定性與原始檔完整性以[Coverage](Coverage.md)為準。仍欠原client build／實際錄包、官方execution oracle、可玩的整場事件、特殊模式、長時間／負載／惡意流量與restart恢復證據。

## 下一輪不回補paid inventory

146 case0已接真native-generation gate、獨立inventory receipt、Type22 timer與201 snapshot修正，見[SpecialItemUse](SpecialItemUse.md)。106重建statistics／清Shop／Nice但不重載或回補消耗；150給新UUID與ordinal0，下一paid use才ordinal1。真TCP第二局耗盡同一resident SN，SQL刪除而live201保留Amount0，close／reopen無row。庫存在login／transfer前seed並由真正CConnectPool載入，不用手改Running／庫存或時鐘通過整合。native ItemSn／StockSn與日期／catalog mapping仍未還原，不把非空201封包測試當完整shop／client相容性。
