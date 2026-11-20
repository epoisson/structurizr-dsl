import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { activate } from "../src/adapter.ts";

const require = createRequire(import.meta.url);
const { create } = require("./mock-vscode.cjs");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MAIN = "file:///work/main.dsl";
const PEOPLE = "file:///work/people.dsl";
const wrap = (body: string, views = ""): string => `workspace {\n  model {\n${body}\n  }\n${views}}\n`;

type H = ReturnType<typeof create>;
function start(): H {
  const h = create();
  activate(h.api, { subscriptions: [] });
  return h;
}
async function open(h: H, uri: string, text: string) {
  const doc = h.doc(text, uri);
  h.api.workspace.textDocuments.push(doc);
  h.listeners.open.forEach((f: (d: unknown) => void) => f(doc));
  await sleep(40);
  return doc;
}
const messages = (h: H, uri: string): string[] => (h.diagnostics.get(uri) ?? []).map((d: { code: string }) => d.code);
const edit = async (h: H, doc: ReturnType<H["doc"]>, text: string) => {
  doc.text = text;
  doc.version++;
  h.listeners.change.forEach((f: (e: unknown) => void) => f({ document: doc }));
  await sleep(380);
};
const LANDSCAPE = ' views {\n    systemLandscape "all" {\n      include *\n    }\n  }\n';

test("a problem inside an included file is shown on that file, not on the workspace", async () => {
  const h = start();
  h.files.set(PEOPLE, 'u = person "User"\nnope "x"\n');
  await open(h, MAIN, wrap("    !include people.dsl"));
  assert.deepEqual(messages(h, MAIN), []);
  assert.deepEqual(messages(h, PEOPLE), ["unknown-keyword"]);
  const d = h.diagnostics.get(PEOPLE)[0];
  assert.deepEqual([d.range.start.line, d.range.start.character, d.source], [1, 0, "structurizr"]);
});

test("a missing include is an error on the include path in the workspace file", async () => {
  const h = start();
  await open(h, MAIN, wrap("    !include gone.dsl"));
  assert.deepEqual(messages(h, MAIN), ["include-not-found"]);
  const d = h.diagnostics.get(MAIN)[0];
  assert.deepEqual([d.range.start.line, d.range.start.character, d.range.end.character], [2, 13, 21]);
});

test("a file changing on disk re-checks the workspaces that include it", async () => {
  const h = start();
  h.files.set(PEOPLE, 'nope "x"\n');
  await open(h, MAIN, wrap("    !include people.dsl"));
  assert.deepEqual(messages(h, PEOPLE), ["unknown-keyword"]);
  h.files.set(PEOPLE, 'u = person "User"\n'); // fixed on disk by another tool
  h.watchers[0].handlers.change.forEach((f: (u: unknown) => void) => f(h.Uri.parse(PEOPLE)));
  await sleep(380);
  assert.deepEqual(messages(h, PEOPLE), []);
});

test("an open, unsaved included file is used instead of what is on disk", async () => {
  const h = start();
  h.files.set(PEOPLE, 'nope "stale on disk"\n');
  await open(h, PEOPLE, 'u = person "Edited"\n'); // open in an editor, with different content
  await open(h, MAIN, wrap("    !include people.dsl"));
  assert.deepEqual(messages(h, PEOPLE), []);
  assert.deepEqual(messages(h, MAIN), []);
});

test("editing an included file re-checks the workspace that includes it", async () => {
  const h = start();
  const frag = await open(h, PEOPLE, 'u = person "User"\n');
  await open(h, MAIN, wrap('    !include people.dsl\n    s = softwareSystem "S"\n    u -> s "Uses"'));
  assert.deepEqual(messages(h, MAIN), []);
  await edit(h, frag, 'renamed = person "User"\n');
  assert.deepEqual(messages(h, MAIN), ["unknown-identifier"]); // the workspace noticed
  await edit(h, frag, 'u = person "User"\n');
  assert.deepEqual(messages(h, MAIN), []);
});

