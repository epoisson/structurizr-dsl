import { randomBytes } from "node:crypto";
import { completionsAt, definitionAt, documentLinks, foldingRanges, hoverAt, outline } from "./language.ts";
import { createAnalysisService } from "./analysis-service.ts";
import { createExportCommands } from "./export-commands.ts";
import { previewHtml, previewPayload, revealTarget } from "./preview.ts";
import type { Analysis, OutlineItem } from "./language.ts";
import type { Range } from "../../core/src/index.ts";

/**
 * Connects the editor features in language.ts to the VS Code API.
 *
 * `vscode` is passed in rather than imported: the extension host loads a small CommonJS shim
 * (dist/extension.cjs) that require()s "vscode" and hands it to this ES module. That keeps this
 * file free of a build-time dependency on @types/vscode, and testable with a mock.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VSCode = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;

const LANGUAGE = "structurizr";
const DEBOUNCE_MS = 250;

export function activate(vscode: VSCode, context: { subscriptions: { dispose(): unknown }[] }): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE);
  const toRange = (r: Range) => new vscode.Range(r.start.line, r.start.column, r.end.line, r.end.column);

  // Analysis, includes, per-file diagnostics and dependency tracking live in the service.
  const service = createAnalysisService(vscode, diagnostics, {
    onUpdated: (uri) => {
      if (uri === previewUri) sendPreview();
    },
  });
  const analysisOf = (doc: Doc): Analysis => service.analysisOf(doc);
  const refresh = (doc: Doc): void => void service.refresh(doc);
  const schedule = (doc: Doc): void => service.schedule(doc);

  // ---- diagram preview ----------------------------------------------------------------------
  let panel: any;
  let previewUri: string | undefined;
  let previewKey: string | undefined;

  const isDark = (): boolean => {
    const kind = vscode.window.activeColorTheme?.kind;
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
  };
  const openDoc = (uri: string): Doc | undefined => vscode.workspace.textDocuments.find((d: Doc) => d.uri.toString() === uri);

  function sendPreview(): void {
    if (!panel || !previewUri) return;
    const doc = openDoc(previewUri);
    if (!doc) {
      panel.webview.postMessage({ type: "render", views: [], current: undefined, svg: undefined, message: "The document is no longer open." });
      return;
    }
    const payload = previewPayload(analysisOf(doc), previewKey, isDark());
    previewKey = payload.current;
    panel.title = `Preview: ${String(doc.uri.path ?? doc.uri).split("/").pop()}`;
    panel.webview.postMessage(payload);
  }

  const reveal = async (click: { id?: string; rel?: string }): Promise<void> => {
    const rootDoc = previewUri ? openDoc(previewUri) : undefined;
    if (!rootDoc) return;
    const target = revealTarget(analysisOf(rootDoc), click);
    if (!target) return;
    // the element may be declared in a file the workspace includes
    const doc = target.file && target.file !== previewUri ? await vscode.workspace.openTextDocument(vscode.Uri.parse(target.file)) : rootDoc;
    const existing = vscode.window.visibleTextEditors?.find((e: Doc) => e.document.uri.toString() === doc.uri.toString());
    await vscode.window.showTextDocument(doc, {
      viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One,
      selection: toRange({ start: target.start, end: target.start }),
      preserveFocus: false,
    });
  };

  const exporter = createExportCommands(vscode, {
    analysisOf,
    currentDoc: () => {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId === LANGUAGE) return editor.document;
      return previewUri ? openDoc(previewUri) : undefined;
    },
    currentKey: () => previewKey,
    isDark,
  });

  const openPreview = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== LANGUAGE) {
      vscode.window.showInformationMessage("Open a Structurizr .dsl file to preview its diagrams.");
      return;
    }
    if (previewUri !== editor.document.uri.toString()) previewKey = undefined;
    previewUri = editor.document.uri.toString();
    if (panel) {
      panel.reveal(vscode.ViewColumn.Beside, true);
      sendPreview();
      return;
    }
    panel = vscode.window.createWebviewPanel("structurizrPreview", "Structurizr Preview", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.webview.html = previewHtml(randomBytes(16).toString("hex"), panel.webview.cspSource);
    panel.webview.onDidReceiveMessage((msg: { type: string; key?: string; id?: string; rel?: string }) => {
      if (msg.type === "ready") sendPreview();
      else if (msg.type === "export") void exporter.exportView({ doc: previewUri ? openDoc(previewUri) : undefined, key: previewKey });
      else if (msg.type === "select") {
        previewKey = msg.key;
        sendPreview();
      } else if (msg.type === "reveal") void reveal(msg);
    });
    panel.onDidDispose(() => {
      panel = undefined;
    });
  };

  const selector = { language: LANGUAGE };
  const symbol = (item: OutlineItem) => {
    const s = new vscode.DocumentSymbol(item.name, item.detail, vscode.SymbolKind[item.kind], toRange(item.range), toRange(item.selectionRange));
    s.children = item.children.map(symbol);
    return s;
  };

  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand("structurizr.openPreview", openPreview),
    vscode.commands.registerCommand("structurizr.exportView", () => exporter.exportView()),
    vscode.commands.registerCommand("structurizr.exportAllViews", () => exporter.exportAllViews()),
    vscode.window.onDidChangeActiveColorTheme(() => sendPreview()),
    // the preview follows whichever Structurizr file you are editing
    vscode.window.onDidChangeActiveTextEditor((editor: Doc) => {
      if (!panel || !editor || editor.document.languageId !== LANGUAGE) return;
      if (previewUri !== editor.document.uri.toString()) previewKey = undefined;
      previewUri = editor.document.uri.toString();
      sendPreview();
    }),
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e: { document: Doc }) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc: Doc) => service.closed(doc)),

    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: (doc: Doc) => outline(analysisOf(doc)).map(symbol),
    }),

    vscode.languages.registerFoldingRangeProvider(selector, {
      provideFoldingRanges: (doc: Doc) =>
        foldingRanges(analysisOf(doc)).map((f) => new vscode.FoldingRange(f.startLine, f.endLine, f.kind === "comment" ? vscode.FoldingRangeKind.Comment : undefined)),
    }),

    vscode.languages.registerHoverProvider(selector, {
      provideHover: (doc: Doc, pos: { line: number; character: number }) => {
        const h = hoverAt(analysisOf(doc), pos.line, pos.character);
        return h ? new vscode.Hover(new vscode.MarkdownString(h.markdown), toRange(h.range)) : undefined;
      },
    }),

    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: (doc: Doc, pos: { line: number; character: number }) => {
        const d = definitionAt(analysisOf(doc), pos.line, pos.character);
        // the definition may be in an included file
        return d ? new vscode.Location(d.file ? vscode.Uri.parse(d.file) : doc.uri, new vscode.Position(d.line, d.column)) : undefined;
      },
    }),

    vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks: (doc: Doc) => documentLinks(analysisOf(doc)).map((l) => new vscode.DocumentLink(toRange(l.range), vscode.Uri.parse(l.target))),
    }),

    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems: (doc: Doc, pos: { line: number; character: number }) =>
        completionsAt(analysisOf(doc), pos.line, pos.character).map((c) => {
          const item = new vscode.CompletionItem(c.label, vscode.CompletionItemKind[c.kind]);
          item.detail = c.detail;
          if (c.documentation) item.documentation = new vscode.MarkdownString(c.documentation);
          item.insertText = new vscode.SnippetString(c.insertText);
          return item;
        }),
    }, "!"),
  );

  // files that are only on disk: when one changes, the workspaces including it are re-checked
  if (vscode.workspace.createFileSystemWatcher) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.dsl");
    context.subscriptions.push(
      watcher,
      watcher.onDidChange((u: Doc) => service.fileChanged(u.toString(), false)),
      watcher.onDidCreate((u: Doc) => service.fileChanged(u.toString(), true)),
      watcher.onDidDelete((u: Doc) => service.fileChanged(u.toString(), true)),
    );
  }

  // documents that were already open when the extension activated
  for (const doc of vscode.workspace.textDocuments) refresh(doc);
}

export function deactivate(): void {}
