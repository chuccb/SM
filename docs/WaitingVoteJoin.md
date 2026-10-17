# 投票中的普通等待房加入：81／82、完整快照與原 electorate

## 範圍

正式 `CGameSessionTable.DoJoinSession` 現允許**合法JS-private issued vote中的普通 Normal 等待房**接納1／2 locals。81與既有現代first-fit82走同一入房準備；不是開放Playing／Guild／Mod／BangPok／practice，也不開放active-vote106／103、native restart／financial replay。原始read-side DTO與public target/vote fields仍不授權入房或移除。

本輪不改SQL、schema6／四種v1 receipts、owned-pre native/legacy模式、GS授權lease或給付。`voteJoinScope=ordinary-issued-waiting`是唯讀診斷scope，不是client權限token；completion／original-client flags仍false。

## 核對的原碼

| 原生函式                      | VA         | 意義                                                                                  |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| table `DoJoinSession`         | `00422849` | 逐local no-session／password／AddPlayer →81/0→full snapshot→foreign join105→game type |
| game `AddPlayer`              | `0041BD0E` | playing與空位檢查，ordinary strategy hooks，不檢查active target                       |
| list `AddPlayer`              | `0042410D` | playing/base gate；authority24才換chief，此build實際zero stub                         |
| base `AddUser(socket,self)`   | `004198FD` | 第一個open vacancy；secondary複製primary color；bomber使用既有resource選擇            |
| base `AddUser(slot,user,...)` | `004199E5` | pointer／IDX／serial／stored slot／pool2，clear chief/status、保留slot高bits          |
| list `AddUser`                | `00423D8D` | 只呼叫Base、增加player count、modified bit4；**不寫vote／target**                     |
| game `AddUser`                | `0041AF4B` | actual-bomber−1、peer flag0、**每local分別sample join DWORD**                         |
| base `SendJoinPacket`         | `00419F90` | 新locals逐一105／self flag1，排除joining socket；不是新增113                          |
| socket `HasAuthority`         | `00406C66` | `33c0c20400`，ANY參數固定0；不從SQL Authority1/24猜豁免                               |

重要差異：**AddUser沒有把新slot票設0的指令。** 正常空位在初始化／舊 `DeleteUser00423DB6` 後本來就是0。這輪保留整份票／target／chief，不以「加入投票」為名把新local設pending1，也不清除整個electorate。純projection對任意觀測的非0 vacant bits亦原樣保留；live path另要求現有private registry完全一致及healthy vacancy0，不能藉DTO把損壞狀態變成issued state。

## Live效果與沒有發生的事情

成功加入只擴充當前roster：

1. 首個未occupied且未Closed的slot；雙local依SELF順序各取一次。slot byte0只清Chief2／Status1C，bomber低6 bits、color低5 bits，opaque高bits保留。
2. primary color沿既有 `GetColorForNewComer` resource policy，secondary複製primary；new higher-level player不自動奪chief。Authority1/24實際固定0，不能靠SQL bits繞closed holes或選chief。
3. 新peer收到81/0、全部八slot105／107、兩次既有112、Normal93；原room sockets收到逐new-local的foreign105。native現代既有foreign105的self flag仍為1，不擅自修正。
4. **不發113／114、不呼叫Defer、不重設CBanChief、不改舊票／target／ghost mappings／opaque matrix**。新0-vote local對matching105答票會在first非pending local early return，沒有success ACK。
5. 新玩家仍接收後續正常room結果；原electorate可解決同一target。新玩家只在**下一次104重新初始化electorate**時參與。
6. private issued state只更新actual player refs，保留原target及exact votes。新0-vote組離房可沿既有ordinary departure重新計票，不需要重建／偽造authority。

No-session下保留的舊positive stored slot不被自創成全面拒絕規則；若其他ownership／tuple均合法，成功入房時重寫stored slot。密碼錯仍81/1、full／closed／無法使用room仍81/2；整條入房沒有新TTL、financial receipt或道具grant。

## 現代預備與所有權

