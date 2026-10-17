import { CSafeObject } from "./CSafeObject.ts";
import type { _USERINFO, _USERINVENTORY, _USERDYNINFO } from "./DB/Rows.ts";
import { CDynInfoCalculator } from "./CDynInfoCalculator.ts";
import type { CSendPacketBase } from "./CSendPacketBase.ts";
import type { CClientSocket } from "./CClientSocket.ts";
import {
  SessionLimit,
  IntegerRange,
  UserDynamicRule,
  UserInventoryFormat,
  UserInventoryRule,
  PreInventoryRule,
} from "./OfficialValues.ts";
import { InventoryDateBridge } from "./RuntimePolicy.ts";
import { CProtocolError } from "./CProtocolError.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";
import {
  CopyUserInventory,
  CaptureUserInventory,
  FindUserInventory,
  FindUserInventoryFromAll,
  FindInventoryLoaded,
  FindSlotDecorationLoaded,
  FindCharDecoLoaded,
  HasFunctionalItem,
  PutUserInventoryList,
  PutInventoryList,
  UserInventoryKey,
  type UserInventory,
  type UserInventoryEquipment,
  type UserInventoryPresentation,
} from "./UserInventory.ts";
import { g_nLevel2ExpTable } from "./Protocol/OfficialTables.ts";
import {
  CopyPreInventoryRows,
  CapturePreInventory,
  PutPreInventoryList,
  type PreInventory,
} from "./PreInventory.ts";
import type { UserItemSnapshot } from "./UserItem.ts";

/** Modern detached audit snapshot, NOT the native object or a client format. */
export interface UserDynamicSnapshot {
  readonly Dynamic: Readonly<_USERDYNINFO>;
  readonly Level: number;
  readonly FakeLevel: number;
  readonly LevelIconEnabled: number;
  readonly LevelIconSN: number;
  readonly DynamicModified: number;
  readonly SimpleInfoModified: number;
  readonly GamesSinceFlush: number;
}

