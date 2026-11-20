import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../../core/src/index.ts";
import { exportAllPlantUML, exportPlantUML } from "../src/index.ts";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const ws = load(read("../../core/test/fixtures/full.dsl")).workspace;
const big = load(read("../../viewer/test/fixtures/big.dsl")).workspace;
const c4 = (key: string, w = ws): string => exportPlantUML(w, key)!;
const basic = (key: string, w = ws): string => exportPlantUML(w, key, { flavor: "basic" })!;

test("every export is a complete @startuml/@enduml document with balanced braces", () => {
  for (const flavor of ["c4", "basic"] as const) {
    for (const w of [ws, big]) {
      for (const v of exportAllPlantUML(w, { flavor })) {
        assert.ok(v.content.startsWith("@startuml\n") && v.content.endsWith("@enduml\n"), `${v.key} ${flavor}`);
        assert.equal(v.content.split("{").length, v.content.split("}").length, `braces in ${v.key}`);
        assert.ok(!/undefined|NaN/.test(v.content), `${v.key} has no undefined/NaN`);
      }
    }
  }
});

test("unknown views and image views are not exportable; exportAll skips image views", () => {
  assert.equal(exportPlantUML(ws, "nope"), undefined);
  assert.equal(exportPlantUML(ws, "image"), undefined);
  const keys = exportAllPlantUML(ws).map((v) => v.key);
  assert.ok(!keys.includes("image") && keys.includes("containers") && keys.length === ws.views.length - 1);
});

test("c4: the right C4 library per view type", () => {
  assert.match(c4("landscape"), /!include <C4\/C4_Context>/);
  assert.match(c4("context"), /!include <C4\/C4_Context>/);
  assert.match(c4("containers"), /!include <C4\/C4_Container>/);
  assert.match(c4("components"), /!include <C4\/C4_Component>/);
  assert.match(c4("flow"), /!include <C4\/C4_Dynamic>/);
  assert.match(c4("deployment"), /!include <C4\/C4_Deployment>/);
});

