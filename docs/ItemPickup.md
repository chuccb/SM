# 道具／障礙拾取、事件公告與金錢核心

## 已接線的範圍

ordinary **真正完成106／109／discovery／150** 的 Running round，已接：

- `OnRequestEatItem`：request144 → response156（money另加multiplier），對整房共用的 box claim flag 仲裁。
- `OnRequestEatObstacle`：request145 → response157，保留 native 攤平索引及座標別名。
- `OnEventItem`：request149 → response30，socket-local player 名稱加原始 CP949 公告；不是發獎。
- `OnItemThrow`：六個 byte → response172 的 **trusted extracted kernel**。ordinary dispatcher 沒有已確認入口；**不把153猜成丟道具**。
- `CUser.IncDecMoney` 與 `MakeMoneyPickupPreview`：native signed32算術／dirty intent／四byte156 body；preview仍是detached，但網路Type99已經專門coordinator接成durable成功流程，詳見[MoneyPickup](MoneyPickup.md)。

金錢路徑先凍結一次計算，以SQLite全部五欄CAS＋不可變receipt提交並確認，再改live wallet／claim／發156。SQL失敗、lost ack或CAS conflict保留原pending plan，不重抽、不回假成功；已claimed的合法Type99仍是native no-op。這不等於自動conflict／orphan／restart恢復。

這些不是完整道具引擎、判勝授權、商城、任務／event prize service，也不是原 client 已可玩的證明。

## 只讀來源與數值集中

來源為所附 `FXGS/FxServer.exe.c`、`.lst`、同一 PE 與原 FastFile，未執行官方 EXE／DAT：

| VA                               | 確認的意義                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `0041EA50`／`0041EB2D..0041EB47` | EatItem；context+3032 的250個 DWORD flags，zero 才改1／回156                     |
| `0041EB7D`／`0041EBBC`           | 164-byte item row+140 Type99；row+144 是第一個 signed money parameter            |
| `0041EB9A..0041EBAF`             | 選定 room user 的 BYTE+2004 ==1 才 `rand()%2+1`                                  |
| `0041EBC6..0041EBE3`             | signed32 IMUL；>10000 僅 diagnostic，接著 `IncDecMoney`，不是 amount cap         |
| `004090EC`／`00409109..00409123` | signed32 ADD 先 wrap，再 clamp 到0..1,000,000，dynamic dirty=1                   |
| `0041ECA3`／`0041ED47..0041ED77` | EatObstacle；`row*15+column<195`；context+4032 zero→1／157                       |
| `0041F28B`／`0041F2BE..0041F2CB` | EventItem；先驗 socket-local self，再讀 label                                    |
| `0041F329`／`0048F010..0048F06A` | 完整91-byte C string：`%s`＋88 bytes 原始 CP949 後綴＋NUL                        |
| `0041F337`                       | 公告 response30，單一 length-prefixed byte string                                |
| `0041E8E7`／`0041E908`           | throw kernel 六個 byte，首 byte 低 nibble 為 room actor                          |
| `0041E9E6`／`0041E9F1`           | throw 清 box flag、回172；其餘欄位原樣 echo                                      |
| `00421661`／`004215C5`           | ordinary dispatcher 的 selector／jump tables；153 → index38 → default `004215B4` |

pickup 的 ownership virtual+192 為 `IsSlotInThisSocket @0041CB51`；throw 的 virtual+188 為 `IsMySocket @004209C0`。不只看相同間接呼叫就猜同一個方法。

`Common/OfficialValues.ts` 集中 `GamePickupState`、`MoneyPickupRule`、`ItemThrowRule`、`UserDynamicRule.MaximumMoney`；容量／nibble 座標共用已核對的 `GameContextLimit`／`GamePosition`。`Common/Protocol/OfficialMessages.ts` 單點保存 immutable 原始公告 hex，不散落本地化字串或共用可變 Buffer。現代1024-byte label 上限放在 `RuntimePolicy`，不是宣稱 native item-name 長度。

## 144／156：claim 不是物品生成或屬性引擎

以下均是 scalar-coded body，不含 opcode／TCP frame：

```text
request144:          u8 roomSlot, boxIndex, itemIndex
response156 nonmoney:u8 roomSlot, boxIndex, itemIndex
response156 money:   u8 roomSlot, boxIndex, itemIndex, multiplier
```

