# FXGS waiting-chief／Loading／Running／Result 更新迴圈與部分計時器接線

## 實作範圍與入口限制

`CGameSession.Update()` 現在串起**一般 Normal、非 Guild／BangPok 房間的 waiting-chief／Loading／Running／Result 分支**：終局判斷、既有 SQLite 結算尾段、爆彈計時、受困死亡計時、152／159 發布、ordinary DestroyPlayer／UDP loss的195／pool4及延遲164回準備。`CGameSessionTable.UpdateGameSessions()` 與 `CTimerThreadNormal` 已接進 `CFxServerApp` 的啟動／清理。

**這不是完整 `Update`或可玩的整場遊戲。** 定時器接受完成private native launch commit的ordinary Loading，及native start或可信`BeginResultLifecycle()`建立的Running／Result；任意改public flags仍不能取得資格。一般network106／109／discovery已接真正`DoStartGame`與Loading timeout移除；production須明確開啟UDP discovery。普通waiting `DeferBanChief`已另接[WaitingChief](WaitingChief.md)，沒有battle token也可排程，且不要求UDP opt-in；practice、特殊模式與其餘事件仍缺。詳見[GameLaunch](GameLaunch.md)／[PlayerRemoval](PlayerRemoval.md)；舊kernel測試仍用trusted fixture，另有真正TCP+UDP連續兩輪整合，**沒有原client整場證據**。

## 來源、常數與命名

| 來源                       | VA／native位置                         | 核對結果                                                            |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `CTimerThreadNormal::Proc` | `00415B65`，Sleep immediate `00415B9A` | 每輪工作前 Sleep **400ms**，不是60Hz物理模擬                        |
| table virtual `+32`        | vtable entry `0048F994`                | 確實是 `CGameSessionTable::UpdateGameSessions 004219A2`             |
| normal-room traversal      | `004219A2..00421A01`                   | 8個stripe，index依0,8,16…，再1,9…，只到254                          |
| running終局／timeout       | `0041DC95..0041DCEB`                   | 先claims；仍Running才檢查 unsigned active elapsed **>180000**       |
| 每幀delta                  | `0041DD00..0041DD09`                   | entry tick − session **+12548**，不是每次重減game start             |
| 炸彈與queue152             | `0041DD16..0041DE11`                   | 原swap-last／landing timer核心；有事件才排152                       |
| pending死亡期限            | `0041DE4F..0041DE81`                   | 全8個state bytes均為1／3／4才用6000，否則10000                      |
| 到期比較與timestamp        | `0041DEAE..0041DF00`                   | unsigned age **>=deadline**；state3→1；再取ElapsedTime寫新timestamp |
| grouped159／flush          | `0041DE14..0041DF49`                   | 先準備兩個packet、更新狀態，再flush；159是單一群組，不是一人一包    |
| `OnBomberDie`              | `0041BFAB`，ordinary跳出 `0041BFE4`    | Normal沒有後續cascade；Mod不能略過其隊長連帶死亡                    |
| last-update writer         | `0041E0BD..0041E0C0`                   | 寫回**進入Update時**的tick，不是SQL／傳送後的時刻                   |

`GameUpdateTiming`、`PlayerStateTimerRule`、`SessionTableRule` 位於 `Common/OfficialValues.ts`。stripe數與玩家容量雖恰好同為8，意思不同，不共用錯誤命名的常數。新getter、failure counters、`AdvancePlayerStateTimers`、timer Start／Stop等為明確的**現代移植API**，不冒稱原PE中有同名方法。

完整閱讀table兩個body後另確認：`UpdateGameSessions`先遍歷255個normal，再遍歷255個practice，兩邊各8 stripes；門檻是session+140的`IsValid`（`00402DF7`），**不是playing或player count**。本移植的Map presence對應有效room，ordinary waiting另有scope／owner guard；battle額外加private native launch／可信round gate，practice仍省略。

`UpdateGameEtc 00421A5A`僅遍歷normal255個，沒有IsValid或round gate；它呼叫的 **`CGameSession::UpdateGameEtc 0041B193`確實只有`C3`（ret）**，在`.c`未呈現不能當作遺失的物理引擎／恢復任務。兩個同名方法已保留此無副作用行為，另外核對PE/vtable。Native Normal Proc並不呼叫這個Etc hook，沒有新增猜測的定時工作。

