# 普通原生對局的投票跨階段：106／116／150／164

## 現在的scope

合法private-issued waiting vote現在可沿**既有ordinary native106開局**進入Loading，再由真109＋peer discovery進Running；票與target不被擅自取消。普通native Loading／Running可新發104或回105，durable Result亦可處理非financial的vote／departure。所有房間／stage必須有對應private native launch／bound round，**單設Playing／stage、trusted Begin hook或read-only DTO不會給這個權限**。

這輪不開放Guild／Mod／BangPok／practice vote、active native-round103切換、room restart／orphan restoration，也不開放Playing入房。[WaitingVoteJoin](WaitingVoteJoin.md)仍只在waiting工作；票控含私有target／exact votes／players及constructor table issuer，不授權financial replay。

`gameUpdate.voteBanScope`明示`ordinary-waiting/native-loading-running/durable-result`，`voteLaunchScope=ordinary-native`，completion／original-client flags仍false。正式native launch仍需要原本的GS UDP opt-in、resources、durable result wiring；沒有架空106／150成功或放寬原生private round gate。

## 原生證據：何時有／沒有清票

| 函式                   | VA／whole-range bytes | 原生票狀態                                                               |
| ---------------------- | --------------------- | ------------------------------------------------------------------------ |
| `OnRequestStartGame`   | `00420F19`／916       | 沒有vote或target reset；CanStart failure也不是取消投票                   |
| `LaunchGameStage`      | `00420BB3`／870       | 發116、statistics、SetPlaying1／Loading；**保留target＋整份votes**       |
| `DoStartGame`          | `0041BDCF`／332       | sync／clock／150／sequence＋1／CBanChief.Init；**保留target＋整份votes** |
| `DoReturnPrepareStage` | `0041B0DA`／217       | 164先發，stage0，**只清target DWORD+828，不寫votes+780 array**           |

Builder以固定literal SHA256核對上述完整函式區段，另24個literal instruction anchors含完整21-byte `CGameClock.StartGame0041B843`，不靠一條鄰近指令臆測「沒有reset」。原PE／decompile／listing只讀，不執行EXE／Win32 API。

`PlanNativeVoteTransition`是immutable data-only觀測：RequestFailed／Launch／Begin全保留，ReturnPrepare只輸出target0。它不回傳Apply、callback、table／round權限；live launch／start用它核對不應被改寫的票，普通return以其target0撤銷私有issued state，**不把原票重設或轉成新的electorate**。164不補114或新cancel ACK，late105在no-active路徑不讀request字段。

## 106準備與private native gate

Ordinary waiting request先確認chief／idle prepare／所有participants；保留原playing-map選擇的native副作用，即使最後115為NotReady等failure，投票仍保留，不出116或113重播。

有issued vote時，以incumbent arrays／slot buffers、private vote object、native prepared／started token refs、bound round identity及full native-context fingerprint做preflight。Fingerprint含original vote/helper/clock/ghost、dynamic／inventory generations、player states、join DWORDs與peer hosts／received flags／sequence。Map selection當下允許改playing-map，**選出後立即鎖定chosen map**，shuffle／clock callback不可再換成另一張map混用116／resources。

所有fallible RNG／resources／116與airplane packet準備、116 header tick與launch-tail WinMM sample完成後，才排115 success與改色107／116／Loading fields。這是現代先準備後publish的差異；native.GetTickCount與WinMM角色以兩次明示port samples保留，不是兩個Windows API／DLL動態oracle。Ready／peer／join時戳、票與target不因launch重設。

Loading權限要求current native token恰是prepared statistics token，沒有已started／bound round；Running要求同token已started且round.StartTick與native clock start一致；Result另外要求durable native result，undurable conflict仍凍結。原生statistics counts保留離房前cohort，不因vote重做統計或重base財務descriptor。

## 移除→Defer→survivor150的預備

普通native離房仍是root ghost／106／sync／chief Init→清stored slot→vote144→conditional second whole-group TRUE removal／pool4→Loading survivor start。Vote本身的114在其table removal完成後才排出，因此Loading target被105踢走而survivors全ready時，recipient順序是 **106／107／sync →150→114**，不是114後另造一場start。

若root removal引發另一組target移除，native的第一個start位置在**inner removal tail**；沒有second group時則在root tail。這輪在清任何ID前預測final survivors／ready+peer條件、驗證仍屬原statistics generation，再依native順序預備：

