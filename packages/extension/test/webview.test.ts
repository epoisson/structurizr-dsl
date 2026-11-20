import { test } from "node:test";
import assert from "node:assert/strict";
import { previewHtml } from "../src/preview.ts";

/** Just enough of a DOM to run the preview page's script. */
class FakeEl {
  id: string;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e: any) => void>> = {};
  children: FakeEl[] = [];
  classes = new Set<string>();
  classList = { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c) };
  textContent = "";
  value = "";
  disabled = false;
  removed = false;
  insertAdjacentHTML: (pos: string, html: string) => void = () => {};
  constructor(id = "") { this.id = id; }
  addEventListener(t: string, fn: (e: any) => void) { (this.listeners[t] ??= []).push(fn); }
  fire(t: string, e: any = {}) { (this.listeners[t] ?? []).forEach((f) => f({ preventDefault() {}, ...e })); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  getAttribute(n: string) { return this.attrs[n]; }
  appendChild(c: FakeEl) { this.children.push(c); }
  remove() { this.removed = true; }
  set innerHTML(_v: string) { this.children = []; }
}

function boot() {
  const els: Record<string, FakeEl> = {};
  for (const id of ["stage", "views", "note", "message", "fit", "in", "out", "export"]) els[id] = new FakeEl(id);
  const svgs: FakeEl[] = [];
  els.stage!.insertAdjacentHTML = (_pos: string, html: string) => {
    const s = new FakeEl();
    s.attrs.width = /width="([\d.]+)"/.exec(html)![1]!;
    s.attrs.height = /height="([\d.]+)"/.exec(html)![1]!;
    svgs.push(s);
  };
  (els.stage as any).querySelector = () => svgs.filter((s) => !s.removed).at(-1);
  (els.stage as any).querySelectorAll = () => svgs.filter((s) => !s.removed);
  const win = new FakeEl();
  const posted: any[] = [];
  let saved: unknown;
  const api = { postMessage: (m: unknown) => void posted.push(m), getState: () => saved, setState: (s: unknown) => void (saved = s) };
  const doc = { getElementById: (id: string) => els[id], createElement: () => new FakeEl() };
  const html = previewHtml("n", "csp");
  const script = /<script nonce="n">([\s\S]*)<\/script>/.exec(html)![1]!;
  new Function("acquireVsCodeApi", "document", "window", script)(() => api, doc, win);
  const send = (m: unknown) => win.fire("message", { data: m });
  const svg = (w = 400, h = 300) => `<svg width="${w}" height="${h}"></svg>`;
  const scaleOf = (s: FakeEl) => Number(/scale\(([\d.e-]+)\)/.exec(s.style.transform!)![1]);
  return { els, svgs, win, posted, send, svg, scaleOf, get state() { return saved; } };
}
const VIEWS = [{ key: "a", title: "A", type: "container" }, { key: "b", title: "B", type: "custom" }];

