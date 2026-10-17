# Bula160／177、圈次155／170、事件8與原版復活hook的實際界線

## 本輪已接入的ordinary native路徑

- `CGameSession::OnReqEatBula 0041CBB2`：request160 → Bula state plane → 全房177。
- `CGameSession::OnLapInfo 0041B5E9`：request155 → per-slot sort／prefix → 全房170。
- `OnSetBomberEvent 0041EE05`的case8：request146 → 兩個opaque bytes原樣附於159，排除整個sender TCP。
- `CGameSession::DeferResurrection 0041B5C8`：按PE的**真正空操作**保留同名方法，沒有新增復活規則或scheduler呼叫。

以上仍不是可玩的完整對局、反作弊、特殊模式或原版client相容性證據。native-generation gate與完整socket group是明示現代防護；不能靠改public Running flags或trusted `BeginResultLifecycle`取得新路徑資格。`completeOfficialRewrite`／`officialClientVerified`仍為false，目前SQLite為schema6，另有獨立[HouseClaim](HouseClaim.md)；Bula／lap／case8本身不新增restart journal。

## 校正：`DeferResurrection`不是待補上的巨大函式

`.lst`把`0041B5C8`標為`DeferResurrection`；實際PE byte就是`C3`，下一個方法從`0041B5C9`開始。這不是因為IDA省略body就能任意補一個重生引擎。舊`.map`的`0041A2AF`不是這批PE的對應位址。

因此本移植同名方法**不讀clock／RNG、不改player state／timestamps／CPoint／ghost、沒有封包或獎勵**，在money／house／result pending期間也只是無副作用的空操作。沒有為了讓它「看起來有功能」而從Update額外呼叫。

`m_bRebirthMap`仍由map+100的`ReBirthMapGroup`取得，普通start在session+12728寫入，practice另有清0 writer。`LaunchGameStage`的同offset `lea`是迴圈end address，不是讀取此旗標做復活判定。本輪核對的普通Update、ghost151／152、146 case8、155及160也沒有讀它作復活資格。state4目前仍保留`Excluded4`描述，不臆造其起始轉移或玩家復活語意。

**這校正的是先前文件一律寫「完整rebirth未移植」的推論。** 已還原此build的空hook，不代表已知client如何呈現復活，更不能宣稱官方client的完整復活玩法已驗證；所附client build／封包／其他模式證據仍缺。

## Bula160：第一個byte不是actor

scalar-coded body，不含opcode：

```text
request160:
  u8 storedState, count
  count times: u8 rowByte, columnByte
response177:
  u8 count
  count times: u8 ORIGINAL rowByte, ORIGINAL columnByte, storedState
```

- `storedState`是原碼不加檢查寫入plane的byte，**不是socket-local self或room actor**。0..255都保留，不能擅加`RequireActor`、`state<8`、chief／死亡／地圖規則。
- plane位於context+4920，26×45個signed DWORD；初始每格−1。native無「只有−1可claim」條件，**既有值會覆寫**，重複pair照原順序echo／寫入。
- native直接用`rowByte*45+columnByte`，沒有逐軸驗證。因此原始column45可alias下一row的column0；本移植保留所有plane內aliases，而不把echo改成canonical座標。
- 完整65,536種byte pairs中，**6,051個flat index在0..1169內，其中4,881個不是canonical column<45**。其餘59,485個會越出Bula plane，可能覆蓋house或其他native記憶體；移植明確拒絕，不重現越界寫入。
- count0仍送177；count255及重複／alias pair都可完整表達。不自行發放money／XP、不改house counts／obstacles／box claim／generated box allocator／ghost／player state／stats／clock。
- sender是通過整組房間身分驗證的socket；native header本身沒有actor。全房包括sender都收到177，兩個local actors仍只有一個TCP收件人。

`GetBulaState`／`SetBulaState`的既有canonical row／column API仍有逐軸防護；handler為保留native flat aliases，另外對直接plane index做整體上界檢查。這不是用Bula當新server collision／spawn engine。

## 圈次155：unsigned QWORD，不是timestamp優先排序

