import { expect, test } from "bun:test";
import { CServerApp } from "../CServerApp.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  BanChiefRule,
  CipherDegree,
  SessionLimit,
} from "../Common/OfficialValues.ts";
import { CDBMan as LoginDB } from "../LS/CDBMan.ts";
import { WireClient } from "./helpers/Clients.ts";
import { TestConfig } from "./helpers/Accounts.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { HandoffRequest } from "./helpers/InventoryHandoff.ts";
import { ChiefSQLState, WaitingChiefVectors } from "./helpers/WaitingChief.ts";
import {
  greeting,
  login,
  transfer,
  establish,
  slotPacket,
} from "./helpers/Network.ts";

/** Real registered users -> LS/GS TCP -> explicit native read-side carry ->
 *80/100/81 -> UNACCELERATED ordinary400ms timer -> native15s odd warning ->
 *30s expiry ->121/3 BEFORE whole pair removal/pool4 ->106/107 succession ->
 *explicit16 ->209 unchanged native201. No injected clocks/ticks, ready bits,
 *Running/UDP, RNG, financial effect, original binary or official client. */
test("REAL TCP + UNACCELERATED timer: resident SuperChief survives LS→GS; odd CAPACITY3 warns after15s, ejects WHOLE pair after30s; no195/finance, explicit16 then identical native209", async () => {
  const app = new CServerApp(TestConfig()),
    peers: WireClient[] = [];
  const connect = (port: number) => {
    const p = new WireClient(port);
    peers.push(p);
    return p;
  };
  const read = async (p: WireClient, opcode: number, timeout = 3000) => {
    const packet = await p.Read(CipherDegree.CRC8, timeout);
    expect(packet.Decode1()).toBe(opcode);
    return packet;
  };
  try {
    const db = new LoginDB(app.m_dbSession);
    for (const ID of ["Alice", "Partner", "Bob"])
      await db.RegisterNewUser({
        ID,
        Password: "test-password",
        Gender: ID === "Alice" ? 1 : 0,
      });
    await app.SetUp();
    const gs = app.m_gameServers[0]!,
      ls = connect(app.m_loginServer.m_listenSocket.port);
    await greeting(ls);
    const group = await login(ls, ["Alice", "Partner"]),
      port = await transfer(ls),
      users = group.map(
        (id) => app.m_center.m_globalUserTable.GetUser(id.GlobalSerialNo)!,
      );
    // TRUSTED preexisting native resident state, NOT a shop/grant/SQL mapping.
    users[0]!.InstallUserInventoryInitialization(
      [
        NativeInventory({
          strAttr: BanChiefRule.SuperChiefAttribute,
          Slot: 255,
          Amount: 0,
          DateCreated: -1.75,
          Modified: 1,
        }),
      ],
      [],
    );
    users[1]!.InstallUserInventoryInitialization([], []);
    const pair = users.map((u) => u.CaptureUserInventoryInitialization()),
      expected201 = new CSendPacket(201).Encode1(2);
    users.forEach((u) => u.MakeUserInventoryPacket(expected201));
    const a = connect(port);
    await greeting(a);
    a.Send(HandoffRequest(group));
    const info = await read(a, 210);
    expect(info.Decode1()).toBe(1);
    info.AssertEnd();
    const catalog = await read(a, 202);
    expect(catalog.Decode2()).toBe(0);
    catalog.AssertEnd();
    expect((await read(a, 201)).m_pBlock).toEqual(expected201.GetBuffer());
    expect(users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
      pair,
    );
    a.Send(
      new CSendPacket(80)
        .EncodeStr("Unaccelerated chief")
        .EncodeStr("")
        .Encode1(1)
        .Encode1(2)
        .Encode1(0)
        .Encode1(0),
    );
    const created = await read(a, 80);
    expect(created.Decode1()).toBe(0);
    const index = created.Decode2(),
      serial = created.Decode4();
    expect(created.Decode1()).toBe(1); // native response echoes the MANNER byte
    created.AssertEnd();
    for (let i = 0; i < 8; i++) slotPacket(await a.Read(), i, i < 2, i < 2);
    for (let i = 0; i < 2; i++) {
      const map = await read(a, 112);
      expect(map.Decode2()).toBe(0xffff);
      map.AssertEnd();
    }
    for (let slot = 3; slot < 8; slot++)
      a.Send(new CSendPacket(100).Encode1((slot << 4) | 1));
    for (let slot = 3; slot < 8; slot++) {
      const closed = await read(a, 110);
      expect(closed.Decode1()).toBe((slot << 4) | 1);
      closed.AssertEnd();
    }
    const secondLS = connect(app.m_loginServer.m_listenSocket.port);
    await greeting(secondLS);
    const other = await login(secondLS, ["Bob"]),
      b = connect(await transfer(secondLS));
    await establish(b, other);
    await read(b, 83);
    b.Send(
      new CSendPacket(81)
        .Encode2(index)
        .Encode4(serial)
        .EncodeStr("")
        .Encode1(1)
        .Encode1(0),
    );
    const joined = await read(b, 81);
    expect(joined.Decode1()).toBe(0);
    joined.AssertEnd();
    for (let i = 0; i < 8; i++) slotPacket(await b.Read(), i, i < 3, i === 2);
    for (let i = 0; i < 2; i++) {
      const map = await read(b, 112);
      expect(map.Decode2()).toBe(0xffff);
      map.AssertEnd();
    }
    (await read(b, 93)).AssertEnd();
    slotPacket(await a.Read(), 2, true, true);
    const room = gs.m_gameSessionTable.GetBaseSession(index, serial)!,
      chiefSocket = users[0]!.m_pClientSocket!,
      bob = app.m_center.m_globalUserTable.GetUser(other[0]!.GlobalSerialNo)!,
      sql = ChiefSQLState(app.m_dbSession),
      financial = users.map((u) => u.GetDynamicInfoSnapshot());
    expect(room.m_nMaxPlayer).toBe(3);
    expect(room.GetCurPlayer()).toBe(3);
    expect(room.IsManner()).toBe(true);
    expect(room.m_bPlaying).toBe(false);
    expect(room.GetResultRoundID()).toBeUndefined();
    expect(room.GetGameLaunchState().NativeLaunch).toBe(false);
    expect(app.GetStatus().gameUpdate[0]!.launchEnabled).toBe(false);
    expect(app.GetStatus().gameUpdate[0]!.waitingChiefRooms).toBe(1);
    expect(gs.m_timerThreadNormal.IsRunning()).toBe(true);
    const warningImage = WaitingChiefVectors.Cases.flatMap(
        (c) => c.Notices,
      ).find((n) => n.Reason === 1 && n.Seconds === 30)!.BodyHex,
      kickImage = WaitingChiefVectors.Cases.flatMap((c) => c.Notices).find(
        (n) => n.Reason === 3 && n.Seconds === 30,
      )!.BodyHex;
    for (const p of [a, b]) {
      const warning = await read(p, 121, 22000);
      expect(warning.m_pBlock.toString("hex")).toBe(warningImage);
      expect(warning.Decode1()).toBe(1);
      expect(warning.Decode2()).toBe(30);
      warning.AssertEnd();
    }
    const warned = room.m_banChief.CaptureSnapshot();
    expect(warned.OddSlot).toBe(true);
    expect(warned.WarnedBanOddSlot).toBe(true);
    expect(
      (warned.WarnedTimeOddSlot - warned.LastTimeEvenSlot) >>> 0,
    ).toBeGreaterThan(15000);
    expect(room.GetCurPlayer()).toBe(3);
    expect(chiefSocket.m_nPoolType).toBe("Session");
    const kick = await read(a, 121, 37000);
    expect(kick.m_pBlock.toString("hex")).toBe(kickImage);
    expect(kick.Decode1()).toBe(3);
    expect(kick.Decode2()).toBe(30);
    kick.AssertEnd();
    // Native ordinary reset sequence to the SURVIVOR only; no extra121/195.
    for (let slot = 0; slot < 2; slot++) {
      const reset = await read(b, 106);
      expect(reset.Decode1()).toBe(slot);
      expect(reset.Decode4()).toBe(group[slot]!.GlobalSerialNo);
      reset.AssertEnd();
    }
    for (const slot of [0, 2]) {
      const state = await read(b, 107);
      expect(state.Decode1()).toBe(slot);
      state.DecodeBuffer(3);
      state.AssertEnd();
    }
    expect(chiefSocket.m_nPoolType).toBe("SessionRemoved");
    expect(chiefSocket.IsConnected()).toBe(true);
    expect(
      users.every(
        (u) =>
          u.GetSessionIdx() === SessionLimit.NoSession &&
          u.GetSessionSerialNo() === 0xffffffff &&
          u.m_nSlotIdx === -1 &&
          u.IsSetFree() === 0 &&
          u.m_pClientSocket === chiefSocket,
      ),
    ).toBe(true);
    expect(room.GetCurPlayer()).toBe(1);
    expect(room.m_rgPlayer[2]).toBe(bob);
    expect(room.IsChief(bob.m_pClientSocket!)).toBe(true);
    expect(gs.m_channelPool.GetRankList()).toHaveLength(3);
    expect(app.m_center.m_globalUserTable.GetUserCount()).toBe(3);
    expect(users.map((u) => u.CaptureUserInventoryInitialization())).toEqual(
      pair,
    );
    expect(users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(financial);
    expect(ChiefSQLState(app.m_dbSession)).toEqual(sql);
    expect(sql.Receipts).toEqual([0, 0, 0, 0]);
    expect(gs.m_gameSessionTable.GetUpdateFailures()).toEqual([]);
    // NOT an automatic lobby reply. Only the client's explicit16 changes stage.
    a.Send(new CSendPacket(16));
    let gotChannel = false;
    for (let i = 0; i < 3; i++) {
      const packet = await a.Read(),
        opcode = packet.Decode1();
      if (opcode === 13) {
        gotChannel = true;
        break;
      }
      expect(opcode).toBe(86); // native table's player-count lobby publication
    }
    expect(gotChannel).toBe(true);
    await read(a, 14);
    expect(chiefSocket.m_nPoolType).toBe("Channel");
    a.Send(new CSendPacket(209));
    expect((await read(a, 201)).m_pBlock).toEqual(expected201.GetBuffer());
    expect(ChiefSQLState(app.m_dbSession)).toEqual(sql);
    expect(app.GetStatus().completeOfficialRewrite).toBe(false);
    expect(app.GetStatus().officialClientVerified).toBe(false);
  } finally {
    for (const p of peers) p.Close();
    await app.CleanUp();
  }
}, 70000);
