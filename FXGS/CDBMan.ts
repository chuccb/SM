import { createHash } from "node:crypto";
import { CDBManBase } from "../Common/DB/CDBManBase.ts";
import type {
  UserDynamicChange,
  _USERDYNINFO,
  _USERINVENTORY,
} from "../Common/DB/Rows.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { NormalizeID } from "../Common/CIDCompare.ts";
import { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CDynInfoCalculator } from "../Common/CDynInfoCalculator.ts";
import {
  CipherDegree,
  SessionLimit,
  ScalarCipher,
  GameResultCategory,
  GameResultFormat,
  DynInfoRule,
  GameResultRule,
  GameContextLimit,
  ItemAttrFormat,
  IntegerRange,
  MoneyPickupRule,
  UserDynamicRule,
  SpecialItemRule,
  GamePlayerState,
} from "../Common/OfficialValues.ts";
import {
  PlanTakeHouse,
  MakeTakeHousePacket,
  type HouseClaimPlan,
} from "./HouseClaim.ts";
import {
  IsSpecialItemType,
  NormalizeSpecialItemRequest,
  MakeSpecialItemPacket,
  CopySpecialItemInventory,
  type SpecialItemRequest,
} from "./SpecialItemUse.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import { g_nLevel2ExpTable } from "../Common/Protocol/OfficialTables.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";

import type { CDBClock } from "../Common/DB/CDBClock.ts";
import type { CUserItemMan } from "./CUserItemMan.ts";
import {
  PlanUserInventoryInitialization,
  type InventoryInitializationObservation,
  type InventoryInitializationPlan,
} from "./InventoryInitialization.ts";

/** Modern durable submission, NEVER a client request or native struct layout. */
export interface GameResultChange extends UserDynamicChange {
  readonly Slot: number;
  readonly GlobalSerialNo: number;
  readonly Category: number;
  readonly ExperienceDelta: number;
}
export interface GameResultSubmission {
  readonly RoundID: string;
  readonly ChannelIndex: number;
  readonly SessionIndex: number;
  readonly SessionSerialNo: number;
  readonly StartTick: number;
  readonly ElapsedMilliseconds: number;
  readonly WinningColor: number;
  readonly Reason: "claims" | "timeout";
  readonly InvalidGame: boolean;
  readonly CountedSlots: readonly number[];
  readonly Changes: readonly GameResultChange[];
  /** CSendPacket CRC8 scalar bytes; not TCP framing or client-authenticated data. */
  readonly Packet: Uint8Array;
}
export interface GameResultReceipt {
  readonly RoundID: string;
  readonly Digest: string;
  readonly CommittedAt: number;
  /** Immutable text and detached bytes, not live CUser/CSendPacket objects. */
  readonly Payload: string;
  readonly Packet: Buffer;
}
interface ReceiptRow {
  RoundID: string;
  Digest: string;
  CommittedAt: number;
  Payload: string;
  Packet: Uint8Array;
}
export type GameResultCommitStatus = "committed" | "duplicate" | "conflict";

/** Trusted modern submission. This is NOT an item spawn/verdict proof. */
export interface MoneyPickupSubmission extends UserDynamicChange {
  readonly RoundID: string;
  readonly ClaimSequence: number;
  readonly ChannelIndex: number;
  readonly SessionIndex: number;
  readonly SessionSerialNo: number;
  readonly StartTick: number;
  readonly Slot: number;
  readonly GlobalSerialNo: number;
  readonly BoxIndex: number;
  readonly ItemIndex: number;
  readonly Authencode: number;
  readonly AmountParameter: number;
  readonly Multiplier: number;
  readonly Delta: number;
  readonly DiagnosticAmountExceeded: boolean;
  readonly Packet: Uint8Array;
}
export interface MoneyPickupReceipt extends GameResultReceipt {
  readonly ClaimSequence: number;
}
interface RoundClaimReceiptRow extends ReceiptRow {
  ClaimSequence: number;
  ChannelIndex: number;
  SessionIndex: number;
  SessionSerialNo: number;
  StartTick: number;
}
export type MoneyPickupCommitStatus = "committed" | "duplicate" | "conflict";
/** Modern house board/allocator + wallet receipt; never a resource item receipt. */
export interface HouseClaimSubmission extends UserDynamicChange {
  readonly RoundID: string;
  readonly ClaimSequence: number;
  readonly ChannelIndex: number;
  readonly SessionIndex: number;
  readonly SessionSerialNo: number;
  readonly StartTick: number;
  readonly GlobalSerialNo: number;
  readonly Plan: HouseClaimPlan;
  readonly Packet: Uint8Array;
}
export interface HouseClaimReceipt extends GameResultReceipt {
  readonly ClaimSequence: number;
}
export type HouseClaimCommitStatus = "committed" | "duplicate" | "conflict";
/** Trusted positive-quantity146/case0 calculation; NOT shop billing/auth. */
export interface SpecialItemUseSubmission {
  readonly RoundID: string;
  readonly UseSequence: number;
  readonly ChannelIndex: number;
  readonly SessionIndex: number;
  readonly SessionSerialNo: number;
  readonly StartTick: number;
  readonly ChannelType: number;
  readonly GlobalSerialNo: number;
  readonly Request: SpecialItemRequest;
  readonly ItemType: number;
  readonly PlayerState: number;
  readonly RefreshStateTime: number | null;
  readonly Before: Readonly<_USERINVENTORY>;
  readonly AfterAmount: number;
  readonly Packet: Uint8Array;
}
export interface SpecialItemUseReceipt extends GameResultReceipt {
  readonly UseSequence: number;
}
interface SpecialReceiptRow extends ReceiptRow {
  UseSequence: number;
  ChannelIndex: number;
  SessionIndex: number;
  SessionSerialNo: number;
  StartTick: number;
}
export type SpecialItemUseCommitStatus = "committed" | "duplicate" | "conflict";
type RoundDescriptor = Pick<
  GameResultSubmission,
  "RoundID" | "ChannelIndex" | "SessionIndex" | "SessionSerialNo" | "StartTick"
>;

