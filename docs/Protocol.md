# 協定方向、來源與未知欄位

本頁是已確認binary layout／數值與實作邊界索引，**不是完整官方協定規格**。原證據保留不動；descriptive enum names不是宣稱已找回全部原enum symbols。曾重複到本頁的Database章節已留在[Database](Database.md)，本頁依現存codec／handlers重新整理。

## 共用wire核心

- opcode按**方向及服務**命名，同數字在request／response可有不同角色；以`Common/Protocol/PacketTypes.ts`和各handler為準。
- `CipherDegree`0／1／2分別None／CRC32／CRC8；frame overhead為3／7／4bytes。client `CSendPacket`預設CRC8 scalar-obfuscated body，local／initial封包要明確None。
- scalar BYTE／WORD／DWORD編碼與stream／CRC分層；WORD／DWORD採big-endian，scalar XOR keys集中於`OfficialValues`／`CBufferManipulator`。raw buffer不套同一scalar XOR。
- legacy字串先依部署碼頁轉bytes，再WORD長度＋raw bytes；不是默認UTF8，也不把未知資料全當字串。`CTextCodec`拒絕NUL／不可往返碼頁；現代encoder拒絕過大字串而不是原來的silent empty。
- stream／CRC只是原協定相容核心，不是TLS／密碼學authentication。TCP unit／integration peers使用production codec；固定人工C++向量提供另外的byte核對，仍非原client錄包／EXE oracle。

## LS主要方向

| request           | 回覆／角色                 | 範圍                                                             |
| ----------------- | -------------------------- | ---------------------------------------------------------------- |
| 1 AskMultiServer  | 1 server list              | cached hash／列表子集                                            |
| 2 AskFirstInfo    | 2 first info               | 原URL等文字不是移植會連線的下載操作                              |
| 3 Login           | 3 login結果                | 1–2 local users、legacy字串crypt與Argon2後端；不是原外部身分驗證 |
| 4／5              | ID確認／註冊結果           | 註冊預設關，現代limits明示                                       |
| 6 ReqConnectToSvr | 6 transfer address／result | Center保留pending，不是GS已連上                                  |

request6 type／index按服務parser；不能因opcode相同就將Shop或GS body與LS全部共用。Center目前是typed in-process facade，沒有假裝已發原Center TCP packets。

## GS request7與Center授權順序

client request `7`：

```text
u8 localCount (1..2)
repeat localCount: str ID; u32 globalSerial; u32 guildSerial
u32 integrityPart0; u32 integrityPart1
u8 initializedFlag                 // 0 -> already initialized
```

兩個DWORD XOR後與`OpaqueOfficial.FxClientIntegrityXor`比對。它不是RTT20的另一組常數；不要抄成同一mask，也不把它稱為不可偽造authentication。native對modified client的處理與移植whole-request拒絕有差異，不能由integrity通過推論有Center權限。

目前正式路徑在完整解碼之後，**先Authorize原pending exact group／ID／serial／guild／IP／server epoch**，再讀account／legacy inventory、prepare210／202／201，最後single-use confirm。錯誤身份在任何DB read前拒絕；encoding成功也不能取代最後lease check。沒有虛構response7 success ack。

- `210` GameAttr，不是channel type；一般已實作路徑必要時接`202` definitions與`201` inventories，再room list。
- initialized=true的目前legacy路徑不編202／201，但仍驗證與讀取帳號／庫存；不是預檢未送body。
- known lease只能in-process使用，不加入client frame、不當bearer token傳送；JSON／copy同形物件不成立。
- native初始化在**Center成功response之後**的`0040885B..004088AF`，不得直接放到未驗證的request7裡做money／XP／procedures。
- 原碼另有pre207條件：!initialized→202；任一local pre-count>0→207（all locals）；若202或207→201。**本工作樹尚無native pre SQL／207正式接線，不憑空製造此body。**

來源、native CHECK副作用／17500ms與modern30s不同、private issued registry與實際新TCP rejection／retry見[ConnectionAuthorization](ConnectionAuthorization.md)。

## 原生Center狀態：不是這個lease的wire格式

Center `CUser+20`為free DWORD、+56 auth DWORD、+60 type BYTE、+64 signed server index、+68 connecting DWORD、+72 tick DWORD。FXGS auth則是BYTE+2004；同樣叫Authencode不代表同一raw width。

`CheckConnectingToSvr004153B0`只允許type1／10／11、registered signed index／online等條件；premium41需**DWORD恰好1**。成功CHECK已設flag／tick，後續SetConnecting才改server／list。`CheckConnectionEstablished00415570`檢查free／nonzero connecting／exact type-index，不採clock、不消耗flag；`SetConnectionEstablished00415120`才清flag。另由`DeferDisconnectTimeout004155F0`做unsigned `(now-start)>17500`／SetFree。

raw pure投影／36PE anchors／3444 cases與256個native inner-loop組合是我們的獨立模型；不執行原binary／Win32，也不將native先改狀態、只用最後result的危險迴圈直接接到現代群組權限。

## 房間／ordinary gameplay索引

