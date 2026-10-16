import type { _USERINVENTORY, UserItem } from "../../Common/DB/Rows.ts";
import { expect } from "bun:test";
import { CSendPacket } from "../../Common/CSendPacket.ts";
import {
  CipherDegree,
  LoginStringKey,
  ServerType,
} from "../../Common/OfficialValues.ts";
import type { CReceivedPacketBase } from "../../Common/CReceivedPacketBase.ts";
import type { WireClient } from "./Clients.ts";

/** Actual wire login/transfer establishment for freshly registered test accounts.
 * Uses the production codec, NOT an independent full-client implementation. */
export async function greeting(peer: WireClient) {
  const p = await peer.Read(CipherDegree.None);
  expect(p.Decode1()).toBe(0);
  expect(p.Decode2()).toBe(3);
  expect(p.Decode2()).toBe(7);
  expect(p.Decode4()).toBe(peer.codec.m_nHeaderType!);
  expect(p.DecodeStr()).toContain("ftp://");
  p.AssertEnd();
}
export async function login(
  peer: WireClient,
  ids: string[],
): Promise<{ ID: string; GlobalSerialNo: number; GuildSn: number }[]> {
  const request = new CSendPacket(3).Encode1(ids.length);
  for (const id of ids)
    request
      .EncodeEncryptedStr(id, LoginStringKey.ID)
      .EncodeEncryptedStr("test-password", LoginStringKey.Password);
  request.Encode4(0);
  peer.Send(request, true);
  const p = await peer.Read();
  expect(p.Decode1()).toBe(3);
  expect(p.Decode1()).toBe(0);
  expect(p.Decode2()).toBe(1);
  expect(p.DecodeStr()).toBe("");
  expect(p.Decode1()).toBe(ids.length);
  const result = [];
  for (const id of ids) {
    const GlobalSerialNo = p.Decode4();
    expect(GlobalSerialNo).toBeGreaterThan(0);
    expect(p.DecodeStr()).toBe(id);
    expect(p.Decode1()).toBe(id === "Alice" ? 1 : 0);
    expect(p.Decode2()).toBe(0);
    expect(p.Decode1()).toBe(1);
    expect(p.Decode1()).toBe(10);
    expect(p.Decode2()).toBe(1);
    expect(p.Decode4()).toBe(0);
    const GuildSn = p.Decode4();
    expect(p.Decode1()).toBe(0);
    expect(p.DecodeStr()).toBe("");
    expect(p.Decode1()).toBe(2);
    expect(p.Decode1()).toBe(2);
    expect(p.Decode4()).toBe(0);
    result.push({ ID: id, GlobalSerialNo, GuildSn });
  }
  expect(p.DecodeStr()).toBe("");
  p.AssertEnd();
  return result;
}
export async function transfer(loginPeer: WireClient): Promise<number> {
  loginPeer.Send(
    new CSendPacket(6).Encode1(ServerType.FXGame).Encode4(0).Encode2(0),
  );
  const p = await loginPeer.Read();
  expect(p.Decode1()).toBe(6);
  expect(p.Decode1()).toBe(1);
  expect(p.Decode1()).toBe(ServerType.FXGame);
  expect(p.Decode4()).toBe(0);
  expect(p.Decode4()).toBe(0x7f000001);
  const port = p.Decode2();
  p.AssertEnd();
  return port;
}
export async function establish(
  peer: WireClient,
  users: { ID: string; GlobalSerialNo: number; GuildSn: number }[],
  inventories?: readonly (readonly Pick<
    _USERINVENTORY,
    "SN" | "Slot" | "Amount" | "Verbose" | "ExpireDate"
  >[])[],
  catalog: readonly Readonly<UserItem>[] = [],
): Promise<void> {
  await greeting(peer);
  const request = new CSendPacket(7).Encode1(users.length);
  for (const u of users)
    request.EncodeStr(u.ID).Encode4(u.GlobalSerialNo).Encode4(u.GuildSn);
  peer.Send(request.Encode4(0).Encode4(0x11221122).Encode1(1));
  const info = await peer.Read();
  expect(info.Decode1()).toBe(210);
  expect(info.Decode1()).toBe(1);
  info.AssertEnd();
  const items = await peer.Read();
  expect(items.Decode1()).toBe(202);
  expect(items.Decode2()).toBe(catalog.length);
  for (const r of catalog) {
    expect(items.Decode4()).toBe(r.SN);
    expect(items.Decode1()).toBe(r.Category);
    expect(items.DecodeStr()).toBe(r.strAttr);
    expect(items.Decode4()).toBe(r.nAttr1 >>> 0);
    expect(items.Decode4()).toBe(r.nAttr2 >>> 0);
    expect(items.Decode4()).toBe(r.nAttr3 >>> 0);
    expect(items.DecodeStr()).toBe(r.strName);
  }
  items.AssertEnd();
  const inventory = await peer.Read();
  expect(inventory.Decode1()).toBe(201);
  expect(inventory.Decode1()).toBe(users.length);
  if (inventories) expect(inventories).toHaveLength(users.length);
  for (const [i] of users.entries()) {
    const rows = inventories?.[i] ?? [];
    expect(inventory.Decode4()).toBe(rows.length);
    for (const r of rows) {
      expect(inventory.Decode4()).toBe(r.SN);
      expect(inventory.Decode1()).toBe(r.Slot);
      expect(inventory.Decode4()).toBe(r.Amount);
      expect(inventory.DecodeStr()).toBe(r.Verbose);
      expect(inventory.DecodeBuffer(8).readDoubleLE()).toBe(
        r.ExpireDate ? r.ExpireDate / 86400 + 25569 : 0,
      );
    }
  }
  inventory.AssertEnd();
}
export function slotPacket(
  p: CReceivedPacketBase,
  slot: number,
  hasPlayer: boolean,
  self: boolean,
  community = 0,
) {
  expect(p.Decode1()).toBe(hasPlayer ? 105 : 107);
  expect(p.Decode1()).toBe(slot);
  if (hasPlayer) {
    expect(p.Decode4()).toBeGreaterThan(0);
    expect(p.Decode1()).toBe(self ? 1 : 0);
    expect(p.Decode1()).toBe(community);
    if (self) expect(p.Decode1()).toBe(255);
  }
  expect(p.DecodeBuffer(3).length).toBe(3);
  if (hasPlayer) {
    p.DecodeStr();
    p.Decode1();
    p.Decode2();
    p.Decode4();
    p.Decode4();
    p.Decode2();
    expect(p.Decode1()).toBe(0);
    expect(p.Decode1()).toBe(0);
    expect(p.Decode4()).toBe(0);
  }
  p.AssertEnd();
}
