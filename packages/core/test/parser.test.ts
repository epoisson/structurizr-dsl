import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "../src/index.ts";
import type { Diagnostic, StatementNode } from "../src/index.ts";

const codes = (src: string): string[] => parse(src).diagnostics.map((d) => d.code);
const errors = (src: string): Diagnostic[] => parse(src).diagnostics.filter((d) => d.severity === "error");
const wrap = (model: string): string => `workspace {\n model {\n${model}\n }\n}\n`;
const modelOf = (src: string): StatementNode[] => {
  const ws = parse(src).root.children[0]!;
  return ws.body!.children.find((c) => c.keyword === "model")!.body!.children;
};

// ---------------------------------------------------------------------------
// well-formed input
// ---------------------------------------------------------------------------

test("fixture covering most of the grammar parses with no diagnostics", () => {
  const r = parse(readFileSync(new URL("./fixtures/full.dsl", import.meta.url), "utf8"));
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.firstError, undefined);
});

test("minimal workspace: tree shape and ranges", () => {
  const r = parse('workspace "Name" "Desc" {\n  model {\n  }\n}\n');
  assert.deepEqual(r.diagnostics, []);
  const ws = r.root.children[0]!;
  assert.equal(ws.keyword, "workspace");
  assert.deepEqual(ws.args.map((a) => a.value), ["Name", "Desc"]);
  assert.equal(ws.body?.context, "workspace");
  assert.equal(ws.range.start.line, 0);
  assert.equal(ws.range.end.line, 3);
  const model = ws.body!.children[0]!;
  assert.equal(model.keyword, "model");
  assert.equal(model.body?.closed, true);
});

test("keywords are case-insensitive and normalised to the canonical spelling", () => {
  const stmts = modelOf(wrap('a = SOFTWARESYSTEM "X"\n b = Person "Y"'));
  assert.deepEqual(stmts.map((s) => s.keyword), ["softwareSystem", "person"]);
  assert.equal(stmts[0]!.identifier?.value, "a");
});

test("the three relationship forms plus the remove operator", () => {
  const src = wrap(
    'archetypes {\n sync = ->\n}\n' +
      'a = softwareSystem "A" {\n -> b "implicit"\n this -> b "this"\n}\n' +
      'b = softwareSystem "B"\n' +
      'a -> b "explicit" "tech" "tag"\n' +
      'a --sync-> b "archetype"\n' +
      "r = a -> b \"assigned\"\n",
  );
  const r = parse(src);
  assert.deepEqual(r.diagnostics, []);
  const model = modelOf(src);
  const a = model.find((s) => s.identifier?.value === "a")!;
  const [implicit, withThis] = a.body!.children;
  assert.equal(implicit!.source, undefined);
  assert.equal(implicit!.args[0]!.value, "b");
  assert.equal(withThis!.source?.value, "this");
  const explicit = model.find((s) => s.args[1]?.value === "explicit")!;
  assert.equal(explicit.source?.value, "a");
  assert.deepEqual(explicit.args.map((x) => x.value), ["b", "explicit", "tech", "tag"]);
  const arch = model.find((s) => s.operator?.value === "--sync->")!;
  assert.equal(arch.keyword, "--<archetype>->");
  assert.equal(model.find((s) => s.identifier?.value === "r")?.form, "relationship");
});

test("archetype definitions and uses, including chains", () => {
  const src = wrap(
    "archetypes {\n app = container\n boot = app {\n technology \"Spring\"\n }\n}\n" +
      'ss = softwareSystem "S" {\n a = boot "A"\n b = app "B"\n}',
  );
  assert.deepEqual(parse(src).diagnostics, []);
  const ss = modelOf(src).find((s) => s.identifier?.value === "ss")!;
  const [a, b] = ss.body!.children;
  assert.equal(a!.keyword, "container");
  assert.equal(a!.usesArchetype, "boot");
  assert.equal(b!.usesArchetype, "app");
  const defs = modelOf(src)[0]!.body!.children;
  assert.equal(defs[1]!.form, "archetype");
  assert.equal(defs[1]!.archetype?.base, "container");
});

