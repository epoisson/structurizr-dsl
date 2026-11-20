import { GLOBALS, getContext, load } from "../../core/src/index.ts";
import type { BlockNode, Diagnostic, Element, GrammarStatement, IncludeHost, LoadResult, ParseOptions, Range, Relationship, StatementNode } from "../../core/src/index.ts";

/**
 * Editor features as plain functions over the parsed and resolved document. Nothing here imports
 * VS Code, so it is unit-testable and reusable by other editors; adapter.ts maps it onto the VS Code API.
 * All positions are 0-based line/column (UTF-16 code units, the same as VS Code).
 */

export interface Analysis {
  /** The text of the document being viewed. */
  source: string;
  lines: string[];
  result: LoadResult;
  /**
   * The identity (URI) of the document being viewed. Positions are only meaningful within one file, so every
   * feature considers just the statements whose range is in this file. Unset when the source has no location.
   */
  file?: string;
}

export function analyze(source: string, file?: string, host?: IncludeHost, options: Omit<ParseOptions, "file" | "host"> = {}): Analysis {
  const loadOptions: ParseOptions = { ...options, ...(file !== undefined ? { file } : {}), ...(host ? { host } : {}) };
  const a: Analysis = { source, lines: source.split("\n"), result: load(source, loadOptions) };
  if (file !== undefined) a.file = file;
  return a;
}

/** Is this range in the document being viewed (as opposed to a file it includes)? */
const isOwn = (a: Analysis, r: Range): boolean => a.file === undefined || r.file === undefined || r.file === a.file;

const inRange = (r: Range, line: number, col: number): boolean =>
  (line > r.start.line || (line === r.start.line && col >= r.start.column)) &&
  (line < r.end.line || (line === r.end.line && col <= r.end.column));

function walk(children: StatementNode[], fn: (s: StatementNode) => void, keep: (s: StatementNode) => boolean = () => true): void {
  for (const s of children) {
    if (keep(s)) fn(s);
    // always descend: a fragment's own statements sit inside blocks that belong to the including file
    if (s.body) walk(s.body.children, fn, keep);
  }
}

/** Walks the statements of the viewed document only (not those pulled in from included files). */
const walkOwn = (a: Analysis, fn: (s: StatementNode) => void): void => walk(a.result.syntax.root.children, fn, (s) => isOwn(a, s.range));

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

export interface OutlineItem {
  name: string;
  detail: string;
  /** A VS Code SymbolKind name, e.g. "Class". */
  kind: string;
  range: Range;
  selectionRange: Range;
  children: OutlineItem[];
}

const ELEMENT_KINDS: Record<string, string> = {
  workspace: "Namespace",
  model: "Module",
  views: "Module",
  configuration: "Module",
  styles: "Module",
  archetypes: "Module",
  terminology: "Module",
  group: "Namespace",
  person: "Class",
  softwareSystem: "Struct",
  container: "Interface",
  component: "Method",
  deploymentEnvironment: "Namespace",
  deploymentNode: "Package",
  infrastructureNode: "Object",
  softwareSystemInstance: "Variable",
  containerInstance: "Variable",
  element: "Object",
};

/** Position of the key argument per view keyword. */
const VIEW_KEY_ARG: Record<string, number> = {
  systemLandscape: 0, systemContext: 1, container: 1, component: 1, filtered: 3, dynamic: 1, deployment: 2, custom: 0, image: 1,
};

function outlineItem(s: StatementNode, a?: Analysis): OutlineItem | undefined {
  if (!s.known) return undefined;
  let kind: string | undefined;
  let name: string;

  if (s.form === "archetype" && s.identifier) {
    kind = "TypeParameter";
    name = s.identifier.value;
  } else if (s.form !== "keyword") {
    return undefined;
  } else if (s.context === "views" && s.keyword in VIEW_KEY_ARG) {
    kind = "Event";
    const key = s.args[VIEW_KEY_ARG[s.keyword]!]?.value;
    name = `${s.keyword}${key ? `: ${key}` : ""}`;
  } else if ((s.context === "styles" || s.context === "stylesMode") && (s.keyword === "element" || s.keyword === "relationship")) {
    kind = "Key";
    name = `${s.keyword} ${s.args[0]?.value ?? ""}`.trim();
  } else if (s.context === "styles" && (s.keyword === "light" || s.keyword === "dark")) {
    kind = "Namespace";
    name = s.keyword;
  } else if (ELEMENT_KINDS[s.keyword]) {
    kind = ELEMENT_KINDS[s.keyword];
    const first = s.args[0]?.value;
    name = s.keyword === "softwareSystemInstance" || s.keyword === "containerInstance" ? `${s.keyword} ${first ?? ""}`.trim() : first || s.keyword;
  } else {
    return undefined;
  }

  const sel = s.args[0]?.range ?? s.keywordRange;
  return {
    name,
    detail: s.identifier ? `${s.identifier.value} = ${s.keyword}` : s.keyword,
    kind: kind!,
    range: s.range,
    selectionRange: inRange(s.range, sel.start.line, sel.start.column) ? sel : s.range,
    children: s.body ? outlineOf(s.body.children, a) : [],
  };
}

