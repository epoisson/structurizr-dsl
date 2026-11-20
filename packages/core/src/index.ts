export type { Position, Range, Severity, Diagnostic } from "./types.ts";
export type { Token, TokenKind, Comment, TokenizeResult } from "./tokenizer.ts";
export { tokenize } from "./tokenizer.ts";
export type { Argument, BlockNode, FileNode, StatementForm, StatementNode } from "./syntax.ts";
export type { ParseResult, ParseOptions } from "./parser.ts";
export type { IncludeHost, AsyncIncludeHost } from "./include.ts";
export type { IncludeLink, PreprocessOptions } from "./preprocess.ts";
export { sortDiagnostics, span } from "./types.ts";
export { parse } from "./parser.ts";

export type {
  Element, ElementType, Relationship, Perspective, HealthCheck, View, ViewType, AutoLayout, DynamicStep,
  ImageSource, ElementStyle, RelationshipStyle, StyleSet, UserRole, Workspace,
} from "./resolver/model.ts";
export { emptyWorkspace } from "./resolver/model.ts";
export type { ResolveResult } from "./resolver/resolver.ts";
export { resolve } from "./resolver/resolver.ts";
export type { WorkspaceIndex } from "./resolver/query.ts";
export { indexWorkspace } from "./resolver/query.ts";
export type { LoadResult } from "./load.ts";
export { load } from "./load.ts";
export type { AsyncLoadOptions } from "./load-async.ts";
export { loadAsync } from "./load-async.ts";

// Grammar tables (the single source of truth for keywords): used by editor features and tooling
export type { Statement as GrammarStatement, Context as GrammarContext } from "./grammar/inventory.ts";
export { CONTEXTS, GLOBAL_DIRECTIVES, ENUMS } from "./grammar/inventory.ts";
export type { ResolvedContext } from "./grammar/lookup.ts";
export { getContext, GLOBALS } from "./grammar/lookup.ts";
