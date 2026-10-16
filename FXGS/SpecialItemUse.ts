import { CProtocolError } from "../Common/CProtocolError.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { NormalizeID } from "../Common/CIDCompare.ts";
import { DefaultTextCodec, type CTextCodec } from "../Common/CTextCodec.ts";
import {
  IsUserInventory,
  type UserInventory,
} from "../Common/UserInventory.ts";
import type { _USERINVENTORY } from "../Common/DB/Rows.ts";
import {
  IntegerRange,
  SessionLimit,
  SpecialItemRule,
} from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import {
  ClientRequest,
  ServerResponse,
} from "../Common/Protocol/PacketTypes.ts";

/** Modern detached factoring of OnSetBomberEvent case0, NOT a recovered struct,
 * shop definition, inventory-item -> resource identity proof or physics engine. */
export interface SpecialItemRequest {
  readonly Slot: number;
  readonly X: number;
  readonly Y: number;
  readonly Opaque: number;
  readonly ItemIndex: number;
  readonly Quantity: number;
  readonly InventorySN?: number;
}
export function IsSpecialItemType(type: number): boolean {
  return (SpecialItemRule.AllowedTypes as readonly number[]).includes(type);
}
function integer(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum)
    throw new CProtocolError("Invalid special-item scalar");
}
export function NormalizeSpecialItemRequest(
  input: SpecialItemRequest,
): SpecialItemRequest {
  integer(input.Slot, SessionLimit.Players - 1);
  integer(input.X, IntegerRange.UInt16Maximum);
  integer(input.Y, IntegerRange.UInt16Maximum);
  for (const value of [input.Opaque, input.ItemIndex, input.Quantity])
    integer(value, IntegerRange.UInt8Maximum);
  if (input.Quantity > 0) {
    if (input.InventorySN === undefined)
      throw new CProtocolError("Missing special-item inventory SN");
    integer(input.InventorySN, IntegerRange.UInt32Maximum);
  } else if (input.InventorySN !== undefined)
    throw new CProtocolError("Zero-quantity special item has no inventory SN");
  return Object.freeze({
    Slot: input.Slot,
    X: input.X,
    Y: input.Y,
    Opaque: input.Opaque,
    ItemIndex: input.ItemIndex,
    Quantity: input.Quantity,
    ...(input.Quantity ? { InventorySN: input.InventorySN! } : {}),
  });
}
export function MakeSpecialItemRequest(input: SpecialItemRequest): CSendPacket {
  const r = NormalizeSpecialItemRequest(input),
    p = new CSendPacket(ClientRequest.SetBomberEvent)
      .Encode1(r.Slot)
      .Encode2(r.X)
      .Encode2(r.Y)
      .Encode1(r.Opaque)
      .Encode1(r.ItemIndex)
      .Encode1(r.Quantity);
  if (r.Quantity) p.Encode4(r.InventorySN!);
  return p;
}
export function MakeSpecialItemPacket(input: SpecialItemRequest): CSendPacket {
  const r = NormalizeSpecialItemRequest(input);
  // Native NEVER appends InventorySN; it echoes all THREE trailing BYTEs.
  return new CSendPacket(ServerResponse.BomberEvent)
    .Encode1(r.Slot)
    .Encode2(r.X)
    .Encode2(r.Y)
    .Encode1(r.Opaque)
    .Encode1(r.ItemIndex)
    .Encode1(r.Quantity);
}
/** Canonical SQL snapshot. No wall-clock expiry filtering: the native handler
 * only looks up an already resident SN, even after its load-time expiry passes.
 * This does NOT authorize an inventory SN/resource-index relationship. */
export function CopySpecialItemInventory(
  input: Readonly<_USERINVENTORY> | Readonly<UserInventory>,
  text: CTextCodec = DefaultTextCodec,
): Readonly<_USERINVENTORY> {
  if (input && IsUserInventory(input))
    throw new CProtocolError("Native inventory persistence is not connected");
  if (
    !input ||
    typeof input.ID !== "string" ||
    typeof input.Verbose !== "string"
  )
    throw new CProtocolError("Missing inventory snapshot/string");
  integer(input.SN, IntegerRange.Int32Maximum);
  integer(input.ItemID, IntegerRange.UInt32Maximum);
  integer(input.Slot, IntegerRange.UInt8Maximum);
  integer(input.Amount, IntegerRange.Int32Maximum);
  integer(input.ExpireDate, IntegerRange.UInt32Maximum);
  integer(input.CreatedAt, IntegerRange.UInt32Maximum);
  if (
    !input.SN ||
    !input.Amount ||
    text.Encode(input.Verbose).length > RuntimePolicy.MaxInventoryVerboseBytes
  )
    throw new CProtocolError("Invalid resident inventory amount/metadata");
  return Object.freeze({
    SN: input.SN,
    ID: NormalizeID(input.ID),
    ItemID: input.ItemID,
    Slot: input.Slot,
    Amount: input.Amount,
    ExpireDate: input.ExpireDate,
    Verbose: input.Verbose,
    CreatedAt: input.CreatedAt,
  });
}
