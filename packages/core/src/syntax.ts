import type { Range } from "./types.ts";

/**
 * Syntax tree. Plain, JSON-serializable data with source ranges on every node.
 * It records what was written; it does not resolve identifiers or expand anything.
 */

/** One argument of a statement (a word or a string). */
export interface Argument {
  /** Content: quotes removed and escapes resolved for strings. */
  value: string;
  /** Exact source text. */
  raw: string;
  quoted: boolean;
  textBlock?: boolean;
  range: Range;
}

/**
 * keyword       led by a keyword:        person "User" { }
 * relationship  led by an operator:      a -> b "Uses"     -> b     a --https-> b
 * line          a keyword-less line:     "name" "value"   (properties, users, animation steps, ...)
 * archetype     an archetype definition: application = container { }
 */
export type StatementForm = "keyword" | "relationship" | "line" | "archetype";

export interface StatementNode {
  type: "statement";
  form: StatementForm;
  /** Id of the context this statement appears in (see grammar/inventory.ts). */
  context: string;
  /**
   * Canonical keyword when recognised ("softwareSystem" even if written "SOFTWARESYSTEM"); for an
   * archetype use, the keyword of its base kind. For relationships the operator label
   * ("->", "--<archetype>->", "-/>"). Otherwise the text as written.
   */
  keyword: string;
  /** False when the keyword was not recognised in this context. */
  known: boolean;
  /** Name of the archetype when this statement uses one, as written. */
  usesArchetype?: string;
  /** `identifier =` prefix. */
  identifier?: Argument;
  /** Relationship forms: explicit source (absent for the implicit-source form `-> b`). */
  source?: Argument;
  /** Relationship forms: the operator token as written, e.g. `--https->`. */
  operator?: Argument;
  /** Dynamic views: the `1:` ordering prefix. */
  order?: Argument;
  /** Arguments after the keyword/operator. For relationships, args[0] is the destination. */
  args: Argument[];
  body?: BlockNode;
  /** The keyword or operator (or the first token of a line statement). */
  keywordRange: Range;
  /** The whole statement, including its body. */
  range: Range;
  /**
   * archetype form only. `base` is the built-in kind ("container", ...) or "->" for relationship
   * archetypes; `extends` names the parent archetype when defined in terms of another archetype.
   */
  archetype?: { kind: "element" | "relationship"; base: string; extends?: string };
}

export interface BlockNode {
  type: "block";
  /** Context entered by the body; "?" when the body was parsed leniently, "raw" for raw bodies. */
  context: string;
  children: StatementNode[];
  /** Raw body text for `!script` and similar. */
  raw?: string;
  /** From `{` to `}` inclusive (to end of file if never closed). */
  range: Range;
  closed: boolean;
}

export interface FileNode {
  type: "file";
  children: StatementNode[];
  range: Range;
}
