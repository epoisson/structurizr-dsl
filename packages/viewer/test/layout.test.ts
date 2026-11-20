import { test } from "node:test";
import assert from "node:assert/strict";
import { layout } from "../src/layout.ts";
import type { Direction, LEdge, LNode, Rect } from "../src/layout.ts";

const opts = (direction: Direction = "tb") => ({ direction, rankSep: 60, nodeSep: 40 });
const box = (id: string, w = 100, h = 50): LNode => ({ id, width: w, height: h });
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.width - 0.01 && b.x < a.x + a.width - 0.01 && a.y < b.y + b.height - 0.01 && b.y < a.y + a.height - 0.01;
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x - 0.01 && inner.y >= outer.y - 0.01 && inner.x + inner.width <= outer.x + outer.width + 0.01 && inner.y + inner.height <= outer.y + outer.height + 0.01;

/** Asserts that no two siblings overlap and every compound contains its children. */
function checkInvariants(roots: LNode[], result: ReturnType<typeof layout>): void {
  const visit = (siblings: LNode[], parent?: Rect): void => {
    const rects = siblings.map((s) => result.nodes.get(s.id)!);
    rects.forEach((r, i) => {
      assert.ok(r, `rect for ${siblings[i]!.id}`);
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y), "finite position");
      if (parent) assert.ok(contains(parent, r), `${siblings[i]!.id} inside its parent`);
      for (let j = i + 1; j < rects.length; j++) assert.ok(!overlap(r, rects[j]!), `${siblings[i]!.id} overlaps ${siblings[j]!.id}`);
    });
    siblings.forEach((s, i) => s.children && visit(s.children, rects[i]));
  };
  visit(roots);
  for (const r of result.nodes.values()) assert.ok(r.x >= -0.01 && r.y >= -0.01 && r.x + r.width <= result.width + 0.01 && r.y + r.height <= result.height + 0.01, "inside the canvas");
}

test("a chain is laid out in order along the main axis", () => {
  const roots = ["a", "b", "c"].map((i) => box(i));
  const edges: LEdge[] = [{ id: "1", from: "a", to: "b" }, { id: "2", from: "b", to: "c" }];
  const r = layout(roots, edges, opts("tb"));
  checkInvariants(roots, r);
  const [a, b, c] = ["a", "b", "c"].map((i) => r.nodes.get(i)!);
  assert.ok(a!.y + a!.height < b!.y && b!.y + b!.height < c!.y);
  assert.equal(a!.x + a!.width / 2, b!.x + b!.width / 2); // straight chain stays aligned
});

test("all four directions point the right way", () => {
  const roots = ["a", "b"].map((i) => box(i));
  const edges: LEdge[] = [{ id: "1", from: "a", to: "b" }];
  const at = (d: Direction) => {
    const r = layout(roots, edges, opts(d));
    return [r.nodes.get("a")!, r.nodes.get("b")!] as const;
  };
  let [a, b] = at("tb"); assert.ok(a.y < b.y);
  [a, b] = at("bt"); assert.ok(a.y > b.y);
  [a, b] = at("lr"); assert.ok(a.x < b.x && Math.abs(a.y - b.y) < 1);
  [a, b] = at("rl"); assert.ok(a.x > b.x);
});

test("long edges get one waypoint per skipped layer; short edges none", () => {
  const roots = ["a", "b", "c"].map((i) => box(i));
  const edges: LEdge[] = [{ id: "ab", from: "a", to: "b" }, { id: "bc", from: "b", to: "c" }, { id: "ac", from: "a", to: "c" }];
  const r = layout(roots, edges, opts());
  assert.equal(r.waypoints.get("ab")!.length, 0);
  assert.equal(r.waypoints.get("ac")!.length, 1);
  // the waypoint lies between the layers, not on top of b
  const w = r.waypoints.get("ac")![0]!;
  const b = r.nodes.get("b")!;
  assert.ok(w.x < b.x || w.x > b.x + b.width);
});

test("cycles and self-contained cycles do not break layout", () => {
  const roots = ["a", "b", "c"].map((i) => box(i));
  const edges: LEdge[] = [{ id: "1", from: "a", to: "b" }, { id: "2", from: "b", to: "c" }, { id: "3", from: "c", to: "a" }, { id: "4", from: "b", to: "a" }];
  const r = layout(roots, edges, opts());
  checkInvariants(roots, r);
  assert.equal(new Set([...r.nodes.values()].map((n) => Math.round(n.y))).size, 3); // three distinct layers
  assert.equal(r.waypoints.get("3")!.length, 1); // the reversed back edge keeps its waypoints, in edge order
});

