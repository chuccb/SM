# 飛機請求156／廣播171：原碼排程、box-item重設與明示防護

## 範圍與來源

已把 `CGameSession::OnRequestAirplane @ 0041D7C0` 接入**真正完成ordinary native launch/start的Running round**，不是僅新增encoder。這個handler不是完整飛機物理／道具選取／拾取／任務引擎。

只讀儲存庫所附 `FXGS/FxServer.exe.c`、`.lst`、PE；沒有執行供給EXE／DAT：

| VA                   | 已確認分支                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `0041D7D4..0041D7E9` | absolute `timeGetTime`，DWORD `lastScheduled+7000`，unsigned `JA`；gate在body decode**之前** |
| `0041D7F3..0041D812` | count為byte；不在1..3只有diagnostic，仍fall through建立171                                   |
| `0041D823..0041D839` | scheduled tick=`now+2000`，先Encode4，再Encode1 count                                        |
| `0041D844..0041D8BE` | 每筆四個byte；第二byte為box-item index，>=250進disconnect分支；其餘原樣echo                  |
| `0041D8C9..0041D8E3` | 全筆有效後，current context+3032+index×4寫0；+12624記錄scheduled tick                        |
| `0041D8EF`           | `CBaseSession::SendPacket`全房，沒有sender exclusion／chief predicate                        |
| `0041D93C`           | bad index呼叫socket virtual+72，Close(0)                                                     |
| `0041BF07`           | 真正`DoStartGame`將+12624歸0；不是單憑106或164就清除                                         |
| `00432498`           | DWORD scalar XOR是`96CA5395`，不是逐byte套`5A`                                               |

`Common/OfficialValues.ts`集中`AirplaneRequestRule`的7000、2000、nominal3、record4 bytes與box-index byte offset1；容量250共用既有`GameContextLimit.BoxItems`。`Common/Protocol/PacketTypes.ts`保留方向分離：request156是飛機請求，**response156卻是EatItem**；飛機response為171，173只是另一個probability設定。

## Wire與可確認的狀態

body均scalar-coded，不含opcode／TCP framing：

```text
request156:
  u8 count
  count × (u8 opaque0, boxIndex, opaque2, opaque3)

response171:
  u32 scheduledTick
  u8 count
  count × (u8 opaque0, boxIndex, opaque2, opaque3)
```

只有第二byte能確認是`m_aBoxItemState[0..249]`索引；**不把其餘byte命名為item type／座標／flight mode**。每筆都原順序echo，重複box ID不去重、不拒絕；清0的結果自然冪等，但重複entries仍保留在171裡。

成功只清指定box-item state並記錄scheduled marker，再全房廣播。**不呼叫AddBoxItem、不改next-box serial、不建立sync object、不draw random、不查173 weights、不自行選item、不改ghost／player states／statistics／SQLite receipt。** 原碼也沒有chief／每筆actor ownership或map initial/frequency條件，這不等於完整anti-cheat或原client一定會發出這些資料。

Village200雖設定60000／22000，這個handler仍可在遊戲剛start、absolute tick gate已通過時接受；map的frequency0亦不在此代表disabled。不得將client可能使用的173時序錯當成這個server handler的predicate。

## 時間的反直覺行為

原碼做的是：

```text
now = absoluteDWORD()
if unsigned(lastScheduled + 7000) > now: return, BODY未decode
scheduled = unsigned(now + 2000)
... validate records ...
lastScheduled = scheduled
broadcast171(scheduled, records)
```

- 沒有`last==0` sentinel bypass：歸0後仍需absolute tick>=7000。
- 不讀`CGameClock.ElapsedTime()`、start tick或`m_dwTimeStopped`。
- 成功保存的是**future scheduled tick**，不是request receipt time。現有descriptive getter `GetGameLaunchState().LastAirplaneRequestTime`明確指這個native+12624欄位；名稱不是聲稱恢復了原member symbol。
- 未wrap時，下一次通常在前次receipt+**9000ms**才通過，且相等可通過；**不可改寫成unsigned(now-lastReceipt)>=7000**。
- 原碼先ADD再unsigned compare，DWORD overflow時可能出現提早接受／延遲，不「修正」為duration comparison。
- 普通164與下一次Loading保留marker，下一次真正DoStartGame才重設。因此新round的first156可以在很短game elapsed內再次接受。

