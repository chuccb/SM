import { CSendPacket } from "../../Common/CSendPacket.ts";
import type { CDBSession } from "../../Common/DB/CDBSession.ts";
import { ChannelType, BanChiefRule } from "../../Common/OfficialValues.ts";
import { ClientRequest } from "../../Common/Protocol/PacketTypes.ts";
import type { BanChiefState } from "../../FXGS/CBanChief.ts";
import type {
  BanChiefNotice,
  WaitingChiefObservation,
} from "../../FXGS/WaitingChief.ts";
import { GameLaunchFixture } from "./GameLaunch.ts";
import { Received, type MemoryClient } from "./Clients.ts";
import { NativeInventory } from "./UserInventory.ts";
import data from "../fixtures/waiting-chief-vectors.json";

export interface WaitingChiefVector {
  Name: string;
  Before: BanChiefState;
  Observation: WaitingChiefObservation;
  TimeBase: number;
  TimeIncrement: number;
  CanStartResult: number;
  After: BanChiefState;
  StateHex: string;
  Notices: (BanChiefNotice & { BodyHex: string })[];
  Eject: boolean;
  ClockReads: number[];
  CanStartCalls: number;
}
export const WaitingChiefVectors = data as unknown as {
  Model: string;
  CaseCount: number;
  Cases: WaitingChiefVector[];
  OfficialPE: { SHA256: string };
  InstructionAnchors: { VA: number; Bytes: string; Meaning: string }[];
};

/** True80/81/96/100 handlers; only accounts and WinMM source are trusted test
 * inputs. No synthetic Running/ready-bit writes, helper-state hacks or SQL item
 * mapping. Native functional rows are EXPLICIT read-side fixtures, NOT grants. */
export function WaitingChiefFixture(
  options: {
    Counts?: readonly number[];
    Manner?: number;
    Capacity?: number;
    SuperChief?: boolean;
    ChannelType?: number;
    JoinTime?: number;
  } = {},
) {
  const e = GameLaunchFixture(
    options.Counts ?? [1, 1],
    options.ChannelType ?? ChannelType.Normal,
    () => 1,
    options.JoinTime ?? 100,
    undefined,
    { Manner: options.Manner ?? 0 },
  );
  if (options.SuperChief)
    e.room.m_rgPlayer[e.room.m_nChiefSlotidx]!.InstallUserInventory([
      NativeInventory({
        strAttr: BanChiefRule.SuperChiefAttribute,
        Amount: 0,
        Slot: 255,
        DateCreated: -1.75,
        Modified: 1,
      }),
    ]);
  const capacity = options.Capacity ?? 8;
  if (capacity < e.room.GetCurPlayer() || capacity > 8) {
    e.close();
    throw new Error("Invalid waiting fixture capacity");
  }
  for (let slot = capacity; slot < 8; slot++)
    e.table.OnPacket(
      Received(
        new CSendPacket(ClientRequest.OpenCloseSlot).Encode1((slot << 4) | 1),
      ),
      e.clients[0]!,
    );
  e.clear();
  return {
    ...e,
    tick(time: number) {
      e.time(time);
      e.table.UpdateGameSessions();
    },
  };
}
export function ChiefNotices(
  peer: MemoryClient,
): { Reason: number; Seconds: number; Hex: string }[] {
  return peer.packets
    .filter((p) => p.m_nPacketType === 121)
    .map((p) => {
      const copy = Received(
        new CSendPacket(121, p.m_nCipherDegree).EncodeBuffer(
          p.m_pBlock.subarray(1),
        ),
      );
      copy.Decode1();
      const Reason = copy.Decode1(),
        Seconds = copy.Decode2();
      copy.AssertEnd();
      return { Reason, Seconds, Hex: p.m_pBlock.toString("hex") };
    });
}
export function ChiefSQLState(session: CDBSession) {
  return {
    Changes: session.db
      .query<{ n: number }, []>("SELECT total_changes() n")
      .get()!.n,
    Receipts: [
      "RuntimeGameResult",
      "RuntimeMoneyPickup",
      "RuntimeHouseClaim",
      "RuntimeSpecialItemUse",
    ].map(
      (t) =>
        session.db
          .query<{ n: number }, []>(`SELECT count(*) n FROM ${t}`)
          .get()!.n,
    ),
  };
}
