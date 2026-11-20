import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "../../core/src/index.ts";
import { listViews, renderView } from "../src/index.ts";

const fixture = readFileSync(new URL("../../core/test/fixtures/full.dsl", import.meta.url), "utf8");
const ws = load(fixture).workspace;

/** A tiny XML well-formedness check: balanced, properly nested tags; no NaN/undefined leaked into attributes. */
function assertWellFormed(svg: string): void {
  const stack: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = m;
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), name, `unbalanced </${name}>`);
    else stack.push(name!);
  }
  assert.deepEqual(stack, [], "all tags closed");
  assert.ok(!/NaN|undefined|Infinity/.test(svg), "no NaN/undefined/Infinity in output");
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(svg), "no unescaped ampersands");
}

test("every view in the fixture renders to well-formed SVG with sane geometry", () => {
  for (const v of ws.views) {
    const r = renderView(ws, v.key)!;
    assert.ok(r, v.key);
    assertWellFormed(r.svg);
    assert.match(r.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [\d.]+ [\d.]+"/);
    for (const n of r.nodes) assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.width <= r.width + 0.5 && n.y + n.height <= r.height + 0.5, `${v.key}: ${n.id} inside the canvas`);
    for (const e of r.edges) for (const p of e.points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test("rendering is deterministic", () => {
  assert.equal(renderView(ws, "containers")!.svg, renderView(ws, "containers")!.svg);
});

test("an unknown view key gives undefined; listViews describes the views", () => {
  assert.equal(renderView(ws, "nope"), undefined);
  const views = listViews(ws);
  assert.equal(views.length, ws.views.length);
  assert.deepEqual(views.find((v) => v.key === "containers"), { key: "containers", title: "[Container] Software System", type: "container", isDefault: false });
  assert.match(views.find((v) => v.key === "context")!.title, /^\[System Context\] Software System$/);
});

test("elements and relationships carry data attributes for interaction", () => {
  const r = renderView(ws, "containers")!;
  const web = ws.model.elements.find((e) => e.identifier === "ss.web")!;
  assert.match(r.svg, new RegExp(`<g class="node" data-id="${web.id}">`));
  assert.match(r.svg, /<g class="edge" data-rel="\d+">/);
  assert.ok(r.nodes.some((n) => n.id === web.id && n.kind === "element"));
  assert.ok(r.nodes.some((n) => n.kind === "boundary")); // the system's boundary around its containers
});

test("a container view draws the scope as a boundary that contains its containers", () => {
  const r = renderView(ws, "containers")!;
  const b = r.nodes.find((n) => n.kind === "boundary")!;
  const inside = r.nodes.filter((n) => n.kind === "element" && ws.model.elements.find((e) => e.id === n.id)?.type === "container");
  assert.ok(inside.length >= 2);
  for (const n of inside) assert.ok(n.x >= b.x && n.y >= b.y && n.x + n.width <= b.x + b.width && n.y + n.height <= b.y + b.height, "container inside boundary");
  const person = r.nodes.find((n) => ws.model.elements.find((e) => e.id === n.id)?.type === "person")!;
  assert.ok(person.y + person.height <= b.y || person.y >= b.y + b.height, "people stay outside the boundary");
});

test("deployment views nest nodes and instances", () => {
  const r = renderView(ws, "deployment")!;
  const rect = (id: string) => r.nodes.find((n) => n.id === id)!;
  const outer = ws.model.elements.find((e) => e.identifier === "node")!;
  const nested = ws.model.elements.find((e) => e.type === "deploymentNode" && e.parentId === outer.id)!;
  const instance = ws.model.elements.find((e) => e.parentId === nested.id)!;
  const inside = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
  assert.ok(inside(rect(nested.id), rect(outer.id)));
  assert.ok(inside(rect(instance.id), rect(nested.id)));
  assert.match(r.svg, /Server \(x2\)/);
});

test("the dynamic view numbers its steps and respects autoLayout direction", () => {
  const r = renderView(ws, "flow")!;
  assert.deepEqual(r.edges.map((e) => e.order), ["1", "2", "3"]);
  assert.match(r.svg, /1: Requests a page/);
  assert.match(r.svg, /2: Calls/);
  assert.match(r.svg, /3: Queries/); // the step's description override
  // `autolayout lr`: elements progress from left to right along the steps
  const x = (id: string) => r.nodes.find((n) => n.id === id)!.x;
  const user = ws.model.elements.find((e) => e.identifier === "user")!;
  const web = ws.model.elements.find((e) => e.identifier === "ss.web")!;
  const db = ws.model.elements.find((e) => e.identifier === "ss.db")!;
  assert.ok(x(user.id) < x(web.id) && x(web.id) < x(db.id));
});

test("edges end on the borders of their boxes, with an arrowhead", () => {
  const r = renderView(ws, "containers")!;
  const near = (p: { x: number; y: number }, n: { x: number; y: number; width: number; height: number }): boolean => {
    const onX = Math.abs(p.x - n.x) < 1.5 || Math.abs(p.x - (n.x + n.width)) < 1.5;
    const onY = Math.abs(p.y - n.y) < 1.5 || Math.abs(p.y - (n.y + n.height)) < 1.5;
    return (onX && p.y >= n.y - 1.5 && p.y <= n.y + n.height + 1.5) || (onY && p.x >= n.x - 1.5 && p.x <= n.x + n.width + 1.5);
  };
  for (const e of r.edges) {
    const rel = ws.model.relationships.find((x) => x.id === e.id)!;
    const src = r.nodes.find((n) => n.id === rel.sourceId)!;
    const dst = r.nodes.find((n) => n.id === rel.destinationId)!;
    assert.ok(near(e.points[0]!, src), "starts on the source border");
    assert.ok(near(e.points.at(-1)!, dst), "ends on the destination border");
  }
  assert.match(r.svg, /marker-end="url\(#arrow-/);
});

test("styles: defaults per type, tag styles in order, terminology, dark mode", () => {
  const light = renderView(ws, "landscape")!.svg;
  assert.match(light, /fill="#08427b"/); // Person default
  assert.match(light, /fill="#1168bd"/); // Software System default
  assert.match(light, /\[Actor\]/); // terminology override
  const dark = renderView(ws, "landscape", { dark: true })!.svg;
  assert.match(dark, /<rect width="100%" height="100%" fill="#1e1e1e"\/>/);
  assert.notEqual(dark, light);
  const bare = renderView(ws, "landscape", { transparent: true })!.svg;
  assert.ok(!bare.includes('width="100%"'));
  const custom = load('workspace {\n model {\n  p = person "P" "d" "VIP"\n }\n views {\n  systemLandscape "k" {\n   include *\n  }\n  styles {\n   element "VIP" {\n    shape Hexagon\n    background #ff0000\n    color #00ff00\n   }\n  }\n }\n}').workspace;
  const svg = renderView(custom, "k")!.svg;
  assert.match(svg, /<polygon [^>]*fill="#ff0000"/);
  assert.match(svg, /fill="#00ff00"/);
});

test("shapes: each draws something, unknown ones fall back to a box", () => {
  for (const shape of ["Box", "RoundedBox", "Circle", "Ellipse", "Hexagon", "Diamond", "Cylinder", "Person", "WebBrowser", "Folder", "Robot"]) {
    const w = load(`workspace {\n model {\n  a = softwareSystem "A"\n }\n views {\n  systemLandscape "k" {\n   include *\n  }\n  styles {\n   element "Software System" {\n    shape ${shape}\n   }\n  }\n }\n}`).workspace;
    const r = renderView(w, "k")!;
    assertWellFormed(r.svg);
    assert.match(r.svg, /<(rect|ellipse|polygon|path|circle)\b/, shape);
  }
});

test("title can be turned off; empty and image views render a message instead of failing", () => {
  assert.ok(renderView(ws, "landscape")!.svg.includes("[System Landscape]") || renderView(ws, "landscape")!.svg.includes("Landscape"));
  assert.ok(!renderView(ws, "containers", { title: false })!.svg.includes("[Container]"));
  const image = renderView(ws, "image")!;
  assertWellFormed(image.svg);
  assert.match(image.svg, /Image view: plantuml diagram\.puml/);
  const empty = load('workspace {\n model {\n }\n views {\n  custom "e" {\n  }\n }\n}').workspace;
  assert.match(renderView(empty, "e")!.svg, /This view is empty/);
});

test("text is escaped", () => {
  const w = load('workspace {\n model {\n  a = softwareSystem "R&D <Core> \\"x\\"" "A & B"\n }\n views {\n  systemLandscape "k" {\n   include *\n  }\n }\n}').workspace;
  const svg = renderView(w, "k")!.svg;
  assertWellFormed(svg);
  assert.ok(svg.includes("R&amp;D &lt;Core&gt; &quot;x&quot;"));
});

test("parallel relationships and self-relationships are drawn", () => {
  const w = load('workspace {\n model {\n  a = softwareSystem "A"\n  b = softwareSystem "B"\n  a -> b "One"\n  a -> b "Two"\n  b -> a "Back"\n  a -> a "Loop"\n }\n views {\n  systemLandscape "k" {\n   include *\n  }\n }\n}').workspace;
  const r = renderView(w, "k")!;
  assertWellFormed(r.svg);
  assert.equal(r.edges.length, 4);
  assert.equal(new Set(r.edges.slice(0, 3).map((e) => `${Math.round(e.points[0]!.x)},${Math.round(e.points[0]!.y)}`)).size, 3, "parallel edges start at distinct points");
  for (const t of ["One", "Two", "Back", "Loop"]) assert.ok(r.svg.includes(`>${t}<`));
});

test("a wide, dense graph renders in every direction without invalid output", () => {
  const w = load(readFileSync(new URL("./fixtures/big.dsl", import.meta.url), "utf8")).workspace;
  for (const dir of ["tb", "bt", "lr", "rl"]) {
    const copy = structuredClone(w);
    copy.views[0]!.autoLayout = { direction: dir as "tb", rankSeparation: 300, nodeSeparation: 300 };
    const r = renderView(copy, "landscape")!;
    assertWellFormed(r.svg);
    assert.equal(r.nodes.length, 9);
  }
});
