import { expect, test } from "bun:test";
import { CClientSocket } from "../Common/CClientSocket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import {
  CipherDegree,
  BanChiefRule,
  BanPlayerRule,
} from "../Common/OfficialValues.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import {
  CaptureBanPlayerObservation,
  PlanHostAskBanPlayer,
  PlanRespondToBanPlayer,
  PlanDeferBanPlayer,
  PlanBanPlayerAfterDeparture,
  MakeBanPlayerPacket,
  type BanPlayerPlan,
  type BanPlayerMessage,
} from "../FXGS/BanPlayer.ts";
import { Received } from "./helpers/Clients.ts";
import {
  BanPlayerVectors as vectors,
  BanObservation,
  WithVotes,
} from "./helpers/BanPlayer.ts";

const text = new CTextCodec();
function host(
  o = BanObservation(),
  target = o.Actors[1]!.SerialNo,
  immediate = 0,
  query = (_slot: number, _attr: string) => false,
) {
  return PlanHostAskBanPlayer(
    o,
    0,
    { TargetSerialNo: target, Immediate: immediate },
    query,
  );
}
function codes(p: BanPlayerPlan) {
  return p.Messages.map((m) =>
    m.Message.Kind === "Question" ? 113 : m.Message.Code,
  );
}

test("25th manual vote policy model:68 fixed source anchors include BOTH zero-authority stubs,113/114,weighted strict majority and post-deletion vtable144; supplied PE read-only", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(68);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(vectors.Model).toContain("NOT original execution");
});

test("ALL2625 independent C++ host/respond/defer/departure cases: primitive After,local-prefix/functional read order,recipient duplicates,removal INTENT,chief-reset observations and exact113/114 plain/scalar bodies", () => {
  expect(vectors.CaseCount).toBe(2625);
  expect(vectors.Cases).toHaveLength(2625);
  const actions = new Set<string>();
  let cascades = 0,
    doubled = 0,
    prefix = 0;
  for (const c of vectors.Cases) {
    actions.add(c.Action);
    const input = structuredClone(c.Observation),
      original = JSON.stringify(input),
      queries: { Slot: number; Attribute: string }[] = [];
    const actual =
      c.Action === "Host"
        ? PlanHostAskBanPlayer(
            input,
            c.Sender,
            { TargetSerialNo: c.SerialNo, Immediate: c.Value },
            (Slot, Attribute) => {
              queries.push({ Slot, Attribute });
              return !!(
                (Attribute === BanChiefRule.SuperChiefAttribute
                  ? c.SuperMask
                  : c.ReflexMask) &
                (1 << Slot)
              );
            },
          )
        : c.Action === "Respond"
          ? PlanRespondToBanPlayer(input, c.Sender, {
              TargetSerialNo: c.SerialNo,
              Answer: c.Value,
            })
          : c.Action === "Defer"
            ? PlanDeferBanPlayer(input)
            : PlanBanPlayerAfterDeparture(input, c.Sender);
    expect(actual).toEqual(c.Expected);
    expect(queries).toEqual(c.FunctionalCalls);
    expect(JSON.stringify(input)).toBe(original);
    expect(Object.isFrozen(actual)).toBe(true);
    const plan = "Decision" in actual ? actual.Decision : actual;
    if ("ChiefInitializations" in actual && actual.ChiefInitializations === 2)
      cascades++;
    if (plan) {
      expect(Object.isFrozen(plan.After)).toBe(true);
      expect(Object.isFrozen(plan.After.Votes)).toBe(true);
      expect(Object.isFrozen(plan.Messages)).toBe(true);
      for (const [i, p] of plan.Messages.entries()) {
        expect(Object.isFrozen(p)).toBe(true);
        expect(Object.isFrozen(p.Message)).toBe(true);
        expect(Object.isFrozen(p.Recipients)).toBe(true);
        const scalar = MakeBanPlayerPacket(p.Message, text),
          plain = MakeBanPlayerPacket(p.Message, text, CipherDegree.None);
        expect(scalar.GetBuffer().toString("hex")).toBe(c.Bodies.Scalar[i]!);
        expect(plain.GetBuffer().toString("hex")).toBe(c.Bodies.Plain[i]!);
        expect(scalar.GetCipherDegree()).toBe(CipherDegree.CRC8);
        const decoded = Received(scalar);
        expect(decoded.Decode1()).toBe(
          p.Message.Kind === "Question" ? 113 : 114,
        );
        if (p.Message.Kind === "Question") {
          expect(decoded.Decode4()).toBe(p.Message.TargetSerialNo);
          expect(decoded.DecodeStr()).toBe(p.Message.Name);
        } else {
          expect(decoded.Decode1()).toBe(p.Message.Code);
          if ("Name" in p.Message)
            expect(decoded.DecodeStr()).toBe(p.Message.Name);
        }
        decoded.AssertEnd();
        if (new Set(p.Recipients).size !== p.Recipients.length) doubled++;
      }
      if (
        c.Action === "Respond" &&
        !plan.DeferCalls &&
        JSON.stringify(plan.After.Votes) !== JSON.stringify(c.Observation.Votes)
      )
        prefix++;
    }
  }
  expect([...actions].sort()).toEqual([
    "Defer",
    "Departure",
    "Host",
    "Respond",
  ]);
  expect(cascades).toBeGreaterThan(0);
  expect(doubled).toBeGreaterThan(0);
  expect(prefix).toBeGreaterThan(0);
});

