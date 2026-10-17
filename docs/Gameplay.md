# FXGS 對局狀態：來源核對與目前移植範圍

這是所附 **FXGS build** 的研究／實作記錄，不是通用 BnB 規格，也不是可玩的整場對局。來源以 `FXGS/FxServer.exe.c` 的 VA marker 與同一 PE 的 `.lst` 為準；反編譯型別與指令矛盾時要看指令。

## 先釐清架構，不杜撰另一套引擎

`CGameMapTmpl::LoadMap 0040C15A` 讀取地圖 metadata。現有證據沒有一個叫 `CGameMap` 的 server-side class 可據以宣稱「缺少它就是缺少原版物理引擎」。原程式 `CGameSession` 接收客戶端的炸彈、吃道具、箱子、鬼魂等事件，核對身份／狀態、保存部分狀態、執行計時、轉送與判定結果。

因此不能把自行設計的完整碰撞／火焰模擬標成「原版做法」。同樣，轉送幾個事件也**不等於**已完成原本的判定、防作弊、UDP peer 協商、生命週期或結算。本移植不替未解功能回傳成功。

## 已修正的 metadata 與 opcode

- `GetMapLevelLimit 0040C5CD`，`.lst 0040C5E5` 為 `[eax+34h]`：**等級限制是 native object +52，不是 +36**。+36 保留為 `m_nOpaque36`。
- 實際 archive：index 0 `Bula00` 的 +36=2、level=1；index 12 `Bula12` 的 +36=2、level=15。`Village01` index 200 的 level=1、飛機初始時間 60000 ms／間隔 22000 ms。
- `CanStartGame` 的 premium 分支另減去 `CMainSystem+12`；該值初始化為 0，不能把任意常數當作 premium 等級折扣。所附 `CUser::HasAuthority 0041688A` 是固定回傳 0 的 stub，不據此杜撰 authority bit 意義。
- **115** 是 request-start 的檢查回覆；**116** 是 `LaunchGameStage 00420BB3` 的載入／準備資料；**150** 是 `DoStartGame 0041BDCF` 的開局；**163** 才是結果。以前把 116 命名為 GameResult 是錯誤，已更正。
- TileInfo 每筆 **11 個 DWORD／44 bytes**，不是 11 個 WORD。多數欄位仍保留原值，未全部賦予遊戲語意。

## 載入協商與 GS UDP

### 目前接線程度

| 區塊                                         | 已實作                                                                                              | 不代表已完成的部分                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `LaunchGameStage 00420BB3`                   | ordinary106／115／116／173、來源選圖／remap／calculator／context／ghost／mission等初始化            | 不支援所有特殊mode／mission引擎；pure encoder仍無副作用                                               |
| TCP `109`／`0041D431`                        | CRC／每位local actual bomber與預設屬性；與peer齊備後真start                                         | 需要private native launch generation，不接受手改flags偽造                                             |
| UDP `11`／`00416619`                         | 選用真discovery、整組／IP／room／owner驗證，回TCP120並嘗試start                                     | 非完整MTUDP host／queue／clock／NAT；預設關閉                                                         |
| UDP `1`／`0041B506`                          | native空函式no-op                                                                                   | **不是TCP109，不改ready／peer或start**                                                                |
| `DoStartGame 0041BDCF`                       | sync／clock／Running／150／sequence／ghost秒轉ms／rebirth／CBanChief與server UUID binding           | 非完整戰鬥事件或restart恢復；pure150 builder仍只編碼                                                  |
| `OnRequestGenerateGhost / DestroyGhost`      | 真native Running151／152、166／167、雙向mapping／時間gate／signed count                             | 不由ghost生成推論復活裁決；不捏造死亡／map gate，詳見[Ghost](Ghost.md)                                |
| `OnRequestAirplane 0041D7C0`                 | 真native Running156／171、absolute ADD gate／future marker／box-item state重設                      | 不自行選item／配置sync；opaque三byte與count hardening見[Airplane](Airplane.md)                        |
| `OnRequestEatItem / EatObstacle / EventItem` | native Running144／145 claim與149→raw30，Type99另有durable wallet／receipt，完整group與body防護     | money協調見[MoneyPickup](MoneyPickup.md)；throw沒有ordinary153入口，來源見[ItemPickup](ItemPickup.md) |
| `OnReqEatBula / OnLapInfo / event8`          | native160／177 flat state、155／170 unsigned64排名、146 case8雙opaque echo                          | 不捏造actor／進度／復活授權；house5money仍需durability，見[GameClaims](GameClaims.md)                 |
| `DeferResurrection 0041B5C8`                 | 與PE相同的C3／無副作用                                                                              | 不是遺漏body，不額外從Update呼叫；原client復活玩法尚無證據                                            |
| `Update 0041DC31` Loading                    | join-relative strict25s、mid-loop非playing30s、整批preflight／table移除／survivor start／195／pool4 | practice／特殊恢復仍缺；ordinary waiting見[WaitingChief](WaitingChief.md)                             |
| `CUdpLossRegulator 004161AC..004165C0`       | 64-entry graph、8秒batch、non-consuming選人／Running table移除／195／pool4                          | 沒有service或scope不支持仍保留graph先拒絕；非可靠故障偵測                                             |

細節、2756組新reference及真TCP+UDP連續兩輪見[GameLaunch](GameLaunch.md)；**不等於原client或整場可玩**。

### 相同名稱不等於相同 handler

`.lst 0041B506` 與實際 PE 的 **`C2 18 00`（`retn 18h`）** 證實：接收 UDP 的 `OnReadyForImmediateStart(CUser*,...)` 多載是空函式。反編譯 `.c` 沒有一般函式 body，不可從同名的另一個多載推斷它有相同行為。真正 TCP `109` 呼叫的是 `0041D431`。

`IsAllPlayerReadyForStart 0041AFFE` 必須有至少一位玩家，且**每個 occupied slot** 都滿足：peer flag 已收到，並且 `(slotStatus & 1C) == 08`。`04`、`0C` 或只有 CRC 通過都不夠。雙人同一 socket 仍要兩個 slot 都核對，但都使用同一組 observed／advertised endpoints。

載入回報中四個 byte 的順序是 **actual bomber index、default bomb count、default bomb power、default speed**。等待房間 random sentinel 是 `10`，實際抽到的特殊角色可為 `8 / 9`；不可拿 sentinel 去查屬性。map CRC 依實際 selected map，比較的是完整資源 CRC，不是 map index 或 opaque header word。

