import { exportMermaid, exportPlantUML } from "../../exporters/src/index.ts";
import { listViews, renderView } from "../../viewer/src/index.ts";
import type { Analysis } from "./language.ts";

/**
 * Exporting views, minus VS Code: the formats on offer, producing the content, and naming files.
 * export-commands.ts drives the dialogs around these.
 */

export type FormatId = "svg" | "plantuml-c4" | "plantuml-basic" | "mermaid-flowchart" | "mermaid-c4";

export interface FormatInfo {
  id: FormatId;
  label: string;
  detail: string;
  extension: string;
  /** VS Code language id used when opening the text in an editor. */
  language: string;
}

export const FORMATS: readonly FormatInfo[] = [
  { id: "svg", label: "SVG image", detail: "A standalone diagram: open it in a browser or embed it in documents", extension: "svg", language: "xml" },
  { id: "plantuml-c4", label: "PlantUML (C4)", detail: "Uses the C4-PlantUML library that ships with PlantUML", extension: "puml", language: "plantuml" },
  { id: "plantuml-basic", label: "PlantUML (plain)", detail: "Plain PlantUML with explicit colours; no C4 library needed", extension: "puml", language: "plantuml" },
  { id: "mermaid-flowchart", label: "Mermaid (flowchart)", detail: "Renders on GitHub, GitLab and docs sites, with automatic layout", extension: "mmd", language: "mermaid" },
  { id: "mermaid-c4", label: "Mermaid (C4)", detail: "Mermaid's experimental C4 diagram types", extension: "mmd", language: "mermaid" },
];

export const formatById = (id: string | undefined): FormatInfo | undefined => FORMATS.find((f) => f.id === id);

/** The formats with the preferred one first. */
export function formatsInOrder(preferred: string | undefined): FormatInfo[] {
  const first = formatById(preferred) ?? FORMATS[0]!;
  return [first, ...FORMATS.filter((f) => f.id !== first.id)];
}

export interface ExportOptions {
  /** SVG only. */
  dark?: boolean;
}

export type ExportResult = { ok: true; content: string; format: FormatInfo } | { ok: false; message: string };

/** Views that can be exported (image views are drawn by the tool that owns the image). */
export function exportableViews(a: Analysis): Array<{ key: string; title: string; type: string }> {
  return listViews(a.result.workspace)
    .filter((v) => v.type !== "image")
    .map(({ key, title, type }) => ({ key, title, type }));
}

export function exportView(a: Analysis, key: string, format: FormatId, options: ExportOptions = {}): ExportResult {
  const info = formatById(format);
  if (!info) return { ok: false, message: `Unknown export format '${format}'.` };
  const ws = a.result.workspace;
  const view = ws.views.find((v) => v.key === key);
  if (!view) return { ok: false, message: `There is no view '${key}'.` };
  if (view.type === "image") return { ok: false, message: `The view '${key}' is an image view; it cannot be exported (it is drawn by the tool that owns the image).` };

  let content: string | undefined;
  if (format === "svg") content = renderView(ws, key, { dark: options.dark ?? false, title: true })?.svg;
  else if (format === "plantuml-c4") content = exportPlantUML(ws, key, { flavor: "c4" });
  else if (format === "plantuml-basic") content = exportPlantUML(ws, key, { flavor: "basic" });
  else if (format === "mermaid-flowchart") content = exportMermaid(ws, key, { flavor: "flowchart" });
  else content = exportMermaid(ws, key, { flavor: "c4" });
  if (content === undefined) return { ok: false, message: `The view '${key}' could not be exported as ${info.label}.` };
  return { ok: true, content: content.endsWith("\n") ? content : content + "\n", format: info };
}

/** A file-name-safe version of a view key. */
export const safeName = (key: string): string => key.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_") || "view";

/** The document's name without directory or extension. */
export function baseName(path: string | undefined): string {
  const file = (path ?? "").split(/[\\/]/).pop() ?? "";
  return file.replace(/\.[^.]*$/, "") || "workspace";
}

export const suggestedFileName = (docBase: string, key: string, extension: string): string => `${docBase}-${safeName(key)}.${extension}`;

export interface ExportedFile {
  name: string;
  content: string;
  key: string;
}

/** Every exportable view as a file named after its key. Keys that sanitise to the same name get a numeric suffix. */
export function exportAllViews(a: Analysis, format: FormatId, options: ExportOptions = {}): { files: ExportedFile[]; skipped: string[]; failed: string[] } {
  const info = formatById(format)!;
  const files: ExportedFile[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const used = new Set<string>();
  for (const v of listViews(a.result.workspace)) {
    if (v.type === "image") {
      skipped.push(v.key);
      continue;
    }
    const r = exportView(a, v.key, format, options);
    if (!r.ok) {
      failed.push(v.key);
      continue;
    }
    const base = safeName(v.key);
    let name = `${base}.${info.extension}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}.${info.extension}`;
    used.add(name.toLowerCase());
    files.push({ name, content: r.content, key: v.key });
  }
  return { files, skipped, failed };
}

/** A note to show when the file has errors, since the export then reflects only what could be resolved. */
export function errorNote(a: Analysis): string | undefined {
  const n = a.result.diagnostics.filter((d) => d.severity === "error").length;
  return n === 0 ? undefined : `The file has ${n} error${n === 1 ? "" : "s"}, so the export shows only what could be resolved.`;
}
