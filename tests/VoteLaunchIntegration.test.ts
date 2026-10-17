import { expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CipherDegree, GameStage } from "../Common/OfficialValues.ts";
import { EncodeUnregisteredDatagram } from "../Common/MTUDPProtocol.ts";
import { networkRoom, read, emptyInventory } from "./helpers/VoteNetwork.ts";
import { UDPPeer, closeUDP, closeTCP, reservePair } from "./helpers/UDP.ts";
import { ChiefSQLState } from "./helpers/WaitingChief.ts";
type Env = Awaited<ReturnType<typeof networkRoom>>;
async function selectedReady(e: Env) {
  // Map97 may enqueue color-normalization107 BEFORE any96. A same-socket209
  // barrier consumes the ACTUAL native stream, not a guessed number of107s.
  const barrier = async (index: number, allowed: readonly number[]) => {
    const g = e.groups[index]!,
      packets: Buffer[] = [];
    g.peer.Send(new CSendPacket(209));
    for (let i = 0; i < 18; i++) {
      const p = await g.peer.Read(),
        op = p.Decode1();
      if (op === 201) {
        emptyInventory(p, g.users.length);
        return packets;
      }
      expect(allowed.includes(op)).toBe(true);
      packets.push(p.m_pBlock);
    }
    throw new Error("No native setup209 barrier");
  };
  e.groups[0]!.peer.Send(new CSendPacket(97).Encode2(200));
  const mapPackets = await barrier(0, [112, 107]);
  expect(mapPackets.length).toBeGreaterThan(0);
  for (const g of e.groups.slice(1))
    for (const body of mapPackets)
      expect((await g.peer.Read()).m_pBlock).toEqual(body);
  for (let i = 1; i < e.groups.length; i++) {
    e.groups[i]!.peer.Send(new CSendPacket(96).Encode1(1));
    const packets = await barrier(i, [107]);
    expect(packets.length).toBeGreaterThan(0);
    for (let j = 0; j < e.groups.length; j++)
      if (i !== j)
        for (const body of packets)
          expect((await e.groups[j]!.peer.Read()).m_pBlock).toEqual(body);
  }
}
async function startVote(e: Env) {
  const target = e.groups[1]!.ids[0]!.GlobalSerialNo;
  e.groups[0]!.peer.Send(new CSendPacket(104).Encode4(target).Encode1(0));
  const started = await read(e.groups[0]!.peer, 114);
  expect(started.Decode1()).toBe(0);
  started.AssertEnd();
  for (const g of e.groups.slice(2)) {
    const p = await read(g.peer, 113);
    expect(p.Decode4()).toBe(target);
    expect(p.DecodeStr()).toBe(e.groups[1]!.ids[0]!.ID);
    p.AssertEnd();
  }
  return target;
}
async function launch(e: Env) {
  e.groups[0]!.peer.Send(new CSendPacket(106));
  const p = await read(e.groups[0]!.peer, 115);
  expect(p.Decode1()).toBe(0);
  p.AssertEnd();
  for (const g of e.groups) {
    let seen = false;
    for (let i = 0; i < 9; i++) {
      const q = await g.peer.Read(),
        op = q.Decode1();
      if (op === 116) {
        seen = true;
        q.Decode4();
        expect(q.Decode2()).toBe(200);
        const n = q.Decode1();
        expect(n).toBe(e.groups.flatMap((g) => g.users).length);
        for (let j = 0; j < n; j++) {
          q.Decode1();
          q.Decode1();
          q.Decode1();
          q.Decode1();
          q.Decode1();
        }
        q.AssertEnd();
        break;
      }
      expect(op).toBe(107);
    }
    expect(seen).toBe(true);
    if (
      e.app.m_itemAttr.GetAirplaneItemProbability(
        e.room.maps.GetMapTmpl(200).m_aMissionInfo[0]!,
      ) !== undefined
    )
      await read(g.peer, 173);
  }
}
async function discover(e: Env, udp: UDPPeer, index: number) {
  const g = e.groups[index]!;
  await udp.Send(
    e.gs.m_udpServer.port,
    EncodeUnregisteredDatagram(
      new CSendPacket(11, CipherDegree.None)
        .Encode4(g.ids[0]!.GlobalSerialNo)
        .Encode2(e.room.m_nIdx)
        .Encode4(e.room.m_ulSerialNo)
        .Encode4(0)
        .Encode2(0)
        .Encode4(0)
        .Encode2(0)
        .GetBuffer(),
    ),
  );
  for (const to of e.groups) await read(to.peer, 120);
}
function ready(e: Env, index: number) {
  const g = e.groups[index]!,
    p = new CSendPacket(109).Encode4(e.room.maps.GetCRC(200));
  for (const u of g.users) {
    const b = e.room.m_aBomberIdxPlaying[u.m_nSlotIdx]!;
    p.Encode1(b)
      .Encode1(e.app.m_bomberAttr.GetDefBombCount(b))
      .Encode1(e.app.m_bomberAttr.GetDefBombPower(b))
      .Encode1(e.app.m_bomberAttr.GetDefSpeed(b));
  }
  g.peer.Send(p);
}
async function nativeBegin(e: Env, indices: readonly number[]) {
  for (const i of indices) {
    const p = await read(e.groups[i]!.peer, 150);
    expect(p.Decode4()).toBe(e.room.GetGameClock().GetStartGameTime());
    p.Decode4();
    p.Decode4();
    p.Decode4();
    p.AssertEnd();
  }
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.GetResultRoundID()).toBeDefined();
}
async function setup(counts: readonly number[]) {
  const reserved = await reservePair();
  await closeTCP(reserved.tcp);
  await closeUDP(reserved.udp);
  return networkRoom(counts, "", reserved.port);
}

