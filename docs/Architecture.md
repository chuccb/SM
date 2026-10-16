# 架構、命名與明確移植差異

這份工作樹以附帶的六套官方服務證據為依據；新增TypeScript，不覆寫原EXE／反編譯／設定／資源／備份。**不是完整官方server，也沒有原版client驗證。** 現況見[Coverage](Coverage.md)。本頁曾誤重複Database章節；本輪依實際程式重新整理本頁，資料庫專屬內容仍完整保留於[Database](Database.md)。

## 來源與命名

| 原始角色                        | 目前路徑／角色                                                                                                    | 明確差異／缺漏                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 各服務packet／CRC／stream／text | `Common/CSendPacket*`、`CReceivedPacketBase`、`CPacketSocket`、`CBufferManipulator`、`SimpleStream`、`CTextCodec` | 保持binary方向與原名；不是JSON遊戲協定，legacy cipher不是TLS           |
| Center user／server tables      | `Center/CCenterServer`、`CGlobalUserTable`、`CLocalServerMan`、`CUser`                                            | **in-process**共享物件；不是原Center TCP、多程序、Win32 object layout  |
| local Center facade             | `Common/CCenterProcess`                                                                                           | 明確server綁定與現代授權lease，沒有假的wire registration ACK           |
| LS                              | `LS/CLoginServerApp`、`CLoginPool`、`CChannelCache`、`CMultiServer`                                               | 登入／轉服子集；密碼改Argon2id                                         |
| FXGS pools／rooms               | `FXGS/CFxServerApp`、`CConnectPool`、`CChannelPool`、`CBaseSession`、`CGameSessionTable`、`CGameSession`          | ordinary子集；waiting-chief／practice／ladder／mission／guild仍缺      |
| 對局clock／context／物件／資源  | `CGameClock`、`CGameContext`、`CSyncGameObjMan`、`CItemAttr`、`CBomberAttr`、`CGameMapTmplList`等                 | 來源對照核心，不冒稱完整可玩world／反作弊                              |
| DBSession／CDBMan               | `Common/DB`與`LS`／`FXGS`／`FXSS`原名類別                                                                         | SQLite取代OLEDB；原native procedures／billing未完成                    |
| native owned inventory          | `Common/UserInventory`、`FXGS/UserInventory`、`Common/CUser`                                                      | trusted read-side／201／105；正式SQL仍legacy，native positive paid拒絕 |
| civil calendar／DB clock        | `Common/CTime`、`Common/Calendar`、`Common/DB/NativeCalendar`／`CDBClock`                                         | 顯式ports／嚴格Gregorian子集；隔離clock未自動接正式GS／native SQL      |
| updater／UDP loss               | `CTimerThreadNormal`、`CUdpLossRegulator`、`MTUDPServer`／`CUDPPacketDispatcher`                                  | 400ms ordinary scope／discovery opt-in，不是完整MTUDP                  |
| Relay                           | `Relay/MTUDPServer`                                                                                               | 明確opt-in與現代限制，非完整端到端client證據                           |
| 整合啟動                        | `CServerApp.ts`、`Main.ts`                                                                                        | 現代部署glue；不以空FXSS／FXUS class冒稱完整服務                       |

原game constants／layouts集中`Common/OfficialValues.ts`，操作上限／TTL／receipt版本在`RuntimePolicy.ts`，packet方向在`Protocol/PacketTypes.ts`。未證實的attrs／opaque bytes保留角色，不改叫通用價格／flags。原普通strategy部分no-op是PE return／vtable已核對的例外，不等於可以用placeholder補未讀程式。

## 啟動與清理

```text
Main：固定Bun版本、載入TOML
  └─ CServerApp
       ├─ FastFile → bomber／map／tile／item與ship資源
       ├─ 共用CDBSession → schema6 migrations／integrity
       ├─ in-process Center
       ├─ 各CFxServerApp → TCP、可選discovery UDP、ordinary timer
       ├─ CLoginServerApp → TCP
       ├─ 可選Relay UDP
       └─ 可選唯讀HTTP／maintenance
```

constructor讀資源／開DB／建cache；`SetUp`才bind。任一步失敗走同一cleanup，GS offline；UDP啟動失敗撤回TCP。`Main`在announce就緒前註冊signals。cleanup先停timer／UDP／listeners、等已斷線但未完的handler與socket close callbacks，再關DB；不能在Argon2 await恢復前把DB關掉。

`processReady`僅表示已實作listeners就緒。`completeOfficialRewrite`、`officialClientVerified`保持false；game updater明示ordinary scope，native launch需UDP opt-in，不等於完整playable round。

## 登入、ownership與授權lease

1. LS解碼1–2組帳密；Argon2在transaction外處理，全部帳號仍valid且socket活著才register整組。ID用ASCII folding匹配SQLite NOCASE，不做Unicode小寫猜測。
2. Center按source ownership／未入房／無pending／target online與容量保留整組pending。source與target service epochs、group frozen refs及原expires固定。
3. GS request7完整解碼後，**先取得bound非消耗式lease**，再讀account／inventory與做detached210／202／201。錯ID／guild／serial／IP沒有任何DB read。
4. 讀取／codec之後全組重新檢查；loaded rows重綁authorized ID，live copies不alias DB adapter回傳物件。最後才single-use commit／整組owner切換／source detach＋close。
5. 讀取或編碼失敗只釋放準備，不取消／延長pending；source TCP可在pending中斷線且不free新owner。service restart／source ABA／expiry／invalid clock不能重用舊authority。
6. logical handoff後rank／transport failure沒有回滾或exactly-once傳送；舊socket關閉不得刪除已交給新owner的共享users。

