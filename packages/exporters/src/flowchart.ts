import type { Element, View, Workspace } from "../../core/src/index.ts";
import { metadataText, resolveElementStyle, resolveRelationshipStyle, viewEdges, viewHierarchy, viewTitle } from "../../viewer/src/index.ts";
import { createAliases, elementOf, hashColour, variantOf } from "./common.ts";

/**
 * Mermaid flowchart export: boxes, cylinders, stadiums; subgraphs for boundaries and nested deployment nodes;
 * `classDef` for element colours and `linkStyle` for relationship colours.
 *
 * Flowcharts render everywhere Mermaid does (GitHub, GitLab, docs sites) and get real automatic layout, which
 * Mermaid's C4 diagram types do not have.
 */

/** Words Mermaid's flowchart grammar treats as keywords; using one as a node id breaks the diagram. */
const RESERVED = new Set(["end", "graph", "subgraph", "flowchart", "class", "classdef", "style", "linkstyle", "click", "call", "href", "default", "direction", "interpolate"]);

/** Text for a quoted flowchart label: `#` and `&`, quotes and angle brackets would otherwise be read as entities or HTML. */
const esc = (s: string | undefined): string =>
  (s ?? "")
    .replace(/#/g, "#35;")
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/`/g, "#96;")
    .replace(/\r?\n/g, "<br/>")
    .trim();

export function flowchartDocument(ws: Workspace, view: View): string {
  const h = viewHierarchy(ws, view);
  const edges = viewEdges(ws, view);
  const alias = createAliases(RESERVED);
  const relById = new Map(ws.model.relationships.map((r) => [r.id, r]));
  const scopeEl = view.scopeId ? elementOf(ws, view.scopeId) : undefined;
  const { title, subtitle } = viewTitle(ws, view, scopeEl);

  // distinct looks become classes, so colours are written once
  const looks = new Map<string, { name: string; fill: string; stroke: string; color: string; dashed: boolean }>();
  const classMembers = new Map<string, string[]>();
  const classify = (id: string, el: Element): void => {
    const s = resolveElementStyle(ws, el, false);
    const sig = [s.background, s.stroke, s.color, s.border].join("|");
    let look = looks.get(sig);
    if (!look) looks.set(sig, (look = { name: `c${looks.size + 1}`, fill: s.background, stroke: s.stroke, color: s.color, dashed: s.border !== "solid" }));
    (classMembers.get(look.name) ?? classMembers.set(look.name, []).get(look.name)!).push(id);
  };

  const label = (el: Element): string => {
    const name = el.type === "deploymentNode" && el.instances && el.instances !== "1" ? `${el.name} (x${el.instances})` : el.name;
    const meta = metadataText(ws, el);
    const parts = [`<b>${esc(name)}</b>`];
    if (meta) parts.push(`<i>${esc(meta)}</i>`);
    if (el.description) parts.push("", esc(el.description));
    return parts.join("<br/>");
  };

  const lines: string[] = [];
  const styleLines: string[] = [];
  const node = (el: Element, pad: string): void => {
    const id = alias(el);
    const s = resolveElementStyle(ws, el, false);
    const v = variantOf(el, s.shape);
    const text = `"${label(el)}"`;
    let shape: string;
    if (el.type === "person" || s.shape === "Person") shape = `${id}([${text}])`;
    else if (v.database) shape = `${id}[(${text})]`;
    else if (v.queue) shape = `${id}[/${text}/]`;
    else if (s.shape === "RoundedBox") shape = `${id}(${text})`;
    else if (s.shape === "Circle" || s.shape === "Ellipse") shape = `${id}((${text}))`;
    else if (s.shape === "Hexagon") shape = `${id}{{${text}}}`;
    else if (s.shape === "Diamond") shape = `${id}{${text}}`;
    else shape = `${id}[${text}]`;
    lines.push(pad + shape);
    classify(id, el);
  };

  const emit = (el: Element, depth: number): void => {
    const pad = "  ".repeat(depth + 1);
    const kids = h.children.get(el.id) ?? [];
    if (el.type === "deploymentNode" && kids.length > 0) {
      const id = alias(el);
      lines.push(`${pad}subgraph ${id} ["${label(el)}"]`);
      kids.forEach((k) => emit(k, depth + 1));
      lines.push(`${pad}end`);
      classify(id, el);
    } else node(el, pad);
  };

  h.roots.forEach((el) => emit(el, 0));
  if (h.scope && h.boundaryChildren.length > 0) {
    const id = alias(h.scope);
    const meta = metadataText(ws, h.scope);
    lines.push(`  subgraph ${id} ["<b>${esc(h.scope.name)}</b>${meta ? `<br/><i>${esc(meta)}</i>` : ""}"]`);
    h.boundaryChildren.forEach((el) => emit(el, 1));
    lines.push("  end");
    styleLines.push(`  style ${id} fill:none,stroke:#444444,stroke-dasharray:6 4`);
  }

  // relationships
  const linkLooks = new Map<string, number[]>();
  const edgeLines: string[] = [];
  edges.forEach((e, i) => {
    const rel = relById.get(e.relationshipId)!;
    const s = resolveRelationshipStyle(ws, rel, false);
    const order = e.order ? `${e.order.replace(/:$/, "")}: ` : "";
    const desc = `${order}${esc(e.description ?? rel.description)}`.trim();
    const tech = esc(e.technology ?? rel.technology);
    const text = [desc, tech ? `[${tech}]` : ""].filter(Boolean).join("<br/>");
    const arrow = s.dash ? "-.->" : "-->";
    const from = alias(elementOf(ws, e.from));
    const to = alias(elementOf(ws, e.to));
    edgeLines.push(`  ${from} ${arrow}${text ? `|"${text}"|` : ""} ${to}`);
    const css = [`stroke:${hashColour(s.color)}`, `stroke-width:${Math.max(1, Math.round(s.thickness))}px`].join(",");
    (linkLooks.get(css) ?? linkLooks.set(css, []).get(css)!).push(i);
  });

  const classDefs = [...looks.values()].map(
    (l) => `  classDef ${l.name} fill:${hashColour(l.fill)},stroke:${hashColour(l.stroke)},color:${hashColour(l.color)}${l.dashed ? ",stroke-dasharray:5 5" : ""}`,
  );
  const classApply = [...classMembers.entries()].map(([name, ids]) => `  class ${ids.join(",")} ${name}`);
  const linkStyles = [...linkLooks.entries()].map(([css, idx]) => `  linkStyle ${idx.join(",")} ${css}`);

  const dir = ({ tb: "TB", bt: "BT", lr: "LR", rl: "RL" } as const)[view.autoLayout?.direction ?? "tb"];
  const quotedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "---",
    `title: "${quotedTitle}"`,
    "---",
    `flowchart ${dir}`,
    `  %% view: ${view.key} (${view.type}), flavor: flowchart`,
    ...(subtitle ? [`  %% ${subtitle.replace(/[\r\n]+/g, " ")}`] : []),
    ...lines,
    "",
    ...edgeLines,
    ...(classDefs.length ? ["", ...classDefs, ...classApply] : []),
    ...styleLines,
    ...linkStyles,
    "",
  ].join("\n");
}