test("the page announces itself, then renders what it is sent", () => {
  const p = boot();
  assert.deepEqual(p.posted, [{ type: "ready" }]);
  p.send({ type: "render", views: VIEWS, current: "b", svg: p.svg(), message: undefined });
  assert.equal(p.els.views!.value, "b");
  assert.equal(p.els.views!.children.length, 2);
  assert.equal(p.els.message!.style.display, "none");
  assert.equal(p.svgs.length, 1);
  assert.match(p.svgs[0]!.style.transform!, /translate\(.*\) scale\(/);
  assert.deepEqual(p.state, { key: "b" });
});

test("the first diagram is fitted to the window (800x600 stage, 400x300 diagram -> scale about 1.25)", () => {
  const p = boot();
  p.send({ type: "render", views: VIEWS, current: "a", svg: p.svg(400, 300), message: undefined });
  assert.ok(Math.abs(p.scaleOf(p.svgs[0]!) - 1.25) < 1e-9);
  const big = boot();
  big.send({ type: "render", views: VIEWS, current: "a", svg: big.svg(1600, 1200), message: undefined });
  assert.ok(big.scaleOf(big.svgs[0]!) < 0.5); // shrunk to fit
});

test("a re-render of the same view keeps the user's zoom; switching view refits", () => {
  const p = boot();
  p.send({ type: "render", views: VIEWS, current: "a", svg: p.svg(), message: undefined });
  p.els.in!.fire("click");
  const zoomed = p.scaleOf(p.svgs[0]!);
  p.send({ type: "render", views: VIEWS, current: "a", svg: p.svg(), message: undefined }); // e.g. after a keystroke
  assert.equal(p.scaleOf(p.svgs[1]!), zoomed);
  assert.equal(p.svgs[0]!.removed, true); // the old diagram is replaced
  p.send({ type: "render", views: VIEWS, current: "b", svg: p.svg(), message: undefined });
  assert.ok(Math.abs(p.scaleOf(p.svgs[2]!) - 1.25) < 1e-9);
});

test("with nothing to draw it shows the message and disables the picker", () => {
  const p = boot();
  p.send({ type: "render", views: [], current: undefined, svg: undefined, message: "No views yet" });
  assert.equal(p.els.message!.style.display, "flex");
  assert.equal(p.els.message!.textContent, "No views yet");
  assert.equal(p.els.views!.disabled, true);
  assert.equal(p.svgs.length, 0);
});

test("choosing a view posts a select message", () => {
  const p = boot();
  p.send({ type: "render", views: VIEWS, current: "a", svg: p.svg(), message: undefined });
  p.els.views!.value = "b";
  p.els.views!.fire("change");
  assert.deepEqual(p.posted.at(-1), { type: "select", key: "b" });
});

test("zoom buttons, wheel (around the cursor) and fit", () => {
  const p = boot();
  p.send({ type: "render", views: VIEWS, current: "a", svg: p.svg(), message: undefined });
  const s = p.svgs[0]!;
  const base = p.scaleOf(s);
  p.els.in!.fire("click");
  assert.ok(Math.abs(p.scaleOf(s) - base * 1.25) < 1e-9);
  p.els.out!.fire("click");
  p.els.out!.fire("click");
  assert.ok(p.scaleOf(s) < base);
  p.els.fit!.fire("click");
  assert.ok(Math.abs(p.scaleOf(s) - base) < 1e-9);
  // wheel up zooms in, and the point under the cursor stays put
  const point = (): [number, number] => {
    const m = /translate\(([\d.-]+)px,([\d.-]+)px\) scale\(([\d.]+)\)/.exec(s.style.transform!)!;
    return [(100 - Number(m[1])) / Number(m[3]), (100 - Number(m[2])) / Number(m[3])];
  };
  const before = point();
  p.els.stage!.fire("wheel", { deltaY: -100, clientX: 100, clientY: 100 });
  assert.ok(p.scaleOf(s) > base);
  const after = point();
  assert.ok(Math.abs(before[0] - after[0]) < 1e-6 && Math.abs(before[1] - after[1]) < 1e-6);
  for (let i = 0; i < 100; i++) p.els.stage!.fire("wheel", { deltaY: 100, clientX: 0, clientY: 0 });
  assert.ok(p.scaleOf(s) >= 0.1 - 1e-9); // clamped
});

test("a click on an element or relationship posts reveal; a drag pans and does not", () => {
  const p = boot();
  p.send({ type: "render", views: VIEWS, current: "a", svg: p.svg(), message: undefined });
  const node = { closest: () => ({ dataset: { id: "7" } }) };
  const edge = { closest: () => ({ dataset: { rel: "9" } }) };
  const none = { closest: () => null };
  const click = (target: unknown) => {
    p.els.stage!.fire("mousedown", { clientX: 10, clientY: 10 });
    p.win.fire("mouseup", { target });
  };
  click(node);
  assert.deepEqual(p.posted.at(-1), { type: "reveal", id: "7" });
  click(edge);
  assert.deepEqual(p.posted.at(-1), { type: "reveal", rel: "9" });
  const count = p.posted.length;
  click(none);
  assert.equal(p.posted.length, count);

  const before = p.svgs[0]!.style.transform;
  p.els.stage!.fire("mousedown", { clientX: 10, clientY: 10 });
  p.win.fire("mousemove", { clientX: 60, clientY: 40 });
  assert.ok(p.els.stage!.classes.has("dragging"));
  p.win.fire("mouseup", { target: node });
  assert.notEqual(p.svgs[0]!.style.transform, before);
  assert.equal(p.posted.length, count); // no reveal after a drag
  assert.ok(!p.els.stage!.classes.has("dragging"));
});

test("the Export… button asks the extension to export the view being shown", () => {
  const p = boot();
  p.send({ type: "render", views: VIEWS, current: "a", svg: p.svg(), message: undefined });
  p.els.export!.fire("click");
  assert.deepEqual(p.posted.at(-1), { type: "export" });
});
