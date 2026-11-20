import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, completionsAt, definitionAt, foldingRanges, hoverAt, outline, wordAt } from "../src/language.ts";
import type { OutlineItem } from "../src/language.ts";

const DOC = `workspace "W" {
    !identifiers hierarchical
    model {
        u = person "User"
        ss = softwareSystem "System" {
            web = container "Web" "Serves pages" "React"
            api = container "API"
            ss.web -> ss.api "Calls"
        }
        u -> ss.web "Uses"
        rel = u -> ss "Direct"
    }
    views {
        systemContext ss "ctx" {
            include *
        }
        styles {
            element "Person" {
                shape Person
            }
        }
    }
}
`;
const a = analyze(DOC);
const line = (needle: string): number => DOC.split("\n").findIndex((l) => l.includes(needle));
const col = (needle: string, inside = 0): number => DOC.split("\n").find((l) => l.includes(needle))!.indexOf(needle) + inside;

test("the sample document is clean", () => {
  assert.deepEqual(a.result.diagnostics, []);
});

test("outline: a hierarchy with sensible kinds and names (relationships are left out)", () => {
  const flat = (items: OutlineItem[], depth = 0): string[] =>
    items.flatMap((i) => [`${"  ".repeat(depth)}${i.kind}: ${i.name}`, ...flat(i.children, depth + 1)]);
  assert.deepEqual(flat(outline(a)), [
    "Namespace: W",
    "  Module: model",
    "    Class: User",
    "    Struct: System",
    "      Interface: Web",
    "      Interface: API",
    "  Module: views",
    "    Event: systemContext: ctx",
    "    Module: styles",
    "      Key: element Person",
  ]);
});

test("outline: selection ranges lie inside the item range, and detail shows the identifier", () => {
  const walk = (items: OutlineItem[]): void => {
    for (const i of items) {
      const r = i.range, s = i.selectionRange;
      assert.ok(s.start.line >= r.start.line && s.end.line <= r.end.line, i.name);
      walk(i.children);
    }
  };
  walk(outline(a));
  const model = outline(a)[0]!.children[0]!;
  assert.equal(model.children[0]!.detail, "u = person");
});

test("outline survives syntax errors", () => {
  const broken = analyze('workspace {\n model {\n  p = person "A"\n  nope "x"\n  s = softwareSystem "S" {\n');
  const model = outline(broken)[0]!.children[0]!;
  assert.deepEqual(model.children.map((c) => c.name), ["A", "S"]);
});

test("folding: blocks fold from the `{` line to the line before `}`; block comments fold too", () => {
  const f = foldingRanges(a);
  const wsStart = line('workspace "W"');
  assert.ok(f.some((r) => r.startLine === wsStart && r.endLine === DOC.split("\n").length - 3)); // last `}` line is length-2
  const m = foldingRanges(analyze("/* a\n b\n c */\nworkspace {\n}\n"));
  assert.deepEqual(m.filter((r) => r.kind === "comment"), [{ startLine: 0, endLine: 2, kind: "comment" }]);
  assert.ok(foldingRanges(analyze("workspace {\n model {\n\n")).length > 0); // unclosed blocks still fold
});

test("wordAt handles dotted identifiers and edges", () => {
  assert.deepEqual(wordAt("  ss.web -> x", 5), { text: "ss.web", start: 2, end: 8 });
  assert.deepEqual(wordAt("ss.", 3), { text: "ss", start: 0, end: 2 });
  assert.equal(wordAt("   ", 1), undefined);
});

test("hover on a keyword shows its syntax from the grammar inventory", () => {
  const h = hoverAt(a, line("= person"), col("person", 2))!;
  assert.match(h.markdown, /person <name> \[description\] \[tags\]/);
  const ctx = hoverAt(a, line("systemContext"), col("systemContext", 3))!;
  assert.match(ctx.markdown, /systemContext <softwareSystem>/);
  // the same word means something else in another context
  const view = hoverAt(a, line("container "), col("container", 1))!;
  assert.match(view.markdown, /container <name> \[description\] \[technology\] \[tags\]/);
});

test("hover on an identifier describes the element or relationship", () => {
  const h = hoverAt(a, line("u -> ss.web"), col("ss.web", 4))!;
  assert.match(h.markdown, /\*\*Web\*\* · container · React/);
  assert.match(h.markdown, /Serves pages/);
  assert.match(h.markdown, /in System/);
  const r = hoverAt(a, line("rel = u"), col("rel", 1))!;
  assert.match(r.markdown, /\*\*User\*\* → \*\*System\*\*: Direct/);
  assert.equal(hoverAt(a, line("workspace"), 0)?.markdown.includes("workspace"), true);
});

test("go to definition for element and relationship identifiers", () => {
  assert.deepEqual(definitionAt(a, line("u -> ss.web"), col("ss.web", 4)), { line: line("web = container"), column: 12 });
  assert.deepEqual(definitionAt(a, line("rel = u"), col("rel", 1)), { line: line("rel = u"), column: 8 });
  assert.equal(definitionAt(a, line("shape Person"), col("shape", 1)), undefined);
});

test("completion: keywords valid for the surrounding block", () => {
  const labels = (l: number, c: number): string[] => completionsAt(a, l, c).map((x) => x.label);
  const inModel = labels(line("u = person") + 0, 8).filter((x) => !x.startsWith("!"));
  // cursor at the start of the line `u = person...` is a statement start
  assert.ok(inModel.includes("person") && inModel.includes("softwareSystem") && inModel.includes("archetypes"));
  assert.ok(!inModel.includes("model") && !inModel.includes("views"));
  const inSystem = labels(line("api = container"), 12);
  assert.ok(inSystem.includes("container") && inSystem.includes("description") && inSystem.includes("tags"));
  assert.ok(!inSystem.includes("person"));
  const inView = labels(line("include *"), 12);
  assert.ok(inView.includes("include") && inView.includes("autoLayout") && !inView.includes("person"));
  const inStyle = labels(line("shape Person"), 16);
  assert.ok(inStyle.includes("shape") && inStyle.includes("background"));
});

test("completion at top level offers only workspace and the global directives", () => {
  const labels = completionsAt(analyze(""), 0, 0).map((c) => c.label);
  assert.ok(labels.includes("workspace") && labels.includes("!include"));
  assert.ok(!labels.includes("person"));
});

test("completion works inside an unclosed block while typing", () => {
  const typing = analyze('workspace {\n model {\n  p = person "A"\n  \n');
  const labels = completionsAt(typing, 3, 2).map((c) => c.label);
  assert.ok(labels.includes("softwareSystem"));
  assert.ok(!labels.includes("views"));
});

test("completion: block keywords insert a body snippet; deprecated ones are hidden", () => {
  const model = completionsAt(analyze("workspace {\n model {\n \n }\n}\n"), 2, 1);
  assert.equal(model.find((c) => c.label === "archetypes")!.insertText, "archetypes {\n\t$0\n}");
  assert.equal(model.find((c) => c.label === "person")!.insertText, "person");
  assert.ok(!model.some((c) => c.label === "!ref" || c.label === "!extend"));
});

test("completion after the keyword offers identifiers", () => {
  const labels = completionsAt(a, line("u -> ss.web"), 14).map((c) => c.label);
  assert.ok(labels.includes("u") && labels.includes("ss.web") && labels.includes("rel") && labels.includes("this"));
});

test("no completions inside raw script bodies or lenient blocks", () => {
  const s = analyze("workspace {\n model {\n  !script groovy {\n   \n  }\n }\n}\n");
  assert.deepEqual(completionsAt(s, 3, 3), []);
});
