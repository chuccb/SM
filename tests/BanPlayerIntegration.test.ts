import { expect, test } from "bun:test";
import { CServerApp } from "../CServerApp.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { BanPlayerRule, SessionLimit } from "../Common/OfficialValues.ts";
import { CDBMan as LoginDB } from "../LS/CDBMan.ts";
import { WireClient } from "./helpers/Clients.ts";
import { TestConfig } from "./helpers/Accounts.ts";
import {
  greeting,
  login,
  transfer,
  establish,
  slotPacket,
} from "./helpers/Network.ts";
import { ChiefSQLState } from "./helpers/WaitingChief.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
async function read(peer: WireClient, opcode: number) {
  const p = await peer.Read();
  expect(p.Decode1()).toBe(opcode);
  return p;
}
/** Genuine registration/LS/GS80/81. No clock/Running/ready/vote state injection.
 * Peer shares production codec: NOT an official client or binary oracle. */
async function networkRoom(counts: readonly number[]) {
  const app = new CServerApp(TestConfig()),
    all: WireClient[] = [],
    groups: {
      peer: WireClient;
      ids: Awaited<ReturnType<typeof login>>;
      users: NonNullable<
        ReturnType<typeof app.m_center.m_globalUserTable.GetUser>
      >[];
    }[] = [];
  const connect = (port: number) => {
      const p = new WireClient(port);
      all.push(p);
      return p;
    },
    close = async () => {
      all.forEach((p) => p.Close());
      await app.CleanUp();
    };
  try {
    const db = new LoginDB(app.m_dbSession);
    let name = 0;
    const names = counts.map((n) =>
      Array.from({ length: n }, () => `Vote${name++}`),
    );
    for (const ID of names.flat())
      await db.RegisterNewUser({ ID, Password: "test-password", Gender: 0 });
    await app.SetUp();
    let index = 0,
      serial = 0,
      occupied = 0;
    for (const [i, count] of counts.entries()) {
      const ls = connect(app.m_loginServer.m_listenSocket.port);
      await greeting(ls);
      const ids = await login(ls, names[i]!),
        peer = connect(await transfer(ls));
      await establish(peer, ids);
      if (i > 0) await read(peer, 83); // one83 per EXISTING room, no empty-list ACK
      const users = ids.map(
        (u) => app.m_center.m_globalUserTable.GetUser(u.GlobalSerialNo)!,
      );
      groups.push({ peer, ids, users });
      const start = occupied;
      occupied += count;
      if (i === 0) {
        const p = new CSendPacket(80)
          .EncodeStr("Native live vote")
          .EncodeStr("")
          .Encode1(0)
          .Encode1(count);
        for (let j = 0; j < count; j++) p.Encode1(0);
        peer.Send(p);
        const made = await read(peer, 80);
        expect(made.Decode1()).toBe(0);
        index = made.Decode2();
        serial = made.Decode4();
        expect(made.Decode1()).toBe(0);
        made.AssertEnd();
      } else {
        const p = new CSendPacket(81)
          .Encode2(index)
          .Encode4(serial)
          .EncodeStr("")
          .Encode1(count);
        for (let j = 0; j < count; j++) p.Encode1(0);
        peer.Send(p);
        const joined = await read(peer, 81);
        expect(joined.Decode1()).toBe(0);
        joined.AssertEnd();
      }
      for (let slot = 0; slot < 8; slot++)
        slotPacket(
          await peer.Read(),
          slot,
          slot < occupied,
          slot >= start && slot < occupied,
        );
      for (let j = 0; j < 2; j++) {
        const map = await read(peer, 112);
        expect(map.Decode2()).toBe(0xffff);
        map.AssertEnd();
      }
      if (i > 0) (await read(peer, 93)).AssertEnd();
      for (const other of groups.slice(0, -1))
        for (let slot = start; slot < occupied; slot++)
          slotPacket(await other.peer.Read(), slot, true, true);
    }
    const gs = app.m_gameServers[0]!,
      room = gs.m_gameSessionTable.GetBaseSession(index, serial)!;
    return { app, gs, room, groups, close };
  } catch (error) {
    await close();
    throw error;
  }
}
function emptyInventory(p: Awaited<ReturnType<typeof read>>, count: number) {
  expect(p.Decode1()).toBe(count);
  for (let i = 0; i < count; i++) expect(p.Decode4()).toBe(0);
  p.AssertEnd();
}

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