export function outlineOf(children: StatementNode[], a?: Analysis): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const s of children) {
    if (a && !isOwn(a, s.range)) {
      // not in the viewed file (an including file's block, or an included file's statement): show only what it holds of ours
      if (s.body) out.push(...outlineOf(s.body.children, a));
      continue;
    }
    const item = outlineItem(s, a);
    if (item) out.push(item);
  }
  return out;
}

export const outline = (a: Analysis): OutlineItem[] => outlineOf(a.result.syntax.root.children, a);

// ---------------------------------------------------------------------------
// folding
// ---------------------------------------------------------------------------

export interface FoldRange {
  startLine: number;
  endLine: number;
  kind?: "comment";
}

export function foldingRanges(a: Analysis): FoldRange[] {
  const out: FoldRange[] = [];
  walkOwn(a, (s) => {
    const b = s.body;
    if (!b) return;
    // fold from the line with `{` to the line before `}` (an unclosed block folds to its last line)
    const end = b.closed ? b.range.end.line - 1 : b.range.end.line;
    if (end > b.range.start.line) out.push({ startLine: b.range.start.line, endLine: end });
  });
  for (const c of a.result.syntax.comments) {
    if (isOwn(a, c.range) && c.style === "block" && c.range.end.line > c.range.start.line) {
      out.push({ startLine: c.range.start.line, endLine: c.range.end.line, kind: "comment" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// words, hover, definition
// ---------------------------------------------------------------------------

export function wordAt(line: string, col: number): { text: string; start: number; end: number } | undefined {
  const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_.!]/.test(c);
  let start = col;
  let end = col;
  while (start > 0 && isWord(line[start - 1])) start--;
  while (end < line.length && isWord(line[end])) end++;
  // trim stray dots at the edges ("ss.api." while typing)
  while (start < end && line[start] === ".") start++;
  while (end > start && line[end - 1] === ".") end--;
  const text = line.slice(start, end);
  return text ? { text, start, end } : undefined;
}

function describe(el: Element, a: Analysis): string {
  const parent = el.parentId ? a.result.workspace.model.elements.find((e) => e.id === el.parentId) : undefined;
  const lines = [`**${el.name}** · ${el.type}${el.technology ? ` · ${el.technology}` : ""}`];
  if (el.description) lines.push(el.description);
  if (parent) lines.push(`in ${parent.name}`);
  lines.push(`tags: ${el.tags.join(", ")}`);
  return lines.join("\n\n");
}

function describeRel(r: Relationship, a: Analysis): string {
  const name = (id: string): string => a.result.workspace.model.elements.find((e) => e.id === id)?.name ?? "?";
  return `**${name(r.sourceId)}** → **${name(r.destinationId)}**${r.description ? `: ${r.description}` : ""}${r.technology ? ` [${r.technology}]` : ""}`;
}

function specFor(s: StatementNode): GrammarStatement | undefined {
  const key = s.keyword.toLowerCase();
  return getContext(s.context)?.keywords.get(key) ?? GLOBALS.get(key);
}

export interface HoverInfo {
  range: Range;
  markdown: string;
}

export function hoverAt(a: Analysis, line: number, col: number): HoverInfo | undefined {
  // 1. a keyword: show its syntax from the grammar inventory
  let hit: HoverInfo | undefined;
  walkOwn(a, (s) => {
    if (hit || !s.known || s.form !== "keyword" || !inRange(s.keywordRange, line, col)) return;
    const spec = specFor(s);
    if (!spec) return;
    const md = ["```text", spec.syntax.split(/\s{3,}\|\s{3,}/).join("\n"), "```"];
    if (spec.note) md.push(spec.note);
    if (spec.status && spec.status !== "planned") md.push(`_${spec.status}_`);
    hit = { range: s.keywordRange, markdown: md.join("\n") };
  });
  if (hit) return hit;

  // 2. an identifier: show what it refers to
  const w = wordAt(a.lines[line] ?? "", col);
  if (!w) return undefined;
  const model = a.result.workspace.model;
  const range = { start: { offset: 0, line, column: w.start }, end: { offset: 0, line, column: w.end } };
  const el = model.elements.find((e) => e.identifier === w.text);
  if (el) return { range, markdown: describe(el, a) };
  const rel = model.relationships.find((r) => r.identifier === w.text);
  if (rel) return { range, markdown: describeRel(rel, a) };
  return undefined;
}

export function definitionAt(a: Analysis, line: number, col: number): { line: number; column: number; file?: string } | undefined {
  const w = wordAt(a.lines[line] ?? "", col);
  if (!w) return undefined;
  const model = a.result.workspace.model;
  const target = model.elements.find((e) => e.identifier === w.text) ?? model.relationships.find((r) => r.identifier === w.text);
  if (!target) return undefined;
  const at: { line: number; column: number; file?: string } = { line: target.range.start.line, column: target.range.start.column };
  if (target.range.file !== undefined) at.file = target.range.file; // may be an included file
  return at;
}

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

export interface CompletionEntry {
  label: string;
  kind: "Keyword" | "Variable";
  detail: string;
  documentation?: string;
  /** VS Code snippet syntax. */
  insertText: string;
}

/** The innermost block containing the position, if any. */
function blockAt(a: Analysis, line: number, col: number): BlockNode | undefined {
  let best: BlockNode | undefined;
  walkOwn(a, (s) => {
    const b = s.body;
    if (!b) return;
    const afterOpen = line > b.range.start.line || (line === b.range.start.line && col > b.range.start.column);
    const beforeClose = !b.closed || line < b.range.end.line || (line === b.range.end.line && col <= b.range.end.column - 1);
    if (afterOpen && beforeClose) best = b;
  });
  return best;
}

export function completionsAt(a: Analysis, line: number, col: number): CompletionEntry[] {
  const before = (a.lines[line] ?? "").slice(0, col);
  const out: CompletionEntry[] = [];

  // Start of a statement: offer the keywords valid in the surrounding block.
  if (/^\s*[A-Za-z!]*$/.test(before)) {
    const block = blockAt(a, line, col);
    const contextId = block ? block.context : fragmentContext(a) ?? "file";
    if (contextId === "?" || contextId === "raw") return [];
    const ctx = getContext(contextId);
    if (!ctx) return [];
    for (const spec of [...ctx.keywords.values(), ...GLOBALS.values()]) {
      if (spec.status === "deprecated") continue;
      const body = spec.block === "required" ? " {\n\t$0\n}" : "";
      out.push({
        label: spec.keyword,
        kind: "Keyword",
        detail: spec.syntax.split(/\s{3,}\|\s{3,}/)[0]!,
        documentation: spec.note,
        insertText: spec.keyword.replace(/[$}\\]/g, "\\$&") + body,
      });
    }
    return out;
  }

  // Elsewhere on the line: identifiers (relationship ends, view scopes, instances, ...).
  const model = a.result.workspace.model;
  for (const e of model.elements) {
    if (!e.identifier) continue;
    out.push({ label: e.identifier, kind: "Variable", detail: `${e.type}: ${e.name}`, documentation: e.description || undefined, insertText: e.identifier });
  }
  for (const r of model.relationships) {
    if (r.identifier) out.push({ label: r.identifier, kind: "Variable", detail: "relationship", insertText: r.identifier });
  }
  out.push({ label: "this", kind: "Keyword", detail: "the element in scope", insertText: "this" });
  return out;
}

// ---------------------------------------------------------------------------
// includes, fragments and files
// ---------------------------------------------------------------------------

/** The `!include` targets in the viewed document, for links. */
export function documentLinks(a: Analysis): Array<{ range: Range; target: string }> {
  return a.result.syntax.includes
    .filter((l) => isOwn(a, l.range) && l.files.length > 0)
    .map((l) => ({ range: l.range, target: l.files[0]! }));
}

/** Diagnostics grouped by the file they are in (the viewed document's own are keyed by its identity). */
export function diagnosticsByFile(a: Analysis, rootKey: string): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  for (const d of a.result.diagnostics) {
    const key = d.range.file ?? rootKey;
    (out.get(key) ?? out.set(key, []).get(key)!).push(d);
  }
  return out;
}

/**
 * A file with statements but no `workspace` is a fragment: it only makes sense pulled into a workspace by
 * `!include`, so analysing it alone would report an error on every line.
 */
export function isFragment(a: Analysis): boolean {
  const own: StatementNode[] = a.result.syntax.root.children.filter((s) => isOwn(a, s.range));
  const real = own.filter((s) => !(s.form === "keyword" && /^!(include|const|var)$/i.test(s.keyword)));
  return real.length > 0 && !real.some((s) => s.keyword === "workspace" && s.known);
}

/** The analysis of a workspace, seen from one of the files it includes: same model, that file's text and statements. */
export function viewFromFragment(workspace: Analysis, file: string, text: string): Analysis {
  return { ...workspace, source: text, lines: text.split("\n"), file };
}

/** Which context a fragment's top-level statements sit in: that of the `!include` that pulled it in. */
function fragmentContext(a: Analysis): string | undefined {
  if (a.file === undefined) return undefined;
  const link = a.result.syntax.includes.find((l) => l.files.includes(a.file!));
  if (!link) return undefined;
  let found: string | undefined;
  walk(a.result.syntax.root.children, (s) => {
    const arg = s.args[0];
    if (!found && /^!include$/i.test(s.keyword) && arg && arg.range.file === link.range.file && arg.range.start.offset === link.range.start.offset) found = s.context;
  });
  return found;
}
