import type { Element, Relationship, View, Workspace } from "./model.ts";

/**
 * Read-only lookups over a resolved workspace. The workspace itself stays plain JSON; build an
 * index when you need fast access by id, parent or identifier.
 */
export interface WorkspaceIndex {
  element(id: string): Element | undefined;
  relationship(id: string): Relationship | undefined;
  view(key: string): View | undefined;
  /** Look up by the DSL identifier (qualified when hierarchical). */
  byIdentifier(identifier: string): Element | Relationship | undefined;
  children(id: string): Element[];
  /** Relationships whose source is the element / whose destination is the element. */
  outgoing(id: string): Relationship[];
  incoming(id: string): Relationship[];
  /** The resolved contents of a view. */
  viewElements(view: View): Element[];
  viewRelationships(view: View): Relationship[];
}

export function indexWorkspace(ws: Workspace): WorkspaceIndex {
  const elements = new Map(ws.model.elements.map((e) => [e.id, e]));
  const relationships = new Map(ws.model.relationships.map((r) => [r.id, r]));
  const views = new Map(ws.views.map((v) => [v.key, v]));
  const identifiers = new Map<string, Element | Relationship>();
  for (const e of ws.model.elements) if (e.identifier) identifiers.set(e.identifier, e);
  for (const r of ws.model.relationships) if (r.identifier) identifiers.set(r.identifier, r);

  const children = new Map<string, Element[]>();
  for (const e of ws.model.elements) {
    if (!e.parentId) continue;
    const list = children.get(e.parentId);
    if (list) list.push(e);
    else children.set(e.parentId, [e]);
  }
  const outgoing = new Map<string, Relationship[]>();
  const incoming = new Map<string, Relationship[]>();
  const push = (m: Map<string, Relationship[]>, k: string, r: Relationship): void => {
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  };
  for (const r of ws.model.relationships) {
    push(outgoing, r.sourceId, r);
    push(incoming, r.destinationId, r);
  }

  const pick = <T>(ids: string[], m: Map<string, T>): T[] => ids.map((id) => m.get(id)).filter((x): x is T => x !== undefined);
  return {
    element: (id) => elements.get(id),
    relationship: (id) => relationships.get(id),
    view: (key) => views.get(key),
    byIdentifier: (i) => identifiers.get(i),
    children: (id) => children.get(id) ?? [],
    outgoing: (id) => outgoing.get(id) ?? [],
    incoming: (id) => incoming.get(id) ?? [],
    viewElements: (v) => pick(v.elements, elements),
    viewRelationships: (v) => pick(v.relationships, relationships),
  };
}
