import type { Comment, Token } from "./tokenizer.ts";
import { tokenize } from "./tokenizer.ts";
import type { Diagnostic, Range, Severity } from "./types.ts";
import { dirname, isDslFile, isHttps, isInsecureUrl, resolveLocalTarget } from "./include.ts";
import type { IncludeHost } from "./include.ts";

/**
 * The stage between the tokenizer and the parser: `!const`, `!var`, `${NAME}` substitution and `!include`.
 *
 * Structurizr processes the DSL line by line, in order, so this does too:
 *   - a `!const` / `!var` takes effect for the lines after it;
 *   - `${NAME}` is replaced inside any word or string token, from a constant/variable, else an environment variable;
 *     an unknown name is left as written;
 *   - `!include` inlines the target's tokens right after the directive, in discovery order, so a brace opened in
 *     one file may be closed in another. Constants defined before an include are visible inside it, and the other way round.
 *
 * The directive lines themselves stay in the token stream, so they appear in the syntax tree (and the editor can
 * show them); only their effect is applied here. Every token keeps the `file` it came from.
 */

export interface PreprocessOptions {
  /** Identity of the source being parsed (path or URI). Needed to resolve relative includes. */
  file?: string;
  /** File access for `!include`. Without it, includes are reported as unavailable and skipped. */
  host?: IncludeHost;
  /** Environment variables for `${NAME}`. Constants and variables win over these. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Predefined constants (for example from the command line). They win over `!const`/`!var` of the same name in the file. */
  variables?: Readonly<Record<string, string>>;
  /** Deepest allowed nesting of includes. Default 32. */
  maxIncludeDepth?: number;
}

/** One `!include`, for editor features such as links. */
export interface IncludeLink {
  /** The target argument in the including file. */
  range: Range;
  /** The target as written (after substitution). */
  target: string;
  /** The files it pulled in (several for a directory; none if it failed). */
  files: string[];
  /** The including file. */
  from: string | undefined;
}

export interface Preprocessed {
  tokens: Token[];
  comments: Comment[];
  /** Lexical diagnostics of every file, plus the preprocessor's own. */
  diagnostics: Diagnostic[];
  includes: IncludeLink[];
  /** Source text by file, so raw bodies can be sliced from the right file. */
  sources: Map<string | undefined, string>;
  /** Every file read through the host (not the root). */
  files: string[];
}

const NAME = /^[A-Za-z0-9\-_.]+$/;
const SUBSTITUTION = /\$\{([A-Za-z0-9\-_.]+)\}/g;
/** Statements whose `{ }` body is raw text in another language and must be left alone. */
const RAW_KEYWORDS = new Set(["!script", "!plugin", "!components"]);

const withValue = (t: Token, value: string): Token => ({ ...t, value });

class Preprocessor {
  private readonly vars = new Map<string, { value: string; constant: boolean }>();
  private readonly locked = new Set<string>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly comments: Comment[] = [];
  private readonly includes: IncludeLink[] = [];
  private readonly sources = new Map<string | undefined, string>();
  private readonly files: string[] = [];
  private readonly options: PreprocessOptions;
  private readonly maxDepth: number;

  constructor(options: PreprocessOptions) {
    this.options = options;
    this.maxDepth = options.maxIncludeDepth ?? 32;
    for (const [k, v] of Object.entries(options.variables ?? {})) {
      this.vars.set(k, { value: v, constant: true });
      this.locked.add(k);
    }
  }

  private report(code: string, message: string, range: Range, severity: Severity = "error"): void {
    this.diagnostics.push({ severity, code, message, range });
  }

  run(source: string, lexed: { tokens: Token[]; comments: Comment[]; diagnostics: Diagnostic[] }): Preprocessed {
    const file = this.options.file;
    this.sources.set(file, source);
    this.comments.push(...lexed.comments);
    this.diagnostics.push(...lexed.diagnostics);
    const { tokens, eof } = this.process(lexed.tokens, file, file === undefined ? [] : [file]);
    if (eof) tokens.push(eof);
    return { tokens, comments: this.comments, diagnostics: this.diagnostics, includes: this.includes, sources: this.sources, files: this.files };
  }

  // -------------------------------------------------------------------------
  // substitution
  // -------------------------------------------------------------------------

  private lookup(name: string): string | undefined {
    const v = this.vars.get(name);
    if (v) return v.value;
    const e = this.options.env?.[name];
    return e;
  }

  private substitute(t: Token): Token {
    if ((t.kind !== "word" && t.kind !== "string") || !t.value.includes("${")) return t;
    const value = t.value.replace(SUBSTITUTION, (whole, name: string) => this.lookup(name) ?? whole);
    return value === t.value ? t : withValue(t, value);
  }

  // -------------------------------------------------------------------------
  // the line loop
  // -------------------------------------------------------------------------

