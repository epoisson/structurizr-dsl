/**
 * Renders src/grammar/inventory.ts into docs/grammar-inventory.md.
 * Run: npm run gen:inventory   (from packages/core)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTEXTS, ENUMS, FINDINGS, GLOBAL_DIRECTIVES, OPEN_QUESTIONS } from "../src/grammar/inventory.ts";
import type { Statement } from "../src/grammar/inventory.ts";

const cell = (t: string): string => t.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const code = (t: string): string => "`" + cell(t) + "`";

function statementTable(rows: Statement[]): string {
  const out = ["| Keyword | Syntax | Body | Status | Notes |", "|---|---|---|---|---|"];
  for (const r of rows) {
    const body =
      r.block === "required" ? `required → \`${r.opens ?? "…"}\`` : r.block === "optional" ? `optional${r.opens ? ` → \`${r.opens}\`` : ""}` : "";
    const flags = [r.status && r.status !== "planned" ? r.status : "", r.assignable ? "assignable" : ""].filter(Boolean).join(", ");
    out.push(`| ${code(r.keyword)} | ${code(r.syntax)} | ${body} | ${flags} | ${cell(r.note ?? "")} |`);
  }
  return out.join("\n");
}

const lines: string[] = [];
const all = [...GLOBAL_DIRECTIVES, ...CONTEXTS.flatMap((c) => c.statements)];
const count = (st: string): number => all.filter((s) => (s.status ?? "planned") === st).length;

lines.push("# Structurizr DSL grammar inventory", "");
lines.push("> Generated from `packages/core/src/grammar/inventory.ts` by `npm run gen:inventory`. Do not edit by hand.", "");
lines.push(
  "Source: the official language reference (https://docs.structurizr.com/dsl/language) plus the Basics, Archetypes, Expressions and Includes pages, read on 2026-10-29.",
  "",
);
lines.push(
  `**${CONTEXTS.length} contexts, ${new Set(all.map((x) => x.keyword.toLowerCase())).size} distinct keywords/operators, ${all.length} statement entries** (an entry is a keyword within one context; ${count("planned")} planned, ${count("deferred")} deferred, ${count("deprecated")} deprecated, ${count("unverified")} unverified).`,
  "",
);
lines.push("Status: *planned* = first iteration; *deferred* = parsed to a node, not executed, emits a diagnostic; *deprecated* = parsed with a warning; *unverified* = under-documented or recalled from older docs.", "");

lines.push("## Design findings", "");
for (const f of FINDINGS) {
  lines.push(`### ${f.id}. ${f.title}`, "", f.detail, "", `**Impact:** ${f.impact}`, "");
}

lines.push("## Global directives", "", "Valid wherever a statement may start; handled by the preprocessor stage.", "", statementTable(GLOBAL_DIRECTIVES), "");

lines.push("## Enumerations", "");
for (const [name, values] of Object.entries(ENUMS)) lines.push(`- **${name}**: ${values.map((v) => "`" + v + "`").join(", ")}`);
lines.push("");

lines.push("## Contexts", "");
for (const c of CONTEXTS) {
  lines.push(`### \`${c.id}\` — ${c.title}`, "", `Entered by: ${code(c.entered)}`, "");
  if (c.note) lines.push(`> ${c.note}`, "");
  if (c.archetypeKinds) lines.push(`Archetypes of these kinds act as keywords here: ${c.archetypeKinds.map((k) => "`" + k + "`").join(", ")}`, "");
  if (c.raw) lines.push("Body is raw text, not DSL.", "");
  if (c.lines) lines.push("Line grammar:", "", "```", c.lines, "```", "");
  if (c.statements.length) lines.push(statementTable(c.statements), "");
}

// Keyword index: where does each keyword appear?
const index = new Map<string, Set<string>>();
for (const c of CONTEXTS) for (const st of c.statements) {
  const key = st.keyword.toLowerCase();
  (index.get(key) ?? index.set(key, new Set()).get(key)!).add(c.id);
}
lines.push("## Keyword index", "", "Keywords that appear in more than one context (see finding F7):", "");
for (const [k, ctxs] of [...index].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (ctxs.size > 1) lines.push(`- \`${k}\`: ${[...ctxs].map((x) => "`" + x + "`").join(", ")}`);
}
lines.push("", "## Open questions to verify", "");
for (const q of OPEN_QUESTIONS) lines.push(`- ${q}`);
lines.push("");

const out = fileURLToPath(new URL("../../../docs/grammar-inventory.md", import.meta.url));
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out}`);
