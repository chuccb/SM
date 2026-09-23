/** Client 207 is one signed item SN. DeleteInventory skips the write while
 *  user+0x14 is set, and a high-bit SN is a negative dword. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CDBMan } from "../src/db/DBMan.ts";
import { CMainPool } from "../src/FXSS/MainPool.ts";
import { CipherDegree, CReceivedPacket, CSendPacket } from "../src/core/Packet.ts";
import type { CClientSocket } from "../src/FXSS/ClientSocket.ts";

const USER = "deleteuser";
let dir = "";
let db: CDBMan;
let prior: CMainPool | null = null;

function body(itemSN: number): CReceivedPacket {
  const p = new CSendPacket(undefined, CipherDegree.kPacketRaw);
  p.Encode4(itemSN >>> 0);
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

test("207 deletes one item, and neither a busy transaction nor a negative SN does", () => {
  dir = mkdtempSync(join(tmpdir(), "sm-delete-"));
  db = new CDBMan(dir);
  prior = CMainPool.ms_pInstance;
  const pool = new CMainPool(db);
  db.prAddInventory(1, USER, 11, 0, 1, 0, 0, 0);
  db.prAddInventory(1, USER, 22, 0, 1, 0, 0, 0);
  const user = { GetName: () => USER, m_fTranxInProgress: 1 };

  pool.OnRequestDeleteItem(body(11), socket(user));
  expect(db.GetUserInventoryRows(USER).map((row) => row.ItemSN).sort()).toEqual([11, 22]);

  user.m_fTranxInProgress = 0;
  pool.OnRequestDeleteItem(body(0x80000000), socket(user));
  expect(db.GetUserInventoryRows(USER).map((row) => row.ItemSN).sort()).toEqual([11, 22]);

  pool.OnRequestDeleteItem(body(11), socket(user));
  expect(db.GetUserInventoryRows(USER).map((row) => row.ItemSN)).toEqual([22]);
});
