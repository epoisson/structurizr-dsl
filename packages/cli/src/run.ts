import { indexWorkspace, load, parse } from "../../core/src/index.ts";
import type { Diagnostic, IncludeHost, ParseOptions } from "../../core/src/index.ts";
import { listViews, renderView } from "../../viewer/src/index.ts";
import { exportMermaid, exportPlantUML } from "../../exporters/src/index.ts";
import type { MermaidFlavor, PlantUMLFlavor } from "../../exporters/src/index.ts";

/**
 * The command line, as a function: arguments in, exit code out. All I/O goes through `IO`, so it is
 * testable and reusable (bin.ts supplies the real file system).
 *
 * Exit codes: 0 = no errors (warnings are fine), 1 = the DSL has errors, 2 = bad usage or unreadable file.
 */

export interface IO {
  readFile(path: string): string;
  readStdin(): string;
  writeFile(path: string, content: string): void;
  mkdirp(path: string): void;
  /** The absolute path for a path as typed (relative to the current directory). */
  resolve(path: string): string;
  /** The entries of a directory (full paths), or undefined if the path is not a directory. */
  listDirectory(path: string): string[] | undefined;
  /** Environment variables, for `${NAME}` in the DSL. */
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const VERSION = "0.2.3";

export const HELP = `structurizr-dsl ${VERSION}: parse, check and resolve Structurizr DSL files

Usage:
  structurizr-dsl <command> <file...> [options]

Commands:
  check     Report errors and warnings. Exit code 1 if there are errors.
  summary   Print what the workspace contains (elements, relationships, views).
  resolve   Print the resolved workspace as JSON (elements, relationships, views with contents).
  parse     Print the syntax tree as JSON.
  svg       Render a view as an SVG diagram.
  export    Export a view to another diagram language (--format plantuml | mermaid).

A file of "-" reads standard input (relative !include paths then need --base-dir).

Options:
  -o, --out <file>    Write JSON output to a file instead of standard output.
      --compact       Minified JSON (default is indented).
      --json          check: print diagnostics as JSON.
  -q, --quiet         check: print nothing, only set the exit code.
      --no-warnings   check: hide warnings.
      --view <key>    svg, export: the view (default: the default view, else the first).
      --all           svg, export: every view into the directory given with -o (one file per view).
      --list          svg, export: list the views and exit.
      --format <f>    export: plantuml (default) or mermaid.
      --flavor <f>    export: plantuml: c4 (default, C4-PlantUML library) or basic (plain PlantUML);
                              mermaid: flowchart (default, renders everywhere) or c4 (Mermaid C4 diagrams).
      --dark          svg: dark colour scheme.
      --no-title      svg: omit the title.
      --define N=V    Define a constant for \${N} in the DSL, overriding the file's own !const/!var (repeatable).
      --base-dir <d>  Standard input only: the directory relative !include paths are resolved against.
  -h, --help          Show this help.
  -v, --version       Show the version.

Exit codes: 0 ok, 1 the DSL has errors, 2 bad usage or unreadable file.

Examples:
  structurizr-dsl check workspace.dsl
  structurizr-dsl resolve workspace.dsl -o workspace.json
  structurizr-dsl svg workspace.dsl --view containers -o containers.svg
  structurizr-dsl svg workspace.dsl --all -o diagrams/
  structurizr-dsl export workspace.dsl --format plantuml --view containers -o containers.puml
  structurizr-dsl export workspace.dsl --all -o puml/ --flavor basic
  structurizr-dsl export workspace.dsl --format mermaid --view containers -o containers.mmd
  structurizr-dsl check workspace.dsl --define ENVIRONMENT=prod
  cat workspace.dsl | structurizr-dsl summary - --base-dir .
`;

interface Options {
  out?: string;
  compact: boolean;
  json: boolean;
  quiet: boolean;
  warnings: boolean;
  view?: string;
  defines: Record<string, string>;
  baseDir?: string;
  format: string;
  flavor?: string;
  all: boolean;
  list: boolean;
  dark: boolean;
  title: boolean;
}

class UsageError extends Error {}

function parseArgs(args: string[]): { command?: string; files: string[]; options: Options; help: boolean; version: boolean } {
  const options: Options = { compact: false, json: false, quiet: false, warnings: true, all: false, list: false, dark: false, title: true, defines: {}, format: "plantuml" };
  const positional: string[] = [];
  let help = false;
  let version = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      case "-o":
      case "--out": {
        const v = args[++i];
        if (v === undefined) throw new UsageError(`${a} needs a file name.`);
        options.out = v;
        break;
      }
      case "--compact":
        options.compact = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-q":
      case "--quiet":
        options.quiet = true;
        break;
      case "--no-warnings":
        options.warnings = false;
        break;
      case "--view": {
        const v = args[++i];
        if (v === undefined) throw new UsageError("--view needs a view key.");
        options.view = v;
        break;
      }
      case "--format": {
        const v = args[++i];
        if (v === undefined) throw new UsageError("--format needs a name (plantuml or mermaid).");
        options.format = v.toLowerCase();
        break;
      }
      case "--flavor": {
        const v = args[++i]?.toLowerCase();
        if (v === undefined) throw new UsageError("--flavor needs a name.");
        options.flavor = v;
        break;
      }
      case "--all":
        options.all = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--define": {
        const v = args[++i];
        const m = v === undefined ? null : /^([A-Za-z0-9\-_.]+)=(.*)$/s.exec(v);
        if (!m) throw new UsageError("--define needs NAME=VALUE (the name may use a-z, A-Z, 0-9, '-', '_' and '.').");
        options.defines[m[1]!] = m[2]!;
        break;
      }
      case "--base-dir": {
        const v = args[++i];
        if (v === undefined) throw new UsageError("--base-dir needs a directory.");
        options.baseDir = v;
        break;
      }
      case "--dark":
        options.dark = true;
        break;
      case "--no-title":
        options.title = false;
        break;
      default:
        if (a.startsWith("-") && a !== "-") throw new UsageError(`Unknown option '${a}'.`);
        positional.push(a);
    }
  }
  const [command, ...files] = positional;
  return { command, files, options, help, version };
}