現代移植沿用同一個`CGameClock.GetCurrentTime`注入來源；預設為Bun `performance.now()` monotonic epoch，**並不是Windows WinMM的OS-boot epoch／解析度相容實作**。此既有平台差異與未完成的network clock synchronization見[Gameplay](Gameplay.md#cgameclock)。人工DWORD時鐘測試不解決這個跨平台相容性問題。

## Native count與明示的現代差異

**count0不是no-op。** Native雖ReportError，仍送171（schedule＋count0）並前推marker；移植保留此安全分支，不補假的entries或誤當不需backoff；不重現舊ReportError文字／時序，也不把0-count當protocol error。

Native對count>3也只有diagnostic，沒有直接return。局部buffer僅十個DWORD，超過10可能覆寫stack；4..10雖不越此buffer，仍超過原碼reported nominal maximum。**現代移植在eligible request中一律拒絕>3**，不宣稱這與native完全相同。獨立模型保留安全4..10的native fall-through images，production tests刻意驗它們是**預期差異**，不是悄悄把模型改成同樣拒絕。

其他防護／差異：

- 先驗證ordinary、完成native generation、Running／未frozen result與完整socket local group；拒絕手改Playing+Running或僅trusted result hook。Native handler自身沒有這些完整phase／mode gates。
- 保留native throttle-before-decode：throttled malformed／trailing／count255 body不讀、不發包、不改world或marker；但common frame CRC／membership／generation限制仍先成立。
- eligible body必須完整Decode／AssertEnd、所有box索引有效，才build packet與commit。bad最後一筆不能先clear第一筆；malformed／bad index走現有protocol-error路徑，不偽造成功。Native close的log／callback時機不聲稱完全等價。
- 於既有room transition中完成全部clears與marker，才以detached packet／recipients publication。回呼不能重入151／152／156、移除、statistics／mode／result；transport failure只計數，不rollback、不replay，沒有delivery acknowledgement。

## 證據與可重建性

`tests/reference/airplane.cpp`是**我們另寫的fixed-width C++人工翻譯**，不import production TS，絕非官方execution oracle。`Tools/BuildAirplaneVectors.ts`先核對**18個PE instruction anchors**，再只編譯／執行我們的模型：

- 2268 body images：所有250個box IDs、count1..3、duplicates，以及三個opaque byte各自完整0..255。
- 474個two-step clock sequences：不同start／stopped、absolute7s／9s boundaries、DWORD半區／rollover、future marker歸0後的gate。
- 36個bad-box images：每個record位置×250..255，證無partial clear／marker／publication。
- 8個native diagnostic-count images：count0與safe4..10；後七組是production刻意拒絕的明示hardening差異。
- 合計**2786組**被`Airplane.test.ts`消費；完整250-word state同時核對exact values與model fingerprint，fingerprint只是test helper，不是protocol／security hash。

另外驗每個body truncation、trailing data、stale secondary、phase／mode、無額外clock／random讀取、exhausted allocator／stopped sync manager仍不改規則、publication reentry／failure、164與真正relaunch。reference初版DWORD cipher錯用byte XOR時，unit明確拒絕；核對`00432498`後修正**人工模型**並新增anchor，沒有把正確的production codec改成錯誤模型。這也說明人工參考不能冒充原程式oracle。

`GameLaunchIntegration.test.ts`在真LS／GS TCP＋UDP discovery、file SQLite與真400ms／8秒164後，第二次native150先用真正144請求claim boxes0／249，再以**nonchief socket發156→全房171**清除這兩個claim flags，核對schedule及含opaque255／duplicate index249的完整records；立即count255由native早期throttle忽略，再用TCP RTT barriers驗無額外171、marker／UUID／receipt不變。沒有手動clock／Update／Running／UUID／payout、額外sleep或private timing setter；最後真shutdown與SQLite reopen。測試端共用codec，**仍不是原client、完整飛機玩法或可玩整場證明**。

```sh
./node_modules/.bin/bun run Tools/BuildAirplaneVectors.ts
./node_modules/.bin/bun test tests/Airplane.test.ts
./node_modules/.bin/bun test tests/GameLaunchIntegration.test.ts
./node_modules/.bin/bun run verify
```

最終數字／穩定性／原始檔完整性見[Coverage](Coverage.md)。非金錢144／145與149公告已另接線，見[ItemPickup](ItemPickup.md)；Type99耐久協調與同round reset後新ordinal已另接，見[MoneyPickup](MoneyPickup.md)；還欠其餘道具等client events、原client復活流程證據／特殊mode／mission／shop／Util、native clock同步及restart恢復；Bula／lap／case8與已核對的C3復活hook另見[GameClaims](GameClaims.md)；不把171當作完整server已完成。

146 case0的paid inventory receipt與Type22 timer已另接，見[SpecialItemUse](SpecialItemUse.md)；不是171的opaque bytes／box claim重設，也不是173機率表發獎。inventory／money／house pending共用world freeze，不能用飛機或qty0 relay穿過未確認的扣量計畫。native ItemSn／StockSn／catalog與日期bridge仍未還原，不宣稱完整飛機或商店道具引擎。
