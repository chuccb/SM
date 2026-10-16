import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const OFFICIAL_SERVICES = {
  Center: "Center/CxCenter.exe",
  LS: "LS/CxLogin.exe",
  FXGS: "FXGS/FxServer.exe",
  FXSS: "FXSS/FxShop.exe",
  FXUS: "FXUS/CxUtil.exe",
  Relay: "Relay/CXRELAY.EXE",
} as const;
export type OfficialService = keyof typeof OFFICIAL_SERVICES;

export interface OfficialFunction {
  service: OfficialService;
  file: string;
  address: string;
  line: number;
  endLine: number;
  signature: string;
  name: string;
  library: boolean;
  body: string;
}

/** IDA's function separator is more reliable than C++ declarations in pseudocode. */
export function readFunctions(service: OfficialService): OfficialFunction[] {
  const file = `${OFFICIAL_SERVICES[service]}.c`;
  const lines = readFileSync(file, "utf8").split("\n");
  const starts: { address: string; index: number }[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\/\/-+ \(([0-9A-F]+)\) -+/.exec(line);
    if (match) starts.push({ address: match[1]!, index });
  }
  return starts.map((start, i) => {
    const end = starts[i + 1]?.index ?? lines.length;
    const bodyLines = lines.slice(start.index + 1, end);
    const open = bodyLines.findIndex((line) => line === "{");
    const signature = bodyLines
      .slice(0, open < 0 ? 1 : open)
      .join(" ")
      .trim();
    const match = /(?:__\w+\s+)?((?:[\w~]+::)*[\w~]+)(?:@<[^>]+>)?\s*\(/.exec(
      signature,
    );
    const name = match?.[1] ?? signature;
    const library =
      /_STL::|ATL::|std::|^_?\w*(?:alloc|memcpy)|^(?:operator |sub_|loc_|nullsub_)/.test(
        name,
      );
    return {
      service,
      file,
      address: `0x${start.address}`,
      line: start.index + 1,
      endLine: end,
      signature,
      name,
      library,
      body: bodyLines.join("\n"),
    };
  });
}

/** Read bytes at a VA in the actual PE, not an older .map with different addresses. */
export class CPeImage {
  readonly bytes: Buffer;
  readonly imageBase: number;
  readonly sha256: string;
  readonly sections: {
    name: string;
    rva: number;
    size: number;
    raw: number;
    rawSize: number;
  }[];

  constructor(readonly file: string) {
    this.bytes = readFileSync(file);
    if (this.bytes.toString("ascii", 0, 2) !== "MZ")
      throw new Error(`${file}: not a PE`);
    const pe = this.bytes.readUInt32LE(0x3c);
    if (this.bytes.readUInt32LE(pe) !== 0x4550)
      throw new Error(`${file}: invalid PE signature`);
    const count = this.bytes.readUInt16LE(pe + 6);
    const optionalSize = this.bytes.readUInt16LE(pe + 20);
    if (this.bytes.readUInt16LE(pe + 24) !== 0x10b)
      throw new Error("Expected 32-bit PE");
    this.imageBase = this.bytes.readUInt32LE(pe + 52);
    this.sha256 = createHash("sha256").update(this.bytes).digest("hex");
    this.sections = [];
    for (let i = 0; i < count; i++) {
      const at = pe + 24 + optionalSize + i * 40;
      this.sections.push({
        name: this.bytes.toString("ascii", at, at + 8).replace(/\0.*$/, ""),
        size: this.bytes.readUInt32LE(at + 8),
        rva: this.bytes.readUInt32LE(at + 12),
        rawSize: this.bytes.readUInt32LE(at + 16),
        raw: this.bytes.readUInt32LE(at + 20),
      });
    }
  }

  read(va: number, length: number): Buffer {
    const rva = va - this.imageBase;
    const section = this.sections.find(
      (s) => rva >= s.rva && rva + length <= s.rva + s.rawSize,
    );
    if (!section || length < 0)
      throw new Error(
        `${this.file}: unmapped VA 0x${va.toString(16)} + ${length}`,
      );
    return Buffer.from(
      this.bytes.subarray(
        section.raw + rva - section.rva,
        section.raw + rva - section.rva + length,
      ),
    );
  }

  symbolVA(symbol: string): number {
    const lst = readFileSync(`${this.file}.lst`, "utf8");
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(
      `^\\.\\w+:([0-9A-F]+)[^\\n]*\\b${escaped}(?:@\\S+)?\\s+(?:db|dw|dd)\\b`,
      "m",
    ).exec(lst);
    if (!match)
      throw new Error(`${this.file}.lst: cannot locate data symbol ${symbol}`);
    return Number.parseInt(match[1]!, 16);
  }
}
