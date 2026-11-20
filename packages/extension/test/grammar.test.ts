import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONTEXTS, GLOBAL_DIRECTIVES } from "../../core/src/index.ts";
import { KEYWORD_GROUPS } from "../src/grammar-lists.ts";

const grammar = JSON.parse(readFileSync(new URL("../syntaxes/structurizr.tmLanguage.json", import.meta.url), "utf8"));

/** Flatten every rule that has a `match`, with its scope name. */
function rules(): Array<{ name: string; re: RegExp }> {
  const out: Array<{ name: string; re: RegExp }> = [];
  const visit = (node: any): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node && typeof node === "object") {
      if (typeof node.match === "string" && node.name) {
        // Oniguruma's inline (?i) is JavaScript's `i` flag
        const insensitive = node.match.startsWith("(?i)");
        out.push({ name: node.name, re: new RegExp(insensitive ? node.match.slice(4) : node.match, insensitive ? "i" : "") });
      }
      Object.values(node).forEach(visit);
    }
  };
  visit(grammar.repository);
  return out;
}
const scopesOf = (text: string): string[] => rules().filter((r) => r.re.test(text)).map((r) => r.name.replace(/\.structurizr$/, ""));

test("grammar metadata", () => {
  assert.equal(grammar.scopeName, "source.structurizr");
  assert.ok(rules().length > 15);
});

test("every keyword in the grammar inventory is highlighted, in exactly one group", () => {
  const all = [...KEYWORD_GROUPS.element, ...KEYWORD_GROUPS.structure, ...KEYWORD_GROUPS.view, ...KEYWORD_GROUPS.property, ...KEYWORD_GROUPS.style];
  const dupes = all.filter((w, i) => all.indexOf(w) !== i);
  assert.deepEqual(dupes, []);
  const known = new Set(all.map((w) => w.toLowerCase()));
  const missing = new Set<string>();
  for (const c of CONTEXTS) for (const s of c.statements) {
    if (s.kind === "operator" || s.keyword.startsWith("!")) continue;
    if (!known.has(s.keyword.toLowerCase())) missing.add(s.keyword);
  }
  assert.deepEqual([...missing], []);
  assert.ok(GLOBAL_DIRECTIVES.every((d) => d.keyword.startsWith("!")));
});

test("keywords are matched case-insensitively, as whole words", () => {
  assert.ok(scopesOf("softwareSystem").includes("entity.name.type.element"));
  assert.ok(scopesOf("SOFTWARESYSTEM").includes("entity.name.type.element"));
  assert.ok(scopesOf("views").includes("keyword.control.structure"));
  assert.ok(scopesOf("autolayout").includes("keyword.other.view"));
  assert.ok(scopesOf("strokeWidth").includes("support.type.property-name.style"));
  assert.ok(!scopesOf("personality").includes("entity.name.type.element"));
  assert.ok(!scopesOf("ss.person").includes("entity.name.type.element")); // part of a dotted identifier
});

test("operators, directives, comments, strings, constants", () => {
  assert.ok(scopesOf("->").includes("keyword.operator.relationship"));
  assert.ok(scopesOf("--https->").includes("keyword.operator.relationship"));
  assert.ok(scopesOf("-/>").includes("keyword.operator.relationship"));
  assert.ok(!scopesOf("x->y").includes("keyword.operator.relationship"));
  assert.ok(scopesOf("!identifiers").includes("keyword.control.directive"));
  assert.ok(scopesOf("# a comment").includes("comment.line.number-sign"));
  assert.ok(!scopesOf("background #ff0000").includes("comment.line.number-sign")); // colour, not a comment
  assert.ok(scopesOf("background #ff0000").includes("constant.other.color"));
  assert.ok(scopesOf("x // note").includes("comment.line.double-slash"));
  assert.ok(scopesOf("true").includes("constant.language.boolean"));
  assert.ok(scopesOf("300").includes("constant.numeric"));
  assert.ok(scopesOf("RoundedBox").includes("support.constant"));
  assert.ok(scopesOf("${NAME}").includes("variable.other.substitution"));
});

test("string and comment rules are begin/end pairs", () => {
  const s = grammar.repository.strings.patterns;
  assert.ok(s.some((p: any) => p.begin === '"""' && p.end === '"""'));
  assert.ok(s.some((p: any) => p.begin === '"'));
  assert.ok(grammar.repository.comments.patterns.some((p: any) => p.begin === "/\\*"));
});

test("language configuration is valid JSON with the expected pieces", () => {
  const c = JSON.parse(readFileSync(new URL("../language-configuration.json", import.meta.url), "utf8"));
  assert.equal(c.comments.lineComment, "//");
  assert.deepEqual(c.comments.blockComment, ["/*", "*/"]);
  assert.ok(new RegExp(c.indentationRules.increaseIndentPattern).test("model {"));
  assert.ok(new RegExp(c.indentationRules.increaseIndentPattern).test("model { // comment"));
  assert.ok(new RegExp(c.indentationRules.decreaseIndentPattern).test("  }"));
});

test("the manifest contributes the language and the grammar", () => {
  const p = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(p.contributes.languages[0].id, "structurizr");
  assert.deepEqual(p.contributes.languages[0].extensions, [".dsl"]);
  assert.equal(p.contributes.grammars[0].language, "structurizr");
  assert.equal(p.main, "./dist/extension.cjs");
  assert.ok(p.activationEvents.includes("onLanguage:structurizr"));
  // every contributed command has an activation event and is wired in the adapter
  for (const c of p.contributes.commands) assert.ok(p.activationEvents.includes(`onCommand:${c.command}`), c.command);
});
