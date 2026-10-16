import { CUser } from "../../Common/CUser.ts";
import { g_nLevel2ExpTable } from "../../Common/Protocol/OfficialTables.ts";
import { MemoryClient } from "./Clients.ts";
import { UserInfo } from "./Accounts.ts";

export interface ScoringPlayer {
  readonly Level: number;
  readonly Color: number;
  readonly Socket: number;
  readonly Authencode: number;
}
export interface ScoringAction {
  readonly Kind: string;
  readonly Victim: number;
  readonly Actor: number;
  readonly Value: number;
}
let serial = 100_000;
/** Trusted kernel test setup, NOT a way for a network client to start a round. */
export function ScoringPlayers(input: readonly (ScoringPlayer | null)[]) {
  const clients = new Map<number, MemoryClient>();
  const slots = Array.from({ length: 8 }, () => Buffer.alloc(3));
  const players = input.map((spec, slot) => {
    if (!spec) return undefined;
    let client = clients.get(spec.Socket);
    if (!client) {
      client = new MemoryClient();
      clients.set(spec.Socket, client);
    }
    const info = UserInfo(`Score${++serial}`);
    info.Exp = g_nLevel2ExpTable[spec.Level - 1]!;
    const user = new CUser(info, serial);
    user.SetAuthenCode(spec.Authencode);
    user.m_pClientSocket = client;
    user.m_nSlotIdx = slot;
    client.m_aUser.push(user);
    slots[slot]![2] = spec.Color;
    return user;
  });
  return { Players: players, Slots: slots, Clients: [...clients.values()] };
}
