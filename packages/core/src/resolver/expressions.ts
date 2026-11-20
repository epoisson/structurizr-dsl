import type { Element, ElementType, Relationship } from "./model.ts";
import type { Ref } from "./state.ts";
import { parseTags } from "./state.ts";

/**
 * Evaluates the Structurizr DSL expression language (https://docs.structurizr.com/dsl/expressions)
 * against a set of elements and relationships.
 *
 * Elements:       ->X   X->   ->X->   element.type==T   element.parent==id   element.tag==a,b
 *                 element.tag!=a,b   element.technology==x   element.properties[k]==v
 *                 element.group==name   element==->X->  (and the one-sided forms)
 * Relationships:  *->*   id->*   *->id   id->id   relationship==...   relationship.tag==a,b
 *                 relationship.source==id   relationship.destination==id
 *                 relationship.properties[k]==v
 * Combining:      A && B   A || B  (left to right, no parentheses)
 *
 * The wildcards `*` and `*?` are not expressions; views handle them.
 */

export type ExprValue =
  | { kind: "elements"; items: Element[] }
  | { kind: "relationships"; items: Relationship[] };

export interface ExprEnv {
  elements: readonly Element[];
  relationships: readonly Relationship[];
  /** Resolves a DSL identifier. Expected to report unknown identifiers itself. */
  resolve: (identifier: string) => Ref | undefined;
  elementById: (id: string) => Element | undefined;
}

export interface ExprError {
  error: string;
}

const TYPE_NAMES: Record<string, ElementType> = {
  person: "person",
  softwaresystem: "softwareSystem",
  container: "container",
  component: "component",
  deploymentnode: "deploymentNode",
  infrastructurenode: "infrastructureNode",
  softwaresysteminstance: "softwareSystemInstance",
  containerinstance: "containerInstance",
  custom: "customElement",
};

const IDENT = /^[A-Za-z0-9_.]+$/;
const PAIR = /^(\*|[A-Za-z0-9_.]+)\s*->\s*(\*|[A-Za-z0-9_.]+)$/;

const hasAll = (have: readonly string[], want: readonly string[]): boolean => want.every((t) => have.includes(t));

export function isExprError(v: ExprValue | ExprError): v is ExprError {
  return "error" in v;
}

/** True when the text looks like a plain identifier reference rather than an expression. */
export function isPlainIdentifier(text: string): boolean {
  return IDENT.test(text);
}

export function evaluate(expression: string, env: ExprEnv): ExprValue | ExprError {
  // split on top-level && / || and fold left to right
  const parts = expression.split(/\s*(&&|\|\|)\s*/);
  let acc = evalSingle(parts[0]!.trim(), env);
  for (let i = 1; i < parts.length; i += 2) {
    if (isExprError(acc)) return acc;
    const op = parts[i]!;
    const rhs = evalSingle((parts[i + 1] ?? "").trim(), env);
    if (isExprError(rhs)) return rhs;
    if (acc.kind !== rhs.kind) return { error: `Cannot combine element and relationship expressions with '${op}'.` };
    const ids = new Set(rhs.items.map((x) => x.id));
    if (acc.kind === "elements") {
      const left = acc.items;
      const right = rhs.items as Element[];
      acc = { kind: "elements", items: op === "&&" ? left.filter((x) => ids.has(x.id)) : union(left, right) };
    } else {
      const left = acc.items;
      const right = rhs.items as Relationship[];
      acc = { kind: "relationships", items: op === "&&" ? left.filter((x) => ids.has(x.id)) : union(left, right) };
    }
  }
  return acc;
}

function union<T extends { id: string }>(a: T[], b: T[]): T[] {
  const seen = new Set(a.map((x) => x.id));
  return [...a, ...b.filter((x) => !seen.has(x.id))];
}

