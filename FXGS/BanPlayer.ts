import { CProtocolError } from "../Common/CProtocolError.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import {
  BanChiefRule,
  BanPlayerRule,
  CipherDegree,
  IntegerRange,
  SessionLimit,
  UserCount,
} from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";

/** MODERN, immutable observations of native +20 actors / +780 votes / +828
 * target. SocketKey is a capture-local label, NOT a live socket or capability.
 * These plans NEVER install a vote, remove a user or grant financial replay. */
export interface BanPlayerActor {
  readonly SerialNo: number;
  readonly SocketKey: number;
  readonly Self: number;
  readonly Name: string;
}
export interface BanPlayerObservation {
  readonly Actors: readonly (Readonly<BanPlayerActor> | null)[];
  readonly Votes: readonly number[];
  readonly TargetSerialNo: number;
  readonly ChiefSlot: number;
}
export interface BanPlayerVoteState {
  readonly Votes: readonly number[];
  readonly TargetSerialNo: number;
}
export type BanPlayerMessage =
  | {
      readonly Kind: "Question";
      readonly TargetSerialNo: number;
      readonly Name: string;
    }
  | { readonly Kind: "Result"; readonly Code: 0 | 1 | 4 }
  | {
      readonly Kind: "Result";
      readonly Code: 2 | 3 | 5;
      readonly Name: string;
    };
export interface BanPlayerPublication {
  readonly Message: Readonly<BanPlayerMessage>;
  /** Question113 preserves native CONSECUTIVE-only socket suppression. */
  readonly Recipients: readonly number[];
}
export interface BanPlayerCounts {
  readonly Total: number;
  readonly Yes: number;
  readonly No: number;
  readonly Pending: number;
  readonly Other: number;
}
export interface BanPlayerPlan {
  /** Policy state immediately BEFORE any described table destruction. Native
   * DeleteUser additionally clears departing votes; this is NOT a final roster. */
  readonly After: Readonly<BanPlayerVoteState>;
  /** Data describing native DestroyPlayer(socket, TRUE) then pool4, BEFORE all
   * Messages. No callback/lease/live user pointer or executable authority. */
  readonly Eject: Readonly<{
    Slot: number;
    SocketKey: number;
    IncludeSelf: true;
    NativePoolType: 4;
  }> | null;
  readonly Messages: readonly Readonly<BanPlayerPublication>[];
  readonly DeferCalls: number;
  readonly Counts: Readonly<BanPlayerCounts> | null;
}
export type BanPlayerFunctionalQuery = (
  slot: number,
  attribute: string,
) => boolean;

function dword(value: number): boolean {
  return (
    Number.isInteger(value) && value >= 0 && value <= IntegerRange.UInt32Maximum
  );
}
/** Capture EVERY primitive before querying functional items / invoking codecs.
 * Structural hardening is modern; it is not the native corruption/UB oracle. */
