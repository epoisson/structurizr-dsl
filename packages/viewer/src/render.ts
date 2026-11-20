import type { Element, ElementStyle, Relationship, RelationshipStyle, View, Workspace } from "../../core/src/index.ts";
import { layout } from "./layout.ts";
import { viewEdges, viewHierarchy } from "./structure.ts";
import type { Direction, LEdge, LNode, Point, Rect } from "./layout.ts";

/**
 * Renders one view of a resolved workspace to a standalone SVG string.
 *
 * Styling follows Structurizr: built-in defaults per tag ("Person", "Container", ...), then the
 * workspace's `styles` in declaration order for every tag the element carries, then `light`/`dark`
 * overrides. Structurizr's own sizes (450x300 boxes, 24px text) are scaled by 0.5.
 */

export interface RenderOptions {
  /** Use the workspace's `dark` styles and light-on-dark defaults. */
  dark?: boolean;
  /** Leave the canvas unpainted (for embedding on a themed background). */
  transparent?: boolean;
  /** Draw the view title above the diagram. Default true. */
  title?: boolean;
}

export interface RenderedNode {
  /** Element id, or "boundary:<id>" for the boundary drawn around the scope element's children. */
  id: string;
  kind: "element" | "boundary";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedEdge {
  /** Relationship id. */
  id: string;
  /** Dynamic views: the step order. */
  order?: string;
  points: Point[];
}

export interface RenderedView {
  svg: string;
  width: number;
  height: number;
  nodes: RenderedNode[];
  edges: RenderedEdge[];
}

const SCALE = 0.5;
const MARGIN = 30;
const TITLE_HEIGHT = 50;

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

export interface Style {
  shape: string;
  background: string;
  color: string;
  stroke: string;
  strokeWidth: number;
  border: "solid" | "dashed" | "dotted";
  fontSize: number;
  opacity: number;
  width?: number;
  height?: number;
  metadata: boolean;
  description: boolean;
}

export interface LineStyle {
  color: string;
  dash: string;
  thickness: number;
  fontSize: number;
  labelWidth: number;
  position: number;
  opacity: number;
}

const BASE: Style = {
  shape: "Box", background: "#dddddd", color: "#000000", stroke: "", strokeWidth: 1, border: "solid",
  fontSize: 12, opacity: 100, metadata: true, description: true,
};

const TAG_DEFAULTS: Record<string, Partial<Style>> = {
  Element: {},
  Person: { shape: "Person", background: "#08427b", color: "#ffffff" },
  "Software System": { background: "#1168bd", color: "#ffffff" },
  Container: { background: "#438dd5", color: "#ffffff" },
  Component: { background: "#85bbf0", color: "#000000" },
  "Deployment Node": { background: "#ffffff", color: "#000000", stroke: "#888888" },
  "Infrastructure Node": { background: "#ffffff", color: "#000000", stroke: "#888888" },
  "Software System Instance": { background: "#1168bd", color: "#ffffff" },
  "Container Instance": { background: "#438dd5", color: "#ffffff" },
};
const DARK_NODE: Partial<Style> = { background: "#2d2d2d", color: "#e6e6e6", stroke: "#888888" };

/** Multiplies each colour channel (factor < 1 darkens). */
function shade(hex: string, factor: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#444444";
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  const ch = [0, 2, 4].map((i) => Math.round(Math.min(255, parseInt(h.slice(i, i + 2), 16) * factor)));
  return "#" + ch.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** CSS colour names are valid in SVG; hex is passed through. */
const colour = (c: string | undefined, fallback: string): string => (c && /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(c) ? c : fallback);

export function resolveElementStyle(ws: Workspace, el: Element, dark: boolean): Style {
  const style: Style = { ...BASE };
  const apply = (p: Partial<Style>): void => {
    for (const [k, v] of Object.entries(p)) if (v !== undefined) (style as unknown as Record<string, unknown>)[k] = v;
  };
  for (const tag of el.tags) {
    apply(TAG_DEFAULTS[tag] ?? {});
    if (dark && (tag === "Deployment Node" || tag === "Infrastructure Node")) apply(DARK_NODE);
  }
  const sets = [ws.styles, dark ? ws.styles.dark : ws.styles.light].filter((s): s is NonNullable<typeof s> => s !== undefined);
  for (const set of sets) {
    for (const s of set.elements) {
      if (!el.tags.includes(s.tag)) continue;
      const u: ElementStyle = s;
      apply({
        shape: u.shape,
        background: u.background,
        color: u.color,
        stroke: u.stroke,
        strokeWidth: u.strokeWidth === undefined ? undefined : Math.max(1, u.strokeWidth * SCALE),
        border: u.border,
        fontSize: u.fontSize === undefined ? undefined : Math.max(7, u.fontSize * SCALE),
        opacity: u.opacity,
        width: u.width === undefined ? undefined : u.width * SCALE,
        height: u.height === undefined ? undefined : u.height * SCALE,
        metadata: u.metadata,
        description: u.description,
      });
    }
  }
  style.background = colour(style.background, BASE.background);
  style.color = colour(style.color, BASE.color);
  style.stroke = style.stroke ? colour(style.stroke, shade(style.background, 0.7)) : shade(style.background, 0.7);
  return style;
}

export function resolveRelationshipStyle(ws: Workspace, rel: Relationship, dark: boolean): LineStyle {
  const s: LineStyle = { color: dark ? "#b0b0b0" : "#707070", dash: "6 4", thickness: 1.5, fontSize: 11, labelWidth: 150, position: 50, opacity: 100 };
  const sets = [ws.styles, dark ? ws.styles.dark : ws.styles.light].filter((x): x is NonNullable<typeof x> => x !== undefined);
  for (const set of sets) {
    for (const u of set.relationships as RelationshipStyle[]) {
      if (!rel.tags.includes(u.tag)) continue;
      if (u.color) s.color = colour(u.color, s.color);
      if (u.style) s.dash = u.style === "solid" ? "" : u.style === "dotted" ? "2 4" : "6 4";
      if (u.thickness !== undefined) s.thickness = Math.max(0.5, u.thickness * 0.75);
      if (u.fontSize !== undefined) s.fontSize = Math.max(7, u.fontSize * SCALE);
      if (u.width !== undefined) s.labelWidth = Math.max(60, u.width * 0.75);
      if (u.position !== undefined) s.position = u.position;
      if (u.opacity !== undefined) s.opacity = u.opacity;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

const charWidth = (size: number, bold = false): number => size * (bold ? 0.6 : 0.55);
const textWidth = (text: string, size: number, bold = false): number => text.length * charWidth(size, bold);

function wrap(text: string, maxWidth: number, size: number, bold = false): string[] {
  const maxChars = Math.max(6, Math.floor(maxWidth / charWidth(size, bold)));
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let cur = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > maxChars) {
        if (cur) lines.push(cur), (cur = "");
        lines.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      if (!cur) cur = word;
      else if ((cur + " " + word).length <= maxChars) cur += " " + word;
      else lines.push(cur), (cur = word);
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number): string => String(Math.round(n * 100) / 100);

interface TextLine {
  text: string;
  size: number;
  bold: boolean;
  dim?: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  person: "Person",
  softwareSystem: "Software System",
  container: "Container",
  component: "Component",
  deploymentNode: "Deployment Node",
  infrastructureNode: "Infrastructure Node",
  softwareSystemInstance: "Software System",
  containerInstance: "Container",
};
const TERM_KEY: Record<string, string> = {
  person: "person", softwareSystem: "softwareSystem", container: "container", component: "component",
  deploymentNode: "deploymentNode", infrastructureNode: "infrastructureNode",
  softwareSystemInstance: "softwareSystem", containerInstance: "container",
};

export function metadataText(ws: Workspace, el: Element): string | undefined {
  const kind = ws.terminology.metadata ?? "square";
  if (kind === "none") return undefined;
  let inner: string;
  if (el.type === "customElement") inner = el.metadata ?? "";
  else {
    const label = ws.terminology[TERM_KEY[el.type] ?? ""] ?? TYPE_LABEL[el.type] ?? el.type;
    inner = el.technology ? `${label}: ${el.technology}` : label;
  }
  if (!inner) return undefined;
  const [l, r] = { square: ["[", "]"], round: ["(", ")"], curly: ["{", "}"], angle: ["<", ">"], "double-angle": ["\u00ab", "\u00bb"] }[kind] ?? ["[", "]"];
  return `${l}${inner}${r}`;
}

function nodeText(ws: Workspace, el: Element, style: Style, width: number): TextLine[] {
  const inner = width - 24;
  const lines: TextLine[] = [];
  const name = el.type === "deploymentNode" && el.instances && el.instances !== "1" ? `${el.name} (x${el.instances})` : el.name;
  for (const t of wrap(name, inner, style.fontSize + 1, true)) lines.push({ text: t, size: style.fontSize + 1, bold: true });
  const meta = style.metadata ? metadataText(ws, el) : undefined;
  if (meta) for (const t of wrap(meta, inner, style.fontSize - 1.5)) lines.push({ text: t, size: style.fontSize - 1.5, bold: false, dim: true });
  if (style.description && el.description) {
    for (const t of wrap(el.description, inner, style.fontSize - 1)) lines.push({ text: t, size: style.fontSize - 1, bold: false });
  }
  return lines;
}

const lineHeight = (l: TextLine): number => Math.round(l.size * 1.3);

/** The box an edge label occupies. */
function labelSize(label: string[], fontSize: number): { w: number; h: number } {
  if (label.length === 0) return { w: 0, h: 0 };
  return { w: Math.max(...label.map((l) => textWidth(l, fontSize))) + 10, h: label.length * Math.round(fontSize * 1.3) + 6 };
}

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------

interface Box {
  el: Element;
  style: Style;
  lines: TextLine[];
  width: number;
  height: number;
  compound: boolean;
}

function shapeInsets(shape: string): { top: number } {
  if (shape === "Person") return { top: 46 };
  if (shape === "Cylinder") return { top: 20 };
  if (shape === "WebBrowser") return { top: 22 };
  return { top: 12 };
}

function measure(ws: Workspace, el: Element, dark: boolean): Box {
  const style = resolveElementStyle(ws, el, dark);
  const width = style.width ?? 230;
  const lines = nodeText(ws, el, style, width);
  const textH = lines.reduce((h, l) => h + lineHeight(l), 0) + Math.max(0, lines.length - 1) * 2;
  let height = shapeInsets(style.shape).top + textH + 14;
  height = Math.max(height, style.height ?? (style.shape === "Person" ? 130 : 96));
  let w = width;
  if (style.shape === "Circle") w = height = Math.max(w, height);
  return { el, style, lines, width: w, height, compound: false };
}

export function viewTitle(ws: Workspace, view: View, scope: Element | undefined): { title: string; subtitle: string } {
  const kind: Record<string, string> = {
    systemLandscape: "System Landscape", systemContext: "System Context", container: "Container", component: "Component",
    dynamic: "Dynamic", deployment: "Deployment", custom: "Custom", filtered: "Filtered", image: "Image",
  };
  const base = view.title ?? `[${kind[view.type] ?? view.type}]${scope ? ` ${scope.name}` : ""}${view.environment ? ` - ${view.environment}` : ""}`;
  return { title: base, subtitle: view.description };
}

export function renderView(ws: Workspace, key: string, options: RenderOptions = {}): RenderedView | undefined {
  const view = ws.views.find((v) => v.key === key);
  if (!view) return undefined;
  const dark = options.dark ?? false;
  const textColor = dark ? "#e6e6e6" : "#333333";
  const canvas = options.transparent ? undefined : dark ? "#1e1e1e" : "#ffffff";
  const labelBg = dark ? "#1e1e1e" : "#ffffff";

  const elements = new Map(ws.model.elements.map((e) => [e.id, e]));
  const relationships = new Map(ws.model.relationships.map((r) => [r.id, r]));
  const scope = view.scopeId ? elements.get(view.scopeId) : undefined;
  const { title, subtitle } = viewTitle(ws, view, scope);
  const showTitle = options.title !== false;
  const titleBlock = showTitle ? TITLE_HEIGHT : 0;

  const empty = (message: string): RenderedView => {
    const width = 520;
    const height = titleBlock + MARGIN * 2 + 30;
    const body = `<text x="${MARGIN}" y="${titleBlock + MARGIN + 10}" font-size="13" fill="${textColor}">${esc(message)}</text>`;
    const svg = open(width, height, canvas) + (showTitle ? titleSvg(title, subtitle, textColor) : "") + body + "</svg>";
    return { svg, width, height, nodes: [], edges: [] };
  };

  if (view.type === "image") return empty(`Image view: ${view.image ? `${view.image.kind} ${view.image.source}` : "no image source"} (rendered by the tool that owns the image)`);
  const inView = view.elements.map((id) => elements.get(id)).filter((e): e is Element => e !== undefined);
  if (inView.length === 0) return empty("This view is empty.");

  // ---- boxes and the nesting used for layout ----------------------------------------------------
  const boxes = new Map<string, Box>();
  for (const el of inView) boxes.set(el.id, measure(ws, el, dark));
  const present = new Set(boxes.keys());

  const hierarchy = viewHierarchy(ws, view);
  const { roots: rootsEls, children: kids, boundaryChildren: boundaryKids } = hierarchy;
  const groupedByScope = scope !== undefined && boundaryKids.length > 0;
  const boundaryId = scope ? `boundary:${scope.id}` : "";
  const BOUNDARY_PAD = 20;
  const BOUNDARY_HEADER = 40;

  const compoundNode = (b: Box, children: LNode[]): LNode => {
    b.compound = true;
    const labelW = Math.max(...b.lines.map((l) => textWidth(l.text, l.size, l.bold))) + 2 * BOUNDARY_PAD;
    const headerLines = b.lines.slice(0, 2);
    const header = headerLines.reduce((h, l) => h + lineHeight(l), 0) + 14;
    return { id: b.el.id, width: Math.max(labelW, 140), height: 60, padding: BOUNDARY_PAD, header: Math.max(BOUNDARY_HEADER, header), children };
  };
  const toNode = (el: Element): LNode => {
    const b = boxes.get(el.id)!;
    const sub = kids.get(el.id);
    if (sub?.length) return compoundNode(b, sub.map(toNode));
    return { id: el.id, width: b.width, height: b.height };
  };
  const roots: LNode[] = rootsEls.map(toNode);

  let boundaryLabel: TextLine[] = [];
  if (groupedByScope && boundaryKids.length > 0) {
    boundaryLabel = [
      { text: scope!.name, size: 13, bold: true },
      ...(metadataText(ws, scope!) ? [{ text: metadataText(ws, scope!)!, size: 10.5, bold: false, dim: true }] : []),
    ];
    const labelW = Math.max(...boundaryLabel.map((l) => textWidth(l.text, l.size, l.bold))) + 2 * BOUNDARY_PAD;
    roots.unshift({
      id: boundaryId,
      width: Math.max(labelW, 140),
      height: 60,
      padding: BOUNDARY_PAD,
      header: Math.max(BOUNDARY_HEADER, boundaryLabel.reduce((h, l) => h + lineHeight(l), 0) + 14),
      children: boundaryKids.map(toNode),
    });
  }

  // ---- edges -------------------------------------------------------------------------------
  interface DrawEdge {
    layoutId: string;
    relId: string;
    from: string;
    to: string;
    order?: string;
    label: string[];
    style: LineStyle;
  }
  const labelFor = (rel: Relationship, description: string | undefined, technology: string | undefined, order: string | undefined, style: LineStyle): string[] => {
    const lines: string[] = [];
    const d = description ?? rel.description;
    const t = technology ?? rel.technology;
    const text = `${order ? `${order.replace(/:$/, "")}: ` : ""}${d}`.trim();
    if (text) lines.push(...wrap(text, style.labelWidth, style.fontSize));
    if (t) lines.push(...wrap(`[${t}]`, style.labelWidth, style.fontSize - 1));
    return lines;
  };
  const drawEdges: DrawEdge[] = [];
  for (const e of viewEdges(ws, view)) {
    const rel = relationships.get(e.relationshipId);
    if (!rel) continue;
    const style = resolveRelationshipStyle(ws, rel, dark);
    drawEdges.push({
      layoutId: e.key, relId: rel.id, from: e.from, to: e.to,
      ...(e.order ? { order: e.order } : {}),
      label: labelFor(rel, e.description, e.technology, e.order, style),
      style,
    });
  }
  const usable = drawEdges;

  // parallel edges between the same two boxes are fanned out
  const pairs = new Map<string, DrawEdge[]>();
  for (const e of usable) {
    const k = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    (pairs.get(k) ?? pairs.set(k, []).get(k)!).push(e);
  }

  // ---- layout ----------------------------------------------------------------------------------
  const auto = view.autoLayout;
  const direction: Direction = auto?.direction ?? "tb";
  const horizontal = direction === "lr" || direction === "rl";
  // layers must be far enough apart for the widest (left/right layouts) or tallest (top/bottom) edge label
  const labelRoom =
    Math.max(
      0,
      ...[...pairs.values()].map((group) => {
        const sizes = group.map((e) => labelSize(e.label, e.style.fontSize));
        return horizontal ? Math.max(...sizes.map((l) => l.w)) : sizes.reduce((sum, l) => sum + l.h, 0);
      }),
    ) + 50;
  const rankSep = Math.max(50, labelRoom, 80 * ((auto?.rankSeparation ?? 300) / 300));
  const nodeSep = Math.max(40, 50 * ((auto?.nodeSeparation ?? 300) / 300));
  const ledges: LEdge[] = usable.filter((e) => e.from !== e.to).map((e) => ({ id: e.layoutId, from: e.from, to: e.to }));
  const result = layout(roots, ledges, { direction, rankSep, nodeSep });

  const ox = MARGIN;
  const oy = MARGIN + titleBlock;
  const rect = (id: string): Rect => {
    const r = result.nodes.get(id)!;
    return { x: r.x + ox, y: r.y + oy, width: r.width, height: r.height };
  };

  // ---- edge geometry ---------------------------------------------------------------------------
  const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const clip = (r: Rect, towards: Point): Point => {
    const c = centre(r);
    const dx = towards.x - c.x;
    const dy = towards.y - c.y;
    if (dx === 0 && dy === 0) return c;
    const t = Math.min(dx !== 0 ? r.width / 2 / Math.abs(dx) : Infinity, dy !== 0 ? r.height / 2 / Math.abs(dy) : Infinity);
    return { x: c.x + dx * t, y: c.y + dy * t };
  };

  const paths = new Map<DrawEdge, Point[]>();
  const startAt = new Map<DrawEdge, number>(); // where along the edge its label first tries to sit
  for (const group of pairs.values()) {
    group.forEach((e, i) => {
      startAt.set(e, group.length > 1 ? 0.5 + (i - (group.length - 1) / 2) * 0.16 : e.style.position / 100);
      const a = rect(e.from);
      const b = rect(e.to);
      if (e.from === e.to) {
        const r = a;
        const y = r.y + r.height / 2 + (i - (group.length - 1) / 2) * 18;
        paths.set(e, [{ x: r.x + r.width, y: y - 8 }, { x: r.x + r.width + 34, y: y - 8 }, { x: r.x + r.width + 34, y: y + 8 }, { x: r.x + r.width, y: y + 8 }]);
        return;
      }
      const [first, second] = e.from < e.to ? [a, b] : [b, a];
      const c1 = centre(first), c2 = centre(second);
      const len = Math.hypot(c2.x - c1.x, c2.y - c1.y) || 1;
      const spacing = horizontal ? Math.max(20, Math.max(...group.map((g) => labelSize(g.label, g.style.fontSize).h)) + 4) : 20;
      const off = (i - (group.length - 1) / 2) * spacing;
      const nx = (-(c2.y - c1.y) / len) * off;
      const ny = ((c2.x - c1.x) / len) * off;
      const mids = (result.waypoints.get(e.layoutId) ?? []).map((p) => ({ x: p.x + ox + nx, y: p.y + oy + ny }));
      const ca = centre(a), cb = centre(b);
      // aim at the next point (already offset) from the offset centre, so parallel lines stay parallel
      const from = { x: ca.x + nx, y: ca.y + ny };
      const to = { x: cb.x + nx, y: cb.y + ny };
      const start = clip({ ...a, x: a.x + nx, y: a.y + ny }, mids[0] ?? to);
      const end = clip({ ...b, x: b.x + nx, y: b.y + ny }, mids[mids.length - 1] ?? from);
      paths.set(e, [start, ...mids, end]);
    });
  }

  // ---- canvas size -------------------------------------------------------------------------------
  let width = result.width + 2 * MARGIN;
  let height = result.height + 2 * MARGIN + titleBlock;
  for (const pts of paths.values()) for (const p of pts) (width = Math.max(width, p.x + MARGIN)), (height = Math.max(height, p.y + MARGIN));
  width = Math.max(width, 360);

  // ---- drawing ----------------------------------------------------------------------------------
  const out: string[] = [open(width, height, canvas)];
  const colours = new Set(usable.map((e) => e.style.color));
  out.push("<defs>");
  for (const c of colours) {
    out.push(`<marker id="${markerId(c)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${esc(c)}"/></marker>`);
  }
  out.push("</defs>");
  if (showTitle) out.push(titleSvg(title, subtitle, textColor));

  const renderedNodes: RenderedNode[] = [];

  // boundaries and compound deployment nodes first (behind everything)
  if (roots.some((r) => r.id === boundaryId)) {
    const r = rect(boundaryId);
    renderedNodes.push({ id: boundaryId, kind: "boundary", ...r });
    out.push(`<g class="boundary" data-id="${esc(scope!.id)}"><rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.width)}" height="${num(r.height)}" rx="6" fill="none" stroke="${dark ? "#aaaaaa" : "#444444"}" stroke-width="1" stroke-dasharray="8 5"/>`);
    out.push(textBlock(boundaryLabel, r.x + 12, r.y + 12, "start", textColor) + "</g>");
  }
  // draw outer compounds before inner ones
  const compoundsInOrder: Element[] = [];
  const collect = (el: Element): void => {
    if (kids.get(el.id)?.length) {
      compoundsInOrder.push(el);
      for (const c of kids.get(el.id)!) collect(c);
    }
  };
  rootsEls.forEach(collect);
  for (const el of compoundsInOrder) {
    const b = boxes.get(el.id)!;
    const r = rect(el.id);
    renderedNodes.push({ id: el.id, kind: "element", ...r });
    out.push(`<g class="node compound" data-id="${esc(el.id)}"><rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.width)}" height="${num(r.height)}" rx="6" fill="${esc(b.style.background)}" fill-opacity="${dark ? 0.35 : 0.6}" stroke="${esc(b.style.stroke)}" stroke-width="${num(b.style.strokeWidth)}"${dashAttr(b.style.border)}/>`);
    out.push(textBlock(b.lines.slice(0, 2), r.x + 12, r.y + 10, "start", dark ? textColor : b.style.color) + "</g>");
  }

  // edges
  const labelsOut: string[] = [];
  const obstacles: Rect[] = inView.filter((el) => !kids.get(el.id)?.length).map((el) => rect(el.id));
  const placed: Rect[] = [];
  const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width + 2 && b.x < a.x + a.width + 2 && a.y < b.y + b.height + 2 && b.y < a.y + a.height + 2;
  for (const e of usable) {
    const pts = paths.get(e)!;
    const dash = e.style.dash ? ` stroke-dasharray="${e.style.dash}"` : "";
    const op = e.style.opacity < 100 ? ` opacity="${e.style.opacity / 100}"` : "";
    out.push(
      `<g class="edge" data-rel="${esc(e.relId)}"${e.order ? ` data-order="${esc(e.order)}"` : ""}><polyline points="${pts.map((p) => `${num(p.x)},${num(p.y)}`).join(" ")}" fill="none" stroke="${esc(e.style.color)}" stroke-width="${num(e.style.thickness)}"${dash}${op} marker-end="url(#${markerId(e.style.color)})"/></g>`,
    );
    if (e.label.length) {
      const { w, h } = labelSize(e.label, e.style.fontSize);
      let at: Point;
      if (e.from === e.to) {
        const x = pts[1]!.x + w / 2 + 4;
        const y0 = (pts[1]!.y + pts[2]!.y) / 2;
        at = { x, y: y0 };
        for (const dy of [0, h + 2, -(h + 2), 2 * (h + 2), -2 * (h + 2)]) {
          const box = { x: x - w / 2, y: y0 + dy - h / 2, width: w, height: h };
          if (![...obstacles, ...placed].some((o) => overlaps(box, o))) {
            at = { x, y: y0 + dy };
            break;
          }
        }
      } else {
        // try the preferred spot, then nearby ones, taking the first that clears every box and label
        const base = startAt.get(e) ?? 0.5;
        const tries = [0, 0.12, -0.12, 0.24, -0.24, 0.36, -0.36].map((d) => Math.min(0.88, Math.max(0.12, base + d)));
        at = pointAlong(pts, tries[0]!);
        for (const t of tries) {
          const p = pointAlong(pts, t);
          const box = { x: p.x - w / 2, y: p.y - h / 2, width: w, height: h };
          if (![...obstacles, ...placed].some((o) => overlaps(box, o))) {
            at = p;
            break;
          }
        }
      }
      placed.push({ x: at.x - w / 2, y: at.y - h / 2, width: w, height: h });
      const rows = e.label
        .map((l, i) => `<text x="${num(at.x)}" y="${num(at.y - h / 2 + 4 + (i + 0.8) * Math.round(e.style.fontSize * 1.3))}" text-anchor="middle" font-size="${num(i === 0 || !l.startsWith("[") ? e.style.fontSize : e.style.fontSize - 1)}" fill="${esc(e.style.color === "#707070" ? textColor : e.style.color)}">${esc(l)}</text>`)
        .join("");
      labelsOut.push(`<g class="edge-label" data-rel="${esc(e.relId)}"><rect x="${num(at.x - w / 2)}" y="${num(at.y - h / 2)}" width="${num(w)}" height="${num(h)}" rx="3" fill="${labelBg}" fill-opacity="0.85"/>${rows}</g>`);
    }
  }

  // leaf elements
  for (const el of inView) {
    if (kids.get(el.id)?.length) continue;
    const b = boxes.get(el.id)!;
    const r = rect(el.id);
    renderedNodes.push({ id: el.id, kind: "element", ...r });
    out.push(`<g class="node" data-id="${esc(el.id)}">${shapeSvg(b.style, r)}${textBlockFor(b, r)}</g>`);
  }
  out.push(...labelsOut);
  out.push("</svg>");

  return {
    svg: out.join("\n"),
    width,
    height,
    nodes: renderedNodes,
    edges: usable.map((e) => ({ id: e.relId, ...(e.order ? { order: e.order } : {}), points: paths.get(e)!.map((p) => ({ x: p.x, y: p.y })) })),
  };
}

// ---------------------------------------------------------------------------
// svg pieces
// ---------------------------------------------------------------------------

function open(width: number, height: number, canvas: string | undefined): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}" width="${num(width)}" height="${num(height)}" font-family="Helvetica, Arial, sans-serif">` +
    (canvas ? `<rect width="100%" height="100%" fill="${canvas}"/>` : "")
  );
}

function titleSvg(title: string, subtitle: string, color: string): string {
  return (
    `<text x="${MARGIN}" y="${MARGIN + 6}" font-size="16" font-weight="bold" fill="${color}">${esc(title)}</text>` +
    (subtitle ? `<text x="${MARGIN}" y="${MARGIN + 24}" font-size="11.5" fill="${color}" fill-opacity="0.75">${esc(subtitle)}</text>` : "")
  );
}

const markerId = (c: string): string => "arrow-" + c.replace(/[^a-z0-9]/gi, "");
const dashAttr = (b: "solid" | "dashed" | "dotted"): string => (b === "dashed" ? ' stroke-dasharray="6 4"' : b === "dotted" ? ' stroke-dasharray="2 3"' : "");

/** A block of text lines starting at (x, top). */
function textBlock(lines: TextLine[], x: number, top: number, anchor: "start" | "middle", color: string): string {
  let y = top;
  const rows: string[] = [];
  for (const l of lines) {
    y += lineHeight(l);
    rows.push(
      `<text x="${num(x)}" y="${num(y - 3)}" text-anchor="${anchor}" font-size="${num(l.size)}"${l.bold ? ' font-weight="bold"' : ""}${l.dim ? ' fill-opacity="0.85"' : ""} fill="${esc(color)}">${esc(l.text)}</text>`,
    );
    y += 2;
  }
  return rows.join("");
}

function textBlockFor(b: Box, r: Rect): string {
  const top = r.y + shapeInsets(b.style.shape).top;
  const lineTotal = b.lines.reduce((h, l) => h + lineHeight(l), 0) + Math.max(0, b.lines.length - 1) * 2;
  const avail = r.height - shapeInsets(b.style.shape).top - 8;
  const start = top + Math.max(0, (avail - lineTotal) / 2);
  return textBlock(b.lines, r.x + r.width / 2, start, "middle", b.style.color);
}

function shapeSvg(s: Style, r: Rect): string {
  const { x, y, width: w, height: h } = r;

  const cx = x + w / 2;
  const cy = y + h / 2;

  const common =
    `fill="${esc(s.background)}" ` +
    `stroke="${esc(s.stroke)}" ` +
    `stroke-width="${num(s.strokeWidth)}"` +
    `${dashAttr(s.border)}` +
    `${s.opacity < 100 ? ` opacity="${num(s.opacity / 100)}"` : ""}`;

  const line =
    `fill="none" ` +
    `stroke="${esc(s.stroke)}" ` +
    `stroke-width="${num(s.strokeWidth)}"`;

  const thinLine =
    `fill="none" ` +
    `stroke="${esc(s.stroke)}" ` +
    `stroke-width="${num(Math.max(1, s.strokeWidth / 2))}"`;

  const dot = `fill="${esc(s.stroke)}"`;

  switch (s.shape) {
    case "Box":
      return (
        `<rect x="${num(x)}" y="${num(y)}" ` +
        `width="${num(w)}" height="${num(h)}" ${common}/>`
      );

    case "RoundedBox": {
      const radius = Math.min(w, h) * 0.08;

      return (
        `<rect x="${num(x)}" y="${num(y)}" ` +
        `width="${num(w)}" height="${num(h)}" ` +
        `rx="${num(radius)}" ry="${num(radius)}" ${common}/>`
      );
    }

    case "Circle": {
      const radius = Math.min(w, h) / 2;

      return (
        `<circle cx="${num(cx)}" cy="${num(cy)}" ` +
        `r="${num(radius)}" ${common}/>`
      );
    }

    case "Ellipse":
      return (
        `<ellipse cx="${num(cx)}" cy="${num(cy)}" ` +
        `rx="${num(w / 2)}" ry="${num(h / 2)}" ${common}/>`
      );

    case "Hexagon": {
      const inset = Math.min(w * 0.2, h * 0.5);

      const points: Point[] = [
        { x: x + inset, y },
        { x: x + w - inset, y },
        { x: x + w, y: cy },
        { x: x + w - inset, y: y + h },
        { x: x + inset, y: y + h },
        { x, y: cy },
      ];

      return (
        `<polygon points="${points
          .map((point) => `${num(point.x)},${num(point.y)}`)
          .join(" ")}" ${common}/>`
      );
    }

    case "Diamond":
      return (
        `<polygon points="` +
        `${num(cx)},${num(y)} ` +
        `${num(x + w)},${num(cy)} ` +
        `${num(cx)},${num(y + h)} ` +
        `${num(x)},${num(cy)}` +
        `" ${common}/>`
      );

    case "Cylinder": {
      const capHeight = Math.min(h * 0.16, w * 0.16);
      const topY = y + capHeight;
      const bottomY = y + h - capHeight;

      return (
        `<path d="` +
          `M ${num(x)} ${num(topY)} ` +
          `A ${num(w / 2)} ${num(capHeight)} 0 0 1 ` +
          `${num(x + w)} ${num(topY)} ` +
          `L ${num(x + w)} ${num(bottomY)} ` +
          `A ${num(w / 2)} ${num(capHeight)} 0 0 1 ` +
          `${num(x)} ${num(bottomY)} ` +
          `Z" ${common}/>` +
        `<path d="` +
          `M ${num(x)} ${num(topY)} ` +
          `A ${num(w / 2)} ${num(capHeight)} 0 0 0 ` +
          `${num(x + w)} ${num(topY)}` +
          `" ${line}/>`
      );
    }

    case "Pipe": {
      const capWidth = Math.min(w * 0.16, h * 0.25);
      const leftX = x + capWidth;
      const rightX = x + w - capWidth;

      return (
        `<path d="` +
          `M ${num(leftX)} ${num(y)} ` +
          `L ${num(rightX)} ${num(y)} ` +
          `A ${num(capWidth)} ${num(h / 2)} 0 0 1 ` +
          `${num(rightX)} ${num(y + h)} ` +
          `L ${num(leftX)} ${num(y + h)} ` +
          `A ${num(capWidth)} ${num(h / 2)} 0 0 1 ` +
          `${num(leftX)} ${num(y)} ` +
          `Z" ${common}/>` +
        `<path d="` +
          `M ${num(leftX)} ${num(y)} ` +
          `A ${num(capWidth)} ${num(h / 2)} 0 0 1 ` +
          `${num(leftX)} ${num(y + h)}` +
          `" ${line}/>`
      );
    }

    case "Person": {
      const size = Math.min(w, h);
      const ix = x + (w - size) / 2;
      const iy = y + (h - size) / 2;

      const headRadius = size / 6;
      const headCx = ix + size / 2;
      const headCy = iy + headRadius;

      // Ensure the body and head overlap enough to avoid an SVG seam.
      const overlap = Math.max(1, s.strokeWidth);

      const bodyTop = headCy + headRadius - overlap;
      const bodyBottom = iy + size * 0.94;
      const bodyHeight = Math.max(0, bodyBottom - bodyTop);
      const bodyRadius = size * 0.16;

      const armTop = bodyTop + bodyHeight * 0.45;
      const leftArmX = ix + size / 5;
      const rightArmX = ix + size - size / 5;

      return (
        `<rect x="${num(ix)}" y="${num(bodyTop)}" ` +
          `width="${num(size)}" height="${num(bodyHeight)}" ` +
          `rx="${num(bodyRadius)}" ry="${num(bodyRadius)}" ` +
          `${common}/>` +
        `<circle cx="${num(headCx)}" cy="${num(headCy)}" ` +
          `r="${num(headRadius)}" ${common}/>` +
        `<line x1="${num(leftArmX)}" y1="${num(armTop)}" ` +
          `x2="${num(leftArmX)}" y2="${num(bodyBottom)}" ` +
          `${thinLine}${dashAttr(s.border)}/>` +
        `<line x1="${num(rightArmX)}" y1="${num(armTop)}" ` +
          `x2="${num(rightArmX)}" y2="${num(bodyBottom)}" ` +
          `${thinLine}${dashAttr(s.border)}/>`
      );
    }

    case "Robot": {
      const size = Math.min(w, h);
      const ix = x + (w - size) / 2;
      const iy = y + (h - size) / 2;

      // The robot head occupies one third of the icon width.
      const headSize = size / 3;
      const headX = ix + (size - headSize) / 2;
      const headY = iy;

      const earWidth = size / 1.8;
      const earHeight = size / 10;
      const earX = ix + (size - earWidth) / 2;
      const earY = headY + (headSize - earHeight) / 2;

      // Ensure the body and head overlap enough to avoid an SVG seam.
      const overlap = Math.max(1, s.strokeWidth);

      const bodyTop = headY + headSize - overlap;
      const bodyBottom = iy + size * 0.94;
      const bodyHeight = Math.max(0, bodyBottom - bodyTop);
      const bodyRadius = size * 0.12;

      const armTop = bodyTop + bodyHeight * 0.45;
      const leftArmX = ix + size / 5;
      const rightArmX = ix + size - size / 5;

      return (
        `<rect x="${num(ix)}" y="${num(bodyTop)}" ` +
          `width="${num(size)}" height="${num(bodyHeight)}" ` +
          `rx="${num(bodyRadius)}" ry="${num(bodyRadius)}" ` +
          `${common}/>` +
        `<rect x="${num(earX)}" y="${num(earY)}" ` +
          `width="${num(earWidth)}" height="${num(earHeight)}" ` +
          `rx="${num(earHeight / 2)}" ry="${num(earHeight / 2)}" ` +
          `${common}/>` +
        `<rect x="${num(headX)}" y="${num(headY)}" ` +
          `width="${num(headSize)}" height="${num(headSize)}" ` +
          `rx="${num(headSize * 0.2)}" ` +
          `ry="${num(headSize * 0.2)}" ${common}/>` +
        `<line x1="${num(leftArmX)}" y1="${num(armTop)}" ` +
          `x2="${num(leftArmX)}" y2="${num(bodyBottom)}" ` +
          `${thinLine}${dashAttr(s.border)}/>` +
        `<line x1="${num(rightArmX)}" y1="${num(armTop)}" ` +
          `x2="${num(rightArmX)}" y2="${num(bodyBottom)}" ` +
          `${thinLine}${dashAttr(s.border)}/>`
      );
    }

    case "Folder": {
      const tabWidth = Math.min(w * 0.4, h * 0.9);
      const tabHeight = Math.min(h * 0.18, tabWidth * 0.35);
      const shoulder = Math.min(w * 0.06, tabHeight * 0.6);

      return (
        `<path d="` +
          `M ${num(x)} ${num(y + h)} ` +
          `L ${num(x)} ${num(y)} ` +
          `L ${num(x + tabWidth)} ${num(y)} ` +
          `L ${num(x + tabWidth + shoulder)} ${num(y + tabHeight)} ` +
          `L ${num(x + w)} ${num(y + tabHeight)} ` +
          `L ${num(x + w)} ${num(y + h)} ` +
          `Z" ${common} stroke-linejoin="round"/>`
      );
    }

    case "WebBrowser": {
      const radius = Math.min(w, h) * 0.025;
      const headerHeight = Math.min(h * 0.18, 24);
      const dotRadius = Math.max(2, headerHeight * 0.12);
      const dotGap = dotRadius * 3;
      const dotStartX = x + dotGap;

      return (
        `<rect x="${num(x)}" y="${num(y)}" ` +
          `width="${num(w)}" height="${num(h)}" ` +
          `rx="${num(radius)}" ry="${num(radius)}" ${common}/>` +
        `<line x1="${num(x)}" y1="${num(y + headerHeight)}" ` +
          `x2="${num(x + w)}" y2="${num(y + headerHeight)}" ` +
          `${thinLine}/>` +
        [0, 1, 2]
          .map(
            (i: number): string =>
              `<circle cx="${num(dotStartX + i * dotGap)}" ` +
              `cy="${num(y + headerHeight / 2)}" ` +
              `r="${num(dotRadius)}" ${dot}/>`
          )
          .join("")
      );
    }

    case "Window": {
      const radius = Math.min(w, h) * 0.025;
      const headerHeight = Math.min(h * 0.18, 24);
      const buttonSize = Math.max(5, headerHeight * 0.35);
      const buttonGap = buttonSize * 0.55;
      const rightPadding = buttonSize;

      return (
        `<rect x="${num(x)}" y="${num(y)}" ` +
          `width="${num(w)}" height="${num(h)}" ` +
          `rx="${num(radius)}" ry="${num(radius)}" ${common}/>` +
        `<line x1="${num(x)}" y1="${num(y + headerHeight)}" ` +
          `x2="${num(x + w)}" y2="${num(y + headerHeight)}" ` +
          `${thinLine}/>` +
        [0, 1, 2]
          .map((i: number): string => {
            const bx =
              x +
              w -
              rightPadding -
              buttonSize -
              i * (buttonSize + buttonGap);

            const by = y + (headerHeight - buttonSize) / 2;

            return (
              `<rect x="${num(bx)}" y="${num(by)}" ` +
              `width="${num(buttonSize)}" height="${num(buttonSize)}" ` +
              `${thinLine}/>`
            );
          })
          .join("")
      );
    }

    case "MobileDevicePortrait": {
      const radius = Math.min(w, h) * 0.08;
      const topArea = Math.min(h * 0.12, w * 0.22);
      const bottomArea = Math.min(h * 0.14, w * 0.26);
      const speakerWidth = Math.min(w * 0.25, topArea);
      const buttonRadius = Math.min(w, bottomArea) * 0.22;

      return (
        `<rect x="${num(x)}" y="${num(y)}" ` +
          `width="${num(w)}" height="${num(h)}" ` +
          `rx="${num(radius)}" ry="${num(radius)}" ${common}/>` +
        `<line x1="${num(x)}" y1="${num(y + topArea)}" ` +
          `x2="${num(x + w)}" y2="${num(y + topArea)}" ` +
          `${thinLine}/>` +
        `<line x1="${num(x)}" y1="${num(y + h - bottomArea)}" ` +
          `x2="${num(x + w)}" y2="${num(y + h - bottomArea)}" ` +
          `${thinLine}/>` +
        `<line x1="${num(cx - speakerWidth / 2)}" ` +
          `y1="${num(y + topArea / 2)}" ` +
          `x2="${num(cx + speakerWidth / 2)}" ` +
          `y2="${num(y + topArea / 2)}" ` +
          `${thinLine} stroke-linecap="round"/>` +
        `<circle cx="${num(cx)}" ` +
          `cy="${num(y + h - bottomArea / 2)}" ` +
          `r="${num(buttonRadius)}" ${thinLine}/>`
      );
    }

    case "MobileDeviceLandscape": {
      const radius = Math.min(w, h) * 0.08;
      const leftArea = Math.min(w * 0.12, h * 0.22);
      const rightArea = Math.min(w * 0.14, h * 0.26);
      const speakerHeight = Math.min(h * 0.25, leftArea);
      const buttonRadius = Math.min(h, rightArea) * 0.22;

      return (
        `<rect x="${num(x)}" y="${num(y)}" ` +
          `width="${num(w)}" height="${num(h)}" ` +
          `rx="${num(radius)}" ry="${num(radius)}" ${common}/>` +
        `<line x1="${num(x + leftArea)}" y1="${num(y)}" ` +
          `x2="${num(x + leftArea)}" y2="${num(y + h)}" ` +
          `${thinLine}/>` +
        `<line x1="${num(x + w - rightArea)}" y1="${num(y)}" ` +
          `x2="${num(x + w - rightArea)}" y2="${num(y + h)}" ` +
          `${thinLine}/>` +
        `<line x1="${num(x + leftArea / 2)}" ` +
          `y1="${num(cy - speakerHeight / 2)}" ` +
          `x2="${num(x + leftArea / 2)}" ` +
          `y2="${num(cy + speakerHeight / 2)}" ` +
          `${thinLine} stroke-linecap="round"/>` +
        `<circle cx="${num(x + w - rightArea / 2)}" ` +
          `cy="${num(cy)}" r="${num(buttonRadius)}" ` +
          `${thinLine}/>`
      );
    }

    case "Component": {
      const radius = Math.min(w, h) * 0.025;
      const tabWidth = Math.min(w * 0.12, h * 0.22);
      const tabHeight = Math.min(h * 0.14, tabWidth * 0.55);
      const tabX = x - tabWidth / 2;

      const upperTabY = y + h * 0.28;
      const lowerTabY = y + h * 0.58;

      return (
        `<rect x="${num(x)}" y="${num(y)}" ` +
          `width="${num(w)}" height="${num(h)}" ` +
          `rx="${num(radius)}" ry="${num(radius)}" ${common}/>` +
        `<rect x="${num(tabX)}" y="${num(upperTabY)}" ` +
          `width="${num(tabWidth)}" height="${num(tabHeight)}" ` +
          `${common}/>` +
        `<rect x="${num(tabX)}" y="${num(lowerTabY)}" ` +
          `width="${num(tabWidth)}" height="${num(tabHeight)}" ` +
          `${common}/>`
      );
    }

    default:
      return (
        `<rect x="${num(x)}" y="${num(y)}" ` +
        `width="${num(w)}" height="${num(h)}" ${common}/>`
      );
  }
}

/** The point at fraction t of the polyline's length. */
function pointAlong(points: Point[], t: number): Point {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    lengths.push(l);
    total += l;
  }
  let target = total * Math.min(1, Math.max(0, t));
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i]! || i === lengths.length - 1) {
      const f = lengths[i]! === 0 ? 0 : Math.min(1, target / lengths[i]!);
      return { x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * f, y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * f };
    }
    target -= lengths[i]!;
  }
  return points[0]!;
}

export function listViews(ws: Workspace): Array<{ key: string; title: string; type: string; isDefault: boolean }> {
  const elements = new Map(ws.model.elements.map((e) => [e.id, e]));
  return ws.views.map((v) => ({
    key: v.key,
    title: viewTitle(ws, v, v.scopeId ? elements.get(v.scopeId) : undefined).title,
    type: v.type,
    isDefault: v.isDefault,
  }));
}
