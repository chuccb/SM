import { describe, expect, test } from "bun:test";
import vectors from "./fixtures/packet-vectors.json";
import {
  SimpleStreamDecrypt3,
  SimpleStreamEncrypt3,
} from "../Common/SimpleStream.ts";
import { CCRC8, CCRC32, adler32 } from "../Common/CCRC.ts";
import { CBufferManipulator as BM } from "../Common/CBufferManipulator.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CPacketSocket } from "../Common/CPacketSocket.ts";
import { CipherDegree } from "../Common/OfficialValues.ts";
import { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { COSmartStream } from "../Common/COSmartStream.ts";
import { CISmartStream } from "../Common/CISmartStream.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import {
  gsConvertTableDecode,
  gsConvertTableEncode,
  g_nLevel2ExpTable,
} from "../Common/Protocol/OfficialTables.ts";
import { CDynInfoCalculator } from "../Common/CDynInfoCalculator.ts";
import { EncodePassword } from "../Common/EncodePassword.ts";

const fromHex = (s: string) => Buffer.from(s, "hex");
describe("independent fixed-width C++ vectors (not just self-roundtrips)", () => {
  for (const v of vectors.streams)
    test(`SimpleStream key=${v.key} len=${v.plain.length / 2}`, () => {
      expect(
        SimpleStreamEncrypt3(fromHex(v.plain), v.key).toString("hex"),
      ).toBe(v.encrypted);
      expect(
        SimpleStreamDecrypt3(fromHex(v.encrypted), v.key).toString("hex"),
      ).toBe(v.plain);
    });
  for (const v of vectors.crc)
    test(`seeded non-reflected CRC ${v.seed}`, () => {
      const data = Buffer.from("123456789");
      expect(CCRC8.UpdateCRC(v.seed, data)).toBe(v.crc8);
      expect(CCRC32.UpdateCRC(v.seed, data)).toBe(v.crc32);
    });
  for (const v of vectors.frames)
    test(`frame degree=${v.degree} seq=${v.sequence}`, () => {
      const degree = v.degree as CipherDegree;
      const packet = new CSendPacket(3, degree)
        .Encode1(255)
        .Encode2(0x1234)
        .Encode4(0x89abcdef)
        .EncodeStr("Alice");
      expect(packet.GetBuffer().toString("hex")).toBe(v.body);
      const socket = new CPacketSocket({
        headerType: 2,
        sendSequence: v.sequence,
      });
      expect(socket.PutPacket(packet).toString("hex")).toBe(v.frame);
      const receiver = new CPacketSocket({
        headerType: 2,
        receiveBase: 102,
        receiveSequence: v.sequence,
        cipherDegree: degree,
      });
      const [received] = receiver.GetPackets(fromHex(v.frame));
      expect(received!.Decode1()).toBe(3);
      expect(received!.Decode1()).toBe(255);
      expect(received!.Decode2()).toBe(0x1234);
      expect(received!.Decode4()).toBe(0x89abcdef);
      expect(received!.DecodeStr()).toBe("Alice");
      received!.AssertEnd();
    });
});

