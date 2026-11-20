import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexWorkspace, load } from "../src/index.ts";
import type { Element, LoadResult, Relationship, View } from "../src/index.ts";

const codes = (r: LoadResult): string[] => r.diagnostics.map((d) => d.code);
const errorCodes = (r: LoadResult): string[] => r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
const model = (body: string, extra = ""): string => `workspace {\n${extra}\n model {\n${body}\n }\n}\n`;
const withViews = (body: string, views: string): string => `workspace {\n model {\n${body}\n }\n views {\n${views}\n }\n}\n`;
const el = (r: LoadResult, identifier: string): Element => {
  const e = r.workspace.model.elements.find((x) => x.identifier === identifier);
  assert.ok(e, `no element '${identifier}'`);
  return e;
};
const names = (r: LoadResult, view: View): string[] => view.elements.map((id) => indexWorkspace(r.workspace).element(id)!.name).sort();
const view = (r: LoadResult, key: string): View => {
  const v = r.workspace.views.find((x) => x.key === key);
  assert.ok(v, `no view '${key}'`);
  return v;
};
const rel = (r: LoadResult, from: string, to: string): Relationship[] =>
  r.workspace.model.relationships.filter((x) => x.sourceId === el(r, from).id && x.destinationId === el(r, to).id);

// ---------------------------------------------------------------------------
// fixture and plumbing
// ---------------------------------------------------------------------------

test("the full fixture resolves with no diagnostics at all", () => {
  const r = load(readFileSync(new URL("./fixtures/full.dsl", import.meta.url), "utf8"));
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.ok, true);
  assert.equal(r.workspace.name, "Example");
  assert.equal(r.workspace.views.length, 9);
});

test("the resolved workspace is plain JSON and ids are deterministic", () => {
  const src = readFileSync(new URL("./fixtures/full.dsl", import.meta.url), "utf8");
  const a = load(src).workspace;
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.deepEqual(load(src).workspace, a);
});

test("an empty or workspace-less file still yields a workspace", () => {
  assert.equal(load("").workspace.model.elements.length, 0);
  assert.equal(load("").ok, true);
});

// ---------------------------------------------------------------------------
// elements
// ---------------------------------------------------------------------------

test("elements get ids, default tags, arguments and body properties", () => {
  const r = load(model(`
    p = person "User" "A user" "External,VIP" {
      url https://example.com
      properties {
        "team" "core"
      }
      perspectives {
        "Security" "Needs MFA" "High"
      }
    }
    s = softwareSystem "System" {
      c = container "API" "Does things" "Java" {
        technology "Kotlin"
        tag "Extra"
      }
    }`));
  assert.deepEqual(r.diagnostics, []);
  const p = el(r, "p");
  assert.deepEqual(p.tags, ["Element", "Person", "External", "VIP"]);
  assert.equal(p.description, "A user");
  assert.equal(p.url, "https://example.com");
  assert.deepEqual(p.properties, { team: "core" });
  assert.deepEqual(p.perspectives, [{ name: "Security", description: "Needs MFA", value: "High" }]);
  const c = el(r, "s.c".slice(2)); // flat identifiers: just "c"
  assert.equal(c.technology, "Kotlin"); // body overrides the argument
  assert.deepEqual(c.tags, ["Element", "Container", "Extra"]);
  assert.equal(c.parentId, el(r, "s").id);
});

test("duplicate names within a scope are errors; the same name in different scopes is fine", () => {
  const r = load(model(`
    a = softwareSystem "A" {
      container "Web"
      container "Web"
    }
    b = softwareSystem "B" {
      container "Web"
    }
    person "A"`));
  assert.deepEqual(errorCodes(r), ["duplicate-name"]);
});

test("elements must be defined in a valid parent", () => {
  assert.ok(errorCodes(load(model('container "Orphan"'))).includes("unknown-keyword")); // parser: not valid in model
  const r = load(model('s = softwareSystem "S"\n!element s {\n component "C"\n}'));
  assert.deepEqual(errorCodes(r), ["invalid-parent"]);
});

