# House161／178：占格、generated boxes與5金錢的耐久協調

## 已接範圍與來源

ordinary native round的`CGameSession::OnReqTakeHouse 0041D941`現已接入request161 → 獨立SQLite receipt＋wallet → live house plane／color counts／generated-box allocator → 全房178。不是把它偽裝成Type99 item144，也沒有省掉原本的金錢。

- house getter／setter：`0041B801`／`0041B817`，context+9600的13×15 signed-DWORD plane、context+0的8個color counters。
- `AddBoxItem 0041B7BA`：context+4916的next index，從126開始、250耗盡；成功回傳原index並遞增。
- `0041DA2D`的literal **5**是178的section marker；`0041DAEB`的LEA乘 **5**才是每accepted new cell的金錢。兩者在`OfficialValues.HouseClaimRule`分開命名，不混成一個「house magic5」。
- `0041DAF1`呼叫`CUser::IncDecMoney 004090EC`，即使accepted=0亦有native dirty intent。沒有authencode1 bonus／RNG，也不改XP／WDL／level／statistics／clock。
- `FXGS/HouseClaim.ts`是明示的現代detached factoring／資料型別，**不是宣稱還原出一個同名native class**。房間方法仍保留原名`OnReqTakeHouse`。

`completeOfficialRewrite`／`officialClientVerified`仍為false。這不是完整對局、地圖／spawn／反作弊授權、特殊模式、原版client相容或完整restart journal的證據。

## Wire與native狀態

以下為scalar-coded body，**不含opcode／TCP framing**：

```text
request161:
  u8 roomActor, requestedHouseCount
  requestedHouseCount times: u8 row, column
  u8 requestedDropCount
  requestedDropCount times: u8 opaque0, opaque1, opaque2
response178:
  u8 roomActor, acceptedNewHouseCount
  acceptedNewHouseCount times: u8 row, column
  u8 literalSectionMarker=5, allocatedDropCount
  allocatedDropCount times: u8 opaque0, allocatedBoxIndex, opaque1, opaque2
```

- actor是**room slot**，不是local self；第二個local玩家也能發161。移植要求合法且owned的0..7 slot及完整socket group／native launch generation；native未作相同的完整phase／ownership防護。
- 每組row／column各自檢查`row<13 && column<15`；超界pair**跳過**，不是fatal，也不採Bula的flat aliases。因此(0,15)不會占(1,0)。完整65,536組byte pairs中，195組為canonical board cells，另65,341組跳過。
- 只有原state==−1才接受；先寫actor，所以同request的重複pair第二次不再算新格。其他actor已占格也不重分配。回覆只含新接受的pairs，保留其原順序。
- counter依**actor當前slot color &0x1F**增加，不是依actor編號；同色玩家共用counter。native setter只增加color0..7，signed32 overflow照原wrap。純模型亦保留color8／31「寫格但不增counter」；ordinary native入口早已拒絕此種不合法room colors，不把raw邊界模型當網路可達性證據。
- 三個drop bytes在此函式中都沒有進一步解釋／驗證，只在第一與第二之間插入box ID。完整0..255原樣保留，**不猜成item種類、tile座標或spawn證明**。
- 配置box只推進next pointer，不reset既有box-item claim flag，也不改obstacle／Bula／bomb／ghost／sync manager。可以requestedHouseCount=0但仍配置drops；沒有新增alive／chief／house-map／accepted-count→drop-count規則。
- zero new houses仍送178、呼叫native money0 dirty intent並保存獨立receipt。金錢為`5*accepted`，最大195新格→975；native signed32 ADD後clamp0..1,000,000。authcode1在此**沒有**倍數。

原有`OnShobuari 0041CC8B`（request162，empty body）現可消費真正161寫入的counts。測試以真正house claims產生winner／tie再經162→163，不偽造counts或death。state6勝方會forced end；全state7平手不設Forced，但沒有active／pending玩家，仍可ready結算。原碼沒有在這裡證明「客戶端於正確時機要求仲裁」，不能因此宣稱可信裁決或反作弊。

## 明示的現代差異：不發布native殘缺178

native逐筆decode三個drop bytes，再呼叫AddBoxItem。若回−1則break，但`0041DACB`仍以**原requested drop count**回填header，因此可能送出宣告有N筆、實際只有M筆的殘缺body；先前house state已寫、最後仍付款。

