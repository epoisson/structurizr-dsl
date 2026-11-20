/**
 * Generates syntaxes/structurizr.tmLanguage.json from the keyword lists and the grammar inventory.
 * Run: npm run gen:grammar
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENUMS } from "../../core/src/index.ts";
import { KEYWORD_GROUPS } from "../src/grammar-lists.ts";

const words = (list: readonly string[]): string => list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
/** Keywords are case-insensitive in the DSL; Oniguruma's inline (?i). */
const keywordRule = (scope: string, list: readonly string[]) => ({
  name: scope,
  match: `(?i)(?<![\\w.\\-])(?:${words(list)})(?![\\w.\\-])`,
});

const enumValues = [
  ...ENUMS.shape, ...ENUMS.border, ...ENUMS.routing, ...ENUMS.autoLayoutDirection, ...ENUMS.userRole,
  ...ENUMS.terminologyMetadata, ...ENUMS.identifiers, ...ENUMS.scope, ...ENUMS.visibility,
].filter((v, i, all) => all.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i);

const substitution = { name: "variable.other.substitution.structurizr", match: "\\$\\{[^}]*\\}" };

const grammar = {
  $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  name: "Structurizr DSL",
  scopeName: "source.structurizr",
  patterns: [
    { include: "#comments" },
    { include: "#strings" },
    { include: "#directives" },
    { include: "#operators" },
    { include: "#keywords" },
    { include: "#constants" },
    { include: "#substitution" },
  ],
  repository: {
    comments: {
      patterns: [
        { name: "comment.line.number-sign.structurizr", match: "^\\s*#.*$" },
        { name: "comment.line.double-slash.structurizr", match: "//.*$" },
        { name: "comment.block.structurizr", begin: "/\\*", end: "\\*/" },
      ],
    },
    strings: {
      patterns: [
        { name: "string.quoted.triple.structurizr", begin: '"""', end: '"""', patterns: [substitution] },
        {
          name: "string.quoted.double.structurizr",
          begin: '"',
          end: '"|$',
          patterns: [{ name: "constant.character.escape.structurizr", match: '\\\\["\\\\]' }, substitution],
        },
        { name: "string.quoted.double.structurizr", begin: "\\u201c", end: "\\u201d|$", patterns: [substitution] },
      ],
    },
    directives: { name: "keyword.control.directive.structurizr", match: "(?<![\\w.\\-])![A-Za-z]+" },
    operators: {
      patterns: [
        { name: "keyword.operator.relationship.structurizr", match: "(?<!\\S)(?:--[A-Za-z0-9_.]+->|-/>|->)(?!\\S)" },
        { name: "keyword.operator.assignment.structurizr", match: "(?<=\\s)=(?=\\s)" },
      ],
    },
    keywords: {
      patterns: [
        keywordRule("entity.name.type.element.structurizr", KEYWORD_GROUPS.element),
        keywordRule("keyword.control.structure.structurizr", KEYWORD_GROUPS.structure),
        keywordRule("keyword.other.view.structurizr", KEYWORD_GROUPS.view),
        keywordRule("variable.other.property.structurizr", KEYWORD_GROUPS.property),
        keywordRule("support.type.property-name.style.structurizr", KEYWORD_GROUPS.style),
      ],
    },
    constants: {
      patterns: [
        { name: "constant.language.boolean.structurizr", match: "(?i)(?<![\\w.\\-])(?:true|false)(?![\\w.\\-])" },
        { name: "constant.other.color.structurizr", match: "(?<!\\S)#[0-9A-Fa-f]{3,8}(?!\\S)" },
        { name: "constant.numeric.structurizr", match: "(?<![\\w.\\-])\\d+(?:\\.\\d+)?(?![\\w.\\-])" },
        keywordRule("support.constant.structurizr", enumValues),
      ],
    },
    substitution,
  },
};

const out = fileURLToPath(new URL("../syntaxes/structurizr.tmLanguage.json", import.meta.url));
writeFileSync(out, JSON.stringify(grammar, null, 2) + "\n");
console.log(`wrote ${out}`);
