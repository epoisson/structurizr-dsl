import type { Argument, BlockNode, StatementNode } from "../syntax.ts";
import type { Element, ElementType, HealthCheck, Perspective, Relationship } from "./model.ts";
import { evaluate, isExprError } from "./expressions.ts";
import { State, mergeTags, parseTags } from "./state.ts";

/**
 * Builds elements and relationships from the model statements of the syntax tree.
 *
 * Processing is strictly in document order and identifiers must be defined before use, exactly
 * like Structurizr's own DSL. Everything that goes wrong is reported and skipped, so a bad
 * statement never stops the rest of the model from being built.
 */

const DEFAULT_TAGS: Record<ElementType, string[]> = {
  person: ["Element", "Person"],
  softwareSystem: ["Element", "Software System"],
  container: ["Element", "Container"],
  component: ["Element", "Component"],
  deploymentNode: ["Element", "Deployment Node"],
  infrastructureNode: ["Element", "Infrastructure Node"],
  softwareSystemInstance: ["Software System Instance"],
  containerInstance: ["Container Instance"],
  customElement: ["Element"],
};
const RELATIONSHIP_TAGS = ["Relationship"];

const STATIC_TYPES = new Set<ElementType>(["person", "softwareSystem", "container", "component", "customElement"]);
const DEPLOYMENT_TYPES = new Set<ElementType>(["deploymentNode", "infrastructureNode", "softwareSystemInstance", "containerInstance"]);

/** Positional argument names per element-defining keyword. */
const ARGS: Partial<Record<string, string[]>> = {
  person: ["name", "description", "tags"],
  softwareSystem: ["name", "description", "tags"],
  container: ["name", "description", "technology", "tags"],
  component: ["name", "description", "technology", "tags"],
  deploymentNode: ["name", "description", "technology", "tags", "instances"],
  infrastructureNode: ["name", "description", "technology", "tags"],
  element: ["name", "metadata", "description", "tags"],
};

const ELEMENT_KEYWORDS: Record<string, ElementType> = {
  person: "person",
  softwareSystem: "softwareSystem",
  container: "container",
  component: "component",
  deploymentNode: "deploymentNode",
  infrastructureNode: "infrastructureNode",
  element: "customElement",
};

export type ImpliedStrategy = "none" | "unlessAnyExists" | "unlessSameExists";

/** Where a statement sits. */
export interface Scope {
  /** The element whose body we are in. */
  element?: Element;
  environment?: string;
  groupPath: string[];
}

/** The properties common to elements, relationships and archetypes. */
interface Props {
  description?: string;
  technology?: string;
  tags: string[];
  url?: string;
  properties: Record<string, string>;
  perspectives: Perspective[];
  metadata?: string;
}

interface ArchetypeDef {
  kind: "element" | "relationship";
  base: string;
  defaults: Props;
}

const val = (a: Argument | undefined): string => a?.value ?? "";
const emptyProps = (): Props => ({ tags: [], properties: {}, perspectives: [] });

export class ModelBuilder {
  private readonly state: State;
  private readonly archetypes = new Map<string, ArchetypeDef>();
  private strategy: ImpliedStrategy = "unlessAnyExists";
  private readonly byPair = new Map<string, Relationship[]>();
  private readonly removals: Array<{ source: string; destination: string }> = [];

  constructor(state: State) {
    this.state = state;
  }

  // -------------------------------------------------------------------------
  // entry points
  // -------------------------------------------------------------------------

  /** Processes the statements of a `model` block (or any other element-defining block). */
  processModel(block: BlockNode): void {
    this.processStatements(block.children, { groupPath: [] });
  }

  setIdentifiers(stmt: StatementNode): void {
    const mode = val(stmt.args[0]).toLowerCase();
    if (mode === "flat" || mode === "hierarchical") this.state.identifiers = mode;
    else this.state.report("invalid-value", "Expected 'flat' or 'hierarchical'.", stmt.args[0]?.range ?? stmt.range);
  }

