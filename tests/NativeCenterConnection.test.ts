import { afterEach, expect, test } from "bun:test";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { CenterConnectionRule, ServerType } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { CCenterServer } from "../Center/CCenterServer.ts";
import { CUser } from "../Common/CUser.ts";
import { MemoryClient } from "./helpers/Clients.ts";
import { TestConfig, UserInfo } from "./helpers/Accounts.ts";
import {
  CopyNativeCenterConnectionState,
  PlanCheckConnectingToSvr,
  PlanSetConnectingToSvr,
  CheckNativeConnectionEstablished,
  PlanSetConnectionEstablished,
  PlanDeferDisconnectTimeout,
  type NativeCenterConnectionState,
  type NativeCenterConnectionTarget,
} from "../Center/NativeConnection.ts";
import raw from "./fixtures/center-connection-vectors.json";
interface VectorPlan {
  Result: number;
  ClockReads: number;
  State: NativeCenterConnectionState;
}
interface Vector {
  Name: string;
  Before: NativeCenterConnectionState;
  Target: NativeCenterConnectionTarget;
  RequestTick: number;
  NowTick: number;
  ProbeType: number;
  ProbeIndex: number;
  Expected: {
    Check: VectorPlan;
    Routed: NativeCenterConnectionState;
    Established: boolean;
    EstablishedState: NativeCenterConnectionState;
    Timeout: VectorPlan;
  };
}
const vectors: {
  Model: string;
  Cases: Vector[];
  NativeGroupHazards: {
    Before: NativeCenterConnectionState[];
    Target: NativeCenterConnectionTarget;
    Checks: number[];
    NativeLastResult: number;
    AfterNativeLoop: NativeCenterConnectionState[];
  }[];
  OfficialPE: { Service: string; SHA256: string }[];
  InstructionAnchors: {
    Service: string;
    VA: number;
    Bytes: string;
    Meaning: string;
  }[];
} = raw;
const sockets: MemoryClient[] = [];
afterEach(() => {
  for (const p of sockets.splice(0).reverse()) p.Close();
});
function peer() {
  const p = new MemoryClient();
  sockets.push(p);
  return p;
}
function state(
  extra: Partial<NativeCenterConnectionState> = {},
): NativeCenterConnectionState {
  return {
    SetFree: 0,
    Connecting: 0,
    ServerType: 1,
    ServerIndex: 0,
    ConnectingTick: 0,
    Authencode: 0,
    ...extra,
  };
}
const target: NativeCenterConnectionTarget = {
  Type: 10,
  Index: 0,
  RegisteredCount: 5,
  Exists: true,
  Connected: true,
  ChannelType: 0,
};

test("native Center model pins36 PE anchors,3444 cases/256 inner-loop hazards and17500 native timeout distinct from modern30000 policy", () => {
  expect(vectors.Model).toContain("NOT-modern-lease");
  expect(vectors.Cases).toHaveLength(3444);
  expect(vectors.NativeGroupHazards).toHaveLength(256);
  expect(vectors.InstructionAnchors).toHaveLength(36);
  const images = {
    Center: new CPeImage(OFFICIAL_SERVICES.Center),
    FXGS: new CPeImage(OFFICIAL_SERVICES.FXGS),
  };
  for (const p of vectors.OfficialPE)
    expect(images[p.Service as keyof typeof images].sha256).toBe(p.SHA256);
  for (const a of vectors.InstructionAnchors)
    expect(
      images[a.Service as keyof typeof images]
        .read(a.VA, a.Bytes.length / 2)
        .toString("hex"),
    ).toBe(a.Bytes);
  expect(CenterConnectionRule.NativeConnectingTimeoutMs).toBe(17500);
  expect(RuntimePolicy.SessionTransferTimeoutMs).toBe(30000);
  expect(CenterConnectionRule.NoServerIndex).toBe(-2147483648);
});

test("3444 independent C++ images consume actual native check/route/established/clear/timeout TS projections with exact DWORD/byte/signed-index and explicit clock counts", () => {
  for (const c of vectors.Cases) {
    const before = JSON.stringify(c.Before);
    let checkReads = 0,
      timeReads = 0;
    const checked = PlanCheckConnectingToSvr(c.Before, c.Target, () => {
      checkReads++;
      return c.RequestTick;
    });
    expect<unknown>(checked).toEqual(c.Expected.Check);
    expect(checkReads).toBe(c.Expected.Check.ClockReads);
    expect(Object.isFrozen(checked.State)).toBe(true);
    const routed =
      checked.Result === 1
        ? PlanSetConnectingToSvr(checked.State, c.Target.Type, c.Target.Index)
        : checked.State;
    expect(routed).toEqual(c.Expected.Routed);
    const ok = CheckNativeConnectionEstablished(
      routed,
      c.ProbeType,
      c.ProbeIndex,
    );
    expect(ok).toBe(c.Expected.Established);
    expect(ok ? PlanSetConnectionEstablished(routed) : routed).toEqual(
      c.Expected.EstablishedState,
    );
    const timed = PlanDeferDisconnectTimeout(c.Before, () => {
      timeReads++;
      return c.NowTick;
    });
    expect<unknown>(timed).toEqual(c.Expected.Timeout);
    expect(timeReads).toBe(c.Expected.Timeout.ClockReads);
    expect(JSON.stringify(c.Before)).toBe(before);
  }
});