### 角色與出生點的硬編碼

`LaunchGameStage` 先建立 `0..mapMaxPlayer-1`，依 STL `random_shuffle 0041DAFD` 的 **forward shuffle** 消耗 `mapMaxPlayer-1` 個抽樣；不是僅洗目前人數，也不是反向 Fisher–Yates。接著按 occupied slot 遞增分配出生點與角色：

- 非 random 選擇直接保留；random 時先 `rand()%30`。
- 非零分支：`rand()%normalCount`，此 archive normalCount=8。
- 零分支：從第一個 random-only index=8 起，第二次 `rand()%3 != 0` 時加一，選 index=9。
- 29/30、1/90、1/45 是**名義權重**，不能忽略 CRT modulo bias／抽樣相關性後聲稱為精確實測機率。
- 實際 PE `rand 0046EA5F` 最後為 `shr eax,16; and eax,7FFFh`；此移植預設提供獨立 CSPRNG 15-bit draws，**不重現原 CRT thread-local seed／序列**。測試可注入固定 draws，核對消耗順序。
- 原 normal `LaunchGameStageEx 004209B9` 也是實際 `C3` 的空函式；practice 的不同 extension 不能硬套。

116 的普通模式 prefix 為 tick DWORD、selected-map WORD、player-count BYTE；各人為 slot、captain=0、spawn index、actual bomber、color。mod／guild／practice 變體尚不由此 helper 支援。正式ordinary native launch亦已執行`CDynInfoCalculator`、隊伍統計、context、mission／ghost／airplane等初始化；pure116 helper仍不代替此commit，不能只憑bytes相符跳過其餘動作。

150 四個 DWORD 依序為 clock start time、`sequence XOR key`、ghost-start **秒數**、ghost-frequency **秒數**；native 是送完這些值後才把本地兩個倒數乘 1000。map 22 `Cemetery02` 的 40／20、map 194 `Tomb15` 的 50／3 都已測試，不誤用飛機的毫秒欄位。XOR DWORD 的意義仍保持 opaque，不稱為安全 anti-cheat token。

### Peer 記錄、逾時與 loss graph

`MTUDPServer::StartupBase 0042E55A` 綁定 **GS TCP port + 1**。`MTUDPServer::Proc 0042E367` 在交給 `HOSTHANDLE` 前先做 `ntohl/ntohs`，所以 address／port 是 host-order 整數；**不是 raw `inet_addr` DWORD**。native handle 8 bytes 包含 2 bytes padding，wire 只寫六個有效 bytes。

`OnUDPPeerInfo 0041CE45` 為每個 slot 保存三個 host：observed、兩個 advertised。只在 address 非零且與前面完整 address+port 不同時寫入該 candidate **原本的位置**；不壓縮重複造成的空洞。同 IP 不同 port 不是重複。每個 local player 都得到同一份記錄。已收到的 socket 群組不因重送而改 endpoint；普通離房清peer flags／endpoints但**保留join timestamp／actual bomber／player states**；slot reuse再依AddUser重設自己負責的欄位。

TCP 120 的八個 presence byte 代表 **slot 有沒有玩家**，不是 discovery 是否完成；occupied 但未 discovery 者仍有 3 組零 host。末端 DWORD 來自 `AddUser 0041AF4B` 記下的 **加入時間**（native +12948），不是 global serial。25 秒從這個 join time 開始，不從 116 發送重新計算。`.lst 0041DF94` 與 `004165AC` 均為 unsigned `jbe` 的未到期分支，故恰好 25000／8000 毫秒都還不算到期；rollover 仍以 DWORD 差值計算。native 在逐人移除期間若 playing 變 false，可能改採 30000 ms；正式Loading traversal已逐筆重查這個門檻；pure候選helper本身不代替changing-state移除driver。

185 `OnNotifyUDPLoss 0041D0BC` 與 186 `OnRequestUDPRelay 0041D6E7` 都只讀**一個 target slot byte**，向 **target socket** 送 `54 + reporting primary room slot`，不是回一串 peers 給 sender，也沒有新 endpoint／token 欄位。186 另要求 sender 的 native +11604 state **不等於 1**；這是多值 state，原 Update 也讀取值 3，不能把它改成 boolean。54 的 bytes 與路由已確認，原 client 收到後的完整行為仍未驗證。

**已解的 `CUser+20`**：`CUser::CUser 0041784E`／`.lst 0041789A..0041789F` 在 `this+16` 建構 `CSafeObject`；`IsSetFree 00408DE9` 讀該 base 的 DWORD+4，合計正是 CUser+20。`SetFree 0042EB8C` 先 `InterlockedExchange(flag,1)`，僅第一次呼叫 virtual `SafeFree` 並回 1，重複回 0。185／186 的 **target** guard 因此是「尚未標記釋放」，**不是 `GetSelfidx()==0`**；target 可為同 socket 的 secondary slot。這與 regulator 的 primary eligibility 是兩種不同條件。新增 `Common/CSafeObject.ts`、target guard 與實際 PE bytes 回歸錨點。

真正 dispatch 的 187 在 running 時呼叫 regulator；不要誤把另一個未經此 dispatch 呼叫的 `OnNotifyUDPPacketLoss 0041CAD9` 當作完全相同的入口。regulator 使用 reporter-row／target-column 的 8×8 DWORD boolean matrix：

1. 同一 socket 的全部 local players 都標記一列，重複回報仍為 1，不累計票數。
2. 第一筆有效回報記下 batch 起點；新增回報不延期。pending flag 與 timestamp=0 分開。
3. 經過 **大於 8000 ms** 才調節，只在 `GetSelfidx()==0` 的 primary slots 之間計算。
4. 先選最高 incident degree，平手取**最少 outgoing reports**，再平手取最低 slot。self-edge 的 degree 加二。
5. 在copy上清該 row／column，模擬整個 socket 離房後重算；pure consuming kernel隨後清原matrix／pending，實際Running adapter則等支持的table batch完成才清。

Native `RegulateConnection` 每批另外消耗一次 `rand()%10` 判斷是否印出 diagnostic matrix；純 kernel 省略 logging 與這個 RNG draw。因此即使手動注入 CRT seed，也不可宣稱跨功能 native stream parity。真正 ejection 已在可信ordinary Running Update接線：table移除後，檢查**primary** `IsSetFree`／live TCP，再送空195、切unnamed pool4。詳見 [PlayerRemoval](PlayerRemoval.md) 的原碼順序、群組／ghost／chief／sync與現代preflight／batch差異。

