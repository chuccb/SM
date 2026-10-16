import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CServerApp } from "../CServerApp.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import {
  CipherDegree,
  GameStage,
  DynInfoLayout,
  SlotStateMask,
} from "../Common/OfficialValues.ts";
import { EncodeUnregisteredDatagram } from "../Common/MTUDPProtocol.ts";
import { CDBMan as LoginDB } from "../LS/CDBMan.ts";
import { CDBMan as GameDB } from "../FXGS/CDBMan.ts";
import { WireClient } from "./helpers/Clients.ts";
import {
  greeting,
  login,
  transfer,
  establish,
  slotPacket,
} from "./helpers/Network.ts";
import { TestConfig } from "./helpers/Accounts.ts";
import { UDPPeer, closeUDP, closeTCP, reservePair } from "./helpers/UDP.ts";
import vectors from "./fixtures/game-launch-vectors.json";
import pickupVectors from "./fixtures/item-pickup-vectors.json";
import claimVectors from "./fixtures/game-claims-vectors.json";

type WireUser = { ID: string; GlobalSerialNo: number; GuildSn: number };
async function expectType(
  peer: WireClient,
  opcode: number,
  timeout = 3000,
): Promise<CReceivedPacketBase> {
  const packet = await peer.Read(CipherDegree.CRC8, timeout);
  expect(packet.Decode1()).toBe(opcode);
  return packet;
}
async function expectMap(peer: WireClient, index: number): Promise<void> {
  const p = await expectType(peer, 112);
  expect(p.Decode2()).toBe(index);
  p.AssertEnd();
}
function discovery(user: WireUser, index: number, serial: number): Buffer {
  return EncodeUnregisteredDatagram(
    new CSendPacket(11, CipherDegree.None)
      .Encode4(user.GlobalSerialNo)
      .Encode2(index)
      .Encode4(serial)
      .Encode4(0)
      .Encode2(0)
      .Encode4(0)
      .Encode2(0)
      .GetBuffer(),
  );
}
async function result(
  peer: WireClient,
): Promise<{ packet: CReceivedPacketBase; events: number[] }> {
  const events: number[] = [];
  for (let i = 0; i < 8; i++) {
    const p = await peer.Read(),
      opcode = p.Decode1();
    if (opcode === 163) return { packet: p, events };
    expect(opcode).toBe(159);
    events.push(p.Decode1());
  }
  throw new Error("No result after bounded native event stream");
}
/** Real registered accounts -> actual LS/GS TCP handoff -> real discovery UDP
 * ->106/109/150 ->144/145/149 pickups/event +151/152 ghosts -> client claims/death
 * ->money144 with injected SQL-ACK loss AFTER real COMMIT ->automatic400ms retry
 * ->house161/178 with separate real-COMMIT/ACK-loss automatic retry
 * ->Bula160/177 +lap155/170 +opaque146/8/159 (no rebirth inventions)
 * ->special146/0 inventory CAS/lost-ACK/Type22,209/201 ->claims/163 ->durable SQLite ->164 ->second native launch/reset ->more money +156/171.
 * ONLY storage-ack availability is injected. NO injected Running, ready bits,
 * clock, RNG, statistics, payout, timer tick or result UUID. NOT an official client. */
