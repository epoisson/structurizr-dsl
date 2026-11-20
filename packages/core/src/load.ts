import { sortDiagnostics } from "./types.ts";
import type { Diagnostic } from "./types.ts";
import { parse } from "./parser.ts";
import type { ParseOptions, ParseResult } from "./parser.ts";
import { resolve } from "./resolver/resolver.ts";
import type { Workspace } from "./resolver/model.ts";

export interface LoadResult {
  /** Always present; holds whatever could be resolved if the source has problems. */
  workspace: Workspace;
  /** Syntax and resolution diagnostics together, ordered by position. */
  diagnostics: Diagnostic[];
  /** The earliest error by position. */
  firstError: Diagnostic | undefined;
  /** True when there are no errors (warnings are fine). */
  ok: boolean;
  /** The syntax tree, for editor features (outline, ranges). */
  syntax: ParseResult;
}

/** Parse + resolve in one call. `options` says where the source lives and how to reach included files, variables, etc. */
export function load(source: string, options: ParseOptions = {}): LoadResult {
  const syntax = parse(source, options);
  const resolved = resolve(syntax.root);
  const diagnostics = sortDiagnostics([...syntax.diagnostics, ...resolved.diagnostics], options.file);
  const firstError = diagnostics.find((d) => d.severity === "error");
  return { workspace: resolved.workspace, diagnostics, firstError, ok: firstError === undefined, syntax };
}
