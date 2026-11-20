import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../../core/src/index.ts";
import { exportAllMermaid, exportMermaid } from "../src/index.ts";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const ws = load(read("../../core/test/fixtures/full.dsl")).workspace;
const big = load(read("../../viewer/test/fixtures/big.dsl")).workspace;
const flow = (key: string, w = ws): string => exportMermaid(w, key)!;
const c4 = (key: string, w = ws): string => exportMermaid(w, key, { flavor: "c4" })!;
const model = (body: string, views = 'systemLandscape "k" {\n   include *\n  }'): ReturnType<typeof load>["workspace"] =>
  load(`workspace {\n model {\n${body}\n }\n views {\n  ${views}\n }\n}`).workspace;

test("unknown and image views are not exportable; exportAll skips image views", () => {
  assert.equal(exportMermaid(ws, "nope"), undefined);
  assert.equal(exportMermaid(ws, "image"), undefined);
  assert.equal(exportAllMermaid(ws).length, ws.views.length - 1);
});

test("flowchart: frontmatter title, direction from autoLayout, header comments", () => {
  const out = flow("containers");
  assert.ok(out.startsWith('---\ntitle: "[Container] Software System"\n---\nflowchart TB\n'));
  assert.match(flow("flow"), /^flowchart LR$/m); // autoLayout lr
  for (const [dir, word] of [["bt", "BT"], ["rl", "RL"]] as const) {
    const w = model('  a = softwareSystem "A"', `systemLandscape "k" {\n   include *\n   autoLayout ${dir}\n  }`);
    assert.match(flow("k", w), new RegExp(`^flowchart ${word}$`, "m"));
  }
});

