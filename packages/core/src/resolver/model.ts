import type { Range } from "../types.ts";

/**
 * Resolved workspace model. Plain JSON-serializable data, flat and id-based so it can cross a
 * webview boundary and feed exporters without any behaviour attached.
 *
 * Ids are strings from one shared counter ("1", "2", ...), assigned in document order, so the same
 * source always produces the same ids.
 */

export type ElementType =
  | "person"
  | "softwareSystem"
  | "container"
  | "component"
  | "deploymentNode"
  | "infrastructureNode"
  | "softwareSystemInstance"
  | "containerInstance"
  | "customElement";

export interface Perspective {
  name: string;
  description: string;
  value?: string;
  url?: string;
}

export interface HealthCheck {
  name: string;
  url: string;
  /** seconds */
  interval: number;
  /** milliseconds */
  timeout: number;
}

export interface Element {
  id: string;
  type: ElementType;
  name: string;
  description: string;
  technology?: string;
  /** Effective tags: defaults first ("Element", "Container", ...), then archetype and user tags. */
  tags: string[];
  url?: string;
  properties: Record<string, string>;
  perspectives: Perspective[];
  /** Containing element (software system -> container -> component; node -> node/instance/infrastructure). */
  parentId?: string;
  /** Group name; nested groups are joined with "/". */
  group?: string;
  /** The DSL identifier as it must be written to reference this element (qualified when hierarchical). */
  identifier?: string;
  /** Deployment elements: the environment they belong to. */
  environment?: string;
  /** Instances: the container or software system they instantiate. */
  instanceOfId?: string;
  /** Instances: names of the deployment groups they belong to. */
  deploymentGroups?: string[];
  /** Deployment nodes: instance count as written ("1", "4", "0..1"). */
  instances?: string;
  healthChecks?: HealthCheck[];
  /** Custom elements. */
  metadata?: string;
  /** The declaring statement. */
  range: Range;
}

export interface Relationship {
  id: string;
  sourceId: string;
  destinationId: string;
  description: string;
  technology?: string;
  tags: string[];
  url?: string;
  properties: Record<string, string>;
  perspectives: Perspective[];
  identifier?: string;
  /** Set on implied and replicated relationships: the relationship they were derived from. */
  linkedRelationshipId?: string;
  range: Range;
}

export type ViewType =
  | "systemLandscape"
  | "systemContext"
  | "container"
  | "component"
  | "filtered"
  | "dynamic"
  | "deployment"
  | "custom"
  | "image";

export interface AutoLayout {
  direction: "tb" | "bt" | "lr" | "rl";
  rankSeparation: number;
  nodeSeparation: number;
}

export interface DynamicStep {
  /** Ordering label as written or auto-numbered ("1", "2", "2.1"). */
  order: string;
  relationshipId: string;
  /** The step uses the relationship in the opposite direction (a response). */
  reversed: boolean;
  description?: string;
  technology?: string;
}

export interface ImageSource {
  kind: "plantuml" | "mermaid" | "kroki" | "image";
  source: string;
  /** kroki only */
  format?: string;
}

export interface View {
  key: string;
  type: ViewType;
  title?: string;
  description: string;
  /** Software system or container in scope (undefined for landscape, custom, "*" scopes). */
  scopeId?: string;
  /** Deployment views: environment name. */
  environment?: string;
  /** Filtered views. */
  baseKey?: string;
  filter?: { mode: "include" | "exclude"; tags: string[] };
  autoLayout?: AutoLayout;
  isDefault: boolean;
  /** Computed contents. For deployment views, ancestors of included nodes are included too. */
  elements: string[];
  relationships: string[];
  /** Dynamic views only, in order. */
  steps?: DynamicStep[];
  /** Animation steps as lists of element ids. */
  animations: string[][];
  properties: Record<string, string>;
  /** Image views only. */
  image?: ImageSource;
  range: Range;
}

export interface ElementStyle {
  tag: string;
  shape?: string;
  icon?: string;
  width?: number;
  height?: number;
  background?: string;
  color?: string;
  stroke?: string;
  strokeWidth?: number;
  fontSize?: number;
  border?: "solid" | "dashed" | "dotted";
  opacity?: number;
  metadata?: boolean;
  description?: boolean;
  properties: Record<string, string>;
}

export interface RelationshipStyle {
  tag: string;
  thickness?: number;
  color?: string;
  style?: "solid" | "dashed" | "dotted";
  routing?: string;
  jump?: boolean;
  fontSize?: number;
  width?: number;
  position?: number;
  opacity?: number;
  properties: Record<string, string>;
}

export interface StyleSet {
  elements: ElementStyle[];
  relationships: RelationshipStyle[];
}

export interface UserRole {
  username: string;
  role: "read" | "write";
}

export interface Workspace {
  name: string;
  description: string;
  properties: Record<string, string>;
  model: {
    elements: Element[];
    relationships: Relationship[];
    /** Deployment environment names, in declaration order. */
    environments: string[];
    identifiers: "flat" | "hierarchical";
  };
  views: View[];
  /** Properties set in the `views` block. */
  viewProperties: Record<string, string>;
  styles: StyleSet & { light?: StyleSet; dark?: StyleSet };
  themes: string[];
  terminology: Record<string, string>;
  configuration: {
    scope?: string;
    visibility?: string;
    users: UserRole[];
    properties: Record<string, string>;
  };
}

export function emptyWorkspace(): Workspace {
  return {
    name: "",
    description: "",
    properties: {},
    model: { elements: [], relationships: [], environments: [], identifiers: "flat" },
    views: [],
    viewProperties: {},
    styles: { elements: [], relationships: [] },
    themes: [],
    terminology: {},
    configuration: { users: [], properties: {} },
  };
}
