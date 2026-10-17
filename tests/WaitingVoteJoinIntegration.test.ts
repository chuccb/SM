import { expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CDBMan as LoginDB } from "../LS/CDBMan.ts";
import { WireClient } from "./helpers/Clients.ts";
import { greeting, login, transfer, establish } from "./helpers/Network.ts";
import { networkRoom, read, emptyInventory } from "./helpers/VoteNetwork.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { ChiefSQLState } from "./helpers/WaitingChief.ts";
import { JoinSessionResult } from "../Common/OfficialValues.ts";
type Environment = Awaited<ReturnType<typeof networkRoom>>;
async function newcomer(e: Environment, ids: string[], peers: WireClient[]) {
  const db = new LoginDB(e.app.m_dbSession);
  for (const ID of ids)
    await db.RegisterNewUser({ ID, Password: "test-password", Gender: 0 });
  const ls = new WireClient(e.app.m_loginServer.m_listenSocket.port);
  peers.push(ls);
  await greeting(ls);
  const identities = await login(ls, ids),
    p = new WireClient(await transfer(ls));
  peers.push(p);
  await establish(p, identities);
  await read(p, 83);
  return {
    peer: p,
    ids: identities,
    users: identities.map(
      (id) => e.app.m_center.m_globalUserTable.GetUser(id.GlobalSerialNo)!,
    ),
  };
}
async function begin(e: Environment) {
  const [a, b, c, d] = e.groups,
    target = b!.ids[0]!.GlobalSerialNo;
  a!.peer.Send(new CSendPacket(104).Encode4(target).Encode1(0));
  const p = await read(a!.peer, 114);
  expect(p.Decode1()).toBe(0);
  p.AssertEnd();
  for (const g of [c, d].filter((g) => !!g)) {
    const q = await read(g!.peer, 113);
    expect(q.Decode4()).toBe(target);
    expect(q.DecodeStr()).toBe(b!.ids[0]!.ID);
    q.AssertEnd();
  }
  return target;
}
function requestJoin(
  e: Environment,
  peer: WireClient,
  count: number,
  password = "",
) {
  const p = new CSendPacket(81)
    .Encode2(e.room.m_nIdx)
    .Encode4(e.room.m_ulSerialNo)
    .EncodeStr(password)
    .Encode1(count);
  for (let i = 0; i < count; i++) p.Encode1(i ? 0 : 5);
  peer.Send(p);
}
async function joinSnapshot(e: Environment, p: WireClient, count: number) {
  const ack = await read(p, 81);
  expect(ack.Decode1()).toBe(0);
  ack.AssertEnd();
  const socket =
    e.app.m_center.m_globalUserTable.FindUserFromId("Later0")?.m_pClientSocket;
  for (let slot = 0; slot < 8; slot++) {
    const user = e.room.m_rgPlayer[slot],
      expected = user
        ? e.room.MakeSetPlayerPacket(slot, user.m_pClientSocket === socket)
        : e.room.MakeSetSlotStatePacket(slot);
    expect((await p.Read()).m_pBlock).toEqual(expected.GetBuffer());
  }
  for (let i = 0; i < 2; i++) {
    const q = await read(p, 112);
    expect(q.Decode2()).toBe(0xffff);
    q.AssertEnd();
  }
  (await read(p, 93)).AssertEnd();
  for (const old of e.groups)
    for (let local = 0; local < count; local++)
      expect((await old.peer.Read()).m_pBlock).toEqual(
        e.room.MakeSetPlayerPacket(4 + local, true).GetBuffer(),
      );
}