/** Fields retain original roles rather than carrying a new JSON client protocol. */
export class CUser extends CSafeObject {
  m_pClientSocket: CClientSocket | undefined;
  m_nSessionIdx: number = SessionLimit.NoSession;
  m_nSessionSerialNo = 0xffffffff;
  m_nSlotIdx = -1;
  private m_vInventory: _USERINVENTORY[] = [];
  private readonly m_setModifiedInventory = new Set<_USERINVENTORY>();
  private m_vUserInventory: readonly Readonly<UserInventory>[] | undefined;
  private m_nUserInventoryRevision = 0;
  private m_bInstallingUserInventory = false;
  private m_userInventoryText: CTextCodec = DefaultTextCodec;
  /** Explicit legacy SQLite bridge. NEVER infer native catalog/stock/date from
   * an ItemID that happens to match. A real legacy reload abandons native mode. */
  get m_aInventory(): _USERINVENTORY[] {
    return this.m_vInventory;
  }
  set m_aInventory(rows: _USERINVENTORY[]) {
    if (this.m_bInstallingUserInventory)
      throw new CProtocolError("Reentrant inventory reload");
    if (this.m_vUserInventory !== undefined) {
      this.NextUserInventoryRevision();
      this.m_vUserInventory = undefined;
      this.m_nFakeLevel = 0;
      this.m_bLevelIcon = 0;
      this.m_nLevelIconSn = 0;
    }
    this.m_vInventory = rows;
    this.m_setModifiedInventory.clear(); // a genuine inventory reload, not a DB ACK
  }
  /** TRUSTED native read-side install only. No client grant/SQL bridge. Every
   * row and equipment value is preflighted before replacing either vector.
   * Nonempty legacy inventory cannot be reinterpreted or silently discarded. */
  InstallUserInventory(
    source: readonly Readonly<UserInventory>[],
    equipment: Readonly<UserInventoryEquipment> = {},
    text: CTextCodec = DefaultTextCodec,
  ): void {
    if (this.m_bInstallingUserInventory)
      throw new CProtocolError("Reentrant inventory reload");
    if (this.m_nUserInventoryRevision >= IntegerRange.UInt32Maximum)
      throw new CProtocolError("Native inventory revision exhausted");
    if (
      this.m_vInventory.length ||
      source.length > UserInventoryRule.LoadCountLimit
    )
      throw new CProtocolError(
        "Cannot mix native/legacy inventory or exceed resident capacity",
      );
    this.m_bInstallingUserInventory = true;
    try {
      const fake = equipment.FakeLevel,
        icon = equipment.LevelIconSN;
      if (fake !== undefined) this.AssertInt32(fake);
      if (icon !== undefined) UserInventoryKey(icon);
      const rows = Object.freeze(
        [...source].map((r) => CopyUserInventory(r, text)),
      );
      if (this.m_vInventory.length)
        throw new CProtocolError(
          "Legacy inventory changed during native preflight",
        );
      this.NextUserInventoryRevision();
      // Public legacy callers may still hold the old empty array. Detach it
      // and seal the native-mode legacy view, so accidental push/splice cannot
      // silently create a mixed layout behind the native vector. The explicit
      // legacy setter remains the only supported mode replacement.
      this.m_vInventory = [];
      Object.freeze(this.m_vInventory);
      this.m_vUserInventory = rows;
      this.m_userInventoryText = text;
      if (fake !== undefined) this.m_nFakeLevel = fake;
      if (icon !== undefined) {
        this.m_bLevelIcon = 1;
        this.m_nLevelIconSn = icon | 0;
      }
      this.m_setModifiedInventory.clear();
    } finally {
      this.m_bInstallingUserInventory = false;
    }
  }
  /** MODERN TRUSTED paired read-side replacement. Preflight BOTH lists and
   * both generation budgets before publishing either. Never applies a pre
   * projection's After/financial effects, runs SQL, or authorizes a grant.
   * No callback occurs between the two vector/revision publications. */
  InstallUserInventoryInitialization(
    ownedSource: readonly Readonly<UserInventory>[],
    preSource: readonly Readonly<PreInventory>[],
    equipment: Readonly<UserInventoryEquipment> = {},
    text: CTextCodec = DefaultTextCodec,
  ): void {
    if (this.m_bInstallingUserInventory || this.m_bInstallingPreInventory)
      throw new CProtocolError("Reentrant inventory initialization install");
    if (
      this.m_nUserInventoryRevision >= IntegerRange.UInt32Maximum ||
      this.m_nPreInventoryRevision >= IntegerRange.UInt32Maximum
    )
      throw new CProtocolError("Inventory initialization revision exhausted");
    this.m_bInstallingUserInventory = true;
    this.m_bInstallingPreInventory = true;
    try {
      if (
        !Array.isArray(ownedSource) ||
        !Array.isArray(preSource) ||
        ownedSource.length > UserInventoryRule.LoadCountLimit ||
        preSource.length > PreInventoryRule.SuccessfulLoadLimit ||
        this.m_vInventory.length
      )
        throw new CProtocolError(
          "Cannot mix native/legacy inventory or exceed resident capacity",
        );
      const ownedInput = [...ownedSource],
        preInput = [...preSource],
        fake = equipment.FakeLevel,
        icon = equipment.LevelIconSN;
      if (fake !== undefined) this.AssertInt32(fake);
      if (icon !== undefined) UserInventoryKey(icon);
      // Capture ALL rows before the FIRST codec callback can mutate sources.
      const capturedOwned = ownedInput.map(CaptureUserInventory),
        capturedPre = preInput.map(CapturePreInventory),
        owned = Object.freeze(
          capturedOwned.map((r) => CopyUserInventory(r, text)),
        ),
        pre = CopyPreInventoryRows(capturedPre, text),
        legacy: _USERINVENTORY[] = [];
      Object.freeze(legacy);
      if (this.m_vInventory.length)
        throw new CProtocolError(
          "Legacy inventory changed during initialization preflight",
        );
      // No fallible port/getter/copy below: one synchronous publication.
      this.m_nUserInventoryRevision++;
      this.m_nPreInventoryRevision++;
      this.m_vUserInventory = owned;
      this.m_aPreInventory = pre;
      this.m_vInventory = legacy;
      this.m_userInventoryText = text;
      if (fake !== undefined) this.m_nFakeLevel = fake;
      if (icon !== undefined) {
        this.m_bLevelIcon = 1;
        this.m_nLevelIconSn = icon | 0;
      }
      this.m_setModifiedInventory.clear();
    } finally {
      this.m_bInstallingUserInventory = false;
      this.m_bInstallingPreInventory = false;
    }
  }
  /** Atomic detached read-side pair only; null Owned means legacy mode. Neither
   * this DTO nor its revisions prove SQL/financial initialization or freshness. */
  CaptureUserInventoryInitialization(): Readonly<{
    OwnedGeneration: Readonly<{ Native: boolean; Revision: number }>;
    Presentation: Readonly<UserInventoryPresentation>;
    Owned: Readonly<{
      Revision: number;
      Rows: readonly Readonly<UserInventory>[];
    }> | null;
    Pre: Readonly<{
      Revision: number;
      Rows: readonly Readonly<PreInventory>[];
    }>;
  }> {
    return Object.freeze({
      OwnedGeneration: Object.freeze({
        Native: this.m_vUserInventory !== undefined,
        Revision: this.m_nUserInventoryRevision,
      }),
      Presentation: Object.freeze({
        FakeLevel: this.m_nFakeLevel,
        LevelIconEnabled: this.m_bLevelIcon,
        LevelIconSN: this.m_nLevelIconSn,
      }),
      Owned:
        this.m_vUserInventory === undefined
          ? null
          : Object.freeze({
              Revision: this.m_nUserInventoryRevision,
              Rows: this.m_vUserInventory,
            }),
      Pre: Object.freeze({
        Revision: this.m_nPreInventoryRevision,
        Rows: this.m_aPreInventory,
      }),
    });
  }
  /**00417B7B: append a detached native row with clean dirty flag; no equipment
   * mutation or SQL grant. Unlike the original, do NOT dirty the caller's row. */
  AddInventory(
    row: Readonly<UserInventory>,
    text: CTextCodec = this.m_userInventoryText,
  ): void {
    this.InstallUserInventory(
      [...(this.m_vUserInventory ?? []), { ...row, Modified: 0 }],
      {},
      text,
    );
  }

