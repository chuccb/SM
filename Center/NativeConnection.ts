import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  CenterConnectionRule,
  ChannelType,
  IntegerRange,
  ServerType,
} from "../Common/OfficialValues.ts";

/** READ-ONLY NATIVE Center CUser field roles. Not the deployment's shared
 * Common/CUser, an authorization lease, actual pool/list/counter or Center TCP.
 * Authencode is Center DWORD+56, NOT FXGS BYTE+2004 / legacy TicketDate. */
export interface NativeCenterConnectionState {
  readonly SetFree: number;
  readonly Connecting: number;
  readonly ServerType: number;
  readonly ServerIndex: number;
  readonly ConnectingTick: number;
  readonly Authencode: number;
}
export interface NativeCenterConnectionTarget {
  readonly Type: number;
  readonly Index: number;
  readonly RegisteredCount: number;
  readonly Exists: boolean;
  readonly Connected: boolean;
  readonly ChannelType: number;
}
export interface NativeCenterConnectionPlan {
  readonly Result: 0 | 1 | 2;
  readonly State: Readonly<NativeCenterConnectionState>;
  readonly ClockReads: number;
}
function dword(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < IntegerRange.Int32Minimum ||
    value > IntegerRange.UInt32Maximum
  )
    throw new CProtocolError("Invalid native Center DWORD");
  return value >>> 0;
}
function byte(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > IntegerRange.UInt8Maximum
  )
    throw new CProtocolError("Invalid native Center BYTE");
  return value;
}
function fields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CProtocolError("Invalid native Center observation");
  const r = input as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, r[k]]));
}
export function CopyNativeCenterConnectionState(
  input: unknown,
): Readonly<NativeCenterConnectionState> {
  const r = fields(input, [
    "SetFree",
    "Connecting",
    "ServerType",
    "ServerIndex",
    "ConnectingTick",
    "Authencode",
  ]);
  return Object.freeze({
    SetFree: dword(r.SetFree),
    Connecting: dword(r.Connecting),
    ServerType: byte(r.ServerType),
    ServerIndex: dword(r.ServerIndex) | 0,
    ConnectingTick: dword(r.ConnectingTick),
    Authencode: dword(r.Authencode),
  });
}
function target(input: unknown): Readonly<NativeCenterConnectionTarget> {
  const r = fields(input, [
    "Type",
    "Index",
    "RegisteredCount",
    "Exists",
    "Connected",
    "ChannelType",
  ]);
  if (typeof r.Exists !== "boolean" || typeof r.Connected !== "boolean")
    throw new CProtocolError("Invalid native Center server observation");
  return Object.freeze({
    Type: byte(r.Type),
    Index: dword(r.Index) | 0,
    RegisteredCount: dword(r.RegisteredCount) | 0,
    Exists: r.Exists,
    Connected: r.Connected,
    ChannelType: byte(r.ChannelType),
  });
}
function clock(read: () => number): () => number {
  if (typeof read !== "function")
    throw new CProtocolError("Native Center requires explicit tick source");
  return () => dword(read());
}
/**004153B0: pure projection of the original CHECK, which ALREADY writes the
 * connecting flag/tick on success. Server index does not move until the
 * SEPARATE SetConnectingToSvr step. This is not modern non-consuming lease logic. */
export function PlanCheckConnectingToSvr(
  source: Readonly<NativeCenterConnectionState>,
  server: Readonly<NativeCenterConnectionTarget>,
  readTick: () => number,
): NativeCenterConnectionPlan {
  const state = CopyNativeCenterConnectionState(source),
    t = target(server),
    read = clock(readTick);
  const result = (Result: 0 | 1 | 2, State = state, ClockReads = 0) =>
    Object.freeze({ Result, State, ClockReads });
  if (
    state.SetFree !== 0 ||
    state.Connecting !== 0 ||
    (state.ServerType === t.Type && state.ServerIndex === t.Index)
  )
    return result(0);
  if (
    (t.Type !== ServerType.Login &&
      t.Type !== ServerType.FXGame &&
      t.Type !== ServerType.FXShop) ||
    t.Index < 0 ||
    t.Index >= t.RegisteredCount ||
    !t.Exists ||
    !t.Connected
  )
    return result(0);
  if (
    t.ChannelType === ChannelType.Premium &&
    state.Authencode !== CenterConnectionRule.PremiumAuthencode
  )
    return result(2);
  const tick = read();
  return result(
    1,
    Object.freeze({ ...state, Connecting: 1, ConnectingTick: tick }),
    1,
  );
}
/**00415540/00415340: STATE ONLY; no actual server IncConn/DecConn or connecting
 * list insertion. Caller supplies observed indices; do NOT grant authorization. */
export function PlanSetConnectingToSvr(
  source: Readonly<NativeCenterConnectionState>,
  type: number,
  index: number,
): Readonly<NativeCenterConnectionState> {
  const state = CopyNativeCenterConnectionState(source),
    Type = byte(type),
    Index = dword(index) | 0;
  return Object.freeze({ ...state, ServerType: Type, ServerIndex: Index });
}
/**00415570 checks free/connecting + exact type/index ONLY. No timeout or list
 * consumption here; group/name checks live in the original caller instead. */
export function CheckNativeConnectionEstablished(
  source: Readonly<NativeCenterConnectionState>,
  type: number,
  index: number,
): boolean {
  const state = CopyNativeCenterConnectionState(source),
    Type = byte(type),
    Index = dword(index) | 0;
  return (
    state.SetFree === 0 &&
    state.Connecting !== 0 &&
    state.ServerType === Type &&
    state.ServerIndex === Index
  );
}
/**00415120 clears connecting flag ONLY, not tick/type/index/auth. */
export function PlanSetConnectionEstablished(
  source: Readonly<NativeCenterConnectionState>,
): Readonly<NativeCenterConnectionState> {
  return Object.freeze({
    ...CopyNativeCenterConnectionState(source),
    Connecting: 0,
  });
}
/**004155F0 unsigned tick subtraction, STRICT >17500; original SetFree is
 * one-shot and resets server index only on FIRST free. No host/Win32 call. */
export function PlanDeferDisconnectTimeout(
  source: Readonly<NativeCenterConnectionState>,
  readTick: () => number,
): NativeCenterConnectionPlan {
  const state = CopyNativeCenterConnectionState(source),
    read = clock(readTick);
  if (state.Connecting === 0)
    return Object.freeze({ Result: 0, State: state, ClockReads: 0 });
  const elapsed = (read() - state.ConnectingTick) >>> 0,
    expired = elapsed > CenterConnectionRule.NativeConnectingTimeoutMs;
  return Object.freeze({
    Result: expired ? 1 : 0,
    State:
      expired && state.SetFree === 0
        ? Object.freeze({
            ...state,
            SetFree: 1,
            ServerIndex: CenterConnectionRule.NoServerIndex,
          })
        : state,
    ClockReads: 1,
  });
}