export class CDBMan extends CDBManBase {
  private m_bPlanningUserInventory = false;
  /** Observed native pre -> owned ordering ONLY. No SQL calls or live After
   * installation. Actual instance guard covers input/codec/clock reentry. */
  PlanInitUserInventory(
    input: Readonly<InventoryInitializationObservation>,
    items: CUserItemMan,
    clock: CDBClock,
  ): InventoryInitializationPlan {
    if (this.m_bPlanningUserInventory)
      throw new CProtocolError("Reentrant inventory initialization projection");
    this.m_bPlanningUserInventory = true;
    try {
      if (items.db !== this)
        throw new CProtocolError(
          "Inventory initialization catalog owner mismatch",
        );
      return PlanUserInventoryInitialization(input, items, clock, this.text);
    } finally {
      this.m_bPlanningUserInventory = false;
    }
  }
  /** SQLite-only extension. Exact same round key + canonical payload is a
   * duplicate even after account values change back (ABA) or nobody gets XP.
   * A different payload for an existing key is rejected, not silently accepted.
   * Before/After CAS, receipt and packet commit in ONE IMMEDIATE transaction.
   * This authorizes no verdict and promises no exactly-once network delivery.
   */
  CommitGameResult(input: GameResultSubmission): GameResultCommitStatus {
    this.AssertReceiptTransactionOwner();
    const request = this.NormalizeGameResult(input);
    const payload = JSON.stringify({
      Version: RuntimePolicy.GameResultReceiptVersion,
      ...request,
      Packet: Buffer.from(request.Packet).toString("hex"),
    });
    if (Buffer.byteLength(payload) > RuntimePolicy.MaxGameResultReceiptBytes)
      throw new CProtocolError("Game result receipt exceeds storage limit");
    const digest = createHash("sha256").update(payload).digest("hex");
    const packet = Buffer.from(request.Packet);
    return this.session.db
      .transaction((): GameResultCommitStatus => {
        const previous = this.GetGameResultReceipt(request.RoundID);
        if (previous) {
          if (
            previous.Digest !== digest ||
            previous.Payload !== payload ||
            !previous.Packet.equals(packet)
          )
            throw new CProtocolError(
              "Game result key reused with a different submission",
              "result-key-reused",
            );
          return "duplicate";
        }
        const special = this.GetLastSpecialItemUseReceipt(request.RoundID);
        if (special) this.AssertSpecialRoundDescriptor(request, special);
        const money = this.GetLastMoneyPickupReceipt(request.RoundID);
        if (money) this.AssertMoneyRoundDescriptor(request, money);
        const house = this.GetLastHouseClaimReceipt(request.RoundID);
        if (house) this.AssertHouseRoundDescriptor(request, house);
        // Nested transaction is a SQLite savepoint; conflict already rolls it
        // back. Empty/fully departed rooms still need an immutable round receipt.
        if (
          request.Changes.length &&
          !this.UpdateUserDynamicBatch(request.Changes)
        )
          return "conflict";
        this.session.db
          .query(
            `INSERT INTO RuntimeGameResult
        (RoundID, Digest, ChannelIndex, SessionIndex, SessionSerialNo, Payload, Packet)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.RoundID,
            digest,
            request.ChannelIndex,
            request.SessionIndex,
            request.SessionSerialNo,
            payload,
            packet,
          );
        return "committed";
      })
      .immediate();
  }

  /** One-user ALL-FIVE-field absolute CAS + immutable receipt in one IMMEDIATE
   * transaction. Never SQL Money+delta: native IMUL/ADD wrap before clamping.
   * Exact duplicates precede CAS/closed-round checks (including no-op and ABA).
   * A new ordinal must be contiguous, retain the round descriptor, and precede
   * settlement. This API trusts the caller's resource/actor authorization.
   */
  CommitMoneyPickup(input: MoneyPickupSubmission): MoneyPickupCommitStatus {
    this.AssertReceiptTransactionOwner();
    const request = this.NormalizeMoneyPickup(input),
      payload = this.MoneyPickupPayload(request),
      digest = createHash("sha256").update(payload).digest("hex"),
      packet = Buffer.from(request.Packet);
    return this.session.db
      .transaction((): MoneyPickupCommitStatus => {
        const previous = this.GetMoneyPickupReceipt(
          request.RoundID,
          request.ClaimSequence,
        );
        if (previous) {
          if (
            previous.Digest !== digest ||
            previous.Payload !== payload ||
            !previous.Packet.equals(packet)
          )
            throw new CProtocolError(
              "Money pickup key reused with a different submission",
              "money-key-reused",
            );
          return "duplicate";
        }
        if (this.GetGameResultReceipt(request.RoundID))
          throw new CProtocolError(
            "Money pickup round is already settled",
            "money-round-closed",
          );
        const special = this.GetLastSpecialItemUseReceipt(request.RoundID);
        if (special) this.AssertSpecialRoundDescriptor(request, special);
        const house = this.GetLastHouseClaimReceipt(request.RoundID);
        if (house) this.AssertHouseRoundDescriptor(request, house);
        const last = this.GetLastMoneyPickupReceipt(request.RoundID);
        if (request.ClaimSequence !== (last?.ClaimSequence ?? 0) + 1)
          throw new CProtocolError(
            "Money pickup sequence is not contiguous",
            "money-sequence",
          );
        if (last) this.AssertMoneyRoundDescriptor(request, last);
        if (
          !this.UpdateUserDynamicBatch([
            { Before: request.Before, After: request.After },
          ])
        )
          return "conflict";
        this.session.db
          .query(
            `INSERT INTO RuntimeMoneyPickup
        (RoundID,ClaimSequence,Digest,ChannelIndex,SessionIndex,SessionSerialNo,StartTick,Payload,Packet)
        VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            request.RoundID,
            request.ClaimSequence,
            digest,
            request.ChannelIndex,
            request.SessionIndex,
            request.SessionSerialNo,
            request.StartTick,
            payload,
            packet,
          );
        return "committed";
      })
      .immediate();
  }

  /** Read-back of this EXACT canonical calculation, not just an acknowledgement
   * string or equal (possibly no-op) wallet. No mutation or payment is performed. */
  ConfirmMoneyPickup(input: MoneyPickupSubmission): boolean {
    this.AssertReceiptTransactionOwner(); // an enclosing view may contain uncommitted wallet edits
    const request = this.NormalizeMoneyPickup(input),
      payload = this.MoneyPickupPayload(request),
      receipt = this.GetMoneyPickupReceipt(
        request.RoundID,
        request.ClaimSequence,
      );
    if (!receipt) return false;
    if (receipt.Payload !== payload || !receipt.Packet.equals(request.Packet))
      throw new CProtocolError(
        "Money pickup key reused with a different submission",
        "money-key-reused",
      );
    return true;
  }
  /** A savepoint release is NOT a durable commit. The receipt methods must own
   * their top-level transaction; the CAS batch remains intentionally nestable. */
  private AssertReceiptTransactionOwner(): void {
    if (this.session.db.inTransaction)
      throw new CProtocolError(
        "Receipt commit requires its own top-level transaction",
        "receipt-transaction",
      );
  }