test("pair and identifier-list lines", () => {
  const src = wrap('softwareSystem "S" {\n properties {\n "a" "b"\n c d\n }\n}');
  assert.deepEqual(parse(src).diagnostics, []);
  const props = modelOf(src)[0]!.body!.children[0]!.body!;
  assert.deepEqual(props.children.map((c) => [c.form, c.keyword, c.args[0]!.value]), [["line", "a", "b"], ["line", "c", "d"]]);
});

test("dynamic view lines, with and without order", () => {
  const src = 'workspace {\n views {\n dynamic * "k" {\n 1: a -> b "do"\n a -> b\n rel1 "text"\n autolayout\n }\n }\n}';
  const r = parse(src);
  assert.deepEqual(r.diagnostics, []);
  const body = r.root.children[0]!.body!.children[0]!.body!.children[0]!.body!.children;
  assert.equal(body[0]!.order?.value, "1:");
  assert.equal(body[0]!.form, "relationship");
  assert.equal(body[1]!.order, undefined);
  assert.equal(body[2]!.form, "line");
  assert.equal(body[3]!.keyword, "autoLayout");
});

test("workspace extends", () => {
  assert.deepEqual(codes("workspace extends base.dsl {\n}\n"), []);
  assert.deepEqual(codes("workspace extends {\n}\n"), ["invalid-workspace"]);
});

// ---------------------------------------------------------------------------
// brace rules
// ---------------------------------------------------------------------------

test("brace placement: `{` must end the line, `}` must be alone", () => {
  assert.ok(codes("workspace { model\n}\n").includes("opening-brace-position"));
  assert.ok(codes("workspace {\n model {\n } }\n}\n").includes("closing-brace-position"));
  assert.ok(codes("workspace\n{\n}\n").includes("opening-brace-position"));
});

test("missing and extra closing braces", () => {
  // every unclosed block is reported at its own `{`, ordered by position
  const missing = errors("workspace {\n model {\n");
  assert.deepEqual(missing.map((e) => [e.code, e.range.start.line]), [["unclosed-block", 0], ["unclosed-block", 1]]);
  assert.deepEqual(codes("workspace {\n}\n}\n"), ["unexpected-closing-brace"]);
});

test("bodies: required, forbidden", () => {
  assert.ok(codes("workspace {\n model\n}\n").includes("missing-body"));
  assert.ok(codes(wrap('softwareSystem "S" {\n description "d" {\n }\n}')).includes("unexpected-body"));
});

// ---------------------------------------------------------------------------
// keyword and argument checking
// ---------------------------------------------------------------------------

test("unknown keyword is reported once, and its body does not cascade", () => {
  const src = wrap('banana "x" {\n person "A"\n nonsense\n}\nperson "ok"');
  const errs = errors(src);
  assert.deepEqual(errs.map((e) => e.code), ["unknown-keyword"]);
  assert.match(errs[0]!.message, /banana/);
  // statements after the bad one still parse
  assert.equal(modelOf(src).at(-1)!.keyword, "person");
  assert.equal(modelOf(src)[0]!.known, false);
});

test("a keyword that exists elsewhere is not valid here", () => {
  const e = errors(wrap("deploymentNode \"x\""));
  assert.equal(e[0]!.code, "unknown-keyword");
});

test("argument counts come from the spec syntax", () => {
  assert.ok(codes(wrap("person")).includes("too-few-arguments"));
  assert.ok(codes(wrap('person "a" "b" "c" "d"')).includes("too-many-arguments"));
  assert.deepEqual(codes(wrap('person "a" "b" "c"')), []);
  assert.ok(codes(wrap('softwareSystem "S" {\n tags\n}')).includes("too-few-arguments"));
  assert.deepEqual(codes(wrap('softwareSystem "S" {\n tags "a" "b" "c" "d"\n}')), []); // variadic
  assert.ok(codes(wrap('softwareSystem "S" {\n properties {\n "only-name"\n }\n}')).includes("too-few-arguments"));
});

test("relationships: permitted contexts, scope, archetypes", () => {
  assert.ok(codes('workspace {\n views {\n a -> b\n }\n}').includes("unexpected-relationship"));
  assert.ok(codes(wrap("-> x")).includes("no-implicit-source"));
  assert.ok(codes(wrap("a --nope-> b")).includes("unknown-archetype"));
  assert.ok(codes(wrap("a -> ")).includes("too-few-arguments"));
});

