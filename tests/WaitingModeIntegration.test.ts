import { expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { CDBMan as LoginDB } from "../LS/CDBMan.ts";
import { WireClient } from "./helpers/Clients.ts";
import { greeting, login, transfer, establish } from "./helpers/Network.ts";
import { networkRoom, read, emptyInventory } from "./helpers/VoteNetwork.ts";
import { ChiefSQLState } from "./helpers/WaitingChief.ts";
type Env = Awaited<ReturnType<typeof networkRoom>>;
async function beginVote(e: Env) {
  const target = e.groups[1]!.ids[0]!.GlobalSerialNo;
  e.groups[0]!.peer.Send(new CSendPacket(104).Encode4(target).Encode1(0));
  const p = await read(e.groups[0]!.peer, 114);
  expect(p.Decode1()).toBe(0);
  p.AssertEnd();
  for (const g of e.groups.slice(2)) {
    const p = await read(g.peer, 113);
    expect(p.Decode4()).toBe(target);
    expect(p.DecodeStr()).toBe(e.groups[1]!.ids[0]!.ID);
    p.AssertEnd();
  }
  return target;
}
async function mode(e: Env, opcode: number, response: number) {
  e.groups[0]!.peer.Send(new CSendPacket(opcode));
  for (const g of e.groups) {
    const p = await read(g.peer, response);
    p.AssertEnd();
    expect(p.m_pBlock.toString("hex")).toBe(response === 92 ? "06" : "07");
  }
}

test("REAL TCP:issued waiting vote103/92 and102/93 preserve electorate/Manner, later Mod pair joins with92 snapshot/zero ballots,old105 still resolves same target, no SQL/grant", async () => {
  const e = await networkRoom([1, 2, 1, 1]),
    peers: WireClient[] = [];
  try {
    const target = await beginVote(e),
      votes = [...e.room.m_anBanPlayerVote],
      chief = e.room.m_nChiefSlotidx;
    await mode(e, 103, 92);
    expect(e.room.GetGameTypeState().Value).toBe(1);
    expect(e.room.m_nManner).toBe(0);
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    await mode(e, 102, 93);
    expect(e.room.GetGameTypeState().Value).toBe(0);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    await mode(e, 103, 92);
    const db = new LoginDB(e.app.m_dbSession);
    for (const ID of ["ModeLater0", "ModeLater1"])
      await db.RegisterNewUser({ ID, Password: "test-password", Gender: 0 });
    const ls = new WireClient(e.app.m_loginServer.m_listenSocket.port);
    peers.push(ls);
    await greeting(ls);
    const ids = await login(ls, ["ModeLater0", "ModeLater1"]),
      p = new WireClient(await transfer(ls));
    peers.push(p);
    await establish(p, ids);
    await read(p, 83);
    const users = ids.map(
        (u) => e.app.m_center.m_globalUserTable.GetUser(u.GlobalSerialNo)!,
      ),
      all = [...e.groups.flatMap((g) => g.users), ...users],
      sql = ChiefSQLState(e.app.m_dbSession),
      wallet = all.map((u) => u.GetDynamicInfoSnapshot()),
      pair = all.map((u) => u.CaptureUserInventoryInitialization());
    p.Send(
      new CSendPacket(81)
        .Encode2(e.room.m_nIdx)
        .Encode4(e.room.m_ulSerialNo)
        .EncodeStr("")
        .Encode1(2)
        .Encode1(0)
        .Encode1(0),
    );
    const ack = await read(p, 81);
    expect(ack.Decode1()).toBe(0);
    ack.AssertEnd();
    for (let slot = 0; slot < 8; slot++) {
      const u = e.room.m_rgPlayer[slot],
        expected = u
          ? e.room.MakeSetPlayerPacket(
              slot,
              u.m_pClientSocket === users[0]!.m_pClientSocket,
            )
          : e.room.MakeSetSlotStatePacket(slot);
      expect((await p.Read()).m_pBlock).toEqual(expected.GetBuffer());
    }
    for (let i = 0; i < 2; i++) {
      const q = await read(p, 112);
      expect(q.Decode2()).toBe(0xffff);
      q.AssertEnd();
    }
    (await read(p, 92)).AssertEnd();
    for (const old of e.groups)
      for (const u of users)
        expect((await old.peer.Read()).m_pBlock).toEqual(
          e.room.MakeSetPlayerPacket(u.m_nSlotIdx, true).GetBuffer(),
        );
    expect(e.room.GetGameTypeState().Value).toBe(1);
    expect(e.room.m_nChiefSlotidx).toBe(chief);
    expect(e.room.m_nManner).toBe(0);
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    p.Send(new CSendPacket(105).Encode4(target).Encode1(255));
    p.Send(new CSendPacket(209));
    emptyInventory(await read(p, 201), 2);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    e.groups[2]!.peer.Send(new CSendPacket(105).Encode4(target).Encode1(1));
    for (const to of [
      ...e.groups.filter((_, i) => i !== 1).map((g) => g.peer),
      p,
    ]) {
      for (const [i, u] of e.groups[1]!.users.entries()) {
        const q = await read(to, 106);
        expect(q.Decode1()).toBe(1 + i);
        expect(q.Decode4()).toBe(u.GetGlobalSerialNo());
        q.AssertEnd();
      }
      const q = await read(to, 114);
      expect(q.Decode1()).toBe(2);
      expect(q.DecodeStr()).toBe(e.groups[1]!.ids[0]!.ID);
      q.AssertEnd();
    }
    const own = await read(e.groups[1]!.peer, 106);
    expect(own.Decode1()).toBe(2);
    expect(own.Decode4()).toBe(e.groups[1]!.ids[1]!.GlobalSerialNo);
    own.AssertEnd();
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.room.GetGameTypeState().Value).toBe(1);
    expect(e.room.GetCurPlayer()).toBe(5);
    expect(e.groups[1]!.users[0]!.m_pClientSocket!.m_nPoolType).toBe(
      "SessionRemoved",
    );
    expect(all.map((u) => u.GetDynamicInfoSnapshot())).toEqual(wallet);
    expect(all.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
      pair,
    );
    expect(ChiefSQLState(e.app.m_dbSession)).toEqual(sql);
    expect(e.app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(e.app.GetStatus().officialClientVerified).toBe(false);
  } finally {
    peers.forEach((p) => p.Close());
    await e.close();
  }
}, 15000);

test("REAL TCP + UNACCELERATED Mod waiting timer:active103 vote is NOT unscheduled,odd CAPACITY5 warns>5s/ejects chief>10s with121 before removal,private ballot continues without195/finance", async () => {
  const e = await networkRoom([1, 1, 1, 1], "", undefined, 1);
  try {
    for (const slot of [5, 6, 7]) {
      e.groups[0]!.peer.Send(new CSendPacket(100).Encode1((slot << 4) | 1));
      for (const g of e.groups) {
        const p = await read(g.peer, 110);
        expect(p.Decode1()).toBe((slot << 4) | 1);
        p.AssertEnd();
      }
    }
    const target = await beginVote(e),
      sql = ChiefSQLState(e.app.m_dbSession),
      users = e.groups.flatMap((g) => g.users),
      wallet = users.map((u) => u.GetDynamicInfoSnapshot()),
      pair = users.map((u) => u.CaptureUserInventoryInitialization()),
      chiefSocket = e.groups[0]!.users[0]!.m_pClientSocket!;
    await mode(e, 103, 92);
    expect(e.room.m_nMaxPlayer).toBe(5);
    expect(e.room.GetCurPlayer()).toBe(4);
    expect(e.room.IsManner()).toBe(true);
    expect(e.room.IsWaitingChiefScheduled()).toBe(true);
    expect(e.gs.m_timerThreadNormal.IsRunning()).toBe(true);
    for (const g of e.groups) {
      const p = await g.peer.Read(CipherDegree.CRC8, 10000);
      expect(p.Decode1()).toBe(121);
      expect(p.Decode1()).toBe(1);
      expect(p.Decode2()).toBe(10);
      p.AssertEnd();
    }
    const warned = e.room.m_banChief.CaptureSnapshot();
    expect(
      (warned.WarnedTimeOddSlot - warned.LastTimeEvenSlot) >>> 0,
    ).toBeGreaterThan(5000);
    expect(e.room.GetCurPlayer()).toBe(4);
    const kick = await e.groups[0]!.peer.Read(CipherDegree.CRC8, 15000);
    expect(kick.Decode1()).toBe(121);
    expect(kick.Decode1()).toBe(3);
    expect(kick.Decode2()).toBe(10);
    kick.AssertEnd();
    for (const g of e.groups.slice(1)) {
      const reset = await read(g.peer, 106);
      expect(reset.Decode1()).toBe(0);
      expect(reset.Decode4()).toBe(e.groups[0]!.ids[0]!.GlobalSerialNo);
      reset.AssertEnd();
      for (const slot of [0, 1]) {
        const state = await read(g.peer, 107);
        expect(state.Decode1()).toBe(slot);
        state.DecodeBuffer(3);
        state.AssertEnd();
      }
    }
    expect(
      (e.room.GetGameClock().GetCurrentTime() - warned.WarnedTimeOddSlot) >>> 0,
    ).toBeGreaterThan(10000);
    expect(chiefSocket.m_nPoolType).toBe("SessionRemoved");
    expect(chiefSocket.IsConnected()).toBe(true);
    expect(e.room.GetCurPlayer()).toBe(3);
    expect(e.room.m_nChiefSlotidx).toBe(1);
    expect(e.room.GetGameTypeState().Value).toBe(1);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    e.groups[0]!.peer.Send(new CSendPacket(209));
    emptyInventory(await read(e.groups[0]!.peer, 201), 1); // no extra195/15 or reset to root
    e.groups[2]!.peer.Send(new CSendPacket(105).Encode4(target).Encode1(0));
    for (const g of e.groups.slice(1)) {
      const q = await read(g.peer, 114);
      expect(q.Decode1()).toBe(3);
      expect(q.DecodeStr()).toBe(e.groups[1]!.ids[0]!.ID);
      q.AssertEnd();
    }
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.room.GetGameTypeState().Value).toBe(1);
    expect(users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(wallet);
    expect(users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
      pair,
    );
    expect(ChiefSQLState(e.app.m_dbSession)).toEqual(sql);
    expect(e.app.GetStatus().gameUpdate[0]!.waitingGameTypeScope).toBe(
      "normal-mod/issued-vote",
    );
  } finally {
    await e.close();
  }
}, 30000);