test("disconnected nodes and an empty graph", () => {
  const roots = ["a", "b", "c"].map((i) => box(i));
  checkInvariants(roots, layout(roots, [], opts()));
  const empty = layout([], [], opts());
  assert.deepEqual([empty.width, empty.height, empty.nodes.size], [0, 0, 0]);
});

test("compound nodes contain their children and grow to fit them", () => {
  const roots: LNode[] = [
    { id: "group", width: 50, height: 50, padding: 20, header: 30, children: [box("x"), box("y")] },
    box("out"),
  ];
  const edges: LEdge[] = [{ id: "1", from: "x", to: "y" }, { id: "2", from: "y", to: "out" }];
  const r = layout(roots, edges, opts());
  checkInvariants(roots, r);
  const g = r.nodes.get("group")!;
  assert.ok(g.height >= 50 + 50 + 40 + 30 + 60 - 1); // two stacked boxes + padding + header + rank gap
  assert.ok(r.nodes.get("x")!.y >= g.y + 30 + 20 - 0.01); // below the header
  assert.ok(r.nodes.get("out")!.y > g.y + g.height); // edge from inside the group to outside still orders the groups
});

test("compounds nest, and an edge between nested leaves is solved at the lowest shared level", () => {
  const roots: LNode[] = [
    {
      id: "outer", width: 10, height: 10, children: [
        { id: "inner1", width: 10, height: 10, children: [box("a"), box("b")] },
        { id: "inner2", width: 10, height: 10, children: [box("c")] },
      ],
    },
  ];
  const edges: LEdge[] = [{ id: "ab", from: "a", to: "b" }, { id: "bc", from: "b", to: "c" }, { id: "oa", from: "outer", to: "a" }];
  const r = layout(roots, edges, opts("lr"));
  checkInvariants(roots, r);
  assert.ok(r.nodes.get("a")!.x < r.nodes.get("b")!.x);
  assert.ok(r.nodes.get("inner1")!.x < r.nodes.get("inner2")!.x);
  assert.ok(r.waypoints.has("ab") && r.waypoints.has("bc"));
  assert.ok(!r.waypoints.has("oa")); // ancestor edge: skipped, not drawable
});

test("parallel and anti-parallel edges are fine", () => {
  const roots = ["a", "b"].map((i) => box(i));
  const edges: LEdge[] = [{ id: "1", from: "a", to: "b" }, { id: "2", from: "a", to: "b" }, { id: "3", from: "b", to: "a" }];
  checkInvariants(roots, layout(roots, edges, opts()));
});

test("crossing reduction: a bipartite pair that crosses in input order gets uncrossed", () => {
  const roots = ["a1", "a2", "b1", "b2"].map((i) => box(i));
  const edges: LEdge[] = [{ id: "1", from: "a1", to: "b2" }, { id: "2", from: "a2", to: "b1" }];
  const r = layout(roots, edges, opts());
  const [a1, a2, b1, b2] = ["a1", "a2", "b1", "b2"].map((i) => r.nodes.get(i)!.x);
  assert.ok((a1! - a2!) * (b2! - b1!) > 0, "a1 is on the same side as b2");
});

test("random graphs: invariants always hold, in every direction", () => {
  let seed = 12345;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let round = 0; round < 60; round++) {
    const n = 2 + Math.floor(rnd() * 12);
    const roots: LNode[] = [];
    for (let i = 0; i < n; i++) roots.push(box(`n${i}`, 60 + Math.floor(rnd() * 120), 30 + Math.floor(rnd() * 80)));
    // wrap some nodes into compounds
    const groups = Math.floor(rnd() * 3);
    const top: LNode[] = [];
    const wrapped = roots.slice();
    for (let g = 0; g < groups && wrapped.length > 3; g++) {
      const take = wrapped.splice(0, 2 + Math.floor(rnd() * 2));
      top.push({ id: `g${g}`, width: 10, height: 10, children: take });
    }
    top.push(...wrapped);
    const edges: LEdge[] = [];
    const m = Math.floor(rnd() * n * 2);
    for (let i = 0; i < m; i++) {
      const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n);
      if (a !== b) edges.push({ id: `e${i}`, from: `n${a}`, to: `n${b}` });
    }
    for (const d of ["tb", "bt", "lr", "rl"] as const) checkInvariants(top, layout(top, edges, opts(d)));
  }
});