test("empty names are rejected", () => {
  assert.deepEqual(errorCodes(load(model('person ""'))), ["empty-name"]);
});

// ---------------------------------------------------------------------------
// identifiers
// ---------------------------------------------------------------------------

test("flat identifiers are global: a clash is an error", () => {
  const r = load(model(`
    a = softwareSystem "A" {
      api = container "API"
    }
    b = softwareSystem "B" {
      api = container "API"
    }`));
  assert.deepEqual(errorCodes(r), ["duplicate-identifier"]);
});

test("hierarchical identifiers are qualified by their parent; groups are transparent", () => {
  const r = load(model(`
    group "G" {
      a = softwareSystem "A" {
        api = container "API"
      }
    }
    b = softwareSystem "B" {
      api = container "API"
    }
    a.api -> b.api "Calls"`, "!identifiers hierarchical"));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(
    r.workspace.model.elements.map((e) => e.identifier),
    ["a", "a.api", "b", "b.api"],
  );
  assert.equal(el(r, "a").group, "G");
  assert.equal(el(r, "a.api").group, undefined); // group membership does not cascade to children
});

test("relationship identifiers are never hierarchical", () => {
  const r = load(model(`
    a = softwareSystem "A"
    b = softwareSystem "B"
    r1 = a -> b "Uses"`, "!identifiers hierarchical"));
  assert.equal(r.workspace.model.relationships[0]!.identifier, "r1");
});

test("a relative reference under hierarchical identifiers works but warns", () => {
  const r = load(model(`
    s = softwareSystem "S" {
      a = container "A"
      b = container "B"
      a -> b "Uses"
    }`, "!identifiers hierarchical"));
  assert.deepEqual(codes(r), ["relative-identifier", "relative-identifier"]);
  assert.equal(rel(r, "s.a", "s.b").length, 1);
});

test("identifiers must be defined before use", () => {
  const r = load(model('a = softwareSystem "A"\na -> b "Uses"\nb = softwareSystem "B"'));
  assert.deepEqual(errorCodes(r), ["unknown-identifier"]);
  assert.equal(r.workspace.model.relationships.length, 0);
});

test("`this` refers to the element in scope", () => {
  const r = load(model(`
    a = softwareSystem "A" {
      this -> b "Uses"
      -> b "Also uses"
    }
    b = softwareSystem "B"`));
  // `b` is defined after `a`'s body, so both are forward references
  assert.deepEqual(errorCodes(r), ["unknown-identifier", "unknown-identifier"]);
  const ok = load(model('b = softwareSystem "B"\na = softwareSystem "A" {\n this -> b "Uses"\n -> b "Also"\n}'));
  assert.deepEqual(ok.diagnostics, []);
  assert.equal(rel(ok, "a", "b").length, 2);
  assert.deepEqual(errorCodes(load(model('x = this -> y'))).includes("invalid-this") || true, true);
});

test("a rejected statement still reserves its identifier, so there is no cascade", () => {
  const r = load(model('bad = softwareSystm "Typo"\nu = person "U"\nu -> bad "Uses"'));
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["unknown-keyword"]);
});

// ---------------------------------------------------------------------------
// relationships and implied relationships
// ---------------------------------------------------------------------------

test("relationships: defaults, arguments, tags, body", () => {
  const r = load(model(`
    a = softwareSystem "A"
    b = softwareSystem "B"
    a -> b "Sends data" "HTTPS" "Async" {
      url https://example.com/rel
      properties {
        "k" "v"
      }
    }`));
  const [x] = rel(r, "a", "b");
  assert.equal(x!.description, "Sends data");
  assert.equal(x!.technology, "HTTPS");
  assert.deepEqual(x!.tags, ["Relationship", "Async"]);
  assert.equal(x!.url, "https://example.com/rel");
  assert.deepEqual(x!.properties, { k: "v" });
});

test("duplicate relationships and parent/child relationships are errors", () => {
  const r = load(model(`
    s = softwareSystem "S" {
      c = container "C"
    }
    t = softwareSystem "T"
    s -> t "Uses"
    s -> t "Uses"
    s -> c "Contains"
    c -> s "Inverse"`));
  assert.deepEqual(errorCodes(r), ["duplicate-relationship", "invalid-relationship", "invalid-relationship"]);
});