  /** Immutable generation for105/201 and modern pending-plan drift fences.
   * Capturing does not grant inventory or claim the SQL source has committed. */
  CaptureUserInventory():
    | Readonly<{ Revision: number; Rows: readonly Readonly<UserInventory>[] }>
    | undefined {
    const rows = this.m_vUserInventory;
    return rows === undefined
      ? undefined
      : Object.freeze({ Revision: this.m_nUserInventoryRevision, Rows: rows });
  }
  GetUserInventoryGeneration(): Readonly<{
    Native: boolean;
    Revision: number;
  }> {
    return Object.freeze({
      Native: this.m_vUserInventory !== undefined,
      Revision: this.m_nUserInventoryRevision,
    });
  }
  private NextUserInventoryRevision(): void {
    if (this.m_nUserInventoryRevision >= IntegerRange.UInt32Maximum)
      throw new CProtocolError("Native inventory revision exhausted");
    this.m_nUserInventoryRevision++;
  }
  /**00416A8E: FIRST resident ItemSn in native mode; explicit legacy SN otherwise.
   * No StockSn/name/Slot/Amount/expiry predicate and no cross-layout fallback. */
  GetUserInventory(
    sn: number,
  ): _USERINVENTORY | Readonly<UserInventory> | undefined {
    return this.m_vUserInventory === undefined
      ? this.m_vInventory.find((row) => row.SN === sn)
      : FindUserInventory(this.m_vUserInventory, sn);
  }
  GetUserInventoryFromAll(
    attribute: string,
  ): Readonly<UserInventory> | undefined {
    return FindUserInventoryFromAll(
      this.m_vUserInventory ?? [],
      attribute,
      this.m_userInventoryText,
    );
  }
  HasFunctionalItem(attribute: string): boolean {
    return HasFunctionalItem(
      this.m_vUserInventory ?? [],
      attribute,
      this.m_userInventoryText,
    );
  }
  GetInventoryLoaded(category: number): Readonly<UserInventory> | undefined {
    return FindInventoryLoaded(this.m_vUserInventory ?? [], category);
  }
  GetSlotDecorationLoaded(
    position: number,
  ): Readonly<UserInventory> | undefined {
    return FindSlotDecorationLoaded(this.m_vUserInventory ?? [], position);
  }
  GetCharDecoLoaded(position: number): Readonly<UserInventory> | undefined {
    return FindCharDecoLoaded(this.m_vUserInventory ?? [], position);
  }
  MakeInventoryPacket(packet: CSendPacketBase, category: number): void {
    PutInventoryList(packet, this.m_vUserInventory ?? [], category);
  }
  /** Modern factoring of case0 Amount/+80 dirty writes, NOT SQL/receipt/ACK.
   * Native read-side mutation is trusted ONLY; the gameplay paid coordinator
   * explicitly refuses native rows until its separate storage CAS is wired. */
  ConsumeUserInventory(sn: number, quantity: number): void {
    if (this.m_bInstallingUserInventory)
      throw new CProtocolError("Reentrant inventory mutation");
    const row = this.GetUserInventory(sn);
    if (
      !row ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > IntegerRange.UInt8Maximum ||
      !Number.isInteger(row.Amount) ||
      row.Amount < quantity ||
      row.Amount > IntegerRange.Int32Maximum
    )
      throw new CProtocolError("Insufficient resident inventory amount");
    if (this.m_vUserInventory !== undefined) {
      const i = this.m_vUserInventory.indexOf(row as UserInventory);
      const changed = Object.freeze({
        ...(row as UserInventory),
        Amount: (row.Amount - quantity) | 0,
        Modified: 1,
      });
      this.NextUserInventoryRevision();
      this.m_vUserInventory = Object.freeze(
        this.m_vUserInventory.map((r, index) => (index === i ? changed : r)),
      );
    } else {
      const legacy = row as _USERINVENTORY;
      legacy.Amount = (legacy.Amount - quantity) | 0;
      this.m_setModifiedInventory.add(legacy);
    }
  }
  IsInventoryModified(sn: number): number {
    const row = this.GetUserInventory(sn);
    if (!row) return 0;
    return this.m_vUserInventory === undefined
      ? this.m_setModifiedInventory.has(row as _USERINVENTORY)
        ? 1
        : 0
      : (row as UserInventory).Modified;
  }
  GetInventoryStateSnapshot():
    | readonly Readonly<_USERINVENTORY & { Modified: number }>[]
    | readonly Readonly<UserInventory>[] {
    return (
      this.m_vUserInventory ??
      Object.freeze(
        this.m_vInventory.map((row) =>
          Object.freeze({
            ...row,
            Modified: this.m_setModifiedInventory.has(row) ? 1 : 0,
          }),
        ),
      )
    );
  }
  private m_aPreInventory: readonly Readonly<PreInventory>[] = Object.freeze(
    [],
  );
  private m_nPreInventoryRevision = 0;
  private m_bInstallingPreInventory = false;
  /** TRUSTED service-local read-side replacement, NOT an award/load procedure
   * or financial ACK. It mutates NO dynamic/owned inventory/legacy SQL field. */
  InstallPreInventory(
    source: readonly Readonly<PreInventory>[],
    text: CTextCodec = DefaultTextCodec,
  ): void {
    if (this.m_bInstallingPreInventory)
      throw new CProtocolError("Reentrant pre-inventory install");
    if (this.m_nPreInventoryRevision >= IntegerRange.UInt32Maximum)
      throw new CProtocolError("Pre-inventory revision exhausted");
    this.m_bInstallingPreInventory = true;
    try {
      const rows = CopyPreInventoryRows(source, text);
      this.m_nPreInventoryRevision++;
      this.m_aPreInventory = rows;
    } finally {
      this.m_bInstallingPreInventory = false;
    }
  }
  GetPreInventoryCount(): number {
    return this.m_aPreInventory.length;
  }
  CapturePreInventory(): Readonly<{
    Revision: number;
    Rows: readonly Readonly<PreInventory>[];
  }> {
    return Object.freeze({
      Revision: this.m_nPreInventoryRevision,
      Rows: this.m_aPreInventory,
    });
  }
  GetPreInventoryGeneration(): number {
    return this.m_nPreInventoryRevision;
  }
  /**00416CA9: caller supplies an explicit immutable native catalog generation.
   * Capture the level/vector ONCE before user-supplied codecs can reload them.
   * The GS read-side handoff supplies ALL locals; this body grants NO items
   * and does NOT execute native SQL/premium/financial initialization. */
  MakePreInventoryPacket(
    packet: CSendPacketBase,
    catalog: UserItemSnapshot,
  ): void {
    const rows = this.m_aPreInventory,
      level = this.GetLevel();
    PutPreInventoryList(packet, rows, catalog, level);
  }
  m_bClientInitialized = true;
  // Native +1976..+2000. These are logical fields, NOT native locks/DB queues.
  private m_bDynamicModified = 0;
  private m_bSimpleInfoModified = 0;
  private m_nLevel = 0;
  private m_nFakeLevel = 0;
  private m_bLevelIcon = 0;
  private m_nLevelIconSn = 0;
  private m_nGamesSinceFlush = 0;
  // Center CUser ctor @ 00415640 initializes authcode to zero. This is NOT
  // SID, GuildSn, a transfer token, or the premium-ticket date.
  m_nAuthencode = 0;
  /** FXGS 00408148 / 00408E22 store/read a BYTE at +2004. */
  SetAuthenCode(value: number): void {
    this.m_nAuthencode = value & 0xff;
  }
  GetAuthencode(): number {
    return this.m_nAuthencode & 0xff;
  }
  constructor(
    public m_userInfo: _USERINFO,
    readonly m_nGlobalSerialNo: number,
  ) {
    super();
    // The port receives an already-loaded _USERINFO. Native initialization
    // loads it after construction and SetLevel's the initially-zero cache.
    this.SetLevel();
  }
  GetName(): string {
    return this.m_userInfo.ID;
  }
  /** FXGS 0041697B: identity search in the owning socket's 1..2 user array. */
  GetSelfidx(): number {
    return this.m_pClientSocket?.m_aUser.indexOf(this) ?? -1;
  }
  GetGlobalSerialNo(): number {
    return this.m_nGlobalSerialNo;
  }
  GetSessionIdx(): number {
    return this.m_nSessionIdx;
  }
  GetSessionSerialNo(): number {
    return this.m_nSessionSerialNo;
  }
  /** FXGS 00403142 reads signed int16 at CUser+176 (= _USERACCOUNT+152).
   * CDBMan::GetUserInfo 0040A7E0 binds this from @CommunitySvr, not @SN.
   * SetPlayer 105 emits its low byte; AppendSimpleInfo emits Gender separately. */
  GetCommunitySvr(): number {
    return (this.m_userInfo.CommunitySvr << 16) >> 16;
  }
  /** 0040312D / 00416874: cached level, NOT an implicit DB/Exp refresh. */
  GetLevel(): number {
    return this.m_nLevel;
  }
  SetLevel(): void {
    this.m_nLevel = CDynInfoCalculator.GetLevel(this.m_userInfo.Exp);
  }
  GetExp(): number {
    return this.m_userInfo.Exp;
  }
  /**0041688A is xor eax,eax; ret4 in THIS build. Do not reinterpret the
   * SQLite Authority value as recovered permission bits/role exemptions. */
  HasAuthority(_authority: number): number {
    return 0;
  }
  GetFakeLevel(): number {
    return this.m_nFakeLevel;
  }
  SetFakeLevel(value: number): void {
    this.AssertInt32(value);
    this.m_nFakeLevel = value;
  }
  /** 00416E47: ADD is signed32 before the 1..table-size clamp. */
  GetLookLevel(): number {
    const level = (this.m_nLevel + this.m_nFakeLevel) | 0;
    return Math.min(g_nLevel2ExpTable.length, Math.max(1, level));
  }
  /** 00408DFE / 0040313B. Icon enable is independent of the fake-level offset. */
  SetLevelIcon(enabled: number, sn: number): void {
    this.AssertInt32(enabled);
    this.AssertInt32(sn);
    this.m_bLevelIcon = enabled;
    this.m_nLevelIconSn = sn;
  }
  GetLevelIconSn(): number {
    return this.m_nLevelIconSn;
  }
  SetSimpleInfoModified(value: number): void {
    this.AssertInt32(value);
    this.m_bSimpleInfoModified = value;
  }
  /** 00416A1D: signed ADD wraps, then negative result is clamped to zero.
   * Return -1/0/+1 is the LEVEL direction, NOT the amount of experience applied.
   * Dirty flags model native intent only; this does not enqueue or write SQL.
   */
  IncDecExp(value: number): number {
    this.AssertInt32(value);
    this.AssertInt32(this.m_userInfo.Exp);
    this.m_userInfo.Exp = Math.max(0, (this.m_userInfo.Exp + value) | 0);
    this.m_bDynamicModified = 1;
    const level = CDynInfoCalculator.GetLevel(this.m_userInfo.Exp);
    if (level === this.m_nLevel) return 0;
    const direction = level > this.m_nLevel ? 1 : -1;
    this.m_nLevel = level;
    this.m_bSimpleInfoModified = 1;
    return direction;
  }
  /** 004090EC: native signed32 addition BEFORE the [0,1,000,000] clamp.
   * Even zero/saturated changes dirty dynamic info. No cached level/simple-info
   * mutation, inventory award, SQL write, or network success is implied. */
  IncDecMoney(value: number): void {
    this.AssertInt32(value);
    this.AssertInt32(this.m_userInfo.Money);
    this.m_userInfo.Money = Math.min(
      UserDynamicRule.MaximumMoney,
      Math.max(0, (this.m_userInfo.Money + value) | 0),
    );
    this.m_bDynamicModified = 1;
  }
  /** 0041D1C1..0041D219: fixed-width increments, not automatic SQL writes. */
  IncWin(): void {
    this.IncrementResult("Win");
  }
  IncDraw(): void {
    this.IncrementResult("Draw");
  }
  IncLose(): void {
    this.IncrementResult("Lose");
  }
  /** 0041D245 / DeferFlushModifiedInfo 00417603: this is a flush cadence
   * counter, reset by the native flush driver, NOT lifetime total games. */
  IncGame(): void {
    this.m_nGamesSinceFlush = (this.m_nGamesSinceFlush + 1) >>> 0;
  }