```text
request155: u8 roomSlot, firstProgressByte, secondProgressByte
response170:
  u8 reportedOccupiedCount
  exactly8 times:
    occupied: u8 rank, firstProgressByte
    vacant:   u8 ff, ff
```

native只檢查roomSlot<8，**沒有actor ownership或target occupancy條件**。合法room socket可以回報另一peer或空slot；本移植保留，不能捏造只有chief／自己才能報。這也意味著它**不是可信進度／終點裁決或反作弊證據**。

收到完整body後，native取一次absolute `timeGetTime()`，不是ElapsedTime或扣過pause的時長：

```text
LOW  DWORD = absoluteTick
HIGH DWORD = ((255-firstProgressByte)<<8) | (255-secondProgressByte)
perSlotPrefix = firstProgressByte
```

`+12632`是8個上述兩DWORD記錄，start時兩字皆FFFFFFFF；`+12696`是8個prefix DWORD，start清0。rank比較**unsigned64**，先HIGH，再LOW；較小值較好。兩筆完全相同時較低slot先。不能誤作signed時間排序、先比時間、或把所有未知者當rank0／省略。

- rank全部從1開始，所有occupied玩家互相比較，**未回報但occupied的FFFFFFFF／FFFFFFFF也參與排名**。
- header count則只計occupied且`(LOW & HIGH)!=FFFFFFFF`者，與rank參與人數不同。
- 空slot可以保存被回報的sort／prefix，但不被count或顯示，仍輸出FF／FF。離房不偷偷清既有sort；之後排名只看目前occupancy。
- 兩個progress bytes的精確client UI用途仍未建立，不猜成tile座標、已完成圈數／checkpoint授權。request154才是既有`OnLapFinished`的state5 claim。
- 本handler不改clock start／end／stopped、player state／statistics／wallet、不結算、不推進Update的last tick，沒有RNG。

`GameLapRule`集中255／shift8／rank1／vacantFF的已確認意義；array layout與launch初始化沿用`GameLaunchRule`。時間源仍是現代clock adapter，**沒有解決WinMM OS-boot epoch parity**。

## 事件8：IDA漏掉參數不等於丟棄第二byte

共同header仍為`u8 (8<<4)|actor, u16 x, u16 y`，接`u8 opaque0, opaque1`。actor必須通過既有room-slot／sender ownership；x／y仍是WORD，不是tile plane indices。

`0041F1DE`保存第一個byte，`0041F1E9`保存第二個byte，`0041F1F3`明確push第二個值交給Encode1。IDA在goto共用尾段把該參數漏寫，不能依偽C的空呼叫捏造0或丟棄欄位。

回159保留共同header及**兩個opaque bytes**，排除整個sender TCP。沒有state、ghost、CPoint、timestamp或stat變更，沒有map／alive／rebirth條件。0的免費relay／paid inventory消耗現另經獨立schema5 receipt接通，Type22只刷新state3 time，詳見[SpecialItemUse](SpecialItemUse.md)；client5仍依現代server-only政策拒絕。

**WORD wire為big-endian**，XOR A569；x86物件記憶體為little-endian不代表封包也是。FXGS `Encrypt2 00432478..00432482`明確先存AH再AL。第一次真網路交叉驗證抓出新C++參考一度把WORD寫成LE；production codec原本正確。本輪修正了新模型，並對每份case8同時驗raw bytes與解碼後數值，避免錯誤request／echo自我抵消。舊12份參考模型未改。

## 凍結、terminal sockets與發布

- pending money／house／special inventory／result會先擋三條新入口；既有money fingerprint包含整個context與lap state，所以不允許在凍結後修改Bula或進度再安裝舊wallet計畫。
- 新native paths與共用`RequireNativeRunningRound`額外拒絕已closed的sender socket；既有整組檢查也拒絕SetFree／stale secondary／錯generation。這是現代生命週期防護，不冒稱native error path相同。
- 整筆body／bounds先驗完，再進transition／detached batch；late invalid cell、truncation／trailing data不會留下有效prefix的部分更新。
- Bula整批、lap sort／prefix完成後才發布；case8亦在transition guard內排除sender發布。callback重入不准改gameplay／roster／result；巢狀Update是原guard的無副作用return，不是新例外。
- 每peer有detached packet；某一send失敗只增加既有publication counter，不污染其他peer、不中斷已完成狀態、不自動重播。Bula與lap都是可再報告的state，不宣稱exactly-once delivery。
- 測試會在transport錯誤隔離邊界**外**檢查callback assertion failure，避免「assertion被當成send錯誤吞掉」造成假通過。