test("native CClientSocket.HasAuthority00406C66 ignores this AND every argument: no SQLite21/premium/admin permission inference", () => {
  const poison = new Proxy(
    {},
    {
      get() {
        throw new Error("MUST NOT READ this");
      },
    },
  );
  for (const param of [
    -2147483648,
    -1,
    ...Array.from({ length: 256 }, (_, i) => i),
    2147483647,
    4294967295,
  ])
    expect(
      CClientSocket.prototype.HasAuthority.call(poison as CClientSocket, param),
    ).toBe(0);
});

test("host auto-Yes counts BOTH locals; with only two peer groups native tally may pass immediately, with NO113 or started0 ACK", () => {
  const o = BanObservation([2, 2]);
  const p = host(o, o.Actors[3]!.SerialNo);
  expect(p.After.Votes).toEqual([2, 2, 0, 0, 0, 0, 0, 0]);
  expect(p.After.TargetSerialNo).toBe(0);
  expect(codes(p)).toEqual([2]);
  expect(p.Counts).toEqual({ Total: 2, Yes: 2, No: 0, Pending: 0, Other: 0 });
  expect(p.Eject).toEqual({
    Slot: 3,
    SocketKey: 1,
    IncludeSelf: true,
    NativePoolType: 4,
  });
  expect(p.Messages[0]!.Recipients).toEqual([0]);
});

test("strict Yes majority vs No tie: 2*Yes==Total remains pending until No tie/all-answered; target locals are excluded", () => {
  const o = BanObservation();
  const pending = PlanDeferBanPlayer(WithVotes(o, [2, 0, 1, 0]));
  expect(pending.After.TargetSerialNo).not.toBe(0);
  expect(pending.Messages).toEqual([]);
  const failed = PlanDeferBanPlayer(WithVotes(o, [2, 0, 3, 0]));
  expect(codes(failed)).toEqual([3]);
  expect(failed.Eject).toBeNull();
  const passed = PlanDeferBanPlayer(WithVotes(o, [2, 0, 2, 1]));
  expect(codes(passed)).toEqual([2]);
  expect(passed.Messages[0]!.Recipients).toEqual([0, 2, 3]);
  expect(host(o).After.Votes).toEqual([2, 0, 1, 1, 0, 0, 0, 0]);
});