這**不是投票多數／真實網路故障的證明**：單一 A→B claim 就可能讓 native 選中 B。移植保留其選人語意，沒有捏造 quorum 或宣稱具有安全性。non-consuming plan完成支持scope的table移除後才清graph；不是可靠故障偵測。Loading另有join-time driver，不以Running graph代替。

### 明確的現代差異與阻擋

- 新 `FXGS.UDPEnabled` 預設 false；不開放未經驗證的原所有 MTUDP 功能。listener 僅接收資料，不發 UDP ack／反射／轉送，不建立任意 host map。
- 全 datagram 驗證成功後才 dispatch；原程式可能先排入有效 prefix，再發現後段 CRC／長度錯誤。雙人群組亦先整組驗證再設 flags，避免 native 逐筆檢查留下半更新。
- Native `cUnreliableQueueIn::AddPacket 004284B9` 忽略 empty payload；`GetPacket 00428565` 每次取一筆，dispatcher 隨後 `HostDestroy 0042DB30` 透過 `cHost` 析構清掉其餘 queue。因此同一 datagram 僅 dispatch **第一個非空 frame payload**，即使它是 type-1 no-op，也不繼續跑後面的 11。本 adapter 保留這個單 datagram 效果，但**不模擬跨 datagram 的 thread batching／race／RB-tree dispatch 順序**。
- resolver 檢查**整個 local-player group** 都仍由同一 GS 擁有、未 marked-free 且無 pending transfer；另核對 live TCP IP、room generation 與 slot identity。無效 UDP 不照原 invalid-index 分支去斷掉被指名者的 TCP。
- 速率／來源數上限在 `RuntimePolicy`，不冒稱 native 規則。IP 比對不能排除同 NAT 已知 serial 或來源位址偽造；**沒有 UDP 密碼學 ownership proof**，不應作為通過安全審查的公網服務。
- 無效／不完整／空 target 的 187 不啟動 loss batch、不留下半份 matrix；native 會先設 pending 再讀 target，並不拒絕空 target。這是額外防禦，不偽稱 byte-for-byte error-path parity。
- `CSafeObject` 只移植 terminal mark／一次性 virtual hook；Bun 單 event-loop 下同步檢查，不假稱跨 worker 原子指令或完整 native collection lists／dirty-user DB flush。行程內 Center 共用同一 CUser 轉服，故 `ClearAttachedUsers` 刻意僅 detach；最終 global-table deletion 才 SetFree。原各行程會 SetFree 自己的 service-local copies，不能直接照抄到共享實例。
- `m_aPlayerState`／endpoint records 在進入 network handler 前先定義初始化；這不假裝重現 native pre-launch 未初始化記憶體。已核實的 0..7 分支見後節；state4 的起始語意與完整 timer／event driver 仍待核對或移植。
- `CGameClock.GetCurrentTime`、兩個 packet builders、timeout candidate helper 與 regulator 回傳候選 socket 是抽出的移植 API，不冒稱完整原方法。預設 `performance.now()` 與原 WinMM boot epoch 不相同，也尚未完成 native 網路 clock 同步。
- `RequestStartGame`／`DeferStartGame`已支援ordinary native generation；只有手動建loading／缺private token或service的情況仍先拒絕。production launch需UDP opt-in；active網路103進入未移植Mod先拒絕，而native原碼允許，這是明確scope差異。400ms timer涵蓋ordinary waiting-chief／Loading／Running／Result，waiting另見[WaitingChief](WaitingChief.md)；見[GameLaunch](GameLaunch.md)／[GameUpdate](GameUpdate.md)。

## `CDynInfoCalculator`：統計與獎勵核心

來源為 `0040B1BE..0040B6EB`、getters／setters `0041AAF1..0041AB68`，以及 `LaunchGameStage 00420BB3` 的隊伍配對區塊。`Common/CDynInfoCalculator.ts` 現已具備 instance 計算，不再只有 `GetLevel`。

- native object 共 **596 bytes**：population +4、overall mean +8、team means +12、player weights +44、64-DWORD saver/victim matrix +76、save counts +332、kill counts +364、opaque +396、Nice +428、colors +460、team counts +492、MyTeamNo +524、OtherTeamNo +556、explicit premium +588、invalid +592。`DynInfoLayout` 集中保存 DWORD offsets；`GetStateBytes()` 只回傳 detached audit copy，+0 為 0，**不是原指標、網路結構或可載入存檔**。
- `Init` 清除 counters／matrix／premium，未佔用 color=-1。權重是 `sqrt(level+100)`；overall／team 的逐筆總和、player weights、最後平均值都在原 `FSTP DWORD` 點儲存 **float32**。不可只在最後才 round，也不可每個算術中間值都 fround。
- 初始 invalid=1；至少出現兩個**不同 socket identities** 才清成 0。同一 TCP 的兩位本機玩家、即使不同隊，也仍 invalid；不同 TCP 但同一隊則不因此 invalid。
- `Init` 本身不計 `MyTeamNo`／`OtherTeamNo`。新增 **`PrepareRoundStatistics()` 移植 helper** 先 Init，再含 self +1、逐個 unordered occupied pair 累加同隊／異隊。這兩欄是同隊（含自己）／異隊的**玩家人數**，不是不同隊伍的數目。此 helper 不送 116／150、不改 playing／stage、不開 clock、不清其他 kernels，也不是完整 `LaunchGameStage`。
- `SetKillerIndex(victim,killer)` 原本**忽略 victim**，每次都增加 killer；不按死者去重。`SetSaverIndex(victim,saver)` 則依 `[saver][victim]` 去重，含同一 slot 的配對。`SetNice` 已保存，但已讀獎勵公式沒有讀它，不自行增加獎勵。

令 `N` 為人數、`A` 為 overall mean、`n_c/A_c` 為該隊人數／mean、`w_i` 為該人的儲存權重，`K/S` 為 kill/save count：

```text
B(f) = N*A*f/(n_c*A_c) * (w_i/A_c) * 0.5 + 20*K + 20*S
Money = clamp(trunc(trunc(300*N/n_c)/2), 200, 450)
Win   = clamp(trunc(B(100)), 50, 200)
Draw  = clamp(trunc(B(10)),   0,  50)
```

Win／Draw 在 clamp **之後**，若 explicit premium 非零 **或** premium channel，才做整數 `11*n/10`。`GetKillNSaveExp` 則**只看 premium channel 本身**，為 `clamp(trunc(20*K+20*S),0,140)`，不另乘 1.1。invalid game 的獎勵為 0。`GetWinExp` 的 out-reference 原指令一律寫 0；沒有據此杜撰 lucky RNG。