移植**先完整解碼**全部cells、drop count、triples與end-of-body，再建立detached plan。若`nextBox + requestedDrops >250`，整筆以`house-capacity`拒絕，**不占任何格、不增count、不配置box、不付錢、不保留pending／receipt、不送178**。不是偷偷cap筆數或修補header後聲稱native parity。native會提前留下未讀bytes、先前部分world變更、鬆散actor範圍／trailing body等行為亦未重現。

合法完整178最多`5 + 2*195 + 4*124 =891` scalar bytes（含opcode）；SQLite的packet bound與最大組合測試綁定此已推導上界。

另一個順序差異是native先broadcast178再IncDecMoney；本移植為安全durability，**先SQL COMMIT／確認、完成全部live狀態，才detached publication**。不能冒稱原writer／transport時序相同。

## Schema4：獨立house receipt，不挪用money144

`004_HouseClaim.sql`在同一交易migration新增`RuntimeHouseClaim`及immutable／closed-round triggers；既有schema1／2／3資料會保留升級，失敗rollback。`RuntimeGameResult`／`RuntimeMoneyPickup`不重建、不改原payload版本。house格式version1與32KiB上限放`RuntimePolicy`，不是native資料表／限制。

可信submission包含：server round UUID、**獨立house ordinal**、channel／room／serial／start tick、actor global serial、完整requested pairs／opaque triples、board／counts／allocator Before與計算After、accepted／allocated records、native delta、user五欄Before／After及exact178。

`CommitHouseClaim`在own root **IMMEDIATE** transaction內：

1. 正規化與重算plan／signed wallet arithmetic／exact178，不接受偽造derived After或任意金額。ID採既有ASCII-case normalization；canonical JSON／SHA-256與metadata再讀會交叉重驗。
2. 先查同UUID＋ordinal的exact immutable receipt；完全相同回duplicate，內容不同回key-reused。即使後來wallet ABA、零金額或round已結算，duplicate也不重新付款。
3. 新序號必須連續；house sequence和money144 sequence**各自**單調，不共用resource／156格式。已有house receipt的After board／counts／allocator必須接上新Before；不能可信內部reset後悄悄重開舊world key。
4. 與已有house、money receipts及後來result共用同一round descriptor。新house須早於result；結果提交也核對house descriptor。跨類型不宣稱單一全域SQL event journal。
5. 同交易執行user **Money／Exp／Win／Draw／Lose全部五欄absolute CAS**與INSERT。receipt INSERT失敗回滾wallet；CAS conflict不新增receipt，也不rebase。

`ConfirmHouseClaim`要求root transaction外讀回相同canonical calculation與packet；savepoint release不是durable COMMIT。session再確認目前stored五欄正好等於frozen After、round仍open、live participants／generation／wallet／context／metadata等fingerprint未變，才安裝。SHA-256是corruption detection，**不是MAC、管理者防護、spawn或判勝授權**。

三類receipt含ID／數值，須與帳號庫一同保護及一致備份；未完成retention／封存／安全刪除，zero-count請求也會累積receipt，不能當作已通過長期負載與營運驗收的帳本。

## 凍結、重試與發布

- plan不改live；完整pending保存immutable request／packet hex／snapshots／occupant references。SQL conflict、錯誤、未知ACK或COMMIT後ACK遺失皆保留同一份，不換key／重算獎金或重新配置box。
- 只有**同actor＋同原ordered cells＋同全部triples**的161可重試；或由真正400ms `Update` driver在**任何clock sampling／timers／result capture之前**重試，成功的retry tick也不消耗lastUpdate delta。
- house pending與money／special inventory pending互斥；pending期間擋其他room packets／direct gameplay、UDP discovery、bomb timer、名單變更、mode／統計重置、result capture與room-list dirty flush。closed／SetFree／stale secondary不轉成offline payout。
- 驗證失敗維持frozen diagnostics：`conflict`、`storage`、`state-changed`或`stored-state-changed`；HTTP增加`pendingHouseClaims`，不暴露ID／money／packet／SQL exception。沒有通用自動conflict／orphan修復。
- wallet／native dirty intent、board／color counts／next box、ordinal與pending clear全部先完成；每socket才收到detached178。send failure只記bounded publication failure，不回滾／重播／再付款；callback重入被鎖，packet mutation不污染其他peer。
- 協定**沒有request nonce**。completed之後再次發同一161，是新request／新ordinal：已占格不再加錢，但requested drops會再配置新boxes。不能把storage retry冪等說成exactly-once TCP或防止所有client重送。
- 163的Before取後來已同步wallet，不能覆蓋house／item awards；164保留house plane／counts／allocator，下一真正106在Loading已Init成−1／0／126，150才綁新UUID／ordinal1。