  private process(tokens: Token[], file: string | undefined, stack: string[]): { tokens: Token[]; eof?: Token } {
    const out: Token[] = [];
    let eof: Token | undefined;
    let rawDepth = 0;
    let i = 0;
    while (i < tokens.length) {
      const line: Token[] = [];
      let newline: Token | undefined;
      while (i < tokens.length) {
        const t = tokens[i++]!;
        if (t.kind === "newline") {
          newline = t;
          break;
        }
        if (t.kind === "eof") {
          eof = t;
          break;
        }
        line.push(t);
      }
      if (line.length === 0) {
        if (newline) out.push(newline);
        continue;
      }

      // inside a raw body (inline script): copied verbatim; nothing in it is a directive
      if (rawDepth > 0) {
        out.push(...line);
        if (newline) out.push(newline);
        if (line[line.length - 1]!.kind === "lbrace") rawDepth++;
        else if (line.length === 1 && line[0]!.kind === "rbrace") rawDepth--;
        continue;
      }

      const first = line[0]!;
      const keyword = first.kind === "word" ? first.value.toLowerCase() : "";
      const isDirective = keyword === "!const" || keyword === "!var" || keyword === "!include";
      const sub = line.map((t, idx) => (idx === 0 && isDirective ? t : this.substitute(t)));

      if (RAW_KEYWORDS.has(keyword) && sub[sub.length - 1]!.kind === "lbrace") rawDepth = 1;

      out.push(...sub);
      if (newline) out.push(newline);

      if (keyword === "!const" || keyword === "!var") this.define(keyword === "!const", sub);
      else if (keyword === "!include") out.push(...this.include(sub, file, stack));
    }
    return eof ? { tokens: out, eof } : { tokens: out };
  }

  private define(constant: boolean, line: Token[]): void {
    const nameTok = line[1];
    const valueTok = line[2];
    if (!nameTok || !valueTok) return; // the parser reports the missing arguments
    const name = nameTok.value;
    if (!NAME.test(name)) {
      this.report("invalid-variable-name", `'${name}' is not a valid name: use only a-z, A-Z, 0-9, '-', '_' and '.'.`, nameTok.range);
      return;
    }
    if (this.locked.has(name)) return; // predefined from outside: it wins, silently
    const existing = this.vars.get(name);
    if (existing?.constant) {
      this.report("constant-redefined", `'${name}' is a constant and cannot be redefined; keeping its first value. (Use !var for a value that changes.)`, nameTok.range, "warning");
      return;
    }
    this.vars.set(name, { value: valueTok.value, constant });
  }

  // -------------------------------------------------------------------------
  // !include
  // -------------------------------------------------------------------------

  private include(line: Token[], file: string | undefined, stack: string[]): Token[] {
    const targetTok = line[1];
    if (!targetTok) return []; // the parser reports the missing argument
    const target = targetTok.value;
    const host = this.options.host;
    const link: IncludeLink = { range: targetTok.range, target, files: [], from: file };
    this.includes.push(link);

    // 1. work out what to read
    const found: Array<{ id: string; text: string }> = [];
    let id: string;
    let remote = false;
    if (isInsecureUrl(target)) {
      this.report("include-insecure-url", "Only HTTPS URLs can be included.", targetTok.range);
      return [];
    }
    if (isHttps(target)) {
      id = target;
      remote = true;
    } else {
      if (!host || file === undefined) {
        this.report(
          "include-unavailable",
          !host ? `'!include ${target}' was skipped: no file access was provided.` : `'!include ${target}' was skipped: the location of this source is unknown, so a relative path cannot be resolved.`,
          targetTok.range,
          "warning",
        );
        return [];
      }
      const r = resolveLocalTarget(file, target);
      if (!r.ok) {
        this.report(r.code, r.message, targetTok.range);
        return [];
      }
      id = r.id;
      remote = isHttps(id); // a relative include from a file that was itself loaded from a URL
    }

    if (remote) {
      if (!host?.readUrl) {
        this.report("include-url-unavailable", "Including a URL is not enabled here.", targetTok.range);
        return [];
      }
      const text = host.readUrl(id);
      if (text === undefined) {
        this.report("include-not-found", `Could not load '${id}'.`, targetTok.range);
        return [];
      }
      found.push({ id, text });
    } else {
      const entries = host!.listDirectory?.(id);
      if (entries) {
        const dsl = entries.filter(isDslFile).sort();
        if (dsl.length === 0) this.report("include-empty-directory", `The directory '${target}' contains no .dsl files.`, targetTok.range, "warning");
        for (const entry of dsl) {
          const text = host!.readFile(entry);
          if (text === undefined) this.report("include-not-found", `Could not read '${entry}'.`, targetTok.range);
          else found.push({ id: entry, text });
        }
      } else {
        const text = host!.readFile(id);
        if (text === undefined) {
          this.report("include-not-found", `Could not find '${target}' (looked for ${id}).`, targetTok.range);
          return [];
        }
        found.push({ id, text });
      }
    }

    // 2. tokenize, check for cycles and depth, and process each (they may define variables and include more)
    const out: Token[] = [];
    for (const f of found) {
      if (stack.includes(f.id)) {
        this.report("include-cycle", `Including '${target}' would create a cycle: ${[...stack, f.id].map((s) => dirname(s) === "" ? s : s.slice(dirname(s).length + 1)).join(" -> ")}.`, targetTok.range);
        continue;
      }
      if (stack.length >= this.maxDepth) {
        this.report("include-depth", `Includes are nested more than ${this.maxDepth} deep.`, targetTok.range);
        continue;
      }
      const lexed = tokenize(f.text, f.id);
      this.sources.set(f.id, f.text);
      this.files.push(f.id);
      this.comments.push(...lexed.comments);
      this.diagnostics.push(...lexed.diagnostics);
      link.files.push(f.id);
      out.push(...this.process(lexed.tokens, f.id, [...stack, f.id]).tokens);
    }
    return out;
  }
}

export function preprocess(source: string, lexed: { tokens: Token[]; comments: Comment[]; diagnostics: Diagnostic[] }, options: PreprocessOptions = {}): Preprocessed {
  return new Preprocessor(options).run(source, lexed);
}
