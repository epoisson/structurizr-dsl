import type { Element, View, Workspace } from "../../core/src/index.ts";

/**
 * What a view contains and how it nests, independent of how it is drawn. Shared by the SVG renderer
 * and the exporters (PlantUML, Mermaid) so they all agree on boundaries, nesting and edges.
 */

export interface Hierarchy {
  /** The software system / container in scope, if the view has one. */
  scope?: Element;
  /** Every element of the view, in view order. */
  elements: Element[];
  /** Elements drawn at the top level (not inside a boundary or a parent node). */
  roots: Element[];
  /** Deployment views: children of each deployment node, by node id. */
  children: Map<string, Element[]>;
  /**
   * Container, component, dynamic and filtered views draw a boundary around the scope element's
   * children. These are those children; empty when there is no boundary.
   */
  boundaryChildren: Element[];
}

export function viewHierarchy(ws: Workspace, view: View): Hierarchy {
  const byId = new Map(ws.model.elements.map((e) => [e.id, e]));
  const elements = view.elements.map((id) => byId.get(id)).filter((e): e is Element => e !== undefined);
  const present = new Set(elements.map((e) => e.id));
  const scope = view.scopeId ? byId.get(view.scopeId) : undefined;
  const grouped = scope !== undefined && view.type !== "deployment" && view.type !== "systemContext" && view.type !== "systemLandscape";

  const children = new Map<string, Element[]>();
  const roots: Element[] = [];
  const boundaryChildren: Element[] = [];
  for (const el of elements) {
    if (view.type === "deployment" && el.parentId && present.has(el.parentId)) {
      (children.get(el.parentId) ?? children.set(el.parentId, []).get(el.parentId)!).push(el);
    } else if (grouped && el.parentId === scope!.id) boundaryChildren.push(el);
    else roots.push(el);
  }
  const h: Hierarchy = { elements, roots, children, boundaryChildren };
  if (scope) h.scope = scope;
  return h;
}

export interface ViewEdge {
  /** Unique within the view: `r<relationship id>`, or `s<index>` for dynamic steps. */
  key: string;
  relationshipId: string;
  /** Element ids, already swapped for reversed (response) steps. */
  from: string;
  to: string;
  /** Dynamic views: the step order and any description/technology override. */
  order?: string;
  description?: string;
  technology?: string;
}

/** The edges of a view whose two ends are both in the view, in drawing order. */
export function viewEdges(ws: Workspace, view: View): ViewEdge[] {
  const rels = new Map(ws.model.relationships.map((r) => [r.id, r]));
  const present = new Set(view.elements);
  const out: ViewEdge[] = [];
  if (view.type === "dynamic" && view.steps) {
    view.steps.forEach((step, i) => {
      const rel = rels.get(step.relationshipId);
      if (!rel) return;
      const [from, to] = step.reversed ? [rel.destinationId, rel.sourceId] : [rel.sourceId, rel.destinationId];
      const e: ViewEdge = { key: `s${i}`, relationshipId: rel.id, from, to, order: step.order };
      if (step.description !== undefined) e.description = step.description;
      if (step.technology !== undefined) e.technology = step.technology;
      out.push(e);
    });
  } else {
    for (const id of view.relationships) {
      const rel = rels.get(id);
      if (rel) out.push({ key: `r${id}`, relationshipId: id, from: rel.sourceId, to: rel.destinationId });
    }
  }
  return out.filter((e) => present.has(e.from) && present.has(e.to));
}
