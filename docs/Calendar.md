# 原生日期欄位、CTime 與隔離 DB calendar clock

本輪從 supplied PE／decomp／listing重新推導日期邊界，補上 `Common/Calendar.ts`、`Common/CTime.ts`、`Common/DB/NativeCalendar.ts`、`CDBClock.ts` 及 CDBManBase 的兩個同名 copy methods。

**這不是完整 Windows／OLE DB emulator，也尚未把 native provider／SQL 初始化接進正式 GS。** 既有原生庫存仍接受已觀測 raw DATE；正式 SQLite／legacy201仍是明示 Unix expiry bridge，不自動轉欄位、migration、給付或新增receipt。`completeOfficialRewrite`／`officialClientVerified`仍為false。

## 原始欄位：兩種轉換不能混為一談

`tagDBTIMESTAMP` 16 bytes：signed SHORT year、WORD month/day/hour/minute/second、DWORD fraction。`_SYSTEMTIME` 同為16 bytes，但在 month 之後插入 weekday，最後有 milliseconds。`NativeTimeFormat` 集中尺寸與 offsets；不是把兩個16-byte struct直接互拷。

| 操作                        | 原始VA（FXGS／LS）     | 六個 civil 欄位                          | weekday  | milliseconds／fraction               |
| --------------------------- | ---------------------- | ---------------------------------------- | -------- | ------------------------------------ |
| `ConvertDBTimeToSystemTime` | `004404D0`／`00431CD0` | 保留WORD位元；signed year轉unsigned WORD | **未寫** | ms明確為0，fraction不使用            |
| `CDBRowset::Get_FieldDate`  | `00440F00`／`0042C540` | year/month/day/hour/minute/second拷貝    | **未寫** | ms也**未寫**，fraction雖讀取但不使用 |
| `ConvertSystemTimeToDBTime` | `00440520`／`00431D20` | 六個WORD；year回到signed SHORT           | 不使用   | fraction**一律0**，不使用來源ms      |

`.lst` 的 Get_FieldDate 最後六個WORD stores並沒有補 weekday／ms。這不是前一次CTime的值，不是SQL NULL，不是從fraction換算出的毫秒，也不能因為在Linux移植就憑空設為0。

現代DTO因此以 **`null` 明示未觀測／未寫入word**，只允許這兩欄為null；若可信caller另有確定的word觀測，可以明示供給。`ReadDBTimestamp`只解碼精確16-byte detached LE input，不推測provider binding／DBSTATUS／SQL NULL，不接受Unix數字或日期字串。

`CaptureDBTimestamp`接受signed或unsigned SHORT year spelling，輸出signed bits；轉SYSTEMTIME再保留unsigned WORD。這只是native位元拷貝，不表示負年份或65535是有效日期。copy validation與calendar validity刻意分離。

## CTime：明示ports，不偷偷讀主機時間

原始 `CTime`：default ctor／SetCurrentTime呼叫GetLocalTime；SetTime／GetAsSystemTime拷貝全部16 bytes；GetYear／Month／Day／Hour／Minute／Second／weekday讀stored WORD。FormatTimePlain是month/day/hour/minute/second的minimum-two-digit串接，**不含year**。weekday字串0／7都為Sun，1..6為Mon..Sat，其餘為空；未知word在現代讀取時拒絕，不模擬stack垃圾。

`CTime.GetTickCount`（FXGS `00408DD5`）實際回傳calendar `CTime*`，**不是 WinMM DWORD tick**。現代版本回傳分離snapshot，避免native共用mutable `ms_timeCurrent`讓不相關server或已持有的time reference被重寫；不改既有 `CGameClock` 的 unsigned DWORD／rollover 規則。

```ts
const clock = new CDBClock(monotonicMilliseconds);
// trusted OBSERVATION，這裡沒有執行prGetTime／SQL或SetLocalTime：
clock.SyncLocalTimeFromDB(observedExecResult, observedDBTimestamp);
const environment = StrictCalendarEnvironment(() => clock.GetLocalTime());
const current = new CTime(environment);
const stored = new CTime(environment, Get_FieldDate(observedDateColumn));
```

環境要求顯式 `GetLocalTime` 與 `SystemTimeToVariantTime` ports。CTOR有明示time就不sample；只有omitted／undefined才sample，null不會被誤當default clock request。ports與欄位先capture、copy/freeze；SetCurrentTime／SetTime失敗原值保留，recursive read／conversion拒絕。GetVariantTime先latch輸入，即使callback更換CTime內容，本次仍使用原snapshot；結果的Success／Value只讀一次。

### 原始 API failure 是不確定值，不是DATE0

FXGS `00433850..00433867`／LS `00424B10..00424B27` 呼叫 `SystemTimeToVariantTime` 後，**不檢查BOOL就fld stack double**。若API失敗且未填out值，原碼可讀到不確定記憶體。現代ports回傳`{Success,Value}`，false／missing／NaN／Infinity均拒絕；不填0掩蓋失敗。真實成功DATE0與明示觀測的negative-zero raw bits仍保留。

## 可攜嚴格 Gregorian 支援子集

`StrictSystemTimeToVariantTime` 是**明示、可替換的現代profile**，不是宣稱與原機某版OleAut32逐bit等價：

