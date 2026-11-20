import type { Argument, StatementNode } from "../syntax.ts";
import type { Range } from "../types.ts";
import { ENUMS } from "../grammar/inventory.ts";
import type { AutoLayout, DynamicStep, Element, ElementType, Relationship, View, ViewType } from "./model.ts";
import { evaluate, isExprError, isPlainIdentifier } from "./expressions.ts";
import { State, parseTags } from "./state.ts";

/**
 * Resolves view definitions and computes their contents (which elements and relationships each
 * view shows) so that viewers and exporters never have to evaluate include/exclude rules.
 *
 * Wildcard semantics (https://docs.structurizr.com/dsl/language, tutorial and changelog):
 *   systemLandscape  `*`   all people and software systems
 *   systemContext    `*`   the system in scope + people/systems directly connected to it
 *   container        `*`   the containers of the system + people/systems directly connected to them
 *   component        `*`   the components of the container + people/systems/containers directly connected
 *   `*?` (reluctant) the same elements, but only relationships that touch the scoped elements.
 * Relationships between the elements in a view are added automatically, like Structurizr does.
 */

const KEY_PREFIX: Record<ViewType, string> = {
  systemLandscape: "SystemLandscape",
  systemContext: "SystemContext",
  container: "Container",
  component: "Component",
  filtered: "Filtered",
  dynamic: "Dynamic",
  deployment: "Deployment",
  custom: "Custom",
  image: "Image",
};

const DEPLOYMENT_TYPES = new Set<ElementType>(["deploymentNode", "infrastructureNode", "softwareSystemInstance", "containerInstance"]);
const STATIC_TYPES = new Set<ElementType>(["person", "softwareSystem", "container", "component", "customElement"]);
const CONNECTED_PEOPLE_AND_SYSTEMS = new Set<ElementType>(["person", "softwareSystem", "customElement"]);

const val = (a: Argument | undefined): string => a?.value ?? "";

/** The mutable contents of a view while its rules are applied. */
interface Content {
  elements: Set<string>;
  relationships: Set<string>;
}

interface PendingAnimation {
  ids: Array<{ id: string; range: Range }>;
}

export class ViewResolver {
  readonly views: View[] = [];
  readonly properties: Record<string, string> = {};
  private readonly state: State;
  private readonly counters: Partial<Record<ViewType, number>> = {};
  private index: Map<string, Relationship[]> | undefined;

  constructor(state: State) {
    this.state = state;
  }

  // -------------------------------------------------------------------------
  // entry
  // -------------------------------------------------------------------------