export function CaptureBanPlayerObservation(
  source: BanPlayerObservation,
): Readonly<BanPlayerObservation> {
  const { Actors, Votes, TargetSerialNo, ChiefSlot } = source;
  if (
    !Array.isArray(Actors) ||
    Actors.length !== SessionLimit.Players ||
    !Array.isArray(Votes) ||
    Votes.length !== SessionLimit.Players ||
    !dword(TargetSerialNo) ||
    !Number.isInteger(ChiefSlot) ||
    ChiefSlot < IntegerRange.Int32Minimum ||
    ChiefSlot > IntegerRange.Int32Maximum
  )
    throw new CProtocolError("Invalid ban-player observation");
  const actors = Array.from(Actors, (actor) => {
    if (actor === null) return null;
    if (!actor || typeof actor !== "object")
      throw new CProtocolError("Invalid ban-player actor");
    const { SerialNo, SocketKey, Self, Name } = actor;
    if (
      !dword(SerialNo) ||
      SerialNo === 0 ||
      !Number.isInteger(SocketKey) ||
      SocketKey < 0 ||
      SocketKey >= SessionLimit.Players ||
      !Number.isInteger(Self) ||
      Self < 0 ||
      Self >= UserCount.Maximum ||
      typeof Name !== "string"
    )
      throw new CProtocolError("Invalid ban-player actor");
    return Object.freeze({ SerialNo, SocketKey, Self, Name });
  });
  const votes = Array.from(Votes);
  if (
    votes.some((v) => !dword(v)) ||
    new Set(actors.flatMap((a) => (a ? [a.SerialNo] : []))).size !==
      actors.filter(Boolean).length
  )
    throw new CProtocolError("Invalid ban-player votes/serials");
  for (const key of new Set(actors.flatMap((a) => (a ? [a.SocketKey] : [])))) {
    const locals = actors
      .filter((a) => a?.SocketKey === key)
      .map((a) => a!.Self)
      .sort((a, b) => a - b);
    if (
      locals.length < UserCount.Minimum ||
      locals.length > UserCount.Maximum ||
      locals.some((self, i) => self !== i)
    )
      throw new CProtocolError("Invalid ban-player local group");
  }
  return Object.freeze({
    Actors: Object.freeze(actors),
    Votes: Object.freeze(votes),
    TargetSerialNo,
    ChiefSlot,
  });
}
function group(s: BanPlayerObservation, socket: number): number[] {
  return s.Actors.map((a, slot) => ({ a, slot }))
    .filter(({ a }) => a?.SocketKey === socket)
    .sort((a, b) => a.a!.Self - b.a!.Self)
    .map((a) => a.slot);
}
function sockets(s: BanPlayerObservation, excluded?: number): number[] {
  return [
    ...new Set(
      s.Actors.flatMap((a) =>
        a && a.SocketKey !== excluded ? [a.SocketKey] : [],
      ),
    ),
  ];
}
function result(code: 0 | 1 | 2 | 3 | 4 | 5, name?: string): BanPlayerMessage {
  return code === 2 || code === 3 || code === 5
    ? { Kind: "Result", Code: code, Name: name! }
    : { Kind: "Result", Code: code };
}
function finish(
  s: BanPlayerObservation,
  target = s.TargetSerialNo,
  votes: readonly number[] = s.Votes,
  messages: readonly BanPlayerPublication[] = [],
  eject: BanPlayerPlan["Eject"] = null,
  deferCalls = 0,
  counts: BanPlayerCounts | null = null,
): Readonly<BanPlayerPlan> {
  return Object.freeze({
    After: Object.freeze({
      TargetSerialNo: target,
      Votes: Object.freeze([...votes]),
    }),
    Eject: eject ? Object.freeze({ ...eject }) : null,
    Messages: Object.freeze(
      messages.map((p) =>
        Object.freeze({
          Message: Object.freeze({ ...p.Message }),
          Recipients: Object.freeze([...p.Recipients]),
        }),
      ),
    ),
    DeferCalls: deferCalls,
    Counts: counts ? Object.freeze({ ...counts }) : null,
  });
}
function ejectAt(
  s: BanPlayerObservation,
  slot: number,
): NonNullable<BanPlayerPlan["Eject"]> {
  return {
    Slot: slot,
    SocketKey: s.Actors[slot]!.SocketKey,
    IncludeSelf: true,
    NativePoolType: 4,
  };
}
/**00424F78: counts LOCALS with nonzero votes, not one ballot per socket.
 * Unknown nonzero DWORDs count in Total but not Yes/No. No invented timeout. */
function defer(s: BanPlayerObservation): Readonly<BanPlayerPlan> {
  const counts = { Total: 0, Yes: 0, No: 0, Pending: 0, Other: 0 };
  let target = SessionLimit.NoSlot as number;
  s.Actors.forEach((a, slot) => {
    if (!a) return;
    if (a.SerialNo === s.TargetSerialNo) target = slot;
    const vote = s.Votes[slot]!;
    if (!vote) return;
    counts.Total++;
    if (vote === BanPlayerRule.Yes) counts.Yes++;
    else if (vote === BanPlayerRule.No) counts.No++;
    else if (vote === BanPlayerRule.Pending) counts.Pending++;
    else counts.Other++;
  });
  if (target < 0)
    return finish(
      s,
      0,
      s.Votes,
      [
        {
          Message: result(BanPlayerRule.MissingOrImmediate),
          Recipients: sockets(s),
        },
      ],
      null,
      1,
      counts,
    );
  if (2 * counts.Yes > counts.Total) {
    const eject = ejectAt(s, target);
    return finish(
      s,
      0,
      s.Votes,
      [
        {
          Message: result(BanPlayerRule.Passed, s.Actors[target]!.Name),
          Recipients: sockets(s, eject.SocketKey),
        },
      ],
      eject,
      1,
      counts,
    );
  }
  if (2 * counts.No >= counts.Total || counts.Yes + counts.No >= counts.Total)
    return finish(
      s,
      0,
      s.Votes,
      [
        {
          Message: result(BanPlayerRule.Failed, s.Actors[target]!.Name),
          Recipients: sockets(s),
        },
      ],
      null,
      1,
      counts,
    );
  return finish(s, s.TargetSerialNo, s.Votes, [], null, 1, counts);
}
export function PlanDeferBanPlayer(
  source: BanPlayerObservation,
): Readonly<BanPlayerPlan> {
  return defer(CaptureBanPlayerObservation(source));
}
/**00424A3B. Authority21 of CClientSocket00406C66 is a zero stub in THIS
 * build: it cannot bypass requested-immediate, functional items or voting. */
