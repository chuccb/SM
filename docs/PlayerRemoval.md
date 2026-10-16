# FXGS 離房、UDP loss 移除與 native pool4

本文件對應這批 `FXGS/FxServer.exe.c`、同一 PE／`.lst`，不是通用 BnB 規格。**沒有執行原 EXE，也沒有原版 client 整場證據。** 人工 C++ 模型是獨立靜態翻譯，不是原程式 oracle。

## 本輪接通與仍未接通

- 已還原 ordinary `CBaseSession → CListSession → CGameSession → CGameSessionTable` 的 `DestroyPlayer` 分層。`DeleteAllUser` 回到低階 pointer／slot flag 移除，不再混入整條離房流程。Session IDX／serial由table在呼叫game前清除；直接game-layer呼叫不是完整table departure API，不代替此步驟。
- 已接通可信 ordinary **Running** Update 的到期 UDP loss：不消耗 graph 的選人／整批 preflight → table-owned 移除 → primary safe-object／TCP 檢查 → 空 **195** → native pool4 → 最後消耗 graph，再跑本次 bomb／death timers。
- 有效的等待房間與 Result 也能使用普通離房鏈；ordinary Mod 的這條移除本身沒有 mode-specific hook，因此不額外偽造 Mod 死亡／結算。**Mod Update／判勝仍不支援。** Guild strategy、RoomTicket／Supreme 建房路徑、BangPok、pending ban vote cascades 仍未開放。
- **已commit的ordinary native Loading**支援完整移除／survivors `DeferStartGame`／真正150；只有手改playing flags、缺少token／statistics／services的Loading仍先拒絕。候選與可能start的survivors在任何批次移除之前preflight，不先踢一半再跳過開局。見[GameLaunch](GameLaunch.md)。
- `CTimerThreadNormal`排程private native Loading及native／可信ordinary Running／Result，不排waiting-chief／practice。network request106／deferred150須ordinary scope、UDP opt-in及durable wiring；仍不能推論整場可玩或特殊模式已接通。

## 原碼位置與順序

| 來源                   | VA／欄位                           | 已核對內容                                                                                                                                                 |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| table `DestroyPlayer`  | `00421C32`                         | 捕捉 IDX／serial；清除共享 socket 的 session IDs；只對相同有效世代做 virtual removal；最後一人則 close                                                     |
| game `DestroyPlayer`   | `0041BA8D`                         | 第一 local 的舊 slot → 清 peers → ghost → List/Base → strategy+24 → sync → chief → pool1 → flush → 清 slotidx → strategy+32 → vote/loading hooks → history |
| Base／List removal     | `0041A723`／`004238BA`             | Base 刪整組 users／socket recipients、reset106、pool1；List 是真正 pass-through，不是另一輪清理                                                            |
| `DeleteUser`           | `00419580`                         | 清 pointer，**只清 slot flag 的 chief bit2**，不是清整個 slot record                                                                                       |
| `GetSlotidx`           | `00419880`，`CUser+1960`           | 讀 stored slot，不搜尋 membership；pointer 刪掉後仍可供106使用                                                                                             |
| `SendResetPlayer`      | `00419EE1`                         | 依 local group 順序向 survivors 排106；includeSelf 只把**最後一位 local** 的106送給 leaver                                                                 |
| List `DeleteUser`      | `00423DB6`，`+152`／`+780`         | 清該 slot 的 vote；opaque DWORD matrix 清 active row／column；player count modified bit4                                                                   |
| ghost leave            | `0041AE53`，`+872/+904/+936`       | 166轉移／167銷毀；此 helper 的167**不減 ghost count**                                                                                                      |
| sync leave             | `00415150`                         | 整組 membership 已刪除後，只呼叫**第一 local** 的舊 slot；沒有 survivor 或已 stopped 就提前返回                                                            |
| chief succession       | `00423D3B`／`00423E55`／`0042404B` | 普通房第一 occupied slot；無 eligible chief 為-2；只有 !playing 才清新 chief 全 local group 的 ready/status bits                                           |
| ordinary strategy+24   | vtable `0048F7EC → 004216E6`       | 指令確實是 `C2 04 00`，native no-op，不是為方便而留下的 gameplay stub                                                                                      |
| native close           | `0048F61C → 004194DB`              | virtual+16 指向 `CBaseSession::Destroy`，**只清 IsValid+140**，不另清 playing/context/clock                                                                |
| UDP regulation tail    | `004164F4..00416544`               | table removal 後才查 primary `IsSetFree`／socket closing，送195之後寫 pool4                                                                                |
| stale packet exception | `0042233B`／`0042241E`             | room index>=255忽略；有效範圍但 generation mismatch 通常斷線，pool4例外忽略                                                                                |
| room history           | `00406F68`                         | 最近五個**不同 room indices**，FIFO；duplicate 不刷新位置                                                                                                  |

