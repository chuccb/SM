import type {
  BanPlayerObservation,
  BanPlayerPlan,
  BanPlayerDepartureObservation,
} from "../../FXGS/BanPlayer.ts";
import data from "../fixtures/ban-player-vectors.json";
export interface BanPlayerVector {
  Name: string;
  Action: "Host" | "Respond" | "Defer" | "Departure";
  Observation: BanPlayerObservation;
  Sender: number;
  SerialNo: number;
  Value: number;
  SuperMask: number;
  ReflexMask: number;
  Expected: BanPlayerPlan | BanPlayerDepartureObservation;
  Bodies: { Scalar: string[]; Plain: string[] };
  FunctionalCalls: { Slot: number; Attribute: string }[];
}
export const BanPlayerVectors = data as unknown as {
  Model: string;
  Cases: BanPlayerVector[];
  CaseCount: number;
  OfficialPE: { SHA256: string };
  InstructionAnchors: { VA: number; Bytes: string; Meaning: string }[];
};
export function BanObservation(
  groups: readonly number[] = [1, 1, 1, 1],
): BanPlayerObservation {
  let serial = 0x81234560,
    slot = 0;
  const Actors: BanPlayerObservation["Actors"][number][] = Array.from(
    { length: 8 },
    () => null,
  );
  for (const [SocketKey, count] of groups.entries())
    for (let Self = 0; Self < count; Self++) {
      Actors[slot] = {
        SerialNo: serial++,
        SocketKey,
        Self,
        Name: `User${slot}`,
      };
      slot++;
    }
  return {
    Actors,
    Votes: Array<number>(8).fill(0),
    ChiefSlot: 0,
    TargetSerialNo: 0,
  };
}
export function WithVotes(
  source: BanPlayerObservation,
  votes: readonly number[],
  target = source.Actors[1]!.SerialNo,
): BanPlayerObservation {
  return {
    ...source,
    Votes: Array.from({ length: 8 }, (_, i) => votes[i] ?? 0),
    TargetSerialNo: target,
  };
}