  /** Handles one view-defining statement from a `views` block. Returns false if not a view statement. */
  add(stmt: StatementNode): boolean {
    switch (stmt.keyword) {
      case "systemLandscape":
        this.build(stmt, "systemLandscape", { key: 0, description: 1 });
        return true;
      case "systemContext":
        this.build(stmt, "systemContext", { scope: 0, key: 1, description: 2 });
        return true;
      case "container":
        this.build(stmt, "container", { scope: 0, key: 1, description: 2 });
        return true;
      case "component":
        this.build(stmt, "component", { scope: 0, key: 1, description: 2 });
        return true;
      case "filtered":
        this.build(stmt, "filtered", { base: 0, mode: 1, tags: 2, key: 3, description: 4 });
        return true;
      case "dynamic":
        this.build(stmt, "dynamic", { scope: 0, key: 1, description: 2 });
        return true;
      case "deployment":
        this.build(stmt, "deployment", { scope: 0, environment: 1, key: 2, description: 3 });
        return true;
      case "custom":
        this.build(stmt, "custom", { key: 0, title: 1, description: 2 });
        return true;
      case "image":
        this.build(stmt, "image", { scope: 0, key: 1 });
        return true;
      case "properties":
        if (stmt.body) for (const c of stmt.body.children) if (c.form === "line") this.properties[c.keyword] = val(c.args[0]);
        return true;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // view construction
  // -------------------------------------------------------------------------

  private build(stmt: StatementNode, type: ViewType, pos: Record<string, number>): void {
    const arg = (name: string): Argument | undefined => (pos[name] === undefined ? undefined : stmt.args[pos[name]!]);
    const state = this.state;

    const view: View = {
      key: "",
      type,
      description: val(arg("description")),
      isDefault: false,
      elements: [],
      relationships: [],
      animations: [],
      properties: {},
      range: stmt.range,
    };
    if (arg("title")) view.title = val(arg("title"));

    // scope
    const scopeArg = arg("scope");
    if (scopeArg && scopeArg.value !== "*") {
      const el = state.lookupElement(scopeArg.value, undefined, scopeArg.range);
      const expected: Partial<Record<ViewType, ElementType[]>> = {
        systemContext: ["softwareSystem"],
        container: ["softwareSystem"],
        component: ["container"],
        dynamic: ["softwareSystem", "container"],
        deployment: ["softwareSystem"],
      };
      const ok = expected[type];
      if (!el) return;
      if (ok && !ok.includes(el.type)) {
        state.report("invalid-view-scope", `A ${type} view needs a ${ok.join(" or ")} in scope, but '${scopeArg.value}' is a ${el.type}.`, scopeArg.range);
        return;
      }
      view.scopeId = el.id;
    } else if (!scopeArg && (type === "systemContext" || type === "container" || type === "component")) {
      return; // missing scope: the parser already reported the missing argument
    }

    // deployment environment
    if (type === "deployment") {
      const envArg = arg("environment");
      if (!envArg) return;
      const ref = state.refs.get(envArg.value);
      const name = ref?.kind === "environment" ? ref.name : envArg.value;
      if (!state.environments.includes(name)) {
        state.report("unknown-environment", `The deployment environment '${envArg.value}' does not exist.`, envArg.range);
        return;
      }
      view.environment = name;
    }

    // filtered
    if (type === "filtered") {
      const baseArg = arg("base");
      const base = this.views.find((v) => v.key === val(baseArg));
      if (!base) {
        state.report("unknown-view", `The base view '${val(baseArg)}' does not exist (it must be defined earlier).`, baseArg?.range ?? stmt.range);
        return;
      }
      if (base.type === "dynamic" || base.type === "filtered" || base.type === "image") {
        state.report("invalid-base-view", `A filtered view cannot be based on a ${base.type} view.`, baseArg!.range);
        return;
      }
      const mode = val(arg("mode")).toLowerCase();
      if (!ENUMS.filteredMode.includes(mode as "include" | "exclude")) {
        state.report("invalid-value", "Expected 'include' or 'exclude'.", arg("mode")?.range ?? stmt.range);
        return;
      }
      view.baseKey = base.key;
      view.filter = { mode: mode as "include" | "exclude", tags: parseTags(val(arg("tags"))) };
      if (base.scopeId) view.scopeId = base.scopeId;
      if (base.environment) view.environment = base.environment;
    }

    // key
    const explicit = val(arg("key"));
    view.key = explicit || this.generateKey(type);
    if (this.views.some((v) => v.key === view.key)) {
      state.report("duplicate-view-key", `A view with the key '${view.key}' already exists.`, arg("key")?.range ?? stmt.range);
      return;
    }

    const content: Content = { elements: new Set(), relationships: new Set() };
    const animations: PendingAnimation[] = [];
    const steps: DynamicStep[] = [];
    if (type === "dynamic") view.steps = steps;
    let autoOrder = 0;

    for (const c of stmt.body?.children ?? []) {
      if (!c.known) continue;
      if (type === "dynamic" && (c.form === "relationship" || c.form === "line")) {
        autoOrder = this.dynamicStep(c, steps, content, autoOrder);
        continue;
      }
      switch (c.keyword) {
        case "include":
        case "exclude":
          if (type !== "filtered") for (const a of c.args) this.rule(view, content, c.keyword, a);
          break;
        case "autoLayout":
          this.autoLayout(view, c);
          break;
        case "default":
          view.isDefault = true;
          break;
        case "animation":
          this.collectAnimation(c, animations);
          break;
        case "title":
          view.title = val(c.args[0]);
          break;
        case "description":
          view.description = val(c.args[0]);
          break;
        case "properties":
          for (const p of c.body?.children ?? []) if (p.form === "line") view.properties[p.keyword] = val(p.args[0]);
          break;
        case "plantuml":
        case "mermaid":
        case "image":
          view.image = { kind: c.keyword, source: val(c.args[0]) };
          break;
        case "kroki":
          view.image = { kind: "kroki", format: val(c.args[0]), source: val(c.args[1]) };
          break;
      }
    }

    if (type === "filtered") this.applyFilter(view, content);
    if (type === "deployment") this.addDeploymentAncestors(content);
    view.elements = [...content.elements];
    view.relationships = [...content.relationships];

    for (const anim of animations) {
      const ids: string[] = [];
      for (const { id, range } of anim.ids) {
        if (content.elements.has(id)) ids.push(id);
        else state.report("animation-element-not-in-view", "This element is not in the view, so it cannot be animated.", range, "warning");
      }
      if (ids.length > 0) view.animations.push(ids);
    }
    this.views.push(view);
  }

  private generateKey(type: ViewType): string {
    const n = (this.counters[type] = (this.counters[type] ?? 0) + 1);
    return `${KEY_PREFIX[type]}-${String(n).padStart(3, "0")}`;
  }

  private autoLayout(view: View, stmt: StatementNode): void {
    const layout: AutoLayout = { direction: "tb", rankSeparation: 300, nodeSeparation: 300 };
    let i = 0;
    const first = stmt.args[0];
    if (first && Number.isNaN(Number(first.value))) {
      const dir = first.value.toLowerCase();
      if ((ENUMS.autoLayoutDirection as readonly string[]).includes(dir)) layout.direction = dir as AutoLayout["direction"];
      else this.state.report("invalid-value", `Expected one of ${ENUMS.autoLayoutDirection.join(", ")} but found '${first.value}'.`, first.range);
      i = 1;
    }
    for (const field of ["rankSeparation", "nodeSeparation"] as const) {
      const a = stmt.args[i++];
      if (!a) break;
      const n = Number(a.value);
      if (!Number.isInteger(n) || n < 0) this.state.report("invalid-value", `Expected a non-negative integer but found '${a.value}'.`, a.range);
      else layout[field] = n;
    }
    view.autoLayout = layout;
  }

  private collectAnimation(stmt: StatementNode, out: PendingAnimation[]): void {
    for (const line of stmt.body?.children ?? []) {
      const ids: PendingAnimation["ids"] = [];
      for (const a of [{ value: line.keyword, range: line.keywordRange }, ...line.args]) {
        const el = this.state.lookupElement(a.value, undefined, a.range);
        if (el) ids.push({ id: el.id, range: a.range });
      }
      out.push({ ids });
    }
  }

  // -------------------------------------------------------------------------
  // relationship index
  // -------------------------------------------------------------------------

  private relsOf(id: string): Relationship[] {
    if (!this.index) {
      this.index = new Map();
      for (const r of this.state.relationships) {
        for (const end of r.sourceId === r.destinationId ? [r.sourceId] : [r.sourceId, r.destinationId]) {
          const list = this.index.get(end);
          if (list) list.push(r);
          else this.index.set(end, [r]);
        }
      }
    }
    return this.index.get(id) ?? [];
  }

  private other(r: Relationship, id: string): string {
    return r.sourceId === id ? r.destinationId : r.sourceId;
  }

  // -------------------------------------------------------------------------
  // include / exclude
  // -------------------------------------------------------------------------

  private rule(view: View, content: Content, mode: "include" | "exclude", arg: Argument): void {
    const text = arg.value.trim();
    const state = this.state;

    if (text === "*" || text === "*?") {
      if (mode === "include") this.addDefaults(view, content, text === "*?");
      else state.report("invalid-expression", "'*' cannot be excluded.", arg.range);
      return;
    }

    if (isPlainIdentifier(text)) {
      const ref = state.lookup(text, undefined, arg.range);
      if (!ref) return;
      if (ref.kind === "element") {
        const el = state.elementById.get(ref.id);
        if (!el) return; // its definition was rejected earlier and already reported
        if (mode === "include") this.addElement(view, content, el, arg.range);
        else this.removeElement(content, el.id);
        return;
      }
      if (ref.kind === "relationship") {
        const rel = state.relationshipById.get(ref.id);
        if (!rel) return;
        if (mode === "include") this.addRelationship(content, rel);
        else content.relationships.delete(rel.id);
        return;
      }
      if (ref.kind === "group") {
        for (const el of state.elements.filter((e) => e.group === ref.name || e.group?.startsWith(ref.name + "/"))) {
          if (mode === "include") this.addElement(view, content, el);
          else this.removeElement(content, el.id);
        }
        return;
      }
      state.report("invalid-expression", `'${text}' cannot be used in a view.`, arg.range);
      return;
    }

    const result = evaluate(text, {
      elements: state.elements,
      relationships: state.relationships,
      resolve: (t) => state.lookup(t, undefined, arg.range),
      elementById: (id) => state.elementById.get(id),
    });
    if (isExprError(result)) {
      state.report("invalid-expression", result.error, arg.range);
      return;
    }
    if (result.kind === "elements") {
      for (const el of result.items) {
        if (mode === "include") this.addElement(view, content, el);
        else this.removeElement(content, el.id);
      }
    } else {
      for (const rel of result.items) {
        if (mode === "include") this.addRelationship(content, rel);
        else content.relationships.delete(rel.id);
      }
    }
  }

  /** `range` is given for explicit identifiers (an invalid element is an error); expressions skip silently. */
  private addElement(view: View, content: Content, el: Element, range?: Range): void {
    const problem = this.notAllowed(view, el);
    if (problem) {
      if (range) this.state.report("invalid-view-element", `'${el.name}' ${problem}.`, range);
      return;
    }
    if (content.elements.has(el.id)) return;
    content.elements.add(el.id);
    this.connect(content, el.id);
  }

  private removeElement(content: Content, id: string): void {
    content.elements.delete(id);
    for (const r of this.relsOf(id)) content.relationships.delete(r.id);
  }

  private addRelationship(content: Content, rel: Relationship): void {
    if (content.elements.has(rel.sourceId) && content.elements.has(rel.destinationId)) content.relationships.add(rel.id);
  }

  /** Adds every relationship between this element and the other elements already in the view. */
  private connect(content: Content, id: string): void {
    for (const r of this.relsOf(id)) {
      if (content.elements.has(r.sourceId) && content.elements.has(r.destinationId)) content.relationships.add(r.id);
    }
  }

  /** Why an element may not be in this view, or undefined if it may. */
  private notAllowed(view: View, el: Element): string | undefined {
    const scope = view.scopeId ? this.state.elementById.get(view.scopeId) : undefined;
    switch (view.type) {
      case "systemLandscape":
      case "systemContext":
        return CONNECTED_PEOPLE_AND_SYSTEMS.has(el.type) ? undefined : "cannot be added to a system landscape or system context view";
      case "container":
        if (scope && el.id === scope.id) return "is the software system in scope, so it cannot be added to its own container view";
        return el.type === "component" || !STATIC_TYPES.has(el.type) ? "cannot be added to a container view" : undefined;
      case "component":
        if (scope && (el.id === scope.id || el.id === scope.parentId)) return "contains this component view, so it cannot be added to it";
        return STATIC_TYPES.has(el.type) ? undefined : "cannot be added to a component view";
      case "custom":
        return STATIC_TYPES.has(el.type) ? undefined : "cannot be added to a custom view";
      case "deployment": {
        if (!DEPLOYMENT_TYPES.has(el.type)) return "cannot be added to a deployment view";
        if (el.environment !== view.environment) return `belongs to the '${el.environment}' environment, not '${view.environment}'`;
        if (scope && el.type === "containerInstance") {
          const container = this.state.elementById.get(el.instanceOfId!);
          if (container?.parentId !== scope.id) return "is an instance of a container outside the software system in scope";
        }
        return undefined;
      }
      default:
        return "cannot be added to this type of view";
    }
  }

  private addDefaults(view: View, content: Content, reluctant: boolean): void {
    const state = this.state;
    const scope = view.scopeId ? state.elementById.get(view.scopeId) : undefined;
    const scoped: Element[] = [];
    const neighbours = new Map<string, Element>();
    const connectedTo = (ids: Set<string>, allowed: (e: Element) => boolean): void => {
      for (const id of ids) {
        for (const r of this.relsOf(id)) {
          const o = state.elementById.get(this.other(r, id));
          if (o && !ids.has(o.id) && allowed(o)) neighbours.set(o.id, o);
        }
      }
    };

    switch (view.type) {
      case "systemLandscape":
        scoped.push(...state.elements.filter((e) => e.type === "person" || e.type === "softwareSystem"));
        break;
      case "systemContext":
        if (scope) {
          scoped.push(scope);
          connectedTo(new Set([scope.id]), (e) => CONNECTED_PEOPLE_AND_SYSTEMS.has(e.type));
        }
        break;
      case "container":
        if (scope) {
          scoped.push(...state.elements.filter((e) => e.type === "container" && e.parentId === scope.id));
          connectedTo(new Set(scoped.map((e) => e.id)), (e) => CONNECTED_PEOPLE_AND_SYSTEMS.has(e.type) && e.id !== scope.id);
        }
        break;
      case "component":
        if (scope) {
          scoped.push(...state.elements.filter((e) => e.type === "component" && e.parentId === scope.id));
          connectedTo(
            new Set(scoped.map((e) => e.id)),
            (e) => (CONNECTED_PEOPLE_AND_SYSTEMS.has(e.type) || e.type === "container") && e.id !== scope.id && e.id !== scope.parentId,
          );
        }
        break;
      case "custom":
        scoped.push(...state.elements.filter((e) => STATIC_TYPES.has(e.type)));
        break;
      case "deployment":
        scoped.push(...state.elements.filter((e) => !this.notAllowed(view, e)));
        break;
      default:
        return;
    }

    for (const e of [...scoped, ...neighbours.values()]) content.elements.add(e.id);
    const scopedIds = new Set(scoped.map((e) => e.id));
    for (const id of [...content.elements]) {
      for (const r of this.relsOf(id)) {
        if (!content.elements.has(r.sourceId) || !content.elements.has(r.destinationId)) continue;
        if (reluctant && view.type !== "systemLandscape" && view.type !== "custom" && view.type !== "deployment") {
          if (!scopedIds.has(r.sourceId) && !scopedIds.has(r.destinationId)) continue;
        }
        content.relationships.add(r.id);
      }
    }
  }

  /** Deployment views also show the nodes that contain the included elements. */
  private addDeploymentAncestors(content: Content): void {
    for (const id of [...content.elements]) {
      for (const a of this.state.ancestors(this.state.elementById.get(id)!)) {
        content.elements.add(a.id);
        this.connect(content, a.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // filtered and dynamic views
  // -------------------------------------------------------------------------

  private applyFilter(view: View, content: Content): void {
    const base = this.views.find((v) => v.key === view.baseKey)!;
    const { mode, tags } = view.filter!;
    const hasAny = (have: string[]): boolean => tags.some((t) => have.includes(t));
    const keep = (have: string[]): boolean => (mode === "include" ? hasAny(have) : !hasAny(have));
    for (const id of base.elements) if (keep(this.state.elementById.get(id)!.tags)) content.elements.add(id);
    for (const id of base.relationships) {
      const r = this.state.relationshipById.get(id)!;
      if (keep(r.tags) && content.elements.has(r.sourceId) && content.elements.has(r.destinationId)) content.relationships.add(id);
    }
  }

  /** Returns the updated auto-order counter. */
  private dynamicStep(stmt: StatementNode, steps: DynamicStep[], content: Content, autoOrder: number): number {
    const state = this.state;
    let order = stmt.order ? stmt.order.value.replace(/:$/, "") : "";
    if (order === "") order = String(autoOrder + 1);
    const numeric = Number(order);
    const nextAuto = Number.isInteger(numeric) ? numeric : autoOrder;

    let rel: Relationship | undefined;
    let reversed = false;
    let description: string | undefined;
    let technology: string | undefined;

    if (stmt.form === "line") {
      // `[order:] relationshipId [description]`
      const ref = state.lookup(stmt.keyword, undefined, stmt.keywordRange);
      if (!ref) return nextAuto;
      if (ref.kind !== "relationship") {
        state.report("not-a-relationship", `'${stmt.keyword}' is not a relationship.`, stmt.keywordRange);
        return nextAuto;
      }
      rel = state.relationshipById.get(ref.id);
      if (stmt.args[0]) description = stmt.args[0].value;
    } else {
      const src = stmt.source ? state.lookupElement(stmt.source.value, undefined, stmt.source.range) : undefined;
      const dstArg = stmt.args[0];
      const dst = dstArg ? state.lookupElement(dstArg.value, undefined, dstArg.range) : undefined;
      if (!src || !dst) return nextAuto;
      const wanted = stmt.args[1]?.value;
      const between = (a: string, b: string): Relationship[] => state.relationships.filter((r) => r.sourceId === a && r.destinationId === b);
      let candidates = between(src.id, dst.id);
      if (candidates.length === 0) {
        candidates = between(dst.id, src.id);
        reversed = candidates.length > 0;
      }
      if (candidates.length === 0) {
        state.report("no-relationship", `A relationship between '${src.name}' and '${dst.name}' does not exist in the model.`, stmt.operator?.range ?? stmt.range);
        return nextAuto;
      }
      rel = (wanted !== undefined && candidates.find((r) => r.description === wanted)) || candidates[0];
      if (wanted !== undefined) description = wanted;
      if (stmt.args[2]) technology = stmt.args[2].value;
    }
    if (!rel) return nextAuto;

    const step: DynamicStep = { order, relationshipId: rel.id, reversed };
    if (description !== undefined) step.description = description;
    if (technology !== undefined) step.technology = technology;
    steps.push(step);
    content.elements.add(rel.sourceId);
    content.elements.add(rel.destinationId);
    content.relationships.add(rel.id);
    return nextAuto;
  }
}

