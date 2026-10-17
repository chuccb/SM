# 普通等待房 Normal／Mod 切換：102／103、93／92

## 已接範圍與仍缺的部分

普通等待房現在可在**合法private-issued vote仍pending時**切Normal／Mod；Mode1等待房可104／105、ordinary departure／nested cascade、81／82入房與原CBanChief排程，不再靠停止timer避開未完成流程。Normal等待房切Mod不取消／重開electorate，回Normal後可沿同一vote進原private native106／116／150。

**Mod開局／Playing戰鬥未接通。** 網路103在已commit native launch／bound round時仍先拒絕；Mod等待房106在115 success／116或時計前拒絕，不能把opcode92視為captain／Mod對局或financial成功。Guild／BangPok／practice vote、Mod combat/result、restart restoration及原client驗證仍缺。`completeOfficialRewrite`／`officialClientVerified=false`。

新status `waitingGameTypeScope=normal-mod/issued-vote`；`voteBanScope`明示ordinary Normal／Mod waiting與native **Normal** Loading／Running／durable Result。Native mode／waiting issued epoch及readonly檢視都不授權Mod combat／SQL replay。

## 原碼實際做什麼

| 函式                  | VA／完整長度          | 原生效果                                                                            |
| --------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `SendGameTypeNormal`  | `0041B509`／94 bytes  | DWORD `+948=0`，93 opcode-only；recipient非null只送該peer，null向room送             |
| `SendGameTypeMod`     | `0041B567`／97 bytes  | DWORD `+948=1`，92 opcode-only；同樣target／room選擇；相鄰`0041B5C8 C3`不算入此函式 |
| `OnSetGameTypeNormal` | `0041C783`／65 bytes  | chief slot0..7／nonnull／actual socket相符，呼叫setter；沒有Playing或vote gate      |
| `OnSetGameTypeMod`    | `0041C7C4`／65 bytes  | 相同chief gate後呼叫Mod setter；沒有Playing／vote gate                              |
| `CanStartGame`        | `0041C805`／447 bytes | 逐participant ready／team／Manner／map／premium／level；**不讀mode+948**            |

這些setter**不寫Manner、不改票／target／chief／ready、不sample clock、不重設helper／map／statistics／strategy、不設room modified bit、不給付或執行SQL**。同mode再次要求仍發原native opcode，不偷偷去重；`SendGameType(recipient)` snapshot同樣會再次寫原mode值，不能把modern private revision0當成「從沒入房」等native身分。

`GameType.Mod`名稱沿既有原碼符號，沒有自行擴充成道具價格、權限角色或獎勵倍率。這輪逐一核對`+948`讀取點，確認其中一處只是DumpLog的`MOD:%d`文字，**不是額外financial/reward API**。

## 為什麼還不能開Mod戰鬥

其餘已找到的mode差異不是setter的一個bit就結束：

- `CheckIsCaptain0041BF31`於Mod launch的116填cached captain DWORDs `+952..983`；比較current team與raw user DWORD`+212`（`CUser.GetExp0041B9F8`），**不是cached level+1984**。有同team較大Exp即非captain，tie可有多個captains；原init把八個cached flags清0。
- `OnBomberDie0041BFAB`還檢查當前Mod／cached flag並重新比較current XP，再對其他same-color、state0或3 teammates形成native159／80死亡連鎖。Captain cache、current XP、team／state與傳送順序需要自己的完整port／pending-death／financial integration。
- Ordinary strategy仍是原native ret4等空函式；**沒有因opcode92換成另一個未經證明的plugin strategy**，也不因此宣稱Mod result／restart已完成。

這些是下一階段的來源邊界；本輪不猜成「最高cached level隊長」、不任意新增或跳過death cascade，不回覆假的Mod start-success。Native setters本身允許Playing，本次網路限制是**明示現代scope差異**。既有直接trusted setter用於scope／failure fixtures的行為，不等於網路開放Mod combat。

## 現代issued waiting模式與publish防護

Live setter仍先做chief／body hardening（network）、transition／gameplay freeze及exact private vote ownership檢查；active native vote想進Mod combat仍拒絕。Constructed room的mode預設0；合法setter同步發布mode與private waiting-mode marker、monotonic private revision，全部callback只看完成後資料。反射`m_nGameType=1`或複製projection DTO不是issued Mod等待房，不能使timer／vote／join取得資格。

Private revision在idempotent mode setter亦前進，用於read-side／native vote context fence，同bytes的Normal re-publication不會穿過準備中的snapshot。它不是native欄位／client token；revision上限先拒絕，不wrap／授權financial replay。`GetGameTypeState`只回immutable Value／WaitingIssued／Revision metadata。

92／93全部先prepare body，再沿既有`WithGameTransition`／detached packet batch發布。Callback不能立刻104／105／mode／join／remove／Update重入；每peer publication失敗只計數，其他peer照常嘗試，不rollback／replay native flag、不宣稱client ACK／exactly-once。外部合法setter在read-only query callback中已完成的93不是「該read-only準備失敗就會rollback」的副作用。

`waitingGameTypeScope`不替代原private table issuer／vote registry。Known Mod等待房沿相同empty ordinary strategy／first-occupied chief與mode-independent CanStart，既有capacity833／current832／Manner parity、SuperChief×3與double Init／outer setter的時計仍保留。入房snapshot最後為**當前92或93**，不是一律93；新0-vote local仍不能補投當前ballot。

## 可重建證據

第**29份**人工C++ reference：**5完整函式images＋23固定literal anchors／2048 cases／1039092-byte fixture**。覆蓋全部256 Manner values、mode signed／DWORD edges、Playing true／false、target／ballot edges及明示requested0／1；比對immutable After只有mode變、opcode93／92、完整plain／scalar一byte bodies。Native function images釘住「不清票／不動Manner／helper／clock／strategy」，不是把鄰近一條指令當整體證明。Model不import TS calculator／codec，不執行供給EXE／Windows API。

```sh
./node_modules/.bin/bun run vectors:game-type-transition
./node_modules/.bin/bun test tests/GameTypeTransition.test.ts tests/WaitingModeLifecycle.test.ts tests/WaitingModeIntegration.test.ts
```

新增**26 tests／17772 assertions／3檔**：3 pure／PE／one-byte body、21 actual-room lifecycle、2真TCP。Mode setter／vote／join都走正式handlers；Normal private native開局／result conflict亦由106／109／peer建立，非注入Running。Clock與financial-predicate負例明示scope fixture，不冒充所有financial-pending TCP。

真TCP第一例pending vote103／102保留Manner／electorate，later Mod pair入房收到92 snapshot，新105仍被原票0排除、原105解決同target；wallet／native-pre／SQL changes與四種receipts不變。第二例**未加速正式400ms timer**在Mod waiting／odd capacity5／current4，實際>5秒warn121／1、>10秒後chief121／3→整組移除／pool4，private vote仍繼續、No tie114／3後結束；無195／自動15／SQL effects。

測試peer共用codec，不是原client oracle；模型中Playing觀測亦不是live Mod戰鬥可用證據。全套、regression controls、original／fixture integrity與fresh-export proof見[Coverage](Coverage.md)。