test("a fragment (no workspace) is not drowned in errors; with no workspace known it gets one explanatory note", async () => {
  const h = start();
  await open(h, PEOPLE, 'u = person "User"\ns = softwareSystem "S"\n');
  assert.deepEqual(messages(h, PEOPLE), ["fragment"]);
  const note = h.diagnostics.get(PEOPLE)[0];
  assert.equal(note.severity, 2); // information, not an error
  assert.match(note.message, /no workspace/);
  // once a workspace that includes it is open, the note goes and the workspace speaks for the file
  h.files.set(PEOPLE, 'u = person "User"\ns = softwareSystem "S"\n');
  await open(h, MAIN, wrap("    !include people.dsl"));
  assert.deepEqual(messages(h, PEOPLE), []);
  // and closing the workspace brings the note back
  const main = h.api.workspace.textDocuments.find((d: { uri: { toString(): string } }) => d.uri.toString() === MAIN);
  h.listeners.close.forEach((f: (d: unknown) => void) => f(main));
  assert.deepEqual(messages(h, PEOPLE), ["fragment"]);
  assert.deepEqual(messages(h, MAIN), []);
});

test("editor features work inside a fragment, through the workspace that includes it", async () => {
  const h = start();
  const frag = await open(h, PEOPLE, 'u = person "User"\nsys = softwareSystem "System"\n\n');
  await open(h, MAIN, wrap("    !include people.dsl", LANDSCAPE));
  const symbols = h.providers.symbols.provider.provideDocumentSymbols(frag);
  assert.deepEqual(symbols.map((s: { name: string }) => s.name), ["User", "System"]); // the fragment's own elements
  const main = h.api.workspace.textDocuments.find((d: { uri: { toString(): string } }) => d.uri.toString() === MAIN);
  const mainSymbols = h.providers.symbols.provider.provideDocumentSymbols(main);
  assert.deepEqual(mainSymbols[0].children[0].children.map((s: { name: string }) => s.name), []); // not the included ones
  // completion at the top of the fragment offers what is valid in `model`, because that is where it is included
  const labels = h.providers.completion.provider.provideCompletionItems(frag, { line: 2, character: 0 }).map((i: { label: string }) => i.label);
  assert.ok(labels.includes("person") && labels.includes("softwareSystem") && !labels.includes("views"));
  // hover on an element of the fragment
  const hover = h.providers.hover.provider.provideHover(frag, { line: 0, character: 6 });
  assert.match(hover.contents.value, /person <name>/);
});

test("!include targets are links to the files", async () => {
  const h = start();
  h.files.set(PEOPLE, 'u = person "User"\n');
  const main = await open(h, MAIN, wrap("    !include people.dsl"));
  const links = h.providers.links.provider.provideDocumentLinks(main);
  assert.equal(links.length, 1);
  assert.equal(links[0].target.toString(), PEOPLE);
  assert.deepEqual([links[0].range.start.line, links[0].range.start.character, links[0].range.end.character], [2, 13, 23]);
  assert.deepEqual(h.providers.links.provider.provideDocumentLinks(await open(h, "file:///work/other.dsl", wrap(""))), []);
});

test("go to definition crosses into the included file", async () => {
  const h = start();
  h.files.set(PEOPLE, '\n\nu = person "User"\n');
  const main = await open(h, MAIN, wrap('    !include people.dsl\n    s = softwareSystem "S"\n    u -> s "Uses"'));
  const loc = h.providers.definition.provider.provideDefinition(main, { line: 4, character: 4 });
  assert.equal(loc.uri.toString(), PEOPLE);
  assert.deepEqual([loc.range.line, loc.range.character], [2, 0]);
  const local = h.providers.definition.provider.provideDefinition(main, { line: 4, character: 9 }); // `s`, defined in the workspace file
  assert.equal(local.uri.toString(), MAIN);
});