- actor 是 room slot0..7，不是 local0／1；同 socket 的 secondary 可以是 actor。
- box 是0..249；item bound 用實際 `CItemAttr.GetItemCount()`，不是商城 SQL 定義。所附 archive 是71 rows，不在 production 把71硬編碼成容量。
- box flag 必須**恰為0**，才改為1並全房送156，包含 sender；任何非零值均 no-op。不是每玩家各自一份，也不重送成功封包。
- 完整 item／box／actor 驗證在 flag 檢查之前；已 claimed 不代表 malformed body／非法 item 可以跳過驗證。這與飛機的 throttle-before-body 不同。
- native 非 Type99 分支只改 claim flag／發包，**不依 parameters 修改 server 的 bomber count／power／speed／inventory／XP／WDL**。Type98 alphabet 也不自動產生149公告。
- 原 handler 未驗證該 box 實際生成過何種 item，也無距離、alive／dead、隊色或 chief predicate；移植沒有假造這些授權證明。因此成功仲裁一個 flag 並不等於已建立安全的道具經濟／物理引擎。

## 145／157：先攤平，再檢查界線

```text
request145: u8 roomSlot, packedPosition
index = (packedPosition & 15) + 15 * (packedPosition >> 4)
response157:u8 roomSlot, ORIGINAL packedPosition
```

native 只要求 `index<195`，不是獨立要求 `column<15`：

- row0..11 的 column15 有效，分別 alias 到下一 row 的 column0。
- `0x0f` 與 `0x10` 共用 index15；先取得的 actor 會阻擋另一個 packed byte，但157仍 echo原始 byte，不能 canonicalize。
- 所有256個 packed bytes 中 **207有效／49無效**，有效值對應195個實際 cells，含12組 aliases。
- `0xce` 對應最後一格194；`0xcf` 對應195而無效。

zero→1／nonzero no-op 的 claim 語意與144相同。不能直接呼叫嚴格 row／column 的 `CGameContext.GetObstacleState` 來判斷145，否則會錯拒12個 native 合法 bytes。已接的148→161 drop 使用 canonical有效座標清0，之後145可再次 claim。

## 149／30：完整公告不能只看 IDA 的 `%s`

```text
request149: u8 SOCKET-LOCAL self; str logOnlyLabel
response30:str rawAnnouncement
rawAnnouncement = configured-codepage(username) + rawCP949Suffix88Bytes
```

- self 必須小於 sender socket 的 user count。Bob 在 room slot2 仍使用 local0；不能用2當 self。
- native invalid self 在讀 string length **之前**即 return。移植保留此 no-op／未 decode 後續 body 的順序；共同 frame、phase、完整 group／generation 驗證仍在前。
- valid label 只供 native `ReportEx(1)` 記錄，不查 item table、不參與公告、不增加金錢、庫存或 event prize。移植不製造舊 event-log 檔，也不記錄使用者送來的 label／個資。
- `.lst` 在 `aS_3` 第一行僅顯示 `db '%s'`，**不是字串到此結束**；後面88個 bytes 另列成 `db`。PE 的下一個 NUL 在 `0048F06A`。初版 reference 的 `%s\0` anchor 因此真的失敗，核對完整 raw bytes 後修正模型與實作，沒有刪掉驗證來接受不完整字串。

完整 CP949 解碼為：

```text
%s님께서 이벤트 아이템을 획득하셨습니다! 축하합니다!
자세한 내용은 홈페이지를 참고하세요~
```

兩行皆含結尾 LF。意義是「該玩家獲得活動道具，恭喜；詳細內容參考首頁」。**所附 BNB_TAIWAN binary 中仍是這段韓文 bytes**；不能把翻譯後的中文、Unicode韓文再 Big5 encode、或僅玩家名稱當 native wire。輸出使用 `EncodeStr(Buffer)` 保留 suffix，不會偷偷前往任何首頁。原 client 的顯示效果／codepage 相容仍未驗證。

149是可重複的 stateless notice，不是一次性 reward receipt；失敗後不自動 replay，但另一個有效149仍可再公告。不能據此宣稱可靠或 exactly-once delivery。

## 金錢：native算術與專門的耐久coordinator

所附 money rows25..32 的 parameters[0] 分別為：

```text
10, 20, 50, 100, 200, 500, 5000, -1000
LucciPocket0 = +5000; LucciPocket1 = -1000
```

它們不是購買價格或外部 cash／billing 單位。native kernel：

```text
multiplier = user.authencodeByte == 1 ? rand()%2+1 : 1
signedDelta = signed32(multiplier * signedParameter0)
money = clamp(signed32(oldMoney + signedDelta), 0, 1_000_000)
dynamicDirty = 1
```

