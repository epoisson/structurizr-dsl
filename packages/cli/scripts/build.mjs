/**
 * Dependency-free build: strips TypeScript types with Node's built-in `module.stripTypeScriptTypes`
 * (Node 22.13+ to BUILD) and writes plain ES modules that run on Node 18+.
 *
 * Output (packages/cli/dist):
 *   core/   the parser and resolver
 *   cli/    the command line; bin.js is the entry point (has a shebang, is executable)
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const dist = join(cliRoot, "dist");
const sources = [
  { from: join(cliRoot, "..", "core", "src"), to: join(dist, "core") },
  { from: join(cliRoot, "..", "viewer", "src"), to: join(dist, "viewer") },
  { from: join(cliRoot, "..", "exporters", "src"), to: join(dist, "exporters") },
  { from: join(cliRoot, "src"), to: join(dist, "cli") },
];

rmSync(dist, { recursive: true, force: true });

let count = 0;
function build(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const name of readdirSync(fromDir)) {
    const from = join(fromDir, name);
    if (statSync(from).isDirectory()) {
      build(from, join(toDir, name));
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    const stripped = stripTypeScriptTypes(readFileSync(from, "utf8"), { mode: "strip" });
    // `./x.ts` -> `./x.js` in static imports, re-exports and dynamic imports
    let js = stripped.replace(/((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, "$1$2.js$3");
    // the source tree reaches the core at ../../core/src/, but dist/ lays it out as dist/core/
    js = js.replaceAll("../../core/src/", "../core/").replaceAll("../../viewer/src/", "../viewer/").replaceAll("../../exporters/src/", "../exporters/");
    writeFileSync(join(toDir, name.replace(/\.ts$/, ".js")), js);
    count++;
  }
}
for (const s of sources) build(s.from, s.to);

writeFileSync(join(dist, "package.json"), JSON.stringify({ type: "module" }) + "\n");

const bin = join(dist, "cli", "bin.js");
writeFileSync(bin, "#!/usr/bin/env node\n" + readFileSync(bin, "utf8"));
chmodSync(bin, 0o755);
console.log(`built ${count} files into ${dist}`);