function evalSingle(s: string, env: ExprEnv): ExprValue | ExprError {
  if (s === "") return { error: "Empty expression." };

  // ---- relationship.* --------------------------------------------------------
  let m = /^relationship\.tag\s*(==|!=)\s*(.+)$/.exec(s);
  if (m) {
    const want = parseTags(m[2]!);
    const eq = m[1] === "==";
    return rels(env.relationships.filter((r) => hasAll(r.tags, want) === eq));
  }
  m = /^relationship\.properties\[([^\]]+)\]\s*==\s*(.+)$/.exec(s);
  if (m) return rels(env.relationships.filter((r) => r.properties[m![1]!.trim()] === m![2]!.trim()));
  m = /^relationship\.(source|destination)\s*==\s*(.+)$/.exec(s);
  if (m) {
    const el = elementRef(m[2]!.trim(), env);
    if (!el) return { error: `'${m[2]!.trim()}' is not an element.` };
    return rels(env.relationships.filter((r) => (m![1] === "source" ? r.sourceId : r.destinationId) === el.id));
  }
  m = /^relationship\s*==\s*(.+)$/.exec(s);
  if (m) return evalRelationshipPair(m[1]!.trim(), env);

  // ---- element.* -----------------------------------------------------------------
  m = /^element\.type\s*==\s*(.+)$/.exec(s);
  if (m) {
    const t = TYPE_NAMES[m[1]!.trim().toLowerCase()];
    if (!t) return { error: `Unknown element type '${m[1]!.trim()}'.` };
    return els(env.elements.filter((e) => e.type === t));
  }
  m = /^element\.parent\s*==\s*(.+)$/.exec(s);
  if (m) {
    const parent = elementRef(m[1]!.trim(), env);
    if (!parent) return { error: `'${m[1]!.trim()}' is not an element.` };
    return els(env.elements.filter((e) => e.parentId === parent.id));
  }
  m = /^element\.tag\s*(==|!=)\s*(.+)$/.exec(s);
  if (m) {
    const want = parseTags(m[2]!);
    const eq = m[1] === "==";
    return els(env.elements.filter((e) => hasAll(e.tags, want) === eq));
  }
  m = /^element\.technology\s*(==|!=)\s*(.+)$/.exec(s);
  if (m) {
    const eq = m[1] === "==";
    return els(env.elements.filter((e) => (e.technology === m![2]!.trim()) === eq));
  }
  m = /^element\.properties\[([^\]]+)\]\s*==\s*(.+)$/.exec(s);
  if (m) return els(env.elements.filter((e) => e.properties[m![1]!.trim()] === m![2]!.trim()));
  m = /^element\.group\s*==\s*(.+)$/.exec(s);
  if (m) return els(env.elements.filter((e) => e.group === m![1]!.trim()));
  m = /^element\s*==\s*(.+)$/.exec(s);
  if (m) return evalCoupling(m[1]!.trim(), env);

  // ---- id -> id, * -> *, id -> *, * -> id (relationships) --------------------------
  const pair = PAIR.exec(s);
  if (pair) return evalRelationshipPair(s, env);

  // ---- couplings and plain identifiers ------------------------------------------------
  if (s.startsWith("->") || s.endsWith("->")) return evalCoupling(s, env);

  if (IDENT.test(s)) {
    const ref = env.resolve(s);
    if (!ref) return { error: `Unknown identifier '${s}'.` };
    if (ref.kind === "element") {
      const e = env.elementById(ref.id);
      return els(e ? [e] : []); // a missing element means its definition was rejected and already reported
    }
    if (ref.kind === "relationship") return rels(env.relationships.filter((r) => r.id === ref.id));
    if (ref.kind === "group") return els(env.elements.filter((e) => e.group === ref.name || e.group?.startsWith(ref.name + "/")));
    return { error: `'${s}' cannot be used in an expression.` };
  }
  return { error: `Unrecognised expression '${s}'.` };
}

const els = (items: Element[]): ExprValue => ({ kind: "elements", items });
const rels = (items: Relationship[]): ExprValue => ({ kind: "relationships", items });

function elementRef(text: string, env: ExprEnv): Element | undefined {
  const ref = env.resolve(text);
  return ref?.kind === "element" ? env.elementById(ref.id) : undefined;
}

/** `*->*`, `a->*`, `*->b`, `a->b` (also with `relationship==` stripped). */
function evalRelationshipPair(text: string, env: ExprEnv): ExprValue | ExprError {
  if (text === "*") return rels([...env.relationships]);
  const m = PAIR.exec(text);
  if (!m) return { error: `Unrecognised relationship expression '${text}'.` };
  const [, from, to] = m;
  let src: Element | undefined;
  let dst: Element | undefined;
  if (from !== "*") {
    src = elementRef(from!, env);
    if (!src) return { error: `'${from}' is not an element.` };
  }
  if (to !== "*") {
    dst = elementRef(to!, env);
    if (!dst) return { error: `'${to}' is not an element.` };
  }
  return rels(env.relationships.filter((r) => (!src || r.sourceId === src.id) && (!dst || r.destinationId === dst.id)));
}

/** `->X`, `X->`, `->X->` where X is an identifier or a nested element expression. */
function evalCoupling(text: string, env: ExprEnv): ExprValue | ExprError {
  const afferent = text.startsWith("->");
  const efferent = text.endsWith("->") && text.length > (afferent ? 2 : 0);
  let inner = text;
  if (afferent) inner = inner.slice(2);
  if (efferent) inner = inner.slice(0, -2);
  inner = inner.trim();
  if (!afferent && !efferent) {
    // `element==<identifier>`: just that element (or group)
    return evalSingle(inner, env);
  }

  const base = evalSingle(inner, env);
  if (isExprError(base)) return base;
  if (base.kind !== "elements") return { error: `'${inner}' does not select elements.` };

  const ids = new Set(base.items.map((e) => e.id));
  const out = [...base.items];
  const add = (id: string): void => {
    if (ids.has(id)) return;
    const e = env.elementById(id);
    if (e) {
      ids.add(id);
      out.push(e);
    }
  };
  const baseIds = new Set(base.items.map((e) => e.id));
  for (const r of env.relationships) {
    if (afferent && baseIds.has(r.destinationId)) add(r.sourceId);
    if (efferent && baseIds.has(r.sourceId)) add(r.destinationId);
  }
  return els(out);
}