- authencode 是 CUser+2004 的 byte，**不是 gender、authority、TicketDate 或已證明的付費資格**。只有等於1才 draw一次；其他值不 draw。預設15-bit CSPRNG並非原 CRT thread-local seed／sequence parity。
- IMUL與ADD都先 signed32 wrap；不可用無界 JS multiplication／SQL clamp替代順序。甚至合法 storage int32 大值加正 delta 也可能 wrap負值、最後變0。
- > 10000只是 diagnostic；`5001×2=10002` 仍完整計算，不改成10000。真正 wallet cap 是 ADD 後的1,000,000。
- `IncDecMoney(0)` 或飽和不變仍標 dynamic dirty=1，不改 cached level、simple-info dirty、games-since-flush、其他動態欄位或 inventory。dirty只是記憶體意圖，**不是 SQL ack**。

`MakeMoneyPickupPreview` 是明示的現代 detached helper，clone user 後用同一 `IncDecMoney` 核心，回 Before／After／delta／multiplier／diagnostic flag／native156 bytes。preview本身不 claim、不改 live user、不送包、不寫 SQLite、不改 round UUID；bonus preview明確會消耗一次可信 RNG draw。呼叫者不能把它當成已完成拾取或直接安裝／發送為成功。

`RuntimeGameResult`是結算回執；native163只增加XP／WDL，不增加money。Type99現另用schema3引入、目前schema6保留的`RuntimeMoneyPickup`：server round UUID＋單調money claim序號、同IMMEDIATE transaction的全部五欄absolute CAS＋exact156 receipt，以及live-state／stored-After確認。SQL／ack失敗只保留同一plan；尚未確認前不改claim／wallet、不queue156。house161不是resource item／156，已另用schema4獨立board／allocator＋5money receipt，與money／special inventory pending互斥，見[HouseClaim](HouseClaim.md)。

box可被飛機／death／trusted throw重設，因此不能只以box當idempotency key；同round重設後的新money claim使用下一ordinal。成功live wallet會進入之後result Before；pending money先擋住result capture／timers／removal。收據不可變、no-op／飽和亦有receipt；不將SQL `SetMoney`、result receipt或dirty flag當同一個操作。Native preview本身仍無durability，也沒有新增client payout endpoint。細節與恢復限制見[MoneyPickup](MoneyPickup.md)、[Database](Database.md)、[ResultLifecycle](ResultLifecycle.md)。

## Throw kernel：有函式，不表示153就是入口

`OnItemThrow0041E8E7`解六個 bytes：首 byte低 nibble為room actor、第二為box index；首 byte高 nibble與後四 bytes保持opaque。成功清指定box flag為0並全房 echo六個 bytes於172；不配置新box、不套用item attributes、不draw random。

此函式在現有 `.c`／`.lst` 未找到 ordinary caller；更直接的 PE 證據是153在selector table選38，jump entry38指向default，而非此函式。故移植保留 **trusted direct-call kernel**，不新增 `ClientRequest.ItemThrow=153`。其測試的已消耗 synthetic prefix僅為cursor adapter，不是聲稱找到 client opcode。也不把未找到 direct xref冒充所有間接可達性的完整證明。

native invalid box為diagnostic／return，actor虛呼叫也沒有等價的完整安全前檢；移植的完整 body／actor／box／group／native-round驗證是明示hardening，不模擬 unsafe memory或相同log／disconnect timing。

## 狀態生命週期與現代邊界

- 164回準備保留box／obstacle claim arrays。
- 下一個106的 **`LaunchGameStage00420BB3` 已呼叫 `CGameContext.Init`清兩個 arrays**，在Loading、尚未150之前完成；不能把它和下一次 `DoStartGame` 才重設的飛機 scheduled marker混為一談。
- 飛機156→171、普通death drops及trusted throw可按原來各自的分支清特定box flags；不藉此重新分配serial或重算物品種類。
- 新網路入口限定已完成native ordinary generation／Running、未frozen money／結果、完整 socket group與room tuple。native handlers本身沒有同樣的phase／mode gate；不是宣稱完全錯誤路徑parity。
- 先全body驗證再改flag／建detached publication；149合法self另加1024-byte／可逆legacy encoding／NUL／trailing檢查。invalid self的native早退例外刻意保留。
- claim／reset完成後才flush queued publication；回呼不能重入item／ghost／airplane／移除／statistics／mode／result。send失敗只記有界attempt counter；不rollback或自動重播。156／157之後因flag而不重送；stateless30和trusted172則仍可由新的有效呼叫重複發出。

