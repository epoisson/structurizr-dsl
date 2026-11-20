/**
 * Dependency-free build for the extension (Node 22.13+ to build; the output needs only VS Code's own Node).
 *
 * dist/extension.cjs   CommonJS shim: the extension host require()s it, and it import()s the ES modules
 * dist/esm/            the extension code and the core, types stripped, plain ES modules
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const esm = join(dist, "esm");
const sources = [
  { from: join(root, "..", "core", "src"), to: join(esm, "core") },
  { from: join(root, "..", "viewer", "src"), to: join(esm, "viewer") },
  { from: join(root, "..", "exporters", "src"), to: join(esm, "exporters") },
  { from: join(root, "src"), to: join(esm, "ext") },
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
    let js = stripTypeScriptTypes(readFileSync(from, "utf8"), { mode: "strip" });
    js = js.replace(/((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, "$1$2.js$3");
    js = js.replaceAll("../../core/src/", "../core/").replaceAll("../../viewer/src/", "../viewer/").replaceAll("../../exporters/src/", "../exporters/"); // source layout -> dist layout
    writeFileSync(join(toDir, name.replace(/\.ts$/, ".js")), js);
    count++;
  }
}
for (const s of sources) build(s.from, s.to);

writeFileSync(join(esm, "package.json"), JSON.stringify({ type: "module" }) + "\n");
writeFileSync(
  join(dist, "extension.cjs"),
  `"use strict";
// The extension host loads this CommonJS file; the real code is ES modules in ./esm.
let ext;
exports.activate = async (context) => {
  const vscode = require("vscode");
  ext = await import("./esm/ext/adapter.js");
  ext.activate(vscode, context);
};
exports.deactivate = () => ext && ext.deactivate();
`,
);
console.log(`built ${count} files into ${dist}`);
