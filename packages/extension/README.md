# Structurizr DSL for VS Code

Language support for `.dsl` Structurizr workspaces. No dependencies.

- Syntax highlighting (generated from the same keyword tables as the parser)
- Diagnostics as you type: syntax errors, unknown identifiers, duplicate names, invalid view contents
- Outline and breadcrumbs, code folding
- Hover: keyword syntax from the language reference; element and relationship summaries for identifiers
- Go to definition for element and relationship identifiers
- Completion: the keywords valid in the surrounding block, and identifiers
- **Export**: `Structurizr: Export View…` and `Structurizr: Export All Views…` (command palette, editor right-click menu, and an Export… button in the preview). Formats: SVG, PlantUML (C4 or plain), Mermaid (flowchart or C4). Save to a file, copy to the clipboard, or open in a new editor. Settings: `structurizr.export.defaultFormat`, `structurizr.export.action`, `structurizr.export.svgTheme`.
- **Diagram preview**: `Structurizr: Open Preview to the Side` (also a button in the editor title bar). Pick a view, pan and zoom, click any element or relationship to jump to its source. Updates as you type, follows your light/dark theme.

`!const`, `!var` and `!include` are supported: problems in an included file are shown on that file, `!include` paths are links,
go to definition and click-to-source cross files, and a file that is only ever included (no `workspace`) is checked through the
workspace that includes it. Settings: `structurizr.variables`, `structurizr.includes.allowRemote` (off by default).

`!script`, `!plugin` and `!components` are recognised but not executed (a warning is shown).