test("REAL TCP + UDP:issued vote survives106/116/109/150 and real162/163/UNACCELERATED164; target clears only at return,ballots retained,no private replay or clock/ready/Running injection", async () => {
  const e = await setup([1, 1, 1, 1]),
    udp = e.groups.map(() => new UDPPeer());
  try {
    await Promise.all(udp.map((p) => p.Bind()));
    await selectedReady(e);
    const target = await startVote(e),
      votes = [...e.room.m_anBanPlayerVote];
    await launch(e);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    for (let i = 0; i < e.groups.length; i++) await discover(e, udp[i]!, i);
    for (let i = 0; i < e.groups.length; i++) ready(e, i);
    await nativeBegin(e, [0, 1, 2, 3]);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    e.groups[0]!.peer.Send(new CSendPacket(162));
    for (const g of e.groups) {
      let result = false;
      for (let i = 0; i < 8; i++) {
        const p = await g.peer.Read(),
          op = p.Decode1();
        if (op === 163) {
          result = true;
          break;
        }
        expect(op).toBe(159);
      }
      expect(result).toBe(true);
    }
    expect(e.room.m_nGameState).toBe(GameStage.Result);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    const round = e.room.GetResultRoundID()!,
      receipt = e.app.m_dbSession.db
        .query("SELECT count(*) AS n FROM RuntimeGameResult")
        .get();
    expect(receipt).toEqual({ n: 1 });
    const ended = e.room.GetGameClock().GetEndGameTime();
    for (const g of e.groups) {
      const p = await g.peer.Read(CipherDegree.CRC8, 12000);
      expect(p.Decode1()).toBe(164);
      expect(p.Decode1()).toBe(0);
      p.AssertEnd();
    }
    expect(
      (e.room.GetGameClock().GetCurrentTime() - ended) >>> 0,
    ).toBeGreaterThan(8000);
    expect(e.room.m_bPlaying).toBe(false);
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
    expect(e.room.HasActiveBanPlayerVote()).toBe(false);
    expect(e.room.GetResultRoundID()).toBeUndefined();
    expect(round).not.toBe("");
    e.groups[2]!.peer.Send(new CSendPacket(105));
    e.groups[2]!.peer.Send(new CSendPacket(209));
    emptyInventory(await read(e.groups[2]!.peer, 201), 1); // no stale114 from expired vote
    await startVote(e);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    expect(e.app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(e.app.GetStatus().officialClientVerified).toBe(false);
  } finally {
    await Promise.all(udp.map((p) => closeUDP(p.socket)));
    await e.close();
  }
}, 25000);

test("REAL TCP + UDP:Loading105 kicks DUAL unready target then survivors actually start150 BEFORE114/2,private launch retained,no UDP195 or SQL awards", async () => {
  const e = await setup([1, 2, 1, 1]),
    udp = e.groups.map(() => new UDPPeer());
  try {
    await Promise.all(udp.map((p) => p.Bind()));
    await selectedReady(e);
    const target = await startVote(e),
      users = e.groups.flatMap((g) => g.users),
      sql = ChiefSQLState(e.app.m_dbSession),
      wallet = users.map((u) => u.GetDynamicInfoSnapshot());
    await launch(e);
    for (const i of [0, 2, 3]) {
      await discover(e, udp[i]!, i);
      ready(e, i);
      e.groups[i]!.peer.Send(new CSendPacket(209));
      emptyInventory(await read(e.groups[i]!.peer, 201), 1);
    }
    expect(e.room.m_nGameState).toBe(GameStage.Loading);
    expect(e.room.m_ulBanTargetSerialNo).toBe(target);
    e.groups[2]!.peer.Send(new CSendPacket(105).Encode4(target).Encode1(255));
    for (const i of [0, 2, 3]) {
      for (const [local, u] of e.groups[1]!.users.entries()) {
        const p = await read(e.groups[i]!.peer, 106);
        expect(p.Decode1()).toBe(1 + local);
        expect(p.Decode4()).toBe(u.GetGlobalSerialNo());
        p.AssertEnd();
      }
    }
    await nativeBegin(e, [0, 2, 3]);
    for (const i of [0, 2, 3]) {
      const p = await read(e.groups[i]!.peer, 114);
      expect(p.Decode1()).toBe(2);
      expect(p.DecodeStr()).toBe(e.groups[1]!.ids[0]!.ID);
      p.AssertEnd();
    }
    const victim = await read(e.groups[1]!.peer, 106);
    expect(victim.Decode1()).toBe(2);
    expect(victim.Decode4()).toBe(e.groups[1]!.ids[1]!.GlobalSerialNo);
    victim.AssertEnd();
    e.groups[1]!.peer.Send(new CSendPacket(209));
    emptyInventory(await read(e.groups[1]!.peer, 201), 2);
    expect(e.groups[1]!.users[0]!.m_pClientSocket!.m_nPoolType).toBe(
      "SessionRemoved",
    );
    expect(e.groups[1]!.users[0]!.m_pClientSocket!.IsConnected()).toBe(true);
    expect(e.room.GetCurPlayer()).toBe(3);
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.room.GetGameLaunchState().GameSequence).toBe(
      (e.room.m_ulSerialNo + 1) >>> 0,
    );
    expect(ChiefSQLState(e.app.m_dbSession)).toEqual(sql);
    expect(users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(wallet);
    expect(e.app.GetStatus().gameUpdate[0]!.pendingVoteRooms).toBe(0);
  } finally {
    await Promise.all(udp.map((p) => closeUDP(p.socket)));
    await e.close();
  }
}, 15000);