- proleptic Gregorian、year **100..9999**；僅接受真實有效month/day與hour0..23／minute,second0..59。
- **seconds包含在時間fraction內，milliseconds忽略**。未觀測weekday／ms不妨礙此conversion，因為二者不參與DATE。
- epoch為1899-12-30；1899-12-29 06:00是**-1.25**，18:00是**-1.75**；epoch day本身加正fraction。不是Unix seconds，也不是所有日子都能用`days+fraction`。
- 不使用JS Date、UTC/local轉換、主機TZ或DST；以整數Gregorian year/month arithmetic再產生binary64。
- **拒絕**invalid-day rolling（day0、非閏年2/29等）及00..99的OS-dependent century mapping，不猜原機Windows／regional設定。這些是支援範圍的明確縮限，不是來源API根本不接受。
- 本輪沒有 DATE→SYSTEMTIME通用inverse，也沒有宣稱原DLL的所有floating rounding／calendar／range行為已證實。

Microsoft固定版本 [SystemTimeToVariantTime API文件](https://github.com/MicrosoftDocs/sdk-api/blob/cdefd0ed0fa0834394799655b080b019374e95cb/sdk-api-src/content/oleauto/nf-oleauto-systemtimetovarianttime.md)記錄BOOL、秒解析度、ms ignored與invalid-day rolling；這不是原供給系統的DLL版本證據。另以read-only Wine測試研究過00..99 century cutoff的OS差異，**不複製／編譯／執行Wine程式碼**，也不將其當original oracle。

## CDBClock：取代危險host SetLocalTime的隔離設計

原 `SyncLocalTimeFromDB` 是`prGetTime`→signed ExecResult>=0→ConvertDBTime→**SetLocalTime**；成功與失敗各log。移植絕不執行這個host clock副作用。

新 `CDBClock` 是獨立per-server、fixed-civil clock：

1. 初始unsynchronized，Read在任何monotonic callout前拒絕。它沒有自動的SQLite／prGetTime provider。
2. 可信caller明示observed ExecResult與DBTIMESTAMP；負signed DWORD（含unsigned spelling）不讀timestamp、不sample、不改anchor。
3. copy／strict civil validation完成才sample注入的**完整safe-integer monotonic milliseconds**，把DB civil值（ms0）與該sample綁定。這不是GameClock的32-bit rollover port。
4. elapsed以獨立Gregorian civil integer arithmetic推進，不對raw DATE直接加ms/day。clock輸出的weekday／ms是**此現代clock計算的值**，不是說native DB copy曾寫入它們。
5. 成功sync即使同值也增加generation；`CaptureLocalTime`在同guard內捕獲frozen`{Time,Revision}`，不讓舊time搭配新revision。它是data，不是financial capability。
6. bad replacement日期／欄位或getter失敗在sample前保留舊valid anchor；monotonic invalid／backwards／throw或civil overflow則清anchor、更新generation。clock數值恢復不會自動復活舊anchor，必須新明示可信sync。
7. reentry拒絕，revision最大值不wrap；range／safe-integer overflow不clip成看似有效日期。default monotonic來源僅`floor(performance.now())`，不讀或修改host wall clock。

這個profile不跟隨Windows本機DST／timezone跳轉，不提供DB freshness／身份／billing／durable replay保證，也不自動取消或授權Center lease。正式使用前仍需真native provider與clock-generation fence／初始化recovery設計。

## 既有 inventory 的整合邊界

新增測試有真正串起：**明示native DB timestamp→Get_FieldDate→CTime→raw DATE→既有PlanInitUserInventory→可信CUser native201**。沒有把legacy SN／ItemID／ExpireDate／pre schema混進這條路徑。

- 秒解析度下，同秒＋999ms仍相等；下一秒才滿足native嚴格`now > stored`。missing definition不sample；level已失效仍sample，與既有loader一致。
- **保留負DATE的原始數值比較quirk**：在1899-12-29，later18:00(-1.75)反而小於earlier06:00(-1.25)，既有native raw comparison不會當作dateExpired。本輪不擅自改成chronological predicate。
- DeleteAttempts仍只是觀測投影，不執行SQL；Install不代表SQL grant／commit。formalGS仍legacy account／owned bridge，沒有自動採用此clock或兩種新calendar轉換。
- schema6／logical export v2／四類version1 receipts／正quantity native paid fail-closed與qty0 relay均不改；不重播pre financial effects。

## 參考模型與驗證

第21份我們的獨立手譯C++：**30固定PE anchors、3份LS／GS一致copy routine區段、2773 cases**（2748支援civil與25個明確不支援cases）；以獨立Julian-day公式對照TS cumulative Gregorian math，含century／leap／pre-epoch／上下界、WORD／signed-year／fraction、不確定欄位、plain／scalar native201 raw DATE bytes。**1680組clock advances**另比對time／weekday／ms／DATE與range fault。

`Calendar.test.ts`22項＋`CalendarClock.test.ts`15項：**37 pass／0 fail／30541 assertions**。有API failure與-0、result getter單讀、callback latch／reentry、clock invalidation／同值sync、no-host-Date/TZ、real CDBManBase pure methods／SQLite無寫入、庫存實際201 consumer與legacy bytes不變。五種TS red→green regressions／controls在移除negative-fraction／把unwritten-ms改零／移除fault退役／BOOL檢查或SetTime全copy期間reentry guard時先red，恢復後green；不是supplied EXE或原DLL執行證明。

```sh
./node_modules/.bin/bun run vectors:calendar # 只編譯/執行我們的C++
./node_modules/.bin/bun test tests/Calendar.test.ts tests/CalendarClock.test.ts
./node_modules/.bin/bun run verify
```

仍待完整native SQL／provider與NULL/status證據、Windows版本／timezone／DST／invalid calendar profiles、pre→owned初始化與durable effects/recovery、flush／collector／原client驗證。最新整套數字見 [Coverage](Coverage.md)，原生庫存邊界見 [UserInventory](UserInventory.md)。