Native base memory layout為12個slot預留空間，普通 game 使用8個；matrix row stride為 **12 DWORD／48 bytes**，不是8。原碼不足以為此 matrix 指定更強的遊戲語意，故保留 `m_adwOpaqueSlotMatrix` 名稱，沒有當成另一張 UDP loss graph。

硬編碼集中於 `Common/OfficialValues.ts`：`ListSessionLayout`、`GameGhostAssignment`／`GameGhostRule`、`SessionLimit.NoSlot/NoEligibleChief`、`ClientSessionHistoryRule`、`FxClientPoolType`、`BanChiefLayout/Timing`。ghost／matrix 的新欄位名稱是按已確認角色描述，不冒稱找到了原 C++ member symbols。

### 不能清掉的離房狀態

table 先把整組 users 的 session IDX／serial設 sentinel，game 再清 peer discovery bytes／endpoints，後段才把 stored slot index 設-1；**不清** vacant player state、state timestamp、actual playing bomber、join timestamp、其餘 slot bytes、clock、calculator 的人數／隊色 snapshot。`AddUser` 可以按自己的原碼重新初始化該 slot。

空 slot state 仍會影響死亡的6／10秒選擇、win／house-state 計算。若離房者的 state3 同時到期，原版後續 timer 仍可把該空 slot 編入159；串接測試已驗證這點，不能因為「沒玩家了」就跳過它。最後一組離房時 sync 看到0 survivors，可能保留 objects 到房間失效；同樣不自行修正成全部 destroy176。

### ghost 的雙 local 特例

整段 ghost loop 執行時，**全部離房 local users 仍是 occupied**。找下一個 owner 不排除同 socket、尚未處理或已處理的 local slot。例如 slot0 的 ghost 先移到 slot1，處理 slot1 時又可移回已處理的 slot0；之後整組 pointer 才刪除。移植保留此可由原碼重現的行為，沒有自作主張改成只向 survivors 轉移。生成／銷毀requests151／152現已另接真native Running，與本helper共用mapping validation，**但不把count修成cardinality、不要求owner仍occupied**；離房166只有ghost／newSlot，而新生成166多owner高位與opaque echo。ghost相關來源見[Ghost](Ghost.md)；DeferResurrection另已證實為C3，不能由轉移ghost推論復活，詳見[GameClaims](GameClaims.md)。

### chief 與 CBanChief

新 chief 的其他 local slots 先排107，再舊 chief slot（即使已空），最後新 chief slot；不是重發所有人的107。遊戲中交接不清 ready bits；等待房交接才清新 chief 的整個 local group。

`CBanChief` 已有真正 state object、Init、warning／odd flags與timestamps，不是 reset placeholder。`IsBanChief(full, manner, multiplier)` 在所附 build **沒有使用 manner argument**；full 使用10000×multiplier，其他20000×multiplier，strict unsigned `>`；warning10000、odd-slot5000，以 DWORD 乘法 overflow。constructor 以外的 native `Init` 是 `SetOddSlot(false) → SetCanStart(false)`。目前只接入初始化／chief departure reset，**未啟用 DeferBanChief、authority22、警告121或自動踢房長 scheduler**。

## pool4 不是 Lobby 或新網路 pool

沒有還原出正式 native enum 名；已確認 FXGS socket+468 的值：0 Connecting、1 Lobby、2 Session、3 Channel、4 **unnamed post-removal**、6 Practice。移植為跨服務 descriptive stage string，其中4稱 `SessionRemoved`，不是宣稱原碼也有此符號。

- Worker 對非0仍交 `CChannelPool`，不關閉 TCP、不建立新 listener，也不卸除 Center users／channel rank。
- table removal 完成後，Running regulator檢查**第一位primary**，Loading檢查**遇到的未peer user**（可能secondary）；該user未 SetFree 且 TCP仍存活才送195；body只有opcode，scalar-obfuscated body為 `99`，沒有 slot／reason／endpoint／新 token。之後才轉4。
- 不符合該通知條件的 closed／marked-free peer，仍完成普通房間移除，但不送195或轉4；native removal 已暫切pool1。
- 合法已認證群組在無房／pool4 stale generation下的遲到房內封包被忽略，不重新綁 endpoint、不移除另一世代 occupant。明確83回Lobby送15與現有room83列表；16回Channel送13／14。**不自動送這些 stage packets。**
- 這不新增「必須先83／16才准建房」的規則。原本80／81等已知建入房路由仍有各自檢查；Native `DoCreateSession/DoJoinSession`主要檢查 no-session／generation，沒有統一的 pool4 authentication pool。此行為另有測試。
- 尚未完全移植所有 ChannelPool／pool variants，故這不是所有pool4協定行為的相容保證。existing full-group auth／安全政策仍適用。

## 現代安全差異與故障處理