  GetMoneyPickupReceipt(
    roundID: string,
    claimSequence: number,
  ): MoneyPickupReceipt | undefined {
    this.AssertRoundID(roundID);
    this.u32(claimSequence);
    if (!claimSequence)
      throw new CProtocolError("Invalid money pickup sequence");
    const row = this.session.db
      .query<RoundClaimReceiptRow, [string, number]>(
        `SELECT RoundID,ClaimSequence,Digest,ChannelIndex,SessionIndex,SessionSerialNo,StartTick,CommittedAt,Payload,Packet
       FROM RuntimeMoneyPickup WHERE RoundID=? AND ClaimSequence=?`,
      )
      .get(roundID, claimSequence);
    if (!row) return undefined;
    const packet = Buffer.from(row.Packet);
    // Canonical revalidation also catches metadata/body corruption when someone
    // deliberately recomputes an unkeyed digest. This is NOT administrator auth.
    try {
      const data = JSON.parse(row.Payload);
      if (
        createHash("sha256").update(row.Payload).digest("hex") !== row.Digest ||
        data?.Version !== RuntimePolicy.MoneyPickupReceiptVersion ||
        typeof data.Packet !== "string"
      )
        throw new Error("digest/version");
      const normalized = this.NormalizeMoneyPickup({
        ...data,
        Packet: Buffer.from(data.Packet, "hex"),
      });
      if (
        normalized.RoundID !== roundID ||
        normalized.ClaimSequence !== claimSequence ||
        row.RoundID !== roundID ||
        row.ClaimSequence !== claimSequence ||
        normalized.ChannelIndex !== row.ChannelIndex ||
        normalized.SessionIndex !== row.SessionIndex ||
        normalized.SessionSerialNo !== row.SessionSerialNo ||
        normalized.StartTick !== row.StartTick ||
        this.MoneyPickupPayload(normalized) !== row.Payload ||
        !packet.equals(normalized.Packet)
      )
        throw new Error("body/metadata");
    } catch {
      throw new Error("Corrupt money pickup receipt");
    }
    return Object.freeze({
      RoundID: row.RoundID,
      ClaimSequence: row.ClaimSequence,
      Digest: row.Digest,
      CommittedAt: row.CommittedAt,
      Payload: row.Payload,
      Packet: packet,
    });
  }

  private GetLastMoneyPickupReceipt(
    roundID: string,
  ): MoneyPickupReceipt | undefined {
    const row = this.session.db
      .query<
        { ClaimSequence: number },
        [string]
      >("SELECT ClaimSequence FROM RuntimeMoneyPickup WHERE RoundID=? ORDER BY ClaimSequence DESC LIMIT 1")
      .get(roundID);
    return row
      ? this.GetMoneyPickupReceipt(roundID, row.ClaimSequence)
      : undefined;
  }
  private AssertMoneyRoundDescriptor(
    request: RoundDescriptor,
    receipt: MoneyPickupReceipt,
  ): void {
    const data: RoundDescriptor = JSON.parse(receipt.Payload);
    for (const field of [
      "RoundID",
      "ChannelIndex",
      "SessionIndex",
      "SessionSerialNo",
      "StartTick",
    ] as const)
      if (request[field] !== data[field])
        throw new CProtocolError(
          "Money/result round descriptor changed",
          "money-round-reused",
        );
  }
  private MoneyPickupPayload(request: MoneyPickupSubmission): string {
    const payload = JSON.stringify({
      Version: RuntimePolicy.MoneyPickupReceiptVersion,
      ...request,
      Packet: Buffer.from(request.Packet).toString("hex"),
    });
    if (Buffer.byteLength(payload) > RuntimePolicy.MaxMoneyPickupReceiptBytes)
      throw new CProtocolError("Money pickup receipt exceeds storage limit");
    return payload;
  }
  private NormalizeMoneyPickup(
    input: MoneyPickupSubmission,
  ): MoneyPickupSubmission {
    this.AssertRoundID(input.RoundID);
    for (const value of [
      input.ClaimSequence,
      input.ChannelIndex,
      input.SessionSerialNo,
      input.StartTick,
      input.GlobalSerialNo,
    ])
      this.u32(value);
    if (!input.ClaimSequence)
      throw new CProtocolError("Invalid money pickup sequence");
    const index = (value: number, maximum: number) => {
      if (!Number.isInteger(value) || value < 0 || value >= maximum)
        throw new CProtocolError("Invalid money pickup index/byte");
    };
    index(input.SessionIndex, SessionLimit.GameSessions);
    index(input.Slot, SessionLimit.Players);
    index(input.BoxIndex, GameContextLimit.BoxItems);
    index(input.ItemIndex, ItemAttrFormat.MaximumItems);
    index(input.Authencode, 0x100);
    if (
      !Number.isInteger(input.AmountParameter) ||
      input.AmountParameter < IntegerRange.Int32Minimum ||
      input.AmountParameter > IntegerRange.Int32Maximum
    )
      throw new CProtocolError("Invalid signed money amount parameter");
    if (
      input.Multiplier !== MoneyPickupRule.MinimumMultiplier &&
      (input.Authencode !== MoneyPickupRule.BonusAuthencode ||
        input.Multiplier !==
          MoneyPickupRule.MinimumMultiplier +
            MoneyPickupRule.MultiplierModulo -
            1)
    )
      throw new CProtocolError("Invalid native money multiplier");
    const delta = Math.imul(input.Multiplier, input.AmountParameter);
    if (
      input.Delta !== delta ||
      typeof input.DiagnosticAmountExceeded !== "boolean" ||
      input.DiagnosticAmountExceeded !==
        delta > MoneyPickupRule.DiagnosticAmountThreshold
    )
      throw new CProtocolError(
        "Money pickup delta/diagnostic differs from native IMUL",
      );
    if (!input.Before || !input.After)
      throw new CProtocolError("Missing money snapshots");
    this.ValidateID(input.Before.ID);
    this.ValidateID(input.After.ID);
    const id = NormalizeID(input.Before.ID);
    if (id !== NormalizeID(input.After.ID))
      throw new CProtocolError("Money pickup user identity changed");
    const copy = (state: Readonly<_USERDYNINFO>): Readonly<_USERDYNINFO> => {
        for (const value of [
          state.Money,
          state.Exp,
          state.Win,
          state.Draw,
          state.Lose,
        ])
          this.u31(value);
        return Object.freeze({
          ID: id,
          Money: state.Money,
          Exp: state.Exp,
          Win: state.Win,
          Draw: state.Draw,
          Lose: state.Lose,
        });
      },
      before = copy(input.Before),
      after = copy(input.After),
      wrapped = (before.Money + delta) | 0,
      expectedMoney =
        wrapped < 0 ? 0 : Math.min(wrapped, UserDynamicRule.MaximumMoney);
    if (
      after.Money !== expectedMoney ||
      (["Exp", "Win", "Draw", "Lose"] as const).some(
        (field) => before[field] !== after[field],
      )
    )
      throw new CProtocolError(
        "Money pickup snapshots differ from native money-only ADD/clamp",
      );
    const packet = Buffer.from(input.Packet),
      p = new CReceivedPacketBase(packet, CipherDegree.CRC8, this.text);
    if (
      packet.length !== 1 + MoneyPickupRule.ResponseFieldCount ||
      p.Decode1() !== ServerResponse.EatItem ||
      p.Decode1() !== input.Slot ||
      p.Decode1() !== input.BoxIndex ||
      p.Decode1() !== input.ItemIndex ||
      p.Decode1() !== input.Multiplier
    )
      throw new CProtocolError(
        "Money pickup packet differs from frozen calculation",
      );
    p.AssertEnd();
    return Object.freeze({
      RoundID: input.RoundID,
      ClaimSequence: input.ClaimSequence,
      ChannelIndex: input.ChannelIndex,
      SessionIndex: input.SessionIndex,
      SessionSerialNo: input.SessionSerialNo,
      StartTick: input.StartTick,
      Slot: input.Slot,
      GlobalSerialNo: input.GlobalSerialNo,
      BoxIndex: input.BoxIndex,
      ItemIndex: input.ItemIndex,
      Authencode: input.Authencode,
      AmountParameter: input.AmountParameter,
      Multiplier: input.Multiplier,
      Delta: delta,
      DiagnosticAmountExceeded: input.DiagnosticAmountExceeded,
      Before: before,
      After: after,
      Packet: packet,
    });
  }

