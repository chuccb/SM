import { expect, test } from "bun:test";
import { CServerConfig } from "../Common/CServerConfig.ts";
import { IPv4Number, InetAddr, NormalizePeerIP } from "../Common/CIPAddress.ts";
import { CRateLimiter } from "../Common/CRateLimiter.ts";
import { OpaqueOfficial, ServerType } from "../Common/OfficialValues.ts";
import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import {
  DecodeRelayDatagram,
  EncodeUnregisteredDatagram,
} from "../Relay/RelayProtocol.ts";
import { CCRC8 } from "../Common/CCRC.ts";

test("deployment config has the five original channel types/ports and safe defaults", () => {
  const c = CServerConfig.Load();
  expect(c.Runtime.Host).toBe("0.0.0.0");
  expect(c.Runtime.Registration).toBe(false);
  expect(c.Relay.Enabled).toBe(false);
  expect(c.FXGS.Channels.map((a) => [a.Port, a.Type])).toEqual([
    [4848, 1],
    [5858, 0],
    [6868, 41],
    [7888, 77],
    [8888, 99],
  ]);
  expect(c.FXSS.Ports).toEqual([9801, 9811, 9821, 9831]);
  expect(ServerType.Util).toBe(99);
});
test("config rejects duplicate ports, unreachable advertisement, invalid codec and giant names", () => {
  const dir = ".analysis/tests";
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/invalid-${crypto.randomUUID()}.toml`;
  const template = readFileSync("Config/Server.toml", "utf8");
  try {
    for (const contents of [
      template.replace("Port = 4848", "Port = 3838"),
      template.replace(
        'AdvertisedIP = "127.0.0.1"',
        'AdvertisedIP = "0.0.0.0"',
      ),
      template.replace('Encoding = "big5"', 'Encoding = "bogus"'),
      template.replace('Name = "BnB初級-1"', `Name = "${"初".repeat(17)}"`),
      template.replace('Host = "0.0.0.0"', 'Host = ""'),
      template.replace("Registration = false", "Regisration = false"),
      template.replace(
        'Greetings = ["ftp://download.nexon.co.kr/ca"]',
        'Greetings = [""]',
      ),
    ]) {
      writeFileSync(path, contents);
      expect(() => CServerConfig.Load(path)).toThrow();
    }
  } finally {
    unlinkSync(path);
  }
});
test("transfer IP is host-order, MultiServer inet_addr is deliberately different", () => {
  expect(IPv4Number("127.0.0.1")).toBe(0x7f000001);
  expect(InetAddr("127.0.0.1")).toBe(0x0100007f);
  expect(IPv4Number("192.168.1.2")).toBe(0xc0a80102);
  expect(InetAddr("192.168.1.2")).toBe(0x0201a8c0);
  expect(NormalizePeerIP("::ffff:192.168.1.2")).toBe("192.168.1.2");
  expect(() => IPv4Number("999.0.0.1")).toThrow();
});
test("runtime admission limit is bounded and expires; it is not official game logic", () => {
  let t = 0;
  const gate = new CRateLimiter(2, 1000, 1, () => t);
  expect(gate.Admit("a")).toBe(true);
  expect(gate.Admit("a")).toBe(true);
  expect(gate.Admit("a")).toBe(false);
  expect(gate.Admit("b")).toBe(false);
  t = 1000;
  expect(gate.Admit("b")).toBe(true);
  expect(gate.Admit("a")).toBe(false);
});
test("audited signed C++ integrity constants survive conversion without a hexadecimal typo", () => {
  expect(OpaqueOfficial.FxClientIntegrityXor).toEqual([
    -250197109 >>> 0,
    287445282,
  ]);
  expect(OpaqueOfficial.FxClientRTTIntegrity).toEqual([
    -551932335 >>> 0,
    287445282,
  ]);
});
function frame(
  source: number,
  destination: number,
  payload = Buffer.from([1, 2, 3]),
): Buffer {
  const n = payload.length + 9;
  const b = Buffer.alloc(n + 1);
  b[0] = n;
  b.writeUInt32BE(source, 1);
  b.writeUInt32BE(destination, 5);
  b.set(payload, 9);
  b[n] = CCRC8.UpdateCRC(0, b.subarray(0, n));
  return b;
}
test("relay strips nine-byte header, re-frames payload and verifies seeded CRC8", () => {
  const raw = frame(0x11223344, 0xaabbccdd);
  const decoded = DecodeRelayDatagram(raw);
  expect(decoded).toEqual([
    {
      source: 0x11223344,
      destination: 0xaabbccdd,
      payload: Buffer.from([1, 2, 3]),
    },
  ]);
  const forwarded = EncodeUnregisteredDatagram(decoded[0]!.payload);
  expect(forwarded.subarray(0, 4).toString("hex")).toBe("04010203");
  expect(CCRC8.UpdateCRC(0, forwarded)).toBe(0);
  expect(
    DecodeRelayDatagram(Buffer.concat([raw, frame(0x11223344, 10)])).length,
  ).toBe(2);
});
test("relay rejects length-underflow, mixed-source, oversize, truncation and corrupt CRC", () => {
  for (let n = 0; n < 9; n++) {
    const b = Buffer.alloc(n + 1);
    b[0] = n;
    expect(() => DecodeRelayDatagram(b)).toThrow();
  }
  const good = frame(1, 2);
  const bad = Buffer.from(good);
  bad[9] = bad[9]! ^ 1;
  expect(() => DecodeRelayDatagram(bad)).toThrow("CRC");
  expect(() => DecodeRelayDatagram(good.subarray(0, -1))).toThrow();
  expect(() => DecodeRelayDatagram(Buffer.alloc(4097))).toThrow();
  expect(() => DecodeRelayDatagram(Buffer.concat([good, frame(2, 3)]))).toThrow(
    "Mixed",
  );
  expect(() => EncodeUnregisteredDatagram(Buffer.alloc(255))).toThrow();
});
