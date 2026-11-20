import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/language.ts";
import { FORMATS, baseName, errorNote, exportAllViews, exportView, exportableViews, formatsInOrder, safeName, suggestedFileName } from "../src/exporting.ts";
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
    }
    image * "pic" {
      plantuml x.puml
    }
  }
}
`;
const ONE_VIEW = DSL.replace(/    systemContext[\s\S]*?\n    }\n/, "").replace(/    image[\s\S]*?\n    }\n/, "");
const a = analyze(DSL);

// ---- pure logic ------------------------------------------------------------------------------------------------

test("formats: five of them, each with an extension and a language id", () => {
  assert.deepEqual(FORMATS.map((f) => f.id), ["svg", "plantuml-c4", "plantuml-basic", "mermaid-flowchart", "mermaid-c4"]);
  assert.deepEqual([...new Set(FORMATS.map((f) => f.extension))], ["svg", "puml", "mmd"]);
  assert.equal(formatsInOrder("mermaid-flowchart")[0]!.id, "mermaid-flowchart");
  assert.equal(formatsInOrder("mermaid-flowchart").length, 5);
  assert.equal(formatsInOrder("nonsense")[0]!.id, "svg"); // unknown preference falls back
  assert.equal(formatsInOrder(undefined)[0]!.id, "svg");
});

test("exportableViews leaves out image views", () => {
  assert.deepEqual(exportableViews(a).map((v) => v.key), ["land", "ctx"]);
});

test("exportView produces each format's own syntax", () => {
  const get = (f: Parameters<typeof exportView>[2]): string => {
    const r = exportView(a, "ctx", f);
    assert.ok(r.ok, JSON.stringify(r));
    return r.content;
  };
  assert.match(get("svg"), /^<svg xmlns=/);
  assert.match(get("plantuml-c4"), /^@startuml\n[\s\S]*!include <C4\/C4_Context>[\s\S]*@enduml\n$/);
  assert.ok(!get("plantuml-basic").includes("C4/") && get("plantuml-basic").startsWith("@startuml"));
  assert.match(get("mermaid-flowchart"), /^---\ntitle: .*\n---\nflowchart TB\n/);
  assert.match(get("mermaid-c4"), /^C4Context\n/);
  for (const f of FORMATS) assert.ok(get(f.id).endsWith("\n"));
});

test("exportView: dark SVG, unknown views and formats, image views", () => {
  const light = exportView(a, "land", "svg") as { content: string };
  const dark = exportView(a, "land", "svg", { dark: true }) as { content: string };
  assert.notEqual(light.content, dark.content);
  assert.match(dark.content, /#1e1e1e/);
  assert.deepEqual(exportView(a, "nope", "svg"), { ok: false, message: "There is no view 'nope'." });
  const img = exportView(a, "pic", "plantuml-c4");
  assert.ok(!img.ok && /image view/.test(img.message));
  assert.ok(!exportView(a, "pic", "svg").ok);
  assert.ok(!exportView(a, "land", "bogus" as never).ok);
});

test("file names: safe, based on the document, deduplicated", () => {
  assert.equal(safeName("a/b c:d"), "a_b_c_d");
  assert.equal(safeName("../etc"), "__etc"); // cannot climb out of the chosen folder
  for (const nasty of ["../../x", "..\\..\\x", "/abs/path", "a/../b"]) {
    const n = safeName(nasty);
    assert.ok(!/[\\/]/.test(n) && !n.startsWith("."), `${nasty} -> ${n}`);
  }
  assert.equal(safeName(""), "view");
  assert.equal(baseName("/home/me/shop.dsl"), "shop");
  assert.equal(baseName("C:\\work\\shop.v2.dsl"), "shop.v2");
  assert.equal(baseName(undefined), "workspace");
  assert.equal(suggestedFileName("shop", "SystemContext-001", "puml"), "shop-SystemContext-001.puml");
  const clash = analyze('workspace {\n model {\n }\n views {\n  custom "a b" {\n  }\n  custom "a_b" {\n  }\n  custom "A_B" {\n  }\n }\n}');
  const { files } = exportAllViews(clash, "svg");
  assert.deepEqual(files.map((f) => f.name), ["a_b.svg", "a_b_2.svg", "A_B_3.svg"]); // case-insensitive clashes too
});

test("exportAllViews: one file per exportable view; image views are skipped", () => {
  const r = exportAllViews(a, "mermaid-flowchart");
  assert.deepEqual(r.files.map((f) => f.name), ["land.mmd", "ctx.mmd"]);
  assert.deepEqual(r.skipped, ["pic"]);
  assert.deepEqual(r.failed, []);
  assert.ok(r.files.every((f) => f.content.startsWith("---")));
});

test("errorNote counts errors, not warnings", () => {
  assert.equal(errorNote(a), undefined);
  assert.match(errorNote(analyze('workspace {\n model {\n  nope "x"\n }\n}\n'))!, /has 1 error, so/);
  assert.equal(errorNote(analyze('workspace {\n !const A b\n}\n')), undefined); // a warning only
});

// ---- the commands, through the adapter ---------------------------------------------------------------------------

const byLabel = (re: RegExp) => (items: Array<{ label: string }>) => items.find((i) => re.test(i.label));

function setup(text = DSL) {
  const h = create();
  activate(h.api, { subscriptions: [] });
  const doc = h.doc(text, "file:///work/w.dsl");
  h.api.workspace.textDocuments.push(doc);
  h.listeners.open.forEach((f: (d: unknown) => void) => f(doc));
  h.win.activeTextEditor = { document: doc };
  return { h, doc };
}
const run = (h: ReturnType<typeof create>, cmd: string) => h.commands[cmd]();

test("the commands are registered", () => {
  const { h } = setup();
  assert.equal(typeof h.commands["structurizr.exportView"], "function");
  assert.equal(typeof h.commands["structurizr.exportAllViews"], "function");
});

test("export a view and save it: view, format and action are asked, then the file is written next to the document", async () => {
  const { h } = setup();
  const target = h.Uri.file("/work/out/land.puml");
  h.queue.picks.push(byLabel(/^Landscape|System Landscape/), byLabel(/PlantUML \(C4\)/), byLabel(/Save/));
  h.queue.saves.push(target);
  await run(h, "structurizr.exportView");
  assert.equal(h.quickPickCalls.length, 3);
  assert.equal(h.quickPickCalls[0].items.length, 2); // the image view is not offered
  assert.equal(h.quickPickCalls[1].items.length, 5);
  assert.equal(h.saveCalls[0].defaultUri.path, "/work/w-land.puml");
  assert.deepEqual(h.saveCalls[0].filters, { "PlantUML (C4)": ["puml"] });
  const written = h.files.get(target.toString());
  assert.match(written, /^@startuml\n/);
  assert.match(written, /C4_Context/);
  assert.match(h.infoCalls.at(-1).message, /Exported 'land' as PlantUML \(C4\)/);
  assert.deepEqual(h.infoCalls.at(-1).items, ["Open"]);
});

test("choosing Open after saving opens the file", async () => {
  const { h } = setup();
  const target = h.Uri.file("/work/x.svg");
  h.queue.picks.push(byLabel(/Landscape/), byLabel(/SVG/), byLabel(/Save/));
  h.queue.saves.push(target);
  h.queue.info.push("Open");
  await run(h, "structurizr.exportView");
  assert.deepEqual(h.executed.at(-1), ["vscode.open", target]);
});

test("a workspace with a single view does not ask which view", async () => {
  const { h } = setup(ONE_VIEW);
  h.queue.picks.push(byLabel(/SVG/), byLabel(/Copy/));
  await run(h, "structurizr.exportView");
  assert.equal(h.quickPickCalls.length, 2);
  assert.match(h.clipboard[0], /^<svg /);
});

test("copy to clipboard and open in a new editor", async () => {
  const { h } = setup();
  h.queue.picks.push(byLabel(/Landscape/), byLabel(/Mermaid \(flowchart\)/), byLabel(/Copy/));
  await run(h, "structurizr.exportView");
  assert.match(h.clipboard[0], /^---\ntitle:/);
  assert.match(h.infoCalls.at(-1).message, /Copied the Mermaid \(flowchart\) export of 'land'/);

  const o = setup();
  o.h.queue.picks.push(byLabel(/Landscape/), byLabel(/PlantUML \(plain\)/), byLabel(/Open/));
  await run(o.h, "structurizr.exportView");
  assert.equal(o.h.opened[0].language, "plantuml");
  assert.match(o.h.opened[0].content, /^@startuml/);
  assert.equal(o.h.shown.length, 1);
  assert.equal(o.h.shown[0].opts.preview, false);
});

test("cancelling at any step does nothing", async () => {
  for (let stopAfter = 0; stopAfter < 4; stopAfter++) {
    const { h } = setup();
    const steps = [byLabel(/Landscape/), byLabel(/SVG/), byLabel(/Save/)];
    for (let i = 0; i < stopAfter && i < 3; i++) h.queue.picks.push(steps[i]!);
    // after the picks run out the next dialog returns undefined (cancel); the save dialog is never confirmed
    await run(h, "structurizr.exportView");
    assert.equal(h.files.size, 0, `step ${stopAfter}`);
    assert.equal(h.clipboard.length, 0);
    assert.equal(h.opened.length, 0);
    assert.ok(!h.infoCalls.some((c: { message: string }) => /Exported|Copied/.test(c.message)));
  }
});

test("settings: default format first, preset action skips the question, SVG theme", async () => {
  const { h } = setup(ONE_VIEW);
  h.config["structurizr.export.defaultFormat"] = "mermaid-c4";
  h.config["structurizr.export.action"] = "copy";
  h.queue.picks.push((items: Array<{ label: string }>) => items[0]);
  await run(h, "structurizr.exportView");
  assert.equal(h.quickPickCalls.length, 1); // only the format: the action came from settings
  assert.equal(h.quickPickCalls[0].items[0].label, "Mermaid (C4)");
  assert.match(h.clipboard[0], /^C4Context/);

  const d = setup(ONE_VIEW);
  d.h.config["structurizr.export.action"] = "copy";
  d.h.config["structurizr.export.svgTheme"] = "dark";
  d.h.queue.picks.push(byLabel(/SVG/));
  await run(d.h, "structurizr.exportView");
  assert.match(d.h.clipboard[0], /#1e1e1e/);

  const e = setup(ONE_VIEW);
  e.h.config["structurizr.export.action"] = "copy";
  e.h.config["structurizr.export.svgTheme"] = "editor";
  e.h.win.activeColorTheme = { kind: 2 };
  e.h.queue.picks.push(byLabel(/SVG/));
  await run(e.h, "structurizr.exportView");
  assert.match(e.h.clipboard[0], /#1e1e1e/);

  const l = setup(ONE_VIEW);
  l.h.config["structurizr.export.action"] = "copy";
  l.h.queue.picks.push(byLabel(/SVG/));
  await run(l.h, "structurizr.exportView");
  assert.ok(!l.h.clipboard[0].includes("#1e1e1e")); // default: light
});

test("a file with errors still exports, with a note", async () => {
  const { h } = setup(ONE_VIEW.replace('u = person "User"', 'u = persn "User"'));
  h.config["structurizr.export.action"] = "copy";
  h.queue.picks.push(byLabel(/SVG/));
  await run(h, "structurizr.exportView");
  assert.equal(h.clipboard.length, 1);
  assert.match(h.infoCalls.at(-1).message, /The file has 1 error, so the export shows only what could be resolved\./);
});

test("a write failure is reported, not thrown", async () => {
  const { h } = setup(ONE_VIEW);
  h.queue.picks.push(byLabel(/SVG/), byLabel(/Save/));
  h.queue.saves.push(h.Uri.file("/work/x.svg"));
  h.failWrites.on = true;
  await run(h, "structurizr.exportView");
  assert.match(h.errors[0], /Could not write .*x\.svg: disk full/);
  assert.ok(!h.infoCalls.some((c: { message: string }) => /^Exported/.test(c.message)));
});

test("nothing to export: no editor, or no views", async () => {
  const h = create();
  activate(h.api, { subscriptions: [] });
  await run(h, "structurizr.exportView");
  await run(h, "structurizr.exportAllViews");
  assert.deepEqual(h.infoMessages, ["Open a Structurizr .dsl file to export its views.", "Open a Structurizr .dsl file to export its views."]);

  const e = setup('workspace {\n model {\n }\n}\n');
  await run(e.h, "structurizr.exportView");
  await run(e.h, "structurizr.exportAllViews");
  assert.equal(e.h.infoMessages.filter((m: string) => /no views to export/.test(m)).length, 2);
  const only = setup('workspace {\n model {\n }\n views {\n  image * "p" {\n   plantuml a.puml\n  }\n }\n}\n');
  await run(only.h, "structurizr.exportView");
  assert.match(only.h.infoMessages.at(-1), /no views to export/);
});

test("export all: one file per view into the chosen folder; image views are reported as skipped", async () => {
  const { h } = setup();
  const folder = h.Uri.file("/work/diagrams");
  h.queue.picks.push(byLabel(/Mermaid \(flowchart\)/));
  h.queue.opens.push([folder]);
  await run(h, "structurizr.exportAllViews");
  assert.deepEqual([...h.files.keys()].sort(), ["file:///work/diagrams/ctx.mmd", "file:///work/diagrams/land.mmd"]);
  assert.equal(h.openCalls[0].canSelectFolders, true);
  assert.equal(h.openCalls[0].canSelectFiles, false);
  assert.equal(h.openCalls[0].defaultUri.path, "/work"); // starts next to the document
  const msg = h.infoCalls.at(-1);
  assert.match(msg.message, /Exported 2 views as Mermaid \(flowchart\)\. Skipped image view: pic\./);
  assert.deepEqual(msg.items, ["Reveal in File Explorer"]);
  h.queue.info.push("Reveal in File Explorer");
  // (reveal is offered on the message above; trigger it through a fresh run)
});

test("export all: existing files need confirmation; declining writes nothing, accepting overwrites", async () => {
  const { h } = setup();
  const folder = h.Uri.file("/work/d");
  h.files.set("file:///work/d/land.svg", "OLD");
  h.queue.picks.push(byLabel(/SVG/));
  h.queue.opens.push([folder]);
  h.queue.warn.push(undefined); // dismissed
  await run(h, "structurizr.exportAllViews");
  assert.match(h.warnings[0].message, /1 file already exists in that folder and will be overwritten: land\.svg\./);
  assert.equal(h.warnings[0].opts.modal, true);
  assert.equal(h.files.get("file:///work/d/land.svg"), "OLD");
  assert.equal(h.files.size, 1);

  h.queue.picks.push(byLabel(/SVG/));
  h.queue.opens.push([folder]);
  h.queue.warn.push("Overwrite");
  await run(h, "structurizr.exportAllViews");
  assert.match(h.files.get("file:///work/d/land.svg"), /^<svg /);
  assert.equal(h.files.size, 2);
});

test("export all: reveal in the file explorer, cancelling, and write errors", async () => {
  const { h } = setup();
  const folder = h.Uri.file("/work/r");
  h.queue.picks.push(byLabel(/SVG/));
  h.queue.opens.push([folder]);
  h.queue.info.push("Reveal in File Explorer");
  await run(h, "structurizr.exportAllViews");
  assert.deepEqual(h.executed.at(-1), ["revealFileInOS", folder]);

  const c = setup();
  c.h.queue.picks.push(byLabel(/SVG/));
  c.h.queue.opens.push(undefined); // folder dialog cancelled
  await run(c.h, "structurizr.exportAllViews");
  assert.equal(c.h.files.size, 0);

  const f = setup();
  f.h.queue.picks.push(byLabel(/SVG/));
  f.h.queue.opens.push([folder]);
  f.h.failWrites.on = true;
  await run(f.h, "structurizr.exportAllViews");
  assert.match(f.h.errors[0], /Could not write 2 files: .*disk full/);
  assert.match(f.h.infoCalls.at(-1).message, /Exported 0 views/);
});

test("the preview's Export… button exports the view being shown, without asking which", async () => {
  const { h } = setup();
  h.commands["structurizr.openPreview"]();
  const panel = h.panels[0];
  panel.send({ type: "ready" });
  panel.send({ type: "select", key: "ctx" });
  h.win.activeTextEditor = undefined; // focus is in the webview
  h.config["structurizr.export.action"] = "copy";
  h.queue.picks.push(byLabel(/PlantUML \(C4\)/));
  panel.send({ type: "export" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.quickPickCalls.length, 1); // only the format
  assert.match(h.clipboard[0], /C4_Context/);
  assert.match(h.clipboard[0], /SystemContext|System Context/);
  assert.match(h.infoCalls.at(-1).message, /export of 'ctx'/);
});

test("the view picker offers the previewed view first", async () => {
  const { h } = setup();
  h.commands["structurizr.openPreview"]();
  h.panels[0].send({ type: "ready" });
  h.panels[0].send({ type: "select", key: "ctx" });
  await run(h, "structurizr.exportView"); // all dialogs cancelled
  const items = h.quickPickCalls[0].items;
  assert.equal(items[0].key, "ctx");
  assert.match(items[0].description, /shown in the preview/);
});

// ---- the real build ---------------------------------------------------------------------------------------------
test("the BUILT extension exports through the real built exporters (guards the rewritten import paths)", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync(process.execPath, [`${root}scripts/build.mjs`], { stdio: "ignore" });
  const h = create();
  const stub = `${root}dist/node_modules/vscode`;
  mkdirSync(stub, { recursive: true });
  (globalThis as Record<string, unknown>).__mock = h;
  writeFileSync(`${stub}/index.js`, "module.exports = globalThis.__mock.api;\n");
  try {
    const shim = require(`${root}dist/extension.cjs`);
    const doc = h.doc(ONE_VIEW, "file:///work/w.dsl");
    h.api.workspace.textDocuments.push(doc);
    h.win.activeTextEditor = { document: doc };
    await shim.activate({ subscriptions: [] });
    h.config["structurizr.export.action"] = "copy";
    for (const [label, expected] of [["SVG", /^<svg /], ["PlantUML \\(C4\\)", /^@startuml/], ["Mermaid \\(flowchart\\)", /^---\ntitle:/], ["Mermaid \\(C4\\)", /^C4Context/], ["PlantUML \\(plain\\)", /skinparam/]] as const) {
      h.queue.picks.push(byLabel(new RegExp(label)));
      await h.commands["structurizr.exportView"]();
      assert.match(h.clipboard.at(-1), expected, label);
    }
    assert.equal(h.clipboard.length, 5);
    shim.deactivate();
  } finally {
    rmSync(`${root}dist/node_modules`, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__mock;
  }
});
