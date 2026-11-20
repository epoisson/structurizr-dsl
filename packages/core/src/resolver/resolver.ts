import type { FileNode, StatementNode } from "../syntax.ts";
import { sortDiagnostics } from "../types.ts";
import type { Diagnostic } from "../types.ts";
import { ModelBuilder } from "./builder.ts";
import { emptyWorkspace } from "./model.ts";
import type { Workspace } from "./model.ts";
import { State } from "./state.ts";
import { resolveConfiguration, resolveStyles, resolveTerminology } from "./styles.ts";
import { ViewResolver } from "./views.ts";

export interface ResolveResult {
  /** Always present. If the input was broken it holds whatever could be resolved. */
  workspace: Workspace;
  /** Resolution diagnostics only (the parser's are separate), ordered by position. */
  diagnostics: Diagnostic[];
}

const val = (s: StatementNode, i: number): string => s.args[i]?.value ?? "";

/**
 * Turns a syntax tree into a resolved workspace: elements and relationships with ids, effective
 * tags, qualified identifiers, implied relationships, deployment instances, and views with their
 * contents computed.
 *
 * Statements are processed in document order and identifiers must be defined before use (as in
 * Structurizr). Errors never abort resolution; each one is reported and the offending statement skipped.
 */
export function resolve(root: FileNode): ResolveResult {
  const ws = emptyWorkspace();
  const state = new State();
  const builder = new ModelBuilder(state);
  const views = new ViewResolver(state);

  const wsStmt = root.children.find((c) => c.known && c.keyword === "workspace");
  if (wsStmt) {
    const extendsBase = val(wsStmt, 0).toLowerCase() === "extends";
    if (extendsBase) {
      state.report("unsupported", "'workspace extends' is not supported yet; the base workspace is not loaded.", wsStmt.args[0]!.range, "warning");
    } else {
      ws.name = val(wsStmt, 0);
      ws.description = val(wsStmt, 1);
    }

    for (const c of wsStmt.body?.children ?? []) {
      if (!c.known) continue;
      switch (c.keyword) {
        case "name":
          ws.name = val(c, 0);
          break;
        case "description":
          ws.description = val(c, 0);
          break;
        case "properties":
          for (const p of c.body?.children ?? []) if (p.form === "line") ws.properties[p.keyword] = val(p, 0);
          break;
        case "!identifiers":
          builder.setIdentifiers(c);
          break;
        case "model":
          if (c.body) builder.processModel(c.body);
          builder.finish();
          break;
        case "views":
          for (const v of c.body?.children ?? []) {
            if (!v.known) continue;
            if (views.add(v)) continue;
            switch (v.keyword) {
              case "styles":
                if (v.body) ws.styles = resolveStyles(v.body, state);
                break;
              case "theme":
              case "themes":
                for (const a of v.args) ws.themes.push(a.value);
                break;
              case "terminology":
                if (v.body) ws.terminology = resolveTerminology(v.body, state);
                break;
            }
          }
          break;
        case "configuration":
          if (c.body) ws.configuration = resolveConfiguration(c.body, state);
          break;
      }
    }
  }

  ws.model = {
    elements: state.elements,
    relationships: state.relationships,
    environments: state.environments,
    identifiers: state.identifiers,
  };
  ws.views = views.views;
  ws.viewProperties = views.properties;

  const diagnostics = sortDiagnostics(state.diagnostics, root.range.file);
  return { workspace: ws, diagnostics };
}
