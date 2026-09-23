/** Client 221/222 cart-list cache. Count is strlen/7 after a reload, not a comma split. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncodeCP950 } from "../src/core/Encoding.ts";
import { CipherDegree, CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CDBMan } from "../src/db/DBMan.ts";
import {
  CART_ADD_COUNT_DIVISOR,
  CART_LIST_BYTES,
  CART_LIST_COUNT_DIVISOR,
  CART_USER_ID_BYTES,
} from "../src/FXSS/Defs.ts";
import { CMainPool } from "../src/FXSS/MainPool.ts";
import { CUser } from "../src/FXSS/User.ts";
import type { CClientSocket } from "../src/FXSS/ClientSocket.ts";
import { S2C_ShopPacket } from "../src/core/protocol/PacketIDs.ts";

const USER = "cartuser";
let dir = "";
let db: CDBMan;
let prior: CMainPool | null = null;

function body(write: (packet: CSendPacket) => void): CReceivedPacket {
  const packet = new CSendPacket(undefined, CipherDegree.kPacketRaw);
  write(packet);
  const received = new CReceivedPacket();
  received.SetCipherDegree(CipherDegree.kPacketRaw);
  received.SetRcvPacket(packet.m_pBlock.subarray(0, packet.m_uOffset), packet.m_uOffset);
  return received;
}

function open(): { pool: CMainPool; user: CUser; sent: CSendPacket[] } {
  dir = mkdtempSync(join(tmpdir(), "sm-cart-list-"));
  db = new CDBMan(dir);
  prior = CMainPool.ms_pInstance;
  const pool = new CMainPool(db);
  const user = new CUser(null);
  user.SetName(USER);
  const sent: CSendPacket[] = [];
  user.m_pSocket = {
    m_nSelectedUserIdx: 0,
    GetUser: () => user,
    SendPacket: (packet: CSendPacket) => {
      sent.push(packet);
      return enSocket.kioOk;
    },
  } as unknown as CClientSocket;
  return { pool, user, sent };
}

function socketOf(user: CUser): CClientSocket {
  return user.m_pSocket!;
}

function decode(packet: CSendPacket): CReceivedPacket {
  const received = new CReceivedPacket();
  received.SetRcvPacket(packet.m_pBlock.subarray(0, packet.m_uOffset), packet.m_uOffset);
  received.SetCipherDegree(packet.m_nCipherDegree);
  received.m_nPacketType = received.Decode1();
  return received;
}

afterEach(() => {
  CMainPool.ms_pInstance = prior;
  db?.Close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("221 is silent while user+0x14 is set, and a missing user writes nothing", () => {
  const { pool, user, sent } = open();
  user.m_fTranxInProgress = 1;
  pool.OnRequestAddCartList(body((packet) => packet.EncodeStr("1234567")), socketOf(user));
  pool.OnRequestCartList(body(() => {}), socketOf(user));
  expect(db.prGetUserCartList(USER).retval).toBe(0);
  expect(user.m_strCartList).toBe("");
  expect(user.m_nCartListCount).toBe(0);
  expect(sent).toEqual([]);

  pool.OnRequestAddCartList(body((packet) => packet.EncodeStr("1234567")), {
    m_nSelectedUserIdx: 0,
    GetUser: () => null,
  } as unknown as CClientSocket);
  expect(db.prGetUserCartList(USER).retval).toBe(0);
});

test("222 keeps the full C string and strlen/5; 221 reloads strlen/7 and the 70-byte field", () => {
  const { pool, user, sent } = open();
  const list = "123456,123456,";
  const extra = "x".repeat(CART_LIST_BYTES);
  pool.OnRequestAddCartList(body((packet) => packet.EncodeStr(list + extra)), socketOf(user));

  expect(user.m_strCartList).toBe(list + extra);
  expect(user.m_nCartListCount).toBe(Math.floor((list.length + extra.length) / CART_ADD_COUNT_DIVISOR));
  expect(db.prGetUserCartList(USER)).toEqual({ retval: 1, stockSN: (list + extra).slice(0, CART_LIST_BYTES) });

  pool.OnRequestCartList(body(() => {}), socketOf(user));
  const reply = decode(sent[0]!);
  expect(reply.m_nPacketType).toBe(S2C_ShopPacket.OnCartList);
  expect(reply.Decode1()).toBe(Math.floor(CART_LIST_BYTES / CART_LIST_COUNT_DIVISOR));
  const wire = EncodeCP950(reply.DecodeStr());
  expect(wire.length).toBe(CART_LIST_BYTES);
  expect(Buffer.from(wire).toString("latin1")).toBe((list + extra).slice(0, CART_LIST_BYTES));
  expect(reply.m_uOffset).toBe(reply.m_uLength);
});

test("a short list is count 0 on the wire even when it contains commas", () => {
  const { pool, user, sent } = open();
  pool.OnRequestAddCartList(body((packet) => packet.EncodeStr("12,34,")), socketOf(user));
  pool.OnRequestCartList(body(() => {}), socketOf(user));
  const reply = decode(sent[0]!);
  expect(reply.Decode1()).toBe(0);
  expect(reply.m_uOffset).toBe(reply.m_uLength);
  expect(user.m_nCartListCount).toBe(0);
  expect(EncodeCP950(user.m_strCartList).length).toBe(CART_LIST_BYTES);
});

test("seven bytes are count 1, and the string keeps the field's trailing zeros", () => {
  const { pool, user, sent } = open();
  const list = "123456,";
  pool.OnRequestAddCartList(body((packet) => packet.EncodeStr(list)), socketOf(user));
  pool.OnRequestCartList(body(() => {}), socketOf(user));
  const reply = decode(sent[0]!);
  expect(reply.Decode1()).toBe(1);
  const wire = EncodeCP950(reply.DecodeStr());
  expect(wire.length).toBe(CART_LIST_BYTES);
  expect(wire[list.length]).toBe(0);
  expect(Buffer.from(wire.subarray(0, list.length)).toString("latin1")).toBe(list);
});

test("an empty add replaces the string but does not touch a nonempty count", () => {
  const { pool, user } = open();
  user.m_nCartListCount = 9;
  user.m_strCartList = "kept-only-until-add";
  pool.OnRequestAddCartList(body((packet) => packet.EncodeStr("")), socketOf(user));
  expect(user.m_strCartList).toBe("");
  expect(user.m_nCartListCount).toBe(9);
  expect(db.prGetUserCartList(USER)).toEqual({ retval: 1, stockSN: "" });
});

test("a NUL ends both the stored parameter and the cache copy", () => {
  const { pool, user } = open();
  pool.OnRequestAddCartList(body((packet) => packet.EncodeStr("1234567\0MORE")), socketOf(user));
  expect(user.m_strCartList).toBe("1234567");
  expect(user.m_nCartListCount).toBe(Math.floor(7 / CART_ADD_COUNT_DIVISOR));
  expect(db.prGetUserCartList(USER).stockSN).toBe("1234567");
});

test("a failed reload keeps the add cache, including a count whose low byte is zero", () => {
  const { pool, user, sent } = open();
  const list = "a".repeat(CART_ADD_COUNT_DIVISOR * 256);
  pool.OnRequestAddCartList(body((packet) => packet.EncodeStr(list)), socketOf(user));
  expect(user.m_nCartListCount).toBe(256);
  const failed = spyOn(db, "prGetUserCartList").mockImplementation(() => {
    throw new Error("injected exec failure");
  });
  try {
    pool.OnRequestCartList(body(() => {}), socketOf(user));
  } finally {
    failed.mockRestore();
  }
  expect(user.m_strCartList).toBe(list);
  expect(user.m_nCartListCount).toBe(256);
  const reply = decode(sent[0]!);
  expect(reply.Decode1()).toBe(0);
  expect(reply.DecodeStr()).toBe(list);
});

test("no row still replaces the cache, and a 70-byte trailing space is trimmed", () => {
  const { pool, user, sent } = open();
  user.m_strCartList = "stale";
  user.m_nCartListCount = 4;
  pool.OnRequestCartList(body(() => {}), socketOf(user));
  expect(sent).toHaveLength(1);
  expect(decode(sent[0]!).Decode1()).toBe(0);
  expect(user.m_nCartListCount).toBe(0);
  expect(user.m_strCartList).toBe("\0".repeat(CART_LIST_BYTES));

  const spaced = `${"1234567"}${" ".repeat(CART_LIST_BYTES - 7)}`;
  db.prAddUserCartList(USER, spaced);
  pool.OnRequestCartList(body(() => {}), socketOf(user));
  const reply = decode(sent[1]!);
  expect(reply.Decode1()).toBe(1);
  expect(reply.DecodeStr()).toBe("1234567");
});

test("the cart id parameter is 16 bytes on both the write and the reload", () => {
  const { pool, user, sent } = open();
  const id = "A".repeat(CART_USER_ID_BYTES + 4);
  user.SetName(id);
  pool.OnRequestAddCartList(body((packet) => packet.EncodeStr("1234567")), socketOf(user));
  expect(db.prGetUserCartList(id).stockSN).toBe("1234567");
  expect(db.prGetUserCartList(id.slice(0, CART_USER_ID_BYTES)).stockSN).toBe("1234567");
  pool.OnRequestCartList(body(() => {}), socketOf(user));
  expect(decode(sent[0]!).Decode1()).toBe(1);
});
