import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTEXTS, ENUMS, GLOBAL_DIRECTIVES } from "../src/grammar/inventory.ts";

const byId = new Map(CONTEXTS.map((c) => [c.id, c]));

test("context ids are unique", () => {
  assert.equal(byId.size, CONTEXTS.length);
});

test("every `opens` refers to a known context", () => {
  for (const c of CONTEXTS) {
    for (const st of c.statements) {
      if (st.opens) assert.ok(byId.has(st.opens), `${c.id}: '${st.keyword}' opens unknown context '${st.opens}'`);
    }
  }
});

test("no duplicate keywords within a context (case-insensitive)", () => {
  for (const c of CONTEXTS) {
    const seen = new Set<string>();
    for (const st of c.statements) {
      const k = st.keyword.toLowerCase();
      assert.ok(!seen.has(k), `${c.id}: duplicate keyword '${st.keyword}'`);
      seen.add(k);
    }
  }
});

test("every context is reachable from `file`", () => {
  const reached = new Set<string>(["file"]);
  const queue = ["file"];
  while (queue.length) {
    const c = byId.get(queue.pop()!)!;
    for (const st of c.statements) {
      if (st.opens && !reached.has(st.opens)) {
        reached.add(st.opens);
        queue.push(st.opens);
      }
    }
  }
  // archetype bodies are entered from the `archetypes` lines grammar, not from a keyword statement
  const entered = new Set(["archetypeElement", "archetypeRelationship"]);
  const unreachable = CONTEXTS.map((c) => c.id).filter((id) => !reached.has(id) && !entered.has(id));
  assert.deepEqual(unreachable, []);
});

test("statements that require a body name the context it opens", () => {
  for (const c of CONTEXTS) {
    for (const st of c.statements) {
      if (st.block === "required" && st.opens === undefined) {
        // only !components (deferred) and the unverified branding block may omit it
        assert.ok(st.status === "unverified" || st.status === "deferred", `${c.id}: '${st.keyword}'`);
      }
    }
  }
});

test("keyword statements are non-empty and global directives are all '!'-prefixed", () => {
  for (const d of GLOBAL_DIRECTIVES) assert.ok(d.keyword.startsWith("!"));
  for (const c of CONTEXTS) for (const st of c.statements) assert.ok(st.keyword.length > 0 && st.syntax.length > 0);
});

test("spec keywords from the language reference table of contents are all present", () => {
  const present = new Set<string>();
  for (const c of CONTEXTS) for (const st of c.statements) present.add(st.keyword.toLowerCase());
  for (const g of GLOBAL_DIRECTIVES) present.add(g.keyword.toLowerCase());
  const toc = [
    "workspace", "model", "archetypes", "group", "person", "softwaresystem", "container", "component",
    "deploymentenvironment", "deploymentgroup", "deploymentnode", "infrastructurenode", "softwaresysteminstance",
    "containerinstance", "instanceof", "healthcheck", "element", "->", "-/>", "tag", "tags", "description",
    "technology", "instances", "url", "properties", "perspectives", "!extend", "!ref", "!element", "!elements",
    "!relationship", "!relationships", "views", "systemlandscape", "systemcontext", "filtered", "dynamic",
    "deployment", "custom", "image", "include", "exclude", "autolayout", "default", "animation", "title",
    "styles", "light", "dark", "relationship", "theme", "themes", "terminology", "configuration", "scope",
    "visibility", "users", "!include", "!identifiers", "!impliedrelationships", "!docs", "!adrs", "!components",
    "!script", "!plugin", "!const", "!var",
  ];
  assert.deepEqual(toc.filter((k) => !present.has(k)), []);
});

test("element style and relationship style properties cover the spec lists", () => {
  const props = (id: string) => byId.get(id)!.statements.map((s) => s.keyword).sort();
  assert.deepEqual(props("elementStyle"), [
    "background", "border", "color", "colour", "description", "fontSize", "height", "icon", "metadata",
    "opacity", "properties", "shape", "stroke", "strokeWidth", "width",
  ]);
  assert.deepEqual(props("relationshipStyle"), [
    "color", "colour", "fontSize", "jump", "opacity", "position", "properties", "routing", "style", "thickness", "width",
  ]);
  assert.equal(ENUMS.shape.length, 19);
});
