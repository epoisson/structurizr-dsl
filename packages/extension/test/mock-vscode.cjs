"use strict";
// A minimal stand-in for the parts of the VS Code API the adapter uses. It records registrations.
const names = (prefix) => new Proxy({}, { get: (_t, k) => (typeof k === "string" ? k : undefined) });

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b, c, d) {
    if (typeof a === "number") { this.start = new Position(a, b); this.end = new Position(c, d); }
    else { this.start = a; this.end = b; }
  }
}
class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
class DocumentSymbol { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange, children: [] }); } }
class FoldingRange { constructor(start, end, kind) { Object.assign(this, { start, end, kind }); } }
class MarkdownString { constructor(value) { this.value = value; } }
class SnippetString { constructor(value) { this.value = value; } }
class Hover { constructor(contents, range) { Object.assign(this, { contents, range }); } }
class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
class Uri {
  constructor(scheme, path) { this.scheme = scheme; this.path = path; this.fsPath = path; }
  toString() { return `${this.scheme}://${this.path}`; }
  static file(path) { return new Uri("file", path); }
  static parse(text) { const m = /^(\w+):\/\/(.*)$/.exec(text); return new Uri(m ? m[1] : "file", m ? m[2] : text); }
  static joinPath(base, ...parts) {
    const segs = base.path.split("/");
    for (const part of parts.join("/").split("/")) { if (part === "..") segs.pop(); else if (part !== "." && part !== "") segs.push(part); }
    return new Uri(base.scheme, segs.join("/") || "/");
  }
}
class DocumentLink { constructor(range, target) { this.range = range; this.target = target; } }
class CompletionItem { constructor(label, kind) { Object.assign(this, { label, kind }); } }

