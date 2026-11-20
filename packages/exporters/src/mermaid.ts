import type { Workspace } from "../../core/src/index.ts";
import { c4Document } from "./c4.ts";
import type { ExportedView } from "./common.ts";
import { flowchartDocument } from "./flowchart.ts";

/**
 * Mermaid export.
 *
 *   flowchart  (default) a Mermaid flowchart: renders everywhere (GitHub, GitLab, docs sites), with automatic layout,
 *              subgraphs for boundaries and nested deployment nodes, and your element/relationship colours.
 *   c4         Mermaid's C4 diagram types (C4Context, C4Container, ...). Mermaid marks these experimental and
 *              places shapes in rows rather than laying them out, so they suit small diagrams.
 */

export type MermaidFlavor = "flowchart" | "c4";

export interface MermaidOptions {
  flavor?: MermaidFlavor;
}

export function exportMermaid(ws: Workspace, key: string, options: MermaidOptions = {}): string | undefined {
  const view = ws.views.find((v) => v.key === key);
  if (!view || view.type === "image") return undefined;
  return (options.flavor ?? "flowchart") === "c4" ? c4Document(ws, view, "mermaid") : flowchartDocument(ws, view);
}

export function exportAllMermaid(ws: Workspace, options: MermaidOptions = {}): ExportedView[] {
  const out: ExportedView[] = [];
  for (const v of ws.views) {
    const content = exportMermaid(ws, v.key, options);
    if (content !== undefined) out.push({ key: v.key, content });
  }
  return out;
}
