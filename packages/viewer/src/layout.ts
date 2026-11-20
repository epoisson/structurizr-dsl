/**
 * A small layered ("Sugiyama-style") graph layout with nested nodes, and no dependencies.
 *
 *   1. Nodes are laid out level by level, innermost first, so a compound node (a boundary or a
 *      deployment node) gets its size from the layout of its children.
 *   2. Within one level: break cycles, assign layers (longest path), add dummy nodes for edges that
 *      span several layers, reduce crossings with barycenter sweeps, then assign coordinates by
 *      isotonic regression (each node is pulled toward its neighbours without overlapping).
 *   3. An edge is solved at the level of the lowest compound containing both of its ends; its dummy
 *      nodes become waypoints.
 *
 * Direction tb/bt/lr/rl is handled by laying out top-to-bottom with width and height swapped, then transposing/flipping.
 */

export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}

export interface LNode {
  id: string;
  /** For a compound node this is a minimum; the real size comes from its children. */
  width: number;
  height: number;
  children?: LNode[];
  /** Compound nodes: space around the children, and space above them for the label. */
  padding?: number;
  header?: number;
}

export interface LEdge {
  id: string;
  from: string;
  to: string;
}

export type Direction = "tb" | "bt" | "lr" | "rl";

export interface LayoutOptions {
  direction: Direction;
  /** Space between layers. */
  rankSep: number;
  /** Space between nodes in a layer. */
  nodeSep: number;
}

export interface Layout {
  /** Absolute rectangles for every node, compound nodes included. */
  nodes: Map<string, Rect>;
  /** Absolute waypoints per edge (excluding the end points), in edge direction. */
  waypoints: Map<string, Point[]>;
  width: number;
  height: number;
}

interface Level {
  rects: Map<string, Rect>;
  waypoints: Map<string, Point[]>;
  width: number;
  height: number;
}

interface LevelEdge {
  id: string;
  a: string;
  b: string;
}

const DUMMY = 10;

export function layout(roots: LNode[], edges: LEdge[], opts: LayoutOptions): Layout {
  const byId = new Map<string, LNode>();
  const parent = new Map<string, string | undefined>();
  const index = (n: LNode, p: string | undefined): void => {
    byId.set(n.id, n);
    parent.set(n.id, p);
    n.children?.forEach((c) => index(c, n.id));
  };
  roots.forEach((r) => index(r, undefined));

  const chain = (id: string): string[] => {
    const out: string[] = [];
    for (let c: string | undefined = id; c !== undefined; c = parent.get(c)) out.unshift(c);
    return out;
  };

  // each edge belongs to the level of the lowest compound that contains both ends
  const perLevel = new Map<string | undefined, LevelEdge[]>();
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const ca = chain(e.from);
    const cb = chain(e.to);
    let i = 0;
    while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
    if (i >= ca.length || i >= cb.length) continue; // one end contains the other: not drawable
    const owner = i > 0 ? ca[i - 1] : undefined;
    const list = perLevel.get(owner) ?? [];
    list.push({ id: e.id, a: ca[i]!, b: cb[i]! });
    perLevel.set(owner, list);
  }

  // solve levels bottom-up; compound sizes are fixed as their inner layouts complete
  const levels = new Map<string | undefined, Level>();
  const sizes = new Map<string, { width: number; height: number; dx: number; dy: number }>();
  const solve = (owner: string | undefined, children: LNode[]): void => {
    for (const c of children) if (c.children?.length) solve(c.id, c.children);
    const nodes = children.map((c) => {
      const s = sizes.get(c.id);
      return { id: c.id, width: s?.width ?? c.width, height: s?.height ?? c.height };
    });
    const level = levelLayout(nodes, perLevel.get(owner) ?? [], opts);
    levels.set(owner, level);
    if (owner !== undefined) {
      const n = byId.get(owner)!;
      const pad = n.padding ?? 20;
      const header = n.header ?? 30;
      const width = Math.max(n.width, level.width + 2 * pad);
      const height = Math.max(n.height, level.height + 2 * pad + header);
      sizes.set(owner, { width, height, dx: pad + (width - 2 * pad - level.width) / 2, dy: pad + header });
    }
  };
  solve(undefined, roots);

  // make everything absolute
  const nodes = new Map<string, Rect>();
  const waypoints = new Map<string, Point[]>();
  const place = (owner: string | undefined, origin: Point): void => {
    const level = levels.get(owner)!;
    for (const [id, r] of level.rects) {
      const abs = { x: origin.x + r.x, y: origin.y + r.y, width: r.width, height: r.height };
      nodes.set(id, abs);
      const inner = sizes.get(id);
      if (inner) place(id, { x: abs.x + inner.dx, y: abs.y + inner.dy });
    }
    for (const [id, pts] of level.waypoints) waypoints.set(id, pts.map((p) => ({ x: origin.x + p.x, y: origin.y + p.y })));
  };
  place(undefined, { x: 0, y: 0 });

  const top = levels.get(undefined)!;
  return { nodes, waypoints, width: top.width, height: top.height };
}

