import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { analyze } from "../src/language.ts";
import { previewHtml, previewPayload, revealTarget } from "../src/preview.ts";
import { activate } from "../src/adapter.ts";

const require = createRequire(import.meta.url);
const { create } = require("./mock-vscode.cjs");

const DSL = `workspace {
  model {
    u = person "User"
    s = softwareSystem "System"
    u -> s "Uses"
  }
  views {
    systemLandscape "land" {
      include *
    }
    systemContext s "ctx" {
      include *
      default
    }
  }
}
`;

test("payload: lists the views and picks requested, else default, else first", () => {
  const a = analyze(DSL);
  const p = previewPayload(a, undefined, false);
  assert.deepEqual(p.views.map((v) => v.key), ["land", "ctx"]);
  assert.equal(p.current, "ctx"); // the default view
  assert.match(p.svg!, /^<svg /);
  assert.equal(p.message, undefined);
  assert.equal(previewPayload(a, "land", false).current, "land");
  assert.equal(previewPayload(a, "missing", false).current, "ctx");
  assert.equal(previewPayload(analyze(DSL.replace("      default\n", "")), undefined, false).current, "land");
});

test("payload: dark mode and transparency", () => {
  const a = analyze(DSL);
  const light = previewPayload(a, "land", false).svg!;
  const dark = previewPayload(a, "land", true).svg!;
  assert.notEqual(light, dark);
  assert.ok(!light.includes('width="100%"') && !dark.includes('width="100%"')); // transparent: the editor background shows
});

test("payload: messages when there is nothing to draw", () => {
  const noViews = previewPayload(analyze('workspace {\n model {\n }\n}\n'), undefined, false);
  assert.equal(noViews.svg, undefined);
  assert.match(noViews.message!, /no views/);
  const broken = previewPayload(analyze('workspace {\n model {\n  nope "x"\n }\n}\n'), undefined, false);
  assert.match(broken.message!, /Fix the errors/);
  const partial = previewPayload(analyze(DSL.replace('u = person "User"', 'u = persn "User"')), undefined, false);
  assert.match(partial.message!, /errors/);
  assert.ok(partial.svg); // still draws what resolved
});

test("reveal targets: elements and relationships", () => {
  const a = analyze(DSL);
  const ws = a.result.workspace;
  const user = ws.model.elements.find((e) => e.identifier === "u")!;
  assert.deepEqual(revealTarget(a, { id: user.id })!.start.line, 2);
  assert.equal(revealTarget(a, { rel: ws.model.relationships[0]!.id })!.start.line, 4);
  assert.equal(revealTarget(a, { id: "999" }), undefined);
  assert.equal(revealTarget(a, {}), undefined);
});

