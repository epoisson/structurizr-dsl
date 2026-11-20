import type { Element, Relationship, View, Workspace } from "../../core/src/index.ts";
import { resolveElementStyle, viewEdges, viewHierarchy, viewTitle } from "../../viewer/src/index.ts";
import { createAliases, elementOf, hashColour, quoted, stylesOf, variantOf } from "./common.ts";

/**
 * The C4 emitter shared by the PlantUML (C4-PlantUML library) and Mermaid (C4 diagram types) exporters. Both use
 * the same macro names (Person, System, Container, Rel, ...), so one emitter serves both; the dialect decides how
 * the diagram is introduced and how user styles are expressed.
 */
export type C4Dialect = "plantuml" | "mermaid";

export function c4Document(ws: Workspace, view: View, dialect: C4Dialect): string {
  const mermaid = dialect === "mermaid";
  const h = viewHierarchy(ws, view);
  const edges = viewEdges(ws, view);
  const alias = createAliases();
  const relById = new Map(ws.model.relationships.map((r) => [r.id, r]));
  const styles = stylesOf(ws);
  const elementArgs = (s: (typeof styles.elements)[number]): string[] =>
    [
      s.background ? `$bgColor="${hashColour(s.background)}"` : "",
      s.color ? `$fontColor="${hashColour(s.color)}"` : "",
      s.stroke ? `$borderColor="${hashColour(s.stroke)}"` : "",
      s.border === "dashed" ? "$borderStyle=DashedLine()" : s.border === "dotted" ? "$borderStyle=DottedLine()" : "",
      s.strokeWidth ? `$borderThickness=${s.strokeWidth}` : "",
    ].filter(Boolean);
  const relationshipArgs = (s: (typeof styles.relationships)[number]): string[] =>
    [
      s.color ? `$textColor="${hashColour(s.color)}", $lineColor="${hashColour(s.color)}"` : "",
      s.style === "dashed" ? "$lineStyle=DashedLine()" : s.style === "dotted" ? "$lineStyle=DottedLine()" : "",
      s.thickness ? `$lineThickness=${s.thickness}` : "",
    ].filter(Boolean);
  // a tag is only worth declaring if its style sets something C4-PlantUML understands (a bare `shape` does not)
  const styledElementTags = new Map(styles.elements.filter((s) => elementArgs(s).length > 0).map((s) => [s.tag, s]));
  const styledRelTags = new Map(styles.relationships.filter((s) => relationshipArgs(s).length > 0).map((s) => [s.tag, s]));
  const usedElementTags = new Set<string>();
  const usedRelTags = new Set<string>();

  const safeTag = (t: string): boolean => !/[+"]/.test(t);
  const elementTags = (el: Element): string => {
    if (mermaid) return ""; // Mermaid's C4 has no tags; colours are set with UpdateElementStyle instead
    const tags = el.tags.filter((t) => styledElementTags.has(t) && safeTag(t));
    tags.forEach((t) => usedElementTags.add(t));
    return tags.length ? `, $tags="${tags.join("+")}"` : "";
  };
  const relTags = (r: Relationship): string => {
    if (mermaid) return "";
    const tags = r.tags.filter((t) => styledRelTags.has(t) && safeTag(t));
    tags.forEach((t) => usedRelTags.add(t));
    return tags.length ? `, $tags="${tags.join("+")}"` : "";
  };

  const macroFor = (base: "Person" | "System" | "Container" | "Component", el: Element): string => {
    const v = variantOf(el, resolveElementStyle(ws, el, false).shape);
    const kind = base === "Person" ? "" : v.database ? "Db" : v.queue ? "Queue" : "";
    return `${base}${kind}${v.external ? "_Ext" : ""}`;
  };

  const lines: string[] = [];
  const emit = (el: Element, depth: number): void => {
    const pad = "  ".repeat(depth);
    const a = alias(el);
    const name = quoted(el.type === "deploymentNode" && el.instances && el.instances !== "1" ? `${el.name} (x${el.instances})` : el.name);
    const desc = quoted(el.description);
    const tech = quoted(el.technology);
    switch (el.type) {
      case "person":
        lines.push(`${pad}${macroFor("Person", el)}(${a}, "${name}", "${desc}"${elementTags(el)})`);
        break;
      case "softwareSystem":
      case "softwareSystemInstance":
        lines.push(`${pad}${macroFor("System", el)}(${a}, "${name}", "${desc}"${elementTags(el)})`);
        break;
      case "container":
      case "containerInstance":
        lines.push(`${pad}${macroFor("Container", el)}(${a}, "${name}", "${tech}", "${desc}"${elementTags(el)})`);
        break;
      case "component":
        lines.push(`${pad}${macroFor("Component", el)}(${a}, "${name}", "${tech}", "${desc}"${elementTags(el)})`);
        break;
      case "infrastructureNode":
        // Mermaid's C4 grammar rejects Node(...) (even though it documents it) and a leaf Deployment_Node; only a
        // Container is accepted as a leaf inside a deployment node, so infrastructure nodes are drawn as one.
        lines.push(`${pad}${mermaid ? "Container" : "Node"}(${a}, "${name}", "${tech}", "${desc}"${elementTags(el)})`);
        break;
      case "deploymentNode": {
        const kids = h.children.get(el.id) ?? [];
        const open = `${pad}Deployment_Node(${a}, "${name}", "${tech}", "${desc}"${elementTags(el)})`;
        if (kids.length === 0) lines.push(open);
        else {
          lines.push(`${open} {`);
          kids.forEach((k) => emit(k, depth + 1));
          lines.push(`${pad}}`);
        }
        break;
      }
      default:
        // custom element: Mermaid's C4 has no generic box, so it is drawn as a system
        if (mermaid) lines.push(`${pad}System(${a}, "${name}", "${quoted(el.metadata ? `[${el.metadata}] ${el.description}` : el.description)}")`);
        else lines.push(`${pad}rectangle "${name}${el.metadata ? `\\n[${quoted(el.metadata)}]` : ""}" as ${a}`);
    }
  };

  h.roots.forEach((el) => emit(el, 0));
  if (h.scope && h.boundaryChildren.length > 0) {
    const macro = h.scope.type === "softwareSystem" ? "System_Boundary" : "Container_Boundary";
    lines.push(`${macro}(${alias(h.scope)}, "${quoted(h.scope.name)}") {`);
    h.boundaryChildren.forEach((el) => emit(el, 1));
    lines.push("}");
  }

  lines.push("");
  for (const e of edges) {
    const rel = relById.get(e.relationshipId)!;
    const label = quoted(e.description ?? rel.description);
    const tech = quoted(e.technology ?? rel.technology);
    const [from, to] = [alias(elementOf(ws, e.from)), alias(elementOf(ws, e.to))];
    if (view.type === "dynamic") lines.push(`RelIndex("${quoted((e.order ?? "").replace(/:$/, ""))}", ${from}, ${to}, "${label}", "${tech}"${relTags(rel)})`);
    else lines.push(`Rel(${from}, ${to}, "${label}", "${tech}"${relTags(rel)})`);
  }

  const kinds = new Set(h.elements.map((e) => e.type));
  const level =
    view.type === "dynamic" ? "Dynamic"
    : view.type === "deployment" ? "Deployment"
    : view.type === "component" || kinds.has("component") ? "Component"
    : view.type === "container" || kinds.has("container") ? "Container"
    : "Context";
  const scope = view.scopeId ? elementOf(ws, view.scopeId) : undefined;
  const { title, subtitle } = viewTitle(ws, view, scope);
  const dir = view.autoLayout?.direction;

  if (mermaid) {
    // Mermaid: styling comes after the elements (UpdateElementStyle / UpdateRelStyle); no layout control exists.
    const out = [`C4${level}`, `  %% view: ${view.key} (${view.type}), flavor: c4`];
    if (subtitle) out.push(`  %% ${quoted(subtitle).replace(/\\n/g, " ")}`);
    out.push(`  title ${quoted(title)}`, ...lines.map((l) => (l ? `  ${l}` : l)));
    // user-defined colours only (the C4 defaults already match Structurizr's)
    const merged = (tags: string[], defs: Map<string, Record<string, string>>): Record<string, string> => {
      const r: Record<string, string> = {};
      for (const t of tags) Object.assign(r, defs.get(t) ?? {});
      return r;
    };
    const elementColours = new Map<string, Record<string, string>>();
    for (const s of styles.elements) {
      const c: Record<string, string> = {};
      if (s.background) c.$bgColor = hashColour(s.background);
      if (s.color) c.$fontColor = hashColour(s.color);
      if (s.stroke) c.$borderColor = hashColour(s.stroke);
      if (Object.keys(c).length) elementColours.set(s.tag, { ...(elementColours.get(s.tag) ?? {}), ...c });
    }
    const relColours = new Map<string, Record<string, string>>();
    for (const s of styles.relationships) {
      if (s.color) relColours.set(s.tag, { ...(relColours.get(s.tag) ?? {}), $textColor: hashColour(s.color), $lineColor: hashColour(s.color) });
    }
    const updates: string[] = [];
    for (const el of h.elements) {
      const c = merged(el.tags, elementColours);
      if (Object.keys(c).length) updates.push(`  UpdateElementStyle(${alias(el)}, ${Object.entries(c).map(([k, v]) => `${k}="${v}"`).join(", ")})`);
    }
    const seen = new Set<string>();
    for (const e of edges) {
      const rel = relById.get(e.relationshipId)!;
      const c = merged(rel.tags, relColours);
      const [from, to] = [alias(elementOf(ws, e.from)), alias(elementOf(ws, e.to))];
      if (Object.keys(c).length && !seen.has(`${from}>${to}`)) {
        seen.add(`${from}>${to}`);
        updates.push(`  UpdateRelStyle(${from}, ${to}, ${Object.entries(c).map(([k, v]) => `${k}="${v}"`).join(", ")})`);
      }
    }
    if (dir) out.push(`  %% autoLayout ${dir}: Mermaid's C4 diagrams have no layout direction`);
    return [...out, ...(updates.length ? ["", ...updates] : []), ""].join("\n");
  }

  // PlantUML: tag definitions must precede the elements that use them, so they go right after the include
  const defs: string[] = [];
  for (const t of usedElementTags) defs.push(`AddElementTag("${quoted(t)}", ${elementArgs(styledElementTags.get(t)!).join(", ")})`);
  for (const t of usedRelTags) defs.push(`AddRelTag("${quoted(t)}", ${relationshipArgs(styledRelTags.get(t)!).join(", ")})`);
  const layout =
    dir === "lr" || dir === "rl" ? ["LAYOUT_LEFT_RIGHT()", ...(dir === "rl" ? ["' autoLayout rl: C4-PlantUML only supports left-to-right"] : [])]
    : dir === "bt" ? ["LAYOUT_TOP_DOWN()", "' autoLayout bt: C4-PlantUML only supports top-to-bottom"]
    : ["LAYOUT_TOP_DOWN()"];
  return [
    "@startuml",
    `' view: ${view.key} (${view.type}), flavor: c4`,
    `!include <C4/C4_${level}>`,
    ...layout,
    ...defs,
    ...(subtitle ? [`' ${quoted(subtitle).replace(/\\n/g, " ")}`] : []),
    `title ${quoted(title)}`,
    "",
    ...lines,
    "@enduml",
    "",
  ].join("\n");
}

