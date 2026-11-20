import { loadAsync } from "../../core/src/index.ts";
import type { AsyncIncludeHost, Diagnostic, IncludeHost, Range } from "../../core/src/index.ts";
import { analyze, diagnosticsByFile, isFragment, viewFromFragment } from "./language.ts";
import type { Analysis } from "./language.ts";

/**
 * Analysing documents that use `!include`, in VS Code.
 *
 * - Included files may be open (and edited, unsaved) or only on disk. A synchronous host serves the providers
 *   from open documents plus a cache of disk reads; an asynchronous host does the real reads for a refresh.
 * - Diagnostics are published per file: a problem inside an included file shows up on that file.
 * - A file that is only ever included (no `workspace`) is a fragment: analysed alone it would be all errors, so
 *   its diagnostics and editor features come from the workspace that includes it.
 * - Editing a file refreshes every open workspace that includes it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VSCode = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;

const LANGUAGE = "structurizr";
const DEBOUNCE_MS = 250;

export interface AnalysisHooks {
  /** Called when the analysis of a workspace document has been (re)computed and published. */
  onUpdated(uri: string): void;
}

export interface AnalysisService {
  /** The analysis to base editor features on. Synchronous; fragments are seen through their workspace. */
  analysisOf(doc: Doc): Analysis;
  /** Re-analyses a document, reading included files as needed, and publishes diagnostics. */
  refresh(doc: Doc): Promise<void>;
  /** A debounced refresh, which also refreshes the open workspaces that include this document. */
  schedule(doc: Doc): void;
  closed(doc: Doc): void;
  /** A file changed on disk (`structural`: created or deleted, which also changes directory listings). */
  fileChanged(uri: string, structural: boolean): void;
}

