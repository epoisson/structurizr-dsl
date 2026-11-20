# Structurizr DSL grammar inventory

> Generated from `packages/core/src/grammar/inventory.ts` by `npm run gen:inventory`. Do not edit by hand.

Source: the official language reference (https://docs.structurizr.com/dsl/language) plus the Basics, Archetypes, Expressions and Includes pages, read on 2026-10-29.

**39 contexts, 95 distinct keywords/operators, 256 statement entries** (an entry is a keyword within one context; 241 planned, 3 deferred, 2 deprecated, 10 unverified).

Status: *planned* = first iteration; *deferred* = parsed to a node, not executed, emits a diagnostic; *deprecated* = parsed with a warning; *unverified* = under-documented or recalled from older docs.

## Design findings

### F1. Keywords are case-insensitive

`softwareSystem` and `softwaresystem` are equivalent (Basics).

**Impact:** Keyword tables are keyed by lower-cased text. Whether identifiers are also case-insensitive is not stated on the pages fetched (open question).

### F2. Strictly line-oriented, with brace placement rules

`{` must be the last token of its statement's line; `}` must be alone on its line; braces only appear when there is child content.

**Impact:** The parser consumes `newline` tokens as statement terminators and can report brace-placement errors precisely.

### F3. Imperative, in-order processing; no forward references

Lines are processed in order (Basics). An identifier must be defined before use.

**Impact:** The resolver can be single pass, and a use-before-define is a real error rather than something to defer.

### F4. String substitution runs on token text, sequentially

`${NAME}` is replaced inside any token, including inside quoted strings. NAME can be a `!const`, a `!var` (redefinable later) or an environment variable; unknown names are left as-is.

**Impact:** A sequential preprocessor stage sits between tokenizer and parser. Environment variables must be injected through an option, because the core cannot touch process.env.

### F5. !include is textual inlining

Content is inlined where the directive appears. Target is a file, a directory (all DSL files in it) or an HTTPS URL; local paths are relative to the parent file and must stay in its directory or below.

**Impact:** Handled in the preprocessor by splicing tokens, with each token keeping its origin file and range for diagnostics. The resolver interface needs readFile, listDirectory and (optionally) fetchUrl. A brace opened in one file may close in another.

### F6. Relationship operators are tokens; expressions are words

`->`, `--archetype->` and `-/>` are operators. Expression words such as `->x`, `x->`, `->x->`, `*->*` are single arguments.

**Impact:** The tokenizer classifies exactly those three shapes as `arrow` and leaves everything else a `word` (implemented in this step).

### F7. One keyword, many meanings

`container`, `component`, `element`, `relationship`, `group`, `description`, `metadata`, `image`, `properties` and `default` all mean different things in different contexts.

**Impact:** Keyword tables are per context (this inventory), never global.

### F8. Archetypes add user-defined keywords

`application = container {...}` makes `application` usable wherever `container` is. Relationship archetypes make `--https->` valid.

**Impact:** In element-defining contexts, an unknown leading word is looked up in the archetype table built so far (valid, since processing is in order). Inventory field `archetypeKinds` says which base kinds apply where.

### F9. Positional arguments with `""` placeholders and optional quotes

Arguments are positional; `""` skips an optional argument; quotes are optional when a value has no whitespace.

**Impact:** The syntax tree stores arguments positionally and distinguishes a skipped argument (empty string) from an absent one.

### F10. Expressions are a sub-language

`element.tag==X`, `element.parent==id`, `&&`, `||`, `->id->`, `relationship.source==id` and so on; whitespace requires quoting the whole expression.

**Impact:** Kept as opaque strings in the syntax tree and parsed by a separate small expression parser in the resolver.

### F11. !script bodies are raw code

`!script groovy { ... }` contains code in another language.

**Impact:** Even though execution is deferred, the body must be captured as raw text and skipped. Normal tokenizing would report spurious errors on quotes and comments inside it. The end-of-body rule is not documented (probably a lone `}` line); needs a fixture.

### F12. !element body depends on its target

Children allowed in `!element <id> { }` are those of the referenced element's kind.

**Impact:** The parser accepts the union of element-body statements; the resolver validates once it knows the target kind.

### F13. `group` is both a block and a property

`group <name> { }` is a block inside model/softwareSystem/container; `group <name>` inside a component is a property.

**Impact:** Distinguished by context, and by whether a `{` follows.

### F14. Dynamic view bodies are not keyword-led

Lines are `[order:] a -> b [desc] [tech]` or `[order:] relId [desc]`.

**Impact:** The dynamic view context has its own line grammar alongside its keyword statements.

### F15. Deprecated and Java-bound features still need nodes

`!ref` / `!extend` are deprecated. `!docs`, `!adrs`, `!components`, `!impliedRelationships <fqcn>`, `!script`, `!plugin` depend on files or the JVM.

**Impact:** All parse into nodes (so files load and outlines work). Deprecated ones carry a warning; JVM-bound ones carry a 'not supported' diagnostic.

### F16. workspace extends can point at JSON

`workspace extends <file|url>` accepts a DSL or a JSON workspace; all identifiers of a DSL base are available.

**Impact:** Loading JSON workspaces is a second input format. It needs a decision on scope for the first iteration.

## Global directives

Valid wherever a statement may start; handled by the preprocessor stage.

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `!include` | `!include <file\|directory\|url>` |  |  | Textual inlining at the point of use. A relative path inside the including file's directory or below; a directory includes its .dsl files; a URL must be HTTPS and needs a host that allows it. |
| `!const` | `!const <name> <value>` |  |  | Defines a constant for `${name}` substitution in the lines that follow. Names use a-z A-Z 0-9 - _ . Constants cannot be redefined. Shown at file top level; whether it is legal in every context is not stated, so it is accepted anywhere. |
| `!var` | `!var <name> <value>` |  |  | Like !const but may be redefined later. |
| `!script` | `!script <groovy\|kotlin\|ruby\|javascript> { ...raw code... }   \|   !script <file>` | optional | deferred | Inline body is raw code, not DSL. Must be skipped without tokenizing. |
| `!plugin` | `!plugin <fqcn>` | optional | deferred | Parameter syntax is not in the language reference. |

## Enumerations

- **shape**: `Box`, `RoundedBox`, `Circle`, `Ellipse`, `Hexagon`, `Diamond`, `Cylinder`, `Bucket`, `Pipe`, `Person`, `Robot`, `Folder`, `WebBrowser`, `Window`, `Terminal`, `Shell`, `MobileDevicePortrait`, `MobileDeviceLandscape`, `Component`
- **border**: `solid`, `dashed`, `dotted`
- **lineStyle**: `solid`, `dashed`, `dotted`
- **routing**: `Direct`, `Orthogonal`, `Curved`
- **autoLayoutDirection**: `tb`, `bt`, `lr`, `rl`
- **identifiers**: `hierarchical`, `flat`
- **scope**: `landscape`, `softwaresystem`, `none`
- **visibility**: `private`, `public`
- **userRole**: `read`, `write`
- **terminologyMetadata**: `square`, `round`, `curly`, `angle`, `double-angle`, `none`
- **filteredMode**: `include`, `exclude`
- **elementExpressionType**: `Person`, `SoftwareSystem`, `Container`, `Component`, `DeploymentNode`, `InfrastructureNode`, `SoftwareSystemInstance`, `ContainerInstance`, `Custom`
- **archetypeBaseKinds**: `person`, `softwareSystem`, `container`, `component`, `deploymentNode`, `infrastructureNode`, `group`, `element`

## Contexts

### `file` — File (top level)

Entered by: `start of file`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `workspace` | `workspace [name] [description] { ... }   \|   workspace extends <file\|url> { ... }` | required → `workspace` |  | `extends` loads a base workspace: a DSL file, or a JSON workspace. |

### `workspace` — workspace

Entered by: `workspace { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `name` | `name <text>` |  |  |  |
| `description` | `description <text>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `!identifiers` | `!identifiers <hierarchical\|flat>` |  |  |  |
| `!docs` | `!docs <path> [fqcn]` |  |  |  |
| `!adrs` | `!adrs <path> [type\|fqn]` |  |  |  |
| `!decisions` | `!decisions <path> [type\|fqn]` |  | unverified | Alias of !adrs; only seen in the 'portable DSL' list in the language reference. |
| `model` | `model { ... }` | required → `model` |  |  |
| `views` | `views { ... }` | required → `views` |  |  |
| `configuration` | `configuration { ... }` | required → `configuration` |  |  |

### `model` — model

Entered by: `model { }`

Archetypes of these kinds act as keywords here: `person`, `softwareSystem`, `group`, `element`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `!identifiers` | `!identifiers <hierarchical\|flat>` |  |  |  |
| `archetypes` | `archetypes { ... }` | required → `archetypes` |  |  |
| `group` | `group <name> { ... }` | required → `groupModel` | assignable |  |
| `person` | `person <name> [description] [tags] { ... }` | optional → `person` | assignable |  |
| `softwareSystem` | `softwareSystem <name> [description] [tags] { ... }` | optional → `softwareSystem` | assignable |  |
| `deploymentEnvironment` | `deploymentEnvironment <name> { ... }` | optional → `deploymentEnvironment` | assignable | Can be referenced by identifier or by name from a deployment view. |
| `element` | `element <name> [metadata] [description] [tags] { ... }` | optional → `customElement` | assignable | Custom element, outside the C4 model. |
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `--<archetype>->` | `<source> --<archetype>-> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Relationship archetype; see `archetypes`. |
| `!element` | `!element <identifier> { ... }   \|   <identifier> = !element <canonicalName> { ... }` | required → `elementRef` | assignable | Not in the language reference's model children list, but documented for workspace extension. |
| `!elements` | `!elements <expression> { ... }` | required → `bulkElements` |  |  |
| `!relationship` | `!relationship <identifier> { ... }   \|   <identifier> = !relationship <canonicalName> { ... }` | required → `bulkRelationships` | assignable |  |
| `!relationships` | `!relationships <expression> { ... }` | required → `bulkRelationships` |  |  |
| `!impliedRelationships` | `!impliedRelationships <true\|false\|fqcn>` |  | unverified | Listed as a directive without a stated context; believed to belong in `model`. fqcn form needs a JVM class: deferred. |
| `!ref` | `!ref ...` |  | deprecated | Use !element / !relationship. |
| `!extend` | `!extend ...` |  | deprecated | Use !element / !relationship. |

### `archetypes` — archetypes

Entered by: `archetypes { }`

> Names defined here become additional keywords in the element-defining contexts, for the rest of the file.

Line grammar:

```
<name> = <baseKind|archetype> [{ ... }]   (element archetype; baseKind in ENUMS.archetypeBaseKinds)
<name> = -> [{ ... }]   |   <name> = --<archetype>-> [{ ... }]   (relationship archetype)
```

### `archetypeElement` — element archetype body

Entered by: `<name> = <baseKind> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `description` | `description <text>` |  |  |  |
| `technology` | `technology <text>` |  |  |  |
| `tag` | `tag <tag>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |
| `metadata` | `metadata <text>` |  | unverified | Custom-element archetypes only; keyword spelling not shown in the docs. |

### `archetypeRelationship` — relationship archetype body

Entered by: `<name> = -> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `description` | `description <text>` |  |  |  |
| `technology` | `technology <text>` |  |  |  |
| `tag` | `tag <tag>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |

### `groupModel` — group (in model)

Entered by: `group <name> { } inside model`

Archetypes of these kinds act as keywords here: `person`, `softwareSystem`, `group`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `group` | `group <name> { ... }` | required → `groupModel` | assignable | Groups can be nested. |
| `person` | `person <name> [description] [tags] { ... }` | optional → `person` | assignable |  |
| `softwareSystem` | `softwareSystem <name> [description] [tags] { ... }` | optional → `softwareSystem` | assignable |  |
| `element` | `element <name> ...` | optional → `customElement` | unverified, assignable | Reference says model groups hold people and software systems only. |

### `groupSystem` — group (in softwareSystem)

Entered by: `group <name> { } inside softwareSystem`

Archetypes of these kinds act as keywords here: `container`, `group`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `group` | `group <name> { ... }` | required → `groupSystem` | assignable |  |
| `container` | `container <name> [description] [technology] [tags] { ... }` | optional → `container` | assignable |  |

### `groupContainer` — group (in container)

Entered by: `group <name> { } inside container`

Archetypes of these kinds act as keywords here: `component`, `group`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `group` | `group <name> { ... }` | required → `groupContainer` | assignable |  |
| `component` | `component <name> [description] [technology] [tags] { ... }` | optional → `component` | assignable |  |

### `groupDeployment` — group (in deployment environment / node)

Entered by: `group <name> { } inside deploymentEnvironment or deploymentNode`

> The language reference lists `group` as a child of deploymentEnvironment/deploymentNode but does not say what it may contain.

Archetypes of these kinds act as keywords here: `deploymentNode`, `group`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `group` | `group <name> { ... }` | required → `groupDeployment` | assignable |  |
| `deploymentNode` | `deploymentNode <name> ...` | optional → `deploymentNode` | assignable |  |
| `infrastructureNode` | `infrastructureNode <name> ...` | optional → `infrastructureNode` | unverified, assignable |  |

### `person` — person

Entered by: `person <name> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `description` | `description <text>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `tag` | `tag <tag>` |  |  |  |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `--<archetype>->` | `<source> --<archetype>-> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Relationship archetype; see `archetypes`. |

### `softwareSystem` — softwareSystem

Entered by: `softwareSystem <name> { }`

Archetypes of these kinds act as keywords here: `container`, `group`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `!docs` | `!docs <path> [fqcn]` |  |  |  |
| `!adrs` | `!adrs <path> [type\|fqn]` |  |  |  |
| `!decisions` | `!decisions <path> [type\|fqn]` |  | unverified | Alias of !adrs; only seen in the 'portable DSL' list in the language reference. |
| `group` | `group <name> { ... }` | required → `groupSystem` | assignable |  |
| `container` | `container <name> [description] [technology] [tags] { ... }` | optional → `container` | assignable |  |
| `description` | `description <text>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `tag` | `tag <tag>` |  |  |  |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `--<archetype>->` | `<source> --<archetype>-> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Relationship archetype; see `archetypes`. |

### `container` — container

Entered by: `container <name> { }`

Archetypes of these kinds act as keywords here: `component`, `group`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `!docs` | `!docs <path> [fqcn]` |  |  |  |
| `!adrs` | `!adrs <path> [type\|fqn]` |  |  |  |
| `!decisions` | `!decisions <path> [type\|fqn]` |  | unverified | Alias of !adrs; only seen in the 'portable DSL' list in the language reference. |
| `group` | `group <name> { ... }` | required → `groupContainer` | assignable |  |
| `component` | `component <name> [description] [technology] [tags] { ... }` | optional → `component` | assignable |  |
| `!components` | `!components { ... }` | optional | deferred | Wrapper around the Java component finder; early-access documentation only. |
| `description` | `description <text>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `tag` | `tag <tag>` |  |  |  |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |
| `technology` | `technology <text>` |  |  |  |
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `--<archetype>->` | `<source> --<archetype>-> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Relationship archetype; see `archetypes`. |

### `component` — component

Entered by: `component <name> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `!docs` | `!docs <path> [fqcn]` |  |  |  |
| `!adrs` | `!adrs <path> [type\|fqn]` |  |  |  |
| `!decisions` | `!decisions <path> [type\|fqn]` |  | unverified | Alias of !adrs; only seen in the 'portable DSL' list in the language reference. |
| `description` | `description <text>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `tag` | `tag <tag>` |  |  |  |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |
| `technology` | `technology <text>` |  |  |  |
| `group` | `group <name>` |  |  | Property form: sets the component's group name. Not a block here. |
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `--<archetype>->` | `<source> --<archetype>-> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Relationship archetype; see `archetypes`. |

### `deploymentEnvironment` — deploymentEnvironment

Entered by: `deploymentEnvironment <name> { }`

Archetypes of these kinds act as keywords here: `deploymentNode`, `group`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `group` | `group <name> { ... }` | required → `groupDeployment` | assignable |  |
| `deploymentGroup` | `deploymentGroup <name>` |  | assignable | Whether it can take an identifier is not stated; deploymentGroups are referenced by identifier from instances. |
| `deploymentNode` | `deploymentNode <name> [description] [technology] [tags] [instances] { ... }` | optional → `deploymentNode` | assignable |  |
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `-/>` | `<source> -/> <destination> ...` |  | unverified | 'Remove relationship' operator. The language reference only links to a Patreon post; exact syntax unknown. |

### `deploymentNode` — deploymentNode

Entered by: `deploymentNode <name> { }`

Archetypes of these kinds act as keywords here: `deploymentNode`, `infrastructureNode`, `group`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `group` | `group <name> { ... }` | required → `groupDeployment` | assignable |  |
| `deploymentNode` | `deploymentNode <name> [description] [technology] [tags] [instances] { ... }` | optional → `deploymentNode` | assignable | Nestable. |
| `infrastructureNode` | `infrastructureNode <name> [description] [technology] [tags] { ... }` | optional → `infrastructureNode` | assignable |  |
| `softwareSystemInstance` | `softwareSystemInstance <identifier> [deploymentGroups] [tags] { ... }` | optional → `instance` | assignable | deploymentGroups: comma separated identifiers. |
| `containerInstance` | `containerInstance <identifier> [deploymentGroups] [tags] { ... }` | optional → `instance` | assignable |  |
| `instanceOf` | `instanceOf <identifier> [deploymentGroups] [tags] { ... }` | optional → `instance` | assignable | Alias for softwareSystemInstance / containerInstance, chosen by what the identifier refers to. |
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `--<archetype>->` | `<source> --<archetype>-> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Relationship archetype; see `archetypes`. |
| `description` | `description <text>` |  |  |  |
| `technology` | `technology <text>` |  |  |  |
| `instances` | `instances <number\|range>` |  |  | Static number or range: "4", "0..1", "1..N", "0..*". |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `tag` | `tag <tag>` |  |  |  |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |

### `infrastructureNode` — infrastructureNode

Entered by: `infrastructureNode <name> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `--<archetype>->` | `<source> --<archetype>-> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Relationship archetype; see `archetypes`. |
| `description` | `description <text>` |  |  |  |
| `technology` | `technology <text>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `tag` | `tag <tag>` |  |  |  |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |

### `instance` — softwareSystemInstance / containerInstance / instanceOf

Entered by: `<instance keyword> <identifier> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `--<archetype>->` | `<source> --<archetype>-> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Relationship archetype; see `archetypes`. |
| `description` | `description <text>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `tag` | `tag <tag>` |  |  |  |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |
| `healthCheck` | `healthCheck <name> <url> [interval] [timeout]` |  |  | interval: seconds (default 60). timeout: milliseconds (default 0). |

### `customElement` — element (custom)

Entered by: `element <name> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `description` | `description <text>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `tag` | `tag <tag>` |  |  |  |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `--<archetype>->` | `<source> --<archetype>-> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Relationship archetype; see `archetypes`. |

### `relationshipBlock` — relationship body

Entered by: `<relationship> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `tag` | `tag <tag>` |  |  |  |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |

### `elementRef` — !element body

Entered by: `!element <identifier> { }`

> Valid children are those of the referenced element's own context, so they depend on what the identifier resolves to. The parser accepts the union; the resolver validates.

### `bulkElements` — !elements body

Entered by: `!elements <expression> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `->` | `<source> -> <destination> [description] [technology] [tags]   \|   -> <destination> [description] [technology] [tags]` | optional → `relationshipBlock` | assignable | Second form: source is the element in scope. `this` refers to the element in scope. |
| `tag` | `tag <tag>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |

### `bulkRelationships` — !relationship / !relationships body

Entered by: `!relationship <id> { } or !relationships <expression> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `tag` | `tag <tag>` |  |  |  |
| `tags` | `tags <tag> [tag...]` |  |  | Comma separated, or individual arguments, or both. |
| `url` | `url <url>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `perspectives` | `perspectives { ... }` | required → `perspectives` |  |  |

### `properties` — properties

Entered by: `properties { }`

Line grammar:

```
<name> <value>
```

### `perspectives` — perspectives

Entered by: `perspectives { }`

Line grammar:

```
<name> <description> [value]
```

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `perspective` | `perspective <name> { ... }` | required → `perspective` |  |  |

### `perspective` — perspective body

Entered by: `perspective <name> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `description` | `description <text>` |  |  |  |
| `value` | `value <text>` |  |  |  |
| `url` | `url <url>` |  |  |  |

### `views` — views

Entered by: `views { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `systemLandscape` | `systemLandscape [key] [description] { ... }` | optional → `viewStatic` |  |  |
| `systemContext` | `systemContext <softwareSystem> [key] [description] { ... }` | optional → `viewStatic` |  |  |
| `container` | `container <softwareSystem> [key] [description] { ... }` | optional → `viewStatic` |  | A view here, not an element. |
| `component` | `component <container> [key] [description] { ... }` | optional → `viewStatic` |  | A view here, not an element. |
| `filtered` | `filtered <baseKey> <include\|exclude> <tags> [key] [description] { ... }` | optional → `viewFiltered` |  |  |
| `dynamic` | `dynamic <*\|softwareSystem\|container> [key] [description] { ... }` | required → `viewDynamic` |  |  |
| `deployment` | `deployment <*\|softwareSystem> <environment> [key] [description] { ... }` | optional → `viewStatic` |  | environment: identifier or name. |
| `custom` | `custom [key] [title] [description] { ... }` | optional → `viewStatic` |  |  |
| `image` | `image <*\|element> [key] { ... }` | required → `viewImage` |  |  |
| `styles` | `styles { ... }` | required → `styles` |  |  |
| `theme` | `theme <name\|url\|file>` |  |  |  |
| `themes` | `themes <name\|url\|file> [name\|url\|file...]` |  |  |  |
| `terminology` | `terminology { ... }` | required → `terminology` |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |
| `branding` | `branding { logo <file\|url>; font <name> [url] }` | required → `…` | unverified | Not in the current language reference; recalled from older versions. A `logo` file reference still appears in the 'portable DSL' list. |

### `viewStatic` — view body (systemLandscape, systemContext, container, component, deployment, custom)

Entered by: `<view keyword> ... { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `include` | `include <*\|*?\|identifier\|expression> [...]` |  |  | `*?` is the reluctant wildcard (system context, container, component views). |
| `exclude` | `exclude <identifier\|expression> [...]   \|   exclude "<*\|id\|expr> -> <*\|id\|expr>"` |  |  |  |
| `autoLayout` | `autoLayout [tb\|bt\|lr\|rl] [rankSeparation] [nodeSeparation]` |  |  | Defaults: tb, 300, 300. |
| `default` | `default` |  |  |  |
| `animation` | `animation { ... }` | required → `animation` |  |  |
| `title` | `title <text>` |  |  |  |
| `description` | `description <text>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |

### `viewFiltered` — filtered view body

Entered by: `filtered ... { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `default` | `default` |  |  |  |
| `title` | `title <text>` |  |  |  |
| `description` | `description <text>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |

### `viewDynamic` — dynamic view body

Entered by: `dynamic ... { }`

> Not keyword-led. `include`/`exclude`/`animation` are not permitted. The cookbook documents parallel sequences; their syntax is not in the language reference.

Line grammar:

```
[order:] <element> -> <element> [description] [technology]
[order:] <relationship identifier> [description]
```

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `autoLayout` | `autoLayout [tb\|bt\|lr\|rl] [rankSeparation] [nodeSeparation]` |  |  |  |
| `default` | `default` |  |  |  |
| `title` | `title <text>` |  |  |  |
| `description` | `description <text>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |

### `viewImage` — image view body

Entered by: `image ... { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `plantuml` | `plantuml <file\|url\|viewKey>` |  |  |  |
| `mermaid` | `mermaid <file\|url\|viewKey>` |  |  |  |
| `kroki` | `kroki <format> <file\|url>` |  |  |  |
| `image` | `image <file\|url>` |  |  |  |
| `default` | `default` |  |  |  |
| `title` | `title <text>` |  |  |  |
| `description` | `description <text>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |

### `animation` — animation

Entered by: `animation { }`

Line grammar:

```
<identifier> [identifier...]   (one animation step per line)
```

### `styles` — styles

Entered by: `styles { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `light` | `light { ... }` | required → `stylesMode` |  |  |
| `dark` | `dark { ... }` | required → `stylesMode` |  |  |
| `element` | `element <tag> { ... }` | required → `elementStyle` |  |  |
| `relationship` | `relationship <tag> { ... }` | required → `relationshipStyle` |  |  |

### `stylesMode` — light / dark

Entered by: `light { } or dark { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `element` | `element <tag> { ... }` | required → `elementStyle` |  |  |
| `relationship` | `relationship <tag> { ... }` | required → `relationshipStyle` |  |  |

### `elementStyle` — element style

Entered by: `element <tag> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `shape` | `shape <Box\|RoundedBox\|Circle\|...>` |  |  | ENUMS.shape |
| `icon` | `icon <file\|url>` |  |  |  |
| `width` | `width <integer>` |  |  |  |
| `height` | `height <integer>` |  |  |  |
| `background` | `background <#rrggbb\|colorName>` |  |  |  |
| `color` | `color <#rrggbb\|colorName>` |  |  |  |
| `colour` | `colour <#rrggbb\|colorName>` |  |  | Alias of color. |
| `stroke` | `stroke <#rrggbb\|colorName>` |  |  |  |
| `strokeWidth` | `strokeWidth <1-10>` |  |  |  |
| `fontSize` | `fontSize <integer>` |  |  |  |
| `border` | `border <solid\|dashed\|dotted>` |  |  |  |
| `opacity` | `opacity <0-100>` |  |  |  |
| `metadata` | `metadata <true\|false>` |  |  |  |
| `description` | `description <true\|false>` |  |  | Boolean here, unlike the text-valued `description` elsewhere. |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |

### `relationshipStyle` — relationship style

Entered by: `relationship <tag> { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `thickness` | `thickness <integer>` |  |  |  |
| `color` | `color <#rrggbb\|colorName>` |  |  |  |
| `colour` | `colour <#rrggbb\|colorName>` |  |  | Alias of color. |
| `style` | `style <solid\|dashed\|dotted>` |  |  |  |
| `routing` | `routing <Direct\|Orthogonal\|Curved>` |  |  |  |
| `jump` | `jump <true\|false>` |  |  |  |
| `fontSize` | `fontSize <integer>` |  |  |  |
| `width` | `width <integer>` |  |  |  |
| `position` | `position <0-100>` |  |  |  |
| `opacity` | `opacity <0-100>` |  |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |

### `terminology` — terminology

Entered by: `terminology { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `person` | `person <term>` |  |  |  |
| `softwareSystem` | `softwareSystem <term>` |  |  |  |
| `container` | `container <term>` |  |  |  |
| `component` | `component <term>` |  |  |  |
| `deploymentNode` | `deploymentNode <term>` |  |  |  |
| `infrastructureNode` | `infrastructureNode <term>` |  |  |  |
| `relationship` | `relationship <term>` |  |  |  |
| `metadata` | `metadata <square\|round\|curly\|angle\|double-angle\|none>` |  |  |  |

### `configuration` — configuration

Entered by: `configuration { }`

| Keyword | Syntax | Body | Status | Notes |
|---|---|---|---|---|
| `scope` | `scope <landscape\|softwaresystem\|none>` |  |  |  |
| `visibility` | `visibility <private\|public>` |  |  |  |
| `users` | `users { ... }` | required → `users` |  |  |
| `properties` | `properties { <name> <value> ... }` | required → `properties` |  |  |

### `users` — users

Entered by: `users { }`

Line grammar:

```
<username> <read|write>
```

## Keyword index

Keywords that appear in more than one context (see finding F7):

- `--<archetype>->`: `model`, `person`, `softwareSystem`, `container`, `component`, `deploymentNode`, `infrastructureNode`, `instance`, `customElement`
- `->`: `model`, `person`, `softwareSystem`, `container`, `component`, `deploymentEnvironment`, `deploymentNode`, `infrastructureNode`, `instance`, `customElement`, `bulkElements`
- `!adrs`: `workspace`, `softwareSystem`, `container`, `component`
- `!decisions`: `workspace`, `softwareSystem`, `container`, `component`
- `!docs`: `workspace`, `softwareSystem`, `container`, `component`
- `!identifiers`: `workspace`, `model`
- `autolayout`: `viewStatic`, `viewDynamic`
- `color`: `elementStyle`, `relationshipStyle`
- `colour`: `elementStyle`, `relationshipStyle`
- `component`: `groupContainer`, `container`, `views`, `terminology`
- `container`: `groupSystem`, `softwareSystem`, `views`, `terminology`
- `default`: `viewStatic`, `viewFiltered`, `viewDynamic`, `viewImage`
- `deploymentnode`: `groupDeployment`, `deploymentEnvironment`, `deploymentNode`, `terminology`
- `description`: `workspace`, `archetypeElement`, `archetypeRelationship`, `person`, `softwareSystem`, `container`, `component`, `deploymentNode`, `infrastructureNode`, `instance`, `customElement`, `perspective`, `viewStatic`, `viewFiltered`, `viewDynamic`, `viewImage`, `elementStyle`
- `element`: `model`, `groupModel`, `styles`, `stylesMode`
- `fontsize`: `elementStyle`, `relationshipStyle`
- `group`: `model`, `groupModel`, `groupSystem`, `groupContainer`, `groupDeployment`, `softwareSystem`, `container`, `component`, `deploymentEnvironment`, `deploymentNode`
- `image`: `views`, `viewImage`
- `infrastructurenode`: `groupDeployment`, `deploymentNode`, `terminology`
- `metadata`: `archetypeElement`, `elementStyle`, `terminology`
- `opacity`: `elementStyle`, `relationshipStyle`
- `person`: `model`, `groupModel`, `terminology`
- `perspectives`: `archetypeElement`, `archetypeRelationship`, `person`, `softwareSystem`, `container`, `component`, `deploymentNode`, `infrastructureNode`, `instance`, `customElement`, `relationshipBlock`, `bulkElements`, `bulkRelationships`
- `properties`: `workspace`, `archetypeElement`, `archetypeRelationship`, `person`, `softwareSystem`, `container`, `component`, `deploymentNode`, `infrastructureNode`, `instance`, `customElement`, `relationshipBlock`, `bulkElements`, `bulkRelationships`, `views`, `viewStatic`, `viewFiltered`, `viewDynamic`, `viewImage`, `elementStyle`, `relationshipStyle`, `configuration`
- `relationship`: `styles`, `stylesMode`, `terminology`
- `softwaresystem`: `model`, `groupModel`, `terminology`
- `tag`: `archetypeElement`, `archetypeRelationship`, `person`, `softwareSystem`, `container`, `component`, `deploymentNode`, `infrastructureNode`, `instance`, `customElement`, `relationshipBlock`, `bulkElements`, `bulkRelationships`
- `tags`: `archetypeElement`, `archetypeRelationship`, `person`, `softwareSystem`, `container`, `component`, `deploymentNode`, `infrastructureNode`, `instance`, `customElement`, `relationshipBlock`, `bulkElements`, `bulkRelationships`
- `technology`: `archetypeElement`, `archetypeRelationship`, `container`, `component`, `deploymentNode`, `infrastructureNode`
- `title`: `viewStatic`, `viewFiltered`, `viewDynamic`, `viewImage`
- `url`: `person`, `softwareSystem`, `container`, `component`, `deploymentNode`, `infrastructureNode`, `instance`, `customElement`, `relationshipBlock`, `bulkElements`, `bulkRelationships`, `perspective`
- `width`: `elementStyle`, `relationshipStyle`

## Open questions to verify

- Identifiers: the Identifiers page was read (chars a-zA-Z_0-9; hierarchical applies to elements only; groups excluded). Still unknown: case sensitivity of identifiers, whether relative names inside a parent's body resolve under `!identifiers hierarchical` (the resolver accepts them with a warning), and exactly which statements may be assigned.
- Dynamic view parallel sequences (cookbook): syntax not in the language reference.
- `-/>` remove-relationship operator: only linked to a Patreon post; syntax and valid contexts unknown.
- !script inline body termination rule, and !plugin parameter syntax.
- Whether !const / !var are legal in every context or only before `workspace`.
- Where !impliedRelationships is allowed (assumed: model).
- `branding` block and `metadata` keyword spelling: recalled from older versions, absent from the current reference.
- Whether relationships, custom elements or infrastructure nodes may appear directly inside group blocks.