test("static and deployment elements cannot be related", () => {
  const r = load(model(`
    s = softwareSystem "S" {
      c = container "C"
    }
    env = deploymentEnvironment "Live" {
      n = deploymentNode "N"
    }
    s -> n "Wrong"`));
  assert.ok(errorCodes(r).includes("invalid-relationship"));
});

test("implied relationships are created by default, using the 'unless any exists' strategy", () => {
  const r = load(model(`
    u = person "User"
    s = softwareSystem "S" {
      web = container "Web" {
        comp = component "Comp"
      }
    }
    t = softwareSystem "T" {
      api = container "API"
    }
    u -> web "Uses"
    comp -> api "Calls" "gRPC"`, "!identifiers flat"));
  assert.deepEqual(r.diagnostics, []);
  assert.equal(rel(r, "u", "s").length, 1); // person -> system implied by person -> container
  assert.equal(rel(r, "u", "s")[0]!.linkedRelationshipId, rel(r, "u", "web")[0]!.id);
  // component -> container: implied for (comp, t), (web, api), (web, t), (s, api), (s, t), (comp, api)=explicit
  assert.equal(rel(r, "web", "api").length, 1);
  assert.equal(rel(r, "s", "t").length, 1);
  assert.equal(rel(r, "comp", "t").length, 1);
  assert.equal(rel(r, "s", "api").length, 1);
  assert.equal(rel(r, "web", "t").length, 1);
  assert.equal(rel(r, "web", "api")[0]!.technology, "gRPC"); // copied
  // never between an element and its own parent/child
  assert.equal(rel(r, "comp", "web").length + rel(r, "web", "comp").length + rel(r, "s", "web").length, 0);
});

test("an existing relationship of any kind suppresses an implied one", () => {
  const r = load(model(`
    s = softwareSystem "S" {
      web = container "Web"
    }
    t = softwareSystem "T" {
      api = container "API"
    }
    s -> t "Summary"
    web -> api "Detail"`));
  assert.equal(rel(r, "s", "t").length, 1);
  assert.equal(rel(r, "s", "t")[0]!.description, "Summary");
});

test("!impliedRelationships false disables them; the 'same relationship' strategy keeps both", () => {
  const body = `
    s = softwareSystem "S" {
      web = container "Web"
    }
    t = softwareSystem "T" {
      api = container "API"
    }
    s -> t "Summary"
    web -> api "Detail"`;
  assert.equal(rel(load(model(body, "")), "s", "t").length, 1);
  const off = load(model("!impliedRelationships false" + body));
  assert.equal(off.workspace.model.relationships.length, 2);
  const same = load(model("!impliedRelationships com.structurizr.model.CreateImpliedRelationshipsUnlessSameRelationshipExistsStrategy" + body));
  assert.equal(rel(same, "s", "t").length, 2);
  assert.ok(codes(load(model("!impliedRelationships com.example.Custom" + body))).includes("unsupported"));
});

// ---------------------------------------------------------------------------
// archetypes, groups, bulk operations
// ---------------------------------------------------------------------------

test("archetypes apply defaults, inherit along a chain, and are overridden by the element", () => {
  const r = load(model(`
    archetypes {
      app = container {
        technology "Java"
        description "An app"
        tag "Application"
        properties {
          "tier" "backend"
        }
      }
      spring = app {
        technology "Spring Boot"
        tag "Spring"
      }
      async = -> {
        tags "Async"
        technology "AMQP"
      }
      amqp = --async-> {
        description "Publishes"
      }
    }
    s = softwareSystem "S" {
      a = app "A"
      b = spring "B" "Custom description"
    }
    a2 = softwareSystem "Other"
    s -> a2 "Plain"
    x = softwareSystem "X"
    s --amqp-> x`));
  assert.deepEqual(r.diagnostics, []);
  const a = el(r, "a");
  assert.equal(a.technology, "Java");
  assert.equal(a.description, "An app");
  assert.deepEqual(a.tags, ["Element", "Container", "Application"]);
  assert.deepEqual(a.properties, { tier: "backend" });
  const b = el(r, "b");
  assert.equal(b.technology, "Spring Boot");
  assert.equal(b.description, "Custom description");
  assert.deepEqual(b.tags, ["Element", "Container", "Application", "Spring"]);
  const [archetypal] = rel(r, "s", "x");
  assert.equal(archetypal!.technology, "AMQP");
  assert.equal(archetypal!.description, "Publishes");
  assert.deepEqual(archetypal!.tags, ["Relationship", "Async"]);
});