test("clicking an element in the preview opens the included file it was declared in", async () => {
  const h = start();
  h.files.set(PEOPLE, '\nu = person "User"\n');
  const main = await open(h, MAIN, wrap('    !include people.dsl\n    s = softwareSystem "S"', LANDSCAPE));
  h.win.activeTextEditor = { document: main };
  h.commands["structurizr.openPreview"]();
  const panel = h.panels[0];
  panel.send({ type: "ready" });
  assert.match(panel.posted.at(-1).svg, /User/); // the included element is drawn
  panel.send({ type: "reveal", id: "1" });
  await sleep(20);
  assert.equal(h.shown.at(-1).doc.uri.toString(), PEOPLE);
  assert.equal(h.shown.at(-1).opts.selection.start.line, 1);
});

test("the preview follows changes in included files", async () => {
  const h = start();
  h.files.set(PEOPLE, 'u = person "Before"\n');
  const main = await open(h, MAIN, wrap("    !include people.dsl", LANDSCAPE));
  h.win.activeTextEditor = { document: main };
  h.commands["structurizr.openPreview"]();
  const panel = h.panels[0];
  panel.send({ type: "ready" });
  assert.match(panel.posted.at(-1).svg, /Before/);
  h.files.set(PEOPLE, 'u = person "After"\n');
  h.watchers[0].handlers.change.forEach((f: (u: unknown) => void) => f(h.Uri.parse(PEOPLE)));
  await sleep(380);
  assert.match(panel.posted.at(-1).svg, /After/);
});

test("directory includes list the directory and take its .dsl files in order", async () => {
  const h = start();
  h.files.set("file:///work/parts/b.dsl", 'b = softwareSystem "B"\n');
  h.files.set("file:///work/parts/a.dsl", 'a = softwareSystem "A"\n');
  h.files.set("file:///work/parts/notes.txt", "ignored");
  const main = await open(h, MAIN, wrap("    !include parts", LANDSCAPE));
  assert.deepEqual(messages(h, MAIN), []);
  const outline = h.providers.symbols.provider.provideDocumentSymbols(main);
  assert.equal(outline[0].children[0].children.length, 0);
  h.win.activeTextEditor = { document: main };
  h.commands["structurizr.openPreview"]();
  h.panels[0].send({ type: "ready" });
  const svg: string = h.panels[0].posted.at(-1).svg;
  assert.ok(svg.indexOf(">A<") > 0 && svg.includes(">B<"));
});

test("a creation or deletion on disk refreshes directory includes", async () => {
  const h = start();
  h.files.set("file:///work/parts/a.dsl", 'a = softwareSystem "A"\n');
  await open(h, MAIN, wrap('    !include parts\n    x = person "X"\n    x -> b "Uses"'));
  assert.deepEqual(messages(h, MAIN), ["unknown-identifier"]);
  h.files.set("file:///work/parts/b.dsl", 'b = softwareSystem "B"\n');
  h.watchers[0].handlers.create.forEach((f: (u: unknown) => void) => f(h.Uri.parse("file:///work/parts/b.dsl")));
  await sleep(380);
  assert.deepEqual(messages(h, MAIN), []);
});

test("the structurizr.variables setting substitutes ${NAME}, and wins over the file's own constants", async () => {
  const h = start();
  h.config["structurizr.variables"] = { ENV: "prod" };
  const main = await open(h, MAIN, '!const ENV dev\n' + wrap('    a = softwareSystem "${ENV}"', LANDSCAPE));
  h.win.activeTextEditor = { document: main };
  h.commands["structurizr.openPreview"]();
  h.panels[0].send({ type: "ready" });
  assert.match(h.panels[0].posted.at(-1).svg, />prod</);
  assert.deepEqual(messages(h, MAIN), []);
});

test("!const and !var need no files and work in plain documents", async () => {
  const h = start();
  await open(h, MAIN, '!const A "x"\n!var B y\n' + wrap('    s = softwareSystem "${A}${B}"\n    t = softwareSystem "${NOPE}"'));
  assert.deepEqual(messages(h, MAIN), []); // an unknown name is left as written, not an error
});

