/**
 * Builds a release into ./release : runs the gates, builds every artifact, writes checksums.
 *   node scripts/release.mjs
 *
 * Gates (any failure stops the release): every package has the same version, tests pass, types check
 * (when TypeScript is installed), CHANGELOG has a section for this version.
 * Set PLANTUML_JAR=/path/to/plantuml.jar to also validate every PlantUML export with the real tool.
 *
 * Artifacts: the CLI package (.tgz), the VS Code extension (.vsix), a source archive (from the git tag when
 * HEAD is tagged v<version>), release notes, and SHA256SUMS. Needs Node 22.13+ and npm.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
const fail = (msg) => {
  console.error(`\nRELEASE ABORTED: ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n== ${msg}`);

// ---- 1. versions ---------------------------------------------------------------------------------------
step("versions");
const manifests = ["package.json", ...readdirSync(join(root, "packages")).map((p) => `packages/${p}/package.json`)];
const versions = new Map(manifests.map((m) => [m, JSON.parse(readFileSync(join(root, m), "utf8")).version]));
const version = versions.get("package.json");
for (const [m, v] of versions) if (v !== version) fail(`${m} is ${v}, expected ${version}`);
console.log(`all ${versions.size} packages at ${version}`);

// ---- 2. changelog ----------------------------------------------------------------------------------------
step("changelog");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const m = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, "m").exec(changelog);
if (!m) fail(`CHANGELOG.md has no "## [${version}]" section`);
const notes = `# structurizr-dsl ${version}\n\n${m[1].trim()}\n`;
console.log(`found the ${version} section (${notes.split("\n").length} lines)`);

// ---- 3. gates -------------------------------------------------------------------------------------------------
step("tests" + (process.env.PLANTUML_JAR ? " (including real PlantUML validation)" : " (PLANTUML_JAR not set: real PlantUML check skipped)"));
run("npm", ["test"]);
step("types");
if (existsSync(join(root, "node_modules", ".bin", "tsc"))) run("npm", ["run", "typecheck"]);
else console.log("TypeScript is not installed: skipping the typecheck (npm install to enable it)");

// ---- 4. artifacts -----------------------------------------------------------------------------------------------
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const artifacts = [];

step("CLI package");
run("npm", ["run", "build", "-w", "packages/cli"]);
const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: join(root, "packages", "cli"), encoding: "utf8" }).trim().split("\n").pop();
artifacts.push(packed);

step("VS Code extension");
run("npm", ["run", "package", "-w", "packages/extension"]);
const vsix = `structurizr-dsl-${version}.vsix`;
copyFileSync(join(root, "packages", "extension", vsix), join(out, vsix));
rmSync(join(root, "packages", "extension", vsix));
artifacts.push(vsix);

step("source archive");
const tag = `v${version}`;
const head = spawnSync("git", ["describe", "--exact-match", "--tags", "HEAD"], { cwd: root, encoding: "utf8" });
if (head.status === 0 && head.stdout.trim() === tag) {
  const archive = `structurizr-dsl-${version}-source.zip`;
  run("git", ["archive", "--format=zip", `--prefix=structurizr-dsl-${version}/`, "-o", join(out, archive), tag]);
  artifacts.push(archive);
} else {
  console.log(`HEAD is not tagged ${tag}: no source archive (tag the commit first: git tag ${tag})`);
}

writeFileSync(join(out, "RELEASE-NOTES.md"), notes);
artifacts.push("RELEASE-NOTES.md");

// ---- 5. checksums -----------------------------------------------------------------------------------------------
step("checksums");
const sums = artifacts.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`);
writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(sums.join("\n"));
console.log(`\nRelease ${version} is in ${out}`);
