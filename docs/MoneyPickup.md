# 金錢拾取：native144／156與SQLite耐久邊界

## 現在已接通什麼

ordinary真正完成106／109／discovery／150的Running round，`OnRequestEatItem`現在會處理Type99金錢道具：**凍結一次native計算 → SQLite錢包CAS＋不可變收據 → 確認原收據／目前資料 → live wallet與claim → 四欄位156**。不再以「尚未移植durable money pickup」拒絕所有unclaimed Type99。

這不是商城／外部billing／安全物品生成裁決，也不是完整遊戲、原client相容或restart房間恢復的證明。`completeOfficialRewrite`、`officialClientVerified`仍為false。非金錢144、145、149、throw與PE來源詳見[ItemPickup](ItemPickup.md)。

## 不更動已確認的native語意

`0041EA50`依實際resource item row的Type99，取第一個signed parameter；`004090EC`修改wallet：

```text
multiplier = authencodeByte == 1 ? rand()%2+1 : 1
signedDelta = signed32(multiplier * parameter[0])
newMoney = clamp(signed32(oldMoney + signedDelta), 0, 1_000_000)
dynamicDirty = 1
request144: u8 roomSlot, boxIndex, itemIndex
response156 money: u8 roomSlot, boxIndex, itemIndex, multiplier
```

- 所附rows25..32是10／20／50／100／200／500／5000／−1000；Pocket1真的減1000，不是購買價。
- authencode是BYTE，**不等於gender、authority、TicketDate或已驗證的付費資格**。只有值1draw一次；其他值不draw。預設15-bit CSPRNG不保證原CRT seed／sequence相同。
- IMUL與ADD皆先signed32 wrap，不能改成SQL `Money+delta`或先把delta clamp。>10000只diagnostic，5001×2仍可得到10002；真正wallet cap在ADD之後。
- 零delta／負值clamp／飽和即使Before=After，仍有一次claim、dynamic dirty=1及收據；不改cached level／simple-info dirty／games counter／其他動態欄位。
- actor仍是room slot0..7，不是socket-local self；secondary與nonchief可拾取。原handler沒有alive／distance／server-spawned item identity證明，這次沒有捏造。**去重不等於反作弊或可信物品經濟**。
- 非零box flag在完整body／resource／group／ownership驗證後仍no-op，不draw、不進SQLite、不重送156。非金錢156仍只有三欄；request156仍是飛機，不是金錢確認。

上述常數集中在`OfficialValues.ts`的`MoneyPickupRule`／`UserDynamicRule`；版本、4KiB收據上限與目前schema6（money table在schema3引入）放在`RuntimePolicy.ts`，不冒充native常數。

## 為何key不能只是box

box可以在**同一回合**經native飛機156→171、普通event4 death drop或已確認的trusted throw kernel重設為0，再次拾取。只以box當key會漏付合法新claim；只靠Before→After CAS，則無法擋住no-op／飽和／ABA。

每個真正native start建立private server UUID；每個成功安裝的**金錢claim**使用該round的單調`ClaimSequence`，從1開始，不是所有非金錢claim／box allocator的序號。飛機／death／throw不重設它。序號不可wrap；達u32上界在RNG／SQL前拒絕。下一次真正native start才有新UUID／序號；僅把stage設成Running或呼叫trusted `BeginResultLifecycle`不能取得money需要的native launch token。

SQL已提交但memory尚未安裝時，可能已存在下一筆receipt而live Sequence仍是前值；此時只保留原pending plan，不因此另取新序號。

## Schema3引入的money receipts：目前schema6仍保持version1

`003_MoneyPickup.sql`新增**現代**`RuntimeMoneyPickup`，不是原官方table。key為`(RoundID, ClaimSequence)`；綁定：

- channel／session index／room serial／native start tick；
- actor slot／global serial／ASCII-normalized user ID、box／item index；
- authencode byte、signed amount parameter、multiplier／delta／diagnostic flag；
- Money／Exp／Win／Draw／Lose完整Before與After；
- exact五個scalar-coded bytes：156 selector＋四個u8。不是TCP framing／CRC trailer，也沒有新增client JSON協定。

`CommitMoneyPickup`固定欄位順序canonicalize、SHA-256、複製packet，在自己擁有的`BEGIN IMMEDIATE`中：

