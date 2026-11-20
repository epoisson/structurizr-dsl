import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../src/index.ts";

/** Compact view of a token stream: "kind:value" per token, newline/eof as bare kind. */
const summarize = (src: string): string[] =>
  tokenize(src).tokens.map((t) => (t.kind === "newline" || t.kind === "eof" ? t.kind : `${t.kind}:${t.value}`));

test("tokenizes a minimal workspace", () => {
  const src = 'workspace "Name" {\n  model {\n  }\n}\n';
  assert.deepEqual(tokenize(src).diagnostics, []);
  assert.deepEqual(summarize(src), [
    "word:workspace", "string:Name", "lbrace:{", "newline",
    "word:model", "lbrace:{", "newline",
    "rbrace:}", "newline",
    "rbrace:}", "newline",
    "eof",
  ]);
});

test("identifier assignment and relationships", () => {
  assert.deepEqual(summarize('u = person "User"\nu -> s "Uses"'), [
    "word:u", "equals:=", "word:person", "string:User", "newline",
    "word:u", "arrow:->", "word:s", "string:Uses", "newline",
    "eof",
  ]);
});

test("quoted strings keep spaces, resolve escapes, and support smart quotes", () => {
  assert.deepEqual(summarize('a "hello world" "say \\"hi\\"" \u201csmart quotes\u201d'), [
    "word:a", "string:hello world", 'string:say "hi"', "string:smart quotes", "newline", "eof",
  ]);
  const [, str] = tokenize('a "x y"').tokens;
  assert.equal(str?.text, '"x y"'); // raw text keeps the quotes
});

test("empty string is a valid token", () => {
  assert.deepEqual(summarize('a ""'), ["word:a", "string:", "newline", "eof"]);
});

test("# and // line comments, /* */ block comments", () => {
  const src = "# full line\n// another\nperson /* inline */ x // trailing\n/* multi\nline */\ny";
  const r = tokenize(src);
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(summarize(src), ["word:person", "word:x", "newline", "word:y", "newline", "eof"]);
  assert.deepEqual(r.comments.map((c) => c.style), ["line", "line", "block", "line", "block"]);
});

test("# mid-line is a word (colours); // inside a URL is a word", () => {
  assert.deepEqual(summarize("background #ff0000"), ["word:background", "word:#ff0000", "newline", "eof"]);
  assert.deepEqual(summarize("!include https://example.com/a.dsl"), [
    "word:!include", "word:https://example.com/a.dsl", "newline", "eof",
  ]);
});

test("${CONST} references stay inside a word", () => {
  assert.deepEqual(summarize("a ${NAME} b${X}"), ["word:a", "word:${NAME}", "word:b${X}", "newline", "eof"]);
});

test("backslash continuation joins physical lines", () => {
  assert.deepEqual(summarize('a "b" \\\n  "c"\nd'), [
    "word:a", "string:b", "string:c", "newline", "word:d", "newline", "eof",
  ]);
  // trailing spaces after the backslash are tolerated
  assert.deepEqual(summarize("a \\  \nb"), ["word:a", "word:b", "newline", "eof"]);
});

test("text blocks span lines and keep raw content", () => {
  const src = 'description """\n  line 1\n  "quoted"\n"""\nnext';
  const r = tokenize(src);
  assert.deepEqual(r.diagnostics, []);
  const block = r.tokens[1]!;
  assert.equal(block.kind, "string");
  assert.equal(block.textBlock, true);
  assert.equal(block.value, '\n  line 1\n  "quoted"\n');
  assert.equal(block.range.start.line, 0);
  assert.equal(block.range.end.line, 3);
  assert.equal(r.tokens.at(-3)?.value, "next");
});

test("CRLF line endings", () => {
  assert.deepEqual(summarize('a "b"\r\nc\r\n'), ["word:a", "string:b", "newline", "word:c", "newline", "eof"]);
  assert.equal(tokenize("# c\r\nx").comments[0]?.text, "# c"); // no stray \r
});

test("blank and comment-only lines emit no newline tokens", () => {
  assert.deepEqual(summarize("\n\n# c\n\n"), ["eof"]);
});

test("no trailing newline still ends the final line", () => {
  assert.deepEqual(summarize("a b"), ["word:a", "word:b", "newline", "eof"]);
});

test("positions are 0-based line/column with half-open ranges", () => {
  const { tokens } = tokenize('ab\n  cd "e"');
  const cd = tokens.find((t) => t.value === "cd")!;
  assert.deepEqual(cd.range.start, { offset: 5, line: 1, column: 2 });
  assert.deepEqual(cd.range.end, { offset: 7, line: 1, column: 4 });
  const str = tokens.find((t) => t.kind === "string")!;
  assert.deepEqual(str.range.start, { offset: 8, line: 1, column: 5 });
  assert.deepEqual(str.range.end, { offset: 11, line: 1, column: 8 });
});

test("unterminated string: diagnostic, stops at end of line, continues", () => {
  const r = tokenize('a "oops\nb');
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0]?.code, "unterminated-string");
  assert.equal(r.diagnostics[0]?.range.start.line, 0);
  assert.deepEqual(summarize('a "oops\nb'), ["word:a", "string:oops", "newline", "word:b", "newline", "eof"]);
});

test("unterminated block comment and text block", () => {
  assert.equal(tokenize("a /* never closed").diagnostics[0]?.code, "unterminated-block-comment");
  const r = tokenize('a """never closed\nmore');
  assert.equal(r.diagnostics[0]?.code, "unterminated-text-block");
  assert.equal(r.tokens[1]?.kind, "string");
});

test("always ends with eof, even for empty input", () => {
  assert.deepEqual(summarize(""), ["eof"]);
});

test("relationship operators: ->, --archetype->, -/> are arrows; expression words are not", () => {
  assert.deepEqual(summarize("a --https-> b"), ["word:a", "arrow:--https->", "word:b", "newline", "eof"]);
  assert.deepEqual(summarize("a -/> b"), ["word:a", "arrow:-/>", "word:b", "newline", "eof"]);
  assert.deepEqual(summarize("sync = -> {"), ["word:sync", "equals:=", "arrow:->", "lbrace:{", "newline", "eof"]);
  for (const w of ["->x", "x->", "->x->", "*->*", "-->", "--x", "element.tag==A"]) {
    assert.deepEqual(summarize(`include ${w}`), ["word:include", `word:${w}`, "newline", "eof"], w);
  }
});
