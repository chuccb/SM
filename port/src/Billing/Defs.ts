/** Local replacement policy, NOT recovered DigiQ server internals. */
import { USER_INVENTORY_LOAD_LIMIT } from "../lib/Item.ts";

export const LOCAL_BILLING_MODE_KEY = "LocalBillingMode";
export const LOCAL_BILLING_MODE = "inventory-v1";
export const BILLING_GAME = 4;
// Conservative local cap from GS InitUserInventory 0040AF55; all DB rows count.
export const MAX_LOCAL_INVENTORY_ROWS = USER_INVENTORY_LOAD_LIMIT;
export const MAX_CASH = 0x7fffffff;
export const RESERVATION_MS = 120_000;
export const AUTHORIZATION_MS = 60 * 60_000;
export const LOCAL_BILLING_RETRY_MS = 2_000;
export const MAX_BILLING_FRAME = 4096;
export const MAX_BILLING_PEERS = 16;
export const BILLING_IDLE_SECONDS = 15 * 60;
export const BILLING_ERROR = {
  authorization: "Please authorize with your game account and password.",
  funds: "Not enough billing points.",
  product: "This product is unavailable for local billing.",
  pending: "Another purchase is still pending.",
  expired: "Purchase expired or was cancelled. No points were charged.",
  unavailable: "Billing is unavailable. Please try again.",
  unsupported: "This operation is not supported by local billing.",
} as const;

export class BillingError extends Error {}
export interface PurchaseRequest {
  world: number;
  name: string;
  serial: number;
  stock: number;
  price: number;
}
export interface BillingConfig {
  enabled: boolean;
  host: "127.0.0.1";
  port: number;
}
