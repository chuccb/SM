import { expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { BanPlayerRule, SessionLimit } from "../Common/OfficialValues.ts";
import { ChiefSQLState } from "./helpers/WaitingChief.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { read, networkRoom, emptyInventory } from "./helpers/VoteNetwork.ts";

test("REAL TCP:104/105 + REAL pending-vote disconnect shrinks denominator, synchronously ejects another DUAL group(TRUE),114/2 only survivors; no195/auto-Lobby/finance", async () => {
  const e = await networkRoom([1, 2, 1, 1, 1]);
  try {
    const [a, b, c, d, leaving] = e.groups,
      allUsers = e.groups.flatMap((g) => g.users),
      target = b!.ids[0]!.GlobalSerialNo,
      sql = ChiefSQLState(e.app.m_dbSession),
      wallet = allUsers.map((u) => u.GetDynamicInfoSnapshot()),
      pairs = allUsers.map((u) => u.CaptureUserInventoryInitialization()),
      victimSocket = b!.users[0]!.m_pClientSocket!,
      departed = leaving!.users[0]!;
    a!.peer.Send(new CSendPacket(104).Encode4(target).Encode1(0));
    const started = await read(a!.peer, 114);
    expect(started.Decode1()).toBe(0);
    started.AssertEnd();
    for (const g of [c!, d!, leaving!]) {
      const q = await read(g.peer, 113);
      expect(q.Decode4()).toBe(target);
      expect(q.DecodeStr()).toBe(b!.ids[0]!.ID);
      q.AssertEnd();
    }
    c!.peer.Send(new CSendPacket(105).Encode4(target).Encode1(255));
    c!.peer.Send(new CSendPacket(209));
    emptyInventory(await read(c!.peer, 201), 1); // same-socket handler-order barrier, no guessed sleep
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    expect(e.app.GetStatus().gameUpdate[0]!.pendingVoteRooms).toBe(1);
    expect(e.room.GetCurPlayer()).toBe(6);
    leaving!.peer.Close();
    for (const g of [a!, c!, d!]) {
      for (const user of [departed, ...b!.users]) {
        const reset = await read(g.peer, 106);
        expect(reset.Decode1()).toBe(
          user === departed ? 5 : user === b!.users[0] ? 1 : 2,
        );
        expect(reset.Decode4()).toBe(user.GetGlobalSerialNo());
        reset.AssertEnd();
      }
      const p = await read(g.peer, 114);
      expect(p.Decode1()).toBe(2);
      expect(p.DecodeStr()).toBe(b!.ids[0]!.ID);
      p.AssertEnd();
    }
    // Target was still a room recipient when the OUTER peer left: its earlier
    //106 is queued before deferred tally removes the target itself.
    const outer = await read(b!.peer, 106);
    expect(outer.Decode1()).toBe(5);
    expect(outer.Decode4()).toBe(departed.GetGlobalSerialNo());
    outer.AssertEnd();
    const last = await read(b!.peer, 106);
    expect(last.Decode1()).toBe(2);
    expect(last.Decode4()).toBe(b!.ids[1]!.GlobalSerialNo);
    last.AssertEnd();
    b!.peer.Send(new CSendPacket(209));
    emptyInventory(await read(b!.peer, 201), 2); // proves no intervening114/195/15 and TCP remains alive
    expect(victimSocket.m_nPoolType).toBe("SessionRemoved");
    expect(victimSocket.IsConnected()).toBe(true);
    expect(
      b!.users.every(
        (u) =>
          u.GetSessionIdx() === SessionLimit.NoSession &&
          u.m_nSlotIdx === -1 &&
          u.IsSetFree() === 0,
      ),
    ).toBe(true);
    expect(e.room.GetCurPlayer()).toBe(3);
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(
      e.app.m_center.m_globalUserTable.GetUser(departed.GetGlobalSerialNo()),
    ).toBeUndefined();
    expect(departed.IsSetFree()).toBe(1);
    expect(e.gs.m_channelPool.GetRankList()).toHaveLength(5);
    expect(allUsers.map((u) => u.GetDynamicInfoSnapshot())).toEqual(wallet);
    expect(allUsers.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
      pairs,
    );
    expect(ChiefSQLState(e.app.m_dbSession)).toEqual(sql);
    expect(e.app.GetStatus().gameUpdate[0]!.pendingVoteRooms).toBe(0);
  } finally {
    await e.close();
  }
}, 15000);

test("REAL TCP:secondary native BanReflex on target reflects104, chief DUAL group gets last106 then pool4; survivors get native107 succession then114/5; no grant/SQL/auto-stage", async () => {
  const e = await networkRoom([2, 2, 1]);
  try {
    const [a, b, c] = e.groups;
    // Explicit trusted PREEXISTING native read-side row, NOT a SQL/client grant.
    b!.users[1]!.InstallUserInventory([
      NativeInventory({
        strAttr: BanPlayerRule.BanReflexAttribute,
        Amount: 0,
        Slot: 255,
        DateCreated: -1.75,
      }),
    ]);
    const all = e.groups.flatMap((g) => g.users),
      sql = ChiefSQLState(e.app.m_dbSession),
      wallet = all.map((u) => u.GetDynamicInfoSnapshot()),
      pairs = all.map((u) => u.CaptureUserInventoryInitialization()),
      chiefSocket = a!.users[0]!.m_pClientSocket!;
    a!.peer.Send(
      new CSendPacket(104).Encode4(b!.ids[0]!.GlobalSerialNo).Encode1(0),
    );
    const last = await read(a!.peer, 106);
    expect(last.Decode1()).toBe(1);
    expect(last.Decode4()).toBe(a!.ids[1]!.GlobalSerialNo);
    last.AssertEnd();
    for (const g of [b!, c!]) {
      for (let slot = 0; slot < 2; slot++) {
        const reset = await read(g.peer, 106);
        expect(reset.Decode1()).toBe(slot);
        expect(reset.Decode4()).toBe(a!.ids[slot]!.GlobalSerialNo);
        reset.AssertEnd();
      }
      for (const slot of [3, 0, 2]) {
        const state = await read(g.peer, 107);
        expect(state.Decode1()).toBe(slot);
        state.DecodeBuffer(3);
        state.AssertEnd();
      }
      const p = await read(g.peer, 114);
      expect(p.Decode1()).toBe(5);
      expect(p.DecodeStr()).toBe(a!.ids[0]!.ID);
      p.AssertEnd();
    }
    a!.peer.Send(new CSendPacket(209));
    emptyInventory(await read(a!.peer, 201), 2);
    expect(chiefSocket.m_nPoolType).toBe("SessionRemoved");
    expect(chiefSocket.IsConnected()).toBe(true);
    expect(e.room.m_nChiefSlotidx).toBe(2);
    expect(e.room.GetCurPlayer()).toBe(3);
    expect(e.app.m_center.m_globalUserTable.GetUserCount()).toBe(5);
    expect(e.gs.m_channelPool.GetRankList()).toHaveLength(5);
    expect(all.map((u) => u.GetDynamicInfoSnapshot())).toEqual(wallet);
    expect(all.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
      pairs,
    );
    expect(ChiefSQLState(e.app.m_dbSession)).toEqual(sql);
    expect(e.app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(e.app.GetStatus().officialClientVerified).toBe(false);
  } finally {
    await e.close();
  }
}, 15000);
