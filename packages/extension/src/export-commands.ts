import type { Analysis } from "./language.ts";
import { errorNote, exportAllViews, exportView, exportableViews, formatsInOrder, baseName, suggestedFileName } from "./exporting.ts";
import type { FormatInfo } from "./exporting.ts";

/**
 * The export commands: the quick picks and dialogs around the logic in exporting.ts.
 * `vscode` is passed in (see adapter.ts for why).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VSCode = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;

/** What the commands need to know about the surrounding extension. */
export interface ExportHost {
  analysisOf(doc: Doc): Analysis;
  /** The document to export when none is given: the active Structurizr editor, else the one being previewed. */
  currentDoc(): Doc | undefined;
  /** The view currently shown in the preview, to offer first. */
  currentKey(): string | undefined;
  /** Whether the editor is using a dark theme. */
  isDark(): boolean;
}

export interface ExportCommands {
  exportView(options?: { doc?: Doc; key?: string }): Promise<void>;
  exportAllViews(options?: { doc?: Doc }): Promise<void>;
}

type Action = "save" | "copy" | "open";

export function createExportCommands(vscode: VSCode, host: ExportHost): ExportCommands {
  const config = () => vscode.workspace.getConfiguration("structurizr.export");
  const info = (message: string, ...items: string[]): Promise<string | undefined> => vscode.window.showInformationMessage(message, ...items);
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  const svgDark = (): boolean => {
    const theme = config().get("svgTheme", "light");
    return theme === "dark" || (theme === "editor" && host.isDark());
  };

  async function pickFormat(): Promise<FormatInfo | undefined> {
    const items = formatsInOrder(config().get("defaultFormat", "svg")).map((f) => ({ label: f.label, description: `.${f.extension}`, detail: f.detail, format: f }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Export format", title: "Structurizr: Export" });
    return picked?.format;
  }

  async function pickAction(): Promise<Action | undefined> {
    const preset = config().get("action", "ask");
    if (preset === "save" || preset === "copy" || preset === "open") return preset;
    const items: Array<{ label: string; description: string; action: Action }> = [
      { label: "Save to file…", description: "Choose where to save it", action: "save" },
      { label: "Copy to clipboard", description: "Paste it into a document or a diagram tool", action: "copy" },
      { label: "Open in a new editor", description: "Look at it or edit it before saving", action: "open" },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "What should happen to the export?", title: "Structurizr: Export" });
    return picked?.action;
  }

  const folderOf = (doc: Doc): unknown => vscode.Uri.joinPath(doc.uri, "..");

  async function exportOne(options: { doc?: Doc; key?: string } = {}): Promise<void> {
    const doc = options.doc ?? host.currentDoc();
    if (!doc) {
      void info("Open a Structurizr .dsl file to export its views.");
      return;
    }
    const a = host.analysisOf(doc);
    const views = exportableViews(a);
    if (views.length === 0) {
      void info("This workspace has no views to export. Add one inside a `views { }` block.");
      return;
    }

    // which view
    let key = options.key && views.some((v) => v.key === options.key) ? options.key : undefined;
    if (!key) {
      if (views.length === 1) key = views[0]!.key;
      else {
        const current = host.currentKey();
        const ordered = [...views.filter((v) => v.key === current), ...views.filter((v) => v.key !== current)];
        const picked = await vscode.window.showQuickPick(
          ordered.map((v) => ({ label: v.title, description: v.key === current ? `${v.key} (shown in the preview)` : v.key, detail: v.type, key: v.key })),
          { placeHolder: "Which view do you want to export?", title: "Structurizr: Export View" },
        );
        if (!picked) return;
        key = picked.key as string;
      }
    }

    // which format, and what to do with it
    const format = await pickFormat();
    if (!format) return;
    const result = exportView(a, key, format.id, { dark: svgDark() });
    if (!result.ok) {
      void vscode.window.showErrorMessage(result.message);
      return;
    }
    const action = await pickAction();
    if (!action) return;
    const note = errorNote(a);
    const suffix = note ? ` ${note}` : "";

    if (action === "copy") {
      await vscode.env.clipboard.writeText(result.content);
      void info(`Copied the ${format.label} export of '${key}' to the clipboard.${suffix}`);
    } else if (action === "open") {
      const opened = await vscode.workspace.openTextDocument({ content: result.content, language: format.language });
      await vscode.window.showTextDocument(opened, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      if (note) void info(note);
    } else {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(doc.uri, "..", suggestedFileName(baseName(doc.uri.path), key, format.extension)),
        filters: { [format.label]: [format.extension] },
        saveLabel: "Export",
        title: `Export '${key}' as ${format.label}`,
      });
      if (!target) return;
      try {
        await vscode.workspace.fs.writeFile(target, encode(result.content));
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not write ${target.path ?? target}: ${(e as Error).message}`);
        return;
      }
      const choice = await info(`Exported '${key}' as ${format.label}.${suffix}`, "Open");
      if (choice === "Open") void vscode.commands.executeCommand("vscode.open", target);
    }
  }

  async function exportAll(options: { doc?: Doc } = {}): Promise<void> {
    const doc = options.doc ?? host.currentDoc();
    if (!doc) {
      void info("Open a Structurizr .dsl file to export its views.");
      return;
    }
    const a = host.analysisOf(doc);
    if (exportableViews(a).length === 0) {
      void info("This workspace has no views to export. Add one inside a `views { }` block.");
      return;
    }
    const format = await pickFormat();
    if (!format) return;
    const folders = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Export here",
      title: `Export every view as ${format.label}`,
      defaultUri: folderOf(doc),
    });
    const folder = folders?.[0];
    if (!folder) return;

    const { files, skipped, failed } = exportAllViews(a, format.id, { dark: svgDark() });
    const targets = files.map((f) => ({ file: f, uri: vscode.Uri.joinPath(folder, f.name) }));

    // warn before overwriting
    const existing: string[] = [];
    for (const t of targets) {
      try {
        await vscode.workspace.fs.stat(t.uri);
        existing.push(t.file.name);
      } catch {
        /* does not exist: fine */
      }
    }
    if (existing.length > 0) {
      const shown = existing.slice(0, 5).join(", ") + (existing.length > 5 ? `, and ${existing.length - 5} more` : "");
      const answer = await vscode.window.showWarningMessage(
        `${existing.length} file${existing.length === 1 ? " already exists" : "s already exist"} in that folder and will be overwritten: ${shown}.`,
        { modal: true },
        "Overwrite",
      );
      if (answer !== "Overwrite") return;
    }

    let written = 0;
    const errors: string[] = [];
    for (const t of targets) {
      try {
        await vscode.workspace.fs.writeFile(t.uri, encode(t.file.content));
        written++;
      } catch (e) {
        errors.push(`${t.file.name}: ${(e as Error).message}`);
      }
    }
    if (errors.length > 0) void vscode.window.showErrorMessage(`Could not write ${errors.length} file${errors.length === 1 ? "" : "s"}: ${errors.join("; ")}`);
    const parts = [`Exported ${written} view${written === 1 ? "" : "s"} as ${format.label}.`];
    if (skipped.length > 0) parts.push(`Skipped image view${skipped.length === 1 ? "" : "s"}: ${skipped.join(", ")}.`);
    if (failed.length > 0) parts.push(`Could not export: ${failed.join(", ")}.`);
    const note = errorNote(a);
    if (note) parts.push(note);
    const choice = await info(parts.join(" "), "Reveal in File Explorer");
    if (choice === "Reveal in File Explorer") void vscode.commands.executeCommand("revealFileInOS", folder);
  }

  return { exportView: exportOne, exportAllViews: exportAll };
}