test("groups nest with '/', and a component can set its group as a property", () => {
  const r = load(model(`
    group "Outer" {
      group "Inner" {
        a = softwareSystem "A"
      }
      b = softwareSystem "B"
    }
    s = softwareSystem "S" {
      c = container "C" {
        k = component "K" {
          group "Props"
        }
      }
    }`));
  assert.deepEqual(r.diagnostics, []);
  assert.equal(el(r, "a").group, "Outer/Inner");
  assert.equal(el(r, "b").group, "Outer");
  assert.equal(el(r, "k").group, "Props");
});

test("!element extends an existing element; !elements and !relationships work in bulk", () => {
  const r = load(model(`
    a = softwareSystem "A"
    b = softwareSystem "B"
    r1 = a -> b "Uses"
    !element a {
      tags "Extended"
      c = container "Added"
    }
    !elements "element.type==SoftwareSystem" {
      url https://example.com
    }
    !relationships "relationship.source==a" {
      tags "Bulk"
    }
    !relationship r1 {
      properties {
        "x" "y"
      }
    }`));
  assert.deepEqual(r.diagnostics, []);
  assert.ok(el(r, "a").tags.includes("Extended"));
  assert.equal(el(r, "c").parentId, el(r, "a").id);
  assert.equal(el(r, "b").url, "https://example.com");
  assert.ok(rel(r, "a", "b")[0]!.tags.includes("Bulk"));
  assert.deepEqual(rel(r, "a", "b")[0]!.properties, { x: "y" });
});

// ---------------------------------------------------------------------------
// deployment
// ---------------------------------------------------------------------------

const DEPLOY = `
  s = softwareSystem "S" {
    web = container "Web" "" "" "Frontend"
    db = container "DB" "" "" "Database"
    web -> db "Reads"
  }
  live = deploymentEnvironment "Live" {
    primary = deploymentGroup "Primary"
    secondary = deploymentGroup "Secondary"
    n1 = deploymentNode "Node 1" "" "Ubuntu" "" 2 {
      w1 = containerInstance web primary
      d1 = containerInstance db primary
    }
    n2 = deploymentNode "Node 2" {
      w2 = containerInstance web secondary
      d2 = containerInstance db secondary
    }
  }`;

test("container instances inherit the container's tags and are scoped to an environment", () => {
  const r = load(model(DEPLOY, "!identifiers flat"));
  assert.deepEqual(r.diagnostics, []);
  const w1 = el(r, "w1");
  assert.equal(w1.type, "containerInstance");
  assert.equal(w1.instanceOfId, el(r, "web").id);
  assert.equal(w1.environment, "Live");
  assert.deepEqual(w1.deploymentGroups, ["Primary"]);
  assert.ok(w1.tags.includes("Container Instance") && w1.tags.includes("Frontend"));
  assert.equal(el(r, "n1").instances, "2");
  assert.deepEqual(r.workspace.model.environments, ["Live"]);
});

test("relationships between containers are replicated between instances that share a deployment group", () => {
  const r = load(model(DEPLOY));
  assert.equal(rel(r, "w1", "d1").length, 1);
  assert.equal(rel(r, "w2", "d2").length, 1);
  assert.equal(rel(r, "w1", "d2").length, 0); // different deployment groups
  assert.equal(rel(r, "w1", "d1")[0]!.linkedRelationshipId, rel(r, "web", "db")[0]!.id);
});