test("real TCP + UDP: native150 ->Bula/lap/opaque8 +special146/0/money144/house161 SQL lost-ack automatic retry ->163/SQLite/164 ->second launch/reset +money/house/aircraft ->durable reopen", async () => {
  const reserved = await reservePair(),
    dir = mkdtempSync(join(tmpdir(), "sm-network-launch-"));
  try {
    const config = TestConfig();
    config.Runtime.Database = join(dir, "game.sqlite");
    config.FXGS.UDPEnabled = true;
    config.FXGS.Channels[0]!.Port = reserved.port;
    const app = new CServerApp(config),
      peers: WireClient[] = [],
      udp = [new UDPPeer(), new UDPPeer()];
    const connect = (port: number) => {
      const peer = new WireClient(port);
      peers.push(peer);
      return peer;
    };
    let persistedKey: string | undefined,
      persistedPacket: Buffer | undefined,
      persistedSecondKey: string | undefined;
    const persistedHouse: {
      RoundID: string;
      ClaimSequence: number;
      Digest: string;
      PacketHex: string;
    }[] = [];
    const persistedMoney: {
      RoundID: string;
      ClaimSequence: number;
      Digest: string;
      PacketHex: string;
    }[] = [];
    const persistedSpecial: {
      RoundID: string;
      UseSequence: number;
      Digest: string;
      PacketHex: string;
    }[] = [];
    let persistedStockSN = 0;
    await closeTCP(reserved.tcp);
    await closeUDP(reserved.udp);
    try {
      const accounts = new LoginDB(app.m_dbSession);
      for (const ID of ["Alice", "Partner", "Bob"])
        await accounts.RegisterNewUser({
          ID,
          Password: "test-password",
          Gender: ID === "Alice" ? 1 : 0,
        });
      // Trusted fixture stock BEFORE any native TCP login/transfer load; not a
      // shop, spawn or special-item award API. Native catalog mapping remains unverified.
      const bobStock = accounts.AddInventory(
        "Bob",
        0xfedcba98,
        3,
        0,
        "opaque-description",
      );
      persistedStockSN = bobStock.SN;
      await app.SetUp();
      await Promise.all(udp.map((p) => p.Bind()));
      const gs = app.m_gameServers[0]!,
        sessions = gs.m_gameSessionTable,
        db = new GameDB(app.m_dbSession),
        lsPort = app.m_loginServer.m_listenSocket.port;
      const firstLS = connect(lsPort);
      await greeting(firstLS);
      const group = await login(firstLS, ["Alice", "Partner"]);
      const a = connect(await transfer(firstLS));
      await establish(a, group);
      a.Send(
        new CSendPacket(80)
          .EncodeStr("Actual native launch")
          .EncodeStr("")
          .Encode1(0)
          .Encode1(2)
          .Encode1(0)
          .Encode1(0),
      );
      const created = await expectType(a, 80);
      expect(created.Decode1()).toBe(0);
      const index = created.Decode2(),
        serial = created.Decode4();
      expect(created.Decode1()).toBe(0);
      created.AssertEnd();
      for (let i = 0; i < 8; i++) slotPacket(await a.Read(), i, i < 2, i < 2);
      await expectMap(a, 0xffff);
      await expectMap(a, 0xffff);
      const secondLS = connect(lsPort);
      await greeting(secondLS);
      const other = await login(secondLS, ["Bob"]);
      const b = connect(await transfer(secondLS));
      await establish(b, other, [[bobStock]]);
      await expectType(b, 83);
      b.Send(
        new CSendPacket(81)
          .Encode2(index)
          .Encode4(serial)
          .EncodeStr("")
          .Encode1(1)
          .Encode1(1),
      );
      const joined = await expectType(b, 81);
      expect(joined.Decode1()).toBe(0);
      joined.AssertEnd();
      for (let i = 0; i < 8; i++) slotPacket(await b.Read(), i, i < 3, i === 2);
      await expectMap(b, 0xffff);
      await expectMap(b, 0xffff);
      await expectType(b, 93);
      slotPacket(await a.Read(), 2, true, true);
      const room = sessions.GetBaseSession(index, serial)!;
      expect(room.GetCurPlayer()).toBe(3);
      expect(room.GetResultRoundID()).toBeUndefined();
      const map = app.m_gameMapTmplList.m_aMapTmpl.findIndex(
        (m) => m.m_strName === "Village01",
      );
      expect(map).toBe(200);
      a.Send(new CSendPacket(97).Encode2(map));
      for (const peer of [a, b]) {
        await expectMap(peer, map);
        // Native waiting-map changes publish ALL occupied107, even unchanged.
        for (let slot = 0; slot < 3; slot++) {
          const p = await expectType(peer, 107);
          expect(p.Decode1()).toBe(slot);
          p.DecodeBuffer(3);
          p.AssertEnd();
        }
      }
      const airplane = vectors.Starts.find((row) => row.Map === map)!.Airplane;
      const clients = [a, b],
        bomberBySlot = [0, 0, 1],
        colors = [0, 0, 2];
      const ready = (peer: WireClient, slots: number[]) => {
        const packet = new CSendPacket(109).Encode4(
          app.m_gameMapTmplList.GetCRC(map),
        );
        for (const slot of slots) {
          const bomber = bomberBySlot[slot]!;
          packet
            .Encode1(bomber)
            .Encode1(app.m_bomberAttr.GetDefBombCount(bomber))
            .Encode1(app.m_bomberAttr.GetDefBombPower(bomber))
            .Encode1(app.m_bomberAttr.GetDefSpeed(bomber));
        }
        peer.Send(packet);
      };
      const selectReady = async () => {
        b.Send(new CSendPacket(96).Encode1(1));
        for (const peer of clients) {
          const p = await expectType(peer, 107);
          expect(p.Decode1()).toBe(2);
          expect(p.DecodeBuffer(3)[0]! & SlotStateMask.Status).toBe(
            SlotStateMask.Ready,
          );
          p.AssertEnd();
        }
      };
      const beginLoading = async () => {
        a.Send(new CSendPacket(106));
        const ack = await expectType(a, 115);
        expect(ack.Decode1()).toBe(0);
        ack.AssertEnd();
        let launchBody: Buffer | undefined;
        for (const peer of clients) {
          const p = await expectType(peer, 116);
          const tick = p.Decode4();
          expect(Number.isInteger(tick)).toBe(true);
          expect(p.Decode2()).toBe(map);
          expect(p.Decode1()).toBe(3);
          const positions: number[] = [];
          for (let slot = 0; slot < 3; slot++) {
            expect(p.Decode1()).toBe(slot);
            expect(p.Decode1()).toBe(0);
            const spawn = p.Decode1();
            expect(spawn).toBeLessThan(8);
            positions.push(spawn);
            expect(p.Decode1()).toBe(bomberBySlot[slot]!);
            expect(p.Decode1()).toBe(colors[slot]!);
          }
          expect(new Set(positions).size).toBe(3);
          p.AssertEnd();
          if (launchBody) expect(p.m_pBlock).toEqual(launchBody);
          else launchBody = Buffer.from(p.m_pBlock);
          const prob = await expectType(peer, 173);
          expect(prob.m_pBlock.toString("hex")).toBe(airplane);
        }
        expect(room.m_nGameState).toBe(GameStage.Loading);
        expect(room.GetResultRoundID()).toBeUndefined();
        expect(sessions.GetLoadingSessionCount()).toBe(1);
        expect(sessions.GetScheduledRoundCount()).toBe(0);
      };
      const beginRunning = async (sequence: number) => {
        const key = room.GetGameLaunchState().GameSequenceKey;
        let body: Buffer | undefined;
        for (const peer of clients) {
          const p = await expectType(peer, 150);
          expect(p.Decode4()).toBe(room.GetGameClock().GetStartGameTime());
          expect(p.Decode4()).toBe((sequence ^ key) >>> 0);
          expect(p.Decode4()).toBe(0);
          expect(p.Decode4()).toBe(0);
          p.AssertEnd();
          if (body) expect(p.m_pBlock).toEqual(body);
          else body = Buffer.from(p.m_pBlock);
        }
        expect(room.m_nGameState).toBe(GameStage.Running);
        expect(sessions.GetLoadingSessionCount()).toBe(0);
        expect(sessions.GetScheduledRoundCount()).toBe(1);
        expect(room.GetGameLaunchState().GameSequence).toBe(
          (sequence + 1) >>> 0,
        );
        return room.GetResultRoundID()!;
      };
      await selectReady();
      await beginLoading();
      ready(a, [0, 1]);
      ready(b, [2]);
      // Per-socket RTT responses are actual TCP queue barriers after109, NOT a
      // sleep, fake readiness ACK, trusted timer invocation or state mutation.
      for (const [i, peer] of clients.entries())
        peer.Send(
          new CSendPacket(20).Encode4(0x11220000 + i).Encode4(0x11221122),
        );
      for (const [i, peer] of clients.entries()) {
        const p = await expectType(peer, 20);
        expect(p.Decode4()).toBe(0x11220000 + i);
        p.Decode4();
        p.AssertEnd();
      }
      expect(room.IsAllPlayerReadyForStart()).toBe(false);
      expect(room.GetResultRoundID()).toBeUndefined();
      const peerInfo = async (peer: WireClient, allDiscovered: boolean) => {
        const p = await expectType(peer, 120);
        // Eight occupancy flags, NOT a discovered-player count or primary count.
        for (let slot = 0; slot < 8; slot++) {
          expect(p.Decode1()).toBe(slot < 3 ? 1 : 0);
          if (slot >= 3) continue;
          const expectedPort =
            slot < 2 ? udp[0]!.port : allDiscovered ? udp[1]!.port : 0;
          for (let host = 0; host < 3; host++) {
            expect(p.Decode4()).toBe(
              host === 0 && expectedPort ? 0x7f000001 : 0,
            );
            expect(p.Decode2()).toBe(host === 0 ? expectedPort : 0);
          }
          expect(p.Decode4()).toBe(room.GetPlayerJoinTime(slot));
        }
        p.AssertEnd();
      };
      await udp[0]!.Send(
        gs.m_udpServer.port,
        discovery(group[0]!, index, serial),
      );
      for (const peer of clients) await peerInfo(peer, false);
      expect(room.HasUDPPeerInfo(0)).toBe(true);
      expect(room.HasUDPPeerInfo(1)).toBe(true);
      expect(room.HasUDPPeerInfo(2)).toBe(false);
      expect(room.GetResultRoundID()).toBeUndefined();
      await udp[1]!.Send(
        gs.m_udpServer.port,
        discovery(other[0]!, index, serial),
      );
      for (const peer of clients) await peerInfo(peer, true);
      const firstKey = await beginRunning(serial),
        firstState = room.GetGameLaunchState();
      const ctx = room.GetCurrentGameContext();
      // All publication/duplicate assertions use per-socket TCP RTT barriers,
      // never a sleep, manual timer tick, synthetic Running or claimed ACK.
      let barrierSerial = 0x22440000;
      const barrier = async () => {
        const marker = barrierSerial;
        barrierSerial += 2;
        for (const [i, peer] of clients.entries())
          peer.Send(
            new CSendPacket(20).Encode4(marker + i).Encode4(0x11221122),
          );
        for (const [i, peer] of clients.entries()) {
          const p = await expectType(peer, 20);
          expect(p.Decode4()).toBe(marker + i);
          p.Decode4();
          p.AssertEnd();
        }
      };
      const expectFields = async (
        opcode: number,
        fields: readonly number[],
      ) => {
        for (const peer of clients) {
          const p = await expectType(peer, opcode);
          expect(
            Array.from({ length: fields.length }, () => p.Decode1()),
          ).toEqual([...fields]);
          p.AssertEnd();
        }
      };
      const pickup = async (
        peer: WireClient,
        slot: number,
        box: number,
        item: number,
      ) => {
        peer.Send(
          new CSendPacket(144).Encode1(slot).Encode1(box).Encode1(item),
        );
        await expectFields(156, [slot, box, item]);
      };
      const moneyPickup = async (
        peer: WireClient,
        slot: number,
        box: number,
        item: number,
      ) => {
        peer.Send(
          new CSendPacket(144).Encode1(slot).Encode1(box).Encode1(item),
        );
        await expectFields(156, [slot, box, item, 1]); // authenticated fixtures have native authencode BYTE0
      };
      const initialUsers = room.m_rgPlayer.map(
        (user) =>
          user && {
            Dynamic: user.GetDynamicInfoSnapshot().Dynamic,
            Inventory: structuredClone(user.m_aInventory),
          },
      );
      expect([...ctx.m_aBoxItemState]).toEqual(Array(250).fill(0));
      expect([...ctx.m_aObstacleState]).toEqual(Array(195).fill(0));
      await pickup(a, 1, 249, 70); // SECOND local actor, real resource endpoint
      expect(ctx.m_aBoxItemState[249]).toBe(1);
      b.Send(new CSendPacket(144).Encode1(2).Encode1(249).Encode1(0));
      b.Send(new CSendPacket(144).Encode1(2).Encode1(249).Encode1(25));
      // Claimed boxes suppress even money BEFORE RNG or any persistence attempt.
      await barrier(); // no extra156/error/disconnect for either duplicate
      a.Send(new CSendPacket(145).Encode1(1).Encode1(0x0f));
      await expectFields(157, [1, 0x0f]);
      expect(ctx.m_aObstacleState[15]).toBe(1);
      b.Send(new CSendPacket(145).Encode1(2).Encode1(0x10));
      await barrier(); // same FLAT index15; no invented col15 rejection/extra157
      for (const [peer, self, reference] of [
        [
          a,
          1,
          pickupVectors.Events.find(
            (r) =>
              r.Name === "Partner" && r.LabelHex === "4c75636369506f636b657430",
          )!,
        ],
        [
          b,
          0,
          pickupVectors.Events.find(
            (r) =>
              r.Name === "Bob" && r.LabelHex === "4c75636369506f636b657430",
          )!,
        ],
      ] as const) {
        peer.Send(new CSendPacket(149).Encode1(self).EncodeStr("LucciPocket0"));
        for (const receiver of clients) {
          const p = await expectType(receiver, 30);
          expect(p.m_pBlock.toString("hex")).toBe(reference.Response);
          // Raw native CP949 suffix must NOT be decoded/re-encoded as Big5.
          expect(p.DecodeStrBytes()).toEqual(
            Buffer.from(reference.Response, "hex").subarray(3),
          );
          p.AssertEnd();
        }
      }
      a.Send(new CSendPacket(149).Encode1(2));
      b.Send(new CSendPacket(149).Encode1(2)); // room slot2 is NOT Bob's local0
      await barrier(); // invalid local self returns BEFORE missing label decode
      expect(
        room.m_rgPlayer.map(
          (user) =>
            user && {
              Dynamic: user.GetDynamicInfoSnapshot().Dynamic,
              Inventory: structuredClone(user.m_aInventory),
            },
        ),
      ).toEqual(initialUsers);
      for (const name of ["Alice", "Partner", "Bob"])
        expect(db.GetUserInfo(name)!.Money).toBe(0);
      // Native160's first BYTE is a stored STATE, not an actor. Bob can send
      //255; raw(0,45) aliases(1,0). Echo repeats and include the sending TCP.
      b.Send(
        new CSendPacket(160)
          .Encode1(255)
          .Encode1(3)
          .Encode1(0)
          .Encode1(45)
          .Encode1(25)
          .Encode1(44)
          .Encode1(1)
          .Encode1(0),
      );
      await expectFields(177, [3, 0, 45, 255, 25, 44, 255, 1, 0, 255]);
      expect(ctx.m_aBulaState[45]).toBe(255);
      expect(ctx.m_aBulaState[1169]).toBe(255);
      a.Send(new CSendPacket(160).Encode1(7).Encode1(0));
      await expectFields(177, [0]); // count0 still emits177, not a suppressed claim
      expect(ctx.m_aBulaState[45]).toBe(255);
      // Native155 intentionally permits reports about another peer's slot.
      // No clock/RNG override: the stored tick must lie in the observed window.
      const beforeLapTick = room.GetGameClock().GetCurrentTime();
      b.Send(new CSendPacket(155).Encode1(1).Encode1(128).Encode1(255));
      const lapFields = [1, 2, 0, 1, 128, 3, 0, ...Array(10).fill(255)];
      await expectFields(170, lapFields);
      const reportTick = room.GetGameLaunchState().LapSort[2]!;
      expect((reportTick - beforeLapTick) >>> 0).toBeLessThanOrEqual(
        (room.GetGameClock().GetCurrentTime() - beforeLapTick) >>> 0,
      );
      expect(room.GetGameLaunchState().LapSort[3]).toBe(0x7f00);
      // A vacant target writes its sort/prefix but is NOT counted or displayed.
      a.Send(new CSendPacket(155).Encode1(7).Encode1(255).Encode1(255));
      await expectFields(170, lapFields);
      expect(room.GetGameLaunchState().LapPrefix[7]).toBe(255);
      const firstLapImage = room.GetGameLaunchState();
      // Case8's two opaque fields are both echoed. Native excludes ALL of
      //Bob's TCP, and does not change state/ghost/time or perform resurrection.
      const event8Image = claimVectors.OpaqueEvents.find(
        (row) => row.Slot === 2 && row.First === 255 && row.Second === 128,
      )!;
      b.Send(
        new CSendPacket(146)
          .Encode1(0x82)
          .Encode2(0xffff)
          .Encode2(0x8080)
          .Encode1(255)
          .Encode1(128),
      );
      const opaque8 = await expectType(a, 159);
      expect(opaque8.m_pBlock.toString("hex")).toBe(event8Image.Response);
      expect([
        opaque8.Decode1(),
        opaque8.Decode2(),
        opaque8.Decode2(),
        opaque8.Decode1(),
        opaque8.Decode1(),
      ]).toEqual([0x82, 0xffff, 0x8080, 255, 128]);
      opaque8.AssertEnd();
      await barrier(); // Bob must not receive159; neither local actor was revived
      expect([...room.m_aPlayerState].slice(0, 3)).toEqual([0, 0, 0]);
      expect(room.GetGameLaunchState().LapSort).toEqual(firstLapImage.LapSort);
      for (const name of ["Alice", "Partner", "Bob"])
        expect(db.GetUserInfo(name)!.Money).toBe(0);
      // Native201 is a READ-ONLY resident snapshot even in a frozen round.
      // Seeded before connection, genuinely loaded by CConnectPool: no live
      // inventory injection, item ownership/spawn invention or clock override.
      const inventory = async (amount: number) => {
        b.Send(new CSendPacket(209));
        const p = await expectType(b, 201);
        expect(p.Decode1()).toBe(1);
        expect(p.Decode4()).toBe(1);
        expect(p.Decode4()).toBe(bobStock.SN);
        expect(p.Decode1()).toBe(bobStock.Slot);
        expect(p.Decode4()).toBe(amount);
        expect(p.DecodeStr()).toBe("opaque-description");
        expect(p.DecodeBuffer(8).readDoubleLE()).toBe(0);
        p.AssertEnd();
      };
      const special = (slot: number, index: number, quantity: number) => {
        const p = new CSendPacket(146)
          .Encode1(slot)
          .Encode2(0x80ff)
          .Encode2(0xff80)
          .Encode1(90)
          .Encode1(index)
          .Encode1(quantity);
        if (quantity) p.Encode4(bobStock.SN);
        return p;
      };
      const expectSpecial = async (
        peer: WireClient,
        slot: number,
        index: number,
        quantity: number,
      ) => {
        const p = await expectType(peer, 159);
        expect([
          p.Decode1(),
          p.Decode2(),
          p.Decode2(),
          p.Decode1(),
          p.Decode1(),
          p.Decode1(),
        ]).toEqual([slot, 0x80ff, 0xff80, 90, index, quantity]);
        p.AssertEnd(); // inventory SN is deliberately NOT echoed
      };
      await inventory(3);
      // Qty0 does not need a row; Alice's SECOND local actor is legal, and the
      // entire two-user Alice TCP is excluded (only Bob receives the159).
      a.Send(special(1, 44, 0));
      await expectSpecial(b, 1, 44, 0);
      await barrier();
      expect(room.m_aShopItemAttempted[1]).toBe(0);
      expect(
        room.m_dynInfoCalculator
          .GetStateBytes()
          .readInt32LE((DynInfoLayout.Nice + 1) * 4),
      ).toBe(0);
      expect(room.GetSpecialItemUseState().Sequence).toBe(0);
      b.Send(new CSendPacket(146).Encode1(0x22).Encode2(12345).Encode2(54321));
      const pendingDie = await expectType(a, 159);
      expect([
        pendingDie.Decode1(),
        pendingDie.Decode2(),
        pendingDie.Decode2(),
      ]).toEqual([0x22, 12345, 54321]);
      pendingDie.AssertEnd();
      await barrier();
      expect(room.m_aPlayerState[2]).toBe(3);
      const oldSpecialTime = ctx.m_aPlayerStateTime[2]!,
        originalSpecial = GameDB.prototype.CommitSpecialItemUse,
        specialObserved = Promise.withResolvers<void>(),
        specialPlans: string[] = [];
      let releaseSpecialAck = false,
        firstSpecialWrite = true,
        frozenSpecialLastUpdate = 0,
        specialDeadline: ReturnType<typeof setTimeout> | undefined;
      GameDB.prototype.CommitSpecialItemUse = function (input) {
        if (input.RoundID !== firstKey || input.UseSequence !== 1)
          return originalSpecial.call(this, input);
        specialPlans.push(
          JSON.stringify({
            ...input,
            Packet: Buffer.from(input.Packet).toString("hex"),
          }),
        );
        if (!firstSpecialWrite && !releaseSpecialAck) return "conflict";
        const result = originalSpecial.call(this, input);
        if (firstSpecialWrite) {
          firstSpecialWrite = false;
          specialObserved.resolve();
          throw new Error(
            "fixture TCP special lost ACK AFTER actual root COMMIT",
          );
        }
        return result;
      };
      try {
        b.Send(special(2, 45, 2));
        await Promise.race([
          specialObserved.promise,
          new Promise<never>((_, reject) => {
            specialDeadline = setTimeout(
              () => reject(new Error("special commit observation timeout")),
              3000,
            );
          }),
        ]);
        frozenSpecialLastUpdate = room.GetLastUpdateTime();
        expect(db.GetInventoryRecord(bobStock.SN)!.Amount).toBe(1);
        expect(room.m_rgPlayer[2]!.GetUserInventory(bobStock.SN)!.Amount).toBe(
          3,
        );
        expect(room.m_rgPlayer[2]!.IsInventoryModified(bobStock.SN)).toBe(0);
        expect(room.m_aShopItemAttempted[2]).toBe(0);
        expect(
          room.m_dynInfoCalculator
            .GetStateBytes()
            .readInt32LE((DynInfoLayout.Nice + 2) * 4),
        ).toBe(0);
        expect(ctx.m_aPlayerStateTime[2]).toBe(oldSpecialTime);
        expect(ctx.m_aGhostPosition[2]).toEqual({ x: 12345, y: 54321 });
        expect(room.GetSpecialItemUseState().Pending).toBe(true);
        expect(sessions.GetPendingSpecialItemUseCount()).toBe(1);
        expect(app.GetStatus().gameUpdate[0]!.pendingSpecialItemUses).toBe(1);
        expect(db.GetSpecialItemUseReceipt(firstKey, 1)).toBeDefined();
        await inventory(3); // SQL is already1; until ACK recovery resident201 MUST still say3
        releaseSpecialAck = true;
        await expectSpecial(a, 2, 45, 2);
      } finally {
        if (specialDeadline !== undefined) clearTimeout(specialDeadline);
        GameDB.prototype.CommitSpecialItemUse = originalSpecial;
      }
      expect(specialPlans.length).toBeGreaterThanOrEqual(2);
      expect(new Set(specialPlans).size).toBe(1);
      const specialReceipt = db.GetSpecialItemUseReceipt(firstKey, 1)!,
        specialData = JSON.parse(specialReceipt.Payload);
      expect(specialData.AfterAmount).toBe(1);
      expect(specialData.Request.InventorySN).toBe(bobStock.SN);
      expect(ctx.m_aPlayerStateTime[2]).toBe(specialData.RefreshStateTime);
      expect(
        (specialData.RefreshStateTime - oldSpecialTime) >>> 0,
      ).toBeLessThan(3000);
      expect(room.GetLastUpdateTime()).toBe(frozenSpecialLastUpdate); // retry tick never consumes a world delta
      expect(room.m_aPlayerState[2]).toBe(3);
      expect(ctx.m_aGhostPosition[2]).toEqual({ x: 12345, y: 54321 });
      expect(room.m_aShopItemAttempted[2]).toBe(1);
      expect(
        room.m_dynInfoCalculator
          .GetStateBytes()
          .readInt32LE((DynInfoLayout.Nice + 2) * 4),
      ).toBe(1);
      expect(room.m_rgPlayer[2]!.IsInventoryModified(bobStock.SN)).toBe(1);
      expect(room.GetSpecialItemUseState().Sequence).toBe(1);
      expect(app.GetStatus().gameUpdate[0]!.pendingSpecialItemUses).toBe(0);
      await inventory(1);
      await barrier(); // no159 to sender, no duplicate broadcast on any retry
      // The injected fault class is storage ACK availability: SQLite commits5000, but its first ACK is
      // lost. Keep storage unavailable until the pending state is observed;
      // thereafter the REAL400ms driver (never a manual tick) must replay the
      // SAME receipt and publish exactly one4-field156 to each live TCP peer.
      const originalMoneyCommit = GameDB.prototype.CommitMoneyPickup,
        observed = Promise.withResolvers<void>(),
        plans: string[] = [];
      let releaseAck = false,
        firstWrite = true;
      GameDB.prototype.CommitMoneyPickup = function (input) {
        if (input.RoundID !== firstKey || input.ClaimSequence !== 1)
          return originalMoneyCommit.call(this, input);
        plans.push(
          JSON.stringify({
            ...input,
            Packet: Buffer.from(input.Packet).toString("hex"),
          }),
        );
        if (!firstWrite && !releaseAck) return "conflict";
        const status = originalMoneyCommit.call(this, input);
        if (firstWrite) {
          firstWrite = false;
          observed.resolve();
          throw new Error("fixture TCP money lost ACK after real COMMIT");
        }
        return status;
      };
      let ackDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        a.Send(new CSendPacket(144).Encode1(1).Encode1(248).Encode1(31));
        await Promise.race([
          observed.promise,
          new Promise<never>((_, reject) => {
            ackDeadline = setTimeout(
              () => reject(new Error("Money commit observation timeout")),
              3000,
            );
          }),
        ]);
        expect(db.GetUserInfo("Partner")!.Money).toBe(5000);
        expect(room.m_rgPlayer[1]!.m_userInfo.Money).toBe(0);
        expect(ctx.m_aBoxItemState[248]).toBe(0);
        expect(room.GetMoneyPickupState().Pending).toBe(true);
        expect(room.GetMoneyPickupState().Sequence).toBe(0);
        expect(sessions.GetPendingMoneyPickupCount()).toBe(1);
        expect(app.GetStatus().gameUpdate[0]!.pendingMoneyPickups).toBe(1);
        expect(db.GetMoneyPickupReceipt(firstKey, 1)).toBeDefined();
        releaseAck = true;
        await expectFields(156, [1, 248, 31, 1]);
      } finally {
        if (ackDeadline !== undefined) clearTimeout(ackDeadline);
        GameDB.prototype.CommitMoneyPickup = originalMoneyCommit;
      }
      expect(plans.length).toBeGreaterThanOrEqual(2);
      expect(new Set(plans).size).toBe(1);
      expect(room.m_rgPlayer[1]!.m_userInfo.Money).toBe(5000);
      expect(ctx.m_aBoxItemState[248]).toBe(1);
      expect(app.GetStatus().gameUpdate[0]!.pendingMoneyPickups).toBe(0);
      await moneyPickup(b, 2, 247, 25);
      expect(db.GetUserInfo("Bob")!.Money).toBe(10);
      await moneyPickup(b, 2, 246, 32);
      expect(db.GetUserInfo("Bob")!.Money).toBe(0);
      expect(
        JSON.parse(db.GetMoneyPickupReceipt(firstKey, 3)!.Payload).Before.Money,
      ).toBe(10);
      expect(
        JSON.parse(db.GetMoneyPickupReceipt(firstKey, 3)!.Payload).After.Money,
      ).toBe(0);
      a.Send(new CSendPacket(144).Encode1(0).Encode1(248).Encode1(32));
      b.Send(new CSendPacket(144).Encode1(2).Encode1(248).Encode1(31));
      await barrier(); // neither duplicate may pay OR produce another156
      expect(room.GetMoneyPickupState().Sequence).toBe(3);
      expect(sessions.GetPendingMoneyPickupCount()).toBe(0);
      expect(ctx.m_nNextBoxItem).toBe(126);
      // Independent house receipt: real SQL credits Alice10, but an injected
      // ACK loss freezes board/counts/allocator/live money. No clock/RNG/gameplay
      // injection: release permits the REAL400ms driver to install exact178.
      const originalHouseCommit = GameDB.prototype.CommitHouseClaim,
        houseObserved = Promise.withResolvers<void>(),
        housePlans: string[] = [];
      let releaseHouseAck = false,
        firstHouseWrite = true;
      GameDB.prototype.CommitHouseClaim = function (input) {
        if (input.RoundID !== firstKey || input.ClaimSequence !== 1)
          return originalHouseCommit.call(this, input);
        housePlans.push(
          JSON.stringify({
            ...input,
            Packet: Buffer.from(input.Packet).toString("hex"),
          }),
        );
        if (!firstHouseWrite && !releaseHouseAck) return "conflict";
        const status = originalHouseCommit.call(this, input);
        if (firstHouseWrite) {
          firstHouseWrite = false;
          houseObserved.resolve();
          throw new Error("fixture TCP house lost ACK after real COMMIT");
        }
        return status;
      };
      let houseDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        a.Send(
          new CSendPacket(161)
            .Encode1(0)
            .Encode1(5)
            .Encode1(0)
            .Encode1(0)
            .Encode1(12)
            .Encode1(14)
            .Encode1(0)
            .Encode1(0)
            .Encode1(13)
            .Encode1(0)
            .Encode1(0)
            .Encode1(15)
            .Encode1(1)
            .Encode1(255)
            .Encode1(128)
            .Encode1(90),
        );
        await Promise.race([
          houseObserved.promise,
          new Promise<never>((_, reject) => {
            houseDeadline = setTimeout(
              () => reject(new Error("House commit observation timeout")),
              3000,
            );
          }),
        ]);
        expect(db.GetUserInfo("Alice")!.Money).toBe(10);
        expect(room.m_rgPlayer[0]!.m_userInfo.Money).toBe(0);
        expect(ctx.m_aHouseState[0]).toBe(-1);
        expect(ctx.m_aHouseState[194]).toBe(-1);
        expect(ctx.m_nNextBoxItem).toBe(126);
        expect(room.GetHouseClaimState().Pending).toBe(true);
        expect(sessions.GetPendingHouseClaimCount()).toBe(1);
        expect(app.GetStatus().gameUpdate[0]!.pendingHouseClaims).toBe(1);
        expect(db.GetHouseClaimReceipt(firstKey, 1)).toBeDefined();
        releaseHouseAck = true;
        await expectFields(178, [0, 2, 0, 0, 12, 14, 5, 1, 255, 126, 128, 90]);
      } finally {
        if (houseDeadline !== undefined) clearTimeout(houseDeadline);
        GameDB.prototype.CommitHouseClaim = originalHouseCommit;
      }
      expect(housePlans.length).toBeGreaterThanOrEqual(2);
      expect(new Set(housePlans).size).toBe(1);
      expect(room.m_rgPlayer[0]!.m_userInfo.Money).toBe(10);
      expect(ctx.m_aHouseState[0]).toBe(0);
      expect(ctx.m_aHouseState[194]).toBe(0);
      expect(ctx.m_aHouseCount[colors[0]!]).toBe(2);
      expect(ctx.m_nNextBoxItem).toBe(127);
      expect(ctx.m_aBoxItemState[126]).toBe(0);
      expect(room.GetHouseClaimState().Sequence).toBe(1);
      expect(sessions.GetPendingHouseClaimCount()).toBe(0);
      a.Send(
        new CSendPacket(161)
          .Encode1(0)
          .Encode1(2)
          .Encode1(0)
          .Encode1(0)
          .Encode1(12)
          .Encode1(14)
          .Encode1(0),
      );
      await expectFields(178, [0, 0, 5, 0]); // No new cells: native dirty/no-op wallet, new house ordinal2.
      expect(db.GetUserInfo("Alice")!.Money).toBe(10);
      expect(room.GetHouseClaimState().Sequence).toBe(2);
      expect(room.GetMoneyPickupState().Sequence).toBe(3);
      await barrier();
      expect(db.GetGameResultReceipt(firstKey)).toBeUndefined();
      expect(room.GetUDPPeerHosts(0)[0]!.Port).toBe(udp[0]!.port);
      expect(room.GetUDPPeerHosts(1)).toEqual(room.GetUDPPeerHosts(0));
      expect(room.GetUDPPeerHosts(2)[0]!.Port).toBe(udp[1]!.port);
      expect(app.GetStatus().gameUpdate[0]!.launchEnabled).toBe(true);
      expect(app.GetStatus().gameUpdate[0]!.loadingRooms).toBe(0);
      expect(app.GetStatus().completeOfficialRewrite).toBe(false);
      expect(app.GetStatus().officialClientVerified).toBe(false);
      expect(db.GetGameResultReceipt(firstKey)).toBeUndefined();
      // Real requests after actual native150. Village ghost frequency0 is NOT
      // disabled, and native has no dead-state/RebirthMap gate in151.
      expect(firstState.RebirthMap).toBe(false);
      const generated = async (slot: number, parameter: number) => {
        a.Send(new CSendPacket(151).Encode1(parameter).Encode1(slot));
        for (const peer of clients) {
          const p = await expectType(peer, 166);
          expect(p.Decode1()).toBe(0);
          expect(p.Decode1()).toBe(slot | 0x80);
          expect(p.Decode1()).toBe(parameter);
          p.AssertEnd();
        }
      };
      await generated(1, 255);
      expect(room.m_anSlotGhost[1]).toBe(0);
      expect(room.m_nGhostCount).toBe(1);
      const generatedTick = room.GetGameLaunchState().LastGhostTime;
      // Bob is NOT the owner; native152 deliberately allows same-room destroy.
      b.Send(new CSendPacket(152).Encode1(0));
      for (const peer of clients) {
        const p = await expectType(peer, 167);
        expect(p.Decode1()).toBe(0);
        p.AssertEnd();
      }
      expect(room.m_anSlotGhost[1]).toBe(-1);
      expect(room.m_anGhostSlot[0]).toBe(-1);
      expect(room.m_nGhostCount).toBe(0);
      expect(room.GetGameLaunchState().LastGhostTime).toBe(generatedTick);
      await generated(0, 0);
      expect(room.m_nGhostCount).toBe(1);
      const finalGhostTick = room.GetGameLaunchState().LastGhostTime;
      expect(db.GetGameResultReceipt(firstKey)).toBeUndefined();
      a.Send(new CSendPacket(146).Encode1(0x60).Encode2(0).Encode2(0));
      a.Send(new CSendPacket(146).Encode1(0x61).Encode2(0).Encode2(0));
      b.Send(
        new CSendPacket(146)
          .Encode1(0x42)
          .Encode2(0)
          .Encode2(0)
          .Encode1(255)
          .Encode1(0),
      );
      const [aResult, bResult] = await Promise.all(clients.map(result));
      expect(aResult!.events).toEqual([0x42]);
      expect(bResult!.events.sort((x, y) => x - y)).toEqual([0x42, 0x60, 0x61]);
      expect(aResult!.packet.m_pBlock).toEqual(bResult!.packet.m_pBlock);
      expect(
        Array.from({ length: 5 }, () => aResult!.packet.Decode1()),
      ).toEqual([0, 0, 0, 0, 1]); // Bob's REAL losing-team paid use, not a fabricated shop flag
      const receipt = db.GetGameResultReceipt(firstKey)!;
      expect(receipt).toBeDefined();
      expect(receipt.Packet).toEqual(aResult!.packet.m_pBlock);
      const payload = JSON.parse(receipt.Payload);
      expect(payload.WinningColor).toBe(0);
      expect(payload.Reason).toBe("claims");
      expect(payload.CountedSlots).toEqual([0, 1, 2]);
      expect(payload.InvalidGame).toBe(false);
      expect(payload.StartTick).toBe(room.GetGameClock().GetStartGameTime());
      expect(room.m_nGameState).toBe(GameStage.Result);
      expect(sessions.GetPendingResultCount()).toBe(0);
      expect(sessions.GetUpdateFailures()).toEqual([]);
      for (const ID of ["Alice", "Partner", "Bob"]) {
        const u = db.GetUserInfo(ID)!;
        expect(u.Exp).toBe(0);
        expect(u.Money).toBe(ID === "Partner" ? 5000 : ID === "Alice" ? 10 : 0);
        expect([u.Win, u.Draw, u.Lose]).toEqual(
          ID === "Bob" ? [0, 0, 1] : [1, 0, 0],
        );
      }
      for (const change of payload.Changes)
        expect([change.Before.Money, change.After.Money]).toEqual(
          change.Slot === 1
            ? [5000, 5000]
            : change.Slot === 0
              ? [10, 10]
              : [0, 0],
        );
      expect(room.GetMoneyPickupState().Sequence).toBe(3);
      persistedKey = firstKey;
      persistedPacket = Buffer.from(receipt.Packet);
      for (const peer of clients) {
        const p = await expectType(peer, 164, 12000);
        expect(p.Decode1()).toBe(0);
        p.AssertEnd();
      }
      expect(room.m_bPlaying).toBe(false);
      expect(room.m_nGameState).toBe(GameStage.Loading);
      expect(room.GetResultRoundID()).toBeUndefined();
      expect(room.m_nMapIdx).toBe(map);
      expect(room.m_nMapIdxPlaying).toBe(-1);
      expect([...room.m_aBomberIdxPlaying]).toEqual(Array(8).fill(-1));
      expect(room.GetGameLaunchState().NativeLaunch).toBe(false);
      expect([ctx.m_aBulaState[45], ctx.m_aBulaState[1169]]).toEqual([
        255, 255,
      ]);
      expect(room.GetGameLaunchState().LapSort).toEqual(firstLapImage.LapSort);
      expect(room.GetGameLaunchState().LapPrefix).toEqual(
        firstLapImage.LapPrefix,
      );
      expect(room.m_nGhostCount).toBe(1);
      expect(room.m_anSlotGhost[0]).toBe(0);
      expect(room.GetGameLaunchState().LastGhostTime).toBe(finalGhostTick);
      expect(sessions.GetScheduledRoundCount()).toBe(0);
      expect([ctx.m_aBoxItemState[249], ctx.m_aObstacleState[15]]).toEqual([
        1, 1,
      ]);
      expect(
        [246, 247, 248, 249].map((box) => ctx.m_aBoxItemState[box]),
      ).toEqual([1, 1, 1, 1]);
      // Launch again solely via wire96/106/109. Native peers survive; NO second
      // discovery, state injection, clock manipulation, UUID or calculator hook.
      await selectReady();
      await beginLoading();
      // Native context Init is in106/LaunchGameStage, already BEFORE150.
      expect([...ctx.m_aBulaState]).toEqual(Array(1170).fill(-1));
      expect(room.GetGameLaunchState().LapSort).toEqual(
        Array(16).fill(0xffffffff),
      );
      expect(room.GetGameLaunchState().LapPrefix).toEqual(Array(8).fill(0));
      expect([...ctx.m_aHouseState]).toEqual(Array(195).fill(-1));
      expect([...ctx.m_aHouseCount]).toEqual(Array(8).fill(0));
      expect(ctx.m_nNextBoxItem).toBe(126);
      expect([...ctx.m_aBoxItemState]).toEqual(Array(250).fill(0));
      expect([...ctx.m_aObstacleState]).toEqual(Array(195).fill(0));
      ready(a, [0, 1]);
      ready(b, [2]);
      const secondKey = await beginRunning((serial + 1) >>> 0);
      persistedSecondKey = secondKey;
      expect(room.GetMoneyPickupState().Sequence).toBe(0);
      expect(secondKey).not.toBe(firstKey);
      expect(room.GetSpecialItemUseState().Sequence).toBe(0);
      expect(room.m_aShopItemAttempted[2]).toBe(0);
      expect(
        room.m_dynInfoCalculator
          .GetStateBytes()
          .readInt32LE((DynInfoLayout.Nice + 2) * 4),
      ).toBe(0);
      expect(room.m_rgPlayer[2]!.GetUserInventory(bobStock.SN)!.Amount).toBe(1);
      // Same resident SN, NEW UUID/ordinal1: final paid use really deletes SQL,
      // while native resident amount0 remains visible in201 until a reload.
      b.Send(special(2, 69, 1));
      await expectSpecial(a, 2, 69, 1);
      await barrier();
      expect(room.GetSpecialItemUseState().Sequence).toBe(1);
      expect(db.GetInventoryRecord(bobStock.SN)).toBeUndefined();
      expect(room.m_rgPlayer[2]!.GetUserInventory(bobStock.SN)!.Amount).toBe(0);
      expect(room.m_rgPlayer[2]!.IsInventoryModified(bobStock.SN)).toBe(1);
      expect(db.GetSpecialItemUseReceipt(secondKey, 1)).toBeDefined();
      await inventory(0);

      expect(room.m_nGhostCount).toBe(0);
      expect([...room.m_anSlotGhost]).toEqual(Array(8).fill(-1));
      expect([...room.m_anGhostSlot]).toEqual(Array(8).fill(-1));
      expect(room.GetGameLaunchState().LastGhostTime).toBe(0);
      b.Send(new CSendPacket(160).Encode1(1).Encode1(1).Encode1(1).Encode1(0));
      await expectFields(177, [1, 1, 0, 1]);
      expect(ctx.m_aBulaState[45]).toBe(1);
      expect(room.GetGameLaunchState().GameSequenceKey).toBe(
        firstState.GameSequenceKey,
      );
      expect(room.HasUDPPeerInfo(0)).toBe(true);
      expect(room.HasUDPPeerInfo(1)).toBe(true);
      expect(room.HasUDPPeerInfo(2)).toBe(true);
      expect(db.GetGameResultReceipt(firstKey)!.Packet).toEqual(receipt.Packet);
      expect(db.GetGameResultReceipt(secondKey)).toBeUndefined();
      expect(
        app.m_dbSession.db
          .query<
            { n: number },
            []
          >("SELECT count(*) AS n FROM RuntimeGameResult")
          .get()!.n,
      ).toBe(1);
      // The REAL8s return already passed the absolute7s aircraft gate; no
      // clock injection/sleep/extra manual Update. Nonchief Bob can request171
      // before the map's60000ms initial time and WITHOUT a sync-object request.
      expect(room.GetGameClock().ElapsedTime()).toBeLessThan(60000);
      expect(room.GetGameLaunchState().LastAirplaneRequestTime).toBe(0);
      await pickup(a, 1, 0, 0);
      await pickup(b, 2, 249, 70);
      expect([ctx.m_aBoxItemState[0], ctx.m_aBoxItemState[249]]).toEqual([
        1, 1,
      ]);
      await moneyPickup(a, 1, 248, 31); // same coin box/item as round1, NEW UUID +ordinal1
      expect(db.GetUserInfo("Partner")!.Money).toBe(10000);
      expect(room.GetMoneyPickupState().Sequence).toBe(1);
      const rows = [
        [255, 0, 128, 255],
        [0, 249, 255, 128],
        [128, 249, 0, 255],
      ];
      const aircraft = new CSendPacket(156).Encode1(rows.length);
      for (const row of rows) for (const value of row) aircraft.Encode1(value);
      const beforeAircraftTick = room.GetGameClock().GetCurrentTime();
      b.Send(aircraft);
      let scheduled: number | undefined;
      for (const peer of clients) {
        const p = await expectType(peer, 171),
          when = p.Decode4();
        if (scheduled !== undefined) expect(when).toBe(scheduled);
        else scheduled = when;
        expect(when).toBe(room.GetGameLaunchState().LastAirplaneRequestTime);
        expect((when - 2000 - beforeAircraftTick) >>> 0).toBeLessThanOrEqual(
          (room.GetGameClock().GetCurrentTime() - beforeAircraftTick) >>> 0,
        );
        expect(p.Decode1()).toBe(3);
        for (const row of rows)
          expect([p.Decode1(), p.Decode1(), p.Decode1(), p.Decode1()]).toEqual(
            row,
          );
        p.AssertEnd();
      }
      if (scheduled === undefined) throw new Error("No171 schedule received");
      expect([ctx.m_aBoxItemState[0], ctx.m_aBoxItemState[249]]).toEqual([
        0, 0,
      ]);
      expect(room.GetCurrentGameContext().m_nNextBoxItem).toBe(126);
      expect(room.m_syncGameObjMan.GetObjectCount()).toBe(0);
      expect(room.GetResultRoundID()).toBe(secondKey);
      await moneyPickup(b, 2, 0, 25); // actual171 reset permits a NEW claim in this round
      expect(db.GetUserInfo("Bob")!.Money).toBe(10);
      expect(ctx.m_aBoxItemState[0]).toBe(1);
      expect(room.GetMoneyPickupState().Sequence).toBe(2);
      expect(room.GetHouseClaimState().Sequence).toBe(0);
      b.Send(
        new CSendPacket(161)
          .Encode1(2)
          .Encode1(1)
          .Encode1(0)
          .Encode1(0)
          .Encode1(1)
          .Encode1(1)
          .Encode1(255)
          .Encode1(0),
      );
      await expectFields(178, [2, 1, 0, 0, 5, 1, 1, 126, 255, 0]);
      expect(ctx.m_aHouseState[0]).toBe(2);
      expect(ctx.m_nNextBoxItem).toBe(127);
      expect(db.GetUserInfo("Bob")!.Money).toBe(15);
      expect(room.GetHouseClaimState().Sequence).toBe(1);
      a.Send(new CSendPacket(144).Encode1(0).Encode1(0).Encode1(32));
      await barrier(); // already claimed: Alice cannot spend somebody else's coin
      // Native throttle precedes body decode, even for count255. Per-socket
      // RTT barriers must see NO extra171 and the committed marker must stay.
      b.Send(new CSendPacket(156).Encode1(255));
      for (const [i, peer] of clients.entries())
        peer.Send(
          new CSendPacket(20).Encode4(0x33440000 + i).Encode4(0x11221122),
        );
      for (const [i, peer] of clients.entries()) {
        const p = await expectType(peer, 20);
        expect(p.Decode4()).toBe(0x33440000 + i);
        p.Decode4();
        p.AssertEnd();
      }
      expect(room.GetGameLaunchState().LastAirplaneRequestTime).toBe(scheduled);
      expect(db.GetGameResultReceipt(secondKey)).toBeUndefined();
      expect(app.GetStatus().gameUpdate[0]!.failedRooms).toBe(0);
      expect(app.GetStatus().gameUpdate[0]!.failedTicks).toBe(0);
      expect(app.GetStatus().gameUpdate[0]!.pendingMoneyPickups).toBe(0);
      expect(
        app.m_dbSession.db
          .query("SELECT count(*) AS n FROM RuntimeMoneyPickup")
          .get(),
      ).toEqual({ n: 5 });
      for (const [key, count] of [
        [firstKey, 3],
        [secondKey, 2],
      ] as const)
        for (let claim = 1; claim <= count; claim++) {
          const receipt = db.GetMoneyPickupReceipt(key, claim)!;
          persistedMoney.push({
            RoundID: key,
            ClaimSequence: claim,
            Digest: receipt.Digest,
            PacketHex: receipt.Packet.toString("hex"),
          });
        }
      for (const [key, count] of [
        [firstKey, 2],
        [secondKey, 1],
      ] as const)
        for (let claim = 1; claim <= count; claim++) {
          const receipt = db.GetHouseClaimReceipt(key, claim)!;
          persistedHouse.push({
            RoundID: key,
            ClaimSequence: claim,
            Digest: receipt.Digest,
            PacketHex: receipt.Packet.toString("hex"),
          });
        }
      expect(app.GetStatus().gameUpdate[0]!.pendingSpecialItemUses).toBe(0);
      for (const key of [firstKey, secondKey]) {
        const receipt = db.GetSpecialItemUseReceipt(key, 1)!;
        persistedSpecial.push({
          RoundID: key,
          UseSequence: 1,
          Digest: receipt.Digest,
          PacketHex: receipt.Packet.toString("hex"),
        });
      }
      expect(
        app.m_dbSession.db
          .query("SELECT count(*) AS n FROM RuntimeSpecialItemUse")
          .get(),
      ).toEqual({ n: 2 });
      expect(app.GetStatus().gameUpdate[0]!.pendingHouseClaims).toBe(0);
      expect(
        app.m_dbSession.db
          .query("SELECT count(*) AS n FROM RuntimeHouseClaim")
          .get(),
      ).toEqual({ n: 3 });
      for (const [ID, amount] of [
        ["Alice", 10],
        ["Partner", 10000],
        ["Bob", 15],
      ] as const)
        expect(db.GetUserInfo(ID)!.Money).toBe(amount);
      expect(udp.every((p) => p.packets.length === 0)).toBe(true); // discovery has NO invented UDP ACK
      // Real close callbacks must finish BEFORE global ownership/SQLite teardown;
      // no fabricated disconnect or a delay that masks listener shutdown races.
      await app.CleanUp();
      expect(gs.m_listenSocket.sockets.size).toBe(0);
      expect(gs.m_channelPool.GetRankList()).toEqual([]);
      expect(app.m_center.m_globalUserTable.GetUserCount()).toBe(0);
      expect(sessions.GetBaseSession(index, serial)).toBeUndefined();
      expect(room.GetCurPlayer()).toBe(0);
      expect(room.GetSockets()).toEqual([]);
    } finally {
      for (const peer of peers) peer.Close();
      await Promise.all(udp.map((p) => closeUDP(p.socket)));
      await app.CleanUp();
    }
    expect(persistedKey).toBeDefined();
    const reopened = new CDBSession(config.Runtime.Database);
    try {
      const db = new GameDB(reopened);
      reopened.IntegrityCheck();
      expect(db.GetGameResultReceipt(persistedKey!)!.Packet).toEqual(
        persistedPacket!,
      );
      expect(db.GetUserInfo("Alice")!.Win).toBe(1);
      expect(db.GetUserInfo("Partner")!.Win).toBe(1);
      expect(db.GetUserInfo("Bob")!.Lose).toBe(1);
      for (const [ID, amount] of [
        ["Alice", 10],
        ["Partner", 10000],
        ["Bob", 15],
      ] as const)
        expect(db.GetUserInfo(ID)!.Money).toBe(amount);
      expect(persistedSecondKey).toBeDefined();
      expect(persistedSpecial).toHaveLength(2);
      for (const receipt of persistedSpecial) {
        const actual = db.GetSpecialItemUseReceipt(
          receipt.RoundID,
          receipt.UseSequence,
        )!;
        expect(actual.Digest).toBe(receipt.Digest);
        expect(actual.Packet.toString("hex")).toBe(receipt.PacketHex);
      }
      expect(
        reopened.db
          .query("SELECT count(*) AS n FROM RuntimeSpecialItemUse")
          .get(),
      ).toEqual({ n: 2 });
      expect(db.GetInventoryRecord(persistedStockSN)).toBeUndefined();
      expect(db.LoadInventory("Bob")).toEqual([]);
      expect(persistedHouse).toHaveLength(3);
      for (const receipt of persistedHouse) {
        const actual = db.GetHouseClaimReceipt(
          receipt.RoundID,
          receipt.ClaimSequence,
        )!;
        expect(actual.Digest).toBe(receipt.Digest);
        expect(actual.Packet.toString("hex")).toBe(receipt.PacketHex);
      }
      expect(
        db.session.db
          .query("SELECT count(*) AS n FROM RuntimeHouseClaim")
          .get(),
      ).toEqual({ n: 3 });
      expect(persistedMoney).toHaveLength(5);
      for (const receipt of persistedMoney) {
        const actual = db.GetMoneyPickupReceipt(
          receipt.RoundID,
          receipt.ClaimSequence,
        )!;
        expect(actual.Digest).toBe(receipt.Digest);
        expect(actual.Packet.toString("hex")).toBe(receipt.PacketHex);
      }
      expect(
        db.session.db
          .query("SELECT count(*) AS n FROM RuntimeMoneyPickup")
          .get(),
      ).toEqual({ n: 5 });
    } finally {
      reopened.Close();
    }
  } finally {
    await closeTCP(reserved.tcp);
    await closeUDP(reserved.udp);
    rmSync(dir, { recursive: true, force: true });
  }
}, 25000);