function create() {
  const listeners = { open: [], change: [], close: [] };
  const diagnostics = new Map();
  const providers = {};
  const collection = {
    set: (uri, list) => diagnostics.set(uri.toString(), list),
    delete: (uri) => diagnostics.delete(uri.toString()),
    dispose() {},
  };
  const reg = (name) => (selector, provider) => ((providers[name] = { selector, provider }), { dispose() {} });
  const textDocuments = [];
  const commands = {};
  const panels = [];
  const infoMessages = [];
  const infoCalls = [];
  const errors = [];
  const warnings = [];
  const quickPickCalls = [];
  const saveCalls = [];
  const openCalls = [];
  const queue = { picks: [], saves: [], opens: [], info: [], warn: [] };
  const files = new Map();
  const config = {};
  const clipboard = [];
  const executed = [];
  const opened = [];
  const failWrites = { on: false };
  const watchers = [];
  const reads = [];
  const shown = [];
  const themeListeners = [];
  const editorListeners = [];
  const win = {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    activeColorTheme: { kind: 1 },
    createWebviewPanel(type, title, column, options) {
      const received = [];
      const panel = {
        type, title, column, options, visible: true, revealed: 0,
        posted: [], disposeHandlers: [], messageHandlers: [],
        webview: {
          html: "", cspSource: "vscode-resource:",
          postMessage(m) { panel.posted.push(m); return Promise.resolve(true); },
          onDidReceiveMessage(fn) { panel.messageHandlers.push(fn); return { dispose() {} }; },
        },
        reveal() { panel.revealed++; },
        onDidDispose(fn) { panel.disposeHandlers.push(fn); return { dispose() {} }; },
        dispose() { panel.disposeHandlers.forEach((f) => f()); },
        send(msg) { panel.messageHandlers.forEach((f) => f(msg)); },
      };
      panels.push(panel);
      return panel;
    },
    showInformationMessage: (m, ...items) => { infoMessages.push(m); infoCalls.push({ message: m, items }); return Promise.resolve(queue.info.shift()); },
    showErrorMessage: (m) => { errors.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m, opts, ...items) => { warnings.push({ message: m, opts, items }); return Promise.resolve(queue.warn.shift()); },
    showQuickPick: (items, opts) => { quickPickCalls.push({ items, opts }); const pick = queue.picks.shift(); return Promise.resolve(pick ? pick(items) : undefined); },
    showSaveDialog: (opts) => { saveCalls.push(opts); return Promise.resolve(queue.saves.shift()); },
    showOpenDialog: (opts) => { openCalls.push(opts); return Promise.resolve(queue.opens.shift()); },
    showTextDocument: async (doc, opts) => { shown.push({ doc, opts }); },
    onDidChangeActiveColorTheme: (fn) => (themeListeners.push(fn), { dispose() {} }),
    onDidChangeActiveTextEditor: (fn) => (editorListeners.push(fn), { dispose() {} }),
  };
  const api = {
    DocumentLink, FileType: { File: 1, Directory: 2 },
    Position, Range, Diagnostic, DocumentSymbol, FoldingRange, MarkdownString, SnippetString, Hover, Location, CompletionItem,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    SymbolKind: names(), CompletionItemKind: names(),
    FoldingRangeKind: { Comment: 1, Imports: 2, Region: 3 },
    ViewColumn: { One: 1, Two: 2, Beside: -2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    commands: { registerCommand: (id, fn) => ((commands[id] = fn), { dispose() {} }), executeCommand: (...args) => { executed.push(args); return Promise.resolve(); } },
    window: win,
    languages: {
      createDiagnosticCollection: () => collection,
      registerDocumentSymbolProvider: reg("symbols"),
      registerFoldingRangeProvider: reg("folding"),
      registerHoverProvider: reg("hover"),
      registerDefinitionProvider: reg("definition"),
      registerCompletionItemProvider: reg("completion"),
      registerDocumentLinkProvider: reg("links"),
    },
    Uri,
    env: { clipboard: { writeText: (t) => { clipboard.push(t); return Promise.resolve(); } } },
    workspace: {
      fs: {
        writeFile: (uri, bytes) => { if (failWrites.on) return Promise.reject(new Error("disk full")); files.set(uri.toString(), Buffer.from(bytes).toString("utf8")); return Promise.resolve(); },
        readFile: (uri) => { reads.push(uri.toString()); return files.has(uri.toString()) ? Promise.resolve(new TextEncoder().encode(files.get(uri.toString()))) : Promise.reject(new Error("not found")); },
        readDirectory: (uri) => {
          reads.push(uri.toString() + "/");
          const prefix = uri.toString().replace(/\/+$/, "") + "/";
          const kids = [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"));
          return kids.length ? Promise.resolve(kids.map((k) => [decodeURIComponent(k.slice(prefix.length)), 1])) : Promise.reject(new Error("not a directory"));
        },
        stat: (uri) => (files.has(uri.toString()) ? Promise.resolve({}) : Promise.reject(new Error("not found"))),
      },
      getConfiguration: (section) => ({ get: (key, dflt) => (`${section}.${key}` in config ? config[`${section}.${key}`] : dflt) }),
      createFileSystemWatcher: (glob) => {
        const w = { glob, handlers: { change: [], create: [], delete: [] }, dispose() {},
          onDidChange: (fn) => (w.handlers.change.push(fn), { dispose() {} }),
          onDidCreate: (fn) => (w.handlers.create.push(fn), { dispose() {} }),
          onDidDelete: (fn) => (w.handlers.delete.push(fn), { dispose() {} }) };
        watchers.push(w);
        return w;
      },
      openTextDocument: (arg) => {
        opened.push(arg);
        if (arg && arg.scheme !== undefined) {
          const open = textDocuments.find((d) => d.uri.toString() === arg.toString());
          return Promise.resolve(open ?? { uri: arg, languageId: "structurizr", version: 1, getText: () => files.get(arg.toString()) ?? "" });
        }
        return Promise.resolve({ ...arg, uri: Uri.parse("untitled://Untitled-1") });
      },
      textDocuments,
      onDidOpenTextDocument: (fn) => (listeners.open.push(fn), { dispose() {} }),
      onDidChangeTextDocument: (fn) => (listeners.change.push(fn), { dispose() {} }),
      onDidCloseTextDocument: (fn) => (listeners.close.push(fn), { dispose() {} }),
    },
  };
  const doc = (text, uri = "file:///a.dsl", languageId = "structurizr") => ({
    uri: Uri.parse(uri), languageId, version: 1, text,
    getText() { return this.text; },
  });
  return { api, listeners, diagnostics, providers, doc, commands, panels, infoMessages, infoCalls, errors, warnings, quickPickCalls, saveCalls, openCalls, queue, files, config, clipboard, executed, opened, failWrites, watchers, reads, shown, themeListeners, editorListeners, win, Uri };
}
module.exports = { create };
