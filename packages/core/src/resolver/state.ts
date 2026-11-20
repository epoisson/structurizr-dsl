import type { Diagnostic, Range, Severity } from "../types.ts";
import type { Element, Relationship } from "./model.ts";

/** What a DSL identifier can refer to. */
export type Ref =
  | { kind: "element"; id: string }
  | { kind: "relationship"; id: string }
  | { kind: "group"; name: string }
  | { kind: "deploymentGroup"; name: string }
  | { kind: "environment"; name: string };

/**
 * Mutable state shared by the model builder and the view resolver: the elements and relationships
 * created so far, the identifier registry, and the diagnostics.
 */
export class State {
  readonly elements: Element[] = [];
  readonly relationships: Relationship[] = [];
  readonly elementById = new Map<string, Element>();
  readonly relationshipById = new Map<string, Relationship>();
  readonly refs = new Map<string, Ref>();
  readonly diagnostics: Diagnostic[] = [];
  readonly environments: string[] = [];
  identifiers: "flat" | "hierarchical" = "flat";
  private counter = 0;

  newId(): string {
    return String(++this.counter);
  }

  report(code: string, message: string, range: Range, severity: Severity = "error"): void {
    this.diagnostics.push({ severity, code, message, range });
  }

  // ---- identifiers --------------------------------------------------------

  /** The key an element identifier is registered under (qualified when hierarchical). */
  keyFor(identifier: string, parent: Element | undefined): string {
    if (this.identifiers === "hierarchical" && parent?.identifier) return `${parent.identifier}.${identifier}`;
    return identifier;
  }

  /** Registers an identifier; reports and returns false if it is already in use. */
  register(key: string, ref: Ref, range: Range): boolean {
    if (this.refs.has(key)) {
      this.report("duplicate-identifier", `The identifier '${key}' is already in use.`, range);
      return false;
    }
    this.refs.set(key, ref);
    return true;
  }

  /**
   * Resolves an identifier as written. `this` is the element in scope. When hierarchical identifiers
   * are on, an unqualified name that only matches relative to the scope is accepted with a warning,
   * because Structurizr itself needs the qualified form.
   */
  lookup(text: string, scope: Element | undefined, range: Range): Ref | undefined {
    if (text === "this") {
      if (!scope) {
        this.report("invalid-this", "'this' can only be used inside an element's body.", range);
        return undefined;
      }
      return { kind: "element", id: scope.id };
    }
    const exact = this.refs.get(text);
    if (exact) return exact;

    if (this.identifiers === "hierarchical" && scope?.identifier) {
      let prefix: string | undefined = scope.identifier;
      while (prefix) {
        const hit = this.refs.get(`${prefix}.${text}`);
        if (hit) {
          this.report(
            "relative-identifier",
            `'${text}' only resolves relative to its scope; use '${prefix}.${text}' (hierarchical identifiers are fully qualified).`,
            range,
            "warning",
          );
          return hit;
        }
        const dot = prefix.lastIndexOf(".");
        prefix = dot > 0 ? prefix.slice(0, dot) : undefined;
      }
    }
    this.report("unknown-identifier", `The identifier '${text}' does not exist (identifiers must be defined before use).`, range);
    return undefined;
  }

  /** Resolves an identifier that must be an element. */
  lookupElement(text: string, scope: Element | undefined, range: Range): Element | undefined {
    const ref = this.lookup(text, scope, range);
    if (!ref) return undefined;
    if (ref.kind !== "element") {
      this.report("not-an-element", `'${text}' is a ${ref.kind}, not an element.`, range);
      return undefined;
    }
    return this.elementById.get(ref.id);
  }

  // ---- hierarchy ------------------------------------------------------------

  parentOf(e: Element): Element | undefined {
    return e.parentId ? this.elementById.get(e.parentId) : undefined;
  }

  ancestors(e: Element): Element[] {
    const out: Element[] = [];
    for (let p = this.parentOf(e); p; p = this.parentOf(p)) out.push(p);
    return out;
  }

  isAncestor(maybeAncestor: Element, e: Element): boolean {
    for (let p = this.parentOf(e); p; p = this.parentOf(p)) if (p.id === maybeAncestor.id) return true;
    return false;
  }

  childrenOf(e: Element): Element[] {
    return this.elements.filter((c) => c.parentId === e.id);
  }

  descendantsOf(e: Element): Element[] {
    const out: Element[] = [];
    const visit = (p: Element): void => {
      for (const c of this.childrenOf(p)) {
        out.push(c);
        visit(c);
      }
    };
    visit(e);
    return out;
  }
}

/** Splits a comma-separated tag list. */
export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function mergeTags(...lists: Array<readonly string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) for (const t of list ?? []) if (!out.includes(t)) out.push(t);
  return out;
}