此lease是**現代hardening**，不是原native CHECK：原`CheckConnectingToSvr`成功時已改flag／tick、native timeout17500ms與現代30000ms也不同。private issued registry、48項新tests、raw Center投影與仍缺的native候選資料rebind／durable effects recovery見[ConnectionAuthorization](ConnectionAuthorization.md)。

## 定義目錄與storage邊界

`CUserItemMan`採whole-input驗證後的immutable unsigned-SN map／202 cache；reload僅讀trusted committed資料，不在client202過程中查SQL。schema6只有FxItem欄名rename；v2 export與v1明確adapter、safe逐statement migration見[UserItemCatalog](UserItemCatalog.md)／[Database](Database.md)。原生owned ItemSn／StockSn／raw DATE不由legacy SN／ItemID／Unix expiry猜出。

四種現代gameplay receipts皆version1，server UUID＋canonical payload／exact bytes與root SQLite CAS提交；不是原stored procedures或商城帳本。pending world／identity／generation fence、COMMIT後drift與lost-ACK明確retry不等於通用外部writer鎖、restart journal或原client判勝授權。見[ResultLifecycle](ResultLifecycle.md)、[MoneyPickup](MoneyPickup.md)、[HouseClaim](HouseClaim.md)、[SpecialItemUse](SpecialItemUse.md)。

## Ordinary gameplay與未完成範圍

已接ordinary106／discovery／109／150、Loading／Running／Result timer與163／164尾段，以及來源對照的ghost／airplane／pickup／Bula／lap／house／special-item子集。actor ownership按各handler來源，不把foreign／vacant原生分支一律改成owner-only。DeferResurrection是PE核對的空操作，不據此捏造完整rebirth。離房／UDP loss、frozen claims與全組guards另見[PlayerRemoval](PlayerRemoval.md)、[GameLaunch](GameLaunch.md)、[GameUpdate](GameUpdate.md)、[Gameplay](Gameplay.md)。

缺少的特殊modes、world／商城／utility、native SQL／日期／pre effects與crash recovery不因ordinary測試通過而完成。`BeginResultLifecycle`等trusted hooks／fixtures不是網路可以任意要求的payout endpoint。

## 安全與部署差異

- 一個Bun event loop＋共用SQLite／Center，取代Win32多程序／IOCP／OLEDB／原async writer；現代同步lease不是跨worker lock或原Center TCP。
- 不執行supplied EXE／DAT／carved SQL；不改host clock、不提供remote system/crash/destroy commands，不主動連舊官方／billing／download端點。hello中的URL僅封包文字。
- 新密碼Argon2id、沒有預設帳密；本機CLI用stdin，不把真正密碼放argv／Git／logs。帳號／receipts含個資，保護DB／備份；沒有retention／安全刪除／完整營運方案。
- RuntimePolicy集中rate／queue／buffer／TTL等現代limits；不是把它們冒稱遊戲原常數。metadata／opaque欄位不猜價格。
- native cipher／CRC不是TLS或modern authentication；same-IP＋random32-bit serial仍是bearer-style轉服威脅模型。不要對公網部署為完整官方server。
- registration、GS UDP與Relay預設關；角色／group／phase／body完整檢查不等於反作弊／原client相容。
- invalid或倒退Center clock取消outstanding transfers，maintenance隔離例外並以`centerMaintenanceFailures`／generic log報告；不靜默延長authority，也不讓timer未處理例外退出行程。

### GS discovery與Relay

GS UDP僅為已authenticated TCP群組、同IP／channel／room generation的discovery，不回應任意UDP探測、不提供完整MTUDP。Relay為獨立opt-in listener；有來源／速率／host map限制，不代表完整可玩NAT／peer傳輸。

### HTTP診斷

只支援GET／HEAD，沒有帳號／付款／GM mutation；`/readyz`200仍會回報完成／client旗標false。頁面同源相對URL，接受preview Host，不向使用者瀏覽器的localhost呼叫。數值診斷不輸出SQL／帳密／玩家資料。

## 原生持有道具read-side與明確storage邊界

`CUserItemMan.CaptureSnapshot` 提供穩定的 immutable definition generation，`PlanInitUserInventory` 以已觀測raw DATE／signed16 threshold依原順序投影，不碰SQL／host clock。`CUser.InstallUserInventory` 明確附掛immutable native vector，與legacy `m_aInventory`分開；原生mode封住空legacy view，舊array alias不能混入新layout。201／105與飾品讀取同一generation，105另clone simple-info抵抗codec callback混代。

money／house／legacy paid與result的frozen fingerprints涵蓋native mode＋revision，byte-identical reload／ABA也不能重試舊plan；storage callback後再次檢查，若已root COMMIT但native generation改變，保留durable receipt並凍結live publication，不自動rebase／重付。這是現代可信內部防護，不是native paid SQL已完成或任意JS／外部SQL writer的全域原子fence。正式GS inventory loader仍是legacy SQLite bridge，native positive paid明確拒絕；pre正式effects／完整初始化、完整Windows calendar／provider整合／native persistence／flush／collector未完成。另有[PreInventory](PreInventory.md)純觀測投影／CUser讀取端207；其獨立generation亦加入Center及pending fingerprints，其[整組讀取端207發布](InventoryHandoff.md)亦已接正式GS，但沒有據此授予financial replay或full initialization權限。詳見[UserInventory](UserInventory.md)。另有[Calendar](Calendar.md)的timestamp-copy／CTime／嚴格DATE子集與隔離CDBClock，不使用JS Date／SetLocalTime，不改native負DATE數值比較、不把clock revision視為financial grant；尚未自動接正式GS或native provider。