  /** Modern isolated calculation copy. No socket, registration, inventory or
   * free-state ownership is copied. Native cached/dirty fields ARE preserved. */
  CloneForResultCalculation(): CUser {
    const copy = new CUser({ ...this.m_userInfo }, this.m_nGlobalSerialNo);
    copy.m_nAuthencode = this.m_nAuthencode;
    copy.m_bDynamicModified = this.m_bDynamicModified;
    copy.m_bSimpleInfoModified = this.m_bSimpleInfoModified;
    copy.m_nLevel = this.m_nLevel;
    copy.m_nFakeLevel = this.m_nFakeLevel;
    copy.m_bLevelIcon = this.m_bLevelIcon;
    copy.m_nLevelIconSn = this.m_nLevelIconSn;
    copy.m_nGamesSinceFlush = this.m_nGamesSinceFlush;
    return copy;
  }
  GetDynamicInfoSnapshot(): UserDynamicSnapshot {
    const { ID, Money, Exp, Win, Draw, Lose } = this.m_userInfo;
    return Object.freeze({
      Dynamic: Object.freeze({ ID, Money, Exp, Win, Draw, Lose }),
      Level: this.m_nLevel,
      FakeLevel: this.m_nFakeLevel,
      LevelIconEnabled: this.m_bLevelIcon,
      LevelIconSN: this.m_nLevelIconSn,
      DynamicModified: this.m_bDynamicModified,
      SimpleInfoModified: this.m_bSimpleInfoModified,
      GamesSinceFlush: this.m_nGamesSinceFlush,
    });
  }
  private IncrementResult(field: "Win" | "Draw" | "Lose"): void {
    this.AssertInt32(this.m_userInfo[field]);
    this.m_userInfo[field] = (this.m_userInfo[field] + 1) | 0;
    this.m_bDynamicModified = 1;
  }
  private AssertInt32(value: number): void {
    if (
      !Number.isInteger(value) ||
      value < IntegerRange.Int32Minimum ||
      value > IntegerRange.Int32Maximum
    )
      throw new CProtocolError("User value is not a signed DWORD");
  }
  /** FXGS 00416FF5. Guild extra word is zero outside guild channels. */
  AppendSimpleInfoPacket(packet: CSendPacketBase): void {
    packet
      .EncodeStr(this.GetName())
      .Encode1(this.m_userInfo.Gender)
      .Encode2(this.GetLookLevel())
      .Encode4(this.m_bLevelIcon ? this.GetLevelIconSn() : 0)
      .Encode4(this.m_userInfo.GuildSn)
      .Encode2(0);
  }
  /** FXGS 00416C0C: count, each SN/Slot/AMOUNT/description/raw VariantTime. */
  MakeUserInventoryPacket(packet: CSendPacketBase): void {
    const native = this.m_vUserInventory;
    if (native !== undefined) {
      PutUserInventoryList(packet, native);
      return;
    }
    packet.Encode4(this.m_aInventory.length);
    for (const item of this.m_aInventory) {
      const time = Buffer.alloc(UserInventoryFormat.VariantTimeBytes);
      // OLE DATE epoch 1899-12-30; zero-expiry is encoded as DATE 0, not Unix epoch.
      // Modern SQLite Unix-second/zero bridge. Native CTime uses DB civil
      // SYSTEMTIME; native DateCreated/timezone/StockSn catalog parity is NOT implied.
      time.writeDoubleLE(
        item.ExpireDate
          ? item.ExpireDate / InventoryDateBridge.SecondsPerDay +
              InventoryDateBridge.UnixEpochVariantDays
          : InventoryDateBridge.NoExpiryVariantTime,
      );
      packet
        .Encode4(item.SN)
        .Encode1(item.Slot)
        .Encode4(item.Amount)
        .EncodeStr(item.Verbose)
        .EncodeBuffer(time);
    }
  }
}