1. root／conditional second chief.Init各自時計（若適用）。
2. `CGameClock.StartGame`自己的DWORD sample。
3. `CBanChief.Init`的另一個sample。
4. detached150 body／original sequence key、sync count／rebirth resource。

時計／codecs失敗不先清target成員、不送106／114或150；同一owned105可重試。Prepared start只存在內部，private WeakSet brand一用即消耗，含exact launch token／sequence，且若由removal預備必須符合當前table-entry socket與同一object identity。Public scalar start／launch inspection或fake DTO都不能成為prepared150／round authority。

`CGameClock.StartGameAt`只是callback-free marker install：清Stopped／End、設Start，**保留Suspended**；不sample clock、不建立private token／UUID或發獎。舊nonvote StartGame仍沿原provider位置取樣；owned-vote route用已預備ticks，不在roster消耗後重讀provider。

Actual109先按原handler驗CRC／雙local attributes及寫parsed ready bits，若後續start-clock fault，合法已寫ready bits保留，但不發150、不改clock／sequence、不建立UUID；可由原deferred start重試。這不是對先前合法ready更新假裝rollback。

## Update、財務凍結與return

Loading timeout與Running UDP regulator使用原private table issuer。只有Update已指定的regulating socket可進入該次owned vote-removal scope；反射modern flags或一般reentry不給相同權限。Nested removal恢復outer bool／batch；若owner transition已持packet batch，survivor start沿同一owned boundary，不另進一次互斥`WithGameTransition`。

Money／house／special-item／undurable result、Applying或Returning仍在vote計畫／item query／clock／SQL之前拒絕；新路徑不提交SQL、重付、離線發獎、修改原CAS／receipt或替detached user重base。Native timeout形成真pending result conflict的案例驗證同一vote保留，storage恢復只提交原receipt。Durable Result的非financial vote可改roster，已commit receipt內容不改；164再取消當時尚存target並撤銷private vote。

Modern detached publication仍等整條狀態完成後flush，callbacks看final state，不能重入；這不是native callback timing parity／client ACK／exactly-once TCP。Late service failure、transport close或任意in-process JavaScript／外部SQL不在全域rollback保證內。

## 驗證與重建

第**28份**人工C++ reference：**4完整函式images＋24固定instruction anchors／2048 cases／1167383-byte fixture**。含每個slot的全部BYTE ballot probes＋DWORD／signed-bit edges、四種phase的target/vote規則、StartAt四marker角色／unsigned rollover及完整150 plain/scalar。C++不import TS policy／user／codec，仍不是原程式execution／resource／permission／financial／client oracle。

```sh
./node_modules/.bin/bun run vectors:vote-lifecycle
./node_modules/.bin/bun test tests/VoteLifecycle.test.ts tests/VoteLaunchLifecycle.test.ts tests/VoteLaunchIntegration.test.ts
```

新增**30 tests／46699 assertions／3檔**：3 pure／PE／markers、25 live lifecycle、2真正TCP＋UDP。Legitimate80／81／96／104／106／109／discovery建立private generations，不注入active vote／Running；clock/RNG、financial-predicate等負例明示DI或trusted scope fixture。原pending-node/private DTO拒絕仍測，並更新前輪「一律拒絕vote106」的舊scope期望。

真TCP第一例讓issued vote穿過106／116／109／150→真162／163→**未加速8秒164**，確認target只在return清、votes retained、late105沒回覆且下一104合法。第二例在Loading以105踢未ready雙local，survivors透過真正discovery／109已ready，收到106→**actual150**→114，target只收own last106／pool4／209，沒有195／自動Lobby／SQL awards。

測試peer共用codec，native inventory／clock fixtures的界線不變；未有原client、完整可玩整場、native financial SQL／flush／collector或restart恢復證據。Full／controls／fresh-export與全部舊fixture完整性見[Coverage](Coverage.md)。

## 後續：waiting模式的額外範圍

[GameTypeTransition](GameTypeTransition.md)已讓issued waiting vote102／103在Normal／Mod間切換，不清票或helper，Mod waiting仍可104／105／join／timer。這**不開本頁native Mod launch／Playing**：Known Mod106先拒絕，103在committed native Normal round仍拒絕。Mod captain cache／current raw XP／death cascade與完整result仍須另驗，不從一byte92授權。