數值證據另核對實際 PE：CRT `__setdefaultprecision 004768BC` 呼叫 `_controlfp(0x10000,0x30000)`（53-bit precision）；`__fpreset 0047E755` 在 FNINIT 後呼叫它。移植使用 binary64 中間運算與對應 float32 stores；**這是靜態證據與人工參考比對，不是執行原版，也尚無完整 native thread/FPU 環境的動態 oracle**。

`GetMaxExpInLevel` 的 IDA `int*` 型別是誤判，實為 threshold 數值，越界為 `INT_MAX`。`GetExpPercentage` 回 per-mille，先作 signed32 wrapping `IMUL 1000` 再 `IDIV`；負 exp 測試不得先 clamp。實檔非負 level spans 均不會令該乘積溢位。最上級因 upper sentinel 回 0。`Tools/ExtractProtocolTables.ts` 現會比對 **LS 0048E160／0048E868 與 GS 004A84B8／004A8BC0 的 450 個 DWORD 完全相同**，而非只假設能共用。

現代防禦明確分開：佔用 colors 8..31 在原版會越過 8-element arrays，此處拒絕；detached／closed-socket／marked-free／duplicate users 與 room/socket generation 錯誤，在清除既有統計前一次驗證。未 Init 的 getter 拒絕執行；查詢 vacant slot 獎勵回 0，不重現 native 不合法呼叫的 array−1 存取。這些不是原 error path parity。

## 結果分類與純終局判定

- `GetWinGameResult 0041B482`：己方 `MyTeamNo >2`，且存在異色隊 `MyTeamNo >2`；**全部八個** state bytes 等於 2／6 的總數必須等於己方人數。最後計數不過濾顏色或 occupancy，亦不計 state 5。
- `GetGameDetailResult 0041CA78`：fallback=3 僅當 **FXGS authencode byte==1**。kill count>2 且等於 OtherTeamNo 時=1；再滿足 MyTeamNo>2 與 saveCount+1==MyTeamNo 時=2。`SetAuthenCode 00408148`／`GetAuthencode 00408E22` 已確認為 `CUser+2004` 的 byte，**不是 TicketDate、是否過期或任意非零值**。
- `GetGameEndDecision()` 為抽出的**純讀取 helper**，其本身不執行 `DeferHandleGameEnd` 的副作用。未 forced 且有 occupied state 0／3 時等待；occupied state 2／5／6 提出顏色，異色 claims 回 draw。實際 `0041D347..0041D354` 證實 force 條件是 `(occupied && state==5) || state==6`，連空 slot 殘留 6 都可 force。
- native 遍歷中會 `IncGame`，但遇到不同色的第二個 claim 就中斷，因此不是「所有玩家一律先 +1」。helper 的 `CountedSlots` 只描述這個 prefix，**不真的遞增供 flush 排程使用的場數計數**。
- 另有可信 `BeginResultLifecycle` 管理的一般 `DeferHandleGameEnd`／result-return tail，會在 SQLite 原子回執成功後才執行上述副作用；**純 helper 本身仍無副作用**，另已接ordinary native start及Loading／Running／Result Update，ordinary waiting-chief另見[WaitingChief](WaitingChief.md)，practice／特殊模式scheduler仍缺。不以勝利宣告當作完整權威性／防作弊證據。

## 結果 163 預覽與使用者動態核心

`SendGameResult 0041FF51` 已逐段核對 `.c`／`.lst` 與 PE constants。decorated signature 只有 **一個 winner-color 參數**，IDA 額外標示的 EDI 參數與 GetWinExp 未定義參數是反編譯 artifacts。**`MakeGameResultPreview` 是純移植 helper**：使用 detached calculator／CUser copies，回傳預期變更與 scalar-coded packet，不變更原 users、calculator、clock、stage、DB、rank list，也不傳送封包。

### 經驗值、分類與前綴

- 使用 unsigned `ElapsedTime`，`t <=15000ms` 時 ratio=0，`15000<t<=45000` 時為 **`f32((t-15000)*f32(1/30000))`**，超過 45000 時為 1。PE `0048F5E0` 的 coefficient bits 為 `0x380bcf65`；不是直接用 double 除法。最後 XP 計算仍用 double 乘法，再作向零截斷。
- 函式內只修改 **Exp／Win／Draw／Lose**，**沒有呼叫 GetIncMoney 或獎勵 money**；不能把 calculator 的 money getter 擅自塞入 163。遊戲內道具的money delta是另一條路徑：native算術／detached preview已還原，網路Type99另經SQLite CAS＋receipt與live coordinator，見[MoneyPickup](MoneyPickup.md)。
- winner=-1：category3／draw；否則以**目前 slot color**區分勝者 category0／1（GetWinGameResult 的 boolean）與敗者 category2。即使 duration 令 XP=0，只要 invalidGame=0，仍執行 IncDecExp(0) 及 WDL 遞增；invalidGame 非零才跳過兩者。
- 每名 occupied user 計算前，explicit premium 會重設為 `authencode byte==1`。non-premium channel 的初始 detail3 只給 auth1；有效勝者另外呼叫 GetGameDetailResult，可覆寫為1／2／3，**premium channel 的勝者仍可能有 detail3**。最終只有 detail3 且 delta=0 時清成0；detail1／2不因此清除。
- session `+11652` 的 8-DWORD flag 已找到 writer：`OnSetBomberEvent` kind0／`0041EF15` 在非零 shop-item quantity 時，**inventory lookup 成功之前**就設為1；完整 launch 清零。故命名為 **shop-item attempt**，不是成功消耗、cash／billing 或 authority。case0現已另以[SpecialItemUse](SpecialItemUse.md)實作paid消耗；不同於native先寫flag／扣量再驗Type，移植完整preflight／durable確認後才一起設Shop與calculator.Nice。不能由預覽 helper假裝已消耗。純統計準備也不冒充 full launch 去重設它。
- 若有 occupied、**目前色不同於 winner**、attempt flag 非零的玩家，prefix 的 shop flag=1，勝者 XP multiplier 起始改為1.05。另當該收獎人的 **cached MyTeamNo>=2** 且至少兩名仍 occupied、**cached calculator color==winner** 的玩家 auth1，再加 double 0.1。不能把這兩種 current／cached color 用途合併，也不能漏掉收獎人 own-team-size 條件。draw／lose 不套用此勝者 bonus。
- 第一個 prefix byte 檢查**全部8個** state 是否有5／6／7，含空 slot；shop flag 則必須 occupied。strategy `GetResultViewType 004216CF` 與 room virtual+156 **`IsLadderGame 004209A6`** 在普通策略都是0，另有 PE vtable／指令測試，不能將後者誤稱 GetExtraPlayerNo。

