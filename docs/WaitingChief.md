# 普通等待房房主警告／移除與 SuperChief

## 已接通的範圍

`CGameSession.DeferBanChief` 已接入 **ordinary Normal／setter-issued Mod等待房、非 Guild／BangPok（含合法issued pending vote）** 的等待房，由正式 `CGameSessionTable.UpdateGameSessions`／`CTimerThreadNormal` 的 400ms／8-stripe 排程驅動。沒有 native launch token／round UUID 也可處理等待房；**不需要啟用 GS UDP discovery**。戰鬥仍須自己的 private native launch／bound round 門檻，不能由等待房資格取得。

已接上既有 `CBanChief`、可信 native resident 的 `Item/SuperChief` 查詢、原生 response **121**、整組普通 table departure／房主交接及 pool4。沒有新增 SQL、receipt、購買、給付、權限角色或自動 lobby 成功。practice／Mod／Guild／BangPok／Playing vote cascades、native flush／collector／restart 與原 client 整場驗證仍未完成；completion／client flags 保持 false。

## 來源與欄位：不能把 capacity 當 player count

| 來源                          | VA／位置             | 核對結果                                                                           |
| ----------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `CGameSession::DeferBanChief` | `0041C15B..0041C47C` | playing 只 Init；否則先驗 chief index／pointer／socket，再查功能道具及 sample time |
| `CGameSession::Update`        | `0041DC52..0041DC62` | nonplaying virtual+224 呼叫 DeferBanChief                                          |
| Manner／ordinary odd gate     | `0041C1CD..0041C200` | **capacity BYTE+833**：Manner 時 `%2 !=0`，非 Manner 時 `<=1`                      |
| full-room selection           | `0041C36C..0041C387` | capacity **+833** 等於 current count **+832** 才採較短 ready delay                 |
| `CUser::HasAuthority`         | `0041688A`           | PE **`33 C0 C2 04 00`**，任何參數皆回傳 **0**，沒有讀 this 或 Authority 欄位       |
| `CUser::HasFunctionalItem`    | `00416AE5`           | native resident **Category2** 與 exact encoded `__mbscmp`；不檢查 Slot／Amount     |
| SuperChief multiplier         | `0041C1AD..0041C1C2` | exact `Item/SuperChief`，有則3，無則1                                              |
| waiting readiness check       | `0041C213..0041C21F` | virtual CanStartGame(1)，非零便 SetCanStart(false)                                 |
| CanStartGame map              | `0041C81E`           | 讀 **playing map+1180**，不是 waiting-selected map+850                             |
| ordinary chief-left reset     | `0041BB44..0041BB5D` | group deletion／sync 後 Init，再 SetNewChief                                       |
| odd kick order                | `0041C327..0041C351` | chief TCP121 → table DestroyPlayer(socket,false) → pool4 → SetOddSlot(false)       |
| normal kick order             | `0041C446..0041C470` | chief TCP121 → table destruction → pool4 → SetCanStart(false)                      |

所附 build 的 authority22 exemption、23 map bypass、25 participant exclusion 都會呼叫同一個 **zero stub**。新 `CUser.HasAuthority` 保留此行為，不從 SQLite `Authority=22`、bit22、`-1` 或 TicketDate 推導權限。這不是把原版 permission engine 補完，也不改既有登入安全政策。

Manner 是非零判斷，並非 Mod game type。例：**capacity3、目前2人**的 Manner 房仍會啟動 odd warning；capacity4、目前3人則不會。非 Manner 的 capacity3 不因奇數而被踢；default capacity8 只有1人也不啟動 odd warning。current count 只在選擇 full-room ready delay 時比較，不能以 `%2` 取代 capacity。

## 期限與121格式

全部為 WinMM **unsigned DWORD milliseconds**，差值以 u32 rollover／underflow 處理。比較皆為 **strict `>`**，恰好期限不警告、不移除：

| 條件                       | 一般     | SuperChief |
| -------------------------- | -------- | ---------- |
| 可以開始而未開始：目前滿房 | 10,000ms | 30,000ms   |
| 可以開始而未開始：其他房   | 20,000ms | 60,000ms   |
| odd-capacity 首次等待      | 5,000ms  | 15,000ms   |
| 警告後的等待               | 10,000ms | 30,000ms   |

`CBanChief.IsBanChief(full,manner,multiplier)` 的 **manner argument 在這個 build 未使用**；不能因此刪掉上層 DeferBanChief 的 Manner parity 分支。既有 CBanChief DWORD multiply／overflow 語意仍保留，scheduler 的 multiplier 僅依功能查詢選1／3。

121 body 為 **opcode BYTE + reason BYTE + WORD warning seconds**。最後一欄是完整 warning delay／1000（10或30），**不是剩餘秒數、slot、token 或 client ack**：

| reason | 用途                  | recipients                                     |
| ------ | --------------------- | ---------------------------------------------- |
| 0      | can-start 首次警告    | 當時所有不同的 room sockets；雙 local 只收一份 |
| 1      | odd-capacity 首次警告 | 同上                                           |
| 2      | can-start 到期移除    | **chief 所屬 socket**，不是每個 local 各一包   |
| 3      | odd-capacity 到期移除 | 同上                                           |

