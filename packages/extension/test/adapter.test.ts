import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activate } from "../src/adapter.ts";

const require = createRequire(import.meta.url);
const { create } = require("./mock-vscode.cjs");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const GOOD = 'workspace {\n model {\n  u = person "U"\n  s = softwareSystem "S"\n  u -> s "Uses"\n }\n}\n';
const BAD = 'workspace {\n model {\n  nope "x"\n }\n}\n';

test("opening a document publishes diagnostics with range, code and source", () => {
  const h = create();
  const ctx = { subscriptions: [] as unknown[] };
  activate(h.api, ctx as never);
  const doc = h.doc(BAD);
  h.listeners.open.forEach((fn: (d: unknown) => void) => fn(doc));
  const [d] = h.diagnostics.get("file:///a.dsl");
  assert.equal(d.code, "unknown-keyword");
  assert.equal(d.source, "structurizr");
  assert.equal(d.severity, 0);
  assert.deepEqual([d.range.start.line, d.range.start.character, d.range.end.character], [2, 2, 6]);
  assert.ok(ctx.subscriptions.length >= 8);
});

test("non-Structurizr documents are ignored; closing clears diagnostics", () => {
  const h = create();
  activate(h.api, { subscriptions: [] });
  h.listeners.open.forEach((fn: (d: unknown) => void) => fn(h.doc(BAD, "file:///x.txt", "plaintext")));
  assert.equal(h.diagnostics.size, 0);
  const doc = h.doc(BAD);
  h.listeners.open.forEach((fn: (d: unknown) => void) => fn(doc));
  assert.equal(h.diagnostics.size, 1);
  h.listeners.close.forEach((fn: (d: unknown) => void) => fn(doc));
  assert.equal(h.diagnostics.size, 0);
});

test("editing re-analyses after a debounce", async () => {
  const h = create();
  activate(h.api, { subscriptions: [] });
  const doc = h.doc(BAD);
  h.listeners.open.forEach((fn: (d: unknown) => void) => fn(doc));
  assert.equal(h.diagnostics.get("file:///a.dsl").length, 1);
  doc.text = GOOD;
  doc.version = 2;
  h.listeners.change.forEach((fn: (e: unknown) => void) => fn({ document: doc }));
  assert.equal(h.diagnostics.get("file:///a.dsl").length, 1); // not yet: debounced
  await sleep(350);
  assert.equal((h.diagnostics.get("file:///a.dsl") ?? []).length, 0); // cleared (deleted or empty: the same to VS Code)
});

test("documents already open at activation are analysed", () => {
  const h = create();
  h.api.workspace.textDocuments.push(h.doc(BAD));
  activate(h.api, { subscriptions: [] });
  assert.equal(h.diagnostics.get("file:///a.dsl").length, 1);
});

test("all providers are registered for the structurizr language and return VS Code objects", () => {
  const h = create();
  activate(h.api, { subscriptions: [] });
  for (const name of ["symbols", "folding", "hover", "definition", "completion"]) {
    assert.deepEqual(h.providers[name].selector, { language: "structurizr" }, name);
  }
  const doc = h.doc(GOOD);

  const symbols = h.providers.symbols.provider.provideDocumentSymbols(doc);
  assert.equal(symbols[0].name, "workspace"); // unnamed workspace: falls back to the keyword
  assert.equal(symbols[0].kind, "Namespace");
  assert.equal(symbols[0].children[0].children[0].kind, "Class");

  const folds = h.providers.folding.provider.provideFoldingRanges(doc);
  assert.ok(folds.length >= 2 && folds[0].start === 0);

  const hover = h.providers.hover.provider.provideHover(doc, { line: 2, character: 8 });
  assert.match(hover.contents.value, /person <name>/);

  const def = h.providers.definition.provider.provideDefinition(doc, { line: 4, character: 3 });
  assert.equal(def.range.line, 2);

  const items = h.providers.completion.provider.provideCompletionItems(doc, { line: 5, character: 1 });
  const person = items.find((i: { label: string }) => i.label === "person");
  assert.equal(person.kind, "Keyword");
  assert.equal(person.insertText.value, "person");
  assert.equal(h.providers.hover.provider.provideHover(doc, { line: 0, character: 100 }), undefined);
});

// ---- the real build: CommonJS shim -> ES modules -----------------------------------------
test("the built extension.cjs activates through the CommonJS -> ESM hand-off", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync(process.execPath, [`${root}scripts/build.mjs`], { stdio: "ignore" });
  const stub = `${root}dist/node_modules/vscode`;
  mkdirSync(stub, { recursive: true });
  copyFileSync(`${root}test/mock-vscode.cjs`, `${stub}/mock.cjs`);
  // the shim does require("vscode"): provide one that returns a fresh mock and exposes it
  const h = create();
  (globalThis as Record<string, unknown>).__mock = h;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${stub}/index.js`, "module.exports = globalThis.__mock.api;\n");
  try {
    const shim = require(`${root}dist/extension.cjs`);
    h.api.workspace.textDocuments.push(h.doc(BAD));
    const subscriptions: unknown[] = [];
    await shim.activate({ subscriptions });
    assert.equal(h.diagnostics.get("file:///a.dsl")[0].code, "unknown-keyword");
    assert.ok(h.providers.symbols && h.providers.completion);
    assert.ok(subscriptions.length >= 8);
    shim.deactivate();
  } finally {
    rmSync(`${root}dist/node_modules`, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__mock;
  }
  assert.ok(existsSync(`${root}dist/esm/ext/adapter.js`));
});
