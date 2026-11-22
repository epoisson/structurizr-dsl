# Structurizr DSL tools

Part 1: parser (tokenizer -> syntax tree -> resolver -> JSON model) + VS Code extension.
Zero runtime dependencies. Dev-only: TypeScript. Tests use `node:test` and Node's built-in
TypeScript support (Node >= 22.18).

    npm install
    npm test
    npm run typecheck

## Layout
- `packages/core`: environment-agnostic TypeScript (no Node / VS Code imports)
  - `src/types.ts`      Position, Range, Diagnostic
  - `src/tokenizer.ts`  DONE. Never throws; lexical problems become diagnostics.
  - `src/syntax.ts`     DONE. Syntax tree types (plain JSON, ranges on every node).
  - `src/parser.ts`     DONE. Error-tolerant recursive-descent parser: `parse(source)`.
  - `src/grammar/`      `inventory.ts` (spec data), `lookup.ts` (per-context keyword tables), `arity.ts` (argument counts derived from the spec syntax).
  - `src/resolver/`     DONE. `resolve(tree)` -> `Workspace` (model.ts types, builder.ts, views.ts, expressions.ts, styles.ts, query.ts).
  - `src/load.ts`       DONE. `load(source)` = parse + resolve.
  - `examples/usage.ts` runnable usage example (`npm run example`).
  - `src/grammar/inventory.ts`  DONE. Machine-readable grammar inventory (contexts, statements, enums, findings).
  - `scripts/gen-inventory.ts`  renders the inventory to `docs/grammar-inventory.md` (`npm run gen:inventory`).
- `docs/grammar-inventory.md`  generated; do not edit by hand.
- `packages/viewer`: layout engine and SVG renderer (`renderView`), no dependencies
- `packages/exporters`: PlantUML and Mermaid exporters
- `packages/cli`: the `structurizr-dsl` command line (built to plain JavaScript in `dist/`)
- `packages/extension`: the VS Code extension (language support and diagram preview)

## Usage

```ts
import { load, indexWorkspace } from "@structurizr-dsl/core";

const result = load(dslText);            // parse + resolve, never throws

for (const d of result.diagnostics) {    // errors and warnings with exact ranges (0-based line/column)
  console.log(`${d.severity} ${d.range.start.line + 1}:${d.range.start.column + 1} [${d.code}] ${d.message}`);
}
if (!result.ok) console.log("first error:", result.firstError?.message);

const ws = result.workspace;             // plain JSON: elements, relationships, views by id
const index = indexWorkspace(ws);        // read-only lookups; the data itself is untouched

const api = index.byIdentifier("shop.api");                 // by DSL identifier
for (const r of index.outgoing(api.id)) { /* relationships out of it */ }

for (const view of ws.views) {                              // contents are already computed
  const elements = index.viewElements(view);                // include/exclude/wildcards evaluated
  const relationships = index.viewRelationships(view);
  // dynamic views also carry ordered `view.steps`
}
const json = JSON.stringify(ws);                            // send to a webview or an exporter
```

Running `npm run example` (see `examples/usage.ts`) on a small online-shop workspace prints:

```
ok: true

Online Shop: 6 elements, 6 relationships, 3 views

API (container) tags: Element, Container
  -> Database: "Reads from and writes to" [JDBC]
  -> Payment Provider: "Takes payment" [HTTPS]

view "context" (systemContext): Shop, Customer, Payment Provider
  Customer -> Shop: Browses and orders
  Shop -> Payment Provider: Takes payment

view "containers" (container): Web App, API, Customer, Payment Provider
  Web App -> API: Calls
  Customer -> Web App: Browses and orders
  API -> Payment Provider: Takes payment

view "checkout" (dynamic): Customer, Web App, API, Payment Provider
  1. Customer -> Web App Submits the order
  2. Web App -> API Calls
  3. API -> Payment Provider Takes payment
```

The two stages can be used separately: `parse(text)` gives the syntax tree (for editor outline and
ranges), and `resolve(tree)` gives the workspace and the resolution diagnostics.

What the resolver implements and where it infers behaviour: `docs/resolver-notes.md`.

## Variables and includes

```
!const TEAM "Payments"            # a constant: ${TEAM} in the lines that follow (cannot be redefined)
!var   ENV  "dev"                 # a variable: like a constant, but may be redefined later

workspace "${TEAM} (${ENV})" {
    model {
        !include people/users.dsl     # a file, relative to this one (this directory or below)
        !include systems              # a directory: its .dsl files, in name order
    }
}
```

`${NAME}` is replaced from constants/variables, else from environment variables; an unknown name is left as written.
`structurizr-dsl check main.dsl --define ENV=prod` (or the `structurizr.variables` setting in VS Code) overrides the file.
Includes cannot leave the including file's directory, cycles are errors, and URL includes are off unless the host allows
them (the CLI never fetches; VS Code only with `structurizr.includes.allowRemote`). A runnable example is in
`examples/multi-file/`. Details, and what is inferred rather than documented: `docs/resolver-notes.md`.

## Command line

