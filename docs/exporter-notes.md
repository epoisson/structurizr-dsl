# Exporters: PlantUML and Mermaid

`packages/exporters` turns one resolved view into text for another diagram tool. Both exporters share the view
structure (boundaries, nesting, dynamic steps) with the SVG renderer, so all three agree on what a view contains.

    structurizr-dsl export workspace.dsl --format plantuml --view containers -o containers.puml
    structurizr-dsl export workspace.dsl --format mermaid  --all -o diagrams/

## Flavours

| Format | Flavour | Notes |
|---|---|---|
| plantuml | `c4` (default) | Uses PlantUML's bundled C4 library (`!include <C4/C4_Container>`): needs no network, renders as a C4 diagram. Styles become `AddElementTag` / `AddRelTag`. |
| plantuml | `basic` | Plain PlantUML with the resolved colours written out (`skinparam` per distinct look). For setups without the C4 library. |
| mermaid | `flowchart` (default) | A Mermaid flowchart. Renders on GitHub/GitLab/docs sites and gets automatic layout. Subgraphs for boundaries and nested deployment nodes; `classDef` / `linkStyle` for colours. |
| mermaid | `c4` | Mermaid's C4 diagram types (`C4Context`, `C4Container`, ...). Marked experimental by Mermaid; shapes are placed in rows, there is no layout direction. |

Element conventions (both formats): the tag `External` selects the `_Ext` variants, the tag `Database` (or shape `Cylinder`)
selects the database variants, the tag `Queue` (or shape `Pipe`) the queue variants.

## How they were checked

Every export of the test workspaces, in every flavour, is run through the real tool:

- PlantUML: `java -jar plantuml.jar -checkonly` (set `PLANTUML_JAR=/path/to/plantuml.jar`). Several exports were also rendered
  to PNG and inspected (this found invisible person labels in the `basic` flavour, now fixed).
- Mermaid: Mermaid's own parser under jsdom (`MERMAID_HOME=<dir where "npm install mermaid jsdom" was run>`; the check
  uses `packages/exporters/scripts/validate-mermaid.mjs`, and nothing is added to this repo).

Both checks are optional (skipped when the variable is not set), so the suite still runs on a machine with only Node.
**Mermaid output was checked for syntax only**: there is no browser here to render it, so how it looks is unverified.

## Things the real tools taught us

- Mermaid comments are `%%`; PlantUML's `'` is a syntax error there.
- Mermaid flowcharts break when a node id is a keyword (`end`, `graph`, `class`, ...): ids are suffixed with `_`.
- In Mermaid labels `#`, `&`, `<`, `>` and quotes are escaped as entities, so text cannot be read as HTML or an entity.
- Mermaid's C4 grammar rejects `Node(...)` (even though it documents it) and a leaf `Deployment_Node`; infrastructure nodes
  are therefore drawn as a `Container` inside their deployment node in the Mermaid `c4` flavour.
- An `actor`'s label in plain PlantUML sits outside the figure, so it must not use the element's (often white) font colour.

## Limitations

- C4-PlantUML only supports top-to-bottom and left-to-right; `autoLayout bt/rl` is noted in a comment and approximated.
- Mermaid C4 diagrams have no layout direction at all.
- Shapes beyond box / person / database / queue (plus hexagon, circle, diamond, rounded in the Mermaid flowchart) fall back to boxes. Icons are not exported.
- Double quotes in PlantUML text become apostrophes (macro arguments cannot contain them).
- Image views cannot be exported (they are drawn by the tool that owns the image).