  /** Call once the model is complete: replicates relationships onto deployment instances. */
  finish(): void {
    this.replicateInstanceRelationships();
    this.applyRemovals();
  }

  // -------------------------------------------------------------------------
  // statement dispatch
  // -------------------------------------------------------------------------

  private processStatements(children: StatementNode[], scope: Scope): void {
    for (const stmt of children) {
      if (!stmt.known) {
        // The parser rejected this statement. Reserve its identifier so later references do not
        // cascade into misleading "unknown identifier" errors.
        const id = stmt.identifier?.value;
        if (id && !this.state.refs.has(id)) this.state.refs.set(id, { kind: "element", id: "" });
        continue;
      }
      if (stmt.form === "relationship") {
        this.relationship(stmt, scope);
        continue;
      }
      if (stmt.form !== "keyword") continue;

      const type = ELEMENT_KEYWORDS[stmt.keyword];
      if (type) {
        this.createElement(stmt, type, scope);
        continue;
      }
      switch (stmt.keyword) {
        case "archetypes":
          this.archetypesBlock(stmt);
          break;
        case "group":
          this.group(stmt, scope);
          break;
        case "deploymentEnvironment":
          this.deploymentEnvironment(stmt, scope);
          break;
        case "deploymentGroup":
          this.deploymentGroup(stmt, scope);
          break;
        case "softwareSystemInstance":
        case "containerInstance":
        case "instanceOf":
          this.createInstance(stmt, scope);
          break;
        case "!identifiers":
          this.setIdentifiers(stmt);
          break;
        case "!impliedRelationships":
          this.impliedRelationships(stmt);
          break;
        case "!element":
          this.elementExtension(stmt, scope);
          break;
        case "!elements":
          this.bulkElements(stmt, scope);
          break;
        case "!relationship":
        case "!relationships":
          this.bulkRelationships(stmt, scope);
          break;
        default:
          if (scope.element) this.elementProperty(stmt, scope.element);
      }
    }
  }

  // -------------------------------------------------------------------------
  // properties shared by elements, relationships and archetypes
  // -------------------------------------------------------------------------

  /** Applies description/technology/tags/url/properties/perspectives/metadata. Returns false if not one of those. */
  private applyProp(stmt: StatementNode, t: Props): boolean {
    switch (stmt.keyword) {
      case "description":
        t.description = val(stmt.args[0]);
        return true;
      case "technology":
        t.technology = val(stmt.args[0]);
        return true;
      case "url":
        t.url = val(stmt.args[0]);
        return true;
      case "metadata":
        t.metadata = val(stmt.args[0]);
        return true;
      case "tags":
      case "tag":
        for (const a of stmt.args) t.tags = mergeTags(t.tags, parseTags(a.value));
        return true;
      case "properties":
        if (stmt.body) Object.assign(t.properties, this.readProperties(stmt.body));
        return true;
      case "perspectives":
        if (stmt.body) t.perspectives.push(...this.readPerspectives(stmt.body));
        return true;
      default:
        return false;
    }
  }

