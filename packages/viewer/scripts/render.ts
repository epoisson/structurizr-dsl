/** Dev helper: node scripts/render.ts <file.dsl> <outDir> [--dark]  writes one SVG per view. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "../../core/src/index.ts";
import { renderView } from "../src/index.ts";

const [file, outDir, flag] = process.argv.slice(2);
if (!file || !outDir) throw new Error("usage: node scripts/render.ts <file.dsl> <outDir> [--dark]");
const r = load(readFileSync(file, "utf8"));
for (const d of r.diagnostics) console.error(`${d.severity} [${d.code}] ${d.message}`);
mkdirSync(outDir, { recursive: true });
for (const v of r.workspace.views) {
  const out = renderView(r.workspace, v.key, { dark: flag === "--dark" });
  if (out) writeFileSync(join(outDir, `${v.key}.svg`), out.svg);
  console.log(`${v.key}: ${out ? `${Math.round(out.width)}x${Math.round(out.height)}, ${out.nodes.length} nodes, ${out.edges.length} edges` : "-"}`);
}