test("archetype definition errors", () => {
  assert.ok(codes(wrap("archetypes {\n x = banana\n}")).includes("unknown-archetype"));
  assert.ok(codes(wrap("archetypes {\n x = --missing->\n}")).includes("unknown-archetype"));
  assert.ok(codes(wrap("archetypes {\n x\n}")).includes("invalid-archetype-definition"));
});

test("only one workspace; stray statements at file level", () => {
  assert.ok(codes("workspace {\n}\nworkspace {\n}\n").includes("duplicate-workspace"));
  assert.deepEqual(codes("person \"x\"\n"), ["unknown-keyword"]);
});

test("identifier on a statement that cannot take one is a warning, not an error", () => {
  const r = parse('workspace {\n x = name "y"\n}\n');
  assert.equal(r.firstError, undefined);
  assert.ok(r.diagnostics.some((d) => d.code === "not-assignable" && d.severity === "warning"));
});

// ---------------------------------------------------------------------------
// deferred, deprecated, raw
// ---------------------------------------------------------------------------

test("!const / !var / !include stay in the tree as statements; a bare parse has no file access, so includes are skipped with a warning", () => {
  const r = parse('!const A "b"\nworkspace {\n !include other.dsl\n !var X y\n}\n');
  assert.equal(r.firstError, undefined);
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["include-unavailable"]);
  assert.equal(r.diagnostics[0]!.severity, "warning");
  assert.equal(r.root.children[0]!.keyword, "!const");
  assert.deepEqual(r.root.children[0]!.args.map((a) => a.value), ["A", "b"]);
  const ws = r.root.children[1]!;
  assert.deepEqual(ws.body!.children.map((c) => c.keyword), ["!include", "!var"]);
});

test("deprecated directives warn", () => {
  const r = parse(wrap("!ref x {\n}\n"));
  assert.ok(r.diagnostics.some((d) => d.code === "deprecated"));
});

test("!script: raw body is captured, not parsed, and produces no lexical noise", () => {
  const src = [
    "workspace {",
    "  model {",
    "    !script groovy {",
    '      def s = "unterminated',
    "      if (x) {",
    "        println 'hi' // and a \"quote",
    "      }",
    "    }",
    '    person "After"',
    "  }",
    "}",
  ].join("\n");
  const r = parse(src);
  assert.equal(r.firstError, undefined, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["unsupported"]);
  const model = r.root.children[0]!.body!.children[0]!.body!.children;
  assert.equal(model[0]!.keyword, "!script");
  assert.equal(model[0]!.body?.context, "raw");
  assert.match(model[0]!.body!.raw!, /println 'hi'/);
  assert.equal(model[1]!.keyword, "person"); // parsing resumes after the script
});

test("!script referencing a file has no body", () => {
  assert.deepEqual(parse("workspace {\n !script scripts/x.groovy\n}\n").diagnostics.map((d) => d.code), ["unsupported"]);
});

test("unclosed raw body reports an error", () => {
  assert.ok(errors("workspace {\n !script groovy {\n code\n").some((d) => d.code === "unclosed-block"));
});

// ---------------------------------------------------------------------------
// diagnostics plumbing
// ---------------------------------------------------------------------------

test("diagnostics are ordered by position; firstError is the earliest error", () => {
  const r = parse('workspace {\n model {\n  bad1\n  person\n }\n}\n');
  const offsets = r.diagnostics.map((d) => d.range.start.offset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  assert.equal(r.firstError, r.diagnostics.find((d) => d.severity === "error"));
  assert.equal(r.firstError?.code, "unknown-keyword");
});

test("lexical errors are merged into the same diagnostic list", () => {
  const r = parse('workspace "oops {\n}\n');
  assert.ok(r.diagnostics.some((d) => d.code === "unterminated-string"));
});

test("empty and comment-only files parse cleanly", () => {
  assert.deepEqual(parse("").diagnostics, []);
  assert.deepEqual(parse("// nothing\n/* here */\n").diagnostics, []);
  assert.equal(parse("// c\n").comments.length, 1);
});

test("the tree is plain JSON (survives a round trip)", () => {
  const r = parse(readFileSync(new URL("./fixtures/full.dsl", import.meta.url), "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(r.root)), r.root);
});
