import type { Argument, BlockNode, StatementNode } from "../syntax.ts";
import { ENUMS } from "../grammar/inventory.ts";
import type { ElementStyle, RelationshipStyle, StyleSet, Workspace } from "./model.ts";
import type { State } from "./state.ts";

/** Styles, terminology and configuration: blocks with no references to the model. */

const val = (a: Argument | undefined): string => a?.value ?? "";

function canonical(list: readonly string[], value: string): string | undefined {
  const lower = value.toLowerCase();
  return list.find((x) => x.toLowerCase() === lower);
}

class Values {
  private readonly state: State;
  constructor(state: State) {
    this.state = state;
  }

  int(a: Argument | undefined, min = 0, max = Infinity): number | undefined {
    if (!a) return undefined;
    const n = Number(a.value);
    if (a.value === "" || !Number.isInteger(n) || n < min || n > max) {
      const range = max === Infinity ? `at least ${min}` : `between ${min} and ${max}`;
      this.state.report("invalid-value", `Expected an integer ${range} but found '${a.value}'.`, a.range);
      return undefined;
    }
    return n;
  }

  bool(a: Argument | undefined): boolean | undefined {
    if (!a) return undefined;
    const v = a.value.toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    this.state.report("invalid-value", `Expected 'true' or 'false' but found '${a.value}'.`, a.range);
    return undefined;
  }

  color(a: Argument | undefined): string | undefined {
    if (!a) return undefined;
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(a.value) || /^[A-Za-z]+$/.test(a.value)) return a.value;
    this.state.report("invalid-value", `Expected a colour (#rgb, #rrggbb or a name) but found '${a.value}'.`, a.range);
    return undefined;
  }

  oneOf(a: Argument | undefined, list: readonly string[]): string | undefined {
    if (!a) return undefined;
    const hit = canonical(list, a.value);
    if (!hit) this.state.report("invalid-value", `Expected one of ${list.join(", ")} but found '${a.value}'.`, a.range);
    return hit;
  }
}

function properties(block: BlockNode | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of block?.children ?? []) if (c.form === "line") out[c.keyword] = val(c.args[0]);
  return out;
}

function set<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function elementStyle(stmt: StatementNode, v: Values): ElementStyle {
  const s: ElementStyle = { tag: val(stmt.args[0]), properties: {} };
  for (const c of stmt.body?.children ?? []) {
    const a = c.args[0];
    switch (c.keyword) {
      case "shape": set(s, "shape", v.oneOf(a, ENUMS.shape)); break;
      case "icon": s.icon = val(a); break;
      case "width": set(s, "width", v.int(a, 0)); break;
      case "height": set(s, "height", v.int(a, 0)); break;
      case "background": set(s, "background", v.color(a)); break;
      case "color":
      case "colour": set(s, "color", v.color(a)); break;
      case "stroke": set(s, "stroke", v.color(a)); break;
      case "strokeWidth": set(s, "strokeWidth", v.int(a, 1, 10)); break;
      case "fontSize": set(s, "fontSize", v.int(a, 0)); break;
      case "border": set(s, "border", v.oneOf(a, ENUMS.border) as ElementStyle["border"]); break;
      case "opacity": set(s, "opacity", v.int(a, 0, 100)); break;
      case "metadata": set(s, "metadata", v.bool(a)); break;
      case "description": set(s, "description", v.bool(a)); break;
      case "properties": s.properties = properties(c.body); break;
    }
  }
  return s;
}

function relationshipStyle(stmt: StatementNode, v: Values): RelationshipStyle {
  const s: RelationshipStyle = { tag: val(stmt.args[0]), properties: {} };
  for (const c of stmt.body?.children ?? []) {
    const a = c.args[0];
    switch (c.keyword) {
      case "thickness": set(s, "thickness", v.int(a, 0)); break;
      case "color":
      case "colour": set(s, "color", v.color(a)); break;
      case "style": set(s, "style", v.oneOf(a, ENUMS.lineStyle) as RelationshipStyle["style"]); break;
      case "routing": set(s, "routing", v.oneOf(a, ENUMS.routing)); break;
      case "jump": set(s, "jump", v.bool(a)); break;
      case "fontSize": set(s, "fontSize", v.int(a, 0)); break;
      case "width": set(s, "width", v.int(a, 0)); break;
      case "position": set(s, "position", v.int(a, 0, 100)); break;
      case "opacity": set(s, "opacity", v.int(a, 0, 100)); break;
      case "properties": s.properties = properties(c.body); break;
    }
  }
  return s;
}

function styleSet(children: StatementNode[], v: Values): StyleSet {
  const out: StyleSet = { elements: [], relationships: [] };
  for (const c of children) {
    if (c.keyword === "element") out.elements.push(elementStyle(c, v));
    else if (c.keyword === "relationship") out.relationships.push(relationshipStyle(c, v));
  }
  return out;
}

export function resolveStyles(block: BlockNode, state: State): Workspace["styles"] {
  const v = new Values(state);
  const out: Workspace["styles"] = styleSet(block.children, v);
  for (const c of block.children) {
    if (c.keyword === "light") out.light = styleSet(c.body?.children ?? [], v);
    else if (c.keyword === "dark") out.dark = styleSet(c.body?.children ?? [], v);
  }
  return out;
}

export function resolveTerminology(block: BlockNode, state: State): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of block.children) {
    const a = c.args[0];
    if (!a) continue;
    if (c.keyword === "metadata") {
      const hit = canonical(ENUMS.terminologyMetadata, a.value);
      if (hit) out.metadata = hit;
      else state.report("invalid-value", `Expected one of ${ENUMS.terminologyMetadata.join(", ")} but found '${a.value}'.`, a.range);
    } else out[c.keyword] = a.value;
  }
  return out;
}

export function resolveConfiguration(block: BlockNode, state: State): Workspace["configuration"] {
  const v = new Values(state);
  const out: Workspace["configuration"] = { users: [], properties: {} };
  for (const c of block.children) {
    const a = c.args[0];
    switch (c.keyword) {
      case "scope": set(out, "scope", v.oneOf(a, ENUMS.scope)); break;
      case "visibility": set(out, "visibility", v.oneOf(a, ENUMS.visibility)); break;
      case "properties": out.properties = properties(c.body); break;
      case "users":
        for (const u of c.body?.children ?? []) {
          const role = v.oneOf(u.args[0], ENUMS.userRole) as "read" | "write" | undefined;
          if (role) out.users.push({ username: u.keyword, role });
        }
        break;
    }
  }
  return out;
}
