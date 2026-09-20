# FXGS 地圖與選圖流程相容性核對

日期：2026-09-20

## 範圍與證據

本輪核對 `CGameMapTmpl`、`CGameMapTmplList`，以及房間選圖、入座隊色、
開局選圖參數與隊色重整。依據是隨附的 `FXGS/FxServer.exe.c`、`.lst`，
以及實際 `FxServer.idx/.idd`。不是只依照 TS 既有註解推斷。

本輪沒有執行 Windows 官方 EXE 做雙端流量差分；下列結論來自靜態組語核對、
原始資料檔核對、單元測試與 TS 伺服器的雙客戶端端對端測試。
**這不是整套伺服器已完全等價的認證。**

## 已修正的差異

| 部分 | 官方證據 | 原 TS 差異與本輪修正 |
| --- | --- | --- |
| 地圖選擇的符號 | `OnSelectMap`，`0041C497: movsx edi, ax` | `Decode2() \| 0` 不會轉為有號 16 位元。改成 signed i16，保留 `-1` 隨機與 `-2-themeIdx` 主題選圖。 |
| 主題索引 | `0041C4F7..0041C501`；`GetThemeMaxMaxPlayer` `0041AC72` | `321 - mapIdx` 是整個 C++ 物件的 DWORD 索引，不是 TS 主題陣列索引。主題陣列始於 DWORD 323，所以零基索引是 `-2-mapIdx`。入座、選圖及開局共用轉換。 |
| 隨機選圖的等級輸入 | `OnRequestStartGame`，`.c:37595..37600` | 官方取 `user+1984` 的等級，TS 原先傳 `dyn.exp`。改傳 `m_nLevel`，避免低等級但累積經驗較高的玩家選到不符等級的地圖。 |
| Premium ticket 輸入 | 同上，`user+2004 == 1` | 傳給選圖方法的是等於 1 的 BOOL，不是原始非零 byte。已正規化。 |
| 隊色及角色 bitfield | `AddUser` `.c:30551..30556`；`OnSelectMap` `.c:33300..33438`；`OnRequestStartGame` `.c:37613..37620` | 原式把 mask 放到整個 XOR 結果上，清掉高位元。改為保留高位元；隊色寫入共用 `SetColorBits`，入座角色使用 `SetBomber`。直接狀態更新不觸發 strategy 的 `OnSelectColor`。 |
| 入座衝突 | `CBaseSession::AddUser` `.c:30544..30550`；`CListSession::AddUser` `.c:40395..40399` | 官方記錄「not return」後仍繼續，TS 卻 return。已保留官方的覆寫及計數流程。 |
| 選圖封包 flush | `OnSelectMap` `0041C4CC` 至 `0041C775` | 官方先排入 112 與各 107，最後一次 flush。移除 TS 在 112 後額外的提前 flush。 |
| 舊版地圖讀取 | `LoadMap` `0040C27F..0040C2BF` | 舊格式第一個 DWORD 也充當物件 `+40`；接著必須讀 `+44` 才到 `+48` 玩家數。原 TS 少跳一個 DWORD，整串欄位錯位。改用順序讀取，並保留 signed int 語意。 |
| 任務地圖判定 | `LoadMap` `.c:13746..13748`；`IsMissionMap` `0040C4E6` | 官方回傳物件 `+104` 的 `missionType > 0`，不是 `+108` 的 missionType 本身。現在獨立保存 0/1 判定。 |
| 地圖表重建 | `Dispose` `0040CA4C`；`CreateTmplList` `0040D394` | 原 TS 清空陣列卻沒有歸零 `m_nMapCount`。現在同步重置地圖及主題索引。 |
| 同名地圖群組 | `LoadMapGroupInfo` `0040D0DA`，`insert_equal` | 官方是 multimap，同名群組累加而非覆蓋；空群組不產生項目。保留其大小寫及重複項目語意。`Dispose` 不清空這個 multimap。 |
| 群組名稱長度 | `LoadMapGroupInfo`，兩處 `>= 0x80` 與 `CAppException` | 原 TS 靜默中止／可能錯位續讀，現在依官方拒絕過長名稱。額外對截斷資料做明確錯誤處理，不讓部分預設地圖進入可選清單。 |

## 重構與保留的特殊行為

