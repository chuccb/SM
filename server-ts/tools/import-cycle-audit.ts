#!/usr/bin/env bun
/** Port-only architecture check: reject static ESM value-import cycles in src/. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../src");
const transpiler = new Bun.Transpiler({ loader: "ts" });

function collect(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collect(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function resolveModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const candidate = resolve(dirname(importer), specifier);
  for (const path of [candidate, `${candidate}.ts`, join(candidate, "index.ts")]) {
    if (existsSync(path)) return normalize(path);
  }
  throw new Error(`${relative(root, importer)} imports missing module ${specifier}`);
}

const files = collect(root).map(normalize);
const edges = new Map(files.map((file) => [file, new Set<string>()]));
for (const file of files) {
  const imports = transpiler.scan(readFileSync(file, "utf8")).imports;
  for (const dependency of imports) {
    // Bun labels static imports/re-exports this way and omits type-only edges.
    if (dependency.kind !== "import-statement") continue;
    const target = resolveModule(file, dependency.path);
    if (target && edges.has(target)) edges.get(file)!.add(target);
  }
}

let index = 0;
const indexes = new Map<string, number>();
const lowLinks = new Map<string, number>();
const stack: string[] = [];
const onStack = new Set<string>();
const cycles: string[][] = [];

function visit(file: string): void {
  indexes.set(file, index);
  lowLinks.set(file, index++);
  stack.push(file);
  onStack.add(file);
  for (const target of edges.get(file)!) {
    if (!indexes.has(target)) {
      visit(target);
      lowLinks.set(file, Math.min(lowLinks.get(file)!, lowLinks.get(target)!));
    } else if (onStack.has(target)) {
      lowLinks.set(file, Math.min(lowLinks.get(file)!, indexes.get(target)!));
    }
  }
  if (lowLinks.get(file) !== indexes.get(file)) return;
  const component: string[] = [];
  let member: string;
  do {
    member = stack.pop()!;
    onStack.delete(member);
    component.push(relative(root, member));
  } while (member !== file);
  if (component.length > 1 || edges.get(file)!.has(file)) cycles.push(component);
}

for (const file of files) if (!indexes.has(file)) visit(file);
if (cycles.length) {
  for (const cycle of cycles) console.error(`Static value-import cycle: ${cycle.join(" -> ")}`);
  process.exit(1);
}
console.log(`Static value-import graph: ${files.length} modules, 0 cycles.`);
