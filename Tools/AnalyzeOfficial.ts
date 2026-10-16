import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  OFFICIAL_SERVICES,
  readFunctions,
  type OfficialService,
} from "./OfficialSource.ts";

const [command = "index", term = ""] = Bun.argv.slice(2);
const services = Object.keys(OFFICIAL_SERVICES) as OfficialService[];
if (command === "find" || command === "show") {
  if (!term)
    throw new Error(
      "Usage: bun run analyze find|show <function, address, or service>",
    );
  for (const service of services) {
    for (const f of readFunctions(service)) {
      if (
        `${f.service} ${f.name} ${f.address}`
          .toLowerCase()
          .includes(term.toLowerCase())
      ) {
        console.log(
          `${f.file}:${f.line}-${f.endLine} @ ${f.address}\n${command === "show" ? f.body : f.signature}\n`,
        );
      }
    }
  }
} else if (command === "index") {
  mkdirSync("docs/generated", { recursive: true });
  const summary = [];
  for (const service of services) {
    const all = readFunctions(service);
    const file = `${OFFICIAL_SERVICES[service]}.c`;
    const sha256 = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
    const functions = all.map(({ body, ...f }) => ({
      ...f,
      calls: [
        ...new Set(
          [
            ...body.matchAll(/\b((?:C\w+|MTUDP\w*|c\w+|_USER\w*)::\w+)\s*\(/g),
          ].map((m) => m[1]!),
        ),
      ].filter((n) => n !== f.name),
      storedProcedures: [...body.matchAll(/SetCmdText\([^\n]*?"([^"]+)"/g)].map(
        (m) => m[1]!,
      ),
      // Raw observations, NOT claims that literals are opcodes or understood constants.
      packetConstructors: [
        ...body.matchAll(
          /CSendPacket::(?:CSendPacket|InitPacket)\([^;]*?,\s*(0x[\dA-Fa-f]+|\d+)\s*(?:,\s*\d+\w*)?\)/g,
        ),
      ].map((m) => m[1]!),
      decompilerWarnings: body
        .split("\n")
        .filter((l) =>
          /^\/\/.*(?:guessed|undefined|failed|positive sp|could not|variables)/.test(
            l,
          ),
        )
        .map((l) => l.slice(3)),
    }));
    writeFileSync(
      `docs/generated/${service}.functions.json`,
      `${JSON.stringify({ file, sha256, functions }, null, 2)}\n`,
    );
    const methods = functions.filter((f) =>
      /^(?:C[A-Z]\w*|MTUDP\w*|c[A-Z]\w*)::/.test(f.name),
    );
    summary.push({
      service,
      functions: all.length,
      namedClassMethods: methods.length,
      sourceLines: readFileSync(file, "utf8").split("\n").length - 1,
      sha256,
    });
  }
  writeFileSync(
    "docs/generated/inventory.json",
    `${JSON.stringify({ sourceCommit: "f88df7d8aa2bbe06511d09c81aefd183c781fcea", services: summary }, null, 2)}\n`,
  );
  console.table(summary.map(({ sha256: _hash, ...s }) => s));
} else {
  throw new Error("Usage: bun run analyze [index | find <term> | show <term>]");
}
