/**
 * Validates Mermaid files with the real Mermaid parser.
 *   MERMAID_HOME=/dir node scripts/validate-mermaid.mjs file.mmd [more files...]
 * MERMAID_HOME is a directory where `npm install mermaid jsdom` has been run (nothing is added to this repo).
 * Prints one line per file; exits 1 if any file is rejected.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const home = process.env.MERMAID_HOME;
if (!home) {
  console.error("MERMAID_HOME is not set");
  process.exit(2);
}
const { JSDOM } = await import(pathToFileURL(join(home, "node_modules", "jsdom", "lib", "api.js")).href);
const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const { default: mermaid } = await import(pathToFileURL(join(home, "node_modules", "mermaid", "dist", "mermaid.core.mjs")).href);
mermaid.initialize({ startOnLoad: false });

let failed = 0;
for (const file of process.argv.slice(2)) {
  try {
    await mermaid.parse(readFileSync(file, "utf8"));
    console.log(`ok       ${file}`);
  } catch (e) {
    failed++;
    console.log(`REJECTED ${file}: ${String(e?.message ?? e).split("\n").slice(0, 3).join(" | ")}`);
  }
}
process.exit(failed ? 1 : 0);
