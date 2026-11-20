/**
 * Builds structurizr-dsl-<version>.vsix without vsce: a .vsix is a zip with a manifest. Uses only Node.
 * Run: npm run package   (builds first)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- files that ship ---------------------------------------------------------
const files = [];
const add = (rel) => {
  const abs = join(root, rel);
  if (statSync(abs).isDirectory()) for (const n of readdirSync(abs)) add(join(rel, n));
  else files.push({ name: "extension/" + rel.split(sep).join("/"), data: readFileSync(abs) });
};
for (const p of ["package.json", "README.md", "language-configuration.json", "syntaxes", "dist",
  "images"]) if (existsSync(join(root, p))) add(p);

// ---- manifest and content types ------------------------------------------------
const hasReadme = files.some((f) => f.name === "extension/README.md");
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>structurizr,c4,dsl,architecture</Tags>
    <Categories>${esc((pkg.categories ?? []).join(","))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />${
      hasReadme ? '\n    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />' : ""
    }
  </Assets>
</PackageManifest>
`;
const types = { ".json": "application/json", ".js": "application/javascript", ".cjs": "application/javascript", ".md": "text/markdown", ".vsixmanifest": "text/xml" };
const exts = new Set(files.map((f) => extname(f.name)).concat(".vsixmanifest"));
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${[...exts].map((e) => `  <Default Extension="${esc(e)}" ContentType="${types[e] ?? "application/octet-stream"}" />`).join("\n")}
</Types>
`;
const entries = [
  { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
  { name: "extension.vsixmanifest", data: Buffer.from(manifest) },
  ...files,
];

// ---- minimal zip writer (stored, UTF-8 names) -------------------------------------
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const u16 = (n) => Buffer.from([n & 255, (n >> 8) & 255]);
const u32 = (n) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const parts = [];
const central = [];
let offset = 0;
for (const e of entries) {
  const name = Buffer.from(e.name, "utf8");
  const crc = crc32(e.data);
  const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(DOS_DATE), u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length), u16(0), name]);
  central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(DOS_DATE), u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
  parts.push(local, e.data);
  offset += local.length + e.data.length;
}
const cd = Buffer.concat(central);
const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
const out = join(root, `${pkg.name}-${pkg.version}.vsix`);
writeFileSync(out, Buffer.concat([...parts, cd, eocd]));
console.log(`wrote ${relative(process.cwd(), out)} (${entries.length} entries)`);