1. 先查相同key；完全相同canonical payload／packet回`duplicate`，不同則拒絕。**先於CAS**，所以ABA或Before=After不會使舊key再次加錢。
2. 新key必須接續本round最後一筆ordinal，且room／start descriptor不能改；已存在`RuntimeGameResult`則拒絕新claim。
3. 比較該user全部五個Before數值後，寫入絕對After，再INSERT receipt。任何CAS conflict不改資料、不留receipt；INSERT／SQL錯誤整筆rollback。
4. immutable UPDATE／DELETE triggers防止意外重開舊key；另有closed-round INSERT trigger。result commit也核對該UUID已有money receipt的room／start descriptor。

`GetMoneyPickupReceipt`回detached bytes，重新驗證digest、canonical native計算／packet與denormalized metadata。`ConfirmMoneyPickup`再核對**這一份確切計算**；單一success字串、或數值剛好等於After的no-op wallet，都不能代替收據。

receipt commit／confirm拒絕已存在的外層SQL transaction。SQLite savepoint release不是最外層durable commit，不能在外層之後rollback的狀態先回成功156。底層`UpdateUserDynamicBatch`仍可在receipt transaction內使用nested savepoint，兩者職責不同。

相同舊receipt可在SQL結算後由storage API查詢／去重，並不自動授權live room繼續拾取；controller另檢查round尚未結算。digest是損壞檢查，**不是MAC或防有DB管理權者改資料的安全機制**。

schema1／2會交易式升級為3，既有account／inventory／audit／result bytes不重建。FxItem export仍是獨立的`schemaVersion:1`。備份／個資／retention限制見[Database](Database.md)；不要清receipt表來「修復」重試。

## Frozen plan、重試與game-state協調

`ResultRound`私有狀態保存唯一pending money plan。第一次有效請求在transition lock下產生detached preview；bonus RNG只draw一次。slot／box／item／auth／parameter、Before／After、UUID／ordinal、occupant object identities與live-state fingerprint全部凍結；packet私有保存為immutable hex，每次DB／transport使用新copy。

- SQL失敗、lost commit acknowledgement或CAS conflict都**不改live wallet／claim、不queue156**；保留原plan。SQL不確定性在此處攔下，不因暫時storage錯誤直接關閉請求socket。
- 僅同actor、同box／item且仍通過完整socket-group／ownership驗證的144可請求重試；不把另一個請求替換進來、不重抽、不rebase到新的wallet。
- 真400ms driver也會重試，**在current-time讀取／result capture／UDP regulation／炸彈／死亡timers之前**。重試成功也結束該tick，不在中間順便163或消耗last-update delta。
- pending期間其他room／battle packets與native gameplay adapters、離房／pointer deletion、ghost departure、mode／stats／start／result／return皆受guard；table不flush會改dirty state的room-list snapshot。違反guard的封包仍可能按既有protocol-error政策斷線；這不是透明暫停或可用性保證。
- 時間源仍前進，並沒有捏造暫停封包或改WinMM epoch。下一個正常tick再按native elapsed／timeout／完整frame delta處理。
- commit前後均核對native token／room generation／完整participants／cached user snapshot／context等狀態。DB端再確認原receipt、當下全部五個stored After與未結算round。外部ABA／統計更動或trusted callback竄改live狀態，都不偷偷覆蓋或重新加錢。

驗證通過後，無`await`地呼叫已核對的`IncDecMoney`、確認完整After snapshot、標claim=1、推進ordinal、清pending，最後才queue／flush detached156。send callback看到的是已完成狀態；失敗只計既有publication counter，**不重付、不自動重播156**。這不是exactly-once TCP delivery。

## 與163／164的關係

native163只改XP／WDL，沒有money award。成功coin先同步live與DB，**之後捕捉**result Before時就包含該餘額；不是永久使用launch時的舊money baseline。若money尚pending，連已Ready的native end claims也不能先capture結果／IncGame／改clock／163。

`RuntimeGameResult`仍負責自己的all-five-field result CAS與receipt；不拿它冒充道具帳本。164保留box flags；下一106已在Loading清context，150建立下一money round UUID。實際測試確認5000經第一輪163／164仍為5000，下一genuine round再次拾取得10000，而不是被結算覆寫為0。

## 診斷與明確未完成的恢復

`GetMoneyPickupState()`回detached `Sequence / Pending / Attempts / Failure`，不回wallet／ID／frozen plan。Attempts是本round協調嘗試數，含再驗證失敗，飽和於u32上界，不是transport ACK數。Failure只有：

