import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nodeIO } from "../src/node-io.ts";
import { HELP, VERSION, run } from "../src/run.ts";
import type { IO } from "../src/run.ts";

const GOOD = `workspace "W" {
  model {
    u = person "User"
    s = softwareSystem "System"
    u -> s "Uses"
  }
  views {
    systemContext s "ctx" {
      include *
    }
  }
}
`;
const BAD = `workspace {\n model {\n  nope "x"\n  person "Fine"\n }\n}\n`;
const WARN = `workspace {\n !script x.groovy\n}\n`; // still unsupported: warned about, not an error

function harness(files: Record<string, string>, stdin = "", env: Record<string, string | undefined> = {}) {
  const key = (p: string): string => (p.startsWith("/cwd/") ? p.slice(5) : p);
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const dirs: string[] = [];
  const io: IO = {
    readFile: (p) => {
      if (!(key(p) in files)) throw new Error("ENOENT: no such file");
      return files[key(p)]!;
    },
    resolve: (p) => (p.startsWith("/") ? p : p === "." || p === "" ? "/cwd" : `/cwd/${p.replace(/^\.\//, "")}`), // like path.resolve
    listDirectory: (p) => {
      const prefix = key(p).replace(/\/+$/, "") + "/";
      const kids = Object.keys(files).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"));
      return kids.length ? kids.map((k) => `/cwd/${k}`) : undefined;
    },
    env,
    readStdin: () => stdin,
    writeFile: (p, c) => void (written[p] = c),
    mkdirp: (p) => void dirs.push(p),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
  };
  return { io, out: () => out.join(""), err: () => err.join(""), written, dirs };
}

test("check: a good file exits 0 and says ok", () => {
  const h = harness({ "a.dsl": GOOD });
  assert.equal(run(["check", "a.dsl"], h.io), 0);
  assert.match(h.out(), /a\.dsl: ok/);
  assert.equal(h.err(), "");
});

test("check: errors exit 1 and are printed as file:line:col severity [code] message", () => {
  const h = harness({ "b.dsl": BAD });
  assert.equal(run(["check", "b.dsl"], h.io), 1);
  assert.match(h.err(), /^b\.dsl:3:3 error \[unknown-keyword\] Unknown keyword 'nope'/);
});

test("check: warnings alone exit 0; --no-warnings hides them", () => {
  const h = harness({ "w.dsl": WARN });
  assert.equal(run(["check", "w.dsl"], h.io), 0);
  assert.match(h.err(), /warning \[unsupported\]/);
  const h2 = harness({ "w.dsl": WARN });
  assert.equal(run(["check", "w.dsl", "--no-warnings"], h2.io), 0);
  assert.equal(h2.err(), "");
});

test("check: several files, exit 1 if any has errors; --quiet prints nothing", () => {
  const h = harness({ "a.dsl": GOOD, "b.dsl": BAD });
  assert.equal(run(["check", "a.dsl", "b.dsl"], h.io), 1);
  assert.match(h.out(), /a\.dsl: ok/);
  assert.match(h.out(), /b\.dsl: errors/);
  const q = harness({ "b.dsl": BAD });
  assert.equal(run(["check", "b.dsl", "-q"], q.io), 1);
  assert.equal(q.out() + q.err(), "");
});

test("check --json prints diagnostics as JSON", () => {
  const h = harness({ "b.dsl": BAD });
  assert.equal(run(["check", "b.dsl", "--json"], h.io), 1);
  const parsed = JSON.parse(h.out());
  assert.equal(parsed[0].file, "b.dsl");
  assert.equal(parsed[0].diagnostics[0].code, "unknown-keyword");
});

test("resolve: JSON workspace on stdout, diagnostics on stderr", () => {
  const h = harness({ "a.dsl": GOOD });
  assert.equal(run(["resolve", "a.dsl"], h.io), 0);
  const ws = JSON.parse(h.out());
  assert.equal(ws.name, "W");
  assert.equal(ws.model.elements.length, 2);
  assert.equal(ws.views[0].key, "ctx");
  assert.ok(h.out().includes("\n  ")); // indented by default
  const c = harness({ "a.dsl": GOOD });
  run(["resolve", "a.dsl", "--compact"], c.io);
  assert.equal(c.out().trim().split("\n").length, 1);
});