const label = (file: string): string => (file === "-" ? "<stdin>" : file);

/** Slashes everywhere: the core treats ids as `/`-separated paths, on Windows too. */
const toId = (p: string): string => p.replace(/\\/g, "/");

function formatDiagnostic(file: string, d: Diagnostic, rootId?: string): string {
  // diagnostics in the file as typed are shown with that name; those in an included file with its full path
  const where = d.range.file !== undefined && d.range.file !== rootId ? d.range.file : file;
  return `${label(where)}:${d.range.start.line + 1}:${d.range.start.column + 1} ${d.severity} [${d.code}] ${d.message}`;
}

export function run(args: string[], io: IO): number {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    io.stderr(`${(e as Error).message}\nRun 'structurizr-dsl --help' for usage.\n`);
    return 2;
  }
  const { command, files, options } = parsed;

  if (parsed.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (parsed.help || !command) {
    (parsed.help ? io.stdout : io.stderr)(HELP);
    return parsed.help ? 0 : 2;
  }
  if (!["check", "summary", "resolve", "parse", "svg", "export"].includes(command)) {
    io.stderr(`Unknown command '${command}'.\nRun 'structurizr-dsl --help' for usage.\n`);
    return 2;
  }
  if (files.length === 0) {
    io.stderr(`'${command}' needs at least one file.\n`);
    return 2;
  }
  if ((command === "resolve" || command === "parse" || command === "svg" || command === "export") && files.length > 1) {
    io.stderr(`'${command}' takes exactly one file.\n`);
    return 2;
  }

  const json = (value: unknown): string => JSON.stringify(value, null, options.compact ? undefined : 2) + "\n";
  const emit = (text: string): void => (options.out ? io.writeFile(options.out, text) : io.stdout(text));

  let exit = 0;
  const allDiagnostics: Array<{ file: string; diagnostics: Diagnostic[] }> = [];

  for (const file of files) {
    let source: string;
    try {
      source = file === "-" ? io.readStdin() : io.readFile(file);
    } catch (e) {
      io.stderr(`Cannot read ${label(file)}: ${(e as Error).message}\n`);
      return 2;
    }

    // Where this source lives, so relative !include paths resolve; and how to read the files they name.
    const rootId = file === "-" ? (options.baseDir !== undefined ? `${toId(io.resolve(options.baseDir))}/<stdin>` : undefined) : toId(io.resolve(file));
    const host: IncludeHost = {
      readFile: (id) => {
        try {
          return io.readFile(id);
        } catch {
          return undefined;
        }
      },
      listDirectory: (id) => io.listDirectory(id),
    };
    const loadOptions: ParseOptions = { host, env: io.env, variables: options.defines, ...(rootId !== undefined ? { file: rootId } : {}) };

    if (command === "parse") {
      const r = parse(source, loadOptions);
      emit(json(r.root));
      for (const d of r.diagnostics) io.stderr(formatDiagnostic(file, d, rootId) + "\n");
      if (r.firstError) exit = 1;
      continue;
    }

    const r = load(source, loadOptions);
    if (!r.ok) exit = 1;

    if (command === "svg" || command === "export") {
      const FORMATS: Record<string, { ext: string; flavors: string[] }> = {
        plantuml: { ext: "puml", flavors: ["c4", "basic"] },
        mermaid: { ext: "mmd", flavors: ["flowchart", "c4"] },
      };
      const format = FORMATS[options.format];
      if (command === "export") {
        if (!format) {
          io.stderr(`Unknown export format '${options.format}'. Available: ${Object.keys(FORMATS).join(", ")}.\n`);
          return 2;
        }
        if (options.flavor !== undefined && !format.flavors.includes(options.flavor)) {
          io.stderr(`--flavor '${options.flavor}' is not available for ${options.format}. Choose: ${format.flavors.join(" or ")}.\n`);
          return 2;
        }
      }
      const ext = command === "svg" ? "svg" : format!.ext;
      for (const d of r.diagnostics) io.stderr(formatDiagnostic(file, d, rootId) + "\n");
      const ws = r.workspace;
      const views = listViews(ws);
      if (options.list) {
        io.stdout(views.map((v) => `${v.key}\t${v.type}\t${v.title}${v.isDefault ? "\t(default)" : ""}`).join("\n") + (views.length ? "\n" : ""));
        continue;
      }
      if (views.length === 0) {
        io.stderr("The workspace has no views to render.\n");
        return 2;
      }
      const render = (key: string): string | undefined =>
        command === "svg"
          ? renderView(ws, key, { dark: options.dark, title: options.title })!.svg
          : options.format === "mermaid"
            ? exportMermaid(ws, key, options.flavor ? { flavor: options.flavor as MermaidFlavor } : {})
            : exportPlantUML(ws, key, options.flavor ? { flavor: options.flavor as PlantUMLFlavor } : {});
      if (options.all) {
        if (!options.out) {
          io.stderr("--all needs an output directory (-o <dir>).\n");
          return 2;
        }
        io.mkdirp(options.out);
        let written = 0;
        for (const v of views) {
          const content = render(v.key);
          if (content === undefined) continue; // e.g. image views cannot be exported
          io.writeFile(`${options.out.replace(/[\\/]+$/, "")}/${v.key.replace(/[^\w.-]/g, "_")}.${ext}`, content);
          written++;
        }
        io.stdout(`wrote ${written} diagram${written === 1 ? "" : "s"} to ${options.out}\n`);
        continue;
      }
      const key = options.view ?? (views.find((v) => v.isDefault) ?? views[0]!).key;
      if (!views.some((v) => v.key === key)) {
        io.stderr(`There is no view '${key}'. Views: ${views.map((v) => v.key).join(", ")}\n`);
        return 2;
      }
      const content = render(key);
      if (content === undefined) {
        io.stderr(`The view '${key}' cannot be ${command === "svg" ? "rendered" : "exported"} (image views are drawn by the tool that owns the image).\n`);
        return 2;
      }
      emit(content + (content.endsWith("\n") ? "" : "\n"));
      continue;
    }

    if (command === "resolve") {
      emit(json(r.workspace));
      for (const d of r.diagnostics) io.stderr(formatDiagnostic(file, d, rootId) + "\n");
    } else if (command === "check") {
      const shown = r.diagnostics.filter((d) => options.warnings || d.severity === "error");
      allDiagnostics.push({ file, diagnostics: shown });
      if (!options.quiet && !options.json) {
        for (const d of shown) io.stderr(formatDiagnostic(file, d, rootId) + "\n");
        if (files.length > 1 || shown.length === 0) {
          io.stdout(`${label(file)}: ${r.ok ? "ok" : "errors"}${shown.length ? ` (${shown.length} diagnostic${shown.length === 1 ? "" : "s"})` : ""}\n`);
        }
      }
    } else {
      // summary
      const ws = r.workspace;
      const ix = indexWorkspace(ws);
      const count = (t: string): number => ws.model.elements.filter((e) => e.type === t).length;
      let text = `${ws.name || "(unnamed workspace)"}\n`;
      text +=
        `  ${ws.model.elements.length} elements ` +
        `(${count("person")} people, ${count("softwareSystem")} software systems, ${count("container")} containers, ${count("component")} components), ` +
        `${ws.model.relationships.length} relationships, ${ws.views.length} views\n`;
      for (const v of ws.views) {
        text += `  view ${v.key} [${v.type}]: ${ix.viewElements(v).length} elements, ${ix.viewRelationships(v).length} relationships\n`;
      }
      emit(text);
      for (const d of r.diagnostics) io.stderr(formatDiagnostic(file, d, rootId) + "\n");
    }
  }

  if (command === "check" && options.json && !options.quiet) {
    io.stdout(json(allDiagnostics.map((x) => ({ file: label(x.file), diagnostics: x.diagnostics }))));
  }
  return exit;
}
