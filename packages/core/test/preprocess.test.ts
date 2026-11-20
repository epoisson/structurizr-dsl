import { test } from "node:test";
import assert from "node:assert/strict";
import { load, loadAsync, parse } from "../src/index.ts";
import type { AsyncIncludeHost, IncludeHost } from "../src/index.ts";

/** An in-memory file system. Ids are plain `/` paths; a directory exists when some file lives below it. */
function memory(files: Record<string, string>): IncludeHost & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readFile: (id) => (reads.push(id), files[id]),
    listDirectory: (id) => {
      const prefix = id.endsWith("/") ? id : id + "/";
      const kids = Object.keys(files).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"));
      return kids.length > 0 ? kids : undefined;
    },
  };
}
const codes = (r: { diagnostics: Array<{ code: string }> }): string[] => r.diagnostics.map((d) => d.code);
const ROOT = "/w/main.dsl";
const wrap = (body: string): string => `workspace {\n model {\n${body}\n }\n}\n`;
const names = (r: ReturnType<typeof load>): string[] => r.workspace.model.elements.map((e) => e.name);

// ---------------------------------------------------------------------------
// variables
// ---------------------------------------------------------------------------

test("${NAME} is replaced inside words, strings and text blocks, from constants and variables", () => {
  const r = load('!const SYS "Billing"\n!const KIND softwareSystem\n' + wrap('a = ${KIND} "${SYS} v1" "Handles ${SYS} \\u2014 ${SYS}"\nb = person "x"'));
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.workspace.model.elements[0]!.name, "Billing v1");
  assert.equal(r.workspace.model.elements[0]!.type, "softwareSystem"); // even the keyword can come from a variable
  assert.match(r.workspace.model.elements[0]!.description, /^Handles Billing .* Billing$/);
  const t = load('!const D "multi"\n' + wrap('a = softwareSystem "A" """\nline ${D}\n"""'));
  assert.match(t.workspace.model.elements[0]!.description, /line multi/);
});

test("definitions take effect for later lines only; !var can be redefined, !const cannot", () => {
  const r = load('!var V one\n' + wrap('a = softwareSystem "${V}"\n!var V two\nb = softwareSystem "${V}"\nc = softwareSystem "${LATER}"\n!const LATER x'));
  assert.deepEqual(names(r), ["one", "two", "${LATER}"]); // used before it was defined: left as written
  const c = load('!const K first\n!const K second\n' + wrap('a = softwareSystem "${K}"'));
  assert.deepEqual(codes(c), ["constant-redefined"]);
  assert.equal(c.diagnostics[0]!.severity, "warning");
  assert.equal(c.workspace.model.elements[0]!.name, "first"); // the first value is kept
  assert.deepEqual(codes(load('!const K first\n!var K second\n' + wrap(""))), ["constant-redefined"]);
});

test("environment variables are the fallback; constants and variables win; unknown names stay", () => {
  const env = { NAME: "from-env", OTHER: "o" };
  const r = load('!const NAME mine\n' + wrap('a = softwareSystem "${NAME}"\nb = softwareSystem "${OTHER}"\nc = softwareSystem "${NOPE}"'), { env });
  assert.deepEqual(names(r), ["mine", "o", "${NOPE}"]);
});

test("predefined variables win silently over the file's own definitions", () => {
  const r = load('!const ENV dev\n!var ENV staging\n' + wrap('a = softwareSystem "${ENV}"'), { variables: { ENV: "prod" } });
  assert.deepEqual(r.diagnostics, []);
  assert.equal(names(r)[0], "prod");
});

test("a value may use earlier variables; names are validated", () => {
  const r = load('!const BASE https://example.com\n!const URL "${BASE}/docs"\n' + wrap('a = softwareSystem "A" {\n url ${URL}\n}'));
  assert.equal(r.workspace.model.elements[0]!.url, "https://example.com/docs");
  const bad = load('!const "bad name!" x\n' + wrap(""));
  assert.deepEqual(codes(bad), ["invalid-variable-name"]);
  assert.deepEqual(codes(load("!const A.b-c_1 x\n" + wrap(""))), []); // the documented character set
  assert.ok(codes(load("!const A\n" + wrap(""))).includes("too-few-arguments"));
});

