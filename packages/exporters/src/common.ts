import type { Element, Workspace } from "../../core/src/index.ts";

/** Shared by the exporters. */

export type ExportFormat = "plantuml" | "mermaid";

export interface ExportedView {
  key: string;
  content: string;
}

/**
 * Stable, unique, tool-safe aliases for elements: the DSL identifier when there is one
 * (`ss.api` becomes `ss_api`), else `e<id>`. Valid as a PlantUML alias and a Mermaid node id.
 */
export function createAliases(reserved?: ReadonlySet<string>): (el: Element) => string {
  const byId = new Map<string, string>();
  const used = new Set<string>();
  return (el) => {
    const hit = byId.get(el.id);
    if (hit) return hit;
    let base = (el.identifier ?? "").replace(/[^A-Za-z0-9_]/g, "_");
    if (base === "" || /^\d/.test(base)) base = `e${el.id}${base ? "_" + base : ""}`;
    if (reserved?.has(base.toLowerCase())) base += "_";
    let alias = base;
    for (let n = 2; used.has(alias.toLowerCase()); n++) alias = `${base}_${n}`;
    used.add(alias.toLowerCase());
    byId.set(el.id, alias);
    return alias;
  };
}

/** Text for use inside a double-quoted string on one line: quotes become apostrophes, newlines become `\n`. */
export const quoted = (s: string | undefined): string => (s ?? "").replace(/"/g, "'").replace(/\r?\n/g, "\\n").trim();

const hasTag = (el: Element, re: RegExp): boolean => el.tags.some((t) => re.test(t));

/** Conventions for picking a special variant of an element. */
export function variantOf(el: Element, shape: string): { external: boolean; database: boolean; queue: boolean } {
  return {
    external: hasTag(el, /^external$/i),
    database: hasTag(el, /^(database|db)$/i) || shape === "Cylinder",
    queue: hasTag(el, /^(queue|message ?queue)$/i) || shape === "Pipe",
  };
}

/** `#rrggbb` stays; a colour name gets a `#` as PlantUML expects. */
export const hashColour = (c: string): string => (c.startsWith("#") ? c : `#${c}`);

export function stylesOf(ws: Workspace): { elements: Workspace["styles"]["elements"]; relationships: Workspace["styles"]["relationships"] } {
  return {
    elements: [...ws.styles.elements, ...(ws.styles.light?.elements ?? [])],
    relationships: [...ws.styles.relationships, ...(ws.styles.light?.relationships ?? [])],
  };
}

export function elementOf(ws: Workspace, id: string): Element {
  return ws.model.elements.find((e) => e.id === id)!;
}