163 body（不含 opcode，全部仍有正常 scalar XOR）：

```text
u8 hasLapOrHouseState, winnerColor(-1->ff), resultView, isLadder, differentColorShopAttempt
for each of 8 slots:
  u8 present
  if present:
    u32 globalSerialNo
    u8 category, killCount(low8), saveCount(low8)
    u16 oldExpPerMille, newExpPerMille, lookLevel
    u8 levelUp, detail
```

old percentage > new percentage 時，old 會改寫0。`levelUp` 是 **IncDecExp 回傳值>0**，不是有獎勵的 boolean；body 中沒有 XP amount、money 或永久總場數。普通策略結果 callbacks 已證明 no-op；guild plugin 未移植，預覽明確拒絕 guild。

### `CUser` cache、dirty flags 與 flush 場數

- `GetLevel 0040312D` 讀 cached level；`SetLevel 00416874` 才從 Exp 計算。native ctor 先設0、載入資料後明確 SetLevel；本移植 constructor 收到已載入的 `_USERINFO`，因此在該處初始化 cache。直接改 `m_userInfo.Exp` **不會再隱含刷新 cache**；原有兩個可信測試 setup 已補 SetLevel。
- `IncDecExp 00416A1D` 作 signed32 wrapping ADD，再將負結果 clamp0；無論 delta 是否0，dynamic dirty=1。新 level 不同時更新 cache、simple-info dirty=1，回傳 **-1／0／+1 的 level direction**。正 XP 也可能溢位回0；cache 不一致時甚至 delta0也能觸發 level direction。不是回傳已加的 XP。
- `IncDecMoney004090EC`先signed32 ADD，再clamp0..1,000,000；delta0／飽和仍dynamic dirty=1，不改cached level／simple-info／games counter。這不是SQLite storage bound或shop cap；網路必須先確認其durable receipt再套用成功。130個獨立C++ transitions與810個money previews見[ItemPickup](ItemPickup.md)；810組亦另驗完整money coordinator，見[MoneyPickup](MoneyPickup.md)。
- `GetLookLevel 00416E47` 將 cachedLevel+fakeLevel 作 signed32 ADD，clamp **1..450**。`SetFakeLevel 00408DF1` 與 `SetLevelIcon 00408DFE` 是分開的欄位，後者不是 fake-level setter。`AppendSimpleInfoPacket` 已改用 look level 並遵循獨立 icon enable／SN。
- `IncWin／IncDraw／IncLose 0041D1C1..0041D219` 作 signed32 遞增並標 dirty。`IncGame 0041D245` 只增加 unsigned **自上次 flush 累積場數**，不改 dynamic dirty；`DeferFlushModifiedInfo 00417603` 在 force 或該數 **>=25** 時重設計數並處理 dirty。這不是永久總遊戲數，也沒有偷偷新增 Games DB 欄位。`SendGameResult` 本身不呼叫 IncGame。
- 另已修正 GS 可信 account reload：替換 `m_userInfo` 後明確 `SetLevel`，inventory全組讀取成功才消耗transfer，然後插入rank。沒有讓一般直接寫 Exp 隱含刷新。
- 已有 in-memory 算術／flag intent、detached clone／audit snapshots與一般durable result tail；**沒有接 native 25場flush driver／collector**。結果每場持久化是現代政策；native dirty／counter算術照留，不把它當 durable ack。snapshot 不是原 object layout、client format。

### SQLite CAS與durable結果邊界

`CDBMan::WriteUserDynInfo 00408FD2` 對 `prUpdateUserDynamic` 綁定 ID 與**絕對值** money／exp／win／draw／lose，不是 delta，也不寫 TicketDate。native flush 方法在呼叫 writer 前已清 dirty；不能直接照抄當成已成功持久化的保證。

新增 **`UpdateUserDynamicBatch` 是現代 SQLite 防護，不是原 stored procedure 或跨玩家原子性 parity**：一批最多一房人數，先驗全部 ID／數字／ASCII-NOCASE duplicates，`BEGIN IMMEDIATE` 中逐筆比較 Before 的全部五個數值（含未改的 Money）才更新 After。缺使用者／任何末筆 stale conflict 都整批 rollback 並回 false；真正 SQL failure rollback 後仍拋錯。保留 TicketDate／account 欄位，不修改 live users、dirty flags 或封包。native counter wrap 成負數時仍在 storage boundary 拒絕，不偷偷寫0。

**這個 base CAS 本身仍不是 durable round receipt、ABA 防護或 exactly-once 結算。** 測試刻意證明恢復舊值／before=after能再匹配。FXGS subclass的 `CommitGameResult` 才另以 server UUID、canonical digest、固定163 bytes與immutable receipt，將 receipt insert和全部五欄CAS放在同一交易；no-op／invalid／空房也留回執。相同key／request回duplicate，不再付獎；changed request拒絕。SQL conflict不留回執，錯誤整批rollback。

一般 `DeferHandleGameEnd`／`UpdateResultLifecycle`／`DeferReturnPrepareStage`／`DoReturnPrepareStage` tail已存在，由正式ordinary native start或可信fresh preparation+running hook啟用。保留 source IncGame prefix、逐人XP/WDL→rank、claims與timeout不同時計順序、strict >180000 active-time cutoff及strict >8000回準備；164 byte0先於重設。**只清playing map，不清selected map／player-state／calculator**；native+828已解為pending ban target serial。guild／Mod／BangPok fail-closed，不假稱完整 lifecycle。

完整原始時序、重新排序的現代持久化政策、凍結plan／SQL retry、rank ownership，以及**未提供**的restart round恢復／exactly-once傳送／判勝授權，見 [ResultLifecycle](ResultLifecycle.md)。正式ordinary launch／Loading恢復已接入，舊kernel測試仍使用trusted running；真網路重複開局見[GameLaunch](GameLaunch.md)，不是原client可玩。Loading／Running／Result排程、6／10秒死亡、批次159及UDP恢復保護見[GameUpdate](GameUpdate.md)。

## `CGameContext`

`CGameSession` ctor `00420A96` 在 +1184 建立 **1 個** context；native size `0x288C = 10380` bytes。`Init 0041CD9B` 並非任意清空整個 struct。