  /** House161 is NOT a Type99 item. Own root IMMEDIATE transaction, all-five
   * wallet CAS and immutable board/allocator/request/178 receipt. Even zero new
   * cells keeps the native IncDecMoney(0) intent. Exact duplicates never pay. */
  CommitHouseClaim(input: HouseClaimSubmission): HouseClaimCommitStatus {
    this.AssertReceiptTransactionOwner();
    const request = this.NormalizeHouseClaim(input),
      payload = this.HouseClaimPayload(request),
      digest = createHash("sha256").update(payload).digest("hex"),
      packet = Buffer.from(request.Packet);
    return this.session.db
      .transaction((): HouseClaimCommitStatus => {
        const previous = this.GetHouseClaimReceipt(
          request.RoundID,
          request.ClaimSequence,
        );
        if (previous) {
          if (
            previous.Payload !== payload ||
            previous.Digest !== digest ||
            !previous.Packet.equals(packet)
          )
            throw new CProtocolError(
              "House claim key reused with a different submission",
              "house-key-reused",
            );
          return "duplicate";
        }
        if (this.GetGameResultReceipt(request.RoundID))
          throw new CProtocolError(
            "House claim round is already settled",
            "house-round-closed",
          );
        const special = this.GetLastSpecialItemUseReceipt(request.RoundID);
        if (special) this.AssertSpecialRoundDescriptor(request, special);
        const last = this.GetLastHouseClaimReceipt(request.RoundID),
          money = this.GetLastMoneyPickupReceipt(request.RoundID);
        if (request.ClaimSequence !== (last?.ClaimSequence ?? 0) + 1)
          throw new CProtocolError(
            "House claim sequence is not contiguous",
            "house-sequence",
          );
        if (money) this.AssertMoneyRoundDescriptor(request, money);
        if (last) {
          this.AssertHouseRoundDescriptor(request, last);
          if (
            JSON.stringify(JSON.parse(last.Payload).Plan.After) !==
            JSON.stringify(request.Plan.Before)
          )
            throw new CProtocolError(
              "House board/allocator receipt chain changed",
              "house-board-changed",
            );
        }
        if (
          !this.UpdateUserDynamicBatch([
            { Before: request.Before, After: request.After },
          ])
        )
          return "conflict";
        this.session.db
          .query(
            `INSERT INTO RuntimeHouseClaim
        (RoundID,ClaimSequence,Digest,ChannelIndex,SessionIndex,SessionSerialNo,StartTick,Payload,Packet)
        VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            request.RoundID,
            request.ClaimSequence,
            digest,
            request.ChannelIndex,
            request.SessionIndex,
            request.SessionSerialNo,
            request.StartTick,
            payload,
            packet,
          );
        return "committed";
      })
      .immediate();
  }
  ConfirmHouseClaim(input: HouseClaimSubmission): boolean {
    this.AssertReceiptTransactionOwner();
    const request = this.NormalizeHouseClaim(input),
      payload = this.HouseClaimPayload(request),
      receipt = this.GetHouseClaimReceipt(
        request.RoundID,
        request.ClaimSequence,
      );
    if (!receipt) return false;
    if (receipt.Payload !== payload || !receipt.Packet.equals(request.Packet))
      throw new CProtocolError(
        "House claim key reused with a different submission",
        "house-key-reused",
      );
    return true;
  }
  GetHouseClaimReceipt(
    roundID: string,
    sequence: number,
  ): HouseClaimReceipt | undefined {
    this.AssertRoundID(roundID);
    this.u32(sequence);
    if (!sequence) throw new CProtocolError("Invalid house claim sequence");
    const row = this.session.db
      .query<RoundClaimReceiptRow, [string, number]>(
        `SELECT RoundID,ClaimSequence,Digest,ChannelIndex,SessionIndex,SessionSerialNo,StartTick,CommittedAt,Payload,Packet
       FROM RuntimeHouseClaim WHERE RoundID=? AND ClaimSequence=?`,
      )
      .get(roundID, sequence);
    if (!row) return undefined;
    const packet = Buffer.from(row.Packet);
    try {
      const data = JSON.parse(row.Payload);
      if (
        createHash("sha256").update(row.Payload).digest("hex") !== row.Digest ||
        data?.Version !== RuntimePolicy.HouseClaimReceiptVersion ||
        typeof data.Packet !== "string"
      )
        throw new Error("digest/version");
      const normalized = this.NormalizeHouseClaim({
        ...data,
        Packet: Buffer.from(data.Packet, "hex"),
      });
      if (
        normalized.RoundID !== roundID ||
        normalized.ClaimSequence !== sequence ||
        row.RoundID !== roundID ||
        row.ClaimSequence !== sequence ||
        normalized.ChannelIndex !== row.ChannelIndex ||
        normalized.SessionIndex !== row.SessionIndex ||
        normalized.SessionSerialNo !== row.SessionSerialNo ||
        normalized.StartTick !== row.StartTick ||
        this.HouseClaimPayload(normalized) !== row.Payload ||
        !packet.equals(normalized.Packet)
      )
        throw new Error("body/metadata");
    } catch {
      throw new Error("Corrupt house claim receipt");
    }
    return Object.freeze({
      RoundID: row.RoundID,
      ClaimSequence: row.ClaimSequence,
      Digest: row.Digest,
      CommittedAt: row.CommittedAt,
      Payload: row.Payload,
      Packet: packet,
    });
  }
  private GetLastHouseClaimReceipt(
    roundID: string,
  ): HouseClaimReceipt | undefined {
    const row = this.session.db
      .query<
        { ClaimSequence: number },
        [string]
      >("SELECT ClaimSequence FROM RuntimeHouseClaim WHERE RoundID=? ORDER BY ClaimSequence DESC LIMIT 1")
      .get(roundID);
    return row
      ? this.GetHouseClaimReceipt(roundID, row.ClaimSequence)
      : undefined;
  }
  private AssertHouseRoundDescriptor(
    request: RoundDescriptor,
    receipt: HouseClaimReceipt,
  ): void {
    const data: RoundDescriptor = JSON.parse(receipt.Payload);
    for (const field of [
      "RoundID",
      "ChannelIndex",
      "SessionIndex",
      "SessionSerialNo",
      "StartTick",
    ] as const)
      if (request[field] !== data[field])
        throw new CProtocolError(
          "House/result round descriptor changed",
          "house-round-reused",
        );
  }
  private HouseClaimPayload(request: HouseClaimSubmission): string {
    const payload = JSON.stringify({
      Version: RuntimePolicy.HouseClaimReceiptVersion,
      ...request,
      Packet: Buffer.from(request.Packet).toString("hex"),
    });
    if (Buffer.byteLength(payload) > RuntimePolicy.MaxHouseClaimReceiptBytes)
      throw new CProtocolError("House claim receipt exceeds storage limit");
    return payload;
  }
  private NormalizeHouseClaim(
    input: HouseClaimSubmission,
  ): HouseClaimSubmission {
    this.AssertRoundID(input.RoundID);
    for (const value of [
      input.ClaimSequence,
      input.ChannelIndex,
      input.SessionSerialNo,
      input.StartTick,
      input.GlobalSerialNo,
    ])
      this.u32(value);
    if (
      !input.ClaimSequence ||
      !Number.isInteger(input.SessionIndex) ||
      input.SessionIndex < 0 ||
      input.SessionIndex >= SessionLimit.GameSessions
    )
      throw new CProtocolError("Invalid house sequence/session");
    if (!input.Plan) throw new CProtocolError("Missing house plan");
    const plan = PlanTakeHouse(
      input.Plan.Before,
      input.Plan.Slot,
      input.Plan.Color,
      input.Plan.Cells,
      input.Plan.DropRequests,
    );
    if (
      JSON.stringify(input.Plan.After?.States) !==
        JSON.stringify(plan.After.States) ||
      JSON.stringify(input.Plan.After?.Counts) !==
        JSON.stringify(plan.After.Counts) ||
      input.Plan.After?.NextBoxItem !== plan.After.NextBoxItem ||
      JSON.stringify(input.Plan.AcceptedCells) !==
        JSON.stringify(plan.AcceptedCells) ||
      JSON.stringify(input.Plan.AllocatedDrops) !==
        JSON.stringify(plan.AllocatedDrops) ||
      input.Plan.Delta !== plan.Delta
    )
      throw new CProtocolError(
        "House plan differs from native board/allocator calculation",
      );
    if (!input.Before || !input.After)
      throw new CProtocolError("Missing house wallet snapshots");
    this.ValidateID(input.Before.ID);
    this.ValidateID(input.After.ID);
    const id = NormalizeID(input.Before.ID);
    if (id !== NormalizeID(input.After.ID))
      throw new CProtocolError("House user identity changed");
    const copy = (state: Readonly<_USERDYNINFO>): Readonly<_USERDYNINFO> => {
        for (const value of [
          state.Money,
          state.Exp,
          state.Win,
          state.Draw,
          state.Lose,
        ])
          this.u31(value);
        return Object.freeze({
          ID: id,
          Money: state.Money,
          Exp: state.Exp,
          Win: state.Win,
          Draw: state.Draw,
          Lose: state.Lose,
        });
      },
      before = copy(input.Before),
      after = copy(input.After),
      wrapped = (before.Money + plan.Delta) | 0,
      expected =
        wrapped < 0 ? 0 : Math.min(wrapped, UserDynamicRule.MaximumMoney);
    if (
      after.Money !== expected ||
      (["Exp", "Win", "Draw", "Lose"] as const).some(
        (field) => after[field] !== before[field],
      )
    )
      throw new CProtocolError("House wallet differs from native ADD/clamp");
    const packet = Buffer.from(input.Packet);
    if (!packet.equals(MakeTakeHousePacket(plan).GetBuffer()))
      throw new CProtocolError("House packet differs from frozen plan");
    return Object.freeze({
      RoundID: input.RoundID,
      ClaimSequence: input.ClaimSequence,
      ChannelIndex: input.ChannelIndex,
      SessionIndex: input.SessionIndex,
      SessionSerialNo: input.SessionSerialNo,
      StartTick: input.StartTick,
      GlobalSerialNo: input.GlobalSerialNo,
      Plan: plan,
      Before: before,
      After: after,
      Packet: packet,
    });
  }

  /** Independent positive-quantity case0 receipt + FULL inventory metadata CAS.
   * No resource/SN equivalence or billing proof is invented. A successful final
   * use deletes the SQL row; the session retains native live amount0/dirty. */
  CommitSpecialItemUse(
    input: SpecialItemUseSubmission,
  ): SpecialItemUseCommitStatus {
    this.AssertReceiptTransactionOwner();
    const request = this.NormalizeSpecialItemUse(input),
      payload = this.SpecialItemUsePayload(request),
      digest = createHash("sha256").update(payload).digest("hex"),
      packet = Buffer.from(request.Packet);
    return this.session.db
      .transaction((): SpecialItemUseCommitStatus => {
        const previous = this.GetSpecialItemUseReceipt(
          request.RoundID,
          request.UseSequence,
        );
        if (previous) {
          if (
            previous.Payload !== payload ||
            previous.Digest !== digest ||
            !previous.Packet.equals(packet)
          )
            throw new CProtocolError(
              "Special-item key reused with a different submission",
              "special-key-reused",
            );
          return "duplicate";
        }
        if (this.GetGameResultReceipt(request.RoundID))
          throw new CProtocolError(
            "Special-item round is already settled",
            "special-round-closed",
          );
        const last = this.GetLastSpecialItemUseReceipt(request.RoundID),
          money = this.GetLastMoneyPickupReceipt(request.RoundID),
          house = this.GetLastHouseClaimReceipt(request.RoundID);
        if (request.UseSequence !== (last?.UseSequence ?? 0) + 1)
          throw new CProtocolError(
            "Special-item sequence is not contiguous",
            "special-sequence",
          );
        if (last) this.AssertSpecialRoundDescriptor(request, last);
        if (money) this.AssertMoneyRoundDescriptor(request, money);
        if (house) this.AssertHouseRoundDescriptor(request, house);
        const row = request.Before,
          predicate =
            "SN=? AND ID=? AND ItemID=? AND Slot=? AND Amount=? AND ExpireDate=? AND Verbose=? AND CreatedAt=?",
          bindings = [
            row.SN,
            row.ID,
            row.ItemID,
            row.Slot,
            row.Amount,
            row.ExpireDate,
            row.Verbose,
            row.CreatedAt,
          ];
        if (!this.GetUserInfo(row.ID)) return "conflict";
        const changed =
          request.AfterAmount === 0
            ? this.session.db
                .query(`DELETE FROM FxUserInventory WHERE ${predicate}`)
                .run(...bindings)
            : this.session.db
                .query(`UPDATE FxUserInventory SET Amount=? WHERE ${predicate}`)
                .run(request.AfterAmount, ...bindings);
        if (changed.changes !== 1) return "conflict";
        this.session.db
          .query(
            `INSERT INTO RuntimeSpecialItemUse
        (RoundID,UseSequence,Digest,ChannelIndex,SessionIndex,SessionSerialNo,StartTick,Payload,Packet)
        VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            request.RoundID,
            request.UseSequence,
            digest,
            request.ChannelIndex,
            request.SessionIndex,
            request.SessionSerialNo,
            request.StartTick,
            payload,
            packet,
          );
        return "committed";
      })
      .immediate();
  }
  ConfirmSpecialItemUse(input: SpecialItemUseSubmission): boolean {
    this.AssertReceiptTransactionOwner();
    const request = this.NormalizeSpecialItemUse(input),
      payload = this.SpecialItemUsePayload(request),
      receipt = this.GetSpecialItemUseReceipt(
        request.RoundID,
        request.UseSequence,
      );
    if (!receipt) return false;
    if (receipt.Payload !== payload || !receipt.Packet.equals(request.Packet))
      throw new CProtocolError(
        "Special-item key reused with a different submission",
        "special-key-reused",
      );
    return true;
  }
  /** Deliberately no load-time expiry predicate: inspect the ACTUAL persisted
   * SN, including another owner/changed metadata or absence after amount0. */
  GetInventoryRecord(sn: number): Readonly<_USERINVENTORY> | undefined {
    this.u32(sn);
    const row = this.session.db
      .query<
        _USERINVENTORY,
        [number]
      >("SELECT * FROM FxUserInventory WHERE SN=?")
      .get(sn);
    return row ? CopySpecialItemInventory(row, this.text) : undefined;
  }
  GetSpecialItemUseReceipt(
    roundID: string,
    sequence: number,
  ): SpecialItemUseReceipt | undefined {
    this.AssertRoundID(roundID);
    this.u32(sequence);
    if (!sequence) throw new CProtocolError("Invalid special-item sequence");
    const row = this.session.db
      .query<SpecialReceiptRow, [string, number]>(
        `SELECT RoundID,UseSequence,Digest,ChannelIndex,SessionIndex,SessionSerialNo,StartTick,CommittedAt,Payload,Packet
       FROM RuntimeSpecialItemUse WHERE RoundID=? AND UseSequence=?`,
      )
      .get(roundID, sequence);
    if (!row) return undefined;
    const packet = Buffer.from(row.Packet);
    try {
      const data = JSON.parse(row.Payload);
      if (
        createHash("sha256").update(row.Payload).digest("hex") !== row.Digest ||
        data?.Version !== RuntimePolicy.SpecialItemUseReceiptVersion ||
        typeof data.Packet !== "string"
      )
        throw new Error("digest/version");
      const normalized = this.NormalizeSpecialItemUse({
        ...data,
        Packet: Buffer.from(data.Packet, "hex"),
      });
      if (
        normalized.RoundID !== roundID ||
        normalized.UseSequence !== sequence ||
        row.RoundID !== roundID ||
        row.UseSequence !== sequence ||
        normalized.ChannelIndex !== row.ChannelIndex ||
        normalized.SessionIndex !== row.SessionIndex ||
        normalized.SessionSerialNo !== row.SessionSerialNo ||
        normalized.StartTick !== row.StartTick ||
        this.SpecialItemUsePayload(normalized) !== row.Payload ||
        !packet.equals(normalized.Packet)
      )
        throw new Error("body/metadata");
    } catch {
      throw new Error("Corrupt special-item receipt");
    }
    return Object.freeze({
      RoundID: row.RoundID,
      UseSequence: row.UseSequence,
      Digest: row.Digest,
      CommittedAt: row.CommittedAt,
      Payload: row.Payload,
      Packet: packet,
    });
  }
  private GetLastSpecialItemUseReceipt(
    roundID: string,
  ): SpecialItemUseReceipt | undefined {
    const row = this.session.db
      .query<
        { UseSequence: number },
        [string]
      >("SELECT UseSequence FROM RuntimeSpecialItemUse WHERE RoundID=? ORDER BY UseSequence DESC LIMIT 1")
      .get(roundID);
    return row
      ? this.GetSpecialItemUseReceipt(roundID, row.UseSequence)
      : undefined;
  }
  private AssertSpecialRoundDescriptor(
    request: RoundDescriptor,
    receipt: SpecialItemUseReceipt,
  ): void {
    const data: RoundDescriptor = JSON.parse(receipt.Payload);
    for (const field of [
      "RoundID",
      "ChannelIndex",
      "SessionIndex",
      "SessionSerialNo",
      "StartTick",
    ] as const)
      if (request[field] !== data[field])
        throw new CProtocolError(
          "Special-item/result round descriptor changed",
          "special-round-reused",
        );
  }
  private SpecialItemUsePayload(request: SpecialItemUseSubmission): string {
    const payload = JSON.stringify({
      Version: RuntimePolicy.SpecialItemUseReceiptVersion,
      ...request,
      Packet: Buffer.from(request.Packet).toString("hex"),
    });
    if (
      Buffer.byteLength(payload) > RuntimePolicy.MaxSpecialItemUseReceiptBytes
    )
      throw new CProtocolError("Special-item receipt exceeds storage limit");
    return payload;
  }
  private NormalizeSpecialItemUse(
    input: SpecialItemUseSubmission,
  ): SpecialItemUseSubmission {
    this.AssertRoundID(input.RoundID);
    for (const value of [
      input.UseSequence,
      input.ChannelIndex,
      input.SessionSerialNo,
      input.StartTick,
      input.GlobalSerialNo,
    ])
      this.u32(value);
    if (
      !input.UseSequence ||
      !Number.isInteger(input.SessionIndex) ||
      input.SessionIndex < 0 ||
      input.SessionIndex >= SessionLimit.GameSessions ||
      !Number.isInteger(input.ChannelType) ||
      input.ChannelType < 0 ||
      input.ChannelType > IntegerRange.UInt8Maximum ||
      input.ChannelType === SpecialItemRule.NoShopUseChannelType
    )
      throw new CProtocolError("Invalid special-item sequence/session/channel");
    const request = NormalizeSpecialItemRequest(input.Request);
    if (
      !request.Quantity ||
      !IsSpecialItemType(input.ItemType) ||
      !Number.isInteger(input.PlayerState) ||
      input.PlayerState < 0 ||
      input.PlayerState > IntegerRange.UInt8Maximum
    )
      throw new CProtocolError("Invalid special-item effect/quantity/state");
    const refresh =
      input.ItemType === SpecialItemRule.RefreshStateTimeType &&
      input.PlayerState === GamePlayerState.PendingDie;
    if (refresh) {
      if (input.RefreshStateTime === null)
        throw new CProtocolError("Missing special-item state time");
      this.u32(input.RefreshStateTime);
    } else if (input.RefreshStateTime !== null)
      throw new CProtocolError("Unexpected special-item state time");
    if (!input.Before)
      throw new CProtocolError("Missing special-item inventory snapshot");
    this.ValidateID(input.Before.ID);
    const before = CopySpecialItemInventory(input.Before, this.text),
      after = before.Amount - request.Quantity;
    if (
      before.SN !== request.InventorySN ||
      after < 0 ||
      input.AfterAmount !== after
    )
      throw new CProtocolError(
        "Special-item amount/SN differs from native subtraction",
      );
    const packet = Buffer.from(input.Packet);
    if (!packet.equals(MakeSpecialItemPacket(request).GetBuffer()))
      throw new CProtocolError(
        "Special-item packet differs from frozen request",
      );
    return Object.freeze({
      RoundID: input.RoundID,
      UseSequence: input.UseSequence,
      ChannelIndex: input.ChannelIndex,
      SessionIndex: input.SessionIndex,
      SessionSerialNo: input.SessionSerialNo,
      StartTick: input.StartTick,
      ChannelType: input.ChannelType,
      GlobalSerialNo: input.GlobalSerialNo,
      Request: request,
      ItemType: input.ItemType,
      PlayerState: input.PlayerState,
      RefreshStateTime: input.RefreshStateTime,
      Before: before,
      AfterAmount: after,
      Packet: packet,
    });
  }