```
structurizr-dsl check   workspace.dsl            # errors/warnings as file:line:col; exit 1 on errors
structurizr-dsl summary workspace.dsl            # what the workspace contains
structurizr-dsl resolve workspace.dsl -o ws.json # resolved workspace as JSON
structurizr-dsl parse   workspace.dsl            # syntax tree as JSON
structurizr-dsl svg     workspace.dsl --view containers -o containers.svg   # a diagram
structurizr-dsl svg     workspace.dsl --all -o diagrams/                    # every view
structurizr-dsl export  workspace.dsl --format plantuml --view containers   # PlantUML (c4 or basic flavour)
structurizr-dsl export  workspace.dsl --format mermaid --all -o diagrams/   # Mermaid (flowchart or c4 flavour)
cat workspace.dsl | structurizr-dsl check -      # "-" reads standard input
```

Options: `-o/--out <file>`, `--compact`, `--json` (check), `-q/--quiet`, `--no-warnings`; for `svg`:
`--view <key>`, `--all`, `--list`, `--dark`, `--no-title`; for `export`: `--format plantuml|mermaid`, `--flavor`; and `-h`, `-v`.
Exporter details, flavours and limits: `docs/exporter-notes.md`.
Exit codes: 0 ok (warnings allowed), 1 the DSL has errors, 2 bad usage or unreadable file.

Getting the command (no packages need to be installed; Node 22.18+ to build, Node 18+ to run):

```
npm run build -w packages/cli      # writes packages/cli/dist (plain JavaScript, 19 small files)

node packages/cli/dist/cli/bin.js check workspace.dsl   # run it directly
cd packages/cli && npm link                             # then `structurizr-dsl ...` works everywhere
cd packages/cli && npm pack                             # makes a .tgz: `npm install -g ./structurizr-dsl-cli-x.y.z.tgz`
```

`dist/` is self-contained: copy the folder anywhere and run `node dist/cli/bin.js`.
Without building (Node 22.18+ runs TypeScript directly): `node packages/cli/src/bin.ts check workspace.dsl`.

## VS Code extension

Features: syntax highlighting, diagnostics as you type, outline and folding, hover (keyword syntax, element summaries),
go to definition, completion, and a diagram preview (`Structurizr: Open Preview to the Side`, or the button in the editor
title bar) with a view picker, pan/zoom, click-to-jump-to-source, live updates and light/dark themes.

```
npm run package -w packages/extension      # writes packages/extension/structurizr-dsl-x.y.z.vsix (no vsce needed)
```

Install it any of these ways:
1. Command line: `code --install-extension packages/extension/structurizr-dsl-x.y.z.vsix`
2. In VS Code: Extensions view, `...` menu, "Install from VSIX...".
3. Without packaging: build (`npm run build -w packages/extension`) and copy `packages/extension` to
   `~/.vscode/extensions/local.structurizr-dsl-x.y.z/` (folder name `publisher.name-version`), then reload the window.
4. For development: open `packages/extension` in VS Code, build, press F5 (Extension Development Host).

Status: the extension logic is unit-tested (language features, the preview payload, the webview page against a fake DOM,
the `.vsix` structure) and the built entry point is exercised against a mock of the VS Code API. It has **not** been run
inside a real VS Code yet, so expect to find rough edges on first use.

Viewer details and limits: `docs/viewer-notes.md`.

## Dependencies

None at runtime, and none needed to develop: tests (`npm test`), the build and the CLI use only Node.
`typescript` and `@types/node` are optional dev dependencies, used solely by `npm run typecheck`.

## Design decisions
- Parser is error-tolerant; the first error is the primary diagnostic (outline keeps working mid-edit).
- Positions are 0-based line/column, ranges half-open (matches VS Code).
- Everything crossing a package boundary is plain JSON-serializable data.

## Tokenizer: lexical rules to verify against the spec / reference fixtures
1. `#` starts a comment only as the first token of a logical line (so `#ff0000` is a word).
2. `//` starts a comment at any token start, but not inside a word (URLs are safe).
3. `/* ... */` may start at any token start and may span lines.
4. `{`, `}`, `=` and the relationship operators (`->`, `--archetype->`, `-/>`) are recognised only as whole
   whitespace-delimited tokens (`->x`, `*->*` are words, being expressions);
   `${CONST}` therefore stays inside words. (`model{` is one word and will be a parse error.)
5. Strings: `"..."` or smart quotes, single line, escapes `\"` and `\\` only.
6. Text blocks `"""..."""` keep raw content (no dedent; the resolver decides).
7. A trailing `\` (optionally followed by spaces) joins the next physical line.
8. `newline` tokens are emitted only for logical lines that contain tokens.

## Parser behaviour
- Never throws; always returns a tree plus diagnostics ordered by position. `firstError` is the earliest error.
- After a bad statement parsing resumes on the next line. The body of an unknown statement is parsed
  leniently (brace structure only) so one typo does not produce a cascade.
- Keywords are matched case-insensitively per context; user-defined archetypes act as keywords.
- Argument counts are derived from the spec syntax strings in the inventory (no second table).
- `!include`, `!const`, `!var`, `!script`, `!plugin`, `!components`: parsed to nodes, ignored, one warning each.
  Inline `!script`/`!plugin` bodies are captured raw (ends at the matching lone `}`).
- Not yet: identifier resolution (resolver stage), enum value checks, expression parsing, `${...}` substitution.
