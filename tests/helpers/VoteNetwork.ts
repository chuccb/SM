import { expect } from "bun:test";
import { CServerApp } from "../../CServerApp.ts";
import { CSendPacket } from "../../Common/CSendPacket.ts";
import { CDBMan as LoginDB } from "../../LS/CDBMan.ts";
import { WireClient } from "./Clients.ts";
import { TestConfig } from "./Accounts.ts";
import { greeting, login, transfer, establish, slotPacket } from "./Network.ts";
export async function read(peer: WireClient, opcode: number) {
  const p = await peer.Read();
  expect(p.Decode1()).toBe(opcode);
  return p;
}
/** Genuine registration/LS/GS80/81. No clock/Running/ready/vote state injection.
 * Peer shares production codec: NOT an official client or binary oracle. */
export async function networkRoom(
  counts: readonly number[],
  password = "",
  nativeUDPPort?: number,
) {
  const config = TestConfig();
  if (nativeUDPPort !== undefined) {
    config.FXGS.UDPEnabled = true;
    config.FXGS.Channels[0]!.Port = nativeUDPPort;
  }
  const app = new CServerApp(config),
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
          .EncodeStr(password)
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
          .EncodeStr(password)
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
export function emptyInventory(
  p: Awaited<ReturnType<typeof read>>,
  count: number,
) {
  expect(p.Decode1()).toBe(count);
  for (let i = 0; i < count; i++) expect(p.Decode4()).toBe(0);
  p.AssertEnd();
}