| Native offset | 保存內容                        | Init 的行為                             |
| ------------- | ------------------------------- | --------------------------------------- |
| 0..31         | 8 個 house／color counters      | 清 0                                    |
| 32..3031      | 150 × 20-byte bomb records      | 重設有效筆數，並非要求覆寫每個舊 record |
| 3032..4031    | 250 個 box-item DWORD state     | 清 0                                    |
| 4032..4811    | 13×15 obstacle DWORD state      | 清 0                                    |
| 4812／4816    | 有效炸彈數／下一個 u32 serial   | 清 0                                    |
| 4820..4851    | 8 個 player-state timestamps    | **不清除**                              |
| 4852..4915    | 8 個 CPoint                     | **不清除**；ctor 原本初始化 points      |
| 4916          | 下一個 generated box-item index | 設為 **126**，不是 0                    |
| 4920..9599    | **26×45** Bula DWORD state      | 設為 -1                                 |
| 9600..10379   | **13×15** house DWORD state     | 設為 -1                                 |

`AddBoxItem` 回傳 126..249，耗盡後回 -1。Bula 與 house／obstacle 使用不同 stride，不能共用一個 13×15 陣列。`SetHouseState` 指定的 color 決定增加哪一個 counter，不是把 state 值當 color。

TypeScript `CGameContext` 仍需明確呼叫 `Init()`；`CGameSession` 建構時會先初始化，避免在網路入口接觸未準備狀態。`AddBomb`、`KickBomb`、`SetBombTimer`、`AdvanceBombTimers` 是從 session handler／Update 區塊抽出的**移植 helper 名稱**，不是假稱 native `CGameContext` 本來有這些符號。

## `CGameClock`

來源：ctor `0041ABBF`、`GetRealElapsedTime 0041ABCF`、`StartGame 0041B843`、`EndGame 0041B858`、`ElapsedTime 0041B866`、`ResumeGame 0041B874`、`SuspendGame 0041CE1F`；session 內 clock 位於 +12732。

4 個 DWORD 依序為累積暫停時間、開始、結束、當前 suspend 起點。數學運算保留 unsigned DWORD rollover：

- `ElapsedTime = now - start`，**不會**因 suspend 或 end 自行凍結。
- native 呼叫者另行扣除累積暫停時間。
- `GetRealElapsedTime = end - start`；`.lst` mangled return 為 `QBEKXZ`，是 unsigned long，即使反編譯顯示 int。
- `StartGame` 重設累積暫停／end／start，**不重設 suspend 起點**。
- 重複 suspend 會記錄 mismatch、先 resume 再 suspend；未 suspend 就 resume 也記錄 mismatch。
- native 的 0 timestamp 是 sentinel；沒有為了看似方便而改掉這個邊界行為。

移植可注入 monotonic time source 及 mismatch callback；預設 clock 的 callback 不執行額外業務動作。原 WinMM 與 Bun `performance.now()` 不保證相同 epoch、解析度或排程；額外的 `GetCurrentTime()` 是依賴注入 helper，不是新發現的 native method。

## 已接入的部分事件與受限Running／Result scheduler

所有以下入口先要求實際 running phase、同房 membership；帶 actor 的事件再核對 room-slot ownership。waiting、loading、result 封包不能把房間提升到 running。

| Request | 原處理方法／VA              | Response／行為                                                              |
| ------- | --------------------------- | --------------------------------------------------------------------------- |
| 140     | `OnBombIgnite 0041E5AC`     | 153：u8 slot、u8 position、u8 attributes、u16 serial                        |
| 141     | `OnBombKickThrow 0041E74E`  | 154：u8 action、u16 serial、u8 destination；不回 old position／timer        |
| 142     | `OnSetBombTimer 0041B1B4`   | 匹配 serial／位置且 stationary 才縮短 timer，並清除 paused flag；不另造 ack |
| 143     | `OnMovableBoxMove 0041B264` | 155，4 個 byte                                                              |
| 148     | `OnDropObstacle 0041B2E0`   | 清該位置 obstacle，161，排除 sender socket                                  |
| 150     | `OnDestroyBox 0041B376`     | 165，3 個 byte；不憑此杜撰新的掉落／碰撞結果                                |
| 147     | `OnSetEffect 0041CA14`      | 160，原 opaque bytes，排除 sender socket                                    |
| 146     | `OnSetBomberEvent 0041EE05` | 部分事件 →159；Normal death 含完整 drop 清除，詳見下節                      |
| 154     | `OnLapFinished 0041FDA7`    | 只讓第一個 occupied lap winner 變 state 5，不發結果                         |
| 162     | `OnShobuari 0041CC68`       | 空 payload；依 eligible colors 的 house counters 更新 state 6／7，不發結果  |

炸彈 record：u32 serial+0、u8 state+4、signed int32 remaining-ms+8、u8 row/column/power+12/13/14、paused DWORD+16。

- position 高 nibble 是 row、低 nibble 是 column；attributes 低 4 bits 是 power、`0x40` 是 remote pause。其他 bits 仍照原封包轉送，不杜撰意義。
- ignite fuse=2800 ms；moving=1，stationary=0。moving 炸彈即使 paused 也扣時間。
- moving 到期先變 stationary 並取得 2000 ms fuse，emit landed=1；stationary 到期 emit landed=0 並以 **swap-last** 移除，不能使用穩定 `filter` 改變後續順序。
- Update 的 152 為 `u8 count + repeated(u16 serial, u8 landed)`；沒有事件時不送空通知。
- `UpdateBombTimers`仍是抽出的kernel API；新的guarded `Update()`共用其packet maker，已串起ordinary claims／timeout、爆彈、pending死亡及164回準備，並由400ms timer驅動**native／可信綁定round**。受困到期為6／10秒unsigned `>=`，全部狀態更新後才發布152→grouped159；最後死亡在下一tick才結算。ordinary Loading及UDP ejection亦已接通，ordinary waiting-chief另已接線，practice／特殊流程仍缺，不等於完整Update。[GameUpdate](GameUpdate.md)列出來源、現代差異與開局審核。

### 146 的已確認子集與限制

共同 header 為 `u8 packed(event高4bits／slot低4bits), u16 x, u16 y`；這些為 **TCP scalar-coded fields**（BYTE XOR 5a、WORD XOR a569），不可把 raw buffer 誤當 plaintext。x/y 保存成 CPoint，**不是** 13×15 tile indices。