test("variables are not substituted inside raw script bodies", () => {
  const r = parse('!const X 1\nworkspace {\n model {\n  !script groovy {\n   println "${X}"\n  }\n }\n}\n');
  const script = r.root.children[1]!.body!.children[0]!.body!.children[0]!;
  assert.match(script.body!.raw!, /\$\{X\}/);
});

test("the directive lines appear in the tree", () => {
  const r = parse("!const A b\n!var C d\n");
  assert.deepEqual(r.root.children.map((c) => [c.keyword, c.args.map((a) => a.value)]), [["!const", ["A", "b"]], ["!var", ["C", "d"]]]);
});

// ---------------------------------------------------------------------------
// includes
// ---------------------------------------------------------------------------

test("an included file is inlined where the directive is, and its elements resolve", () => {
  const host = memory({ "/w/people.dsl": 'u = person "User"\nadmin = person "Admin"\n' });
  const r = load(wrap('!include people.dsl\ns = softwareSystem "S"\nu -> s "Uses"'), { file: ROOT, host });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(names(r), ["User", "Admin", "S"]);
  assert.equal(r.workspace.model.relationships.length, 1);
  assert.deepEqual(r.syntax.files, ["/w/people.dsl"]);
});

test("ranges say which file they are in: the root file and included files", () => {
  const host = memory({ "/w/people.dsl": '\n\nu = person "User"\n' });
  const r = load(wrap("!include people.dsl"), { file: ROOT, host });
  const [u] = r.workspace.model.elements;
  assert.equal(u!.range.file, "/w/people.dsl");
  assert.equal(u!.range.start.line, 2); // a line in the included file, not in the root
  const inc = r.syntax.includes[0]!;
  assert.equal(inc.range.file, ROOT);
  assert.deepEqual([inc.target, inc.files, inc.from], ["people.dsl", ["/w/people.dsl"], ROOT]);
  // without a file identity nothing gets a `file` key at all (the JSON is unchanged)
  assert.ok(!("file" in parse('workspace {\n}\n').root.range));
});

test("nested includes resolve relative to the including file", () => {
  const host = memory({
    "/w/parts/model.dsl": '!include people/users.dsl\ns = softwareSystem "S"\n',
    "/w/parts/people/users.dsl": 'u = person "User"\n',
  });
  const r = load(wrap("!include parts/model.dsl"), { file: ROOT, host });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(names(r), ["User", "S"]);
});

test("includes may sit inside any block, and a brace may open in one file and close in another", () => {
  const host = memory({ "/w/open.dsl": 'softwareSystem "S" {\n', "/w/close.dsl": "}\n" });
  const r = load(wrap("!include open.dsl\n container \"C\"\n!include close.dsl"), { file: ROOT, host });
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.workspace.model.elements[1]!.parentId, r.workspace.model.elements[0]!.id);
});

test("constants flow both ways: into an included file, and out of it", () => {
  const host = memory({ "/w/a.dsl": 'x = softwareSystem "${PARENT}"\n!const FROM_CHILD child\n' });
  const r = load('!const PARENT parent\n' + wrap('!include a.dsl\ny = softwareSystem "${FROM_CHILD}"'), { file: ROOT, host });
  assert.deepEqual(names(r), ["parent", "child"]);
  // and a path can be built from a constant
  const h2 = memory({ "/w/shared/p.dsl": 'u = person "P"\n' });
  assert.deepEqual(names(load('!const DIR shared\n' + wrap("!include ${DIR}/p.dsl"), { file: ROOT, host: h2 })), ["P"]);
});

test("a directory include takes its .dsl files, sorted, and not other files or subdirectories", () => {
  const host = memory({
    "/w/m/b.dsl": 'b = softwareSystem "B"\n',
    "/w/m/a.dsl": 'a = softwareSystem "A"\n',
    "/w/m/notes.txt": "ignore me",
    "/w/m/sub/c.dsl": 'c = softwareSystem "C"\n',
  });
  const r = load(wrap("!include m"), { file: ROOT, host });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(names(r), ["A", "B"]);
  assert.deepEqual(r.syntax.includes[0]!.files, ["/w/m/a.dsl", "/w/m/b.dsl"]);
  const empty = load(wrap("!include m"), { file: ROOT, host: memory({ "/w/m/readme.txt": "x" }) });
  assert.deepEqual(codes(empty), ["include-empty-directory"]);
});