test("missing target resets all occupied votes to1 then target0, emits NOTHING and performs NO functional query; defer-missing is separately114/4", () => {
  const o = BanObservation();
  let calls = 0;
  const p = host(o, 0xffffffff, 255, () => {
    calls++;
    return true;
  });
  expect(calls).toBe(0);
  expect(p.After.Votes).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  expect(p.Messages).toEqual([]);
  expect(p.Eject).toBeNull();
  const d = PlanDeferBanPlayer({ ...o, TargetSerialNo: 0xffffffff });
  expect(codes(d)).toEqual([4]);
  expect(d.Counts!.Total).toBe(0);
});

test("busy target checked before ANY request field, self-check or item query; only chief gets114/1 and previous votes survive", () => {
  const o = WithVotes(BanObservation(), [2, 0, 1, 1]);
  let reads = 0;
  const request = {
    get TargetSerialNo(): number {
      reads++;
      throw new Error("not reached");
    },
    get Immediate(): number {
      reads++;
      throw new Error("not reached");
    },
  };
  const p = PlanHostAskBanPlayer(o, 0, request, () => {
    throw new Error("not reached query");
  });
  expect(reads).toBe(0);
  expect(codes(p)).toEqual([1]);
  expect(p.After).toEqual({ Votes: o.Votes, TargetSerialNo: o.TargetSerialNo });
  expect(p.Messages[0]!.Recipients).toEqual([0]);
  expect(() => PlanHostAskBanPlayer(o, 2, request, () => false)).toThrow(
    "Non-chief",
  );
});

test("chief cannot target ANY own local serial, including secondary, before votes change or items are read", () => {
  const o = BanObservation([2, 1, 1]);
  for (const slot of [0, 1])
    expect(() =>
      host(o, o.Actors[slot]!.SerialNo, 1, () => {
        throw new Error("query after own target");
      }),
    ).toThrow("own local");
  expect(o.Votes).toEqual(Array(8).fill(0));
});

test("SuperChief is conditional on ANY nonzero requested-immediate, queries socket SELF order and successful bypass precedes BanReflex", () => {
  const o = BanObservation([2, 2, 1, 1]),
    calls: string[] = [];
  const p = host(o, o.Actors[3]!.SerialNo, 255, (slot, attr) => {
    calls.push(`${slot}:${attr}`);
    return slot === 1;
  });
  expect(calls).toEqual(["0:Item/SuperChief", "1:Item/SuperChief"]);
  expect(codes(p)).toEqual([4]);
  expect(p.Eject!.SocketKey).toBe(1);
  // Native immediate happens BEFORE target-secondary exclusion / chief auto-Yes.
  expect(p.After.Votes).toEqual([1, 1, 1, 0, 1, 1, 0, 0]);
  calls.length = 0;
  const ordinary = host(o, o.Actors[3]!.SerialNo, 0, (slot, attr) => {
    calls.push(`${slot}:${attr}`);
    return attr.includes("Super");
  });
  expect(calls).toEqual(["2:Item/BanReflex", "3:Item/BanReflex"]);
  expect(codes(ordinary)).toEqual([113, 0]);
});

test("BanReflex can be on secondary target local; removes chief WHOLE socket,114/5 uses actual CHIEF local name not primary", () => {
  const source = BanObservation([2, 2, 1, 1]),
    o = { ...source, ChiefSlot: 1 };
  const p = host(
    o,
    o.Actors[2]!.SerialNo,
    0,
    (slot, attr) => slot === 3 && attr === BanPlayerRule.BanReflexAttribute,
  );
  expect(p.Eject).toEqual({
    Slot: 1,
    SocketKey: 0,
    IncludeSelf: true,
    NativePoolType: 4,
  });
  expect(p.Messages[0]!.Message).toEqual({
    Kind: "Result",
    Code: 5,
    Name: "User1",
  });
  expect(p.Messages[0]!.Recipients).toEqual([1, 2, 3]);
  expect(p.DeferCalls).toBe(0);
});