164保留Bula與lap state；下一次真正106的Loading階段已Init成Bula全−1、sort全FFFFFFFF、prefix全0，150才完成新round UUID。這些live資料**不是SQLite restart journal**，本輪沒有提供round重建。

## 後續House161已接獨立耐久協調

先前拒絕house是因為來源確認每new cell有5金錢，不能只送178／改board卻省掉wallet。後續現已以schema4的獨立`RuntimeHouseClaim`接通board／color counts／generated-box allocator／all-five wallet CAS／exact178與frozen retry，不挪用Type99 resource／156 receipt。

native allocator耗盡會break卻patch原requested count；移植明示為whole-request拒絕，不發殘缺body、不先付錢／占格。native先send後money的順序亦明示改為durable＋完整live後detached發布。完整來源、31 anchors／1633組模型與限制見[HouseClaim](HouseClaim.md)。這不是變更Bula／lap的既有28-anchor reference，也不表示完整遊戲／restart已完成。

## 證據與可重建測試

`Tools/BuildGameClaimsVectors.ts`先read-only驗**28個PE anchors**，只編譯／執行我們人工C++，不執行原EXE。新固定JSON包含：

| 類別                              | 數量  | 驗證                                                           |
| --------------------------------- | ----- | -------------------------------------------------------------- |
| safe Bula single-pair images      | 6051  | exact160／177 bytes與state writes，含4881 aliases              |
| out-of-plane Bula classifications | 59485 | byte-pair全域補集；modern rejection，不是native錯誤輸出oracle  |
| Bula batch images                 | 256   | count0..255、state全byte域、duplicate／alias／order、完整plane |
| lap topologies                    | 247   | 所有至少2人的8-slot masks，測試用真正table departures達成      |
| lap boundary sequences            | 72    | 2／8人、六種DWORD邊界時間的所有兩兩組合                        |
| lap step images（上兩類合計）     | 2160  | unsigned64、reported count、raw170、完整sort／prefix           |
| case8 images                      | 10240 | actor0..7、兩個opaque bytes／WORD numeric values／raw159       |

合計**18,707份有效handler images**，另59,485個明示現代Bula安全分類；不是原程式動態oracle、client授權或完成率。

`GameClaims.test.ts`另覆蓋phase／完整group／closed／SetFree、pending money／result、once-only absolute sample、clock callback與transport重入／失敗、no-op resurrection、house5money durable smoke（先前fail-closed fence已由house專檔取代）、164保留／下一genuine106清除。

`GameLaunchIntegration.test.ts`以真LS／GS TCP＋UDP、真SQLite、實際400ms／8秒driver及兩輪native start，驗Bula aliases／count0／新round重設、foreign及vacant lap target／實際時間window、case8精確bytes與sender排除。只有先前money COMMIT後的storage ACK可用性被故障注入；沒有注入Running、ready bits、clock、RNG、Update、UUID或payout。client端仍共用codec；重開庫驗的是wallet／receipts，不是假稱Bula／lap已提供crash恢復。

```sh
./node_modules/.bin/bun run Tools/BuildGameClaimsVectors.ts
./node_modules/.bin/bun test tests/GameClaims.test.ts
./node_modules/.bin/bun test tests/GameLaunchIntegration.test.ts
./node_modules/.bin/bun run verify
```

最新全套數字、反覆測試、15份reference穩定性與98份供給檔完整性見[Coverage](Coverage.md)。其餘特殊道具／Mod／practice／特殊模式waiting-chief／shop／Util／interservice／restart及原client驗證仍須繼續。

case0與case8共用146但額外欄位完全不同；case0正quantity有request-only SN，case8兩opaque bytes沒有inventory用途。201 Amount／Verbose／rawdate修正與native ItemSn／StockSn、Unix-date bridge的未完成映射，見[SpecialItemUse](SpecialItemUse.md)，不能從本文件的case8證據推論完整商店。