test("resolve: still prints the (partial) workspace when there are errors, and exits 1", () => {
  const h = harness({ "b.dsl": BAD });
  assert.equal(run(["resolve", "b.dsl"], h.io), 1);
  assert.equal(JSON.parse(h.out()).model.elements.length, 1);
  assert.match(h.err(), /unknown-keyword/);
});

test("--out writes to a file instead of stdout", () => {
  const h = harness({ "a.dsl": GOOD });
  assert.equal(run(["resolve", "a.dsl", "-o", "out.json"], h.io), 0);
  assert.equal(h.out(), "");
  assert.equal(JSON.parse(h.written["out.json"]!).name, "W");
});

test("parse prints the syntax tree", () => {
  const h = harness({ "a.dsl": GOOD });
  assert.equal(run(["parse", "a.dsl", "--compact"], h.io), 0);
  const tree = JSON.parse(h.out());
  assert.equal(tree.type, "file");
  assert.equal(tree.children[0].keyword, "workspace");
});

test("summary lists counts and views", () => {
  const h = harness({ "a.dsl": GOOD });
  assert.equal(run(["summary", "a.dsl"], h.io), 0);
  assert.match(h.out(), /^W\n {2}2 elements \(1 people, 1 software systems, 0 containers, 0 components\), 1 relationships, 1 views/);
  assert.match(h.out(), /view ctx \[systemContext\]: 2 elements, 1 relationships/);
});

test("standard input with '-'", () => {
  const h = harness({}, GOOD);
  assert.equal(run(["summary", "-"], h.io), 0);
  assert.match(h.out(), /^W\n/);
  const e = harness({}, BAD);
  run(["check", "-"], e.io);
  assert.match(e.err(), /^<stdin>:3:3 error/);
});

test("usage errors exit 2", () => {
  for (const args of [[], ["bogus", "a.dsl"], ["check"], ["resolve", "a.dsl", "b.dsl"], ["check", "--nope", "a.dsl"], ["check", "a.dsl", "-o"]]) {
    const h = harness({ "a.dsl": GOOD, "b.dsl": GOOD });
    assert.equal(run(args, h.io), 2, args.join(" "));
    assert.ok(h.err().length > 0);
  }
});

test("an unreadable file exits 2 with a message", () => {
  const h = harness({});
  assert.equal(run(["check", "missing.dsl"], h.io), 2);
  assert.match(h.err(), /Cannot read missing\.dsl/);
});

test("--help and --version", () => {
  const h = harness({});
  assert.equal(run(["--help"], h.io), 0);
  assert.equal(h.out(), HELP);
  const v = harness({});
  assert.equal(run(["--version"], v.io), 0);
  assert.equal(v.out(), `${VERSION}\n`);
});

