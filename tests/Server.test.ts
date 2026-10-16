import { expect, test } from "bun:test";
import { CServerApp } from "../CServerApp.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { CDBMan } from "../LS/CDBMan.ts";
import { WireClient } from "./helpers/Clients.ts";
import { TestConfig } from "./helpers/Accounts.ts";
import {
  greeting,
  login,
  transfer,
  establish,
  slotPacket,
} from "./helpers/Network.ts";

test("real TCP: two-player login -> single-use handoff -> room create/join/chat/ready; no JSON game protocol", async () => {
  const app = new CServerApp(TestConfig());
  const peers: WireClient[] = [];
  const connect = (port: number) => {
    const s = new WireClient(port);
    peers.push(s);
    return s;
  };
  try {
    const db = new CDBMan(app.m_dbSession);
    for (const ID of ["Alice", "Partner", "Bob"])
      await db.RegisterNewUser({
        ID,
        Password: "test-password",
        Gender: ID === "Alice" ? 1 : 0,
      });
    // Deliberately distinguish Gender from CommunitySvr, and Center authcode
    // from premium TicketDate; same-valued defaults would hide these wire bugs.
    app.m_dbSession.db
      .query("UPDATE FxUserAccount SET CommunitySvr = 7 WHERE ID = 'Alice'")
      .run();
    app.m_dbSession.db
      .query(
        "UPDATE FxUserDynamic SET TicketDate = unixepoch() + 3600 WHERE ID = 'Alice'",
      )
      .run();
    await app.SetUp();
    const lsPort = app.m_loginServer.m_listenSocket.port;
    const ls = connect(lsPort);
    await greeting(ls);
    const group = await login(ls, ["Alice", "Partner"]);
    // Channel info uses CRC32/SmartStream; following three frames use CRC8.
    ls.Send(new CSendPacket(9).Encode4(0));
    const channel = await ls.Read(CipherDegree.CRC32);
    expect(channel.Decode1()).toBe(10);
    const stream = channel.DecodeISStream();
    expect(stream.Decode2()).toBe(1);
    channel.AssertEnd();
    for (const opcode of [13, 14, 11]) {
      const p = await ls.Read();
      expect(p.Decode1()).toBe(opcode);
    }
    const gs = connect(await transfer(ls));
    await establish(gs, group);
    expect(app.m_center.m_globalUserTable.GetUserCount()).toBe(2);
    gs.Send(
      new CSendPacket(80)
        .EncodeStr("Test room")
        .EncodeStr("")
        .Encode1(0)
        .Encode1(2)
        .Encode1(10)
        .Encode1(0),
    );
    const created = await gs.Read();
    expect(created.Decode1()).toBe(80);
    expect(created.Decode1()).toBe(0);
    const index = created.Decode2();
    const serial = created.Decode4();
    expect(created.Decode1()).toBe(0);
    created.AssertEnd();
    for (let i = 0; i < 8; i++)
      slotPacket(await gs.Read(), i, i < 2, i < 2, i === 0 ? 7 : 0);
    for (let i = 0; i < 2; i++) {
      const p = await gs.Read();
      expect(p.Decode1()).toBe(112);
      expect(p.Decode2()).toBe(0xffff);
      p.AssertEnd();
    }
    const otherLS = connect(lsPort);
    await greeting(otherLS);
    const bob = await login(otherLS, ["Bob"]);
    const otherGS = connect(await transfer(otherLS));
    await establish(otherGS, bob);
    expect((await otherGS.Read()).Decode1()).toBe(83);
    otherGS.Send(
      new CSendPacket(81)
        .Encode2(index)
        .Encode4(serial)
        .EncodeStr("")
        .Encode1(1)
        .Encode1(1),
    );
    const joined = await otherGS.Read();
    expect(joined.Decode1()).toBe(81);
    expect(joined.Decode1()).toBe(0);
    joined.AssertEnd();
    for (let i = 0; i < 8; i++)
      slotPacket(await otherGS.Read(), i, i < 3, i === 2, i === 0 ? 7 : 0);
    for (let i = 0; i < 2; i++) {
      const p = await otherGS.Read();
      expect(p.Decode1()).toBe(112);
      expect(p.Decode2()).toBe(0xffff);
    }
    expect((await otherGS.Read()).Decode1()).toBe(93);
    slotPacket(await gs.Read(), 2, true, true);
    otherGS.Send(new CSendPacket(25).EncodeStr("hello"));
    for (const peer of [gs, otherGS]) {
      const p = await peer.Read();
      expect(p.Decode1()).toBe(25);
      expect(p.DecodeStr()).toBe("Bob : hello");
      p.AssertEnd();
    }
    otherGS.Send(new CSendPacket(96).Encode1(1));
    for (const peer of [gs, otherGS]) {
      const p = await peer.Read();
      expect(p.Decode1()).toBe(107);
      expect(p.Decode1()).toBe(2);
      expect(p.DecodeBuffer(3)[0]! & 0x1c).toBe(4);
      p.AssertEnd();
    }
    gs.Send(new CSendPacket(100).Encode1(0x71));
    for (const peer of [gs, otherGS]) {
      const p = await peer.Read();
      expect(p.Decode1()).toBe(110);
      expect(p.Decode1()).toBe(0x71);
      p.AssertEnd();
    }
    otherGS.Send(
      new CSendPacket(108).Encode1(2).Encode1(3).Encode1(4).Encode2(0xabcd),
    );
    const emotion = await gs.Read();
    expect(emotion.Decode1()).toBe(118);
    expect([
      emotion.Decode1(),
      emotion.Decode1(),
      emotion.Decode1(),
      emotion.Decode2(),
    ]).toEqual([2, 3, 4, 0xabcd]);
    emotion.AssertEnd();
    otherGS.Send(new CSendPacket(20).Encode4(0x1234).Encode4(0x11221122));
    const rtt = await otherGS.Read();
    expect(rtt.Decode1()).toBe(20);
    expect(rtt.Decode4()).toBe(0x1234);
    rtt.Decode4();
    rtt.AssertEnd();
    const state = app.GetStatus();
    expect(state.completeOfficialRewrite).toBe(false);
    expect(state.officialClientVerified).toBe(false);
    expect(state.users).toBe(3);
    expect(state.resources.maps).toBe(226);
  } finally {
    for (const p of peers) p.Close();
    await app.CleanUp();
  }
}, 10000);
test("actual TCP: corrupt CRC closes connection without creating account ownership", async () => {
  const app = new CServerApp(TestConfig());
  let peer: WireClient | undefined;
  try {
    await app.SetUp();
    peer = new WireClient(app.m_loginServer.m_listenSocket.port);
    await greeting(peer);
    const wire = peer.codec.PutPacket(new CSendPacket(20).Encode4(10));
    wire[wire.length - 1] = wire[wire.length - 1]! ^ 1;
    peer.raw.write(wire);
    await expect(peer.Read()).rejects.toThrow("closed");
    expect(app.m_center.m_globalUserTable.GetUserCount()).toBe(0);
  } finally {
    peer?.Close();
    await app.CleanUp();
  }
});