兩個分支不是互斥。單一 call 可依序產生 **1→0** 或 **1→2**；odd kick3 則提早返回，不能再呼叫 CanStartGame／產生 normal kick。CanStart 非零會重設 normal can/warn 時間；odd flag 只依 capacity／Manner 分支處理，even gate 清除 odd warning。**兩種 warning 都沒有清空庫存或獎勵副作用**。

功能道具每次 tick 查詢**當下 chief local 的 native vector**，不是 socket primary／其他玩家。原查詢沒有 Amount>0、equipped、expiry refresh 或 catalog 重解釋；可信 resident 已含 Amount0／Slot255／past raw DATE 的 matching Category2 row 時，仍可影響期限。這**不表示允許載入過期道具／購買成功或發放0amount stock**；row 只來自顯式可信 read-side 安裝，正式 native SQL loader／有效期重驗仍缺。明示 legacy SN／ItemID／Verbose 不會被猜成該功能，native empty 也不降級 SQL。來源轉移見 [ResidentInventoryHandoff](ResidentInventoryHandoff.md)。

警告之後若可信來源明確換 vector，之後的門檻採**當前** multiplier，並不綁死首次公告的秒數。此變更是 read-side reload，不是 scheduler 消耗道具或授權 financial replay。

## 不合併 clock samples；現代 publication／removal 邊界

Native 在 entry、各個 true setter／SetCanStart 及 IsBanChief 會**分別讀 timeGetTime**。正常 timeout 可用較晚 IsBanChief sample 跨過門檻，但 warning expiry 仍使用較早 entry sample。不能只取一次 now 後沿用全段。ordinary chief departure 還有 Init 的 sample，normal tail 再有一次 SetCanStart(false)。

`PlanDeferBanChief` 是明示的 **現代 detached preparation**：

1. 在同一 room-update guard 中捕捉全部 actor／slot buffer／socket group／Info／native owned-pre vectors及epochs、實際 Center owner 的 opaque connection generation。普通 kernel fixture 的 Common CUser 沒有 Center generation；這不是一個轉服 lease。
2. native vector 已 immutable，以 **reference＋epoch** 驗證，不在每個 clock read 重複序列化最多3200筆 native rows。legacy mutable資料仍核對其 snapshot。codec、time、CanStart callback 前後重驗；same-value owned／pre reinstall、Center pending clear/republish ABA 也不能沿用舊決策。
3. fork CBanChief，準備全部 helper fields、獨立 clock reads、121 bodies與 recipients；任何可預期的 clock／scope／第二 local／body／missing-hook 問題，先於 live helper publication／整組移除拒絕。
4. **刻意的現代差異**：chief departure Init／最終 setter 的 clock reads 也先準備。final helper state 在 callbacks 前安裝；真正 destruction 使用該預備 snapshot，不在 roster 消耗後再讀一個可能 throw／重入的 clock。這不是 native callback timing parity。
5. warning 每個 recipient 使用獨立 body；失敗計數而不重送，已設的 warned flag不回滾。chief121在 table destruction 前嘗試；notice 失敗但 ownership未變時，仍完成 group departure／pool4，**沒有195**。
6. 只有 **121 callback 返回後**，經整組 recheck 才可在一個 one-shot、stack-bound closure 中允許 table destruction。正在傳送121本身不是 removal權限；直接 room/table DestroyPlayer、channel transition、room packet、新 group加入均受 guard。service未消耗或保存 callback到返回後，不會得到稍後可重放的權限。

helper欄位發布之間不呼叫callback。這些 guards 不是任意外部 JS／SQL writer 的全域鎖，也不是多執行緒 Win32 synchronization。

### 失敗與pool4

- Chief 所屬1／2 locals **整組**經現有普通 [PlayerRemoval](PlayerRemoval.md) 分層移除；保留 ghost／sync／reset106／受影響107與 slot／session IDs 的原順序。移除最後一組則 table87 關房；不在其後 flush 舊86。
- 新 chief 的 group在 waiting才清 ready；不是隨意重設整個 room／context／clock。沒有新 result UUID、財務計算或自動開始戰鬥。
- pool4在移植中稱 `SessionRemoved`，native enum名稱未知。TCP／Center global users／rank仍保留；**不自動送15或195、不假裝進入lobby**。explicit83／16另有其合法路由；16回Channel送13／14。209仍回同一native201，不 reload／扣量／清pre。
- 若 trusted send callback 在121之後換 native／connection generation、關閉連線或破壞membership，會拒絕消耗 stale group；已嘗試的notice／外部 mutation／已發布helper state不假裝 rollback。這不是exactly-once傳送、receipt或 automatic orphan repair。真app仍遵守既有 disconnect finally cleanup；無法移除的房間需要尚未完成的明確恢復，不能因此離線發獎或重base。

