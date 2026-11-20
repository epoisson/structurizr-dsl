/**
 * How keywords are grouped for syntax highlighting. A test checks that every keyword in the grammar
 * inventory appears in exactly one of these lists, so the TextMate grammar cannot fall behind the parser.
 */
export const KEYWORD_GROUPS = {
  /** entity.name.type: things that define model elements */
  element: [
    "person", "softwareSystem", "container", "component", "deploymentEnvironment", "deploymentGroup", "deploymentNode",
    "infrastructureNode", "softwareSystemInstance", "containerInstance", "instanceOf", "element",
  ],
  /** keyword.control: blocks and structure */
  structure: [
    "workspace", "extends", "model", "views", "configuration", "styles", "archetypes", "terminology", "animation", "users",
    "light", "dark", "perspectives", "perspective", "group", "relationship",
  ],
  /** keyword.other: view definitions and their statements */
  view: [
    "systemLandscape", "systemContext", "filtered", "dynamic", "deployment", "custom", "image", "include", "exclude",
    "autoLayout", "default", "title", "theme", "themes", "plantuml", "mermaid", "kroki", "branding",
  ],
  /** variable.other.property: element and relationship attributes */
  property: [
    "name", "description", "technology", "tags", "tag", "url", "properties", "instances", "healthCheck", "scope",
    "visibility", "value", "metadata",
  ],
  /** support.type.property-name: style properties */
  style: [
    "shape", "icon", "width", "height", "background", "color", "colour", "stroke", "strokeWidth", "fontSize", "border",
    "opacity", "thickness", "style", "routing", "jump", "position",
  ],
} as const;