## 驗證與重建

`tests/reference/item-pickup.cpp` 是**我們獨立人工轉寫的 C++ fixed-width模型**，無 production TypeScript imports；明確的 uint32 ADD／IMUL及two's-complement解釋避免C++ signed-overflow UB。builder只讀PE核對 **34個anchors**，再只編譯／執行自己的模型。

| 固定 images                           |    數量 | production tests如何消費                                                                                                     |
| ------------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------------------------- |
| BoxClaims                             |    1500 | 全250 boxes×三種primary／secondary／nonchief actor×兩個resource endpoints，完整250-word state與156                           |
| ItemClaims                            |    1278 | 三actor×71 item rows×六種zero／nonzero signed states；其中24筆unclaimed money現走真實wallet／receipt／156，非零state仍不付錢 |
| Obstacles                             |    1536 | 全256 packed bytes×六states；207／49界線、完整195-word state與157                                                            |
| Throws                                |    3072 | trusted six-byte kernel；high nibble及每個opaque byte完整0..255，reset與172                                                  |
| InvalidThrows                         |     146 | bad box／masked actor輸入；明示現代拒絕，非執行native unsafe分支                                                             |
| Events／InvalidEvents                 | 18／509 | 完整CP949公告、三使用者／含Big5 label與1024-byte邊界、invalid self-before-string                                             |
| MoneyKernel                           |     130 | signed32 wallet transitions／wrap／clamp與不影響其他cache／flags                                                             |
| MoneyPreviews／SyntheticMoneyPreviews | 800／10 | 八真實money rows、auth0／1／2／255、rand parity／draw counts、負pocket／飽和／wrap與diagnostic／IMUL synthetic rows          |

合計 **8999組**；不是原官方execution oracle、client capture、網路可達性或經濟授權證明。負raw memory只驗kernel，不宣稱能由SQLite直接產生；10組synthetic definitions另以trusted fixture驗完整coordinator，不宣稱archive真的有那些道具或client可修改resource。另驗八slot真正native round、整組secondary stale／marked-free、所有bad item bytes／body truncations、pending CAS freeze、callback reentry／failure，以及164保留／106清理／新150後可再claim。

`GameLaunchIntegration.test.ts`用真LS／GS TCP、UDP discovery、file SQLite與400ms driver：原有144／145 shared claims／alias、149 exact raw30／invalid self、ghost／163／8秒164與下一106清context均保留；另在真正money COMMIT後只注入SQL ACK遺失，由真driver去重後發四欄156，並驗負值clamp、結算保留money、下一genuine round新UUID及171 reset後新claim。五筆money receipts與最終餘額通過close／reopen；沒有注入Running／clock／RNG／手動Update／UUID／payout。詳見[MoneyPickup](MoneyPickup.md)。

TCP測試端仍共用本實作codec，不能排除雙方同錯或取代原client。最終全量／repeat／hash／98個原供給檔完整性數字見[Coverage](Coverage.md)。

```sh
./node_modules/.bin/bun run Tools/BuildItemPickupVectors.ts
./node_modules/.bin/bun test tests/ItemPickup.test.ts
./node_modules/.bin/bun test tests/GameLaunchIntegration.test.ts
./node_modules/.bin/bun run verify
```

耐久money144／重放與reset協調已接；Bula／lap／case8亦另接，DeferResurrection已核對為真正C3空操作，見[GameClaims](GameClaims.md)。仍欠明確conflict／orphan恢復、原client復活玩法證據、其餘特殊道具、house claim的5money耐久協調、特殊mode／特殊模式waiting-chief、shop／Util／interservice與restart恢復。不要把8999組人工images或已接拾取子集當完整server完成率。

## 使用特殊道具不是拾取144

146 case0現另接免費relay、paid inventory全欄CAS＋獨立schema5 receipt／耗盡SQL DELETE／live zero-row dirty-retention；Type22只刷新state3 time，不從144 claim推定可用數量／spawn權威。201也已按native順序修正Amount／Verbose／raw8-byte date。來源與原生ItemSn／StockSn、日期bridge等尚未完成的mapping見[SpecialItemUse](SpecialItemUse.md)。三種gameplay pending共用freeze並交叉核對result descriptor，不共用receipt或ordinal。
