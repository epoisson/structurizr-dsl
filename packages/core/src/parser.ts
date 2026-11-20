import { sortDiagnostics, span } from "./types.ts";
import type { Diagnostic, Range, Severity } from "./types.ts";
import { tokenize } from "./tokenizer.ts";
import { preprocess } from "./preprocess.ts";
import type { IncludeLink, PreprocessOptions } from "./preprocess.ts";
import type { Comment, Token } from "./tokenizer.ts";
import type { Argument, BlockNode, FileNode, StatementForm, StatementNode } from "./syntax.ts";
import { ENUMS } from "./grammar/inventory.ts";
import type { Statement } from "./grammar/inventory.ts";
import { GLOBALS, getContext } from "./grammar/lookup.ts";
import type { ResolvedContext } from "./grammar/lookup.ts";
import { arityOf } from "./grammar/arity.ts";

/**
 * Structurizr DSL parser: tokens -> syntax tree.
 *
 * Error tolerant: it never throws and always returns a tree. Each problem becomes a diagnostic and
 * parsing resumes on the next line, so a mistake does not hide the rest of the file. After a
 * statement with an unknown keyword (or a body where none is allowed) its body is parsed "leniently":
 * the brace structure is still tracked but contents are not validated, which avoids cascades.
 *
 * Not done here (later stages): identifier resolution, enum value checks, expression parsing,
 * `!include` / `!const` / `!var` (recognised, ignored, warned about).
 */

export interface ParseResult {
  root: FileNode;
  comments: Comment[];
  /** Lexical and syntax diagnostics together, ordered by position. */
  diagnostics: Diagnostic[];
  /** The earliest error by position (root file first), if any. */
  firstError: Diagnostic | undefined;
  /** Every `!include` met, with the files it pulled in. */
  includes: IncludeLink[];
  /** Files read through the include host (not counting the root): what this result depends on. */
  files: string[];
}

/** Options for `parse` and `load`: where the source lives and how to reach included files. */
export type ParseOptions = PreprocessOptions;

/** Context id used for bodies that are parsed without validation. */
const LENIENT = "?";

/** Contexts with no element in scope, so `-> x` (implicit source) makes no sense. */
const NO_ELEMENT_IN_SCOPE = new Set(["model", "deploymentEnvironment", "viewDynamic"]);

/** Pseudo statement used for relationship lines inside dynamic views. */
const DYNAMIC_RELATIONSHIP: Statement = {
  keyword: "->",
  syntax: "<source> -> <destination> [description] [technology]",
  kind: "operator",
  block: "none",
};

const ORDER_PREFIX = /^\S+:$/;

const rangeOf = (a: { range: Range }, b: { range: Range }): Range => span(a.range, b.range);

function toArg(t: Token): Argument {
  const a: Argument = { value: t.value, raw: t.text, quoted: t.kind === "string", range: t.range };
  if (t.textBlock) a.textBlock = true;
  return a;
}

const isName = (t: Token): boolean => t.kind === "word" || t.kind === "string";
const plural = (n: number): string => `${n} argument${n === 1 ? "" : "s"}`;

class Parser {
  private pos = 0;
  readonly diagnostics: Diagnostic[] = [];
  /** Source ranges of raw bodies; tokenizer diagnostics inside them are discarded. */
  readonly rawRanges: Array<{ file: string | undefined; start: number; end: number }> = [];
  /** Element archetypes defined so far: lower-cased name -> canonical base kind. */
  private readonly archetypes = new Map<string, string>();
  /** Relationship archetype names defined so far (lower-cased). */
  private readonly relationshipArchetypes = new Set<string>();
  private workspaceSeen = false;
  private readonly sources: Map<string | undefined, string>;
  private readonly tokens: Token[];

  constructor(sources: Map<string | undefined, string>, tokens: Token[]) {
    this.sources = sources;
    this.tokens = tokens;
  }

  private sourceOf(t: Token): string {
    return this.sources.get(t.range.file) ?? "";
  }