## 一次受限Update的順序

```text
ordinary waiting scope → DeferBanChief／121／table整組移除／pool4（不進battle tail）
native launch commit或可信ordinary round gate
  native Running有pending money／house／special inventory？
    是：在任何clock sample前重試原receipt／wallet或inventory計畫
        不重抽／rebase；不跑result／UDP／timers／room-list dirty flush
        成功亦結束該tick，不消耗lastUpdate delta
取本次entry tick（沒有pending money／house／inventory的正常路徑）
  Loading:
    join-relative strict25s未peer候選 → 全batch及可能start的survivors先preflight
    按slot逐筆重查peer／membership／playing門檻（mid-loop false改30s）
    table DestroyPlayer → 可能DeferStartGame／150 → notice-user guard／195／pool4
    正常完成後仍只記entry tick，不同tick內再跑Running分支
  Result:
    strict(now - end) >8000才執行既有164／回準備
  Running:
    重試已凍結result，或先判claims／forced end
    若完成claims：sync.OnGameEnd；不再跑本次timers
    若仍未結束：unsigned(elapsed - stopped) >180000？
      是：timeout result → EndGame → stage2
          不IncGame、不做同次sync.OnGameEnd、不跑timers
      否：
        UDP loss batch到期？
          是：non-consuming候選 → 整批preflight → table逐組DestroyPlayer
              primary safe-object/live TCP通過才送195 → pool4
              完成後清graph；沒有service或unsupported scope則先拒絕
        爆彈delta更新 → 準備152
        pending-death更新 → 準備一包159（仍讀vacant slot狀態）
        狀態全部更新完後，才依surviving peer送152→159
本次正常完成後，lastUpdate = 原entry tick
```

pending-death造成最後一位玩家死亡，**本次仍不重新跑終局判斷**；下一個tick才可能結算。若誤把claims移到timers後面，會改變end tick、duration獎勵區間、IncGame和封包順序。

凍結且尚未durable的result不跑任何state／bomb timer，也不消耗UDP graph。CAS conflict正常回傳時仍寫本次lastUpdate；拋錯則不消耗尚未處理的frame delta。重試始終沿用首次result plan／duration／key，不因後續tick成長重新計算獎勵。完整durability規則見 [ResultLifecycle](ResultLifecycle.md)。

money144與house161的耐久協調是**明示現代前置屏障**，不是native Update多出的已恢復分支。SQL／lost-ack／CAS conflict保留原plan，native token／participants／live fingerprint與stored After不匹配則不安裝；連Ready的end claims亦不能先capture163或IncGame。money／house pending及重試成功tick都不記lastUpdate，與上段result CAS conflict仍消耗entry tick的既有語意不同。時間源本身仍前進，下一正常tick按原elapsed／timeout及累積delta處理，不捏造暫停。HTTP另列`pendingMoneyPickups`／`pendingHouseClaims`；failedRooms為0仍可能有money／house freeze。house的board／allocator＋wallet獨立收據見[HouseClaim](HouseClaim.md)。完整限制、root SQL transaction與terminal orphan見[MoneyPickup](MoneyPickup.md)。

## pending-death不是6秒固定倒數

- 期限選擇讀取**全部8個state bytes**，不看slot是否有人；空slot殘留Active也會切到10000ms。state2／5／6／7及未知byte亦不是1／3／4。
- 狀態時間存在 `CGameContext+4820` 的8個DWORD；使用 `CGameClock.ElapsedTime()`，**不扣 `m_dwTimeStopped`**。180秒總時限與此不同。
- 比較為unsigned DWORD減法，含wrap／underflow；恰好6000／10000就到期，不可套用UDP／return的strict `>`。
- 對每個state3，native各取一次ElapsedTime判斷，若到期再取一次寫timestamp；不是整批共用同一sample。
- 到期只改state／timestamp並呼叫ordinary no-op；不替玩家捏造killer、save、掉落道具、XP或當下結算。

### 原159群組格式

以下是scalar XOR之前的邏輯欄位；沒有新增wire協定：

| 欄位         | 型別／值                                    |
| ------------ | ------------------------------------------- |
| opcode       | u8 **159**                                  |
| event header | u8 **0x50**（server event5，low nibble為0） |
| header X／Y  | u16 **0**, u16 **0**                        |
| count        | u8，到期數；0時不送                         |
| 重複count次  | u8 room slot、u16 **9999**、u16 **9999**    |