test("question113 suppresses only CONSECUTIVE eligible socket repeats: interleaved dual-local voters receive A,B,A;114/0 last to chief only", () => {
  const base = BanObservation([1, 1, 2, 2]),
    a = [...base.Actors];
  [a[3], a[4]] = [a[4]!, a[3]!];
  const p = host({ ...base, Actors: a });
  expect(p.Messages[0]!.Recipients).toEqual([2, 3, 2, 3]);
  expect(codes(p)).toEqual([113, 0]);
  expect(p.Messages[1]!.Recipients).toEqual([0]);
  expect(p.Messages[0]!.Message).toEqual({
    Kind: "Question",
    TargetSerialNo: base.Actors[1]!.SerialNo,
    Name: "User1",
  });
});

test("respond reaches serial only when active; reaches Answer only when matching; no false ACK or timeout invented", () => {
  const o = BanObservation();
  let serialReads = 0,
    answerReads = 0;
  const response = {
    get TargetSerialNo(): number {
      serialReads++;
      return 0xffffffff;
    },
    get Answer(): number {
      answerReads++;
      throw new Error("not reached");
    },
  };
  expect(PlanRespondToBanPlayer(o, 2, response).DeferCalls).toBe(0);
  expect([serialReads, answerReads]).toEqual([0, 0]);
  expect(
    PlanRespondToBanPlayer(WithVotes(o, [2, 0, 1, 1]), 2, response).DeferCalls,
  ).toBe(0);
  expect([serialReads, answerReads]).toEqual([1, 0]);
});

test("respond partial prefix is NATIVE: pending first local becomes No/Yes but nonpending SECOND stops WITHOUT tally; duplicate chief/target votes ignored", () => {
  const o = BanObservation([1, 1, 2]),
    current = WithVotes(o, [2, 0, 1, 3]);
  const p = PlanRespondToBanPlayer(current, 2, {
    TargetSerialNo: current.TargetSerialNo,
    Answer: 255,
  });
  expect(p.After.Votes).toEqual([2, 0, 2, 3, 0, 0, 0, 0]);
  expect(p.DeferCalls).toBe(0);
  expect(p.Messages).toEqual([]);
  for (const sender of [0, 1])
    expect(
      PlanRespondToBanPlayer(current, sender, {
        TargetSerialNo: current.TargetSerialNo,
        Answer: 1,
      }).After.Votes,
    ).toEqual(current.Votes);
  const full = PlanRespondToBanPlayer(WithVotes(o, [2, 0, 1, 1]), 2, {
    TargetSerialNo: current.TargetSerialNo,
    Answer: 0,
  });
  expect(codes(full)).toEqual([3]);
  expect(full.DeferCalls).toBe(1);
});

test("unknown nonzero DWORDs affect denominator but cannot masquerade as1/2/3; vacant-slot vote garbage is ignored", () => {
  const o = WithVotes(BanObservation(), [2, 0, 0xffffffff, 1, 2, 2, 2, 2]);
  const p = PlanDeferBanPlayer(o);
  expect(p.Counts).toEqual({ Total: 3, Yes: 1, No: 0, Pending: 1, Other: 1 });
  expect(p.Messages).toEqual([]);
  expect(p.After.Votes).toEqual(o.Votes);
  expect(
    codes(PlanDeferBanPlayer(WithVotes(BanObservation(), Array(8).fill(0)))),
  ).toEqual([3]);
});

test("departure observation removes whole group/votes, then re-tallies: target disappears->4; new chief can be ejected->TWO observed Init calls, not an executed cascade", () => {
  const o = WithVotes(BanObservation([2, 2, 1]), [2, 2, 0, 0, 2], 0x81234562);
  const d = PlanBanPlayerAfterDeparture(o, 0);
  expect(d.Remaining.ChiefSlot).toBe(2);
  expect(d.Remaining.Actors.slice(0, 2)).toEqual([null, null]);
  expect(d.Remaining.Votes.slice(0, 2)).toEqual([0, 0]);
  expect(codes(d.Decision!)).toEqual([2]);
  expect(d.Decision!.Eject!.SocketKey).toBe(1);
  expect(d.ChiefInitializations).toBe(2);
  expect(codes(PlanBanPlayerAfterDeparture(o, 1).Decision!)).toEqual([4]);
  expect(
    PlanBanPlayerAfterDeparture({ ...o, TargetSerialNo: 0 }, 0).Decision,
  ).toBeNull();
  expect(o.Actors.filter(Boolean)).toHaveLength(5);
  expect(o.Votes.slice(0, 2)).toEqual([2, 2]);
});

