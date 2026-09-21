# 商城道具裝備後重新登入黑屏修復

日期：2026-09-21。範圍是商城購入／裝備後，重新登入 GS、進入大廳時的 70／202／201 尾段，以及同格式的 Shop 201。

## 根因

`CUser::MakeUserInventoryPacket` 的**每位玩家庫存筆數是 E4，不是 E2／E1**。

原本 GS 寫成：

```text
201 [E1 userCount] [E2 inventoryCount] [rows...]
```

原版與修正後是：

```text
201 [E1 userCount]
    userCount × (
      [E4 inventoryCount]
      inventoryCount × [E4 ItemSN][E1 Slot][E4 Amount][EStr Verbose][8B OLE DATE]
    )
```

使用者提供的四件庫存封包以錯誤格式送出時長度為 80 bytes：

```text
93 5b a5 6d 96 ca ...
      ^^^^^ E2(4)
```

Client 依原版格式讀 E4，會把 `a5 6d 96 ca` 解成 `0x33A7C55F`（866,633,055 筆），同時把第一筆 ItemSN 的前兩個 bytes 吃進 count，之後全部欄位錯位。空庫存時，越界的 E4 讀取可能回 0，所以先前空帳號流程看似正常；一旦真正持有道具便在 201 後卡住。

修正後同一組四件道具的 body 長度是 82 bytes，開頭為：

```text
93 5b 96 ca 53 91 96 ca 53 03 22 96 ca 53 94 a5 69 ...
      ^^^^^^^^^^^ E4(4)  ^^^^^^^^^^^ ItemSN 150
```

## 原版證據

### FXGS

`FXGS/FxServer.exe.lst` 的 `CUser::MakeUserInventoryPacket`：

- `00416C27–00416C38`：以 `0x54`（84-byte `UserInventory`）除 vector byte length，EAX 得到元素數。
- `00416C40`：`push eax`。
- `00416C41`：呼叫 send-packet vtable `+0x1C`。
- `004921B4`：該 vtable entry 明確是 `CSendPacketBase::Encode4`。
- 每列的 ItemSN／Amount 同樣呼叫 `+0x1C`；Slot 呼叫 `+0x14`（Encode1），Verbose 呼叫 `+0x20`（EncodeStr），日期經 `+0x28`（EncodeBuffer）寫 8 bytes。

`FXGS/FxServer.map` 是 2004-08-06 build；其中同名函數位於 `004159C8`，`user.cpp` line table 的 count、row 欄位及 loop 相對位置與上述函數一致。這也排除了只依 2005 EXE 猜測欄位順序的做法。

### FXSS

`FXSS/FxShop.exe.c:27145` 的同名函數也對 vector size 與每列 SN／ItemSN 呼叫 vtable `+28`，即 Encode4。雖然原版 Shop 通常不填該 in-memory vector，相關共用格式仍一併修正，避免留下第二個錯誤 writer。

## 最後三包逐包核對

### 70（26 bytes）

提供內容可完整解到封包終點：page 0、1 位玩家、7-byte 名稱、gender 0、look level 1、level icon 0、guild 0、mark revision 0。欄位及長度正常，未修改。

### 202（49,005-byte payload）

- type 202。
- E2 count = `0x044F` = 1,103 筆 FxItem。
- 產生內容與所選 FILE 1 `DB/CAItem.bak` 的 1,103 筆原價 catalog byte-for-byte 起始一致。
- 現有 catalog 測試逐欄讀到封包終點；payload 49,005，加 degree-2 framing 後 49,009，低於 16-bit frame 上限，也低於原版／TS client-socket 96 KiB send queue。
- 原版 `PutUserItemList` 與 2004 map line table 都使用 E2 table count，再依序寫 E4 SN、E1 category、兩個字串及三個 E4 attribute。

因此不拆 202、不刪 catalog、不改價格，也不以 client cache 避開它。

### 201

外層 E1 user count、每列 ItemSN／Slot／Amount／Verbose／8-byte date 都與原版一致；唯一造成解析崩壞的是 per-user count 少了 2 bytes。四個 Slot `0x78/0xE1/0x79/0xF0` 是 Shop 210 持久化後的 BYTE，並非 cipher 或日期錯位。

## 實作與回歸

- GS 與 Shop 的 `MakeUserInventoryPacket` 統一改成 E4 item count。
- packet ID 註解改成正式結構，避免再把外層 E1 user count 與內層 E4 item count 混淆。
- 加入使用者回報的四件 ItemSN／Slot fixture，檢查 corrected prefix、82-byte 長度及四列完整終點。
- Shop writer 加入獨立 E4 count 測試。
- 真實 TCP E2E 現在走 LS → GS → Shop，購買原版商品，送 Shop 210 將 category-12 道具裝到 `0xF0`，回 GS，再完整登出／重新登入；兩次 201 都以 E4 count 解碼並保留裝備 Slot。

Targeted 驗證：

- `bun test test/user-inventory.test.ts test/shop.test.ts`：44 pass、0 fail、383 assertions。
- `bun test test/e2e.test.ts`：57 pass、0 fail、874 assertions。
- `bun run check`：toolchain guard、strict TypeScript 及全套測試皆通過；609 pass、0 fail、26,137 assertions、26 files。

沒有清空道具、縮減 catalog、取消裝備、改價或關閉 inventory loader；Practice、購買持久化與未知帳號自動註冊路徑未變。
