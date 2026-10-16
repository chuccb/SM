# 鬼魂請求151／152與166／167：已核對的分支，不是完整重生引擎

## 來源與命名邊界

只讀本儲存庫 `FXGS/FxServer.exe.c`、`.lst`、PE：

| 來源 VA                       | 已確認用途                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `0041F3F1`                    | `OnRequestGenerateGhost`：兩個request bytes、時間／數量gate、首個free ID與166                                              |
| `0041B3FF`                    | `OnRequestDestroyGhost`：一個ghost ID、reciprocal mapping、167與count decrement                                            |
| `0041CB51`；vtable `0048F6CC` | virtual+`0xC0`是`IsSlotInThisSocket`，檢查0..7、occupied user、selfidx>=0及user socket；不是chief／死亡／rebirth predicate |
| `0041AE53`                    | `DealWithGhostOfLeavingPlayer`，166轉移／167銷毀，但**不減count**                                                          |
| `00420BB3`／`0041BDCF`        | ordinary launch清maps／count／last，start後ghost秒數乘1000成DWORD毫秒                                                      |

request151的第一個byte只確認會原樣append到166；**不命名為位置、type、death或rebirth參數**。`m_bRebirthMap`的start／constructor writers已定位，但151／152沒有讀它；DeferResurrection0041B5C8另已核對為真正C3空操作，case8亦只echo；此slice不宣稱另有rebirth資格或完整重生裁決已完成，來源校正見[GameClaims](GameClaims.md)。mapping欄名是依已確認角色描述，不冒充所有native member symbols都找到了。

`Common/OfficialValues.ts`集中`GameGhostAssignment.NoGhost`、`GameGhostRule.Capacity=8`及`GeneratedOwnerFlag=0x80`。八個ghost IDs與八個room slots是兩種不同索引，雖然容量相同；不要混成socket local index0／1。

## Wire與成功變更

下列都是scalar-coded欄位，不含opcode或TCP framing：

| 方向                      | body                               | 行為                                         |
| ------------------------- | ---------------------------------- | -------------------------------------------- |
| request151                | `u8 opaque, roomSlot`              | slot屬sender整組locals之一；第一byte只做echo |
| response166，**新生成**   | `u8 ghost, roomSlot\|0x80, opaque` | 全房；三個bytes                              |
| request152                | `u8 ghost`                         | 索引是ghost ID，不是room/local slot          |
| response167               | `u8 ghost`                         | 全房；一個byte                               |
| response166，**離房轉移** | `u8 ghost, newRoomSlot`            | 只有兩個bytes；**沒有0x80，也沒有opaque**    |

生成以**最小free ghost ID**0..7配置，寫`ghost→slot`與`slot→ghost`，signed count++。銷毀成功才清兩邊、signed count--；**不重設last-generation timestamp**。152原碼沒有caller==owner或chief檢查；移植保留同房其他authenticated socket可銷毀的語意，而非自行加一個假的owner proof。

未assign的合法152為no-op。已擁有ghost的151不改任何state、不重送166；frequency0時原碼直接return，positive frequency還有native diagnostic／DumpLog，但不是client snapshot。移植不模擬舊log文字、也不發假的snapshot。

這兩個handler**不改player state、ghost position、kill/save／XP、clock／result UUID**，沒有death-state或RebirthMap條件。Village200的0／0也不能擅自解讀為disabled。這不表示原客戶端UI必定會在這張圖發151，更不表示已驗整場鬼魂玩法。

## 精確時間與count語意

生成的短路順序：

1. 先讀absolute WinMM DWORD `now`。
2. `last==0 || unsigned(now-last)>=frequency`。zero-last是sentinel；恰好frequency可通過。
3. `CGameClock.ElapsedTime()>=ghostStart`，不是`ElapsedTime()-stopped`。它會再取clock sample；成功記錄的是**步驟1**的now。
4. **signed** count<8。
5. slot未配置、首個free ghost、建立166後commit／publish。

保留DWORD wrap、`last==0`的反直覺行為與frequency0。count是native signed32欄位，增減以x86 DWORD wrap，不改成非負飽和值；synthetic INT_MIN／stale count images只證kernel branch，不是正常client可造出這些值的證據。

