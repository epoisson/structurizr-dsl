import type { Element, View, Workspace } from "../../core/src/index.ts";
import { metadataText, resolveElementStyle, resolveRelationshipStyle, viewEdges, viewHierarchy, viewTitle } from "../../viewer/src/index.ts";
import { c4Document } from "./c4.ts";
import { createAliases, elementOf, hashColour, quoted, variantOf } from "./common.ts";
import type { ExportedView } from "./common.ts";

/**
 * PlantUML export.
 *
 *   c4     (default) uses PlantUML's bundled C4 standard library (`!include <C4/C4_Container>`, ...): it renders as a
 *          proper C4 diagram and needs no network. Your element/relationship styles become AddElementTag / AddRelTag.
 *   basic  plain PlantUML (rectangles, actors, databases) with the resolved colours written out, for setups that
 *          cannot use the C4 library.
 *
 * Double quotes in text become apostrophes (PlantUML macro arguments cannot hold them).
 */

export type PlantUMLFlavor = "c4" | "basic";

export interface PlantUMLOptions {
  flavor?: PlantUMLFlavor;
}

export function exportPlantUML(ws: Workspace, key: string, options: PlantUMLOptions = {}): string | undefined {
  const view = ws.views.find((v) => v.key === key);
  if (!view) return undefined;
  if (view.type === "image") return undefined;
  return (options.flavor ?? "c4") === "basic" ? basic(ws, view) : c4Document(ws, view, "plantuml");
}

export function exportAllPlantUML(ws: Workspace, options: PlantUMLOptions = {}): ExportedView[] {
  const out: ExportedView[] = [];
  for (const v of ws.views) {
    const content = exportPlantUML(ws, v.key, options);
    if (content !== undefined) out.push({ key: v.key, content });
  }
  return out;
}

const header = (ws: Workspace, view: View, flavor: string): string[] => {
  const scope = view.scopeId ? ws.model.elements.find((e) => e.id === view.scopeId) : undefined;
  const { title, subtitle } = viewTitle(ws, view, scope);
  return [`@startuml`, `' view: ${view.key} (${view.type}), flavor: ${flavor}`, ...(subtitle ? [`' ${quoted(subtitle).replace(/\\n/g, " ")}`] : []), `title ${quoted(title)}`];
};

// ---------------------------------------------------------------------------
// C4-PlantUML
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// plain PlantUML
// ---------------------------------------------------------------------------

function basic(ws: Workspace, view: View): string {
  const h = viewHierarchy(ws, view);
  const edges = viewEdges(ws, view);
  const alias = createAliases();
  const relById = new Map(ws.model.relationships.map((r) => [r.id, r]));

  // one stereotype per distinct look, so the skinparam block stays short
  const looks = new Map<string, { name: string; kind: string; bg: string; fg: string; stroke: string; border: string }>();
  const lookOf = (el: Element, kind: string): string => {
    const s = resolveElementStyle(ws, el, false);
    const sig = [kind, s.background, s.color, s.stroke, s.border].join("|");
    let l = looks.get(sig);
    if (!l) looks.set(sig, (l = { name: `s${looks.size + 1}`, kind, bg: s.background, fg: s.color, stroke: s.stroke, border: s.border }));
    return l.name;
  };

  const label = (el: Element): string => {
    const name = el.type === "deploymentNode" && el.instances && el.instances !== "1" ? `${el.name} (x${el.instances})` : el.name;
    const meta = metadataText(ws, el);
    const parts = [`<b>${quoted(name)}</b>`];
    if (meta) parts.push(`<size:10>${quoted(meta)}</size>`);
    if (el.description) parts.push("", quoted(el.description));
    return parts.join("\\n");
  };

  const lines: string[] = [];
  const emit = (el: Element, depth: number): void => {
    const pad = "  ".repeat(depth);
    const a = alias(el);
    const style = resolveElementStyle(ws, el, false);
    const v = variantOf(el, style.shape);
    const kids = h.children.get(el.id) ?? [];
    if (el.type === "deploymentNode" && kids.length > 0) {
      lines.push(`${pad}rectangle "${label(el)}" as ${a} <<${lookOf(el, "rectangle")}>> {`);
      kids.forEach((k) => emit(k, depth + 1));
      lines.push(`${pad}}`);
    } else if (el.type === "person") lines.push(`${pad}actor "${label(el)}" as ${a} <<${lookOf(el, "actor")}>>`);
    else if (v.database) lines.push(`${pad}database "${label(el)}" as ${a} <<${lookOf(el, "database")}>>`);
    else if (v.queue) lines.push(`${pad}queue "${label(el)}" as ${a} <<${lookOf(el, "queue")}>>`);
    else lines.push(`${pad}rectangle "${label(el)}" as ${a} <<${lookOf(el, "rectangle")}>>`);
  };

  h.roots.forEach((el) => emit(el, 0));
  if (h.scope && h.boundaryChildren.length > 0) {
    const meta = metadataText(ws, h.scope);
    lines.push(`rectangle "<b>${quoted(h.scope.name)}</b>${meta ? `\\n<size:10>${quoted(meta)}</size>` : ""}" as ${alias(h.scope)} <<boundary>> {`);
    h.boundaryChildren.forEach((el) => emit(el, 1));
    lines.push("}");
  }

  lines.push("");
  for (const e of edges) {
    const rel = relById.get(e.relationshipId)!;
    const s = resolveRelationshipStyle(ws, rel, false);
    const order = e.order ? `${e.order.replace(/:$/, "")}: ` : "";
    const text = [`${order}${quoted(e.description ?? rel.description)}`.trim(), quoted(e.technology ?? rel.technology) ? `[${quoted(e.technology ?? rel.technology)}]` : ""].filter(Boolean).join("\\n");
    const mods = [hashColour(s.color), s.dash ? (s.dash.startsWith("2") ? "dotted" : "dashed") : "", `thickness=${Math.max(1, Math.round(s.thickness))}`].filter(Boolean).join(",");
    lines.push(`${alias(elementOf(ws, e.from))} -[${mods}]-> ${alias(elementOf(ws, e.to))}${text ? ` : ${text}` : ""}`);
  }

  const skin: string[] = ["hide stereotype", "skinparam shadowing false", "skinparam rectangle<<boundary>> {", "  BorderStyle dashed", "  BackgroundColor transparent", "}"];
  for (const l of looks.values()) {
    // an actor's label sits outside the figure, on the page, so it must not use the (often white) in-box font colour
    skin.push(`skinparam ${l.kind}<<${l.name}>> {`, `  BackgroundColor ${hashColour(l.bg)}`, `  FontColor ${l.kind === "actor" ? "#333333" : hashColour(l.fg)}`, `  BorderColor ${hashColour(l.stroke)}`);
    if (l.border !== "solid") skin.push(`  BorderStyle ${l.border}`);
    skin.push("}");
  }
  const dir = view.autoLayout?.direction;
  const top = header(ws, view, "basic");
  return [...top, ...(dir === "lr" || dir === "rl" ? ["left to right direction"] : []), ...skin, "", ...lines, "@enduml", ""].join("\n");
}