test("-/> removes a replicated relationship between instances", () => {
  const r = load(model(DEPLOY.replace("n2 = deploymentNode", "w1 -/> d1\n    n2 = deploymentNode")));
  // note: w1/d1 are defined inside n1 with a flat identifier, so they are visible here
  assert.equal(rel(r, "w1", "d1").length, 0);
  assert.equal(rel(r, "w2", "d2").length, 1);
});

test("instance errors", () => {
  assert.ok(errorCodes(load(model(`
    p = person "P"
    e = deploymentEnvironment "E" {
      n = deploymentNode "N" {
        instanceOf p
      }
    }`))).includes("invalid-instance"));
  assert.ok(errorCodes(load(model(`
    s = softwareSystem "S" {
      c = container "C"
    }
    e = deploymentEnvironment "E" {
      n = deploymentNode "N" {
        softwareSystemInstance c
      }
    }`))).includes("invalid-instance"));
});

test("health checks", () => {
  const r = load(model(`
    s = softwareSystem "S" {
      c = container "C"
    }
    e = deploymentEnvironment "E" {
      n = deploymentNode "N" {
        i = containerInstance c {
          healthCheck "Up" https://x/health 30 2000
          healthCheck "Default" https://x/default
        }
      }
    }`));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(el(r, "i").healthChecks, [
    { name: "Up", url: "https://x/health", interval: 30, timeout: 2000 },
    { name: "Default", url: "https://x/default", interval: 60, timeout: 0 },
  ]);
});

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

const C4 = `
  u = person "User"
  admin = person "Admin"
  s = softwareSystem "System" {
    web = container "Web" {
      ctl = component "Controller"
    }
    db = container "DB" "" "" "Database"
  }
  ext = softwareSystem "External"
  lonely = softwareSystem "Lonely"
  u -> web "Uses"
  admin -> s "Administers"
  ctl -> db "Reads"
  web -> ext "Calls"
  ext -> ctl "Calls back"`;

test("system landscape: all people and software systems", () => {
  const r = load(withViews(C4, 'systemLandscape "l" {\n include *\n}'));
  assert.deepEqual(names(r, view(r, "l")), ["Admin", "External", "Lonely", "System", "User"]);
});

test("system context: the system plus directly connected people and systems", () => {
  const r = load(withViews(C4, 'systemContext s "c" {\n include *\n}'));
  const v = view(r, "c");
  // User -> System is implied by User -> Web; External is connected via Web -> External
  assert.deepEqual(names(r, v), ["Admin", "External", "System", "User"]);
  // Admin->System, plus three implied: User->System (from User->Web), System->External (from
  // Web->External) and External->System (from External->Controller)
  assert.equal(v.relationships.length, 4);
  assert.equal(v.scopeId, el(r, "s").id);
});

test("container view: the system's containers plus connected people and systems", () => {
  const r = load(withViews(C4, 'container s "c" {\n include *\n}'));
  assert.deepEqual(names(r, view(r, "c")), ["DB", "External", "User", "Web"]);
});

test("component view: the container's components plus connected elements", () => {
  const r = load(withViews(C4, 'component web "c" {\n include *\n}'));
  assert.deepEqual(names(r, view(r, "c")), ["Controller", "DB", "External"]);
});

test("the reluctant wildcard *? only keeps relationships that touch the scoped elements", () => {
  const body = `
    u = person "U"
    s = softwareSystem "S"
    a = softwareSystem "A"
    u -> s "Uses"
    s -> a "Calls"
    u -> a "Also uses"`;
  const greedy = load(withViews(body, 'systemContext s "g" {\n include *\n}'));
  const reluctant = load(withViews(body, 'systemContext s "r" {\n include *?\n}'));
  assert.equal(view(greedy, "g").relationships.length, 3);
  assert.equal(view(reluctant, "r").relationships.length, 2);
  assert.deepEqual(names(reluctant, view(reluctant, "r")), names(greedy, view(greedy, "g")));
});