| event | 請求額外欄位／狀態                                                                                                            | 159 的轉送                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 0     | `u8 opaque,index,quantity`；正quantity另有`u32 SN`；獨立inventory receipt／Shop／Nice；Type22且state3只刷新time               | header＋三byte，**不帶SN**，排除整個sender TCP |
| 1／7  | 不讀額外欄位，不改 state                                                                                                      | 共同 header，排除整個 sender TCP               |
| 2     | state=3；記 elapsed time／CPoint                                                                                              | 共同 header，排除 sender                       |
| 3     | `u8 saver`；小於8才累加去重 save；state=0                                                                                     | **不帶 saver**，僅 header，排除 sender         |
| 4     | `i8 killer`（−1 不計 kill）、`u8 count`、重複 `(u8 tilePosition,u8 boxIndex)`；清每筆 box／obstacle；state≠4 才設1並更新 time | header＋killer＋count＋pairs，**包含 sender**  |
| 6     | state=2 的勝利 claim                                                                                                          | 共同 header，排除 sender；不結算               |
| 8     | `u8 opaque0, opaque1`；不改state／clock／ghost，兩byte都保留                                                                  | header＋兩opaque bytes，排除整個sender TCP     |

已完整讀取 `OnBomberDie 0041BFAB`：Normal mode 沒有額外副作用；Mod 的 captain death 還會依隊友 Exp／state 作連帶淘汰與 server-generated event-5，**仍未移植**。所以 event 4 現僅允許 Normal，而非只加 kill count 就假稱完整 death handler。

0已接免費relay及paid inventory consumption／獨立receipt；Type22只刷新state3 timer、不改state／位置，來源與201修正／native ItemSn／StockSn映射限制見[SpecialItemUse](SpecialItemUse.md)；8已接完整兩opaque bytes echo且不改state／ghost／time，來源見[GameClaims](GameClaims.md)；原 client 送5會記 log 後轉送，本移植改為明確拒絕 server-only 事件。所有已接入事件要求 running、完整 socket group／generation／actor ownership，146 另需已初始化統計；truncation／trailing data、killer index、drop box/tile 越界皆先檢查完才改 counters／清 drop。**這是現代防禦，不假稱 native 解碼中途副作用與錯誤路徑相同。** saver≥8 按原版忽略並恢復 state 0；有效範圍內的 saver/killer slot 不自行加上原版沒有的 target occupancy 規則。

`OnShobuari` 不讓 state 1／4 所在的 slot 使該色成為候選；只看候選色的 house count。最高分平手／無候選時，所有 occupied slots 變7；唯一最高色的非1隊員變6（含同隊 state4）。另有更高色時要清除先前 tie flag。phase／membership checks **不證明 client 在正確時點呼叫**，也未自動觸發結果。

144／145及149公告已接真正native Running，Type99另有wallet CAS＋receipt／pending guard；見[ItemPickup](ItemPickup.md)與[MoneyPickup](MoneyPickup.md)。鬼魂151／152、飛機156／171及state3的受限6／10秒死亡driver亦已接；Bula160／177與155／170圈次資訊已另接，case8只echo雙opaque。DeferResurrection已核對為native C3；不再把空hook當待補引擎。house161每新格的5money已與board／color counts／allocator經獨立schema4 receipt耐久協調後送178，詳見[HouseClaim](HouseClaim.md)；case0亦已另接inventory耐久協調與Type22 timer，其餘道具／AI／mission／特殊模式與state4起始語意仍待來源確認。以上不是完整player-state driver，詳見[GameClaims](GameClaims.md)。

## `CSyncGameObjMan`

來源 `00414E39`、`00415101`、`00415150`、`00415280`、`0041549F..004155D8`。

- object→slot map 與 8 組 owned-object set；委派給 occupied 且 **`GetSelfidx()==0`** 的最低負載 slot，平手取最低 slot。第二個 local player 不是另一個 UDP controller。
- `CUser::GetSelfidx 0041697B` 在所屬 socket 的 user array 搜尋物件 identity，與 room slot／global serial 不同。找不到或沒有 socket 就 -1。
- initial objects：175，`u16 ID + u8 controller`。
- create request 158：`u16 template + 20 opaque bytes`；174 回覆加上 `u16 ID + u8 controller`。建立間隔是**整房共用**的 5000 ms，不是每 sender 各自一份。
- clock 的 elapsed 減 accumulated pause 後，`.lst 0041550A..0041551C` 為 `sub/add/cmp/jl`，比較使用 **signed int32**。這與 clock 自身 unsigned return 不矛盾，不能只從 `_DWORD` 猜 unsigned comparison。
- destroy request 159／response 176：`u16 ID + u32 reason`。玩家離開依原 `std::set` 升冪送出 reason=0 的 destroy，不自行重委派。
- `OnGameEnd` 將 next-ID 設 -1；`Init` 才清空 maps／sets 與 create interval。

現代安全差異：本移植限制 wire ID 範圍、拒絕重複 Delegate／未 Init 的 initial-count 重設、先完整解碼再使用 interval／ID，並要求 destroy 來自所委派 controller 的 TCP peer。原 `OnReqDestroyObj` 沒有這個 ownership 檢查；本移植也在 stopped／非 running phase 拒絕或忽略遲到操作。這些不是假稱為原來就有的保護。委派本身仍不是 UDP 密碼學驗證。

## `CItemAttr` 與真實 archive

`Load 0040EA1E`／`GetItemidx 0040E37A`：讀的是 **game pickup／ship 資源**，不是 FXSS 庫存、價格或現金。

- `Attr/ItemAttr` 實際 header `[60,0]`；10 個 ship rows、71 個 item rows。
- 檔案中的 ship row 為 code、name、8 個 DWORD；item row 為 name、image-name、8 個 DWORD。LE DWORD 與 resource string 的 u32 byte length 依原讀取順序。
- item native stride 164 bytes：weight+132、opaque+136、type+140、5 個 parameters+144..160。保留未知 words，不猜為物理參數或價格。
- strings 必須 1..63 bytes；native 只在載入後對 RAM 字串緩衝做 `SimpleCipher`。移植保留 plaintext 資源字串；`GetImageName` 的原記憶體處理尚未作為等價 API 實作。
- 名稱 lookup 依序比較完整名，再以 case-insensitive `Item/Item`／`Item/` 前綴移除後比較；保留第一個 match。
- 最多 256 items；32768-byte probability table 初值 ff，依原 weights 順序填入 item index，總 weight 不得超過 32767。實檔總和 **12928**；**不正規化成 100%**，剩餘空間保留 ff。
- type **99** 的 parameter[0] 是遊戲內 money delta，含真實的 `LucciPocket1 = -1000`、`LucciPocket0 = +5000`。它們不是購買價格；signed32 IMUL／ADD、authencode1的rand()%2+1及1,000,000 wallet cap已核對／preview，並另接專用durable money coordinator；不混進原本不加money的163，見[MoneyPickup](MoneyPickup.md)。
- ship count 4096 是 `RuntimePolicy` 的防禦性解析上限，**不是還原出的 native capacity**。載入完成前不發布新資料，失敗 reload 不可部分改寫舊 rows／lookup table。

