import { listViews, renderView } from "../../viewer/src/index.ts";
import type { Range } from "../../core/src/index.ts";
import type { Analysis } from "./language.ts";

/**
 * The preview panel, minus VS Code: what to send the webview, where a click should jump to, and the
 * webview's own page. adapter.ts wires these to a real WebviewPanel.
 */

export interface PreviewPayload {
  type: "render";
  views: Array<{ key: string; title: string; type: string }>;
  /** The view being shown. */
  current: string | undefined;
  svg: string | undefined;
  /** Shown instead of a diagram when there is nothing to draw. */
  message: string | undefined;
}

/** Picks the view to show: the requested one, else the default view, else the first. */
export function previewPayload(a: Analysis, requested: string | undefined, dark: boolean): PreviewPayload {
  const ws = a.result.workspace;
  const views = listViews(ws);
  const list = views.map(({ key, title, type }) => ({ key, title, type }));

  if (views.length === 0) {
    const hasErrors = !a.result.ok;
    return {
      type: "render",
      views: list,
      current: undefined,
      svg: undefined,
      message: hasErrors
        ? "No views to show yet. Fix the errors in the Problems panel to see the diagram."
        : "This workspace has no views. Add one inside a `views { }` block, for example `systemLandscape { include * }`.",
    };
  }
  const current = (requested && views.find((v) => v.key === requested)) || views.find((v) => v.isDefault) || views[0]!;
  const rendered = renderView(ws, current.key, { dark, transparent: true });
  return {
    type: "render",
    views: list,
    current: current.key,
    svg: rendered?.svg,
    message: a.result.ok ? undefined : "The file has errors; the diagram shows what could be resolved.",
  };
}

/** The source range of the element or relationship a click landed on. */
export function revealTarget(a: Analysis, click: { id?: string; rel?: string }): Range | undefined {
  const model = a.result.workspace.model;
  if (click.id !== undefined) return model.elements.find((e) => e.id === click.id)?.range;
  if (click.rel !== undefined) return model.relationships.find((r) => r.id === click.rel)?.range;
  return undefined;
}

const STYLE = `
  html, body { height: 100%; margin: 0; padding: 0; }
  body { display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  #bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #8884); flex: 0 0 auto; }
  select, button { background: var(--vscode-dropdown-background, var(--vscode-button-secondaryBackground)); color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-dropdown-border, #8886); padding: 3px 8px; font: inherit; border-radius: 2px; }
  button { cursor: pointer; min-width: 28px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #8883); }
  #note { opacity: 0.8; margin-left: auto; }
  #stage { position: relative; flex: 1 1 auto; overflow: hidden; cursor: grab; user-select: none; }
  #stage.dragging { cursor: grabbing; }
  #message { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; text-align: center; padding: 24px; opacity: 0.85; }
  .node, .edge { cursor: pointer; }
  .node:hover > :first-child, .node:hover > rect { filter: brightness(1.15); }
  .edge:hover polyline { stroke-width: 3; }
`;

/** The page the webview shows. Runs inside the webview: no access to VS Code except postMessage. */
const SCRIPT = `
  const vscode = acquireVsCodeApi();
  const stage = document.getElementById('stage');
  const select = document.getElementById('views');
  const note = document.getElementById('note');
  const message = document.getElementById('message');
  let svg = null, scale = 1, tx = 0, ty = 0, shown = (vscode.getState() || {}).key;

  const apply = () => { if (svg) svg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; };
  const fit = () => {
    if (!svg) return;
    const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
    const r = stage.getBoundingClientRect();
    scale = Math.min((r.width - 16) / w, (r.height - 16) / h, 1.25);
    tx = (r.width - w * scale) / 2; ty = Math.max(8, (r.height - h * scale) / 2);
    apply();
  };
  const zoom = (f, px, py) => {
    const r = stage.getBoundingClientRect();
    px = px === undefined ? r.width / 2 : px; py = py === undefined ? r.height / 2 : py;
    const next = Math.min(8, Math.max(0.1, scale * f)); f = next / scale;
    tx = px - (px - tx) * f; ty = py - (py - ty) * f; scale = next; apply();
  };

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || m.type !== 'render') return;
    select.innerHTML = '';
    for (const v of m.views) { const o = document.createElement('option'); o.value = v.key; o.textContent = v.title + '  (' + v.key + ')'; select.appendChild(o); }
    if (m.current) select.value = m.current;
    select.disabled = m.views.length === 0;
    note.textContent = m.svg ? (m.message || '') : '';
    for (const old of stage.querySelectorAll('svg')) old.remove();
    message.style.display = m.svg ? 'none' : 'flex';
    message.textContent = m.svg ? '' : (m.message || '');
    if (m.svg) {
      stage.insertAdjacentHTML('afterbegin', m.svg);
      svg = stage.querySelector('svg');
      svg.style.position = 'absolute'; svg.style.transformOrigin = '0 0'; svg.style.maxWidth = 'none';
      if (m.current !== shown || !svg) fit(); else apply();
    } else svg = null;
    shown = m.current; vscode.setState({ key: shown });
  });

  select.addEventListener('change', () => vscode.postMessage({ type: 'select', key: select.value }));
  document.getElementById('fit').addEventListener('click', fit);
  document.getElementById('export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
  document.getElementById('in').addEventListener('click', () => zoom(1.25));
  document.getElementById('out').addEventListener('click', () => zoom(0.8));
  stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });

  let drag = null;
  stage.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
    if (drag.moved > 4) { stage.classList.add('dragging'); tx += dx; ty += dy; apply(); }
  });
  window.addEventListener('mouseup', (e) => {
    const wasClick = drag && drag.moved <= 4;
    drag = null; stage.classList.remove('dragging');
    if (!wasClick) return;
    const el = e.target.closest ? e.target.closest('[data-id], [data-rel]') : null;
    if (!el) return;
    if (el.dataset.id !== undefined) vscode.postMessage({ type: 'reveal', id: el.dataset.id });
    else vscode.postMessage({ type: 'reveal', rel: el.dataset.rel });
  });

  vscode.postMessage({ type: 'ready' });
`;

export function previewHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${STYLE}</style>
</head>
<body>
<div id="bar">
  <select id="views" title="View"></select>
  <button id="out" title="Zoom out">&minus;</button>
  <button id="in" title="Zoom in">+</button>
  <button id="fit" title="Fit to window">Fit</button>
  <button id="export" title="Export this view as SVG, PlantUML or Mermaid">Export&hellip;</button>
  <span id="note"></span>
</div>
<div id="stage"><div id="message"></div></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