test("native inner per-user CHECK mutates before all success;256 modeled group combinations include last-result hazards, not the modern lease algorithm", () => {
  let earlyPartial = 0,
    lastOnly = 0;
  for (const c of vectors.NativeGroupHazards) {
    const checks = c.Before.map((s) =>
      PlanCheckConnectingToSvr(s, c.Target, () => 100),
    );
    expect<number[]>(checks.map((r) => r.Result)).toEqual(c.Checks);
    expect<number>(checks[1]!.Result).toBe(c.NativeLastResult);
    expect(
      checks.map((r) =>
        c.NativeLastResult === 1
          ? PlanSetConnectingToSvr(r.State, c.Target.Type, c.Target.Index)
          : r.State,
      ),
    ).toEqual(c.AfterNativeLoop);
    if (checks[0]!.Result === 1 && checks[1]!.Result !== 1) earlyPartial++;
    if (checks[0]!.Result !== 1 && checks[1]!.Result === 1) lastOnly++;
  }
  expect(earlyPartial).toBeGreaterThan(0);
  expect(lastOnly).toBeGreaterThan(0);
  const config = TestConfig(),
    center = new CCenterServer(config);
  for (const s of center.m_localServerMan.m_aLocalServer) s.m_bConnected = true;
  const source = peer(),
    ls = center.m_localServerMan.GetSvr(ServerType.Login, 0)!,
    users = center.OnAddNewUser(source, ls, [
      UserInfo("First"),
      UserInfo("Second"),
    ]);
  users[0]!.SetFree();
  expect(center.OnReqConnectToSvr(source, ServerType.FXGame, 0).result).toBe(0);
  expect(users.every((u) => !u.m_pendingConnection)).toBe(true);
  expect(users[1]!.IsSetFree()).toBe(0);
});

test("native premium auth is exact DWORD1, not FXGS lowBYTE1 or the modern legacy TicketDate branch", () => {
  const s = state({ Authencode: 257 }),
    p = PlanCheckConnectingToSvr(s, { ...target, ChannelType: 41 }, () => {
      throw Error("premium failure must not sample clock");
    });
  expect(p.Result).toBe(2);
  const user = new CUser(UserInfo("Synthetic"), 7);
  user.SetAuthenCode(257);
  expect(user.GetAuthencode()).toBe(1);
  expect(
    PlanCheckConnectingToSvr(
      state({ Authencode: 1 }),
      { ...target, ChannelType: 41 },
      () => 123,
    ).Result,
  ).toBe(1);
  expect(
    PlanCheckConnectingToSvr(s, { ...target, ChannelType: 42 }, () => 123)
      .Result,
  ).toBe(1);
});

test("CHECK success writes flag/tick BEFORE route, established predicate does not consume flag or check timeout; clear only resets connecting", () => {
  const a = PlanCheckConnectingToSvr(state(), target, () => 99);
  expect([
    a.State.ServerType,
    a.State.ServerIndex,
    a.State.Connecting,
    a.State.ConnectingTick,
  ]).toEqual([1, 0, 1, 99]);
  expect(CheckNativeConnectionEstablished(a.State, 10, 0)).toBe(false);
  const routed = PlanSetConnectingToSvr(a.State, 10, 0);
  expect(CheckNativeConnectionEstablished(routed, 10, 0)).toBe(true);
  expect(CheckNativeConnectionEstablished(routed, 10, 0)).toBe(true);
  expect(PlanDeferDisconnectTimeout(routed, () => 17600).Result).toBe(1);
  expect(CheckNativeConnectionEstablished(routed, 10, 0)).toBe(true);
  expect(PlanSetConnectionEstablished(routed)).toEqual({
    ...routed,
    Connecting: 0,
  });
});