主 app 啟動會載入這份資源，唯讀 status 分開列 `gameItems` 與 `ships`；這不表示商城有貨或可以購買。

144／145與149已另接真正native round，Type99另有durable協調：zero/nonzero claim仲裁、207合法packed obstacle bytes／12組alias、local-self-before-string、原始88-byte CP949公告，以及unrouted throw／detached money preview界線，詳見[ItemPickup](ItemPickup.md)。8999個新人工C++ images／34個PE錨點由`ItemPickup.test.ts`消費；不是原client／官方execution oracle。

## 測試證據與後續接線

`GameContext.test.ts`、`GameEvents.test.ts`、`ItemAttr.test.ts` 核對原有 context／clock／炸彈／sync／資源行為；`SessionNegotiation.test.ts`、`UdpLossRegulator.test.ts`、`GameUDP.test.ts` 新增載入編碼、CRC／屬性、兩種 ready／UDP 到達順序、candidate holes、完整群組原子性、native HostDestroy 單筆 dispatch／empty-frame 行為、peer／loss 逾時、實際 UDP 與啟動 rollback。

`tests/reference/gameplay.cpp`、`tests/reference/session.cpp`、`tests/reference/scoring.cpp`、`tests/reference/game-result.cpp`、`tests/reference/result-lifecycle.cpp` 是人工逐段轉寫的固定寬度 C++ 參考。session 包含 116／120／150／raw UDP／109 body 與所有 **512 種三個 primary 的有向 graph**（含 self-edges、tie）。scoring 則包含 **48 個統計情境×5個 snapshot**、**1359 筆 level/per-mille probes** 及 **512 個終局／house-state patterns**；浮點欄位連同其他 native words 作完整 596-byte canonical 對照。scoring generator 不 import TypeScript calculator，level table 另從 LS／GS PE 提取。新增 result 參考含 **87 個結果情境與63個signed XP transitions**，涵蓋 duration 邊界、normal/premium、current/cached colors、empty-slot quirks、invalid games、level／counter overflow 與完整163 scalar bytes；與 scoring 共用獨立 C++ `scoring-model.h`，不共用 TS 實作。移出 header 後原 scoring fixture hash 不變。新的 lifecycle 參考另含162組cached rank逐人升降／不變排列、210組unsigned回準備deadline／phase／playing、35組active-time cutoff與全部256個ready-mask byte；builder先核對PE的cmp／jbe／E3 mask／serial tie比較與普通no-op。這些不是在正常測試執行原 EXE。重建方式：

```sh
./node_modules/.bin/bun run Tools/BuildGameplayVectors.ts
./node_modules/.bin/bun run Tools/BuildSessionVectors.ts
./node_modules/.bin/bun run Tools/BuildScoringVectors.ts
./node_modules/.bin/bun run Tools/BuildGameResultVectors.ts
./node_modules/.bin/bun run Tools/BuildResultLifecycleVectors.ts
```

需要 g++；一般測試只使用已固定 JSON，不需要 C++ compiler。`GameResult.test.ts`／`UserDynamic.test.ts` 另核對 detached 無副作用、frame 無 XP／money 欄位、cache／fake/icon、whole-group guards、SQLite 跨連線競爭／末筆SQL錯誤rollback／NOCASE，以及 CAS 非 exactly-once 的界線。`Scoring.test.ts`／`RoundArbitration.test.ts` 另測無效初始化原子性、premium 條件區分、飽和、authencode、部分159 wire、所有 death-body truncations、末筆 drop 非法不得先清前筆，以及僅手動prepare統計、缺正式launch services的106**仍不可開局**，避免拿kernel當完整generation。

另直接讀取 PE bytes 核對 UDP ready／normal launch extension 空函式、rand mask、`CSafeObject` base offset／field／atomic-exchange call、LS/GS level table、CRT precision initializer、percentage IMUL／IDIV、authencode accessor 與終局條件分支，但**不執行原 EXE，也不是原 client capture**。GameUDP 使用真實 UDP，但已登入使用者由受信任測試設定；舊loading／running kernel tests仍用trusted state；新增`GameLaunchIntegration.test.ts`把真LS／GS TCP登入轉服、UDP discovery、正式start、SQLite／8秒return與第二輪串起來，並reopenDB；第二輪另經nonchief156→171與throttled-count255／RTT barrier，驗未注入timer或callback也能進入飛機handler。細節見[Airplane](Airplane.md)。另加入第一輪144／145／149的exact raw30／shared claims／alias與RTT no-extra barriers，164保留／106清理，以及第二輪先用真144 claim boxes0／249再由171清除；非金錢／公告不誤加wallet；Type99另只注入真SQL COMMIT後ACK遺失，以真400ms重試、兩輪五筆receipt及SQLite reopen驗證正負money與結算保留，見[MoneyPickup](MoneyPickup.md)。全部仍不等於原client或整場可玩。

`GameResultStorage.test.ts`／`GameResultLifecycle.test.ts`／`ChannelRank.test.ts` 再驗證原子receipt、ABA/no-op、兩個真實Bun子程序同key競爭與migration競爭、schema1升級／DDL rollback、SQL失敗／lost commit acknowledgement、固定plan、native rank interleaving、可信reload、164前後狀態／重入。這不是原client、native executable或完整gameplay oracle。

ordinary selected-map／launch／Loading timeout／pool recovery／result-return與Bula／lap／case8已接通；house161的board／allocator＋5money耐久協調亦已接通；下一批主要缺漏是特殊道具與剩餘client events、各特殊模式及其waiting recovery。DeferResurrection是已證實的原版noop，不憑名稱再捏造重生引擎。完整native flush／collector、conflict後明確恢復、crash後round重建、原client復活／完整對局證據與傳送確認仍缺。不得以空結算、固定勝者或零獎勵假裝完成。