receipt能耐久保存已提交的plan／wallet，但沒有完整round journal、restart恢復、TCP acknowledgements，或對任意外部SQL／JS writer的通用memory＋SQL原子fence。凍結時讀回stored After只是best-effort一致性防護。

## 可重建證據與限制

`Tools/BuildHouseClaimVectors.ts`read-only檢查**31個PE instruction anchors**，再只編譯／執行我們自己的`tests/reference/house-claim.cpp`，不執行官方EXE／DAT。1633組人工模型包括：

| 類別                                     | images | 意義                                                       |
| ---------------------------------------- | -----: | ---------------------------------------------------------- |
| coordinate-domain batches                |    258 | 每批≤255 pairs，完整65536個byte pairs                      |
| count／duplicate／previous-owner batches |    256 | requested count0..255、skip／order／clamp                  |
| allocator boundaries                     |    622 | 全125種next126..250、0／1／remaining／remaining+1／255去重 |
| opaque byte domains                      |    256 | 三個drop欄位各完整0..255，不猜用途                         |
| joint maximum                            |      1 | 255 requested pairs、195新格、124 drops、exact891 bytes    |
| slot／color／wallet／counter boundaries  |    240 | 8actors×5colors×6balances，含raw色8／31與signed32 wrap     |

共**1383 safe images**、**250明示native malformed-body cases**；safe中1287份color0..7亦走真正106／discovery／109／150 →161→SQLite→live→四socket／八actor的178。raw色8／31只做純核心／trusted storage，不假稱通過ordinary native入口。

- `HouseClaimLifecycle.test.ts`：上述完整state／wire images、phase／group／closed／SetFree／whole-body／capacity、zero-delta dirty、frozen pre-clock retry／money/result互斥、lost ACK、false ACK、live／stored drift、SQL與transport callback reentry、detached fail／no replay、counter exhausted、162 winner／tie仲裁、163／164／第二genuine start。
- `HouseClaimStorage.test.ts`：1383 safe images、canonical／immutable／corruption、five-field CAS與INSERT rollback、root ownership、independent sequences／cross-descriptor／closed-round／board chain、891-byte max、writer lock／reopen、兩個真正Bun子行程的同key與house-vs-result競爭、schema3→4保留與DDL rollback。
- `GameLaunchIntegration.test.ts`：真LS／GS TCP＋UDP＋file SQLite、真正400ms／8s driver、兩輪native start；money與house均只故障注入真COMMIT後的storage ACK可用性。house先看到durable wallet／receipt但live frozen，再自動重試exact178；zero新格、164保留／106 reset／second UUID、3筆house＋5筆money receipts，以及Alice10／Partner10000／Bob15在close／reopen保持。未注入Running／ready bits／clock／RNG／Update／UUID／payout。

```sh
./node_modules/.bin/bun run Tools/BuildHouseClaimVectors.ts
./node_modules/.bin/bun test tests/HouseClaimLifecycle.test.ts tests/HouseClaimStorage.test.ts
./node_modules/.bin/bun test tests/GameLaunchIntegration.test.ts
./node_modules/.bin/bun run verify
```

實測全套、反覆測試、16份reference hash與98份原始供給檔完整性以[Coverage](Coverage.md)為準。人工模型和共用codec的測試client都不是官方dynamic oracle／原client相容／完整可玩整場的證據。其餘特殊道具／events、特殊模式waiting-chief／practice／Mod等模式、shop／Util／interservice、flush／collector與conflict／restart恢復仍未完成。

目前DB為schema6，保留原schema4 house receipt／version1不變。146 case0另有獨立inventory receipt；money／house／inventory pending共用world freeze（含inventory metadata／dirty），三個ordinal獨立，並與result交叉核對descriptor。Native ItemSn／StockSn／日期bridge與201修正界線詳見[SpecialItemUse](SpecialItemUse.md)，不是house drop triples的意義或spawn證據。