test("REAL TCP:pending104 admits a LATER dual-local81 snapshot, native/legacy read-side unchanged, NO new113 or ballot; old105 still ejects same target and new peer receives114", async () => {
  const e = await networkRoom([1, 1, 1, 1]),
    peers: WireClient[] = [];
  try {
    const target = await begin(e),
      later = await newcomer(e, ["Later0", "Later1"], peers);
    // Trusted PREEXISTING native read-side data, not a client/SQL grant. The other
    // local stays legacy-empty. New105 must preserve both source modes/epochs.
    later.users[1]!.InstallUserInventory([
      NativeInventory({ Category: 4, Slot: 0, Amount: 0, nAttr1: 13 }),
      NativeInventory({ Category: 6, Slot: 0, nAttr1: 0x1234 }),
    ]);
    const users = [...e.groups.flatMap((g) => g.users), ...later.users],
      sql = ChiefSQLState(e.app.m_dbSession),
      wallet = users.map((u) => u.GetDynamicInfoSnapshot()),
      pair = users.map((u) => u.CaptureUserInventoryInitialization()),
      votes = [...e.room.m_anBanPlayerVote],
      chief = e.room.m_nChiefSlotidx;
    requestJoin(e, later.peer, 2);
    await joinSnapshot(e, later.peer, 2);
    expect(later.users.map((u) => u.m_nSlotIdx)).toEqual([4, 5]);
    expect(e.room.GetCurPlayer()).toBe(6);
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    expect(e.room.m_nChiefSlotidx).toBe(chief);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    expect(e.app.GetStatus().gameUpdate[0]!.pendingVoteRooms).toBe(1);
    const expected = new CSendPacket(201).Encode1(2);
    for (const u of later.users) u.MakeUserInventoryPacket(expected);
    later.peer.Send(new CSendPacket(105).Encode4(target).Encode1(255));
    later.peer.Send(new CSendPacket(209));
    expect((await later.peer.Read()).m_pBlock).toEqual(expected.GetBuffer()); // same-socket barrier: no113/114 before201
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    e.groups[2]!.peer.Send(new CSendPacket(105).Encode4(target).Encode1(1));
    for (const g of [e.groups[0]!, e.groups[2]!, e.groups[3]!, later]) {
      const reset = await read(g.peer, 106);
      expect(reset.Decode1()).toBe(1);
      expect(reset.Decode4()).toBe(target);
      reset.AssertEnd();
      const result = await read(g.peer, 114);
      expect(result.Decode1()).toBe(2);
      expect(result.DecodeStr()).toBe(e.groups[1]!.ids[0]!.ID);
      result.AssertEnd();
    }
    const selfReset = await read(e.groups[1]!.peer, 106);
    expect(selfReset.Decode1()).toBe(1);
    expect(selfReset.Decode4()).toBe(target);
    selfReset.AssertEnd();
    e.groups[1]!.peer.Send(new CSendPacket(209));
    emptyInventory(await read(e.groups[1]!.peer, 201), 1);
    expect(e.room.GetCurPlayer()).toBe(5);
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(wallet);
    expect(users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
      pair,
    );
    expect(ChiefSQLState(e.app.m_dbSession)).toEqual(sql);
    expect(e.gs.m_channelPool.GetRankList()).toHaveLength(6);
    expect(e.app.m_center.m_globalUserTable.GetUserCount()).toBe(6);
    expect(e.app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(e.app.GetStatus().officialClientVerified).toBe(false);
  } finally {
    peers.forEach((p) => p.Close());
    await e.close();
  }
}, 15000);

test("REAL TCP:pending-vote password81/1 has NO partial enrollment, same dual peer retries correct password successfully; closed-slot capacity then returns81/2 without resetting ballot", async () => {
  const e = await networkRoom([1, 1, 1, 1], "Correct"),
    peers: WireClient[] = [];
  try {
    for (const slot of [6, 7]) {
      e.groups[0]!.peer.Send(new CSendPacket(100).Encode1((slot << 4) | 1));
      for (const g of e.groups) {
        const q = await read(g.peer, 110);
        expect(q.Decode1()).toBe((slot << 4) | 1);
        q.AssertEnd();
      }
    }
    const target = await begin(e),
      later = await newcomer(e, ["Later0", "Later1"], peers),
      votes = [...e.room.m_anBanPlayerVote],
      sql = ChiefSQLState(e.app.m_dbSession),
      before = later.users.map((u) => u.CaptureUserInventoryInitialization());
    requestJoin(e, later.peer, 2, "Wrong");
    const rejected = await read(later.peer, 81);
    expect(rejected.Decode1()).toBe(JoinSessionResult.IncorrectPassword);
    rejected.AssertEnd();
    expect(
      later.users.every(
        (u) => u.GetSessionIdx() === 0xffff && u.m_nSlotIdx === -1,
      ),
    ).toBe(true);
    expect(e.room.GetCurPlayer()).toBe(4);
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    requestJoin(e, later.peer, 2, "Correct");
    await joinSnapshot(e, later.peer, 2);
    expect(e.room.GetCurPlayer()).toBe(6);
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    expect(
      later.users.map((u) => u.CaptureUserInventoryInitialization()),
    ).toEqual(before);
    expect(ChiefSQLState(e.app.m_dbSession)).toEqual(sql);
    const extra = await newcomer(e, ["Overflow"], peers),
      afterRegistration = ChiefSQLState(e.app.m_dbSession);
    requestJoin(e, extra.peer, 1, "Correct");
    const full = await read(extra.peer, 81);
    expect(full.Decode1()).toBe(JoinSessionResult.Unavailable);
    full.AssertEnd();
    expect(extra.users[0]!.GetSessionIdx()).toBe(0xffff);
    expect(e.room.GetCurPlayer()).toBe(6);
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    expect(ChiefSQLState(e.app.m_dbSession)).toEqual(afterRegistration);
  } finally {
    peers.forEach((p) => p.Close());
    await e.close();
  }
}, 15000);
