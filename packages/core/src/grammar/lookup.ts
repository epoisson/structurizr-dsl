import { CONTEXTS, GLOBAL_DIRECTIVES } from "./inventory.ts";
import type { Context, Statement } from "./inventory.ts";

/** A context with its statements indexed for fast, case-insensitive lookup. */
export interface ResolvedContext {
  id: string;
  title: string;
  ctx: Context;
  /** Keyword statements by lower-cased keyword. */
  keywords: Map<string, Statement>;
  /** Operator statements by label ("->", "--<archetype>->", "-/>"). */
  operators: Map<string, Statement>;
}

/** `!element <id> { }` accepts whatever the referenced element's own body accepts. */
const ELEMENT_BODY_CONTEXTS = [
  "person", "softwareSystem", "container", "component", "deploymentNode", "infrastructureNode", "instance", "customElement",
];

function build(ctx: Context, statements: Statement[]): ResolvedContext {
  const keywords = new Map<string, Statement>();
  const operators = new Map<string, Statement>();
  for (const st of statements) {
    if (st.kind === "operator") {
      if (!operators.has(st.keyword)) operators.set(st.keyword, st);
    } else {
      const key = st.keyword.toLowerCase();
      if (!keywords.has(key)) keywords.set(key, st);
    }
  }
  return { id: ctx.id, title: ctx.title, ctx, keywords, operators };
}

const byId = new Map(CONTEXTS.map((c) => [c.id, c]));
const cache = new Map<string, ResolvedContext>();

export function getContext(id: string): ResolvedContext | undefined {
  const hit = cache.get(id);
  if (hit) return hit;
  const ctx = byId.get(id);
  if (!ctx) return undefined;
  const statements =
    id === "elementRef"
      ? ELEMENT_BODY_CONTEXTS.flatMap((c) => byId.get(c)?.statements ?? [])
      : ctx.statements;
  const resolved = build(ctx, statements);
  cache.set(id, resolved);
  return resolved;
}

/** Directives valid in any context, by lower-cased keyword. */
export const GLOBALS: ReadonlyMap<string, Statement> = new Map(
  GLOBAL_DIRECTIVES.map((d) => [d.keyword.toLowerCase(), d]),
);