test("flowchart: shapes by element kind", () => {
  const out = flow("flow");
  assert.match(out, /user\(\["<b>User<\/b>/); // person: stadium
  assert.match(out, /ss_db\[\("<b>Database<\/b>/); // database: cylinder
  assert.match(out, /ss_web\["<b>Web App<\/b>/); // default: box
  const w = model('  a = softwareSystem "A" "d" "Q"\n  b = softwareSystem "B"', 'systemLandscape "k" {\n   include *\n  }\n  styles {\n   element "Software System" {\n    shape RoundedBox\n   }\n   element "Q" {\n    shape Hexagon\n   }\n  }'); // later styles win, as in Structurizr
  assert.match(flow("k", w), /a\{\{"<b>A<\/b>/);
  assert.match(flow("k", w), /b\("<b>B<\/b>/);
});

test("flowchart: boundaries and nested deployment nodes are balanced subgraphs", () => {
  assert.match(flow("containers"), /subgraph ss \["<b>Software System<\/b><br\/><i>\[Software System\]<\/i>"\]\n    ss_web/);
  const dep = flow("deployment");
  assert.match(dep, /subgraph node \["<b>Server \(x2\)<\/b>/);
  assert.match(dep, /\n    subgraph e\d+ \["<b>Nested<\/b>/);
  for (const key of ws.views.map((v) => v.key).filter((k) => k !== "image")) {
    const out = flow(key);
    assert.equal((out.match(/^\s*subgraph /gm) ?? []).length, (out.match(/^\s*end$/gm) ?? []).length, `subgraph/end balance in ${key}`);
  }
});

test("flowchart: edges carry labels, technology and step numbers; one linkStyle line per distinct look", () => {
  assert.match(flow("containers"), /ss_web -\.->\|"Calls<br\/>\[HTTPS\]"\| ss_api/);
  assert.match(flow("containers"), /user -\.->\|"Uses"\| ss_web/);
  assert.match(flow("flow"), /user -\.->\|"1: Requests a page"\| ss_web/);
  assert.match(flow("flow"), /ss_api -\.->\|"3: Queries<br\/>\[JDBC\]"\| ss_db/);
  assert.equal((flow("containers").match(/^\s*linkStyle /gm) ?? []).length, 1);
  assert.match(flow("containers"), /linkStyle 0,1 stroke:#707070,stroke-width:2px/);
  const styled = model('  a = softwareSystem "A"\n  b = softwareSystem "B"\n  a -> b "Hot" "" "Hot"\n  b -> a "Cold"', 'systemLandscape "k" {\n   include *\n  }\n  styles {\n   relationship "Hot" {\n    color #ff0000\n    thickness 4\n    style solid\n   }\n  }');
  const out = flow("k", styled);
  assert.match(out, /a -->\|"Hot"\| b/); // solid style: a solid arrow
  assert.match(out, /b -\.->\|"Cold"\| a/);
  assert.match(out, /linkStyle 0 stroke:#ff0000,stroke-width:3px/);
});

test("flowchart: colours become classes written once", () => {
  const out = flow("containers");
  assert.equal((out.match(/^\s*classDef /gm) ?? []).length, 2);
  assert.match(out, /classDef c1 fill:#08427b,stroke:#062e56,color:#ffffff/);
  assert.match(out, /class ss_web,ss_api c2/);
  assert.match(flow("landscape", big), /classDef c\d fill:#999999/); // the External tag's colour
});

test("flowchart: reserved words, odd identifiers and name clashes get safe, unique ids", () => {
  const w = model('  end = softwareSystem "End"\n  graph = softwareSystem "Graph"\n  a.b = softwareSystem "Dots"\n  a_b = softwareSystem "Underscore"\n  softwareSystem "Anonymous"\n  end -> graph "x"');
  const out = flow("k", w);
  const ids = [...out.matchAll(/^  (\w+)[(\[{]/gm)].map((m) => m[1]!);
  assert.ok(!ids.includes("end") && !ids.includes("graph"), "no reserved ids");
  assert.equal(new Set(ids.map((i) => i.toLowerCase())).size, ids.length, "unique");
  assert.match(out, /end_ -\.->\|"x"\| graph_/);
});

test("flowchart: label text is escaped so Mermaid cannot misread it", () => {
  const w = model('  a = softwareSystem "R&D <Core> \\"x\\" #1 `t`" "Line one\\nLine two"');
  const out = flow("k", w);
  assert.ok(out.includes("R#amp;D #lt;Core#gt; #quot;x#quot; #35;1 #96;t#96;"), out);
  assert.ok(!/<Core>/.test(out));
  const t = model('  a = softwareSystem "A"', 'systemLandscape "k" "A \\"quoted\\" title" {\n   include *\n   title "T \\"x\\" \\\\ y"\n  }');
  assert.match(flow("k", t), /^title: "T \\"x\\" \\\\ y"$/m);
});

test("flowchart: self-relationships and custom elements", () => {
  const w = model('  a = softwareSystem "A"\n  e = element "Thing" "Widget"\n  a -> a "Loops"\n  a -> e "Feeds"', 'custom "k" {\n   include *\n  }');
  const out = flow("k", w);
  assert.match(out, /a -\.->\|"Loops"\| a/);
  assert.match(out, /e\["<b>Thing<\/b><br\/><i>\[Widget\]<\/i>/);
});

test("c4: Mermaid C4 diagram types, no PlantUML syntax, %% comments", () => {
  assert.match(c4("landscape"), /^C4Context$/m);
  assert.match(c4("context"), /^C4Context$/m);
  assert.match(c4("containers"), /^C4Container$/m);
  assert.match(c4("components"), /^C4Component$/m);
  assert.match(c4("flow"), /^C4Dynamic$/m);
  assert.match(c4("deployment"), /^C4Deployment$/m);
  for (const key of ws.views.map((v) => v.key).filter((k) => k !== "image")) {
    const out = c4(key);
    assert.ok(!/@startuml|!include|\$tags|LAYOUT_|AddElementTag|^\s*'/m.test(out), `${key} has no PlantUML-only syntax`);
  }
  assert.match(c4("containers"), /^  title \[Container\] Software System$/m);
});

test("c4: elements, boundaries, relationships and user colours", () => {
  const out = c4("containers");
  assert.match(out, /Person_Ext\(user, "User", "A user of the system"\)/);
  assert.match(out, /System_Boundary\(ss, "Software System"\) \{/);
  assert.match(out, /Rel\(ss_web, ss_api, "Calls", "HTTPS"\)/);
  assert.match(out, /UpdateElementStyle\(user, \$bgColor="#08427b", \$fontColor="#ffffff"\)/); // from the fixture's Person style
  assert.match(c4("flow"), /RelIndex\("1", user, ss_web, "Requests a page", ""\)/);
  assert.match(c4("flow"), /ContainerDb\(ss_db, "Database", "PostgreSQL", "Stores data"\)/);
  const rel = model('  a = softwareSystem "A"\n  b = softwareSystem "B"\n  a -> b "Hot" "" "Hot"', 'systemLandscape "k" {\n   include *\n  }\n  styles {\n   relationship "Hot" {\n    color #ff0000\n   }\n  }');
  assert.match(c4("k", rel), /UpdateRelStyle\(a, b, \$textColor="#ff0000", \$lineColor="#ff0000"\)/);
});

test("c4: deployment nesting; infrastructure nodes become containers (Mermaid rejects Node)", () => {
  const dep = c4("deployment");
  assert.match(dep, /Deployment_Node\(node, "Server \(x2\)", "Ubuntu", "Prod server"\) \{/);
  assert.match(dep, /    Container\(node_lb, "Load balancer", "nginx", ""\)/);
  assert.ok(!/\bNode\(/.test(dep));
});

test("output is deterministic and well formed", () => {
  assert.equal(flow("deployment"), flow("deployment"));
  assert.equal(c4("deployment"), c4("deployment"));
  for (const w of [ws, big]) for (const v of exportAllMermaid(w)) assert.ok(!/undefined|NaN/.test(v.content), v.key);
});

// ---- the real Mermaid parser ---------------------------------------------------------------------------------
// Set MERMAID_HOME to a directory where `npm install mermaid jsdom` has been run (nothing is added to this repo).
const home = process.env.MERMAID_HOME;
const haveMermaid = home !== undefined && existsSync(join(home, "node_modules", "mermaid", "dist", "mermaid.core.mjs"));
const validator = fileURLToPath(new URL("../scripts/validate-mermaid.mjs", import.meta.url));

test("real Mermaid accepts every export (set MERMAID_HOME to run)", { skip: !haveMermaid && "MERMAID_HOME not set or mermaid/jsdom not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mmd-"));
  try {
    const validate = (files: string[]): { status: number | null; out: string } => {
      const r = spawnSync(process.execPath, [validator, ...files], { encoding: "utf8", env: { ...process.env, MERMAID_HOME: home! } });
      return { status: r.status, out: r.stdout };
    };
    writeFileSync(join(dir, "control.mmd"), 'flowchart TB\n  a["A" --> \n');
    assert.equal(validate([join(dir, "control.mmd")]).status, 1, "the validator must reject broken input");
    writeFileSync(join(dir, "reserved.mmd"), 'flowchart TB\n  end["E"] --> b["B"]\n');
    assert.equal(validate([join(dir, "reserved.mmd")]).status, 1, "and a reserved word as an id");

    const files: string[] = [];
    for (const [label, w] of [["full", ws], ["big", big]] as const) {
      for (const flavor of ["flowchart", "c4"] as const) {
        for (const v of exportAllMermaid(w, { flavor })) {
          const f = join(dir, `${label}-${flavor}-${v.key}.mmd`);
          writeFileSync(f, v.content);
          files.push(f);
        }
      }
    }
    const r = validate(files);
    assert.equal(r.status, 0, r.out);
    assert.ok(files.length >= 18);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
