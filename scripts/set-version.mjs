// Usage:
//   node scripts/set-version.mjs          -> sync VERSION into all package.json files
//   node scripts/set-version.mjs 0.3.0    -> write VERSION, then sync
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = join(root, 'VERSION');

const arg = process.argv[2]?.replace(/^v/, '');
if (arg) writeFileSync(versionFile, arg + '\n');

const version = readFileSync(versionFile, 'utf8').trim();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version in VERSION: "${version}"`);
  process.exit(1);
}

// Root package.json plus every packages/*/package.json
const packagesDir = join(root, 'packages');
const files = [
  join(root, 'package.json'),
  ...readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(packagesDir, d.name, 'package.json'))
    .filter(existsSync),
];

const pkgs = files.map((file) => {
  const text = readFileSync(file, 'utf8');
  return { file, text, json: JSON.parse(text) };
});
const ownNames = new Set(pkgs.map((p) => p.json.name).filter(Boolean));
const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

for (const { file, text, json } of pkgs) {
  json.version = version;

  // Keep references between your own packages in step too
  for (const field of depFields) {
    for (const dep of Object.keys(json[field] ?? {})) {
      if (!ownNames.has(dep)) continue;
      const m = /^([\^~]?)\d+\.\d+\.\d+/.exec(json[field][dep]);
      if (m) json[field][dep] = m[1] + version;
    }
  }

  const indent = /^(\s+)"/m.exec(text)?.[1] ?? '  ';
  writeFileSync(file, JSON.stringify(json, null, indent) + '\n');
  console.log(`${json.name ?? file}: ${version}`);
}