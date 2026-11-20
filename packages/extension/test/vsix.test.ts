import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const { name, version } = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { name: string; version: string };

/** Reads a zip's central directory: name -> { data, crc }, verifying sizes and CRCs as it goes. */
function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, "end of central directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    assert.equal(method, 0, "stored");
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test("the .vsix is a valid package with the files VS Code needs", () => {
  execFileSync(process.execPath, [`${root}scripts/vsix.mjs`], { stdio: "ignore" });
  const file = `${root}${name}-${version}.vsix`;
  try {
    const zip = readZip(readFileSync(file));
    for (const name of [
      "[Content_Types].xml",
      "extension.vsixmanifest",
      "extension/package.json",
      "extension/README.md",
      "extension/language-configuration.json",
      "extension/syntaxes/structurizr.tmLanguage.json",
      "extension/dist/extension.cjs",
      "extension/dist/esm/package.json",
      "extension/dist/esm/ext/adapter.js",
      "extension/dist/esm/core/parser.js",
      "extension/dist/esm/viewer/render.js",
      "extension/dist/esm/viewer/layout.js",
      "extension/dist/esm/ext/preview.js",
      "extension/dist/esm/ext/exporting.js",
      "extension/dist/esm/ext/export-commands.js",
      "extension/dist/esm/ext/analysis-service.js",
      "extension/dist/esm/exporters/plantuml.js",
      "extension/dist/esm/exporters/mermaid.js",
      "extension/dist/esm/exporters/c4.js",
    ]) assert.ok(zip.has(name), `missing ${name}`);

    const pkg = JSON.parse(zip.get("extension/package.json")!.toString());
    assert.equal(pkg.contributes.commands[0].command, "structurizr.openPreview");
    const commands = pkg.contributes.commands.map((c: { command: string }) => c.command);
    assert.ok(commands.includes("structurizr.exportView") && commands.includes("structurizr.exportAllViews"));
    assert.deepEqual(Object.keys(pkg.contributes.configuration.properties).sort(), ["structurizr.export.action", "structurizr.export.defaultFormat", "structurizr.export.svgTheme", "structurizr.includes.allowRemote", "structurizr.variables"]);
    assert.ok(pkg.contributes.menus["editor/context"].some((m: { command: string }) => m.command === "structurizr.exportView"));
    assert.ok(pkg.contributes.menus["editor/title"].some((m: { command: string }) => m.command === "structurizr.openPreview"));

    const manifest = zip.get("extension.vsixmanifest")!.toString();
    assert.ok(manifest.includes(`Id="${name}" Version="${version}" Publisher="local"`));
    assert.match(manifest, /Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\.80\.0"/);
    assert.match(manifest, /Type="Microsoft\.VisualStudio\.Code\.Manifest" Path="extension\/package\.json"/);

    const types = zip.get("[Content_Types].xml")!.toString();
    for (const ext of [".json", ".js", ".cjs", ".md", ".vsixmanifest"]) assert.ok(types.includes(`Extension="${ext}"`), ext);

    // the packaged files are the real, built ones
    assert.match(zip.get("extension/dist/extension.cjs")!.toString(), /import\("\.\/esm\/ext\/adapter\.js"\)/);
    for (const f of ["ext/adapter.js", "ext/preview.js", "ext/exporting.js", "ext/export-commands.js", "ext/analysis-service.js", "core/preprocess.js", "core/load-async.js", "core/include.js", "viewer/render.js", "exporters/plantuml.js", "exporters/c4.js", "exporters/flowchart.js"]) {
      const code = zip.get(`extension/dist/esm/${f}`)!.toString();
      assert.ok(!/\.ts["']/.test(code), `no .ts import specifiers left in ${f}`);
      for (const m of code.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
        // every relative import points at a file that is in the package
        const dir = `extension/dist/esm/${f.split("/")[0]}`;
        const parts = (dir + "/" + m[1]).split("/");
        const out: string[] = [];
        for (const part of parts) part === ".." ? out.pop() : part !== "." && out.push(part);
        assert.ok(zip.has(out.join("/")), `${f} imports ${m[1]}, which is missing from the package`);
      }
    }
    // no test files, sources or build tooling leak into the package
    assert.ok([...zip.keys()].every((n) => !/\/(test|scripts|src)\//.test(n)));
  } finally {
    rmSync(file, { force: true });
  }
});