  GetGameResultReceipt(roundID: string): GameResultReceipt | undefined {
    this.AssertRoundID(roundID);
    const row = this.session.db
      .query<
        ReceiptRow,
        [string]
      >("SELECT RoundID,Digest,CommittedAt,Payload,Packet FROM RuntimeGameResult WHERE RoundID = ?")
      .get(roundID);
    if (!row) return undefined;
    const packet = Buffer.from(row.Packet);
    // Corruption detection, NOT a keyed authentication tag or protection from
    // an administrator who can change schema/data and recompute this hash.
    if (createHash("sha256").update(row.Payload).digest("hex") !== row.Digest)
      throw new Error("Corrupt game result receipt digest");
    const data: { Version?: number; RoundID?: string; Packet?: string } =
      JSON.parse(row.Payload);
    if (
      data.Version !== RuntimePolicy.GameResultReceiptVersion ||
      data.RoundID !== roundID ||
      data.Packet !== packet.toString("hex")
    )
      throw new Error("Corrupt game result receipt body");
    return Object.freeze({
      RoundID: row.RoundID,
      Digest: row.Digest,
      CommittedAt: row.CommittedAt,
      Payload: row.Payload,
      Packet: packet,
    });
  }

  private NormalizeGameResult(
    input: GameResultSubmission,
  ): GameResultSubmission {
    this.AssertRoundID(input.RoundID);
    for (const value of [
      input.ChannelIndex,
      input.SessionSerialNo,
      input.StartTick,
      input.ElapsedMilliseconds,
    ])
      this.u32(value);
    if (
      !Number.isInteger(input.SessionIndex) ||
      input.SessionIndex < 0 ||
      input.SessionIndex >= SessionLimit.GameSessions
    )
      throw new CProtocolError("Invalid result session index");
    if (
      !Number.isInteger(input.WinningColor) ||
      input.WinningColor < -1 ||
      input.WinningColor >= SessionLimit.Players
    )
      throw new CProtocolError("Invalid result winner color");
    if (
      (input.Reason !== "claims" && input.Reason !== "timeout") ||
      typeof input.InvalidGame !== "boolean"
    )
      throw new CProtocolError("Invalid result boundary");
    if (input.Reason === "timeout" && input.WinningColor !== -1)
      throw new CProtocolError("Native timeout result must be draw");
    if (
      !Array.isArray(input.Changes) ||
      input.Changes.length > SessionLimit.Players ||
      !Array.isArray(input.CountedSlots) ||
      input.CountedSlots.length > SessionLimit.Players
    )
      throw new CProtocolError("Invalid result player arrays");
    const ids = new Set<string>(),
      serials = new Set<number>(),
      slots = new Set<number>();
    const maximumWinDelta = Math.trunc(
      Math.trunc(
        (DynInfoRule.WinMaximum * DynInfoRule.PremiumNumerator) /
          DynInfoRule.PremiumDenominator,
      ) *
        (GameResultRule.OpposingShopItemWinMultiplier +
          GameResultRule.PremiumTeammateWinBonus),
    );
    const changes = Array.from(input.Changes, (change): GameResultChange => {
      if (!change?.Before || !change.After)
        throw new CProtocolError("Missing result player snapshots");
      const slot = change.Slot;
      if (
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot >= SessionLimit.Players ||
        slots.has(slot)
      )
        throw new CProtocolError("Invalid or duplicate result slot");
      slots.add(slot);
      this.u32(change.GlobalSerialNo);
      if (serials.has(change.GlobalSerialNo))
        throw new CProtocolError("Duplicate result global serial");
      serials.add(change.GlobalSerialNo);
      this.ValidateID(change.Before.ID);
      const id = NormalizeID(change.Before.ID);
      if (ids.has(id) || change.Before.ID !== change.After.ID)
        throw new CProtocolError("Invalid result user identity");
      ids.add(id);
      const copy = (state: Readonly<_USERDYNINFO>): Readonly<_USERDYNINFO> => {
        for (const value of [
          state.Money,
          state.Exp,
          state.Win,
          state.Draw,
          state.Lose,
        ])
          this.u31(value);
        return Object.freeze({
          ID: state.ID,
          Money: state.Money,
          Exp: state.Exp,
          Win: state.Win,
          Draw: state.Draw,
          Lose: state.Lose,
        });
      };
      const before = copy(change.Before),
        after = copy(change.After),
        delta = change.ExperienceDelta;
      if (
        !Number.isInteger(change.Category) ||
        change.Category < GameResultCategory.Win ||
        change.Category > GameResultCategory.Draw
      )
        throw new CProtocolError("Invalid game result category");
      const maximumDelta =
        change.Category === GameResultCategory.Draw
          ? Math.trunc(
              (DynInfoRule.DrawMaximum * DynInfoRule.PremiumNumerator) /
                DynInfoRule.PremiumDenominator,
            )
          : change.Category === GameResultCategory.Lose
            ? DynInfoRule.KillSaveMaximum
            : maximumWinDelta;
      if (!Number.isInteger(delta) || delta < 0 || delta > maximumDelta)
        throw new CProtocolError("Invalid game result XP delta");
      if (
        (input.WinningColor === -1) !==
        (change.Category === GameResultCategory.Draw)
      )
        throw new CProtocolError(
          "Result category disagrees with draw boundary",
        );
      if (
        after.Money !== before.Money ||
        after.Exp !== Math.max(0, (before.Exp + delta) | 0) ||
        (input.InvalidGame && delta !== 0)
      )
        throw new CProtocolError(
          "Result dynamic values disagree with native XP-only mutation",
        );
      const field =
        change.Category === GameResultCategory.Draw
          ? "Draw"
          : change.Category === GameResultCategory.Lose
            ? "Lose"
            : "Win";
      for (const counter of ["Win", "Draw", "Lose"] as const) {
        const expected =
          !input.InvalidGame && counter === field
            ? (before[counter] + 1) | 0
            : before[counter];
        if (after[counter] !== expected)
          throw new CProtocolError("Result WDL disagrees with native category");
      }
      return Object.freeze({
        Slot: slot,
        GlobalSerialNo: change.GlobalSerialNo,
        Category: change.Category,
        ExperienceDelta: delta,
        Before: before,
        After: after,
      });
    }).sort((a, b) => a.Slot - b.Slot);
    const counted = Array.from(input.CountedSlots);
    if (
      counted.some(
        (slot, index) =>
          !Number.isInteger(slot) || slot !== changes[index]?.Slot,
      ) ||
      (input.Reason === "timeout" && counted.length)
    )
      throw new CProtocolError("Invalid native IncGame traversal prefix");
    const packet = Buffer.from(input.Packet);
    const expectedLength =
      1 +
      GameResultFormat.PrefixBytes +
      SessionLimit.Players +
      GameResultFormat.OccupiedPlayerBytes * changes.length;
    if (
      packet.length !== expectedLength ||
      packet[0] !== (ServerResponse.GameResult ^ ScalarCipher.ByteXor)
    )
      throw new CProtocolError("Invalid stored result packet");
    this.ValidateResultPacket(packet, input.WinningColor, changes);
    // Fixed property order is deliberate: caller object insertion order and
    // array order must not turn the SAME semantic request into a new digest.
    return Object.freeze({
      RoundID: input.RoundID,
      ChannelIndex: input.ChannelIndex,
      SessionIndex: input.SessionIndex,
      SessionSerialNo: input.SessionSerialNo,
      StartTick: input.StartTick,
      ElapsedMilliseconds: input.ElapsedMilliseconds,
      WinningColor: input.WinningColor,
      Reason: input.Reason,
      InvalidGame: input.InvalidGame,
      CountedSlots: Object.freeze(counted),
      Changes: Object.freeze(changes),
      Packet: packet,
    });
  }

