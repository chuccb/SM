# Packet 121 房主倒數時間相容修復

日期：2026-09-21。範圍是 `CBanChief`、`CGameSession::DeferBanChief`、packet 121 的四個 stage，以及一般房主／`Item/SuperChief`／odd-slot／踢出後 room gate 狀態。

## 回報封包與直接根因

使用者提供的 degree-2 payload：

```text
23 5a 61 dd
```

依原版 cipher 解碼為：

```text
packet ID = 0x23 ^ 0x5A       = 121
stage     = 0x5A ^ 0x5A       = 0
seconds   = 0x61DD ^ 0xA569   = 0xC4B4 = 50356
```

packet 121 格式確實是：

```text
[E1 stage][E2 warningSeconds]
```

問題不在 Client 顯示，也不應把輸出單點硬改成常數 10。原版 `CGameSession::DeferBanChief` 在 `0041C1AC–0041C1C2` 將房主是否持有 `Item/SuperChief` 轉成 EDI：

- 一般房主：`1`
- SuperChief：`3`

此值是**倒數倍率**。原版後續每一次 `GetWarningDelay`／`GetOddSlotInManner` 都 `push edi`；`timeGetTime()` 則另存在 stack local。

原 TS 把 `now = timeGetTime()` 錯傳給所有 delay helper：

```text
GetWarningDelay(now) = (now × 10000) mod 2^32
```

結果再除以 1000、寫入 E2，便成為隨 server uptime 變動且可能二次截斷的巨大秒數；本次正好編成 `61 dd`，Client 解出 50356 秒。

修正後一般 stage 0 的完整 payload 是：

```text
23 5a a5 63
```

其中 `0xA563 ^ 0xA569 = 10`。SuperChief 則是 `0xA577 ^ 0xA569 = 30`。

## 原版完整時序

`CBanChief` 原版方法位於 `FxServer.exe.lst:00401010–00401115`：

- `GetWarningDelay(multiplier) = 10000 × multiplier` ms。
- `GetOddSlotInManner(multiplier) = 5000 × multiplier` ms。
- `IsBanChief(roomFull, unusedGameType, multiplier)`：
  - 滿房：`10000 × multiplier` ms。
  - 未滿房：`20000 × multiplier` ms。
- 所有到期判定都是嚴格的 `elapsed > delay`，不是 `>=`。
- timestamp 與減法均為 DWORD unsigned domain，跨 49.7 日 wrap 仍有效。

packet 121 的四個 stage：

| 流程 | 前置等待 | warning packet | warning 到期 | 對象 |
|---|---:|---|---|---|
| 一般、滿房 | 10 秒；SuperChief 30 秒 | stage 0，E2 10／30 | stage 2，E2 10／30 | 0 broadcast；2 僅房主 |
| 一般、未滿房 | 20 秒；SuperChief 60 秒 | stage 0，E2 10／30 | stage 2，E2 10／30 | 0 broadcast；2 僅房主 |
| odd-slot | 5 秒；SuperChief 15 秒 | stage 1，E2 10／30 | stage 3，E2 10／30 | 1 broadcast；3 僅房主 |

E2 一律是後續 warning 的 10／30 秒，不是一般 gate 的 20／60 秒，也不是 odd-slot grace 的 5／15 秒。

一般 degree-2 payload 因此固定為：

```text
stage 0: 23 5a a5 63
stage 1: 23 5b a5 63
stage 2: 23 58 a5 63
stage 3: 23 59 a5 63
```

SuperChief 只把尾端 `a5 63` 改成 `a5 77`（30 秒）。

## 同一路徑一併修正的原版差異

### 1. 滿房判定

`0041C36C–0041C386` 對 byte `+833`（最大人數）與 byte `+832`（目前人數）做 subtraction／`neg; sbb; inc`，等價於：

```text
m_nMaxPlayerNum === m_nCurPlayerNum
```

原 TS 卻判斷差值 `< 0`，正常滿房時仍走未滿房的 20 秒 gate。現在改回 byte 欄位的 equality 語意。

### 2. odd-slot 踢出後的 reset

stage 3 發送並踢出房主後，原版在 `0041C351` 呼叫 `SetOddSlot(0)`；只有一般 stage 2 路徑才在 `0041C46C` 呼叫 `SetCanStart(0)`。原 TS 把 stage 3 也寫成 `SetCanStart(0)`，現在已分開。

### 3. socket stage

原版兩個踢出分支在 `DestroyPlayer` 將 socket 回到 stage 1 後，分別於 `0041C347`／`0041C462` 明確寫入 `socket+468 = 4`。TS 現在也依相同順序把房主停在 exchange／playing stage 4，不再只依註解假設 table method 會完成它。

### 4. DWORD elapsed

odd-slot grace、兩種 warning expiry 與 `IsBanChief` 均改成 `(now - then) >>> 0`。這與原版 unsigned `sub` 後 `cmp/jbe` 一致，也排除 signed i32 在高位設為 1 時把已到期時間看成負數。

### 5. `CBanChief::Init` lifecycle

原版在四個位置對同一塊 `CGameSession+12576` storage 呼叫 `CBanChief::Init`：

- `CGameSession::Init`（`FxServer.exe.c:31766`）
- 房主離開的 `CGameSession::DestroyPlayer`（`:32737`）
- `CGameSession::DoStartGame`（`:32923`）
- playing branch 的 `DeferBanChief`（`:33078`）

TS 原本漏掉 room Init，另兩處以 `new CBanChief()` 取代原版的 in-place `Init()`；這不會寫入原版要求的目前 `m_dwCanStartTime`，也會讓 `DeferBanChief` 已保存的物件 reference 指向被替換掉的舊狀態。現在四個 lifecycle 點都在同一物件上執行 `Init()`。

## 實作與回歸

- delay helper 參數改名為 `timerMultiplier`，註解明確區分 multiplier 與 timestamp。
- 10／20／5 秒 native delay 使用具名常數；乘法以 `Math.imul(... ) >>> 0` 保留 DWORD low-32-bit 語意。
- `DeferBanChief` 只從同一 multiplier 推導 comparison delay 與 E2 warningSeconds，避免封包值與實際 kick gate 再次分離。
- packet ID 註解補上 stage 0/1 warning、2/3 removal 與 10/30 秒語意。
- `test/ban-chief.test.ts` 直接保存使用者提供的 `23 5a 61 dd` regression，並檢查修正後 raw payload。
- 測試涵蓋一般／SuperChief、滿房／未滿房、stage 0/1/2/3、strict boundary、5/10/15/20/30/60 秒時序、DWORD wrap、broadcast／chief-only、DestroyPlayer、socket stage 4、odd-slot reset 與 in-place Init。

驗證結果：

- `bun test test/practice-start.test.ts test/ban-chief.test.ts`：24 pass、0 fail、217 assertions。
- strict TypeScript：通過。
- `bun run check`：toolchain guard、TypeScript 及全套測試全部通過；**618 pass、0 fail、26,205 assertions、27 files**。

Practice 的 `DeferBanChief` 仍是原版 empty override。商城、inventory、購買／穿戴、重新登入與未知帳號自動註冊路徑均未修改。
