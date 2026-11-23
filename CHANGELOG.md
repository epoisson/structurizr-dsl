# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/). Versions: [SemVer](https://semver.org/).

## [0.2.4] 2026-11-23
- **Version management**: source of truth is in VERSION
- **Relase script**: now runs on Windows
- **VS Extension Icon**: new icon

## [0.2.3] 2026-11-22

### Added
- **`!const`, `!var` and `!include`** with `${NAME}` substitution (constants, variables, environment variables):
  includes of files, directories and (when the host allows) HTTPS URLs, relative to the including file, with cycle and
  path-escape protection. Every source range now knows its file, so errors in included files are reported on those files.
  The core takes file access through a small host interface (`IncludeHost`, `loadAsync` for asynchronous hosts).
- **Command line**: `!include` resolves from real files; `--define NAME=VALUE`; `--base-dir` for standard input;
  diagnostics in included files show that file's path.
- **VS Code**: diagnostics on included files; document links on `!include` paths; go to definition and click-to-source
  across files; editing an included file re-checks the workspaces that include it; fragments (files with no `workspace`)
  get diagnostics and editor features through their workspace; file watching; settings `structurizr.variables` and
  `structurizr.includes.allowRemote`.
- **Mermaid exporter**: `flowchart` flavour (default; subgraphs for boundaries and deployment nesting, colours via
  `classDef` / `linkStyle`) and `c4` flavour (Mermaid's C4 diagram types). `structurizr-dsl export --format mermaid`.
  Every export is validated against Mermaid's real parser; see `docs/exporter-notes.md`.
- The CLI's `--flavor` is now checked against the chosen `--format`.

- **VS Code extension: export.** `Structurizr: Export View…` and `Structurizr: Export All Views…` (command palette,
  editor context menu) and an `Export…` button in the preview. Formats: SVG, PlantUML (C4 or plain), Mermaid
  (flowchart or C4). Save to a file, copy to the clipboard, or open in a new editor; export-all asks before
  overwriting. Settings: `structurizr.export.defaultFormat`, `structurizr.export.action`, `structurizr.export.svgTheme`.

### Changed
- The C4 emitter is shared between PlantUML and Mermaid (PlantUML output is byte-identical to 0.1.0).

## [0.1.0] - 2026-11-05

First release. An independent implementation of the Structurizr DSL tooling in TypeScript, with no runtime
dependencies. Not affiliated with or endorsed by Structurizr.

### Added
- **Parser**: tokenizer and error-tolerant recursive-descent parser covering the full DSL grammar (per-context keyword
  tables generated from `docs/grammar-inventory.md`), with exact source ranges and recovery after errors.
- **Resolver**: elements, relationships, identifiers (flat and hierarchical), archetypes, groups, `!element`,
  `!elements`, `!relationships`, implied relationships (default "unless any exists" strategy), deployment
  environments and instances with replicated relationships, and views with their contents computed (wildcards,
  `*?`, include/exclude, the expression language, filtered, dynamic and deployment views). See
  `docs/resolver-notes.md` for what is documented and what is inferred.
- **Command line** (`structurizr-dsl`): `check`, `summary`, `resolve`, `parse`, `svg`, `export`.
- **Viewer**: a from-scratch layered layout with nested boundaries and an SVG renderer honouring styles, terminology,
  `autoLayout` direction and light/dark.
- **PlantUML exporter**: `c4` flavour (uses PlantUML's bundled C4 library) and `basic` flavour (plain PlantUML);
  every export of the test workspaces is validated with the real PlantUML.
- **VS Code extension**: syntax highlighting, diagnostics, outline, folding, hover, go to definition, completion, and a
  diagram preview (view picker, pan/zoom, click-to-source, live updates, theme aware).

### Not supported yet
- `!include`, `!const`, `!var`, `!script`, `!plugin`, `!components`, `workspace extends`, `!docs`, `!adrs`
  (parsed and ignored with a warning).
- Parallel sequences in dynamic views; remote themes; icons; the `routing` / `jump` relationship styles.

### Known limitations
- The extension has been tested against a mock of the VS Code API and not yet in a real VS Code.
- Several resolver behaviours are inferred from the documentation rather than confirmed against Structurizr itself
  (listed in `docs/resolver-notes.md`).
- Edge labels can still touch in very dense diagrams. See `docs/viewer-notes.md`.
- The package has no license yet (`UNLICENSED`) and a placeholder extension publisher (`local`): choose both before
  publishing anywhere.