describe("packet edge cases and independent format invariants", () => {
  test("network scalars are BE, regardless of x86 little endian", () => {
    const b = Buffer.alloc(7);
    BM.Encode1(b, 0xab);
    BM.Encode2(b, 0xcdef, 1);
    BM.Encode4(b, 0x12345678, 3);
    expect(b.toString("hex")).toBe("abcdef12345678");
  });
  test("extracted PE tables are 16 complete inverse permutations", () => {
    expect(gsConvertTableEncode.length).toBe(16);
    for (let row = 0; row < 16; row++) {
      expect(new Set(gsConvertTableEncode[row]).size).toBe(256);
      for (let i = 0; i < 256; i++)
        expect(gsConvertTableDecode[row]![gsConvertTableEncode[row]![i]!]).toBe(
          i,
        );
    }
  });
  test("TCP handles every split boundary and coalesced packets", () => {
    const s = new CPacketSocket({ headerType: 7 });
    const wire = Buffer.concat([
      s.PutPacket(new CSendPacket(20).Encode4(123)),
      s.PutPacket(new CSendPacket(20).Encode4(456)),
    ]);
    for (let split = 0; split <= wire.length; split++) {
      const r = new CPacketSocket({ headerType: 7, receiveBase: 102 });
      const packets = [
        ...r.GetPackets(wire.subarray(0, split)),
        ...r.GetPackets(wire.subarray(split)),
      ];
      expect(packets.length).toBe(2);
      expect(r.bufferedBytes).toBe(0);
      for (const [i, p] of packets.entries()) {
        expect(p.Decode1()).toBe(20);
        expect(p.Decode4()).toBe(i ? 456 : 123);
      }
    }
  });
  test("bad CRC/sequence/size fail without advancing sequence", () => {
    const s = new CPacketSocket({ headerType: 2 });
    const wire = s.PutPacket(new CSendPacket(25).EncodeStr("test"));
    for (const index of [0, 3, wire.length - 1]) {
      const r = new CPacketSocket({ headerType: 2, receiveBase: 102 });
      const broken = Buffer.from(wire);
      broken[index] = broken[index]! ^ 1;
      expect(() => r.GetPackets(broken)).toThrow();
      expect(r.m_nPacketRcvSeq).toBe(40);
    }
    expect(() =>
      new CPacketSocket({ headerType: 2 }).GetPackets(
        Buffer.from([0, 0xa5, 0x69]),
      ),
    ).toThrow();
    expect(() => new CReceivedPacketBase(Buffer.from([1])).Decode4()).toThrow();
  });
  test("encrypted strings preserve independent key and exact byte size", () => {
    const p = new CSendPacket(3)
      .EncodeEncryptedStr("Alice", 0x11223344)
      .EncodeEncryptedStr("test123", 0x44332211);
    const r = new CReceivedPacketBase(p.GetBuffer(), CipherDegree.CRC8);
    expect(r.Decode1()).toBe(3);
    expect(r.DecodeEncryptedStr(0x11223344)).toBe("Alice");
    expect(r.DecodeEncryptedStr(0x44332211)).toBe("test123");
    r.AssertEnd();
  });
  test("Big5 byte lengths are not UTF-8 or JS code units", () => {
    const codec = new CTextCodec("big5");
    expect(codec.Encode("初級").toString("hex")).toBe("aaecafc5");
    const p = new CSendPacket(25, CipherDegree.None, codec).EncodeStr("初級");
    expect(p.GetBuffer().toString("hex")).toBe("190004aaecafc5");
    const r = new CReceivedPacketBase(p.GetBuffer(), CipherDegree.None, codec);
    r.Decode1();
    expect(r.DecodeStr()).toBe("初級");
  });
  test("SmartStream frozen uncompressed envelope, native LE scalars/u32 strings", () => {
    const stream = new COSmartStream().Encode2(0x1234).EncodeStr("A");
    expect(stream.GetBuffer().toString("hex")).toBe(
      "18080000000034120100000041",
    );
    expect(stream.GetHashValue()).toBe(0x021e0088); // independently checked with Python zlib.adler32(bytes, 0)
    const r = new CISmartStream(stream.GetBuffer());
    expect(r.Decode2()).toBe(0x1234);
    expect(r.DecodeStr()).toBe("A");
    expect(r.IsEOS()).toBe(true);
  });
  test("SmartStream empty and zlib compressed branches, inflate bomb limits", () => {
    const empty = new COSmartStream();
    expect(empty.GetBuffer().toString("hex")).toBe("180100000000");
    expect(empty.GetHashValue()).toBe(0);
    const data = Buffer.from("abc".repeat(1000));
    const stream = new COSmartStream().EncodeBuffer(data);
    const b = stream.GetBuffer();
    expect(b[5]).toBe(1);
    expect(b.length).toBeLessThan(data.length);
    expect(new CISmartStream(b).pRawBuf).toEqual(data);
    expect(stream.GetHashValue()).toBe(adler32(0, b.subarray(5)));
    const invalid = Buffer.from(b);
    invalid.writeUInt32LE(0xffffffff, 6);
    expect(() => new CISmartStream(invalid)).toThrow();
    for (const degree of [CipherDegree.None, CipherDegree.CRC8]) {
      const p = new CSendPacket(10, degree).EncodeOSStream(stream);
      const r = new CReceivedPacketBase(p.GetBuffer(), degree);
      r.Decode1();
      expect(r.DecodeISStream().pRawBuf).toEqual(data);
      r.AssertEnd();
    }
  });
  test("level boundaries use official upper-index convention", () => {
    expect(g_nLevel2ExpTable.length).toBe(450);
    expect(CDynInfoCalculator.GetLevel(0)).toBe(1);
    for (let i = 1; i < 450; i++) {
      const n = g_nLevel2ExpTable[i]!;
      expect(CDynInfoCalculator.GetLevel(n)).toBe(i + 1);
      expect(CDynInfoCalculator.GetLevel(n - 1)).toBe(i);
    }
  });
  test("legacy password is truncated UU-style, new storage must not use it", () => {
    expect(EncodePassword(Buffer.from("")).toString("ascii")).toBe("`");
    expect(EncodePassword(Buffer.from("A")).toString("ascii")).toBe("!00");
    expect(EncodePassword(Buffer.from("ABC")).toString("ascii")).toBe("#04)#");
    expect(() => EncodePassword(Buffer.from([0]))).toThrow();
  });
});