  // -------------------------------------------------------------------------
  // token plumbing
  // -------------------------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1]!;
  }

  private advance(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  /** Tokens up to the end of the logical line; consumes the newline. */
  private readLine(): Token[] {
    const out: Token[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind === "eof") break;
      this.pos++;
      if (t.kind === "newline") break;
      out.push(t);
    }
    return out;
  }

  private report(code: string, message: string, range: Range, severity: Severity = "error"): void {
    this.diagnostics.push({ severity, code, message, range });
  }

  // -------------------------------------------------------------------------
  // structure
  // -------------------------------------------------------------------------

  parseFile(): FileNode {
    const ctx = getContext("file")!;
    const children: StatementNode[] = [];
    const first = this.peek();
    while (this.peek().kind !== "eof") {
      const t = this.peek();
      if (t.kind === "newline") {
        this.advance();
        continue;
      }
      if (t.kind === "rbrace") {
        this.report("unexpected-closing-brace", "Unexpected '}': there is no open block.", t.range);
        this.readLine();
        continue;
      }
      const s = this.parseStatement(ctx);
      if (s) children.push(s);
    }
    const eof = this.peek();
    return { type: "file", children, range: span(first.range, eof.range) };
  }

  /** Parses statements up to the matching `}`. The opening line (including its newline) is already consumed. */
  private parseBody(contextId: string, opener: Token): BlockNode {
    const ctx = contextId === LENIENT ? undefined : getContext(contextId);
    const children: StatementNode[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind === "eof") {
        this.report("unclosed-block", "Missing closing '}' for the block opened here.", opener.range);
        return { type: "block", context: contextId, children, range: span(opener.range, t.range), closed: false };
      }
      if (t.kind === "newline") {
        this.advance();
        continue;
      }
      if (t.kind === "rbrace") {
        this.advance();
        const next = this.peek();
        if (next.kind === "newline") this.advance();
        else if (next.kind !== "eof") {
          this.report("closing-brace-position", "'}' must be on a line of its own.", t.range);
          this.readLine();
        }
        return { type: "block", context: contextId, children, range: rangeOf(opener, t), closed: true };
      }
      const s = this.parseStatement(ctx);
      if (s) children.push(s);
    }
  }

  /** Raw body (inline scripts): skipped, not tokenized into statements. Ends at the matching lone `}`. */
  private parseRawBody(opener: Token): BlockNode {
    let depth = 1;
    let atLineStart = true;
    for (;;) {
      const t = this.peek();
      if (t.kind === "eof") {
        this.report("unclosed-block", "Missing closing '}' for the block opened here.", opener.range);
        const end = t.range.end;
        this.rawRanges.push({ file: opener.range.file, start: opener.range.end.offset, end: end.offset });
        return { type: "block", context: "raw", children: [], raw: this.sourceOf(opener).slice(opener.range.end.offset), range: { ...span(opener.range, t.range), end }, closed: false };
      }
      this.advance();
      if (t.kind === "newline") {
        atLineStart = true;
        continue;
      }
      const next = this.peek();
      const endsLine = next.kind === "newline" || next.kind === "eof";
      if (t.kind === "lbrace" && endsLine) depth++;
      else if (t.kind === "rbrace" && atLineStart && endsLine) {
        depth--;
        if (depth === 0) {
          if (next.kind === "newline") this.advance();
          this.rawRanges.push({ file: opener.range.file, start: opener.range.end.offset, end: t.range.start.offset });
          return {
            type: "block",
            context: "raw",
            children: [],
            raw: this.sourceOf(opener).slice(opener.range.end.offset, t.range.start.offset),
            range: rangeOf(opener, t),
            closed: true,
          };
        }
      }
      atLineStart = false;
    }
  }

  // -------------------------------------------------------------------------
  // statements
  // -------------------------------------------------------------------------

  private parseStatement(ctx: ResolvedContext | undefined): StatementNode | null {
    let line = this.readLine();

    // Brace placement: `{` is the last token of the line; `}` only ever stands alone.
    let opener: Token | undefined;
    const lb = line.findIndex((t) => t.kind === "lbrace");
    if (lb >= 0) {
      if (lb !== line.length - 1) this.report("opening-brace-position", "'{' must be the last token on its line.", line[lb]!.range);
      opener = line[lb];
      line = line.slice(0, lb);
    }
    line = line.filter((t) => {
      if (t.kind !== "rbrace") return true;
      this.report("closing-brace-position", "'}' must be on a line of its own.", t.range);
      return false;
    });

    if (line.length === 0) {
      if (opener) {
        this.report("opening-brace-position", "'{' must be on the same line as the statement it opens.", opener.range);
        this.parseBody(LENIENT, opener);
      }
      return null;
    }

    if (!ctx) return this.genericStatement(line, opener);

    const lineKind = ctx.ctx.lineKind;
    if (lineKind === "archetype") return this.archetypeDefinition(ctx, line, opener);

    // `name = ...` identifier prefix
    let identifier: Argument | undefined;
    let rest = line;
    if (line.length >= 2 && line[1]!.kind === "equals" && isName(line[0]!)) {
      identifier = toArg(line[0]!);
      rest = line.slice(2);
      if (rest.length === 0) {
        this.report("expected-statement", "Expected a statement after '='.", line[1]!.range);
        if (opener) this.parseBody(LENIENT, opener);
        return null;
      }
    } else if (line[0]!.kind === "equals") {
      this.report("unexpected-token", "Unexpected '='.", line[0]!.range);
      rest = line.slice(1);
      if (rest.length === 0) {
        if (opener) this.parseBody(LENIENT, opener);
        return null;
      }
    }

    // pair / identifier-list lines (properties, users, animation, perspectives)
    if (lineKind === "pair" || lineKind === "identifiers") {
      const first = rest[0]!;
      if (first.kind === "word" && ctx.keywords.has(first.value.toLowerCase())) {
        return this.keywordStatement(ctx, line, identifier, rest, opener);
      }
      return this.lineStatement(ctx, line, opener);
    }

    // dynamic view lines: [order:] a -> b ..., [order:] relationshipId ...
    let order: Argument | undefined;
    if (lineKind === "dynamic" && rest.length >= 2 && rest[0]!.kind === "word" && ORDER_PREFIX.test(rest[0]!.text)) {
      order = toArg(rest[0]!);
      rest = rest.slice(1);
    }
    const startsWithKeyword = rest[0]!.kind === "word" && ctx.keywords.has(rest[0]!.value.toLowerCase());
    if (!(lineKind === "dynamic" && startsWithKeyword)) {
      const arrowIdx = rest.findIndex((t) => t.kind === "arrow");
      if (arrowIdx >= 0) return this.relationshipStatement(ctx, line, identifier, order, rest, arrowIdx, opener);
      if (lineKind === "dynamic") return this.lineStatement(ctx, line, opener, order ? 1 : 0);
    }
    return this.keywordStatement(ctx, line, identifier, rest, opener);
  }

  /** No validation: used for bodies under an unknown/invalid statement. */
  private genericStatement(line: Token[], opener: Token | undefined): StatementNode {
    let identifier: Argument | undefined;
    let rest = line;
    if (line.length >= 2 && line[1]!.kind === "equals" && isName(line[0]!)) {
      identifier = toArg(line[0]!);
      rest = line.slice(2);
    }
    const arrowIdx = rest.findIndex((t) => t.kind === "arrow");
    let form: StatementForm = "keyword";
    let source: Argument | undefined;
    let operator: Argument | undefined;
    let head = rest[0];
    let argTokens = rest.slice(1);
    if (arrowIdx >= 0) {
      form = "relationship";
      if (arrowIdx >= 1 && isName(rest[arrowIdx - 1]!)) source = toArg(rest[arrowIdx - 1]!);
      operator = toArg(rest[arrowIdx]!);
      head = rest[arrowIdx];
      argTokens = rest.slice(arrowIdx + 1);
    }
    const first = head ?? line[0]!;
    const node = this.node(form, LENIENT, first.value, first, false, line, argTokens.filter(isName).map(toArg));
    if (identifier) node.identifier = identifier;
    if (source) node.source = source;
    if (operator) node.operator = operator;
    if (opener) this.attachBody(node, this.parseBody(LENIENT, opener));
    return node;
  }

  private archetypeDefinition(ctx: ResolvedContext, line: Token[], opener: Token | undefined): StatementNode | null {
    const syntaxHelp = "Expected '<name> = <baseKind|archetype|->|--archetype->> [{'.";
    if (line.length !== 3 || line[1]!.kind !== "equals" || !isName(line[0]!) || (line[2]!.kind !== "word" && line[2]!.kind !== "arrow")) {
      this.report("invalid-archetype-definition", `Invalid archetype definition. ${syntaxHelp}`, rangeOf(line[0]!, line[line.length - 1]!));
      if (opener) this.parseBody(LENIENT, opener);
      return null;
    }
    const nameTok = line[0]!;
    const baseTok = line[2]!;
    const name = nameTok.value.toLowerCase();
    let kind: "element" | "relationship";
    let base: string | undefined;
    let parent: string | undefined;
    let known = true;

    if (baseTok.kind === "arrow") {
      kind = "relationship";
      base = baseTok.text;
      if (baseTok.text !== "->") {
        parent = baseTok.text.slice(2, -2);
        if (!this.relationshipArchetypes.has(parent.toLowerCase())) {
          known = false;
          this.report("unknown-archetype", `Unknown relationship archetype '${baseTok.text.slice(2, -2)}'.`, baseTok.range);
        }
      }
      this.relationshipArchetypes.add(name);
    } else {
      kind = "element";
      const lower = baseTok.value.toLowerCase();
      const builtIn = ENUMS.archetypeBaseKinds.find((k) => k.toLowerCase() === lower);
      base = builtIn ?? this.archetypes.get(lower);
      if (base && !builtIn) parent = baseTok.value;
      if (base) this.archetypes.set(name, base);
      else {
        known = false;
        this.report(
          "unknown-archetype",
          `'${baseTok.value}' is not an element kind or a defined archetype (kinds: ${ENUMS.archetypeBaseKinds.join(", ")}).`,
          baseTok.range,
        );
      }
    }

    const node = this.node("archetype", ctx.id, base ?? baseTok.value, baseTok, known, line, []);
    node.identifier = toArg(nameTok);
    node.archetype = { kind, base: base ?? baseTok.value };
    if (parent) node.archetype.extends = parent;
    if (opener) this.attachBody(node, this.parseBody(kind === "element" ? "archetypeElement" : "archetypeRelationship", opener));
    return node;
  }

  private relationshipStatement(
    ctx: ResolvedContext,
    line: Token[],
    identifier: Argument | undefined,
    order: Argument | undefined,
    rest: Token[],
    arrowIdx: number,
    opener: Token | undefined,
  ): StatementNode {
    const arrow = rest[arrowIdx]!;
    const dynamic = ctx.ctx.lineKind === "dynamic";

    let source: Argument | undefined;
    if (arrowIdx >= 1) {
      const src = rest[arrowIdx - 1]!;
      if (arrowIdx > 1) {
        this.report("invalid-relationship", "Expected a single source identifier before the operator.", rangeOf(rest[0]!, src));
      }
      if (isName(src)) source = toArg(src);
    } else if (NO_ELEMENT_IN_SCOPE.has(ctx.id)) {
      this.report("no-implicit-source", `There is no element in scope here, so '${arrow.text}' needs an explicit source.`, arrow.range);
    }

    // classify the operator
    const label = arrow.text === "->" ? "->" : arrow.text === "-/>" ? "-/>" : "--<archetype>->";
    if (label === "--<archetype>->") {
      const archetype = arrow.text.slice(2, -2);
      if (!this.relationshipArchetypes.has(archetype.toLowerCase())) {
        this.report("unknown-archetype", `Unknown relationship archetype '${archetype}'.`, arrow.range);
      }
    }

    const spec = dynamic && label === "->" ? DYNAMIC_RELATIONSHIP : ctx.operators.get(label);
    const argTokens = rest.slice(arrowIdx + 1);
    const args = this.toArgs(argTokens);
    const node = this.node("relationship", ctx.id, label, arrow, spec !== undefined, line, args);
    node.operator = toArg(arrow);
    if (source) node.source = source;
    if (identifier) node.identifier = identifier;
    if (order) node.order = order;

    if (!spec) {
      this.report("unexpected-relationship", `Relationships ('${arrow.text}') are not permitted in ${ctx.title}.`, arrow.range);
      if (opener) this.attachBody(node, this.parseBody(LENIENT, opener));
      return node;
    }

    if (identifier && !spec.assignable) {
      this.report("not-assignable", "This statement cannot be assigned to an identifier.", identifier.range, "warning");
    }
    this.checkArity(spec, arrow.text, args, rangeOf(line[0]!, line[line.length - 1]!));
    this.attachBody(node, this.body(spec, opener, arrow.text, node.range));
    return node;
  }

  private keywordStatement(
    ctx: ResolvedContext,
    line: Token[],
    identifier: Argument | undefined,
    rest: Token[],
    opener: Token | undefined,
  ): StatementNode {
    const first = rest[0]!;
    const lineRange = rangeOf(line[0]!, line[line.length - 1]!);
    const argsFrom = (n: number): Argument[] => this.toArgs(rest.slice(n));

    const fail = (code: string, message: string): StatementNode => {
      this.report(code, message, first.range);
      const node = this.node("keyword", ctx.id, first.value, first, false, line, argsFrom(1));
      if (identifier) node.identifier = identifier;
      if (opener) this.attachBody(node, this.parseBody(LENIENT, opener));
      return node;
    };

    if (first.kind !== "word") return fail("expected-keyword", `Expected a keyword but found ${first.text}.`);

    const lower = first.value.toLowerCase();
    let spec: Statement | undefined = ctx.keywords.get(lower) ?? GLOBALS.get(lower);
    let usesArchetype: string | undefined;
    if (!spec) {
      const base = this.archetypes.get(lower);
      const viaBase = base ? ctx.keywords.get(base.toLowerCase()) : undefined;
      if (viaBase) {
        spec = viaBase;
        usesArchetype = first.value;
      }
    }
    if (!spec) return fail("unknown-keyword", `Unknown keyword '${first.value}' in ${ctx.title}.`);

    const args = argsFrom(1);
    const node = this.node("keyword", ctx.id, spec.keyword, first, true, line, args);
    if (identifier) node.identifier = identifier;
    if (usesArchetype) node.usesArchetype = usesArchetype;

    if (spec.status === "deferred") {
      this.report("unsupported", `'${first.value}' is not supported yet and is ignored.`, first.range, "warning");
    } else if (spec.status === "deprecated") {
      this.report("deprecated", `'${first.value}' is deprecated.${spec.note ? " " + spec.note : ""}`, first.range, "warning");
    }
    if (identifier && !spec.assignable) {
      this.report("not-assignable", `'${first.value}' cannot be assigned to an identifier.`, identifier.range, "warning");
    }

    if (spec.keyword === "workspace" && ctx.id === "file") {
      if (this.workspaceSeen) this.report("duplicate-workspace", "A file can only contain one workspace.", first.range);
      this.workspaceSeen = true;
      if (args[0]?.value.toLowerCase() === "extends" && args.length !== 2) {
        this.report("invalid-workspace", "Expected 'workspace extends <file|url>'.", lineRange);
      }
    }

    if (spec.status !== "deferred") this.checkArity(spec, first.value, args, lineRange);
    this.attachBody(node, this.body(spec, opener, first.value, node.range));
    return node;
  }

  /** A keyword-less line: `"name" "value"`, an identifier list, or a dynamic-view relationship id. */
  private lineStatement(ctx: ResolvedContext, line: Token[], opener: Token | undefined, skip = 0): StatementNode {
    const toks = line.slice(skip);
    const first = toks[0]!;
    const args = this.toArgs(toks.slice(1), true);
    const node = this.node("line", ctx.id, first.value, first, true, line, args);
    if (skip > 0) node.order = toArg(line[0]!);

    let min = 1;
    let max: number | null = null;
    if (ctx.ctx.lineKind === "dynamic") [min, max] = [1, 3];
    if (ctx.ctx.lineArity) [min, max] = ctx.ctx.lineArity;
    const total = toks.length;
    const range = rangeOf(toks[0]!, toks[toks.length - 1]!);
    if (total < min) {
      this.report("too-few-arguments", `Expected at least ${plural(min)} per line but got ${total}.`, range);
    } else if (max !== null && total > max) {
      this.report("too-many-arguments", `Expected at most ${plural(max)} per line, got ${total}.`, rangeOf(toks[max]!, toks[total - 1]!));
    }
    if (opener) {
      this.report("unexpected-body", "This line does not take a body.", opener.range);
      this.attachBody(node, this.parseBody(LENIENT, opener));
    }
    return node;
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private node(
    form: StatementForm,
    context: string,
    keyword: string,
    keywordTok: Token,
    known: boolean,
    line: Token[],
    args: Argument[],
  ): StatementNode {
    return {
      type: "statement",
      form,
      context,
      keyword,
      known,
      args,
      keywordRange: keywordTok.range,
      range: rangeOf(line[0]!, line[line.length - 1]!),
    };
  }

  private attachBody(node: StatementNode, body: BlockNode | undefined): void {
    if (!body) return;
    node.body = body;
    node.range = { ...node.range, end: body.range.end };
  }

  /** Converts argument tokens, reporting anything that is not a word or string. */
  private toArgs(tokens: Token[], lenientKinds = false): Argument[] {
    const out: Argument[] = [];
    for (const t of tokens) {
      if (isName(t) || lenientKinds) out.push(toArg(t));
      else this.report("unexpected-token", `Unexpected '${t.text}'.`, t.range);
    }
    return out;
  }

  private checkArity(spec: Statement, label: string, args: Argument[], lineRange: Range): void {
    const { min, max } = arityOf(spec);
    if (args.length < min) {
      this.report("too-few-arguments", `'${label}' expects ${min === max ? "" : "at least "}${plural(min)} but got ${args.length}. Syntax: ${spec.syntax.split(/\s{3,}\|\s{3,}/)[0]}`, lineRange);
    } else if (max !== null && args.length > max) {
      this.report("too-many-arguments", `'${label}' expects ${min === max ? "" : "at most "}${plural(max)} but got ${args.length}.`, rangeOf(args[max]!, args[args.length - 1]!));
    }
  }

  /** Parses the body of a recognised statement according to what its spec allows. */
  private body(spec: Statement, opener: Token | undefined, label: string, statementRange: Range): BlockNode | undefined {
    const mode = spec.block ?? "none";
    if (!opener) {
      if (mode === "required") this.report("missing-body", `'${label}' requires a '{ ... }' body.`, statementRange);
      return undefined;
    }
    if (spec.rawBody) return this.parseRawBody(opener);
    if (mode === "none") {
      this.report("unexpected-body", `'${label}' does not take a body.`, opener.range);
      return this.parseBody(LENIENT, opener);
    }
    return this.parseBody(spec.opens ?? LENIENT, opener);
  }
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  const lexed = tokenize(source, options.file);
  const pre = preprocess(source, lexed, options);
  const parser = new Parser(pre.sources, pre.tokens);
  const root = parser.parseFile();

  // Raw bodies (inline scripts) are not DSL: lexical complaints and comments inside them are noise.
  const insideRaw = (file: string | undefined, offset: number): boolean => parser.rawRanges.some((r) => r.file === file && offset >= r.start && offset <= r.end);
  const lexical = pre.diagnostics.filter((d) => !insideRaw(d.range.file, d.range.start.offset));
  const comments = pre.comments.filter((c) => !insideRaw(c.range.file, c.range.start.offset));

  const diagnostics = sortDiagnostics([...lexical, ...parser.diagnostics], options.file);
  return { root, comments, diagnostics, firstError: diagnostics.find((d) => d.severity === "error"), includes: pre.includes, files: pre.files };
}