- 地圖相關實作移至 `src/FXGS/GameMap.ts`，`GameData.ts` 保留 re-export。
- `LoadMap` 回歸 `CGameMapTmpl`；群組 multimap 由 `CGameMapTmplList` 持有。
- `+60/+64/+84` 根據官方 getter 分別命名為 ghost start、ghost frequency、
  sync game object count，同步更新使用端。其他未核實用途的欄位不猜測命名。
- 2／3／4 隊的重複程式整理成同一個隊色映射流程，維持「先保留既有主色，
  再按原隊色順序分配」；超出隊色數時仍按實際佔位順序 round robin。
- 5／6／7 隊等未處理的 switch 分支仍保留官方 `0x11111111` marker 的結果
  （低五位 `0x11`），不自行改成合理化的隊色。
- 練習模式仍經虛擬 `IsPlayerSet` 與 `MakeSetSlotStatePacket` 納入 AI，
  不把 AI 假裝成一般玩家；107 的 AI marker 與 level 尾端保留。
- `PraticeMapGroup` 是官方的拼字；群組 key 區分大小寫，map pattern 不區分。
  尾端 `?` 是 prefix match，並非「恰好一個字元」。
- 隨機選圖篩選保留原本的特殊規則：guild 排除 mission；premium ticket 跳過
  level／premium-only／practice，但不跳過玩家數、主題與 max-team 比較。
  呼叫端傳入 authority 值作 max-team 比較的既有行為也沒有擅自改成實際隊數。

截斷 `.idd` 的越界讀取在原生版不具可可靠重現的安全語意；TS 在載入時拋出
清楚錯誤是刻意的安全處理，不宣稱要複製官方的 access violation。

## 測試

新增 `test/gamemap.test.ts` 的 **41 個測試**，包括：

- 原始套件：226 張地圖、13 個主題、Bula 任務資料、群組與重建一致性。
- 新／舊格式、signed 欄位、opaque DWORD、全檔 CRC、各截斷位置與名稱上限。
- 同名群組、主題最大隊數、`Map/_` 排除與索引歸零。
- 隨機地圖候選篩選、premium channel／ticket、guild／mission／practice 邊界。
- 16-bit 負數 wire 值、主題到開局 map index、隊色及 bitfield、一次 flush。
- 開局等級與 ticket 正規化、AI 封包尾端、入座的覆寫與高位元保存。

另擴充 `test/e2e.test.ts` 的 packet 97 測試，讓房主與成員經真實 socket 分別
驗證 `0xffff`、`0xfffe`、`0` 三種選圖後的 112 與全部 107。

地圖輪次當時的驗證結果（後續 RNG 輪次另見連結紀錄）：

- Bun runtime：`1.4.3-canary.1 (26e7a4b36)`（npm 安裝標籤 `1.4.2-canary.20260919.1`）。
- `bun test`：**142 pass / 0 fail，1273 assertions，8 files**。
- 專案鎖定 TypeScript `7.0.2`：`tsc --noEmit` 通過。
- TypeScript `7.1.0-dev.20260920.1`：專案及新增測試的嚴格型別檢查通過。
- 預覽工具鏈安裝於獨立的工作區工具目錄（不在 Git repository 內），未修改專案 lockfile 或 dependency 版本。

## 尚未核實／不能宣稱等價的部分

1. **隨機數後續核對已完成本輪範圍，但併發等價性仍有限制。**
   [RNG 核對紀錄](rng-compatibility-audit.md) 已從 EXE 本體確認
   `rand/srand`、`CThread::ProcEntry` seed 與 TLS 狀態，並修正選圖 modulo、
   shuffle、角色隨機、gameVersion 與 premium lucci 的消耗順序。
   `.lst` 的 folded 標記不代表 EXE 指令不存在。現在不再用 `Math.random()`
   縮放選圖；同 seed／序列化呼叫可核對，但 Bun 單一邏輯 request worker
   尚未重現 Windows 多 worker IOCP 排程。詳見該紀錄的明確界線。
2. **非 ASCII 名稱的 MBCS case folding 尚未做等價性驗證。** 本輪維持原始
   位元組（不再用 UTF-8 誤解 map-group 名稱），已驗證隨附 ASCII 地圖資料。
   Windows `_mbsicmp/_mbsnbicmp` 在不同 locale 下的完整語意仍須另行確認。
3. LS／Center／Shop／Util／Relay／SQLite stored-procedure 替代層本輪僅重跑既有
   回歸測試，沒有逐方法重新核對；不能由全套測試通過推論其餘部分全部等價。
