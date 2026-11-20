import type { Diagnostic, Position, Range } from "./types.ts";

/**
 * Structurizr DSL tokenizer.
 *
 * The DSL is line-oriented: a statement is the tokens on one logical line
 * (physical lines joined by a trailing backslash). `newline` tokens are
 * therefore significant and are emitted, but only for lines that contain at
 * least one token (blank and comment-only lines produce nothing).
 *
 * The tokenizer never throws. Lexical problems (unterminated strings, block
 * comments, text blocks) are reported as diagnostics and tokenizing continues,
 * so later stages can still work with a best-effort token stream.
 */

export type TokenKind =
  | "word" // bare token: keywords, identifiers, !directives, numbers, #colours, URLs
  | "string" // "quoted" or """text block"""
  | "lbrace" // {
  | "rbrace" // }
  | "equals" // =  (identifier assignment)
  | "arrow" // -> , --archetype-> , -/>  (relationship operators; `->x` or `*->*` are words)
  | "newline" // end of a logical line
  | "eof";

export interface Token {
  kind: TokenKind;
  /** Exact source text of the token, including quotes. */
  text: string;
  /** For strings: the content without quotes, with escapes resolved. Otherwise equals `text`. */
  value: string;
  range: Range;
  /** True for """text blocks""". Only set on string tokens. */
  textBlock?: boolean;
}

export interface Comment {
  style: "line" | "block";
  text: string;
  range: Range;
}

export interface TokenizeResult {
  tokens: Token[];
  /** Comments are kept out of the token stream but retained for tooling (folding, formatting). */
  comments: Comment[];
  diagnostics: Diagnostic[];
}

/** Maps offsets to 0-based line/column positions. */
class LineIndex {
  private readonly starts: number[] = [0];
  private readonly file: string | undefined;

  constructor(source: string, file?: string) {
    this.file = file;
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10 /* \n */) this.starts.push(i + 1);
    }
  }

  positionAt(offset: number): Position {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { offset, line: lo, column: offset - this.starts[lo]! };
  }

  range(start: number, end: number): Range {
    const r: Range = { start: this.positionAt(start), end: this.positionAt(end) };
    if (this.file !== undefined) r.file = this.file;
    return r;
  }
}

const isSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === "\u00a0";

/** `->`, relationship archetypes such as `--https->`, and the remove operator `-/>`. */
const ARROW = /^(->|-\/>|--[A-Za-z0-9_.]+->)$/;

const CLOSING_QUOTE: Record<string, string> = { '"': '"', "\u201c": "\u201d" }; // “ ”

/** `file` identifies the source (a path or URI); it is recorded on every range so tokens from included files can be told apart. */
export function tokenize(source: string, file?: string): TokenizeResult {
  const index = new LineIndex(source, file);
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const diagnostics: Diagnostic[] = [];
  const n = source.length;

  let i = 0;
  /** True once the current logical line has produced a token. */
  let lineHasTokens = false;

  const push = (
    kind: TokenKind,
    start: number,
    end: number,
    value?: string,
    textBlock?: boolean,
  ): void => {
    const text = source.slice(start, end);
    const token: Token = { kind, text, value: value ?? text, range: index.range(start, end) };
    if (textBlock) token.textBlock = true;
    tokens.push(token);
    if (kind !== "newline" && kind !== "eof") lineHasTokens = true;
  };

  const report = (code: string, message: string, start: number, end: number): void => {
    diagnostics.push({ severity: "error", code, message, range: index.range(start, end) });
  };

  while (i < n) {
    const c = source[i]!;

    // --- end of physical line -------------------------------------------------
    if (c === "\n") {
      if (lineHasTokens) push("newline", i, i + 1);
      lineHasTokens = false;
      i++;
      continue;
    }

    // --- whitespace -----------------------------------------------------------
    if (isSpace(c)) {
      i++;
      continue;
    }

    // --- line continuation: backslash, optional trailing space, newline ---------
    if (c === "\\") {
      let j = i + 1;
      while (j < n && isSpace(source[j]!)) j++;
      if (j < n && source[j] === "\n") {
        i = j + 1; // join with the next physical line; no newline token
        continue;
      }
      if (j >= n) {
        i = j; // trailing backslash at EOF
        continue;
      }
      // otherwise a backslash is just part of a word; fall through
    }

    // --- block comment ----------------------------------------------------------
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      if (close === -1) {
        report("unterminated-block-comment", "Unterminated block comment (missing '*/').", i, n);
      }
      comments.push({ style: "block", text: source.slice(i, end), range: index.range(i, end) });
      i = end;
      continue;
    }

    // --- line comment -------------------------------------------------------------
    // `//` starts a comment wherever a token could start (so URLs like
    // https://x are safe: the `//` is mid-word). `#` only starts a comment as
    // the first token of a line, so colours such as `#ff0000` stay words.
    if ((c === "/" && source[i + 1] === "/") || (c === "#" && !lineHasTokens)) {
      let end = source.indexOf("\n", i);
      if (end === -1) end = n;
      let textEnd = end;
      if (textEnd > i && source[textEnd - 1] === "\r") textEnd--;
      comments.push({ style: "line", text: source.slice(i, textEnd), range: index.range(i, textEnd) });
      i = end; // leave the newline for the main loop
      continue;
    }

    // --- text block: """ ... """ ---------------------------------------------------
    if (c === '"' && source.startsWith('"""', i)) {
      const close = source.indexOf('"""', i + 3);
      if (close === -1) {
        report("unterminated-text-block", 'Unterminated text block (missing closing """).', i, n);
        push("string", i, n, source.slice(i + 3), true);
        i = n;
      } else {
        push("string", i, close + 3, source.slice(i + 3, close), true);
        i = close + 3;
      }
      continue;
    }

    // --- quoted string ------------------------------------------------------------
    const closer = CLOSING_QUOTE[c];
    if (closer !== undefined) {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < n) {
        const ch = source[j]!;
        if (ch === "\n") break; // strings cannot span lines
        if (ch === "\\" && (source[j + 1] === closer || source[j + 1] === "\\")) {
          value += source[j + 1];
          j += 2;
          continue;
        }
        if (ch === closer) {
          closed = true;
          j++;
          break;
        }
        value += ch;
        j++;
      }
      if (!closed) {
        // Drop a trailing \r so CRLF files don't leak it into the value/range.
        if (value.endsWith("\r")) {
          value = value.slice(0, -1);
          j--;
        }
        report("unterminated-string", "Unterminated string (missing closing quote).", i, j);
      }
      push("string", i, j, value);
      i = j;
      continue;
    }

    // --- bare word (and the symbols that are words delimited by whitespace) ---------
    let j = i;
    while (j < n && !isSpace(source[j]!) && source[j] !== "\n") j++;
    const text = source.slice(i, j);
    const kind: TokenKind =
      text === "{" ? "lbrace" : text === "}" ? "rbrace" : text === "=" ? "equals" : ARROW.test(text) ? "arrow" : "word";
    push(kind, i, j);
    i = j;
  }

  if (lineHasTokens) push("newline", n, n);
  push("eof", n, n);

  return { tokens, comments, diagnostics };
}