test("c4: element macros follow type and conventions (External, Database), with technology only where it belongs", () => {
  const containers = c4("containers");
  assert.match(containers, /Person_Ext\(user, "User", "A user of the system", \$tags="Person"\)/); // tagged External
  assert.match(containers, /Container\(ss_web, "Web App", "Java", "Serves pages"\)/);
  assert.match(c4("flow"), /ContainerDb\(ss_db, "Database", "PostgreSQL", "Stores data"/); // Database tag
  assert.ok(!c4("flow").includes('AddElementTag("Database"'), "a style with only a shape declares nothing");
  assert.match(c4("landscape"), /System\(ss, "Software System", "Does things"\)/);
  const stress = c4("landscape", big);
  assert.match(stress, /System_Ext\(payments, "Payment Provider", "Card processing", \$tags="External"\)/);
  assert.match(stress, /Person\(customer, "Customer", "Buys things online"\)/);
});

test("c4: scope boundaries and nested deployment nodes", () => {
  const containers = c4("containers");
  assert.match(containers, /System_Boundary\(ss, "Software System"\) \{\n  Container\(ss_web/);
  assert.match(c4("components"), /Container_Boundary\(ss_api, "API"\) \{/);
  const dep = c4("deployment");
  assert.match(dep, /Deployment_Node\(node, "Server \(x2\)", "Ubuntu", "Prod server"\) \{/);
  assert.match(dep, /  Node\(node_lb, "Load balancer", "nginx", ""\)/);
  assert.match(dep, /  Deployment_Node\(e\d+, "Nested", "Docker", ""\) \{\n    ContainerDb\(/);
});

test("c4: relationships, dynamic steps with order, and tag styles only for tags in use", () => {
  assert.match(c4("containers"), /Rel\(ss_web, ss_api, "Calls", "HTTPS", \$tags="Relationship"\)/);
  const flow = c4("flow");
  assert.match(flow, /RelIndex\("1", user, ss_web, "Requests a page", ""/);
  assert.match(flow, /RelIndex\("3", ss_api, ss_db, "Queries", "JDBC"/); // the step's overrides
  assert.match(c4("containers"), /AddElementTag\("Person", \$bgColor="#08427b"/);
  assert.match(c4("containers"), /AddRelTag\("Relationship", \$lineStyle=DashedLine\(\), \$lineThickness=2\)/);
  // a styled tag that no element in the view carries is not declared
  assert.ok(!c4("components").includes('AddElementTag("Database"'));
  // definitions come before the elements that use them
  const out = c4("containers");
  assert.ok(out.indexOf("AddElementTag") < out.indexOf("Person_Ext("));
});

test("c4: layout direction and title", () => {
  assert.match(c4("flow"), /LAYOUT_LEFT_RIGHT\(\)/); // autoLayout lr
  assert.match(c4("containers"), /LAYOUT_TOP_DOWN\(\)/);
  assert.match(c4("flow"), /^title Request flow$/m);
  assert.match(c4("containers"), /^title \[Container\] Software System$/m);
  const bt = load('workspace {\n model {\n  a = softwareSystem "A"\n }\n views {\n  systemLandscape "k" {\n   include *\n   autoLayout bt\n  }\n }\n}').workspace;
  assert.match(c4("k", bt), /' autoLayout bt: C4-PlantUML only supports top-to-bottom/);
});

test("aliases come from identifiers (dots become underscores), are unique, and are safe", () => {
  const w = load('workspace {\n model {\n  a = softwareSystem "A"\n  b = softwareSystem "B"\n  softwareSystem "Anonymous"\n  x_y = softwareSystem "X"\n  x.y = softwareSystem "Z"\n }\n views {\n  systemLandscape "k" {\n   include *\n  }\n }\n}').workspace;
  const out = c4("k", w);
  const aliases = [...out.matchAll(/^System\((\w+),/gm)].map((m) => m[1]!);
  assert.equal(new Set(aliases.map((a) => a.toLowerCase())).size, aliases.length, "unique");
  assert.ok(aliases.every((a) => /^[A-Za-z_]\w*$/.test(a)));
  assert.ok(aliases.includes("a") && aliases.some((a) => a.startsWith("e")));
});

test("text is made safe for PlantUML: quotes, newlines", () => {
  const w = load('workspace {\n model {\n  a = softwareSystem "Say \\"hi\\"" """Line one\nLine two"""\n }\n views {\n  systemLandscape "k" {\n   include *\n  }\n }\n}').workspace;
  const out = c4("k", w);
  assert.match(out, /System\(a, "Say 'hi'", "Line one\\nLine two"\)/);
  assert.ok(!/"Say "hi""/.test(out));
});

test("custom elements and self-relationships", () => {
  const w = load('workspace {\n model {\n  a = softwareSystem "A"\n  e = element "Thing" "Widget"\n  a -> a "Loops"\n  a -> e "Feeds"\n }\n views {\n  custom "k" {\n   include *\n  }\n }\n}').workspace;
  const out = c4("k", w);
  assert.match(out, /rectangle "Thing\\n\[Widget\]" as e/);
  assert.match(out, /Rel\(a, a, "Loops"/);
});

test("basic: no C4 library, explicit colours per look, shapes and arrow styles", () => {
  const b = basic("landscape", big);
  assert.ok(!b.includes("C4/"));
  assert.match(b, /^hide stereotype$/m);
  assert.match(b, /skinparam actor<<s1>> \{\n  BackgroundColor #08427b\n  FontColor #333333/); // actor labels sit on the page
  assert.match(b, /skinparam rectangle<<s2>> \{\n  BackgroundColor #1168bd\n  FontColor #ffffff/);
  assert.match(b, /actor "<b>Customer<\/b>\\n<size:10>\[Person\]<\/size>\\n\\nBuys things online" as customer <<s1>>/);
  assert.match(b, /customer -\[#707070,dashed,thickness=2\]-> shop : Browses and orders/);
  assert.match(basic("flow"), /database "<b>Database<\/b>/);
  assert.match(basic("flow"), /^left to right direction$/m);
  assert.match(basic("flow"), / : 1: Requests a page/);
  assert.match(basic("containers"), /rectangle "<b>Software System<\/b>\\n<size:10>\[Software System\]<\/size>" as ss <<boundary>> \{/);
  assert.match(basic("deployment"), /rectangle "<b>Server \(x2\)<\/b>[^"]*" as node <<s\d+>> \{/);
});

test("output is deterministic", () => {
  assert.equal(c4("deployment"), c4("deployment"));
  assert.equal(basic("containers"), basic("containers"));
});

// ---- the real PlantUML ------------------------------------------------------------------------------
// Set PLANTUML_JAR=/path/to/plantuml.jar (and have Java installed) to validate every export with the actual tool.
const jar = process.env.PLANTUML_JAR;
const haveJava = jar !== undefined && existsSync(jar) && spawnSync("java", ["-version"]).status === 0;

test("real PlantUML accepts every export (set PLANTUML_JAR to run)", { skip: !haveJava && "PLANTUML_JAR not set or Java missing" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "puml-"));
  try {
    const check = (name: string, content: string): number => {
      const file = join(dir, `${name}.puml`);
      writeFileSync(file, content);
      return spawnSync("java", ["-Djava.awt.headless=true", "-jar", jar!, "-checkonly", file], { encoding: "utf8" }).status ?? -1;
    };
    assert.notEqual(check("control", "@startuml\nPerson(a\nRel(a\n@enduml\n"), 0, "the checker must reject broken input");
    let n = 0;
    for (const [label, w] of [["full", ws], ["big", big]] as const) {
      for (const flavor of ["c4", "basic"] as const) {
        for (const v of exportAllPlantUML(w, { flavor })) {
          assert.equal(check(`${label}-${flavor}-${v.key}`, v.content), 0, `PlantUML rejected ${label}/${flavor}/${v.key}`);
          n++;
        }
      }
    }
    assert.ok(n >= 18);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