| request／response      | 角色／已實作子集                                                             | 文件                                                             |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 80／81／82／83         | create／join／autojoin／lobby，slot／serial／群組ownership                   | [PlayerRemoval](PlayerRemoval.md)                                |
| 96..109                | ready／map／color／bomber／slots／普通start與loading協商                     | [GameLaunch](GameLaunch.md)                                      |
| 106→116／120／150      | ordinary native launch／discovery／109 agreement、fresh round generation     | [GameLaunch](GameLaunch.md)                                      |
| 144／145、156 response | item／obstacle claims與Type99 money                                          | [ItemPickup](ItemPickup.md)、[MoneyPickup](MoneyPickup.md)       |
| 146→159                | BomberEvent，case0 special-use／case8 opaque echo等                          | [SpecialItemUse](SpecialItemUse.md)、[GameClaims](GameClaims.md) |
| 149→raw公告            | local-self event／CP949原始文字，未擅改unknown欄位                           | [ItemPickup](ItemPickup.md)                                      |
| 151／152→166／167      | ghost generate／destroy核心                                                  | [Ghost](Ghost.md)                                                |
| 156→171                | airplane request與future-marker／box-item reset                              | [Airplane](Airplane.md)                                          |
| 160→177、155→170       | Bula與lap核心                                                                | [GameClaims](GameClaims.md)                                      |
| 161→178                | house board／allocator／native5money與獨立durability                         | [HouseClaim](HouseClaim.md)                                      |
| 163／164 responses     | 結果／普通回準備尾段，不是request146回覆                                     | [ResultLifecycle](ResultLifecycle.md)                            |
| response121            | ordinary waiting-chief reason0..3＋WORD warning seconds；非client grant／195 | [WaitingChief](WaitingChief.md)                                  |
| 185／187、195 response | UDP loss／普通移除／pool4                                                    | [PlayerRemoval](PlayerRemoval.md)                                |

各handler對actor、foreign／vacant targets、opaque bytes、time gate的規則並不相同；不能以通用owner-only／全部unsigned等方式「修正」來源。ordinary範圍／特殊mode拒絕及frozen世界／SQL retry見[Gameplay](Gameplay.md)／[GameUpdate](GameUpdate.md)。沒有可玩的整場或完整原client驗證。

## 庫存、202與native／legacy不可混用

- request **209**→response **201**；不是request50，也不是商城購買成功。
- 原生201：localCount BYTE；每人residentCount DWORD；每row `ItemSn DWORD, Slot BYTE, Amount DWORD, str Verbose, raw8 LE f64 DATE`。不是StockSn／ItemID／Unix time。
- 正式SQLite legacy bridge仍用storage SN與顯式Unix／zero-date bridge。native read-side需trusted明確附掛，不能靠ItemID數字相等轉換。
- 原202：WORD count、unsigned-SN排序，再SN／Category／strAttr／nAttr1..3／strName；不是ShopItem stock／Price／Duration猜測。immutable cache與strict v2／v1 import見[UserItemCatalog](UserItemCatalog.md)。
- 105 self裝備／accessory consumers與native generation／same-value ABA fence見[UserInventory](UserInventory.md)；native positive quantity paid仍在legacy CAS前fail-closed。
- 146 case0 quantity0沒有SN且不碰inventory／Shop／Nice／receipt；positive才有storage-domain SN。159不echo SN並排除整個sender TCP；Type22僅state3刷新timestamp、108在SN前早退。見[SpecialItemUse](SpecialItemUse.md)。

## 未知欄位與不做的推論

opaque BYTE／WORD、catalog nAttr依Category／handler解讀，不自行當價錢／duration／flags；SID／BID／global serial／guild serial／stock SN／storage SN分開。raw OLE DATE不猜成永久item／UTC／Unix，也不執行SetLocalTime。[pre-inventory的單人207 body](PreInventory.md)已可在可信附掛後編碼，並由[正式GS整組handoff](InventoryHandoff.md)補local-count／空local、202共用snapshot及conditional201；其opcode207與client delete207方向分離。FXSS／FXUS／Center TCP、native pre正式effects／billing／Windows calendar與完整native SQL仍未完成；沒有以新JSON API或固定成功ack掩蓋缺口。

## 原生持有道具／equipment consumers（可信read-side附掛）

request `209` → response `201` 已使用真正channel handler消費兩個native local users；201為DWORD count、ItemSn DWORD、Slot BYTE、Amount DWORD、Verbose、raw8-byte LE DATE，不是StockSn／ItemID或Unix time。105 self BYTE來自首個equipped Category4的nAttr1 low BYTE（無則255），accessory採Category10 positions0..8、Category12 positions0..4及Category14 tail。capture同一native generation＋simple-info，不混codec callback重載前後資料。

這些原生consumers需可信內部`InstallUserInventory`，不是已接native SQL→GS、裝備request／商城或授予endpoint。既有正式handoff仍讀legacy SQLite；正quantity native paid暫時fail-closed，quantity0仍relay。72 PE anchors／1768獨立C++模型、完整wire順序、400-counter／DATE與未完成界線見[UserInventory](UserInventory.md)。

## 普通等待房121

`0041C15B`：0／1 warning向全room sockets，2／3 kick只向chief TCP；後續由table移除chief整組locals、pool4，不送195或自動15。兩種reason配同一WORD full warning seconds（10或30），不是remaining／slot／token。capacity+833與current+832分開，native HasAuthority0041688A是固定0，不從SQL Authority推角色。可信resident `Item/SuperChief`延長3倍；ordinary正式timer已接線且有未加速真TCP，非native SQL／client完整性證明。見[WaitingChief](WaitingChief.md)。