test("svg: renders the default (or first) view to SVG on stdout", () => {
  const h = harness({ "a.dsl": GOOD });
  assert.equal(run(["svg", "a.dsl"], h.io), 0);
  assert.match(h.out(), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(h.out(), /User/);
  assert.match(h.out(), /\[System Context\] System/);
  const d = harness({ "a.dsl": GOOD });
  run(["svg", "a.dsl", "--dark", "--no-title", "-o", "o.svg"], d.io);
  assert.match(d.written["o.svg"]!, /#1e1e1e/);
  assert.ok(!d.written["o.svg"]!.includes("[System Context]"));
});

test("svg: --view picks a view, --list lists them, --all writes one file per view", () => {
  const two = GOOD.replace("      include *\n    }\n", '      include *\n    }\n    systemLandscape "land" {\n      include *\n    }\n');
  const l = harness({ "a.dsl": two });
  assert.equal(run(["svg", "a.dsl", "--list"], l.io), 0);
  assert.match(l.out(), /^ctx\tsystemContext\t.*\nland\tsystemLandscape/);
  const v = harness({ "a.dsl": two });
  assert.equal(run(["svg", "a.dsl", "--view", "land"], v.io), 0);
  assert.match(v.out(), /System Landscape/);
  const all = harness({ "a.dsl": two });
  assert.equal(run(["svg", "a.dsl", "--all", "-o", "out/"], all.io), 0);
  assert.deepEqual(Object.keys(all.written).sort(), ["out/ctx.svg", "out/land.svg"]);
  assert.deepEqual(all.dirs, ["out/"]);
});

test("svg: usage errors", () => {
  for (const args of [["svg", "a.dsl", "--view", "nope"], ["svg", "a.dsl", "--all"], ["svg", "none.dsl"], ["svg", "a.dsl", "--view"]]) {
    const h = harness({ "a.dsl": GOOD });
    assert.equal(run(args, h.io), 2, args.join(" "));
  }
  const h = harness({ "e.dsl": "workspace {\n}\n" });
  assert.equal(run(["svg", "e.dsl"], h.io), 2);
  assert.match(h.err(), /no views/);
});

test("export: PlantUML to stdout, with --flavor, --view, --list and --all", () => {
  const two = GOOD.replace("      include *\n    }\n", '      include *\n    }\n    systemLandscape "land" {\n      include *\n    }\n');
  const h = harness({ "a.dsl": two });
  assert.equal(run(["export", "a.dsl", "--view", "ctx"], h.io), 0);
  assert.match(h.out(), /^@startuml\n/);
  assert.match(h.out(), /!include <C4\/C4_Context>/);
  assert.match(h.out(), /Person\(u, "User", ""\)/);
  assert.match(h.out(), /@enduml\n$/);
  const b = harness({ "a.dsl": two });
  run(["export", "a.dsl", "--flavor", "basic"], b.io);
  assert.match(b.out(), /skinparam shadowing false/);
  assert.ok(!b.out().includes("C4/"));
  const all = harness({ "a.dsl": two });
  assert.equal(run(["export", "a.dsl", "--all", "-o", "puml"], all.io), 0);
  assert.deepEqual(Object.keys(all.written).sort(), ["puml/ctx.puml", "puml/land.puml"]);
  const l = harness({ "a.dsl": two });
  assert.equal(run(["export", "a.dsl", "--list"], l.io), 0);
  assert.match(l.out(), /^ctx\t/);
});

test("export: Mermaid, with its own flavors and the .mmd extension", () => {
  const two = GOOD.replace("      include *\n    }\n", '      include *\n    }\n    systemLandscape "land" {\n      include *\n    }\n');
  const h = harness({ "a.dsl": two });
  assert.equal(run(["export", "a.dsl", "--format", "mermaid", "--view", "ctx"], h.io), 0);
  assert.match(h.out(), /^---\ntitle: "\[System Context\] System"\n---\nflowchart TB\n/);
  assert.ok(!h.out().includes("@startuml"));
  const c = harness({ "a.dsl": two });
  run(["export", "a.dsl", "--format", "MERMAID", "--flavor", "c4", "--view", "ctx"], c.io);
  assert.match(c.out(), /^C4Context\n/);
  const all = harness({ "a.dsl": two });
  assert.equal(run(["export", "a.dsl", "--format", "mermaid", "--all", "-o", "mmd"], all.io), 0);
  assert.deepEqual(Object.keys(all.written).sort(), ["mmd/ctx.mmd", "mmd/land.mmd"]);
});

test("export: a flavor must belong to the chosen format", () => {
  for (const args of [["export", "a.dsl", "--format", "mermaid", "--flavor", "basic"], ["export", "a.dsl", "--format", "plantuml", "--flavor", "flowchart"]]) {
    const h = harness({ "a.dsl": GOOD });
    assert.equal(run(args, h.io), 2, args.join(" "));
    assert.match(h.err(), /not available for/);
  }
});

test("export: errors for unknown format, bad flavor, and unexportable views", () => {
  for (const args of [["export", "a.dsl", "--format", "dot"], ["export", "a.dsl", "--flavor", "x"], ["export", "a.dsl", "--format"], ["export", "a.dsl", "--view", "nope"]]) {
    const h = harness({ "a.dsl": GOOD });
    assert.equal(run(args, h.io), 2, args.join(" "));
  }
  const img = harness({ "i.dsl": 'workspace {\n model {\n }\n views {\n  image * "pic" {\n   plantuml x.puml\n  }\n }\n}\n' });
  assert.equal(run(["export", "i.dsl", "--view", "pic"], img.io), 2);
  assert.match(img.err(), /cannot be exported/);
});

test("every package.json version matches VERSION", () => {
  const version = readFileSync(
    new URL("../../../VERSION", import.meta.url),
    "utf8"
  ).trim();

  const pkg = (rel: string) =>
    JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version;

  assert.equal(pkg("../package.json"), version);

  for (const p of [
    "../../core/package.json",
    "../../viewer/package.json",
    "../../exporters/package.json",
    "../../extension/package.json",
    "../../../package.json",
  ]) {
    assert.equal(pkg(p), version, p);
  }
});
// ---- !include, !const, !var -------------------------------------------------------------------------------
const SHOP = (inner: string): string => `workspace {\n  model {\n${inner}\n  }\n}\n`;

test("!include is resolved relative to the file, with a host the CLI provides", () => {
  const h = harness({ "main.dsl": SHOP("    !include people.dsl\n    s = softwareSystem \"S\""), "people.dsl": 'u = person "User"\n' });
  assert.equal(run(["summary", "main.dsl"], h.io), 0);
  assert.match(h.out(), /2 elements \(1 people, 1 software systems/);
  assert.equal(h.err(), "");
  const sub = harness({ "docs/main.dsl": SHOP("    !include parts/p.dsl"), "docs/parts/p.dsl": 'u = person "User"\n' });
  assert.equal(run(["summary", "docs/main.dsl"], sub.io), 0);
  assert.match(sub.out(), /1 elements/);
});

test("errors inside an included file name that file; a missing include is an error with exit 1", () => {
  const h = harness({ "main.dsl": SHOP("    !include bad.dsl"), "bad.dsl": 'nope "x"\n' });
  assert.equal(run(["check", "main.dsl"], h.io), 1);
  assert.match(h.err(), /^\/cwd\/bad\.dsl:1:1 error \[unknown-keyword\]/m);
  const missing = harness({ "main.dsl": SHOP("    !include gone.dsl") });
  assert.equal(run(["check", "main.dsl"], missing.io), 1);
  assert.match(missing.err(), /^main\.dsl:3:14 error \[include-not-found\]/m); // reported in the file as typed
  const outside = harness({ "main.dsl": SHOP("    !include ../x.dsl") });
  assert.equal(run(["check", "main.dsl"], outside.io), 1);
  assert.match(outside.err(), /include-outside/);
});

test("directory includes and constants work from the command line", () => {
  const h = harness({
    "main.dsl": '!const TEAM Payments\n' + SHOP('    !include systems\n    x = person "${TEAM} owner"'),
    "systems/b.dsl": 'b = softwareSystem "B ${TEAM}"\n',
    "systems/a.dsl": 'a = softwareSystem "A"\n',
    "systems/readme.txt": "ignored",
  });
  assert.equal(run(["resolve", "main.dsl", "--compact"], h.io), 0);
  const ws = JSON.parse(h.out());
  assert.deepEqual(ws.model.elements.map((e: { name: string }) => e.name), ["A", "B Payments", "Payments owner"]);
});

test("--define overrides the file's own constants; the environment is the fallback", () => {
  const files = { "main.dsl": '!const ENV dev\n' + SHOP('    a = softwareSystem "${ENV} ${REGION}"') };
  const h = harness(files, "", { REGION: "eu" });
  run(["resolve", "main.dsl", "--compact"], h.io);
  assert.equal(JSON.parse(h.out()).model.elements[0].name, "dev eu");
  const d = harness(files, "", { REGION: "eu" });
  run(["resolve", "main.dsl", "--compact", "--define", "ENV=prod", "--define", "REGION=us"], d.io);
  assert.equal(JSON.parse(d.out()).model.elements[0].name, "prod us"); // a define beats both the file and the environment
});

test("--define needs NAME=VALUE", () => {
  for (const args of [["check", "main.dsl", "--define"], ["check", "main.dsl", "--define", "nope"], ["check", "main.dsl", "--define", "bad name=1"]]) {
    const h = harness({ "main.dsl": SHOP("") });
    assert.equal(run(args, h.io), 2, args.join(" "));
  }
  const empty = harness({ "main.dsl": '!const E ""\n' + SHOP('    a = softwareSystem "[${E}]"') });
  run(["resolve", "main.dsl", "--compact", "--define", "E="], empty.io);
  assert.equal(JSON.parse(empty.out()).model.elements[0].name, "[]"); // an empty value is allowed
});

test("standard input: includes need --base-dir, otherwise they are skipped with a warning", () => {
  const files = { "p.dsl": 'u = person "User"\n' };
  const src = SHOP("    !include p.dsl");
  const without = harness(files, src);
  assert.equal(run(["check", "-"], without.io), 0);
  assert.match(without.err(), /warning \[include-unavailable\]/);
  const withBase = harness(files, src);
  assert.equal(run(["summary", "-", "--base-dir", "."], withBase.io), 0);
  assert.match(withBase.out(), /1 elements/);
  assert.equal(withBase.err(), "");
});

test("a cycle between includes is reported, not looped on", () => {
  const h = harness({ "main.dsl": SHOP("    !include a.dsl"), "a.dsl": "!include b.dsl\n", "b.dsl": "!include a.dsl\n" });
  assert.equal(run(["check", "main.dsl"], h.io), 1);
  assert.match(h.err(), /include-cycle/);
});

// ---- the real file system -----------------------------------------------------------------------------------------
const EXAMPLE = fileURLToPath(new URL("../../../examples/multi-file/main.dsl", import.meta.url));

function real(args: string[]): { code: number; out: string; err: string } {
  let out = "", err = "";
  const code = run(args, nodeIO({ stdout: (t) => void (out += t), stderr: (t) => void (err += t) }));
  return { code, out, err };
}

test("real files: the multi-file example checks clean and resolves through a file and a directory include", () => {
  const c = real(["check", EXAMPLE]);
  assert.equal(c.code, 0, c.err);
  assert.equal(c.err, "");
  const r = real(["resolve", EXAMPLE, "--compact"]);
  const ws = JSON.parse(r.out);
  assert.equal(ws.name, "Acme online shop (dev)"); // a constant and a variable in the name
  assert.deepEqual(ws.model.elements.map((e: { name: string }) => e.name), ["Customer", "Support agent", "Shop (staging)", "Payments"]);
  assert.equal(ws.model.elements[2].description, "Acme storefront"); // a constant used inside an included file
  assert.equal(ws.model.relationships.length, 3);
});

test("real files: --define overrides the variable (the included file's !var too), and svg/export render the example", () => {
  const r = real(["resolve", EXAMPLE, "--compact", "--define", "ENV=prod", "--define", "COMPANY=Globex"]);
  const ws = JSON.parse(r.out);
  assert.equal(ws.name, "Globex online shop (prod)");
  assert.equal(ws.model.elements[2].name, "Shop (prod)");
  assert.match(real(["svg", EXAMPLE]).out, /<svg /);
  assert.match(real(["export", EXAMPLE, "--format", "mermaid"]).out, /Shop \(staging\)/);
});

test("real files: a problem inside an included file is reported with that file's real path and exit code 1", () => {
  const fragment = fileURLToPath(new URL("../../../examples/multi-file/people/users.dsl", import.meta.url));
  const inside = real(["check", fragment]); // checking the fragment alone: it has no workspace, so errors everywhere
  assert.equal(inside.code, 1);
  assert.match(inside.err, /users\.dsl:1:12 error \[unknown-keyword\]/); // the keyword after `customer = `
  const missing = real(["check", fileURLToPath(new URL("./no-such-file.dsl", import.meta.url))]);
  assert.equal(missing.code, 2);
});