test("missing files are errors located at the path in the directive", () => {
  const r = load(wrap("!include nope.dsl"), { file: ROOT, host: memory({}) });
  assert.deepEqual(codes(r), ["include-not-found"]);
  const d = r.diagnostics[0]!;
  assert.equal(d.range.file, ROOT);
  assert.deepEqual([d.range.start.line, d.range.start.column], [2, 9]); // the path itself, right after "!include "
  assert.match(d.message, /nope\.dsl/);
});

test("includes must stay in the including file's directory or below", () => {
  const host = memory({ "/secret/s.dsl": 'x = softwareSystem "X"\n', "/w/ok.dsl": 'ok = softwareSystem "Ok"\n' });
  for (const target of ["../secret/s.dsl", "/secret/s.dsl", "C:/x/s.dsl", "..\\secret\\s.dsl", "file:///secret/s.dsl", "a/../../secret/s.dsl"]) {
    const r = load(wrap(`!include ${target.includes("\\") ? '"' + target + '"' : target}`), { file: ROOT, host });
    assert.deepEqual(codes(r), ["include-outside"], target);
    assert.equal(r.workspace.model.elements.length, 0, target);
  }
  assert.deepEqual(names(load(wrap("!include sub/../ok.dsl"), { file: ROOT, host })), ["Ok"]); // never leaves the directory
  assert.ok(host.reads.every((id) => !id.includes("secret")), "the file outside was never read");
});

test("include cycles and runaway depth are errors, not hangs", () => {
  const host = memory({ "/w/a.dsl": "!include b.dsl\n", "/w/b.dsl": "!include a.dsl\n", "/w/self.dsl": "!include self.dsl\n" });
  const r = load(wrap("!include a.dsl"), { file: ROOT, host });
  assert.deepEqual(codes(r), ["include-cycle"]);
  assert.match(r.diagnostics[0]!.message, /a\.dsl -> b\.dsl -> a\.dsl/);
  assert.deepEqual(codes(load(wrap("!include self.dsl"), { file: ROOT, host })), ["include-cycle"]);
  assert.deepEqual(codes(load(wrap("!include main.dsl"), { file: ROOT, host: memory({ [ROOT]: "" }) })), ["include-cycle"]); // the root itself
  const chain: Record<string, string> = {};
  for (let i = 0; i < 10; i++) chain[`/w/c${i}.dsl`] = `!include c${i + 1}.dsl\n`;
  assert.deepEqual(codes(load(wrap("!include c0.dsl"), { file: ROOT, host: memory(chain), maxIncludeDepth: 5 })), ["include-depth"]);
});

test("without file access or a file location, includes are skipped with a warning", () => {
  const none = load(wrap("!include a.dsl\ns = softwareSystem \"S\""));
  assert.deepEqual(codes(none), ["include-unavailable"]);
  assert.match(none.diagnostics[0]!.message, /no file access/);
  assert.deepEqual(names(none), ["S"]);
  const nowhere = load(wrap("!include a.dsl"), { host: memory({ "/w/a.dsl": "" }) });
  assert.deepEqual(codes(nowhere), ["include-unavailable"]);
  assert.match(nowhere.diagnostics[0]!.message, /location of this source is unknown/);
});

test("URL includes: HTTPS only, and only when the host allows them", () => {
  const url = "https://example.com/model/people.dsl";
  assert.deepEqual(codes(load(wrap(`!include ${url}`), { file: ROOT, host: memory({}) })), ["include-url-unavailable"]);
  assert.deepEqual(codes(load(wrap("!include http://example.com/x.dsl"), { file: ROOT, host: memory({}) })), ["include-insecure-url"]);
  const host: IncludeHost = { readFile: () => undefined, readUrl: (u) => (u === url ? 'u = person "Remote"\n!include more.dsl\n' : u === "https://example.com/model/more.dsl" ? 'm = person "More"\n' : undefined) };
  const r = load(wrap(`!include ${url}`), { file: ROOT, host });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(names(r), ["Remote", "More"]); // a relative include inside a remote file resolves against its URL
  assert.deepEqual(codes(load(wrap("!include https://example.com/missing.dsl"), { file: ROOT, host })), ["include-not-found"]);
});

// ---------------------------------------------------------------------------
// diagnostics from included files
// ---------------------------------------------------------------------------