test("unsigned wrap/strict deadline and one-shot SetFree preserve already-free non1 flag/index but timeout STILL returns1", () => {
  const s = state({ Connecting: 1, ConnectingTick: 0xfffffff0 });
  expect(
    PlanDeferDisconnectTimeout(s, () => (0xfffffff0 + 17500) >>> 0).Result,
  ).toBe(0);
  const expired = PlanDeferDisconnectTimeout(
    s,
    () => (0xfffffff0 + 17501) >>> 0,
  );
  expect(expired.State).toEqual({ ...s, SetFree: 1, ServerIndex: -2147483648 });
  expect(expired.Result).toBe(1);
  const already = state({ SetFree: 2, Connecting: 0xffffffff, ServerIndex: 5 });
  expect(PlanDeferDisconnectTimeout(already, () => 17501)).toEqual({
    Result: 1,
    State: already,
    ClockReads: 1,
  });
  expect(
    PlanDeferDisconnectTimeout(state(), () => {
      throw Error("not connecting must not sample");
    }).ClockReads,
  ).toBe(0);
});

test("state/target primitives are captured before explicit tick callback; detached plans do not mutate observed source or caller's server DTO", () => {
  const s = state(),
    t = { ...target };
  let reads = 0;
  const p = PlanCheckConnectingToSvr(s, t, () => {
    reads++;
    (s as { Authencode: number }).Authencode = 7;
    (s as { ServerIndex: number }).ServerIndex = 999;
    t.Index = 999;
    return 123;
  });
  expect(p.State.Authencode).toBe(0);
  expect(p.State.ServerIndex).toBe(0);
  expect(p.State.ConnectingTick).toBe(123);
  expect(reads).toBe(1);
  const calls = new Map<string, number>(),
    rawState = Object.fromEntries(
      Object.entries(state()).map(([k, v]) => [k, v]),
    );
  for (const k of Object.keys(rawState)) {
    const value = rawState[k];
    Object.defineProperty(rawState, k, {
      get: () => {
        calls.set(k, (calls.get(k) ?? 0) + 1);
        return value;
      },
    });
  }
  CopyNativeCenterConnectionState(rawState);
  expect([...calls.values()]).toEqual([1, 1, 1, 1, 1, 1]);
});

test("raw bit spellings normalize, invalid unused observations/clock returns reject without fabricating Windows status/registration or host fallback", () => {
  expect(
    CopyNativeCenterConnectionState(
      state({
        Connecting: -1,
        ConnectingTick: -1,
        ServerIndex: 0xffffffff,
        Authencode: -1,
      }),
    ),
  ).toEqual(
    state({
      Connecting: 0xffffffff,
      ConnectingTick: 0xffffffff,
      ServerIndex: -1,
      Authencode: 0xffffffff,
    }),
  );
  for (const extra of [
    { ServerType: 256 },
    { SetFree: -2147483649 },
    { ConnectingTick: 0x100000000 },
    { Authencode: 1.5 },
  ])
    expect(() =>
      PlanCheckConnectingToSvr(state(extra), target, () => 0),
    ).toThrow();
  for (const extra of [
    { Type: 256 },
    { Index: 0x100000000 },
    { Exists: 1 },
    { RegisteredCount: NaN },
  ])
    expect(() =>
      PlanCheckConnectingToSvr(
        state(),
        { ...target, ...extra } as NativeCenterConnectionTarget,
        () => 0,
      ),
    ).toThrow();
  for (const tick of [NaN, Infinity, 1.5, 0x100000000])
    expect(() =>
      PlanCheckConnectingToSvr(state(), target, () => tick),
    ).toThrow();
  expect(() => PlanDeferDisconnectTimeout(state(), undefined as never)).toThrow(
    "explicit",
  );
});

test("a true native field predicate is NOT an authentication capability: copied observed state cannot establish a modern Center transfer with no issued pending", () => {
  expect(
    CheckNativeConnectionEstablished(
      state({ Connecting: 1, ServerType: 10 }),
      10,
      0,
    ),
  ).toBe(true);
  const center = new CCenterServer(TestConfig());
  for (const s of center.m_localServerMan.m_aLocalServer) s.m_bConnected = true;
  const source = peer(),
    to = peer(),
    ls = center.m_localServerMan.GetSvr(ServerType.Login, 0)!,
    gs = center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!,
    users = center.OnAddNewUser(source, ls, [UserInfo("Observed")]);
  expect(() =>
    center.AuthorizeConnection(to, gs, [
      {
        ID: "Observed",
        GlobalSerialNo: users[0]!.GetGlobalSerialNo(),
        GuildSn: 0,
      },
    ]),
  ).toThrow("transfer");
  expect(source.m_aUser).toEqual(users);
  expect(to.GetUserCount()).toBe(0);
});