export function PlanHostAskBanPlayer(
  source: BanPlayerObservation,
  sender: number,
  request: Readonly<{ TargetSerialNo: number; Immediate: number }>,
  hasFunctional: BanPlayerFunctionalQuery,
): Readonly<BanPlayerPlan> {
  const s = CaptureBanPlayerObservation(source),
    chief = s.Actors[s.ChiefSlot];
  if (!chief || chief.SocketKey !== sender)
    throw new CProtocolError("Non-chief ban-player request");
  // Native busy branch does not decode/read ANY request fields.
  if (s.TargetSerialNo)
    return finish(s, s.TargetSerialNo, s.Votes, [
      { Message: result(BanPlayerRule.Busy), Recipients: [sender] },
    ]);
  const { TargetSerialNo, Immediate } = request;
  if (
    !dword(TargetSerialNo) ||
    !Number.isInteger(Immediate) ||
    Immediate < 0 ||
    Immediate > IntegerRange.UInt8Maximum
  )
    throw new CProtocolError("Invalid ban-player request");
  if (
    s.Actors.some(
      (a) => a?.SocketKey === sender && a.SerialNo === TargetSerialNo,
    )
  )
    throw new CProtocolError("Chief cannot ban his own local group");
  const votes: number[] = s.Actors.map((a) =>
      a && a.SerialNo !== TargetSerialNo
        ? BanPlayerRule.Pending
        : BanPlayerRule.Excluded,
    ),
    target = s.Actors.findIndex((a) => a?.SerialNo === TargetSerialNo);
  if (target < 0) return finish(s, 0, votes);
  const victim = s.Actors[target]!,
    after = { ...s, Votes: votes };
  if (
    Immediate !== 0 &&
    group(s, sender).some((slot) =>
      hasFunctional(slot, BanChiefRule.SuperChiefAttribute),
    )
  ) {
    const eject = ejectAt(s, target);
    return finish(
      s,
      0,
      votes,
      [
        {
          Message: result(BanPlayerRule.MissingOrImmediate),
          Recipients: sockets(s, eject.SocketKey),
        },
      ],
      eject,
    );
  }
  // SuperChief immediate success precedes / BYPASSES BanReflex.
  if (
    group(s, victim.SocketKey).some((slot) =>
      hasFunctional(slot, BanPlayerRule.BanReflexAttribute),
    )
  ) {
    const eject = ejectAt(s, s.ChiefSlot);
    return finish(
      s,
      0,
      votes,
      [
        {
          Message: result(BanPlayerRule.Reflected, chief.Name),
          Recipients: sockets(s, eject.SocketKey),
        },
      ],
      eject,
    );
  }
  for (const slot of group(s, victim.SocketKey))
    votes[slot] = BanPlayerRule.Excluded;
  for (const slot of group(s, sender)) votes[slot] = BanPlayerRule.Yes;
  const decision = defer({ ...after, TargetSerialNo }),
    messages: BanPlayerPublication[] = [...decision.Messages];
  if (decision.After.TargetSerialNo !== 0) {
    const recipients: number[] = [];
    let previous: number | undefined;
    s.Actors.forEach((a) => {
      if (
        !a ||
        a.SocketKey === sender ||
        a.SocketKey === victim.SocketKey ||
        a.SerialNo === TargetSerialNo
      )
        return;
      if (a.SocketKey !== previous) {
        recipients.push(a.SocketKey);
        previous = a.SocketKey;
      }
    });
    messages.push(
      {
        Message: { Kind: "Question", TargetSerialNo, Name: victim.Name },
        Recipients: recipients,
      },
      { Message: result(BanPlayerRule.Started), Recipients: [sender] },
    );
  }
  return finish(
    s,
    decision.After.TargetSerialNo,
    decision.After.Votes,
    messages,
    decision.Eject,
    decision.DeferCalls,
    decision.Counts,
  );
}
/**00423C70: unanswered locals are changed in SELF order; the FIRST nonpending
 * local returns early WITHOUT Defer, preserving any already-written prefix.
 * Native no-active/wrong-serial paths must not read Answer. */
