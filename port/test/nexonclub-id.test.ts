/** A06: FxShop SetNexonClubId 0041FC60, GetNexonClubId 0041F000,
 * RequestGift 00402BA0 and RequestCheck/UseCoupon 00402E10/00402FB0.
 * Inputs are raw-byte strings, not an invented Unicode email policy.
 */
import { describe, expect, test } from "bun:test";
import { CBillingProcess, CUser, CMainSystem, type _USERACCOUNT } from "../src/FXSS/FxShop.ts";
import { CBillingSocketTw } from "../src/FXSS/BillingSocket.ts";
import { DecodePacketTw } from "../src/FXSS/Packet.ts";
import { CReceivedPacket } from "../src/core/Packet.ts";
import type { CDBMan } from "../src/db/DBMan.ts";

function account(Email: string, SN = 7, CommunitySvr = 1): _USERACCOUNT {
  return {
    SN, CommunitySvr, Email, Name: "account", Password: "fixture", EmailRcv: 0, Gender: 0,
    Address: "", Tel: "", Reveal: 0, Profile: "", TotalConn: 0, LastConn: null, Permission: 0,
    money: 0, win: 0, draw: 0, lose: 0, ShopCardNo: 0,
  };
}

const cases: [label: string, email: string, stored: string, wire: string][] = [
  ["ordinary", "audit@nexonclub.com", "audit", "audit"],
  ["empty", "", "", ""],
  ["partial pattern", "@nexonclub.co", "", ""],
  ["domain alone", "@nexonclub.com", "", ""],
  ["unrelated", "audit@example.com", "", ""],
  ["case sensitive", "audit@NEXONCLUB.COM", "", ""],
  ["mixed case local part", "Audit@nexonclub.com", "Audit", "Audit"],
  ["no trimming", " audit@nexonclub.com", " audit", " audit"],
  ["match not at end", "abc@nexonclub.com.evil", "abc@nexo", "abc@nexo"],
  ["match at start", "@nexonclub.comabc", "@ne", "@ne"],
  ["two matches", "a@nexonclub.com@nexonclub.com", "a@nexonclub.com", "a@nexonclub.com"],
  ["raw Big5 prefix", "\xa4\xa4\xa4\xe5@nexonclub.com", "\xa4\xa4\xa4\xe5", "\xa4\xa4\xa4\xe5"],
  ["search crosses NUL in range", "a\0b@nexonclub.com", "a\0b", "a"],
  ["leading NUL", "\0x@nexonclub.com", "\0x", ""],
  ["NUL after the match", "abc@nexonclub.com\0", "abc@", "abc@"],
];

describe("CUser NexonClub ID byte semantics", () => {
  for (const [label, email, stored, wire] of cases) {
    test(label, () => {
      const user = new CUser(null); user.m_strNexonClubId = "stale";
      const profile = account(email); user.SetNexonClubId(profile);
      expect(user.m_strNexonClubId).toBe(stored);
      expect(user.GetNexonClubId()).toBe(wire);
      expect(user.m_strNexonClubId).toBe(stored); // getter never destroys stored bytes
      expect(profile.Email).toBe(email);
    });
  }
  test("SN, CommunitySvr and previous contents cannot replace the email-derived ID", () => {
    const user = new CUser(null);
    for (const sn of [0, 7, 0x7fffffff]) for (const community of [0, 1, 0xffff]) {
      user.SetNexonClubId(account("email@nexonclub.com", sn, community));
      expect(user.GetNexonClubId()).toBe("email");
      user.SetNexonClubId(account("not-matched", sn, community));
      expect(user.GetNexonClubId()).toBe("");
    }
  });
  test("all 256 possible prefix bytes survive storage; only C-string NUL truncates the getter", () => {
    const user = new CUser(null);
    for (let byte = 0; byte < 256; byte++) {
      const prefix = String.fromCharCode(byte);
      user.SetNexonClubId(account(`${prefix}@nexonclub.com`));
      expect(user.m_strNexonClubId).toBe(prefix);
      expect(user.GetNexonClubId()).toBe(byte === 0 ? "" : prefix);
    }
  });
});

describe("derived ID in complete Tw gift/coupon request frames", () => {
  for (const [label, email, stored, wireId] of cases) {
    test(label, () => {
      const oldBilling = CBillingProcess.ms_pInstance;
      const oldMainSystem = CMainSystem.ms_pInstance;
      const billing = new CBillingProcess({} as CDBMan);
      const mainSystem = new CMainSystem();
      mainSystem.m_nFXAttr = 3;
      const socket = new CBillingSocketTw(false);
      const frames: Uint8Array[] = [];
      socket.m_bConnected = true;
      socket.bunSocket = { write: (bytes: Uint8Array) => { frames.push(bytes.slice()); return bytes.length; }, end: () => {} } as unknown as Bun.Socket;
      billing.m_pSocket = socket; billing.m_fConnected = 1;
      const user = new CUser(null); user.SetName("player"); user.SetGlobalSerialNo(123);
      user.m_strCoupon = "coupon"; user.m_nUserAccountHiword = 9; user.m_strTranxInfo = "transaction";
      user.SetNexonClubId(account(email));
      try {
        billing.RequestGift(user, "recipient", 456, 789);
        billing.RequestCheckCoupon(user); billing.RequestUseCoupon(user);
        expect(frames).toHaveLength(3);
        for (const [index, frame] of frames.entries()) {
          const p = new CReceivedPacket(); expect(DecodePacketTw(p, frame, frame.length)).toBe(true);
          expect([p.Decode1(), p.Decode1()]).toEqual(index === 0 ? [0, 7] : [1, index - 1]);
          expect(p.Decode4()).toBe(123);
          if (index === 0) expect([p.Decode4(), p.Decode4(), p.Decode4(), p.Decode4()]).toEqual([0, 0, 456, 789]);
          else expect(p.DecodeStr()).toBe("coupon");
          expect(p.DecodeStr()).toBe(wireId);
          expect(p.DecodeStr()).toBe("player");
          expect([p.Decode1(), p.Decode2()]).toEqual([3, 9]);
          if (index === 0) expect(p.DecodeStr()).toBe("transaction");
          expect(p.m_uOffset).toBe(p.m_uLength);
        }
        expect(user.m_strNexonClubId).toBe(stored);
      } finally {
        socket.Close();
        CBillingProcess.ms_pInstance = oldBilling;
        CMainSystem.ms_pInstance = oldMainSystem;
      }
    });
  }
});