每筆5bytes，整個body為7+5×count bytes，slot依0→7。9999的數值與位置已確認；此區塊不足以把其所有client語意推定為真實座標／物理位置。client送event5仍被拒絕。

## Bun計時、故障與診斷：現代差異

- Bun以unref的`setTimeout`替換Windows thread／Sleep。先等400ms，執行同步table traversal，完成後再等下一個400ms；沒有60Hz、catch-up tick或跨worker原子鎖的承諾。同步SQLite仍會阻塞同一event loop，未做長時間／負載測試。
- `CFxServerApp.CleanUp`先Stop timer，再關閉UDP／TCP；共用SQLite最後才關。啟動rollback也會停止timer／撤回online狀態。Stop在tick callback中呼叫，不得再次排程。
- table保留native normal stripe順序，排程**普通waiting-chief、已commit的native Loading或可信／native Running／Result**；practice／特殊策略不會因此取得資格。native同一Proc還有pool、room-cache、user／guild flush等工作，此class並未全部移植。
- timer的room modified info目前由移植table在Update後flush；native Proc另於Update前做相關flush。不要把此部分接線宣稱為原整個worker時序parity。
- table逐房捕捉例外，下一次tick可重試**同一plan**，不讓單房錯誤中止其餘房間。這只提供重試機會，不會rebase衝突、修補identity、建立新round或恢復crash後房間。沒有table service或scope／identity拒絕時保留graph；支持的Running ejection完成後才消耗。claims／總時限仍先於UDP。
- `GetUpdateFailures()`只有room index／serial、固定error類別及consecutive count；不保存exception text／SQL／帳號／packet／UUID。每index一筆、成功或房間消失後清除。
- `/healthz`的`gameUpdate`逐GS回報timer是否running、`scope: ordinary-waiting-chief-loading-running-result`、`launchEnabled`／`loadingRooms`／`waitingChiefRooms`／`waitingChiefWarningFailures`、scheduled round／pending result／failed room／failed outer tick數，以及移除publication的固定RecoveryNotice／RoomNotice計數。**CAS conflict不拋錯，但pendingResults仍顯示被凍結的result**；failedRooms不是傳送成功率或完整健康證明。
- 152／159先固定bytes及targets，每peer建立獨立packet。傳送例外只增加固定兩欄的failure計數，不重跑timers、不重送死亡、不阻擋其他peer；無client ack。發布期間拒絕battle事件／直接end或return重入，避免在兩包之間另結算。
- 只有測試／trusted `BeginResultLifecycle`把lastUpdate seed為start tick；正式native start保留先前Loading Update tick。Native DoStart不重設此DWORD，不能把trusted seed套進network start。

## 開局來源審核：已實作的ordinary邊界，仍不能只看150

本輪重新完整閱讀 `LaunchGameStage 00420BB3`、`DoStartGame 0041BDCF`、`OnRequestStartGame 00420F19`，已按以下來源接入ordinary流程；特殊模式並未因此完成：

1. request-start先做原選圖／受限隊色重映射與115檢查，不可把目前`CanStartGame`或CSPRNG選圖helper當完整原選擇流程。
2. Launch除了116，還會初始化calculator／隊友敵人數、loss regulator、playing/context/shop-attempt/player states、ghost雙向mapping／數量／時間、launch tick、MissionInfo、飛機時間、每人64-bit masks與counters，最後處理173。
3. `SendAirplaneItemProb 004204EB`讀取實際`FXGS/iteminfo.txt`兩組name／weight，經`CItemAttr` lookup；不是可以憑空均分的概率表。mission選哪組及ladder時間限制另有條件。
4. **map object +100是由`ReBirthMapGroup`推導的Rebirth旗標**（`LoadMap 0040C15A`／`IsRebirthMap 0041AC59`），不是MissionInfo第四字。DoStart將它複製到session+12728。這不證明另有未讀的復活引擎：DeferResurrection0041B5C8本體為C3，本輪沒有添加猜測的Update呼叫，見[GameClaims](GameClaims.md)。
5. Native MissionInfo位於map+108，LoadMap複製前四字，另有STL vector成員；不能把保留的opaque數值當可解引用的server指標，或據此宣稱任務支線完整。
6. DoStart重設sync manager／initial object count、兩個仍需追查名稱的DWORD為−1、啟動clock、stage1；table vtable+12已由`0048F980`核實為**ClearModifiedFlag**，不是廣播或另一個開始封包。
7. Init的sequence從room serial起算，XOR key來自rand；150放當次sequence XOR key後，sequence作u32遞增。ghost start／freq以**秒**放150，之後native才將內存值乘1000。
8. DoStart只清空slot的UDP endpoint records、重設`CBanChief`等；不能把整房peer與所有保留的context欄位任意清零。
9. loading Update逐slot移除逾時socket；移除途中playing改變可能改採30000ms，而非一份固定25000ms候選snapshot。195、marked-free/live TCP及pool4已在ordinary Running recovery核對／接入；Loading已接DoStartGame／DeferStartGame後續，且notice user保留第一個未peer local，不強行改為Running regulator的primary。