export function PlanRespondToBanPlayer(
  source: BanPlayerObservation,
  sender: number,
  response: Readonly<{ TargetSerialNo: number; Answer: number }>,
): Readonly<BanPlayerPlan> {
  const s = CaptureBanPlayerObservation(source);
  if (!s.TargetSerialNo) return finish(s);
  const serial = response.TargetSerialNo;
  if (!dword(serial))
    throw new CProtocolError("Invalid ban-player response serial");
  if (serial !== s.TargetSerialNo) return finish(s);
  const answer = response.Answer;
  if (
    !Number.isInteger(answer) ||
    answer < 0 ||
    answer > IntegerRange.UInt8Maximum
  )
    throw new CProtocolError("Invalid ban-player answer");
  const locals = group(s, sender);
  if (!locals.length)
    throw new CProtocolError("Ban-player response outside room");
  const votes = [...s.Votes];
  for (const slot of locals) {
    if (votes[slot] !== BanPlayerRule.Pending)
      return finish(s, s.TargetSerialNo, votes);
    votes[slot] = answer !== 0 ? BanPlayerRule.Yes : BanPlayerRule.No;
  }
  return defer({ ...s, Votes: votes });
}
export interface BanPlayerDepartureObservation {
  readonly Remaining: Readonly<BanPlayerObservation>;
  readonly Decision: Readonly<BanPlayerPlan> | null;
  /** CBanChief::Init calls attributable to original group plus an elected
   * chief removed by the deferred tally. Observation ONLY, not a clock hook. */
  readonly ChiefInitializations: number;
}
/**00423DB6 /0041BB4E..0041BBC4, ordinary first-occupied chief selection.
 * Predict AFTER deletion of one whole group, then the synchronous vote check.
 * No ghost/sync/IDs/pool/table effects are executed or claimed by this model. */
export function PlanBanPlayerAfterDeparture(
  source: BanPlayerObservation,
  departing: number,
): Readonly<BanPlayerDepartureObservation> {
  const s = CaptureBanPlayerObservation(source),
    locals = group(s, departing);
  if (!locals.length)
    throw new CProtocolError("Ban-player departure outside room");
  const chiefLeft = s.Actors[s.ChiefSlot]?.SocketKey === departing,
    actors = s.Actors.map((a) => (a?.SocketKey === departing ? null : a)),
    votes = [...s.Votes];
  for (const slot of locals) votes[slot] = BanPlayerRule.Excluded;
  let chief = s.ChiefSlot;
  if (chiefLeft) {
    chief = actors.findIndex(Boolean);
    if (chief < 0) chief = SessionLimit.NoEligibleChief;
  }
  const remaining = CaptureBanPlayerObservation({
      ...s,
      Actors: actors,
      Votes: votes,
      ChiefSlot: chief,
    }),
    decision = s.TargetSerialNo ? defer(remaining) : null;
  return Object.freeze({
    Remaining: remaining,
    Decision: decision,
    ChiefInitializations:
      Number(chiefLeft) +
      Number(
        !!decision?.Eject &&
          remaining.Actors[chief]?.SocketKey === decision.Eject.SocketKey,
      ),
  });
}
/** Native113/114 scalar bodies ONLY. Prepares bytes, never transmits, installs
 * votes, invokes table callbacks, invents an ACK or authorizes a stored plan. */
export function MakeBanPlayerPacket(
  source: BanPlayerMessage,
  text: CTextCodec,
  cipher: CipherDegree = CipherDegree.CRC8,
): CSendPacket {
  if (source.Kind === "Question") {
    const { TargetSerialNo, Name } = source;
    if (!dword(TargetSerialNo) || typeof Name !== "string")
      throw new CProtocolError("Invalid ban question");
    return new CSendPacket(ServerResponse.BanPlayer, cipher, text)
      .Encode4(TargetSerialNo)
      .EncodeStr(Name);
  }
  if (source.Kind !== "Result")
    throw new CProtocolError("Invalid ban message kind");
  const { Code } = source;
  if (!Number.isInteger(Code) || Code < 0 || Code > BanPlayerRule.Reflected)
    throw new CProtocolError("Invalid ban result");
  const packet = new CSendPacket(
    ServerResponse.BanPlayerResult,
    cipher,
    text,
  ).Encode1(Code);
  if (Code === 2 || Code === 3 || Code === 5) {
    const name = (source as { Name: string }).Name;
    if (typeof name !== "string")
      throw new CProtocolError("Missing ban result name");
    packet.EncodeStr(name);
  }
  return packet;
}
