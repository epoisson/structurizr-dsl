import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IO } from "./run.ts";

/** The real file system and process streams, for `run`. */
export function nodeIO(streams: { stdout?: (t: string) => void; stderr?: (t: string) => void } = {}): IO {
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    readStdin: () => readFileSync(0, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c),
    mkdirp: (p) => void mkdirSync(p, { recursive: true }),
    resolve: (p) => resolve(p),
    listDirectory: (p) => {
      try {
        if (!statSync(p).isDirectory()) return undefined;
        const dir = p.replace(/\\/g, "/").replace(/\/+$/, "");
        return readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => `${dir}/${e.name}`);
      } catch {
        return undefined;
      }
    },
    env: process.env,
    stdout: streams.stdout ?? ((t) => void process.stdout.write(t)),
    stderr: streams.stderr ?? ((t) => void process.stderr.write(t)),
  };
}