1. **先完整 preflight，後修改。** Native session IDs 是 socket-shared；移植存在各 CUser，因此 stale/no-room path 也檢查1..2位、dense／unique users、ownership與相同tuple，避免第二位 user 被錯清到另一房。普通離房允許 owned closed／SetFree users，不能誤用只接受 live actors 的 battle validator。
2. Native `GetSlotidx` 已恢復讀 stored slot；新 `FindPlayerSlot` 明確負責 pointer＋stored slot 的現代 membership validation，避免把106所需的殘留 slot 當成仍在房內。
3. Native Put/Flush 使用 socket buffers；移植以**當下 recipients＋detached body**排隊，在整條 room state 更新完後才發布，每peer另建packet，維持各peer ghost166/167 → reset106 → sync176 → affected107 的順序。callback看到的是最終狀態，**不是 native callback timing parity**。
4. Room／table／195 publication有 reentry guard；transport例外只計數，不回滾已完成移除、不重跑ghost/sync/chief、不重送195。沒有client ack、delivery guarantee或exactly-once傳送。room的 `GetPacketPublicationFailureCount` 與table的固定 `RecoveryNotice/RoomNotice` 計數不保存exception text。
5. 移植room-list為同步即時發布，native table另排 cache／modified flags。App排除仍在 removal boundary 的 transient-Lobby peer，不在195或明確15之前夾送room-list更新；Update途中已失效／換世代的room不再flush舊86，避免87後又冒出該房更新；這是**現代部署的時序防護**，沒有冒稱完整cache worker已還原。
6. Running整批先用 `GetRegulationCandidates` 在 matrix copy上選人；所有候選的可預期scope／identity／mapping拒絕先檢查完，再逐socket由table執行。只有支持的batch完成才 `Init` 清graph；沒有table service時仍fail-closed，保留graph／未處理timer delta。這不是跨socket／任意注入callback的資料庫交易，也未模擬native `rand()%10` logging draw。
7. Room table的update diagnostics仍只保存index／serial／固定code／consecutive count，一房失敗不阻止其他房。`/healthz`額外顯示移除publication的固定計數，不應視為原client成功收到的證明。

### 凍結結果與真正斷線

尚未durable的首次result plan／duration／key已凍結時，所有正式 departure paths及低階 `DeleteAllUser` **先拒絕 membership mutation**，不把原receipt改成只剩survivors。若只是SQL CAS conflict且users仍合法，可修復外部衝突後重試**原plan**；durable之後的普通離房不再改動該receipt。

TCP真正斷線則不能為了房間拒絕而漏掉其他清理：`CFxServerApp`以 `finally` 仍移除channel rank、通知Center、SetFree／detach global users。房間保留原frozen references，後續 result participant檢查會在SQLite之前拒絕 occupied-but-freed/detached users，**不離線發獎、不重base、不默默另開receipt**。該房會保留pending／failure診斷；**自動offline settlement／restart restoration／人工房間修復API尚未實作**。

Type99的pending money與house161的pending house均使用同樣的pre-mutation departure／DeleteAllUser guard；即使receipt已提交但SQL ACK遺失，尚未確認並安裝live wallet／claim前也不改roster。money／house driver會在clock／result／UDP前重試；terminal detach／其他peer斷線會停在state-changed，不把錢安裝至新user、不重付。SQLite已提交wallet不因斷線回滾，但這不是room restart／orphan recovery。HTTP另有`pendingMoneyPickups`／`pendingHouseClaims`；house board／allocator＋wallet協調見[HouseClaim](HouseClaim.md)；細節與可能因pending protocol guard斷線的可用性界線見[MoneyPickup](MoneyPickup.md)。

## 驗證與重建

`tests/reference/player-removal.cpp` 獨立翻譯280個departure cases（全部32種五人ghost subsets、正反local順序、playing／chief／notify／stopped組合、最後一人／雙人）與624個chief unsigned deadlines、10個state transitions。`Tools/BuildPlayerRemovalVectors.ts`先read-only核對29個PE錨點，再只編譯／執行我們自己的模型：

```sh
./node_modules/.bin/bun run Tools/BuildPlayerRemovalVectors.ts
./node_modules/.bin/bun test tests/PlayerRemoval.test.ts tests/PlayerRemovalIntegration.test.ts tests/UdpLossRegulator.test.ts
```

既有512個有向三-primary loss graphs也逐一比對non-consuming preview與consuming kernel。另測真正CreateSession的service注入、Running串接106／195／152／159、unsigned strict期限、closed/free primary guards、舊generation／稀疏與重複群組、傳送失敗／重入、不重播、83／16／直接建房、真app的frozen CAS斷線與SQLite-before-write拒絕。這些仍是來源／移植邊界驗證；新增[GameLaunch](GameLaunch.md)提供ordinary正式launch及真TCP+UDP連續兩輪，**仍沒有原client或整場可玩證據**。

146 case0 paid inventory現共用gameplay freeze：unresolved CAS／lost-ACK時，不允許removal改roster或替terminal／detached user安裝舊庫存；其他peer已closed亦拒絕。即使SQL扣量已durable，仍不猜測159送達或自動退款／重建room。完整來源與storage-before-live差異見[SpecialItemUse](SpecialItemUse.md)。
