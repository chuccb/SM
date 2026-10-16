import { CDBSession } from "../../Common/DB/CDBSession.ts";
import { CDBClock } from "../../Common/DB/CDBClock.ts";
import { CTextCodec } from "../../Common/CTextCodec.ts";
import { CDBMan } from "../../FXGS/CDBMan.ts";
import { CUserItemMan } from "../../FXGS/CUserItemMan.ts";
import type { InventoryInitializationObservation } from "../../FXGS/InventoryInitialization.ts";
import { PreObservation, PreState } from "./PreInventory.ts";
import { NativeInventory } from "./UserInventory.ts";
import { DBTime } from "./Calendar.ts";
import data from "../fixtures/inventory-initialization-vectors.json";

export interface InitializationVector {
  PreOpened: boolean;
  OwnedOpened: boolean;
  PreScenario: number;
  OwnedScenario: number;
  Negative: boolean;
  Step: number;
  PreRows: {
    SN: number;
    ItemSn: number;
    Amount: number;
    ExecResult: number;
    ReturnValue: number;
  }[];
  OwnedRows: {
    ItemSn: number;
    Slot: number;
    Amount: number;
    DateHex: string;
    LevelCreated: number;
    Verbose: string;
  }[];
  Expected: {
    Stage: string;
    After: InventoryInitializationObservation["Initial"];
    PreRows: number[];
    PreMissing: number[];
    PreReads: number;
    PreFetched: number;
    Events: string[];
    UserLevels: number[];
    Rows: number[];
    Missing: number[];
    Deletes: number[][];
    Reads: number;
    Fetched: number;
    Counted: number;
    Clocks: number;
    Equipment: { FakeLevel?: number; LevelIconSN?: number };
    OwnedPlainHex: string | null;
    OwnedScalarHex: string | null;
    PrePlainHex: string | null;
    PreScalarHex: string | null;
  };
}
export const InitializationVectors: {
  Model: string;
  Cases: InitializationVector[];
  OfficialPE: { Service: string; SHA256: string };
  LevelInput: { LoginSHA256: string; GameSHA256: string; Entries: number };
  InstructionAnchors: { VA: number; Bytes: string; Meaning: string }[];
} = data;
export function InitializationInput(
  c?: InitializationVector,
): InventoryInitializationObservation {
  if (!c)
    return {
      Initial: PreState({ Exp: 0, Level: 1 }),
      PreOpened: true,
      PreRows: [PreObservation()],
      OwnedOpened: true,
      OwnedRows: [NativeInventory({ Slot: 255, Verbose: "OWNED" })],
    };
  return {
    Initial: PreState({ Exp: 0, Level: 1 }),
    PreOpened: c.PreOpened,
    OwnedOpened: c.OwnedOpened,
    PreRows: c.PreRows.map((r) => ({
      ...PreObservation({ SN: r.SN, ItemSn: r.ItemSn, Amount: r.Amount }),
      ExecResult: r.ExecResult,
      ReturnValue: r.ReturnValue,
    })),
    OwnedRows: c.OwnedRows.map((r) => {
      const { DateHex, ...values } = r;
      return {
        ...values,
        StockSn: 0xfedcba98,
        DateCreated: Buffer.from(DateHex, "hex").readDoubleLE(),
      };
    }),
  };
}
export class InitializationCodec extends CTextCodec {
  hook: ((text: string) => void) | undefined;
  override Encode(text: string): Buffer {
    this.hook?.(text);
    return super.Encode(text);
  }
}
export function InitializationFixture(
  negative = false,
  text = new InitializationCodec(),
) {
  const session = new CDBSession(":memory:"),
    db = new CDBMan(session, text);
  for (const [SN, Category] of [
    [7, 2],
    [8, 101],
    [9, 100],
    [10, 9],
    [11, 5],
    [12, 6],
  ])
    session.db
      .query(
        "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES(?,?,'CATALOG',?,0,-1,'definition name')",
      )
      .run(SN!, Category!, SN === 12 ? -17 : 1);
  const items = new CUserItemMan(db);
  let now = 100,
    reads = 0,
    step = 0,
    hook: (() => void) | undefined;
  const clock = new CDBClock(() => {
    reads++;
    hook?.();
    const result = now;
    now += step;
    return result;
  });
  clock.SyncLocalTimeFromDB(
    0,
    negative
      ? DBTime({
          year: 1899,
          month: 12,
          day: 29,
          hour: 6,
          minute: 0,
          second: 0,
        })
      : DBTime({ hour: 0, minute: 0, second: 0 }),
  );
  return {
    session,
    db,
    items,
    clock,
    text,
    step(value: number) {
      step = value;
    },
    now(value: number) {
      now = value;
    },
    reads: () => reads,
    sampleHook(value?: () => void) {
      hook = value;
    },
    close: () => session.Close(),
  };
}