// ---------------------------------------------------------------------------
// one level
// ---------------------------------------------------------------------------

function levelLayout(nodes: Array<{ id: string; width: number; height: number }>, edges: LevelEdge[], opts: LayoutOptions): Level {
  const swap = opts.direction === "lr" || opts.direction === "rl";
  const W = new Map<string, number>();
  const H = new Map<string, number>();
  for (const n of nodes) {
    W.set(n.id, swap ? n.height : n.width);
    H.set(n.id, swap ? n.width : n.height);
  }
  const ids = nodes.map((n) => n.id);

  // ---- unique directed pairs, then cycle removal (DFS back edges are reversed) ----
  const out = new Map<string, string[]>(ids.map((i) => [i, []]));
  const seen = new Set<string>();
  for (const e of edges) {
    const k = `${e.a}\u0000${e.b}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.get(e.a)!.push(e.b);
    }
  }
  const color = new Map<string, number>();
  const reversed = new Set<string>();
  const dfs = (u: string): void => {
    color.set(u, 1);
    for (const v of out.get(u)!) {
      const c = color.get(v) ?? 0;
      if (c === 1) reversed.add(`${u}\u0000${v}`);
      else if (c === 0) dfs(v);
    }
    color.set(u, 2);
  };
  for (const i of ids) if (!color.get(i)) dfs(i);

  const dag = new Map<string, Set<string>>(ids.map((i) => [i, new Set()]));
  const preds = new Map<string, Set<string>>(ids.map((i) => [i, new Set()]));
  for (const [u, vs] of out) {
    for (const v of vs) {
      const [s, t] = reversed.has(`${u}\u0000${v}`) ? [v, u] : [u, v];
      dag.get(s)!.add(t);
      preds.get(t)!.add(s);
    }
  }

  // ---- layering: longest path from the sources, then pull pure sources next to their targets ----
  const layer = new Map<string, number>();
  const indeg = new Map<string, number>(ids.map((i) => [i, preds.get(i)!.size]));
  const order: string[] = [];
  const queue = ids.filter((i) => indeg.get(i) === 0);
  for (const i of queue) layer.set(i, 0);
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of dag.get(u)!) {
      layer.set(v, Math.max(layer.get(v) ?? 0, layer.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  for (const u of [...order].reverse()) {
    if (preds.get(u)!.size === 0 && dag.get(u)!.size > 0) {
      layer.set(u, Math.min(...[...dag.get(u)!].map((v) => layer.get(v)!)) - 1);
    }
  }

  // ---- dummy nodes for edges spanning several layers ----
  const layers: string[][] = [];
  const put = (id: string, l: number): void => {
    (layers[l] ??= []).push(id);
  };
  for (const i of ids) put(i, layer.get(i)!);
  const up = new Map<string, string[]>(); // neighbours in the layer above
  const down = new Map<string, string[]>(); // neighbours in the layer below
  const link = (u: string, v: string): void => {
    (down.get(u) ?? down.set(u, []).get(u)!).push(v);
    (up.get(v) ?? up.set(v, []).get(v)!).push(u);
  };
  const chains = new Map<string, string[]>();
  let dummies = 0;
  for (const [u, vs] of dag) {
    for (const v of vs) {
      let prev = u;
      const mids: string[] = [];
      for (let l = layer.get(u)! + 1; l < layer.get(v)!; l++) {
        const d = `\u0000d${dummies++}`;
        W.set(d, DUMMY);
        H.set(d, 0);
        put(d, l);
        link(prev, d);
        mids.push(d);
        prev = d;
      }
      link(prev, v);
      chains.set(`${u}\u0000${v}`, mids);
    }
  }
  for (let l = 0; l < layers.length; l++) layers[l] ??= [];

  // ---- crossing reduction: barycenter sweeps ----
  const posIn = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const row of layers) row.forEach((id, i) => m.set(id, i));
    return m;
  };
  const sweep = (l: number, neighbours: Map<string, string[]>): void => {
    const pos = posIn();
    const bc = new Map<string, number>();
    for (const id of layers[l]!) {
      const ns = neighbours.get(id);
      bc.set(id, ns && ns.length ? ns.reduce((s, n) => s + pos.get(n)!, 0) / ns.length : pos.get(id)!);
    }
    layers[l]!.sort((a, b) => bc.get(a)! - bc.get(b)! || pos.get(a)! - pos.get(b)!);
  };
  for (let it = 0; it < 8; it++) {
    if (it % 2 === 0) for (let l = 1; l < layers.length; l++) sweep(l, up);
    else for (let l = layers.length - 2; l >= 0; l--) sweep(l, down);
  }

  // ---- coordinates ----
  const x = new Map<string, number>(); // centres
  for (const row of layers) {
    let cursor = 0;
    for (const id of row) {
      x.set(id, cursor + W.get(id)! / 2);
      cursor += W.get(id)! + opts.nodeSep;
    }
  }
  const settle = (row: string[], neighbours: Map<string, string[]>): void => {
    if (row.length === 0) return;
    const desired = row.map((id) => {
      const ns = neighbours.get(id);
      return ns && ns.length ? ns.reduce((s, n) => s + x.get(n)!, 0) / ns.length : x.get(id)!;
    });
    const offsets: number[] = [];
    let acc = 0;
    row.forEach((id, i) => {
      if (i > 0) acc += (W.get(row[i - 1]!)! + W.get(id)!) / 2 + opts.nodeSep;
      offsets.push(acc);
    });
    const placed = isotonic(desired.map((d, i) => d - offsets[i]!)).map((y, i) => y + offsets[i]!);
    row.forEach((id, i) => x.set(id, placed[i]!));
  };
  for (let pass = 0; pass < 6; pass++) {
    for (let l = 1; l < layers.length; l++) settle(layers[l]!, up);
    for (let l = layers.length - 2; l >= 0; l--) settle(layers[l]!, down);
  }

  // vertical positions: layers stacked with rankSep, each as tall as its tallest node
  const y = new Map<string, number>();
  const bandHeight: number[] = [];
  let cursorY = 0;
  layers.forEach((row, l) => {
    const h = Math.max(0, ...row.map((id) => H.get(id)!));
    bandHeight[l] = h;
    for (const id of row) y.set(id, cursorY + (h - H.get(id)!) / 2);
    cursorY += h + opts.rankSep;
  });

  // ---- normalise and transform back to the real direction ----
  let minX = Infinity, maxX = -Infinity;
  for (const [id, cx] of x) {
    minX = Math.min(minX, cx - W.get(id)! / 2);
    maxX = Math.max(maxX, cx + W.get(id)! / 2);
  }
  if (!Number.isFinite(minX)) return { rects: new Map(), waypoints: new Map(), width: 0, height: 0 };
  const totalMain = Math.max(0, cursorY - opts.rankSep);
  const totalCross = maxX - minX;

  const toReal = (cx: number, cy: number, w: number, h: number): Rect => {
    // cx, cy are centres in the top-to-bottom frame (cross axis x, main axis y)
    let rx = cx - minX;
    let ry = cy;
    let rw = w;
    let rh = h;
    if (swap) [rx, ry, rw, rh] = [ry, rx, rh, rw];
    const width = swap ? totalMain : totalCross;
    const height = swap ? totalCross : totalMain;
    if (opts.direction === "bt") ry = height - ry;
    if (opts.direction === "rl") rx = width - rx;
    return { x: rx - rw / 2, y: ry - rh / 2, width: rw, height: rh };
  };
  const centre = (id: string): Point => ({ x: x.get(id)!, y: y.get(id)! + H.get(id)! / 2 });

  const rects = new Map<string, Rect>();
  for (const n of nodes) {
    const c = centre(n.id);
    rects.set(n.id, toReal(c.x, c.y, W.get(n.id)!, H.get(n.id)!));
  }
  const waypoints = new Map<string, Point[]>();
  for (const e of edges) {
    const forward = chains.get(`${e.a}\u0000${e.b}`);
    const backward = chains.get(`${e.b}\u0000${e.a}`);
    const mids = forward ?? (backward ? [...backward].reverse() : []);
    waypoints.set(
      e.id,
      mids.map((d) => {
        const c = centre(d);
        const r = toReal(c.x, c.y, 0, 0);
        return { x: r.x, y: r.y };
      }),
    );
  }
  return {
    rects,
    waypoints,
    width: swap ? totalMain : totalCross,
    height: swap ? totalCross : totalMain,
  };
}

/** Pool-adjacent-violators: the non-decreasing sequence closest to `values` in the least-squares sense. */
function isotonic(values: number[]): number[] {
  const blocks: Array<{ sum: number; n: number }> = [];
  for (const v of values) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(b.sum / b.n);
  return out;
}