只有constructor-bound opaque table issuer能呼叫live vote join。`AddAllUser`的active-vote gate仍在，public plan／bool／target field不能跳過此boundary。ordinary非vote仍使用原路徑，不宣稱已完成其所有native transitions。

入房前以原room的private vote registry、current table generation、整組existing players／slot buffers、full vote／helper／ghost／clock context及原owned-pre rows／epochs／actual Center connection generation建立fence；incoming亦逐local檢查：dense1..2、unique refs／nonzero unsigned serial、socket／SELF／nonfree、no-session tuple，Info／dynamic／legacy ref、native-pre refs＋兩epochs、actual Center opaque generation、原stored slot／pool／connected狀態。全組primitives先capture後才clock／codec；same-value pre reload、Center pending ABA及second-local mutation皆拒絕。

`PlanWaitingVoteJoin`僅做data-only slot／mask／原票投影；bomber與primary color是**既有resource policy的觀測輸入**，不是另一份完整map／random oracle。以detached `CBaseSession` view預備**全部**81／105／107／112／93，view只供本次render、不回傳live pointer或capability。第二人或原occupant105碼頁／overflow失敗，不發81、不半換任何local的tuple、roster或pool。

新locals的join時計先各自sample，原helper／game-clock markers不變；fallible clock／codec全部完成後才callback-free publish。這是現代atomic preflight與native sample時機的差異，不是WinMM動態oracle。

incoming在preflight時還沒session；不能只靠「房間目前transition」阻擋它對別房的80／81／82或stale removal重入。因此table另以socket identity持有exclusive joining reservation，涵蓋整批準備／publication，finally退役。Codecs或transport callbacks中的普通table／room reentry會被拒絕；constructor issuer是行程內信任邊界，不是對任意惡意JavaScript的sandbox。

整批commit後才enqueue／flush detached bytes與recipients。Publication callback看完整roster及已更新private binding；傳送失敗按既有counter處理，不rollback、不重新安裝、不冒稱client ACK／exactly-once。Late close仍可能使傳送未達；這不是durable join／offline settlement／restart restoration。

## 可重建驗證

第**27份**人工C++ reference：**28固定literal PE anchors／1476 cases／2401196-byte fixture**。其中完整固定 **41-byte List.AddUser、79-byte List.AddPlayer、60-byte Game.AddUser**，釘住「沒有vote write／Defer」而不只靠片段推斷。包括所有非空非滿roster masks的選定closed-hole組合、1／2 locals、high slot bits、舊vacant非0 bits、雙color／bomber observations；882 accepted、594 capacity拒絕。逐案比對完整81／105／107／112／93 **plain與scalar bodies**、Big5中文、原票／target／chief與輸入不變。C++不import TS calculator／codec、不執行原EXE／Windows API。

```sh
./node_modules/.bin/bun run vectors:waiting-vote-join
./node_modules/.bin/bun test tests/WaitingVoteJoin.test.ts tests/WaitingVoteJoinLifecycle.test.ts tests/WaitingVoteJoinIntegration.test.ts
```

新增**31 tests／13256 assertions／3檔**：4 pure／PE／body、25 actual-room lifecycle、2真正TCP。Actual80／81／104／105及原table departure建立issued state；malformed identity／financial scopes等負例明示trusted fixture，不假稱network可達性。Native/legacy incoming rows與presentation epochs保留，不讀SQL／refresh expiry／grant。

真TCP驗證pending104後later雙local81完整快照，new105不計票，以同socket209作順序barrier、不用sleep猜測；舊105仍踢同一target、new peer收106／114且保有native/legacy inventory與wallet，無SQL changes／四receipts。另一例password81/1→同peer正確重試→closed capacity81/2；拒絕前沒有部分enrollment。Native row為顯式可信preexisting read-side fixture，不是SQL loader／client grant。

Peer共用production codec，不是原client oracle；模型也不是native resource／SQL／client execution證明。Full／controls／fresh-export結果見[Coverage](Coverage.md)。後續仍缺Playing／特殊模式vote、active-vote launch／mode transitions與durable restoration。
