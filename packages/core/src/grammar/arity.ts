import type { Statement } from "./inventory.ts";

/**
 * Argument counts derived from the syntax strings in the inventory, so the
 * spec text stays the single source of truth.
 *
 *   <x>   required argument        [x]   optional argument
 *   ...   (inside [ ] or on its own) makes the count unbounded
 *
 * A syntax string may hold several alternatives separated by `   |   `; the
 * result spans all of them (min of the mins, max of the maxes).
 */
export interface Arity {
  min: number;
  /** null = unbounded */
  max: number | null;
}

const cache = new WeakMap<Statement, Arity>();

function scan(text: string): Arity {
  let required = 0;
  let optional = 0;
  let variadic = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "<") {
      const end = text.indexOf(">", i);
      if (end < 0) break;
      required++;
      i = end + 1;
    } else if (c === "[") {
      const end = text.indexOf("]", i);
      if (end < 0) break;
      optional++;
      if (text.slice(i, end).includes("...")) variadic = true;
      i = end + 1;
    } else if (text.startsWith("...", i)) {
      variadic = true;
      i += 3;
    } else {
      i++;
    }
  }
  return { min: required, max: variadic ? null : required + optional };
}

export function arityOf(spec: Statement): Arity {
  const hit = cache.get(spec);
  if (hit) return hit;

  let min = Infinity;
  let max: number | null = 0;
  for (const alt of spec.syntax.split(/\s{3,}\|\s{3,}/)) {
    let rest: string;
    if (spec.kind === "operator") {
      const at = Math.max(alt.lastIndexOf("->") + 2, alt.lastIndexOf("-/>") + 3);
      if (at < 2) continue;
      rest = alt.slice(at);
    } else {
      const at = alt.toLowerCase().indexOf(spec.keyword.toLowerCase());
      if (at < 0) continue;
      rest = alt.slice(at + spec.keyword.length);
    }
    const brace = rest.indexOf("{");
    if (brace >= 0) rest = rest.slice(0, brace);
    const a = scan(rest);
    min = Math.min(min, a.min);
    max = max === null || a.max === null ? null : Math.max(max, a.max);
  }
  const result: Arity = { min: min === Infinity ? 0 : min, max };
  cache.set(spec, result);
  return result;
}