| Code                   | 意義                                                    |
| ---------------------- | ------------------------------------------------------- |
| `conflict`             | 原all-five Before未匹配；不rebase                       |
| `storage`              | SQL／收據確認／transaction狀態不確定或失敗              |
| `state-changed`        | native generation、participants或凍結live-state不再匹配 |
| `stored-state-changed` | 目前stored After不匹配，或durable round已結算           |

table與HTTP `gameUpdate[].pendingMoneyPickups`計所有未完成plans，包含已durable但尚未安裝的lost-ack case；`pendingResults`另計，不用`failedRooms=0`假裝沒有coin freeze。

**仍沒有通用conflict repair、pending cancellation／compensation、收據retention、斷線orphan重建或crash後live room恢復API。** terminal detach／其他peer斷線會保留計算並拒絕安裝至新／已free對象；不偷偷離線發送或重新綁user。SQL錢包已提交的部分仍在，但receipt本身不能重建整場遊戲。測試中的「恢復原狀」是明示fixture／operator動作，不是已提供安全的營運修復命令。

stored read-back是有用的防呆，**不是對任意外部SQL／任意trusted JavaScript寫者的原子memory＋SQL fence**。同步native kernel與單一Bun room owner的guard不能擴稱分散式共識、完整room restart recovery或外部billing交易。

## 驗證

- money milestone沿用當時12個reference builders／8999組item images，不因現代durability規則改寫；後續第13份game-claims與第14份house-claim模型亦未修改這些舊images。它們是**我們人工轉寫C++**與PE anchors，不是執行官方EXE。
- 800組實際resource money images與10組synthetic IMUL／diagnostic／zero cases，現在同時驗SQLite receipt與真正native-generation144→live／156路徑；synthetic definitions明確由fixture安排，不宣稱archive真的有那些道具。
- `MoneyPickupStorage.test.ts`：all-five conflict、INSERT rollback、ABA／no-op、canonical／changed key、連續ordinal／descriptor、closed round、immutable／corruption、真SQLite writer lock、兩個真Bun程序競爭、close/reopen、schema2保留升級／DDL rollback與最外層transaction限制。
- `MoneyPickupLifecycle.test.ts`：四socket八actor、一次RNG／frozen retry、lost ACK／caller Buffer污染、clock-before-retry guard、room-list／timers freeze、Ready claims不超前、callback重入／send失敗、stored ABA／stale live／terminal detach、外層與late SQL transaction、ordinal exhaustion、真飛機／death／trusted throw reset、163／164／下一genuine round。
- `GameLaunchIntegration.test.ts`：真LS／GS TCP＋UDP＋file SQLite，在真COMMIT後**只注入storage ACK遺失／可用性gate**，由真400ms driver去重後回156；不注入Running、ready bits、clock、RNG、Update、UUID或payout。第一輪coin＋負值clamp、163／8秒164、第二輪新UUID／同box coin與171 reset後新claim，五筆receipt及餘額在clean shutdown／reopen後保持。測試端共用codec，仍不是官方client／完整戰鬥證據。

```sh
./node_modules/.bin/bun test tests/MoneyPickupStorage.test.ts tests/MoneyPickupLifecycle.test.ts
./node_modules/.bin/bun test tests/GameLaunchIntegration.test.ts
./node_modules/.bin/bun run verify
```

最新全套數字、反覆測試及原始檔完整性見[Coverage](Coverage.md)。其他道具裁決／特殊模式／特殊模式waiting-chief／shop／Util／interservice／原client與restart驗證仍須繼續，Bula／lap／case8與已證實的C3復活hook另見[GameClaims](GameClaims.md)；house5money／board／allocator已另用schema4獨立receipt協調，見[HouseClaim](HouseClaim.md)；money／house／special inventory pending互斥、與result共同核對descriptor，不能把這些持久化子集當完整server。

後續第15份[SpecialItemUse](SpecialItemUse.md)人工模型獨立新增，舊14份images不為inventory收據改寫。146 case0不是Type99：paid扣inventory、設Shop／Nice，Type22必要時刷新time；qty0不讀inventory、不留receipt。其schema5 ordinal／159與money的ordinal／156各自獨立；shared fingerprint亦涵蓋inventory，不能在money凍結時改庫存再安裝舊plan。201修正及native ItemSn／StockSn／date mapping界線另見該文。