test("errors in an included file point at that file; the root's come first", () => {
  const host = memory({ "/w/bad.dsl": 'person "ok"\nnope "x"\nperson "unterminated\n' });
  const r = load(wrap("!include bad.dsl\nundefined_kw 1"), { file: ROOT, host });
  const inBad = r.diagnostics.filter((d) => d.range.file === "/w/bad.dsl");
  assert.deepEqual(inBad.map((d) => [d.code, d.range.start.line]), [["unknown-keyword", 1], ["unterminated-string", 2]]);
  assert.equal(r.diagnostics[0]!.range.file, ROOT); // root file first
  assert.equal(r.diagnostics.at(-1)!.range.file, "/w/bad.dsl");
  assert.equal(r.firstError!.range.file, ROOT);
});

test("raw script bodies in included files are sliced from the right file, and contain no directives", () => {
  const host = memory({ "/w/s.dsl": '!script groovy {\n  // !include evil.dsl\n  def x = "unterminated\n}\nperson "After"\n' });
  const r = load(wrap("!include s.dsl"), { file: ROOT, host });
  assert.ok(!codes(r).includes("include-not-found")); // the include-looking line in the script was not processed
  assert.ok(!codes(r).includes("unterminated-string")); // and lexical noise in the script is discarded
  const script = r.syntax.root.children[0]!.body!.children[0]!.body!.children.find((c) => c.keyword === "!script")!;
  assert.match(script.body!.raw!, /def x = "unterminated/);
  assert.equal(script.body!.range.file, "/w/s.dsl");
});

test("comments from included files are kept and tagged with their file", () => {
  const host = memory({ "/w/c.dsl": "// in the child\nperson \"P\"\n" });
  const r = parse(wrap("!include c.dsl"), { file: ROOT, host });
  assert.deepEqual(r.comments.map((c) => [c.text, c.range.file]), [["// in the child", "/w/c.dsl"]]);
});

// ---------------------------------------------------------------------------
// async hosts
// ---------------------------------------------------------------------------

function asyncOf(sync: IncludeHost & { reads: string[] }): AsyncIncludeHost & { calls: number } {
  const h = {
    calls: 0,
    readFile: async (id: string) => (h.calls++, await Promise.resolve(sync.readFile(id))),
    listDirectory: async (id: string) => (h.calls++, await Promise.resolve(sync.listDirectory!(id))),
  };
  return h;
}

test("loadAsync gives exactly what load gives with a synchronous host", async () => {
  const files = {
    "/w/model/a.dsl": '!include ../model/inner.dsl\na = softwareSystem "A"\n',
    "/w/model/inner.dsl": 'i = person "I"\n',
    "/w/model/b.dsl": 'b = softwareSystem "B"\n',
    "/w/people.dsl": 'u = person "U"\n',
  };
  const src = wrap("!include people.dsl\n!include model\nu -> a \"x\"");
  const sync = load(src, { file: ROOT, host: memory(files) });
  const host = asyncOf(memory(files));
  const a = await loadAsync(src, { file: ROOT, host });
  assert.deepEqual(a.workspace, sync.workspace);
  assert.deepEqual(a.diagnostics, sync.diagnostics);
  assert.ok(host.calls >= 5 && host.calls < 20, `reads were bounded: ${host.calls}`);
});

test("loadAsync reports missing files as diagnostics, never throws for them", async () => {
  const r = await loadAsync(wrap("!include missing.dsl"), { file: ROOT, host: asyncOf(memory({})) });
  assert.deepEqual(codes(r), ["include-not-found"]);
  const noRead = await loadAsync("workspace {\n}\n", { file: ROOT, host: asyncOf(memory({})) });
  assert.equal(noRead.ok, true);
});

test("loadAsync passes real failures of the host through", async () => {
  await assert.rejects(
    loadAsync(wrap("!include a.dsl"), { file: ROOT, host: { readFile: async () => { throw new Error("disk on fire"); } } }),
    /disk on fire/,
  );
});

test("loadAsync handles URLs when the host offers them, and respects variables and env", async () => {
  const host: AsyncIncludeHost = { readFile: async () => undefined, readUrl: async (u) => (u === "https://x.test/p.dsl" ? 'p = person "${WHO}"\n' : undefined) };
  const r = await loadAsync('!const WHO Remote\n' + wrap("!include https://x.test/p.dsl"), { file: ROOT, host });
  assert.deepEqual(names(r), ["Remote"]);
  const e = await loadAsync(wrap('a = softwareSystem "${HOME_DIR}"'), { file: ROOT, host, env: { HOME_DIR: "/home/me" } });
  assert.deepEqual(names(e), ["/home/me"]);
});