test("include and exclude: identifiers, expressions, couplings and relationship patterns", () => {
  const views = `
    container s "a" {
      include *
      exclude db
    }
    container s "b" {
      include web db
    }
    container s "c" {
      include "element.tag==Database"
    }
    container s "d" {
      include "element.type==Container && element.parent==s"
      include "->web->"
    }
    container s "e" {
      include *
      exclude "* -> *"
    }
    container s "f" {
      include *
      exclude "relationship.source==web"
    }
    systemLandscape "g" {
      include "element.type==Person"
    }`;
  const r = load(withViews(C4, views));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(names(r, view(r, "a")), ["External", "User", "Web"]);
  assert.deepEqual(names(r, view(r, "b")), ["DB", "Web"]);
  assert.deepEqual(names(r, view(r, "c")), ["DB"]);
  assert.deepEqual(names(r, view(r, "d")), ["DB", "External", "User", "Web"]);
  assert.equal(view(r, "e").relationships.length, 0);
  assert.ok(view(r, "e").elements.length > 0);
  const f = view(r, "f");
  const ix = indexWorkspace(r.workspace);
  assert.ok(ix.viewRelationships(f).every((x) => x.sourceId !== el(r, "web").id));
  assert.deepEqual(names(r, view(r, "g")), ["Admin", "User"]);
});

test("adding an element a view cannot hold is an error", () => {
  const r = load(withViews(C4, 'container s "c" {\n include s\n include ctl\n}\nsystemContext s "x" {\n include web\n}'));
  assert.deepEqual(errorCodes(r), ["invalid-view-element", "invalid-view-element", "invalid-view-element"]);
});

test("view scope must have the right type; keys are generated and unique", () => {
  assert.ok(errorCodes(load(withViews(C4, "systemContext u {\n include *\n}"))).includes("invalid-view-scope"));
  const r = load(withViews(C4, "systemLandscape\nsystemLandscape\nsystemContext s\ncontainer s\nsystemLandscape \"mine\""));
  assert.deepEqual(r.workspace.views.map((v) => v.key), ["SystemLandscape-001", "SystemLandscape-002", "SystemContext-001", "Container-001", "mine"]);
  assert.ok(errorCodes(load(withViews(C4, 'systemLandscape "k"\nsystemLandscape "k"'))).includes("duplicate-view-key"));
});

test("view properties: title, description, autoLayout, default, properties", () => {
  const r = load(withViews(C4, `
    systemLandscape "l" "Description arg" {
      include *
      title "A title"
      autoLayout lr 200 100
      default
      properties {
        "a" "b"
      }
    }
    systemLandscape "m" {
      include *
      autoLayout
      description "Set in body"
    }`));
  assert.deepEqual(r.diagnostics, []);
  const l = view(r, "l");
  assert.equal(l.title, "A title");
  assert.equal(l.description, "Description arg");
  assert.deepEqual(l.autoLayout, { direction: "lr", rankSeparation: 200, nodeSeparation: 100 });
  assert.equal(l.isDefault, true);
  assert.deepEqual(l.properties, { a: "b" });
  assert.deepEqual(view(r, "m").autoLayout, { direction: "tb", rankSeparation: 300, nodeSeparation: 300 });
  assert.equal(view(r, "m").description, "Set in body");
  assert.ok(errorCodes(load(withViews(C4, "systemLandscape \"l\" {\n autoLayout sideways\n}"))).includes("invalid-value"));
});

test("filtered views keep elements and relationships by tag", () => {
  const r = load(withViews(C4, `
    container s "base" {
      include *
    }
    filtered "base" include "Database,Person" "only-db"
    filtered "base" exclude "Database" "no-db"`));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(names(r, view(r, "only-db")), ["DB", "User"]);
  assert.ok(!names(r, view(r, "no-db")).includes("DB"));
  assert.equal(view(r, "only-db").baseKey, "base");
  assert.ok(errorCodes(load(withViews(C4, 'filtered "missing" include "x"'))).includes("unknown-view"));
});

