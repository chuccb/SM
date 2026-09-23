/** Client 212 is a counted list, not one slot. prUpdateInventoryVerbose
 *  stores at most the varchar(20) CP950 width. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CDBMan } from "../src/db/DBMan.ts";
import { CMainPool } from "../src/FXSS/MainPool.ts";
import { CipherDegree, CReceivedPacket, CSendPacket } from "../src/core/Packet.ts";
import { EncodeCP950 } from "../src/core/Encoding.ts";
import type { CClientSocket } from "../src/FXSS/ClientSocket.ts";

const USER = "verboseuser";
let dir = "";
let db: CDBMan;
let prior: CMainPool | null = null;

function body(count: number, pairs: { sn: number; verbose: string }[]): CReceivedPacket {
  const p = new CSendPacket(undefined, CipherDegree.kPacketRaw);
  p.Encode1(count);
  for (const pair of pairs) {
    p.Encode4(pair.sn);
    p.EncodeStr(pair.verbose);
  }
  const recv = new CReceivedPacket();
  recv.SetCipherDegree(CipherDegree.kPacketRaw);
  recv.SetRcvPacket(p.m_pBlock.subarray(0, p.m_uOffset), p.m_uOffset);
  return recv;
}

function socket(user: { GetName(): string; m_fTranxInProgress: number }): CClientSocket {
  return {
    m_nSelectedUserIdx: 0,
    GetUser: () => user,
  } as unknown as CClientSocket;
}

afterEach(() => {
  CMainPool.ms_pInstance = prior;
  db?.Close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("212 writes every pair and keeps verbose inside 20 CP950 bytes", () => {
  dir = mkdtempSync(join(tmpdir(), "sm-verbose-"));
  db = new CDBMan(dir);
  prior = CMainPool.ms_pInstance;
  const pool = new CMainPool(db);
  db.prAddInventory(1, USER, 11, 0, 1, 0, 0, 0);
  db.prAddInventory(1, USER, 22, 0, 1, 0, 0, 0);

  const wide = "中".repeat(11);
  expect(EncodeCP950("中").length).toBe(2);
  const user = { GetName: () => USER, m_fTranxInProgress: 0 };
  pool.OnRequestModifyItemVerbose(
    body(2, [
      { sn: 11, verbose: "abcdefghijklmnopqrstu" },
      { sn: 22, verbose: wide },
    ]),
    socket(user),
  );

  const rows = db.GetUserInventoryRows(USER);
  const bySn = new Map(rows.map((row) => [row.ItemSN, row.Verbose]));
  expect(bySn.get(11)).toBe("abcdefghijklmnopqrst");
  expect(EncodeCP950(bySn.get(11)!).length).toBe(20);
  expect(bySn.get(22)).toBe("中".repeat(10));
  expect(EncodeCP950(bySn.get(22)!).length).toBe(20);

  user.m_fTranxInProgress = 1;
  pool.OnRequestModifyItemVerbose(body(1, [{ sn: 11, verbose: "blocked" }]), socket(user));
  expect(db.GetUserInventoryRows(USER).find((row) => row.ItemSN === 11)?.Verbose).toBe("abcdefghijklmnopqrst");
});
