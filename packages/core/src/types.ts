/**
 * Shared primitives used by every stage (tokenizer, parser, resolver).
 * Plain data only: JSON-serializable so it can cross the webview boundary.
 */

/** A position in the source. `line` and `column` are 0-based (matches VS Code). */
export interface Position {
  offset: number;
  line: number;
  column: number;
}

/** Half-open range: `start` inclusive, `end` exclusive. */
export interface Range {
  start: Position;
  end: Position;
  /**
   * The file the range is in. Set whenever the source has an identity (a file path or URI), which is always the
   * case for included files; absent for a bare source string.
   */
  file?: string;
}

/** The range from the start of `a` to the end of `b` (in the file of `a`). */
export function span(a: Range, b: Range): Range {
  const r: Range = { start: a.start, end: b.end };
  if (a.file !== undefined) r.file = a.file;
  return r;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. "unterminated-string". */
  code: string;
  message: string;
  range: Range;
}

/**
 * Orders diagnostics: the root file first, then other files by name, each by position. Offsets from
 * different files are not comparable, so the file is always compared first.
 */
export function sortDiagnostics(list: Diagnostic[], rootFile: string | undefined): Diagnostic[] {
  const rank = (d: Diagnostic): number => (d.range.file === rootFile ? 0 : 1);
  return [...list].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.range.file ?? "").localeCompare(b.range.file ?? "") ||
      a.range.start.offset - b.range.start.offset ||
      a.range.end.offset - b.range.end.offset,
  );
}
