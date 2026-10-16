import { CProtocolError } from "../Common/CProtocolError.ts";
import { NormalizeID } from "../Common/CIDCompare.ts";
import {
  IntegerRange,
  UserCount,
  UserFieldSize,
} from "../Common/OfficialValues.ts";

export interface ConnectionIdentity {
  readonly ID: string;
  readonly GlobalSerialNo: number;
  readonly GuildSn: number;
}
declare const authorizationBrand: unique symbol;
/** Modern IN-PROCESS capability, not an original Center packet, bearer token,
 * financial authorization, native procedure ACK or durable recovery receipt.
 * Only the issuing CCenterServer's private WeakMap makes an object valid. */
export interface ConnectionAuthorization {
  readonly [authorizationBrand]: true;
  readonly UserCount: number;
  readonly Expires: number;
}
/** Latch ALL supplied primitives once before any clock/database/codec callback.
 * Native client parsing already bounds encoded IDs; this interface additionally
 * refuses malformed direct trusted calls and duplicate serial/ASCII IDs. */
export function CaptureConnectionIdentities(
  source: readonly ConnectionIdentity[],
): readonly Readonly<ConnectionIdentity>[] {
  if (
    !Array.isArray(source) ||
    source.length < UserCount.Minimum ||
    source.length > UserCount.Maximum
  )
    throw new CProtocolError("Invalid establishment group");
  const rows = [...source].map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new CProtocolError("Invalid transfer identity", "invalid-transfer");
    const { ID, GlobalSerialNo, GuildSn } = raw;
    if (
      typeof ID !== "string" ||
      !ID.length ||
      ID.length > UserFieldSize.ID ||
      /[\x00-\x1f\x7f]/.test(ID) ||
      ![GlobalSerialNo, GuildSn].every(
        (n) => Number.isInteger(n) && n >= 0 && n <= IntegerRange.UInt32Maximum,
      )
    )
      throw new CProtocolError("Invalid transfer identity", "invalid-transfer");
    return Object.freeze({ ID, GlobalSerialNo, GuildSn });
  });
  if (
    new Set(rows.map((r) => NormalizeID(r.ID))).size !== rows.length ||
    new Set(rows.map((r) => r.GlobalSerialNo)).size !== rows.length
  )
    throw new CProtocolError("Duplicate transfer identity", "invalid-transfer");
  return Object.freeze(rows);
}