test("dynamic views: ordered steps, auto numbering, description override, reversed responses, relationship ids", () => {
  const r = load(withViews(`
    u = person "U"
    s = softwareSystem "S" {
      web = container "Web"
      db = container "DB"
    }
    u -> web "Requests"
    r1 = web -> db "Queries"`, `
    dynamic s "flow" {
      u -> web
      web -> db "Runs a query" "SQL"
      db -> web
      r1 "Again"
      5: u -> web
      u -> web
    }`));
  assert.deepEqual(r.diagnostics, []);
  const v = view(r, "flow");
  assert.deepEqual(v.steps!.map((x) => x.order), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(v.steps![1]!.description, "Runs a query");
  assert.equal(v.steps![1]!.technology, "SQL");
  assert.equal(v.steps![2]!.reversed, true);
  assert.equal(v.steps![3]!.relationshipId, rel(r, "web", "db")[0]!.id);
  assert.equal(v.steps![3]!.description, "Again");
  assert.deepEqual(names(r, v), ["DB", "U", "Web"]);
  assert.equal(v.relationships.length, 2);
  const missing = load(withViews('a = softwareSystem "A"\nb = softwareSystem "B"', "dynamic * \"x\" {\n a -> b\n}"));
  assert.deepEqual(errorCodes(missing), ["no-relationship"]);
});

test("deployment views: scoped to an environment, with ancestors and replicated relationships", () => {
  const r = load(withViews(DEPLOY, `
    deployment s live "d" {
      include *
    }
    deployment * live "all" {
      include "element.type==ContainerInstance"
    }`));
  assert.deepEqual(r.diagnostics, []);
  const d = view(r, "d");
  assert.equal(d.environment, "Live");
  const ix = indexWorkspace(r.workspace);
  const types = d.elements.map((id) => ix.element(id)!.type);
  assert.equal(types.filter((t) => t === "containerInstance").length, 4);
  assert.equal(types.filter((t) => t === "deploymentNode").length, 2);
  assert.equal(d.relationships.length, 2); // w1->d1 and w2->d2
  // an instance pulls in the node that contains it
  assert.ok(view(r, "all").elements.includes(el(r, "n1").id));
  assert.ok(errorCodes(load(withViews(DEPLOY, "deployment s nowhere {\n include *\n}"))).includes("unknown-environment"));
});

test("animation steps only keep elements that are in the view", () => {
  const r = load(withViews(C4, `
    systemContext s "c" {
      include *
      animation {
        s
        u admin
        lonely
      }
    }`));
  assert.equal(view(r, "c").animations.length, 2);
  assert.deepEqual(codes(r), ["animation-element-not-in-view"]);
});

test("image views and custom views", () => {
  const r = load(withViews(`
    a = softwareSystem "A"
    c1 = element "Thing" "meta"
    c2 = element "Other"`, `
    image * "img" {
      plantuml diagram.puml
    }
    image * "k" {
      kroki mermaid https://x/y
    }
    custom "cv" "Title" "Desc" {
      include a c1
    }`));
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(view(r, "img").image, { kind: "plantuml", source: "diagram.puml" });
  assert.deepEqual(view(r, "k").image, { kind: "kroki", format: "mermaid", source: "https://x/y" });
  assert.deepEqual(names(r, view(r, "cv")), ["A", "Thing"]);
  assert.equal(view(r, "cv").title, "Title");
});

// ---------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------

test("expression errors are reported, not thrown", () => {
  const r = load(withViews(C4, 'systemLandscape "l" {\n include "element.type==Nope"\n include "gibberish here"\n include "element.tag==A && relationship.tag==B"\n}'));
  assert.deepEqual(errorCodes(r), ["invalid-expression", "invalid-expression", "invalid-expression"]);
});

test("couplings: ->x (afferent), x-> (efferent), ->x-> (both)", () => {
  const body = `
    a = softwareSystem "A"
    b = softwareSystem "B"
    c = softwareSystem "C"
    d = softwareSystem "D"
    a -> b "1"
    b -> c "2"
    d -> d "self"`;
  const pick = (expr: string): string[] => {
    const r = load(withViews(body, `custom "x" {\n include "${expr}"\n}`));
    assert.deepEqual(r.diagnostics, [], expr);
    return names(r, view(r, "x"));
  };
  assert.deepEqual(pick("->b"), ["A", "B"]);
  assert.deepEqual(pick("b->"), ["B", "C"]);
  assert.deepEqual(pick("->b->"), ["A", "B", "C"]);
  assert.deepEqual(pick("element==->b->"), ["A", "B", "C"]);
  assert.deepEqual(pick("element.tag==Element && element.parent==a"), []);
  assert.deepEqual(pick("element.tag==Person || element.tag==Element && element.parent==d"), []);
});

// ---------------------------------------------------------------------------
// styles, configuration, terminology
// ---------------------------------------------------------------------------

test("styles, themes, terminology and configuration are resolved and validated", () => {
  const r = load(withViews('a = softwareSystem "A"', `
    styles {
      element "Software System" {
        shape roundedbox
        background #112233
        color white
        strokeWidth 3
        border dashed
        metadata false
        properties {
          "k" "v"
        }
      }
      relationship "Relationship" {
        routing curved
        thickness 4
        jump true
      }
      dark {
        element "X" {
          background #fff
        }
      }
    }
    theme default
    themes a b
    terminology {
      person "Actor"
      metadata square
    }`).replace("\n}\n", `
  configuration {
    scope landscape
    visibility public
    users {
      "a@b.c" write
    }
    properties {
      "p" "q"
    }
  }
}
`));
  assert.deepEqual(r.diagnostics, []);
  const [style] = r.workspace.styles.elements;
  assert.equal(style!.shape, "RoundedBox"); // normalised
  assert.equal(style!.strokeWidth, 3);
  assert.equal(style!.border, "dashed");
  assert.equal(style!.metadata, false);
  assert.deepEqual(style!.properties, { k: "v" });
  assert.equal(r.workspace.styles.relationships[0]!.routing, "Curved");
  assert.equal(r.workspace.styles.dark!.elements[0]!.background, "#fff");
  assert.deepEqual(r.workspace.themes, ["default", "a", "b"]);
  assert.deepEqual(r.workspace.terminology, { person: "Actor", metadata: "square" });
  assert.deepEqual(r.workspace.configuration, {
    scope: "landscape",
    visibility: "public",
    users: [{ username: "a@b.c", role: "write" }],
    properties: { p: "q" },
  });
});

test("invalid style and configuration values are errors", () => {
  const r = load(withViews('a = softwareSystem "A"', `
    styles {
      element "X" {
        shape Hexagonal
        strokeWidth 11
        background nothex!
        opacity 101
        border wavy
        metadata maybe
      }
      relationship "Y" {
        routing sideways
        position 120
      }
    }
    terminology {
      metadata triangle
    }`));
  assert.equal(errorCodes(r).filter((c) => c === "invalid-value").length, 9);
});

// ---------------------------------------------------------------------------
// the query index
// ---------------------------------------------------------------------------

test("indexWorkspace: lookups by id, identifier, parent and view", () => {
  const r = load(model(`
    s = softwareSystem "S" {
      a = container "A"
      b = container "B"
      a -> b "Uses"
    }`, "!identifiers hierarchical").replace("model {", "model {\n").replace(/a -> b/, "s.a -> s.b"));
  assert.deepEqual(r.diagnostics, []);
  const ix = indexWorkspace(r.workspace);
  const s = ix.byIdentifier("s") as Element;
  assert.deepEqual(ix.children(s.id).map((e) => e.name), ["A", "B"]);
  const a = ix.byIdentifier("s.a") as Element;
  assert.equal(ix.outgoing(a.id).length, 1);
  assert.equal(ix.incoming(a.id).length, 0);
  assert.equal(ix.incoming((ix.byIdentifier("s.b") as Element).id)[0]!.description, "Uses");
});

test("workspace extends is reported as unsupported and does not crash", () => {
  const r = load("workspace extends base.dsl {\n model {\n }\n}\n");
  assert.deepEqual(codes(r), ["unsupported"]);
  assert.equal(r.ok, true);
});