test("captured snapshot and all plan outputs freeze independent data; query changes to source never rewrite latched actor/role/name inputs", () => {
  const o = BanObservation([1, 1, 1, 1]),
    captured = CaptureBanPlayerObservation(o),
    name = o.Actors[1]!.Name;
  const p = host(o, o.Actors[1]!.SerialNo, 1, () => {
    Reflect.set(o.Actors[1]!, "Name", "changed by codec");
    Reflect.set(o, "ChiefSlot", 2);
    return false;
  });
  expect(captured.Actors[1]!.Name).toBe(name);
  expect(p.Messages[0]!.Message).toEqual({
    Kind: "Question",
    TargetSerialNo: captured.Actors[1]!.SerialNo,
    Name: name,
  });
  expect(Object.isFrozen(captured.Actors[1])).toBe(true);
  expect(() => PlanBanPlayerAfterDeparture(captured, 7)).toThrow(
    "outside room",
  );
});

test("modern validation rejects malformed observations/duplicate serials/local self gaps and invalid request/answer/message bodies, with no authority fallback", () => {
  const o = BanObservation();
  for (const bad of [
    { ...o, Actors: [] },
    { ...o, Votes: [1] },
    { ...o, TargetSerialNo: -1 },
    { ...o, ChiefSlot: NaN },
    { ...o, Votes: Array(8).fill(1.5) },
    { ...o, Actors: [{ ...o.Actors[0]!, Self: 1 }, ...o.Actors.slice(1)] },
    { ...o, Actors: [o.Actors[1]!, ...o.Actors.slice(1)] },
  ])
    expect(() => CaptureBanPlayerObservation(bad)).toThrow();
  for (const bad of [-1, 256, NaN, 1.5]) {
    expect(() => host(o, o.Actors[1]!.SerialNo, bad)).toThrow();
    expect(() =>
      PlanRespondToBanPlayer(WithVotes(o, [2, 0, 1, 1]), 2, {
        TargetSerialNo: o.Actors[1]!.SerialNo,
        Answer: bad,
      }),
    ).toThrow();
  }
  for (const bad of [
    { Kind: "Result", Code: 6 },
    { Kind: "Result", Code: 2 },
    { Kind: "Question", TargetSerialNo: -1, Name: "bad" },
    { Kind: "other", Code: 4 },
  ])
    expect(() => MakeBanPlayerPacket(bad as BanPlayerMessage, text)).toThrow();
});

test("113/114 string/body preflight rejects wrong codepage/oversize; simple0/1/4 NEVER touch a name getter; UTF8 is explicit, not native Big5 reinterpretation", () => {
  for (const Code of [0, 1, 4] as const) {
    const m = {
      Kind: "Result" as const,
      Code,
      get Name(): string {
        throw new Error("NOT a name-bearing code");
      },
    };
    expect(MakeBanPlayerPacket(m, text).GetBuffer()).toHaveLength(2);
  }
  expect(() =>
    MakeBanPlayerPacket({ Kind: "Result", Code: 5, Name: "🙂" }, text),
  ).toThrow();
  expect(() =>
    MakeBanPlayerPacket(
      { Kind: "Question", TargetSerialNo: 1, Name: "x".repeat(0x8000) },
      text,
    ),
  ).toThrow();
  const p = MakeBanPlayerPacket(
    { Kind: "Result", Code: 3, Name: "中文" },
    new CTextCodec("utf8"),
    CipherDegree.None,
  );
  expect(p.GetBuffer().toString("hex")).toBe("72030006e4b8ade69687");
});