export function createAnalysisService(vscode: VSCode, diagnostics: Doc, hooks: AnalysisHooks): AnalysisService {
  const diskCache = new Map<string, string | undefined>();
  const dirCache = new Map<string, string[] | undefined>();
  const analyses = new Map<string, { version: number; stamp: number; analysis: Analysis }>();
  const deps = new Map<string, Set<string>>();
  const perRoot = new Map<string, Map<string, Diagnostic[]>>();
  const generation = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bumped when files change on disk, so cached analyses are recomputed. */
  let stamp = 0;

  const toRange = (r: Range) => new vscode.Range(r.start.line, r.start.column, r.end.line, r.end.column);
  const severity = (s: string) =>
    s === "error" ? vscode.DiagnosticSeverity.Error : s === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
  const settings = () => vscode.workspace.getConfiguration("structurizr");
  const options = () => ({ variables: settings().get("variables", {}) as Record<string, string>, env: process.env });
  const openDocs = (): Doc[] => vscode.workspace.textDocuments.filter((d: Doc) => d.languageId === LANGUAGE);
  const openDoc = (uri: string): Doc | undefined => vscode.workspace.textDocuments.find((d: Doc) => d.uri.toString() === uri);

  // ---- hosts --------------------------------------------------------------------------------------------------

  /** What the providers see: open documents first, then whatever has already been read from disk. */
  const syncHost: IncludeHost = {
    readFile: (id) => openDoc(id)?.getText() ?? diskCache.get(id),
    listDirectory: (id) => dirCache.get(id),
  };

  const asyncHost = (): AsyncIncludeHost => {
    const host: AsyncIncludeHost = {
      readFile: async (id) => {
        const open = openDoc(id);
        if (open) return open.getText();
        if (diskCache.has(id)) return diskCache.get(id);
        let text: string | undefined;
        try {
          text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(id)));
        } catch {
          text = undefined;
        }
        diskCache.set(id, text);
        return text;
      },
      listDirectory: async (id) => {
        if (dirCache.has(id)) return dirCache.get(id);
        let entries: string[] | undefined;
        try {
          const listing: Array<[string, number]> = await vscode.workspace.fs.readDirectory(vscode.Uri.parse(id));
          entries = listing.filter(([, type]) => (type & vscode.FileType.File) !== 0).map(([name]) => `${id.replace(/\/+$/, "")}/${encodeURIComponent(name)}`);
        } catch {
          entries = undefined;
        }
        dirCache.set(id, entries);
        return entries;
      },
    };
    // URLs are only fetched when the user has opted in
    if (settings().get("includes.allowRemote", false)) {
      host.readUrl = async (url) => {
        if (diskCache.has(url)) return diskCache.get(url);
        let text: string | undefined;
        try {
          const response = await (globalThis as { fetch?: (u: string) => Promise<{ ok: boolean; text(): Promise<string> }> }).fetch!(url);
          text = response.ok ? await response.text() : undefined;
        } catch {
          text = undefined;
        }
        diskCache.set(url, text);
        return text;
      };
    }
    return host;
  };

  // ---- analyses ---------------------------------------------------------------------------------------------------

  const own = (doc: Doc): Analysis => {
    const uri = doc.uri.toString();
    const hit = analyses.get(uri);
    if (hit && hit.version === doc.version && hit.stamp === stamp) return hit.analysis;
    const analysis = analyze(doc.getText(), uri, syncHost, options());
    analyses.set(uri, { version: doc.version, stamp, analysis });
    return analysis;
  };

  /** The most recently analysed workspace that includes this file. */
  const parentOf = (uri: string): Analysis | undefined => {
    for (const [root, files] of deps) {
      if (root === uri || !files.has(uri)) continue;
      const a = analyses.get(root)?.analysis;
      if (a && !isFragment(a)) return a;
    }
    return undefined;
  };

  const analysisOf = (doc: Doc): Analysis => {
    const a = own(doc);
    if (isFragment(a)) {
      const parent = parentOf(doc.uri.toString());
      if (parent) return viewFromFragment(parent, doc.uri.toString(), doc.getText());
    }
    return a;
  };

  // ---- diagnostics ----------------------------------------------------------------------------------------------------

  const convert = (d: Diagnostic) => {
    const out = new vscode.Diagnostic(toRange(d.range), d.message, severity(d.severity));
    out.code = d.code;
    out.source = "structurizr";
    return out;
  };

  /** Publishes the union of what every analysed workspace says about one file. */
  const recompute = (file: string): void => {
    const seen = new Set<string>();
    const list: unknown[] = [];
    for (const byFile of perRoot.values()) {
      for (const d of byFile.get(file) ?? []) {
        const key = `${d.code}|${d.range.start.offset}|${d.range.end.offset}|${d.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(convert(d));
      }
    }
    const target = vscode.Uri.parse(file);
    if (list.length > 0) diagnostics.set(target, list);
    else diagnostics.delete(target);
  };

  const publish = (rootUri: string, analysis: Analysis, cascade = true): void => {
    const before = perRoot.get(rootUri);
    let byFile: Map<string, Diagnostic[]>;
    if (isFragment(analysis)) {
      // a fragment's own parse is all noise; its problems come from the workspaces that include it
      if (parentOf(rootUri)) byFile = new Map();
      else {
        const first = analysis.lines[0] ?? "";
        const note: Diagnostic = {
          severity: "info",
          code: "fragment",
          message: "This file has no workspace, so it is checked as part of a workspace that !includes it. Open that workspace file to see diagnostics here.",
          range: { start: { offset: 0, line: 0, column: 0 }, end: { offset: first.length, line: 0, column: first.length } },
        };
        byFile = new Map([[rootUri, [note]]]);
      }
    } else byFile = diagnosticsByFile(analysis, rootUri);
    perRoot.set(rootUri, byFile);
    for (const file of new Set([...(before?.keys() ?? []), ...byFile.keys()])) recompute(file);
    if (cascade) republishFragments(deps.get(rootUri));
  };

  /** Fragments' diagnostics depend on whether some workspace includes them, so they follow it. */
  const republishFragments = (files: Iterable<string> | undefined): void => {
    for (const file of files ?? []) {
      const a = analyses.get(file)?.analysis;
      if (a && isFragment(a)) publish(file, a, false);
    }
  };

  // ---- refreshing ---------------------------------------------------------------------------------------------------------

  async function refresh(doc: Doc): Promise<void> {
    if (doc.languageId !== LANGUAGE) return;
    const uri = doc.uri.toString();
    const version = doc.version;
    const text = doc.getText();
    const previousDeps = deps.get(uri);

    let analysis = analyze(text, uri, syncHost, options());
    if (analysis.result.syntax.includes.length > 0) {
      // includes need real reads; do not publish the provisional result (it would claim files are missing)
      const mine = (generation.get(uri) ?? 0) + 1;
      generation.set(uri, mine);
      const result = await loadAsync(text, { file: uri, host: asyncHost(), ...options() });
      if (generation.get(uri) !== mine || doc.version !== version) return; // a newer refresh supersedes this one
      analysis = { source: text, lines: text.split("\n"), result, file: uri };
    }
    analyses.set(uri, { version, stamp, analysis });
    deps.set(uri, new Set(analysis.result.syntax.files));
    publish(uri, analysis);
    // files this workspace stopped including may now be fragments without a home
    if (previousDeps) republishFragments([...previousDeps].filter((f) => !deps.get(uri)!.has(f)));
    hooks.onUpdated(uri);
  }

  const dependents = (uri: string): Doc[] => openDocs().filter((d) => d.uri.toString() !== uri && deps.get(d.uri.toString())?.has(uri));

  function scheduleOne(doc: Doc): void {
    const key = doc.uri.toString();
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void refresh(doc);
      }, DEBOUNCE_MS),
    );
  }

  return {
    analysisOf,
    refresh,
    schedule(doc) {
      if (doc.languageId !== LANGUAGE) return;
      scheduleOne(doc);
      for (const d of dependents(doc.uri.toString())) scheduleOne(d);
    },
    closed(doc) {
      const uri = doc.uri.toString();
      const files = perRoot.get(uri)?.keys();
      const included = deps.get(uri);
      analyses.delete(uri);
      deps.delete(uri);
      const old = perRoot.get(uri);
      perRoot.delete(uri);
      for (const f of new Set([...(files ?? []), uri])) recompute(f);
      if (old && included) republishFragments(included);
    },
    fileChanged(uri, structural) {
      diskCache.delete(uri);
      if (structural) dirCache.clear();
      stamp++;
      for (const d of openDocs()) {
        const key = d.uri.toString();
        if (structural || key === uri || deps.get(key)?.has(uri)) scheduleOne(d);
      }
    },
  };
}