離房不減count，且先處理整個local group才移除player pointers：可能把ghost轉給同組、稍後變空的slot。**count不必等於live assignments；owner也不必仍occupied**。只要雙向mapping一致，後續152仍可清除那個vacant owner的ghost；不自行repair count或挑survivor。普通164亦不清它們，下一次真正106才清maps／count／last。見[PlayerRemoval](PlayerRemoval.md)。

## 明示的現代安全差異

Native151／152本身沒有完整phase gate。此移植僅開放**完成ordinary native launch/start、current generation token一致、Running且result未freeze**的同房完整有效socket group；Loading／waiting、僅手動設Playing+Running、只走trusted result hook、特殊mode或round transition都拒絕。這避免用未初始化的timing假裝已開局，**不是native phase parity或anti-cheat授權**。

- 完整body先decode／AssertEnd；actor、room serial、所有locals、ghost index與signed int32 count驗證先於變更。Native對>=8的152是diagnostic+return；現代移植用protocol error，無部分清除。
- 生成通過時間／數量gates後、銷毀處理前，預檢整份bidirectional mapping；非法range／inverse拒絕。不要求count==cardinality或owner occupied。
- 成功事件先build packet，於room transition內commit，再以detached body／recipients publication。回呼不能重入151／152、離房、statistics／mode／result；transport失敗只計數，**不回滾、不重做、不保證client收到**。
- 公開trusted departure adapter自己也有whole-group／transition／frozen guards及deferred publication；真正table removal走private合法內層，沒有錯把原有`m_bRemovingPlayer`流程全部禁止。

## 驗證、可重建性及仍缺證據

`tests/reference/ghost.cpp`是**我們獨立寫的fixed-width C++人工翻譯**，不import production TS；builder只讀PE核對16個instruction anchors，再編譯／執行我們的模型，**不執行官方EXE／DAT**。

- 4088 generation images：256種occupied ghost subsets×八個actor及native／stale8 count、opaque byte邊界。
- 6128 destruction images：所有subsets／ghost IDs及native、0、8 counters，測試端刻意用非owner socket。
- 42 signed count images：INT_MIN／−1／0／7／8／9／INT_MAX與overflow。
- 366 clock images：原Village200、Cemetery22、Tomb194及兩種明示synthetic headers；start／frequency邊界、zero-last、DWORD wrap、負seconds轉DWORD毫秒、stopped time。共**10,624組**，全部被production `Ghost.test.ts`消費。
- 另外驗嚴格body／stale secondary identity／corrupt graph／特殊phase、time讀取與短路順序、destroy保留cooldown、reentry／transport failure、雙local離房的vacant owner、164／真正relaunch清除。
- `GameLaunchIntegration.test.ts`用**真LS／GS TCP、真UDP discovery、file SQLite、實際400ms／8秒timer**：native150後secondary151→全房166、另一socket152→167、再次151、claims／durable163／164、第二次106／150清ghosts。未注入Running／clock／Update／UUID／payout，最後reopen DB；仍是共用codec的self-client，不是原client或完整可玩round。

```sh
./node_modules/.bin/bun run Tools/BuildGhostVectors.ts
./node_modules/.bin/bun test tests/Ghost.test.ts
./node_modules/.bin/bun test tests/GameLaunchIntegration.test.ts
./node_modules/.bin/bun run verify
```

最終數字、reference穩定性及完整性見[Coverage](Coverage.md)。尚欠原client build與錄包、官方execution oracle、原client復活玩法證據／其他裁決、特殊mode、長時間／負載與restart恢復；156／171的飛機排程與box-state重設已另接線，見[Airplane](Airplane.md)；非金錢144／145、149原始CP949公告、unrouted throw與money核心來源見[ItemPickup](ItemPickup.md)，已接Type99耐久協調及未完成恢復見[MoneyPickup](MoneyPickup.md)；不把「能生成166」當作完整官方server已完成。

## Type22不是鬼魂／復活引擎

146 case0已另接免費relay／paid inventory receipt；Type22僅在state3刷新state-time，不改ghost assignment／position／state或呼叫151／152。原C3 DeferResurrection仍保持空操作，不補造復活判定。pending inventory亦阻擋ghost變更。201與native庫存mapping限制詳見[SpecialItemUse](SpecialItemUse.md)。