test("URL includes are off by default, and fetched (once) when the user opts in", async () => {
  const url = "https://example.test/people.dsl";
  const g = globalThis as { fetch?: unknown };
  const realFetch = g.fetch;
  let calls = 0;
  g.fetch = async (u: string) => (calls++, { ok: u === url, text: async () => 'u = person "Remote"\n' });
  try {
    const off = start();
    await open(off, MAIN, wrap(`    !include ${url}`));
    assert.deepEqual(messages(off, MAIN), ["include-url-unavailable"]);
    assert.equal(calls, 0, "nothing was downloaded");

    const on = start();
    on.config["structurizr.includes.allowRemote"] = true;
    const main = await open(on, MAIN, wrap(`    !include ${url}\n    s = softwareSystem "S"\n    u -> s "Uses"`));
    assert.deepEqual(messages(on, MAIN), []);
    assert.equal(calls, 1);
    await edit(on, main, main.text + " "); // another refresh: served from the cache
    assert.equal(calls, 1);
  } finally {
    g.fetch = realFetch;
  }
});

test("two workspaces including the same file do not duplicate its diagnostics; closing one keeps the other's", async () => {
  const h = start();
  h.files.set(PEOPLE, 'nope "x"\n');
  const a = await open(h, "file:///work/a.dsl", wrap("    !include people.dsl"));
  await open(h, "file:///work/b.dsl", wrap("    !include people.dsl"));
  assert.equal(h.diagnostics.get(PEOPLE).length, 1);
  h.listeners.close.forEach((f: (d: unknown) => void) => f(a));
  assert.equal(h.diagnostics.get(PEOPLE).length, 1);
});

test("closing a workspace removes the diagnostics it published on included files", async () => {
  const h = start();
  h.files.set(PEOPLE, 'nope "x"\n');
  const main = await open(h, MAIN, wrap("    !include people.dsl"));
  assert.equal(messages(h, PEOPLE).length, 1);
  h.listeners.close.forEach((f: (d: unknown) => void) => f(main));
  assert.deepEqual(messages(h, PEOPLE), []);
});

test("an include cycle is reported once, and refreshing does not loop forever", async () => {
  const h = start();
  h.files.set("file:///work/a.dsl", "!include b.dsl\n");
  h.files.set("file:///work/b.dsl", "!include a.dsl\n");
  await open(h, MAIN, wrap("    !include a.dsl"));
  assert.ok(messages(h, "file:///work/b.dsl").includes("include-cycle"));
  assert.ok(h.reads.length < 40, `reads stayed bounded: ${h.reads.length}`);
});

// ---- the real build ----------------------------------------------------------------------------------------------
test("the BUILT extension resolves includes and routes diagnostics (guards the build's import paths)", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync(process.execPath, [`${root}scripts/build.mjs`], { stdio: "ignore" });
  const h = create();
  const stub = `${root}dist/node_modules/vscode`;
  mkdirSync(stub, { recursive: true });
  (globalThis as Record<string, unknown>).__mock = h;
  writeFileSync(`${stub}/index.js`, "module.exports = globalThis.__mock.api;\n");
  try {
    const shim = require(`${root}dist/extension.cjs`);
    await shim.activate({ subscriptions: [] });
    h.files.set(PEOPLE, 'u = person "User"\nnope "x"\n');
    const doc = h.doc(wrap("    !include people.dsl\n    !const A b\n    s = softwareSystem \"${A}\""), MAIN);
    h.api.workspace.textDocuments.push(doc);
    h.listeners.open.forEach((f: (d: unknown) => void) => f(doc));
    await sleep(60);
    assert.deepEqual(messages(h, PEOPLE), ["unknown-keyword"]);
    assert.deepEqual(messages(h, MAIN), []);
    const links = h.providers.links.provider.provideDocumentLinks(doc);
    assert.equal(links[0].target.toString(), PEOPLE);
    shim.deactivate();
  } finally {
    rmSync(`${root}dist/node_modules`, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__mock;
  }
});