以上ordinary實作／2756組launch參考與真正TCP+UDP重複開局見[GameLaunch](GameLaunch.md)；本段不是特殊模式或完整事件已完成的清單；ordinary waiting-chief另見[WaitingChief](WaitingChief.md)。native硬編碼意義未確定者仍以offset／opaque記錄，不散佈猜測的feature名稱。

## 獨立參考與測試界線

`tests/reference/game-update.cpp`是人工fixed-width C++模型，`Tools/BuildGameUpdateVectors.ts`先讀PE核對16個instruction anchors，再只編譯／執行我們自己的模型。固定fixture包含216組state／時間邊界、全部256個pending masks、6個串接frame；其中128個mask另經production session核對真正grouped159 bytes。

`GameUpdate.test.ts`還覆蓋同tick152／159完成後才傳送、下tick結算、entry-clock與DWORD wrap、claims／timeout優先序、SQL conflict／lost ack、per-room錯誤隔離／redaction、callback重入／失敗、實際400ms timer、app自動163／164及shutdown。**本檔app測試仍注入可信running；另有`GameLaunchIntegration.test.ts`真正網路建立round，不是原client或判勝授權的證明。**

## Special-item frozen time／inventory重試

146 case0正quantity共用pre-clock freeze：SQL／ACK失敗時inventory／Shop／Nice／Type22 state-time全留Before；只重試原plan／ordinal／time／159，不再讀clock。成功也不在同tick前進frame。全部live install先於detached159，sender整個TCP排除。Type22只是延後state3 expiry起點，不是復活；qty0只在必要時一次ElapsedTime，不產生inventory receipt。HTTP新增`pendingSpecialItemUses`。來源與201／native映射限制見[SpecialItemUse](SpecialItemUse.md)。

## Active waiting vote

合法private-issued ordinary waiting vote現仍列入400ms／8-stripe waiting-chief排程；[BanPlayer](BanPlayer.md)記錄121→root離房→deferred target整組移除／double Init→outer final setter。Public target-votes drift不被當作合法vote或新增財務權限；status另有`voteBanScope=ordinary-waiting`／`pendingVoteRooms`，completion／client flags仍false。ordinary native Playing／launch已由[VoteLifecycle](VoteLifecycle.md)另接；特殊模式vote與active-vote103仍拒絕；ordinary active-vote加入見[WaitingVoteJoin](WaitingVoteJoin.md)，native其餘Update分支未因此完成。

`gameUpdate.voteJoinScope`另明示`ordinary-issued-waiting`；新入房只擴充private roster、不改正在計算的electorate，不重新sample／reset房主helper。不是Playing join或financial lifecycle授權。

## Vote／native Loading-Running-Result

[VoteLifecycle](VoteLifecycle.md)新增active vote的native106／150世代驗證；private table issuer已指定的regulating socket才可進Update中的vote transition，不能靠一般flag／重入放行。Loading timeout可root→deferred second target→survivor150→114→195，Running regulation沿同一owned batch，statistics cohort／round UUID不重建。Financial retry仍先於clock／vote／roster變更；durable Result允許非financial vote，普通164撤銷issued target／private vote而保留票陣列。

Status `voteBanScope=ordinary-waiting/native-loading-running/durable-result`、`voteLaunchScope=ordinary-native`、`voteJoinScope=ordinary-issued-waiting`，不是complete／client成功旗標。Native tokens／receipts／callback時序與完整source驗證界線見該頁。
