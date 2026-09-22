import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ServiceEvidence {
  readonly directory: string;
  readonly artifact: string;
  readonly provenanceArtifact: string;
  readonly sourcePrefixes: readonly string[];
}

const currentDir = typeof import.meta.dir === "string" ? import.meta.dir : dirname(fileURLToPath(import.meta.url));
const PORT_SOURCE_ROOT = resolve(currentDir, "../src");
const REPOSITORY_ROOT = resolve(currentDir, "../..");
const HEADER_SCAN_BYTES = 1_600;

const SERVICE_EVIDENCE: readonly ServiceEvidence[] = [
  {
    directory: "Center",
    artifact: "Center/CxCenter.exe.c",
    provenanceArtifact: "Center/CxCenter.pdb",
    sourcePrefixes: ["CX/CxCenter/"],
  },
  {
    directory: "LS",
    artifact: "LS/CxLogin.exe.c",
    provenanceArtifact: "LS/CxLogin.pdb",
    sourcePrefixes: ["CX/CxLogin/", "common/"],
  },
  {
    directory: "FXGS",
    artifact: "FXGS/FxServer.exe.c",
    provenanceArtifact: "FXGS/FxServer.pdb",
    sourcePrefixes: ["FX/FxServer/", "FX/common/", "common/"],
  },
  {
    directory: "FXSS",
    artifact: "FXSS/FxShop.exe.c",
    provenanceArtifact: "FXSS/FxShop.pdb",
    sourcePrefixes: ["FX/FxShop/"],
  },
  {
    directory: "FXUS",
    artifact: "FXUS/CxUtil.exe.c",
    provenanceArtifact: "FXUS/CxUtil.pdb",
    sourcePrefixes: ["CX/CxUtil/"],
  },
  {
    directory: "Relay",
    artifact: "Relay/CXRELAY.EXE.c",
    provenanceArtifact: "Relay/CXRELAY.PDB",
    sourcePrefixes: ["CX/CxRelay/"],
  },
];

const NATIVE_SOURCE_PATTERN = /Native source unit:\s*([^\n*]+?\.cpp)\.?/i;
const PORT_BOUNDARY_PATTERN = /\bPort-only\b|\bPublic façade\b/i;
const EXPORTED_CLASS_PATTERN = /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;

function NormalizePath(path: string): string {
  return path.replaceAll("\\", "/").trim();
}

function IsUnderKnownSourceRoot(path: string, prefixes: readonly string[]): boolean {
  const normalized = path.toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

function EscapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function NativeClassNames(source: string): string[] {
  return Array.from(source.matchAll(EXPORTED_CLASS_PATTERN), (match) => match[1]!);
}

const errors: string[] = [];
let nativeUnits = 0;
let sourcePathEvidence = 0;
let objectOnlyEvidence = 0;
let portBoundaries = 0;
let checkedClasses = 0;

for (const service of SERVICE_EVIDENCE) {
  const serviceRoot = join(PORT_SOURCE_ROOT, service.directory);
  const artifact = await readFile(join(REPOSITORY_ROOT, service.artifact), "utf8");
  const provenance = NormalizePath(
    await readFile(join(REPOSITORY_ROOT, service.provenanceArtifact), "latin1"),
  ).toLowerCase();
  const claimedNativeUnits = new Map<string, string>();
  const entries = (await readdir(serviceRoot, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile() && extname(entry.name) === ".ts")
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const file = join(entry.parentPath ?? serviceRoot, entry.name);
    const source = await readFile(file, "utf8");
    const header = source.slice(0, HEADER_SCAN_BYTES);
    const nativeMatch = header.match(NATIVE_SOURCE_PATTERN);

    if (nativeMatch) {
      nativeUnits += 1;
      const nativePath = NormalizePath(nativeMatch[1]!);
      const sourceStem = basename(nativePath, extname(nativePath));
      const moduleStem = basename(entry.name, extname(entry.name));

      if (sourceStem.toLowerCase() !== moduleStem.toLowerCase()) {
        errors.push(
          `${service.directory}/${entry.name}: module name does not match native source ${nativePath}`,
        );
      }
      if (!IsUnderKnownSourceRoot(nativePath, service.sourcePrefixes)) {
        errors.push(
          `${service.directory}/${entry.name}: unrecognized native source root in ${nativePath}`,
        );
      }

      const nativeKey = nativePath.toLowerCase();
      if (provenance.includes(nativeKey)) {
        sourcePathEvidence += 1;
      } else {
        // Center and Relay PDBs retain object records but omit source-file
        // records. A decimal suffix is allowed for the observed COMDAT case
        // (ChannelCache.cpp → ChannelCache1.obj); unrelated basenames are not.
        const objectPattern = new RegExp(`${EscapeRegExp(sourceStem)}\\d*\\.obj`, "i");
        if (objectPattern.test(provenance)) objectOnlyEvidence += 1;
        else {
          errors.push(
            `${service.directory}/${entry.name}: ${nativePath} is absent from ${service.provenanceArtifact}`,
          );
        }
      }

      const priorOwner = claimedNativeUnits.get(nativeKey);
      if (priorOwner) {
        errors.push(
          `${service.directory}/${entry.name}: ${nativePath} is already owned by ${priorOwner}`,
        );
      } else {
        claimedNativeUnits.set(nativeKey, entry.name);
      }

      for (const className of NativeClassNames(source)) {
        checkedClasses += 1;
        if (!artifact.includes(className)) {
          errors.push(
            `${service.directory}/${entry.name}: exported ${className} is absent from ${service.artifact}`,
          );
        }
      }
      continue;
    }

    if (PORT_BOUNDARY_PATTERN.test(header)) {
      portBoundaries += 1;
      continue;
    }

    errors.push(
      `${service.directory}/${entry.name}: declare a native .cpp owner or document the port-only boundary`,
    );
  }
}

if (errors.length !== 0) {
  console.error("Source-boundary audit failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Source-boundary audit passed: ${nativeUnits} native units ` +
      `(${sourcePathEvidence} source paths, ${objectOnlyEvidence} object-only records), ` +
      `${portBoundaries} explicit port boundaries, ${checkedClasses} native classes checked.`,
  );
}
