# Resolver: what it does, and where it guesses

`resolve(syntaxTree)` / `load(source)` turn the syntax tree into a plain-JSON `Workspace`
(`packages/core/src/resolver/model.ts`). This note records the rules it implements, the page of the
official docs each one comes from, and the places where behaviour is inferred rather than documented.

## Implemented from the docs

| Area | Rule | Source |
|---|---|---|
| Identifiers | Characters `a-zA-Z_0-9`. Flat (default) is global: a clash is an error. | docs.structurizr.com/dsl/identifiers |
| | `!identifiers hierarchical`: element identifiers are qualified by their parent (`ss.api`); relationship identifiers are never qualified; groups do not take part in the hierarchy. | identifiers |
| | No forward references: an identifier must be defined before use. `this` is the element in scope. | dsl/faq |
| Implied relationships | On by default, using "create unless any relationship already exists": for `a -> b`, relationships are created between every other combination of {a, ancestors} x {b, ancestors}, skipping self and parent/child pairs, copying description and technology. `!impliedRelationships true|false` and the two named strategies are honoured; other class names warn. | dsl/implied-relationships, java/implied-relationships |
| Relationships | Static elements relate to static elements; deployment elements to deployment elements; never to a parent or child. Duplicate (same source, destination, description) is an error. | dsl/language |
| Default tags | Elements get `Element` plus a type tag (`Container` confirmed in the language reference); relationships get `Relationship`. | dsl/language |
| Expressions | `->x`, `x->`, `->x->`, `element.type/parent/tag/technology/properties/group`, `element==...`, `*->*`, `a->*`, `*->b`, `a->b`, `relationship.tag/source/destination/properties`, `&&` and `||`. | dsl/expressions |
| Wildcards | `include *` per view type; `*?` keeps the same elements but only relationships touching the scoped elements. | dsl/tutorial, DSL changelog |
| Archetypes | Element and relationship archetypes, chained. Description, technology, tags (merged), properties (merged), url, perspectives become defaults; the element's own arguments win. | dsl/archetypes |

## Inferred (not stated in the pages read): verify against real workspaces

1. **Relative identifiers under `!identifiers hierarchical`.** Inside `ss { a = container; b = container; a -> b }` the resolver
   accepts `a` and `b` but warns (`relative-identifier`), because Structurizr appears to require `ss.a`. If Structurizr accepts them,
   the warning can be dropped.
2. **Default tags** other than `Container`: `Person`, `Software System`, `Component`, `Deployment Node`,
   `Infrastructure Node`, `Container Instance`, `Software System Instance`. Instances also inherit the instantiated element's tags.
3. **Deployment relationships.** Relationships between containers/systems are replicated between their instances in the same
   environment when the instances share a deployment group (default group: `Default`). The replication runs once after the whole
   model is read, so it does not depend on statement order. Replicated relationships do not themselves create implied ones.
   `-/>` (documented only via a changelog entry) removes a replicated relationship.
4. **Wildcard contents.** Container view `*` = the system's containers + people/systems directly connected to them; component view
   `*` = the container's components + people/systems/containers directly connected to them. Custom view `*` = all static elements.
   Deployment view `*` = every deployment element in the environment, container instances limited to the scoped system, plus the
   nodes that contain anything included.
5. **Filtered views** keep elements and relationships carrying any of the listed tags (include) or none of them (exclude).
6. **Dynamic views.** A step finds the relationship from source to destination, or the reverse (marked `reversed`, a response);
   a given description is kept as an override. Auto-numbering continues from the last numeric order. Parallel sequences (documented
   in the cookbook only) are not supported.
7. **Name uniqueness**: per type within the same parent and environment. Self-relationships are allowed.
8. **Hand-off cases ignored on purpose**: `workspace extends`, `!docs`, `!adrs`, `!components`, `!ref`, `!extend`,
   `!script`, `!plugin`, `!include`, `!const`, `!var`, `branding`.

## Preprocessing: `!const`, `!var`, `!include`

A stage between the tokenizer and the parser (`packages/core/src/preprocess.ts`), working line by line in order.

**From the documentation** (docs.structurizr.com/dsl/basics, /dsl/includes):
- `!const <name> <value>` and `!var <name> <value>`; names use `a-zA-Z0-9-_.`. A `!var` can be redefined later.
- `${NAME}` is replaced inside any word or string token, from a constant/variable or else an environment variable; an unknown name is left as written.
- `!include <file|directory|url>` inlines the content where the directive appears, in discovery order. A file or directory is a
  relative path in the including file's directory or below; a URL must be HTTPS.

**Inferred (not stated in those pages): verify against real workspaces**
1. Redefining a `!const` is a warning and the first value is kept (the docs only say a `!var` *can* be redefined).
2. A constant or variable wins over an environment variable of the same name.
3. A directory include takes the `.dsl` files directly inside it (not subdirectories), sorted by name.
4. `!const` / `!var` are accepted in any context, not only before `workspace`.
5. Substitution also applies to keywords and to the `!include` target itself, but not inside raw `!script` bodies.
6. Constants defined in an included file stay defined afterwards, and constants defined before an include are visible in it
   (it is textual inlining). A file included twice is inlined twice.
7. Include cycles are errors; nesting deeper than 32 is an error.
8. A relative include inside a file that was itself loaded from a URL resolves against that URL.

**Our own additions**
- `--define NAME=VALUE` (CLI) and the `structurizr.variables` setting predefine constants that win over the file's own definitions.
- URL includes are never fetched unless the host allows it: the CLI does not, and the VS Code extension only with
  `structurizr.includes.allowRemote` (off by default, because opening a workspace could otherwise make the editor download arbitrary URLs).
- Ranges carry the `file` they are in, so a problem in an included file is reported on that file.

## Cascade protection

A statement the parser rejected still reserves its identifier, so later references to it are skipped silently instead of
producing "unknown identifier" noise. A view whose scope element is missing is not created.