test("webview html: strict CSP with a nonce, controls, and a script that matches the nonce", () => {
  const html = previewHtml("abc123", "vscode-resource:");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.match(html, /<script nonce="abc123">/);
  for (const id of ["views", "fit", "in", "out", "stage", "message"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!/<script(?![^>]*nonce)/.test(html), "no script without a nonce");
  assert.ok(!html.includes("http://") && !html.includes("https://"), "no remote resources");
  // the page's script is valid JavaScript
  const script = /<script nonce="abc123">([\s\S]*)<\/script>/.exec(html)![1]!;
  assert.doesNotThrow(() => new Function("acquireVsCodeApi", "document", "window", script));
});

// ---- through the adapter ---------------------------------------------------------------------

function setup(text = DSL) {
  const h = create();
  const ctx = { subscriptions: [] as unknown[] };
  activate(h.api, ctx as never);
  const doc = h.doc(text, "file:///w.dsl");
  h.api.workspace.textDocuments.push(doc);
  h.listeners.open.forEach((f: (d: unknown) => void) => f(doc));
  h.win.activeTextEditor = { document: doc };
  return { h, doc, ctx };
}

test("the open-preview command creates a secured webview panel beside the editor", () => {
  const { h } = setup();
  assert.equal(typeof h.commands["structurizr.openPreview"], "function");
  h.commands["structurizr.openPreview"]();
  assert.equal(h.panels.length, 1);
  const p = h.panels[0];
  assert.equal(p.type, "structurizrPreview");
  assert.equal(p.options.enableScripts, true);
  assert.equal(p.options.retainContextWhenHidden, true);
  assert.equal(p.column.viewColumn, -2); // beside
  assert.match(p.webview.html, /Content-Security-Policy/);
  // a second invocation reuses the panel
  h.commands["structurizr.openPreview"]();
  assert.equal(h.panels.length, 1);
  assert.equal(p.revealed, 1);
});

test("the panel gets a diagram when the page says it is ready, and re-renders on view selection", () => {
  const { h } = setup();
  h.commands["structurizr.openPreview"]();
  const p = h.panels[0];
  p.send({ type: "ready" });
  assert.equal(p.posted.at(-1).current, "ctx");
  assert.match(p.posted.at(-1).svg, /^<svg /);
  p.send({ type: "select", key: "land" });
  assert.equal(p.posted.at(-1).current, "land");
  assert.match(p.title, /^Preview: w\.dsl$/);
});

test("editing the document updates the preview; closing the panel stops updates", async () => {
  const { h, doc } = setup();
  h.commands["structurizr.openPreview"]();
  const p = h.panels[0];
  p.send({ type: "ready" });
  const before = p.posted.length;
  doc.text = DSL.replace('"System"', '"Renamed"');
  doc.version = 2;
  h.listeners.change.forEach((f: (e: unknown) => void) => f({ document: doc }));
  await new Promise((r) => setTimeout(r, 350));
  assert.ok(p.posted.length > before);
  assert.match(p.posted.at(-1).svg, /Renamed/);
  p.dispose();
  const after = p.posted.length;
  doc.text = DSL;
  doc.version = 3;
  h.listeners.change.forEach((f: (e: unknown) => void) => f({ document: doc }));
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(p.posted.length, after);
});

test("clicking an element reveals its source; clicking a relationship too", async () => {
  const { h, doc } = setup();
  h.commands["structurizr.openPreview"]();
  const p = h.panels[0];
  p.send({ type: "ready" });
  const ws = JSON.parse(JSON.stringify(h.panels[0].posted.at(-1)));
  assert.ok(ws.svg);
  p.send({ type: "reveal", id: "1" }); // the person is the first element
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].doc, doc);
  assert.equal(h.shown[0].opts.selection.start.line, 2);
  assert.equal(h.shown[0].opts.preserveFocus, false);
  p.send({ type: "reveal", rel: "3" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.shown[1].opts.selection.start.line, 4);
});

test("theme changes re-render in the matching scheme", () => {
  const { h } = setup();
  h.commands["structurizr.openPreview"]();
  const p = h.panels[0];
  p.send({ type: "ready" });
  const light = p.posted.at(-1).svg;
  h.win.activeColorTheme = { kind: 2 };
  h.themeListeners.forEach((f: () => void) => f());
  assert.notEqual(p.posted.at(-1).svg, light);
});

test("the preview follows the active Structurizr editor; other editors are ignored", () => {
  const { h } = setup();
  h.commands["structurizr.openPreview"]();
  const p = h.panels[0];
  p.send({ type: "ready" });
  const other = h.doc(DSL.replace('"System"', '"Other System"'), "file:///other.dsl");
  h.api.workspace.textDocuments.push(other);
  h.listeners.open.forEach((f: (d: unknown) => void) => f(other));
  h.editorListeners.forEach((f: (e: unknown) => void) => f({ document: other }));
  assert.match(p.posted.at(-1).svg, /Other System/);
  const count = p.posted.length;
  h.editorListeners.forEach((f: (e: unknown) => void) => f({ document: h.doc("x", "file:///n.txt", "plaintext") }));
  h.editorListeners.forEach((f: (e: unknown) => void) => f(undefined));
  assert.equal(p.posted.length, count);
});

test("the command on a non-Structurizr editor shows a message instead of a panel", () => {
  const h = create();
  activate(h.api, { subscriptions: [] });
  h.win.activeTextEditor = { document: h.doc("x", "file:///n.txt", "plaintext") };
  h.commands["structurizr.openPreview"]();
  assert.equal(h.panels.length, 0);
  assert.match(h.infoMessages[0], /Structurizr/);
  h.win.activeTextEditor = undefined;
  h.commands["structurizr.openPreview"]();
  assert.equal(h.infoMessages.length, 2);
});