  private ValidateResultPacket(
    packet: Buffer,
    winner: number,
    changes: readonly GameResultChange[],
  ): void {
    const p = new CReceivedPacketBase(packet, CipherDegree.CRC8, this.text);
    p.Decode1();
    const special = p.Decode1(),
      color = p.Decode1(),
      view = p.Decode1(),
      ladder = p.Decode1(),
      shop = p.Decode1();
    if (
      special > 1 ||
      color !== (winner & 0xff) ||
      view !== 0 ||
      ladder !== 0 ||
      shop > 1
    )
      throw new CProtocolError("Invalid ordinary result prefix");
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      const change = changes.find((entry) => entry.Slot === slot),
        present = p.Decode1();
      if (present !== (change ? 1 : 0))
        throw new CProtocolError(
          "Result packet occupancy differs from updates",
        );
      if (!change) continue;
      if (
        p.Decode4() !== change.GlobalSerialNo ||
        p.Decode1() !== change.Category
      )
        throw new CProtocolError(
          "Result packet player identity/category differs from updates",
        );
      p.Decode1();
      p.Decode1(); // low8 kills/saves are audit bytes, not DB counters
      let oldPercent = CDynInfoCalculator.GetExpPercentage(change.Before.Exp);
      const newPercent = CDynInfoCalculator.GetExpPercentage(change.After.Exp);
      if (oldPercent > newPercent) oldPercent = 0;
      if (p.Decode2() !== oldPercent || p.Decode2() !== newPercent)
        throw new CProtocolError(
          "Result packet percentages differ from updates",
        );
      const look = p.Decode2(),
        up = p.Decode1(),
        detail = p.Decode1();
      // Up cannot be derived from Exp alone: native cache can be stale.
      if (look < 1 || look > g_nLevel2ExpTable.length || up > 1 || detail > 3)
        throw new CProtocolError("Invalid result look-level/flags");
    }
    p.AssertEnd();
  }
  private AssertRoundID(value: string): void {
    if (
      typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        value,
      )
    )
      throw new CProtocolError("Invalid server-generated round ID");
  }
}