  private readProperties(block: BlockNode): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of block.children) if (c.form === "line") out[c.keyword] = val(c.args[0]);
    return out;
  }

  private readPerspectives(block: BlockNode): Perspective[] {
    const out: Perspective[] = [];
    for (const c of block.children) {
      if (c.form === "line") {
        const p: Perspective = { name: c.keyword, description: val(c.args[0]) };
        if (c.args[1]) p.value = c.args[1].value;
        out.push(p);
      } else if (c.form === "keyword" && c.keyword === "perspective") {
        const p: Perspective = { name: val(c.args[0]), description: "" };
        for (const d of c.body?.children ?? []) {
          if (d.keyword === "description") p.description = val(d.args[0]);
          else if (d.keyword === "value") p.value = val(d.args[0]);
          else if (d.keyword === "url") p.url = val(d.args[0]);
        }
        out.push(p);
      }
    }
    return out;
  }

  /** Property-like statements inside an element body. */
  private elementProperty(stmt: StatementNode, el: Element): void {
    switch (stmt.keyword) {
      case "group":
        el.group = val(stmt.args[0]);
        return;
      case "instances":
        el.instances = val(stmt.args[0]);
        return;
      case "healthCheck":
        this.healthCheck(stmt, el);
        return;
    }
    const t: Props = el;
    this.applyProp(stmt, t);
    if (el.technology === "") delete el.technology;
    if (el.url === "") delete el.url;
    if (el.metadata === "") delete el.metadata;
  }

  private healthCheck(stmt: StatementNode, el: Element): void {
    const num = (a: Argument | undefined, fallback: number): number => {
      if (!a || a.value === "") return fallback;
      const n = Number(a.value);
      if (!Number.isInteger(n) || n < 0) {
        this.state.report("invalid-value", `Expected a non-negative integer but found '${a.value}'.`, a.range);
        return fallback;
      }
      return n;
    };
    const hc: HealthCheck = {
      name: val(stmt.args[0]),
      url: val(stmt.args[1]),
      interval: num(stmt.args[2], 60),
      timeout: num(stmt.args[3], 0),
    };
    (el.healthChecks ??= []).push(hc);
  }

  // -------------------------------------------------------------------------
  // archetypes
  // -------------------------------------------------------------------------

  private archetypesBlock(stmt: StatementNode): void {
    for (const def of stmt.body?.children ?? []) {
      if (def.form !== "archetype" || !def.identifier || !def.archetype) continue;
      const parent = def.archetype.extends ? this.archetypes.get(def.archetype.extends.toLowerCase()) : undefined;
      const defaults: Props = parent
        ? {
            ...parent.defaults,
            tags: [...parent.defaults.tags],
            properties: { ...parent.defaults.properties },
            perspectives: [...parent.defaults.perspectives],
          }
        : emptyProps();
      for (const c of def.body?.children ?? []) this.applyProp(c, defaults);
      this.archetypes.set(def.identifier.value.toLowerCase(), { kind: def.archetype.kind, base: def.archetype.base, defaults });
    }
  }

  // -------------------------------------------------------------------------
  // groups and deployment containers
  // -------------------------------------------------------------------------

  private group(stmt: StatementNode, scope: Scope): void {
    const name = val(stmt.args[0]);
    if (!stmt.body) {
      // property form, inside a component
      if (scope.element) scope.element.group = name;
      return;
    }
    const groupPath = [...scope.groupPath, name];
    if (stmt.identifier) {
      // hierarchical identifiers do not apply to groups
      this.state.register(stmt.identifier.value, { kind: "group", name: groupPath.join("/") }, stmt.identifier.range);
    }
    this.processStatements(stmt.body.children, { ...scope, groupPath });
  }

  private deploymentEnvironment(stmt: StatementNode, scope: Scope): void {
    const name = val(stmt.args[0]);
    if (this.state.environments.includes(name)) {
      this.state.report("duplicate-name", `A deployment environment named '${name}' already exists.`, stmt.args[0]?.range ?? stmt.range);
    } else {
      this.state.environments.push(name);
    }
    if (stmt.identifier) this.state.register(stmt.identifier.value, { kind: "environment", name }, stmt.identifier.range);
    if (stmt.body) this.processStatements(stmt.body.children, { ...scope, element: undefined, environment: name, groupPath: [] });
  }

  private deploymentGroup(stmt: StatementNode, scope: Scope): void {
    const name = val(stmt.args[0]);
    if (!scope.environment) return;
    if (stmt.identifier) this.state.register(stmt.identifier.value, { kind: "deploymentGroup", name }, stmt.identifier.range);
  }

  // -------------------------------------------------------------------------
  // elements
  // -------------------------------------------------------------------------

  private createElement(stmt: StatementNode, type: ElementType, scope: Scope): Element | undefined {
    const names = ARGS[stmt.keyword] ?? ["name"];
    const arg: Record<string, string> = {};
    names.forEach((n, i) => (arg[n] = val(stmt.args[i])));

    const name = arg.name ?? "";
    if (name === "") {
      this.state.report("empty-name", "A name must be specified.", stmt.args[0]?.range ?? stmt.keywordRange);
      return undefined;
    }
    const parent = this.parentFor(type, scope, stmt);
    if (parent === null) return undefined;

    const def = stmt.usesArchetype ? this.archetypes.get(stmt.usesArchetype.toLowerCase()) : undefined;
    const d = def?.defaults;
    const el: Element = {
      id: "",
      type,
      name,
      description: arg.description || d?.description || "",
      tags: mergeTags(DEFAULT_TAGS[type], d?.tags, parseTags(arg.tags ?? "")),
      properties: { ...d?.properties },
      perspectives: [...(d?.perspectives ?? [])],
      range: stmt.range,
    };
    const technology = arg.technology || d?.technology;
    if (technology) el.technology = technology;
    if (d?.url) el.url = d.url;
    const metadata = arg.metadata || d?.metadata;
    if (metadata) el.metadata = metadata;
    if (arg.instances) el.instances = arg.instances;
    else if (type === "deploymentNode") el.instances = "1";
    if (parent) el.parentId = parent.id;
    if (scope.environment && DEPLOYMENT_TYPES.has(type)) el.environment = scope.environment;
    if (scope.groupPath.length > 0) el.group = scope.groupPath.join("/");

    if (!this.checkUniqueName(el, stmt)) return undefined;
    return this.addElement(el, stmt, scope);
  }

  /** Returns the parent element, undefined for top-level, or null if the placement is invalid. */
  private parentFor(type: ElementType, scope: Scope, stmt: StatementNode): Element | undefined | null {
    const parent = scope.element;
    const bad = (expected: string): null => {
      this.state.report("invalid-parent", `A ${type} must be defined inside ${expected}.`, stmt.keywordRange);
      return null;
    };
    switch (type) {
      case "person":
      case "softwareSystem":
      case "customElement":
        return undefined;
      case "container":
        return parent?.type === "softwareSystem" ? parent : bad("a software system");
      case "component":
        return parent?.type === "container" ? parent : bad("a container");
      case "deploymentNode":
        if (!scope.environment) return bad("a deployment environment");
        return parent?.type === "deploymentNode" ? parent : undefined;
      case "infrastructureNode":
      case "softwareSystemInstance":
      case "containerInstance":
        return parent?.type === "deploymentNode" ? parent : bad("a deployment node");
    }
  }

  private checkUniqueName(el: Element, stmt: StatementNode): boolean {
    if (el.type === "softwareSystemInstance" || el.type === "containerInstance") return true;
    const clash = this.state.elements.find(
      (o) => o.type === el.type && o.name === el.name && o.parentId === el.parentId && o.environment === el.environment,
    );
    if (clash) {
      this.state.report("duplicate-name", `A ${el.type} named '${el.name}' already exists in this scope.`, stmt.args[0]?.range ?? stmt.range);
      return false;
    }
    return true;
  }

  /** Assigns the id, registers the identifier, stores the element and processes its body. */
  private addElement(el: Element, stmt: StatementNode, scope: Scope): Element {
    const state = this.state;
    el.id = state.newId();
    if (stmt.identifier) {
      const parent = el.parentId ? state.elementById.get(el.parentId) : undefined;
      const key = state.keyFor(stmt.identifier.value, parent);
      if (!/^[A-Za-z0-9_]+$/.test(stmt.identifier.value)) {
        state.report("invalid-identifier", "Identifiers may only contain a-z, A-Z, 0-9 and _.", stmt.identifier.range, "warning");
      }
      if (state.register(key, { kind: "element", id: el.id }, stmt.identifier.range)) el.identifier = key;
    }
    state.elements.push(el);
    state.elementById.set(el.id, el);
    if (stmt.body) {
      this.processStatements(stmt.body.children, { element: el, environment: scope.environment, groupPath: [] });
      if (el.technology === "") delete el.technology;
    }
    return el;
  }

  private createInstance(stmt: StatementNode, scope: Scope): void {
    const targetText = stmt.args[0];
    if (!targetText) return;
    const target = this.state.lookupElement(targetText.value, scope.element, targetText.range);
    if (!target) return;

    let type: ElementType;
    if (target.type === "softwareSystem") type = "softwareSystemInstance";
    else if (target.type === "container") type = "containerInstance";
    else {
      this.state.report("invalid-instance", `'${targetText.value}' is a ${target.type}; only software systems and containers can be instantiated.`, targetText.range);
      return;
    }
    if (
      (stmt.keyword === "softwareSystemInstance" && type !== "softwareSystemInstance") ||
      (stmt.keyword === "containerInstance" && type !== "containerInstance")
    ) {
      this.state.report("invalid-instance", `'${stmt.keyword}' needs a ${stmt.keyword === "containerInstance" ? "container" : "software system"}.`, targetText.range);
      return;
    }
    const parent = this.parentFor(type, scope, stmt);
    if (parent === null) return;

    // deployment groups: comma separated identifiers, default "Default"
    const groups: string[] = [];
    for (const g of parseTags(val(stmt.args[1]))) {
      const ref = this.state.lookup(g, scope.element, stmt.args[1]!.range);
      if (ref?.kind === "deploymentGroup") groups.push(ref.name);
      else if (ref) this.state.report("not-a-deployment-group", `'${g}' is not a deployment group.`, stmt.args[1]!.range);
    }
    const el: Element = {
      id: "",
      type,
      name: target.name,
      description: target.description,
      tags: mergeTags(DEFAULT_TAGS[type], target.tags, parseTags(val(stmt.args[2]))),
      properties: {},
      perspectives: [],
      instanceOfId: target.id,
      deploymentGroups: groups.length > 0 ? groups : ["Default"],
      range: stmt.range,
    };
    if (target.technology) el.technology = target.technology;
    if (parent) el.parentId = parent.id;
    if (scope.environment) el.environment = scope.environment;
    this.addElement(el, stmt, scope);
  }

  // -------------------------------------------------------------------------
  // relationships
  // -------------------------------------------------------------------------

  private relationship(stmt: StatementNode, scope: Scope): void {
    const state = this.state;
    const op = stmt.operator?.value ?? "->";
    const destArg = stmt.args[0];
    if (!destArg) return;

    let source: Element | undefined;
    if (stmt.source) source = state.lookupElement(stmt.source.value, scope.element, stmt.source.range);
    else source = scope.element; // implicit source; the parser already reported a missing one
    const destination = state.lookupElement(destArg.value, scope.element, destArg.range);
    if (!source || !destination) return;

    if (op === "-/>") {
      this.removals.push({ source: source.id, destination: destination.id });
      return;
    }

    let def: ArchetypeDef | undefined;
    if (op.startsWith("--")) def = this.archetypes.get(op.slice(2, -2).toLowerCase());
    const d = def?.defaults;

    const rel: Relationship = {
      id: "",
      sourceId: source.id,
      destinationId: destination.id,
      description: val(stmt.args[1]) || d?.description || "",
      tags: mergeTags(RELATIONSHIP_TAGS, d?.tags, parseTags(val(stmt.args[3]))),
      properties: { ...d?.properties },
      perspectives: [...(d?.perspectives ?? [])],
      range: stmt.range,
    };
    const technology = val(stmt.args[2]) || d?.technology;
    if (technology) rel.technology = technology;
    if (d?.url) rel.url = d.url;

    const problem = this.relationshipProblem(source, destination);
    if (problem) {
      state.report(problem.code, problem.message, stmt.operator?.range ?? stmt.range);
      return;
    }
    if (this.find(source.id, destination.id, (r) => r.description === rel.description)) {
      state.report(
        "duplicate-relationship",
        `A relationship between '${source.name}' and '${destination.name}' with the description '${rel.description}' already exists.`,
        stmt.operator?.range ?? stmt.range,
      );
      return;
    }

    this.addRelationship(rel);
    if (stmt.identifier) {
      // relationship identifiers are never hierarchical
      if (state.register(stmt.identifier.value, { kind: "relationship", id: rel.id }, stmt.identifier.range)) {
        rel.identifier = stmt.identifier.value;
      }
    }
    this.createImplied(rel);
    for (const c of stmt.body?.children ?? []) this.applyProp(c, rel);
    if (rel.technology === "") delete rel.technology;
    if (rel.url === "") delete rel.url;
  }

  private relationshipProblem(s: Element, d: Element): { code: string; message: string } | undefined {
    const staticPair = STATIC_TYPES.has(s.type) && STATIC_TYPES.has(d.type);
    const deploymentPair = DEPLOYMENT_TYPES.has(s.type) && DEPLOYMENT_TYPES.has(d.type);
    if (!staticPair && !deploymentPair) {
      return { code: "invalid-relationship", message: `A relationship between a ${s.type} and a ${d.type} is not allowed.` };
    }
    if (this.state.isAncestor(s, d) || this.state.isAncestor(d, s)) {
      return { code: "invalid-relationship", message: "Relationships cannot be created between an element and its parent or child." };
    }
    return undefined;
  }

  private addRelationship(rel: Relationship): void {
    rel.id = this.state.newId();
    this.state.relationships.push(rel);
    this.state.relationshipById.set(rel.id, rel);
    const key = `${rel.sourceId}>${rel.destinationId}`;
    const list = this.byPair.get(key);
    if (list) list.push(rel);
    else this.byPair.set(key, [rel]);
  }

  private removeRelationship(rel: Relationship): void {
    const i = this.state.relationships.indexOf(rel);
    if (i >= 0) this.state.relationships.splice(i, 1);
    this.state.relationshipById.delete(rel.id);
    const list = this.byPair.get(`${rel.sourceId}>${rel.destinationId}`);
    if (list) list.splice(list.indexOf(rel), 1);
  }

  private find(source: string, destination: string, pred: (r: Relationship) => boolean = () => true): Relationship | undefined {
    return this.byPair.get(`${source}>${destination}`)?.find(pred);
  }

  private impliedRelationships(stmt: StatementNode): void {
    const v = val(stmt.args[0]);
    if (v === "true") this.strategy = "unlessAnyExists";
    else if (v === "false") this.strategy = "none";
    else if (v.endsWith("CreateImpliedRelationshipsUnlessAnyRelationshipExistsStrategy")) this.strategy = "unlessAnyExists";
    else if (v.endsWith("CreateImpliedRelationshipsUnlessSameRelationshipExistsStrategy")) this.strategy = "unlessSameExists";
    else if (v.endsWith("DefaultImpliedRelationshipsStrategy")) this.strategy = "none";
    else {
      this.state.report("unsupported", `The implied relationships strategy '${v}' is not supported; keeping the current one.`, stmt.args[0]?.range ?? stmt.range, "warning");
    }
  }

  /**
   * For a new relationship between s and d, creates relationships between every other combination of
   * s, d and their ancestors (unless the strategy says one already exists, or the pair is
   * self/parent/child). Implied relationships copy description and technology.
   */
  private createImplied(rel: Relationship): void {
    if (this.strategy === "none") return;
    const state = this.state;
    const s = state.elementById.get(rel.sourceId)!;
    const d = state.elementById.get(rel.destinationId)!;
    for (const a of [s, ...state.ancestors(s)]) {
      for (const b of [d, ...state.ancestors(d)]) {
        if ((a === s && b === d) || a.id === b.id) continue;
        if (state.isAncestor(a, b) || state.isAncestor(b, a)) continue;
        const exists =
          this.strategy === "unlessAnyExists"
            ? this.find(a.id, b.id)
            : this.find(a.id, b.id, (r) => r.description === rel.description);
        if (exists) continue;
        const implied: Relationship = {
          id: "",
          sourceId: a.id,
          destinationId: b.id,
          description: rel.description,
          tags: [...RELATIONSHIP_TAGS],
          properties: {},
          perspectives: [],
          linkedRelationshipId: rel.id,
          range: rel.range,
        };
        if (rel.technology) implied.technology = rel.technology;
        this.addRelationship(implied);
      }
    }
  }

  /**
   * Relationships between containers / software systems also exist between their deployed
   * instances (within one environment, and only between instances sharing a deployment group).
   */
  private replicateInstanceRelationships(): void {
    const instances = this.state.elements.filter((e) => e.type === "containerInstance" || e.type === "softwareSystemInstance");
    const byTarget = new Map<string, Element[]>();
    for (const i of instances) {
      const list = byTarget.get(i.instanceOfId!);
      if (list) list.push(i);
      else byTarget.set(i.instanceOfId!, [i]);
    }
    const shareGroup = (a: Element, b: Element): boolean => a.deploymentGroups!.some((g) => b.deploymentGroups!.includes(g));

    for (const r of [...this.state.relationships]) {
      const sources = byTarget.get(r.sourceId);
      const destinations = byTarget.get(r.destinationId);
      if (!sources || !destinations) continue;
      for (const a of sources) {
        for (const b of destinations) {
          if (a.id === b.id || a.environment !== b.environment || !shareGroup(a, b)) continue;
          if (this.find(a.id, b.id, (x) => x.description === r.description)) continue;
          const copy: Relationship = {
            id: "",
            sourceId: a.id,
            destinationId: b.id,
            description: r.description,
            tags: [...r.tags],
            properties: {},
            perspectives: [],
            linkedRelationshipId: r.id,
            range: r.range,
          };
          if (r.technology) copy.technology = r.technology;
          this.addRelationship(copy);
        }
      }
    }
  }

  private applyRemovals(): void {
    for (const rm of this.removals) {
      for (const r of [...(this.byPair.get(`${rm.source}>${rm.destination}`) ?? [])]) this.removeRelationship(r);
    }
  }

  // -------------------------------------------------------------------------
  // extension and bulk operations
  // -------------------------------------------------------------------------

  private elementExtension(stmt: StatementNode, scope: Scope): void {
    const a = stmt.args[0];
    if (!a || !stmt.body) return;
    if (stmt.identifier) {
      this.state.report("unsupported", "Assigning an identifier to '!element' is not supported yet.", stmt.identifier.range, "warning");
    }
    const el = this.state.lookupElement(a.value, scope.element, a.range);
    if (!el) return;
    this.processStatements(stmt.body.children, { element: el, environment: el.environment, groupPath: [] });
  }

  private bulkElements(stmt: StatementNode, scope: Scope): void {
    const a = stmt.args[0];
    if (!a || !stmt.body) return;
    const result = this.evaluateModelExpression(a, scope);
    if (!result || result.kind !== "elements") {
      if (result) this.state.report("invalid-expression", "Expected an expression selecting elements.", a.range);
      return;
    }
    for (const el of result.items) {
      this.processStatements(stmt.body.children, { element: el, environment: el.environment, groupPath: [] });
    }
  }

  private bulkRelationships(stmt: StatementNode, scope: Scope): void {
    const a = stmt.args[0];
    if (!a || !stmt.body) return;
    let targets: Relationship[] = [];
    if (stmt.keyword === "!relationship") {
      const ref = this.state.lookup(a.value, scope.element, a.range);
      if (ref?.kind === "relationship") targets = [this.state.relationshipById.get(ref.id)!];
      else if (ref) this.state.report("not-a-relationship", `'${a.value}' is not a relationship.`, a.range);
    } else {
      const result = this.evaluateModelExpression(a, scope);
      if (result?.kind === "relationships") targets = result.items;
      else if (result) this.state.report("invalid-expression", "Expected an expression selecting relationships.", a.range);
    }
    for (const rel of targets) for (const c of stmt.body.children) this.applyProp(c, rel);
  }

  private evaluateModelExpression(a: Argument, scope: Scope) {
    const state = this.state;
    const result = evaluate(a.value, {
      elements: state.elements,
      relationships: state.relationships,
      resolve: (t) => state.lookup(t, scope.element, a.range),
      elementById: (id) => state.elementById.get(id),
    });
    if (isExprError(result)) {
      state.report("invalid-expression", result.error, a.range);
      return undefined;
    }
    return result;
  }
}