`gameUpdate.scope` 現為 `ordinary-waiting-chief-loading-running-result`。新增 `waitingChiefRooms` 是具可排程scope的現存等待房間數，**不表示每房都沒有identity failure**；`waitingChiefWarningFailures` 是仍存在房間的 warning publication failures 加總，關房後不持久保留。chief121／UDP195 notice失敗共用既有 `RecoveryNotice`，room-list失敗仍是 `RoomNotice`。診斷只留固定計數／code，不留帳號、SQL、packet或exception text。

## 獨立參考與真實網路驗證

第 **24份**獨立人工 C++ model，builder先 read-only 核對 **48個固定 PE anchors**。**2,356 cases**：1,824 deadline、324 capacity/count grid、64 CanStart結果、32兩通知順序、96獨立clock／rollover、16 short-circuit。逐一比對全部8個helper DWORD roles／canonical36-byte image、ordered121 bodies、clock values及CanStart calls。普通 table callback只模型化chief-left Init；CanStartGame為**觀測輸入**，不是另一個完整 native launch／map／permission oracle。

```sh
./node_modules/.bin/bun run vectors:waiting-chief
./node_modules/.bin/bun test tests/WaitingChief.test.ts tests/WaitingChiefLifecycle.test.ts
./node_modules/.bin/bun test tests/WaitingChiefIntegration.test.ts
```

- core涵蓋strict期限、native zero authority、所有capacity/current組合、兩通知／early return、三種延遲全部×3、分開clock讀取、snapshot失敗原子性及codec／clock／Center epoch ABA。
- lifecycle走真正80／81／96／100及table Update；驗雙local整組移除、secondary-chief查詢、CURRENT multiplier、noSQL／四receipt0、最後87、stale generation、missing service、last-clock fault、warning／chief send failures、join／removal重入與closure過期。
- frozen／unsupported scope以trusted Reflect／kernel fixture驗證，**不是實際financial-pending TCP barrier證據**，不擴大既有receipt／wallet範圍。
- **真正LS→GS TCP＋未加速400ms timer**：可信native SuperChief跨服→wire Manner／capacity3／3users→**實際15秒以上**警告121/1→**實際30秒**之後121/3→整個chief pair離房／survivor106/107→pool4保留TCP／三global／rank→explicit16→209完全相同201。**沒有注入clock／timer tick／ready bits／Running／RNG／財務成功**；只有native resident來源為顯式可信fixture。SQL total_changes不變，四receipt都是0。
- 六類錯誤實作 controls（capacity誤用count、漏×3、捏造Authority、漏opaque epoch、等待中join重入、closure不退役）有 **8 red→8 green**，還原原source exact bytes之後compiler通過。

完整suite與重複／乾淨樹檢查見 [Coverage](Coverage.md)。人工C++、共用codec測試peer、未加速時間驗證都**不是執行原EXE／Windows WinMM、原client相容／完整可玩對局／長時間壓測或native SQL給付證明**。沒有執行供給EXE／DAT／carved SQL，不改host clock，不連舊官方／billing端點。

## 與ordinary等待房live vote cascade銜接

[BanPlayer](BanPlayer.md)已將104／105的既有policy接入ordinary等待房；合法issued vote不再停止本頁scheduler。Native普通chief離房後可重算並踢掉繼任chief，second Init仍在outer最後setter之前：新detached removal hook在該位置preflight整條cascade，ready保留ENTRY／IsBan／兩Init／final SetCanStart五次分開samples，odd只ENTRY／兩Init。整份votes現加入waiting fingerprint，並有private vote-state／table issuer、one-use／return revoke及nested bool／batch ownership；public fields／plan不能授權。

本頁現代preflight／final helper先發布的callback時序差異仍在；clock fault、post121 drift先拒絕，不假rollback。真TCP pending disconnect／BanReflex另已驗證，但double-Init時計使用合法packet flow＋顯式clock provider的lifecycle證據，不冒充原client或真WinMM動態oracle。

[WaitingVoteJoin](WaitingVoteJoin.md)另開放active vote中的普通81／82；加入不重設CBanChief或其任何clock marker，後續自然400ms Update才依當時current count與capacity比較。Incoming與incumbent fence／table join reservation並未授權重入本頁121／移除；後續double Init／outer setter仍由既有private issuance與native-order preflight處理。

後續[VoteLifecycle](VoteLifecycle.md)允許issued vote沿native106／116／150保留，ordinary Playing票控不從本頁waiting eligibility取得權限。Native DoStartGame另有自己的CBanChief.Init sample；若Loading移除先造成150，該sample在所有適用的leaving-chief Init後，再獨立預備／install，不折成同一timestamp。普通164撤銷target／private vote，不重設原票陣列。

[GameTypeTransition](GameTypeTransition.md)已開Known Mod waiting排程；合法mode切換／same-mode snapshot不改helper或clock deadline。Native CanStart不讀mode+948，不能把Manner parity或room capacity誤當Mode flag；reflection-only mode1不取得issued waiting scope。Mod106仍拒絕是明示移植availability差異，回Normal後才可native開局，沒有為此新增vote TTL。
