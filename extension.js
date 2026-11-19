// Pointer: a whiteboard layer over the VS Code editor.
// Boards arrive three ways:
//   1. a JSON file dropped at ~/.pointer/board.json (the `point` CLI writes it)
//   2. vscode://stonehub.pointer/show?file=...&lines=84,120  (legacy link)
//   3. the "Pointer: ..." commands, which mark the current selection
// Nothing here edits a document. Everything is a decoration.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BOARD_DIR = path.join(os.homedir(), '.pointer');
const BOARD_FILE = path.join(BOARD_DIR, 'board.json');

const COLORS = {
  red: '#ff5a52', amber: '#ffb000', green: '#3fcf6e', blue: '#4aa8ff', purple: '#b57bff', white: '#f5f5f5',
};
const color = (name, fallback) => COLORS[name] || name || COLORS[fallback || 'red'];
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const boards = new Map(); // fsPath -> ops[]
const types = new Map(); // css key -> TextEditorDecorationType
let overlayType;

function type(key, options) {
  if (!types.has(key)) types.set(key, vscode.window.createTextEditorDecorationType(options));
  return types.get(key);
}

// ---------- geometry ----------

function metrics() {
  const cfg = vscode.workspace.getConfiguration('editor');
  const fontSize = cfg.get('fontSize') || 12;
  let lh = cfg.get('lineHeight') || 0;
  if (lh === 0) lh = Math.round((process.platform === 'darwin' ? 1.5 : 1.35) * fontSize);
  else if (lh < 8) lh = Math.round(lh * fontSize);
  return { lh, cw: fontSize * 0.602 };
}

function parseRanges(spec) {
  if (spec === undefined || spec === null || spec === '') return [];
  return String(spec).split(',').map((part) => {
    const [a, b] = part.trim().split('-').map((n) => parseInt(n, 10) - 1);
    return [a, b === undefined || Number.isNaN(b) ? a : b];
  }).filter(([a]) => !Number.isNaN(a));
}

const lineText = (doc, i) => (i >= 0 && i < doc.lineCount ? doc.lineAt(i).text : '');
const indentOf = (s) => (s.trim() ? s.length - s.trimStart().length : Infinity);

function maxLen(doc, a, b) {
  let n = 0;
  for (let i = a; i <= Math.min(b, doc.lineCount - 1); i++) n = Math.max(n, lineText(doc, i).trimEnd().length);
  return n;
}

// Columns covered by an op on one line: explicit text match, explicit cols, or the trimmed line.
function span(doc, line, op) {
  const text = lineText(doc, line);
  if (op.text) {
    const at = text.indexOf(op.text);
    if (at >= 0) return [at, at + op.text.length];
  }
  if (op.cols) {
    const [[a, b]] = parseRanges(op.cols);
    return [a, b + 1];
  }
  const start = text.length - text.trimStart().length;
  return [start, Math.max(text.trimEnd().length, start + 1)];
}

// An SVG floated over the code. Anchored at (line, col); sized in columns and lines.
function overlay(doc, line, col, cols, lines, body, opts = {}) {
  const { lh, cw } = metrics();
  const w = cols * cw;
  const h = lines * lh;
  const pad = opts.pad === undefined ? 4 : opts.pad;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}" preserveAspectRatio="none">${body({ w, h, lh, cw })}</svg>`;
  const anchorCol = Math.min(Math.max(col, 0), lineText(doc, line).length);
  const shift = col - anchorCol; // columns past the end of the anchor line
  const css = [
    'none', 'position: absolute', 'display: inline-block', 'pointer-events: none', 'z-index: 20',
    `width: calc(${cols}ch + ${pad * 2}px)`, `height: ${h + pad * 2}px`,
    `margin-left: calc(${shift}ch - ${pad}px)`, `margin-top: ${-pad}px`,
    `background: url("data:image/svg+xml,${encodeURIComponent(svg)}") no-repeat`, 'background-size: 100% 100%',
  ].join('; ');
  const pos = new vscode.Position(line, anchorCol);
  return { range: new vscode.Range(pos, pos), renderOptions: { before: { contentText: '​', textDecoration: css } } };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stroke = (c, wpx = 2.2) => `fill="none" stroke="${c}" stroke-width="${wpx}" stroke-linecap="round" stroke-linejoin="round"`;

function eachSpan(doc, op, fn) {
  for (const [a, b] of parseRanges(op.lines || op.line)) {
    for (let line = a; line <= b; line++) fn(line, ...span(doc, line, op));
  }
}

// ---------- ops -> decorations ----------

const draw = {
  highlight(doc, op, out) {
    const c = color(op.color, 'amber');
    const t = type(`hl:${c}`, {
      isWholeLine: true,
      backgroundColor: rgba(c, 0.22),
      borderColor: c, borderWidth: '0 0 0 3px', borderStyle: 'solid',
      overviewRulerColor: c, overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    const notes = [].concat(op.notes || (op.note ? String(op.note).split('|') : []));
    parseRanges(op.lines).forEach(([a, b], i) => {
      out.add(t, {
        range: new vscode.Range(a, 0, Math.min(b, doc.lineCount - 1), 0),
        renderOptions: notes[i] ? { after: { contentText: `  ← ${notes[i]}`, color: c, fontStyle: 'italic' } } : undefined,
      });
    });
  },

  note(doc, op, out) {
    const c = color(op.color, 'amber');
    const line = op.line - 1;
    const rows = String(op.text).split('\n');
    if (rows.length === 1) {
      const end = lineText(doc, line).length;
      out.add(type(`note:${c}`, {}), {
        range: new vscode.Range(line, end, line, end),
        renderOptions: { after: {
          contentText: ` ${op.text} `, color: '#1b1b1b', backgroundColor: c, fontWeight: '600',
          margin: '0 0 0 2ch', textDecoration: 'none; border-radius: 3px; padding: 0 2px',
        } },
      });
      return;
    }
    // Sticky note: several rows, floated right of the code.
    const col = op.col !== undefined ? op.col - 1 : maxLen(doc, line, line + rows.length - 1) + 3;
    const cols = Math.max(...rows.map((r) => r.length)) + 3;
    out.add(overlayType, overlay(doc, line, col, cols, rows.length + 0.4, ({ w, h, lh, cw }) =>
      `<rect x="0" y="0" width="${w}" height="${h}" rx="5" fill="${rgba(c, 0.95)}"/>` +
      rows.map((r, i) => `<text x="${cw * 1.2}" y="${lh * (i + 0.9)}" font-family="Menlo, monospace" font-size="${cw / 0.602}" fill="#1b1b1b" xml:space="preserve">${esc(r)}</text>`).join('')));
  },

  circle(doc, op, out) {
    const c = color(op.color);
    eachSpan(doc, op, (line, s, e) => {
      out.add(overlayType, overlay(doc, line, s - 1, e - s + 2, 1, ({ w, h }) =>
        `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2 + 2}" ${stroke(c)}/>` +
        `<ellipse cx="${w / 2 + 1.5}" cy="${h / 2 - 1}" rx="${w / 2 - 1}" ry="${h / 2 + 3}" ${stroke(c, 1.1)} opacity="0.7" transform="rotate(-1.5 ${w / 2} ${h / 2})"/>`, { pad: 6 }));
    });
  },

  // Drawn one line at a time, so it survives scrolling and folded regions.
  box(doc, op, out) {
    const c = color(op.color, 'blue');
    const label = op.label || '';
    for (const [a, b] of parseRanges(op.lines)) {
      let left = Infinity;
      for (let i = a; i <= b; i++) left = Math.min(left, indentOf(lineText(doc, i)));
      if (left === Infinity) left = 0;
      const cols = maxLen(doc, a, b) - left + 3;
      for (let i = a; i <= b; i++) {
        const tag = i === a && label;
        out.add(overlayType, overlay(doc, i, left - 1, cols + (tag ? label.length + 3 : 0), 1, ({ h, cw }) => {
          const w = cols * cw;
          const r = 5;
          const top = i === a ? `M 1 ${h} L 1 ${r + 1} Q 1 1, ${r + 1} 1 L ${w - r - 1} 1 Q ${w - 1} 1, ${w - 1} ${r + 1} L ${w - 1} ${h}` : '';
          const mid = i !== a && i !== b ? `M 1 0 L 1 ${h} M ${w - 1} 0 L ${w - 1} ${h}` : '';
          const bot = i === b ? `M 1 ${i === a ? r + 1 : 0} L 1 ${h - r - 1} Q 1 ${h - 1}, ${r + 1} ${h - 1} L ${w - r - 1} ${h - 1} Q ${w - 1} ${h - 1}, ${w - 1} ${h - r - 1} L ${w - 1} ${i === a ? r + 1 : 0}` : '';
          return `<rect x="1" y="0" width="${w - 2}" height="${h}" fill="${rgba(c, 0.06)}"/><path d="${top} ${mid} ${bot}" ${stroke(c, 1.8)}/>` +
            (tag ? `<rect x="${w + 5}" y="1" width="${label.length * cw + 10}" height="${h - 2}" rx="4" fill="${c}"/>` +
              `<text x="${w + 10}" y="${h * 0.7}" font-family="Menlo, monospace" font-size="${cw / 0.602}" font-weight="bold" fill="#1b1b1b">${esc(label)}</text>` : '');
        }, { pad: 0 }));
      }
    }
  },

  strike(doc, op, out) {
    const c = color(op.color);
    const t = type(`strike:${c}`, { textDecoration: `line-through ${c} 2px`, opacity: '0.6' });
    eachSpan(doc, op, (line, s, e) => out.add(t, { range: new vscode.Range(line, s, line, e) }));
  },

  underline(doc, op, out) {
    const c = color(op.color);
    const t = type(`under:${c}`, { textDecoration: `underline wavy ${c} 2px` });
    eachSpan(doc, op, (line, s, e) => out.add(t, { range: new vscode.Range(line, s, line, e) }));
  },

  // Fade every line except the ones listed.
  dim(doc, op, out) {
    const keep = parseRanges(op.except).sort((x, y) => x[0] - y[0]);
    const t = type(`dim:${op.opacity || 0.3}`, { opacity: String(op.opacity || 0.3) });
    const fade = (a, b) => { if (b >= a) out.add(t, { range: new vscode.Range(a, 0, b, lineText(doc, b).length) }); };
    let from = 0;
    for (const [a, b] of keep) { fade(from, a - 1); from = Math.max(from, b + 1); }
    fade(from, doc.lineCount - 1);
  },

  // Arrow routed through the empty space right of the code: out, along a rail, back in.
  // from/to are line numbers or {line, col}. Drawn one line at a time, so folds and scrolling are fine.
  arrow(doc, op, out) {
    const c = color(op.color);
    const end = (p) => (typeof p === 'object' ? { line: p.line - 1, col: p.col ? p.col - 1 : undefined } : { line: p - 1 });
    const f = end(op.from);
    const t = end(op.to);
    const fc = f.col !== undefined ? f.col : lineText(doc, f.line).trimEnd().length + 1;
    const tc = t.col !== undefined ? t.col : lineText(doc, t.line).trimEnd().length + 1;
    const label = op.label || '';
    const text = (x, y, cw) => (label ? `<text x="${x}" y="${y}" font-family="Menlo, monospace" font-size="${cw / 0.602}" font-style="italic" font-weight="bold" fill="${c}">${esc(label)}</text>` : '');
    const headAt = (x, y, dir) => `M ${x - dir * 8} ${y - 5} L ${x} ${y} L ${x - dir * 8} ${y + 5}`;
    if (f.line === t.line) {
      const left = Math.min(fc, tc);
      out.add(overlayType, overlay(doc, f.line, left, Math.abs(tc - fc) + label.length + 3, 1, ({ h, cw }) => {
        const [x1, x2] = [(fc - left) * cw, (tc - left) * cw];
        return `<path d="M ${x1} ${h / 2} L ${x2} ${h / 2} ${headAt(x2, h / 2, Math.sign(x2 - x1) || 1)}" ${stroke(c)}/>${text(Math.max(x1, x2) + cw, h / 2 + 4, cw)}`;
      }, { pad: 0 }));
      return;
    }
    const top = Math.min(f.line, t.line);
    const bottom = Math.max(f.line, t.line);
    const down = t.line > f.line;
    const r = 6;
    let gutter = Infinity;
    for (let i = top; i <= bottom; i++) gutter = Math.min(gutter, indentOf(lineText(doc, i)));
    if (op.side !== 'right' && gutter !== Infinity && gutter >= 2) {
      // Rail in the indent whitespace left of the code: always on screen.
      const railL = gutter - 2;
      const segL = (line, body) => {
        const ind = indentOf(lineText(doc, line));
        const cols = (ind === Infinity ? 2 : ind - railL);
        out.add(overlayType, overlay(doc, line, railL, cols + 1, 1, (m) => body(m, m.cw * 0.5, (cols - 0.4) * m.cw), { pad: 0 }));
      };
      segL(f.line, ({ h }, rx, xe) => `<path d="M ${xe} ${h / 2} L ${rx + r} ${h / 2} Q ${rx} ${h / 2}, ${rx} ${down ? h / 2 + r : h / 2 - r} L ${rx} ${down ? h : 0}" ${stroke(c)}/>`);
      for (let i = top + 1; i < bottom; i++) segL(i, ({ h }, rx) => `<path d="M ${rx} 0 L ${rx} ${h}" ${stroke(c)}/>`);
      segL(t.line, ({ h }, rx, xe) => `<path d="M ${rx} ${down ? 0 : h} L ${rx} ${down ? h / 2 - r : h / 2 + r} Q ${rx} ${h / 2}, ${rx + r} ${h / 2} L ${xe} ${h / 2} ${headAt(xe, h / 2, 1)}" ${stroke(c)}/>`);
      if (label) {
        const endCol = lineText(doc, f.line).length;
        out.add(type(`arrowlabel:${c}`, {}), { range: new vscode.Range(f.line, endCol, f.line, endCol), renderOptions: { after: { contentText: `${down ? '↓' : '↑'} ${label}`, color: c, fontStyle: 'italic', fontWeight: 'bold', margin: '0 0 0 2ch' } } });
      }
      return;
    }
    const rail = op.rail !== undefined ? op.rail - 1 : maxLen(doc, top, bottom) + 4;
    const seg = (line, col, body, extra = 0) => out.add(overlayType, overlay(doc, line, col, rail - col + 2 + extra, 1, (m) => body(m, (rail - col + 1) * m.cw), { pad: 0 }));
    seg(f.line, fc, ({ h, cw }, x) => {
      const y = h / 2;
      return `<path d="M 0 ${y} L ${x - r} ${y} Q ${x} ${y}, ${x} ${down ? y + r : y - r} L ${x} ${down ? h : 0}" ${stroke(c)}/>${text(x + cw, y + 4, cw)}`;
    }, label.length + 2);
    for (let i = top + 1; i < bottom; i++) seg(i, rail, ({ h }, x) => `<path d="M ${x} 0 L ${x} ${h}" ${stroke(c)}/>`);
    seg(t.line, tc, ({ h }, x) => {
      const y = h / 2;
      return `<path d="M ${x} ${down ? 0 : h} L ${x} ${down ? y - r : y + r} Q ${x} ${y}, ${x - r} ${y} L 2 ${y} ${headAt(2, y, -1)}" ${stroke(c)}/>`;
    });
  },

  // Raw SVG for diagrams and pseudo code. The body may use {w} {h} {lh} {cw} (pixels).
  svg(doc, op, out) {
    const line = op.line - 1;
    const rows = op.rows || 4;
    const col = op.col !== undefined ? op.col - 1 : maxLen(doc, line, line + rows - 1) + 3;
    out.add(overlayType, overlay(doc, line, col, op.cols || 30, rows, (m) =>
      String(op.svg).replace(/\{(w|h|lh|cw)\}/g, (_, k) => m[k])));
  },
};

function paint(editor) {
  const ops = boards.get(editor.document.uri.fsPath) || [];
  const byType = new Map();
  const out = { add(t, d) { if (!byType.has(t)) byType.set(t, []); byType.get(t).push(d); } };
  for (const op of ops) {
    try { if (draw[op.op]) draw[op.op](editor.document, op, out); } catch (e) { log('op failed', JSON.stringify(op), e.stack); }
  }
  for (const t of [overlayType, ...types.values()]) editor.setDecorations(t, byType.get(t) || []);
}

const repaintAll = () => vscode.window.visibleTextEditors.forEach(paint);
const clearAll = () => { boards.clear(); repaintAll(); };

function addOps(editor, ops) {
  const key = editor.document.uri.fsPath;
  boards.set(key, (boards.get(key) || []).concat(ops));
  paint(editor);
}

// ---------- applying a board ----------

async function applyBoard(board) {
  if (board.clear === 'all') clearAll();
  if (!board.file) return;
  const uri = vscode.Uri.file(board.file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
  const ops = (board.ops || []).filter((o) => draw[o.op]);
  const kept = board.add ? (boards.get(uri.fsPath) || []) : [];
  if (kept.length + ops.length) boards.set(uri.fsPath, kept.concat(ops));
  else boards.delete(uri.fsPath);

  const lines = (spec) => parseRanges(spec).map(([a]) => a);
  if (board.unfoldAll) await vscode.commands.executeCommand('editor.unfoldAll');
  if (board.fold) await vscode.commands.executeCommand('editor.fold', { levels: 1, selectionLines: lines(board.fold) });
  if (board.unfold) await vscode.commands.executeCommand('editor.unfold', { levels: 1, selectionLines: lines(board.unfold) });
  paint(editor);
  if (board.reveal) {
    const [[a, b]] = parseRanges(board.reveal);
    editor.revealRange(new vscode.Range(a, 0, b, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

// Several windows may be watching. The one whose workspace holds the file takes it;
// a file outside every workspace goes to the focused window.
function mine(board) {
  if (!board.file) return true;
  if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(board.file))) return true;
  return vscode.window.state.focused;
}

let lastId;
function readBoard() {
  let board;
  try { board = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); } catch { return; }
  log('read', board.id, lastId);
  if (board.id === lastId) return;
  lastId = board.id;
  if (!mine(board)) return;
  applyBoard(board).then(() => log('applied', board.id), (e) => { log('failed', e.stack); vscode.window.showErrorMessage(`Pointer: ${e.message}`); });
}
const log = (...a) => { if (process.env.POINTER_DEBUG) fs.appendFileSync(path.join(BOARD_DIR, 'debug.log'), a.join(' ') + '\n'); };

// ---------- marking your own selection ----------

function fromSelections(editor, make) {
  addOps(editor, editor.selections.map((sel) => {
    const a = sel.start.line + 1;
    const b = (sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line) + 1;
    const cols = a === b && !sel.isEmpty ? `${sel.start.character + 1}-${sel.end.character}` : undefined;
    return make({ lines: a === b ? `${a}` : `${a}-${b}`, a, b, cols });
  }));
}

function activate(context) {
  overlayType = vscode.window.createTextEditorDecorationType({});
  fs.mkdirSync(BOARD_DIR, { recursive: true });
  try { lastId = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')).id; } catch { /* no board yet */ }
  let timer;
  const watcher = fs.watch(BOARD_DIR, (_e, name) => {
    if (name !== 'board.json') return;
    clearTimeout(timer);
    timer = setTimeout(readBoard, 60);
  });

  const cmd = (name, fn) => vscode.commands.registerTextEditorCommand(`pointer.${name}`, fn);
  context.subscriptions.push(
    { dispose: () => watcher.close() },
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const q = new URLSearchParams(uri.query);
        if (uri.path === '/clear') return clearAll();
        return applyBoard({
          file: q.get('file'), fold: q.get('fold'), unfold: q.get('unfold'), add: q.get('add') === '1',
          reveal: (q.get('lines') || '').split(',')[0],
          ops: [{ op: 'highlight', lines: q.get('lines'), note: q.get('notes') || q.get('note') }],
        }).catch((e) => vscode.window.showErrorMessage(`Pointer: ${e.message}`));
      },
    }),
    vscode.commands.registerCommand('pointer.clear', clearAll),
    cmd('clearFile', (ed) => { boards.delete(ed.document.uri.fsPath); paint(ed); }),
    cmd('undo', (ed) => { const ops = boards.get(ed.document.uri.fsPath); if (ops) { ops.pop(); paint(ed); } }),
    cmd('highlight', (ed) => fromSelections(ed, (s) => ({ op: 'highlight', lines: s.lines }))),
    cmd('circle', (ed) => fromSelections(ed, (s) => ({ op: 'circle', lines: s.lines, cols: s.cols }))),
    cmd('box', (ed) => fromSelections(ed, (s) => ({ op: 'box', lines: s.lines }))),
    cmd('strike', (ed) => fromSelections(ed, (s) => ({ op: 'strike', lines: s.lines, cols: s.cols }))),
    cmd('underline', (ed) => fromSelections(ed, (s) => ({ op: 'underline', lines: s.lines, cols: s.cols }))),
    cmd('focus', (ed) => {
      const except = ed.selections.map((s) => `${s.start.line + 1}-${s.end.line + 1}`).join(',');
      const key = ed.document.uri.fsPath;
      boards.set(key, (boards.get(key) || []).filter((o) => o.op !== 'dim'));
      addOps(ed, [{ op: 'dim', except }]);
    }),
    cmd('note', async (ed) => {
      const text = await vscode.window.showInputBox({ prompt: 'Note text' });
      if (text) fromSelections(ed, (s) => ({ op: 'note', line: s.a, text }));
    }),
    cmd('arrow', async (ed) => {
      if (ed.selections.length !== 2) {
        vscode.window.showInformationMessage('Pointer: place two cursors (Option+click): the start, then the end.');
        return;
      }
      const [from, to] = ed.selections.map((s) => s.active.line + 1);
      const label = await vscode.window.showInputBox({ prompt: 'Arrow label (optional)' });
      addOps(ed, [{ op: 'arrow', from, to, label }]);
    }),
    vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(paint)),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('editor')) repaintAll(); }),
  );
}

module.exports = { activate, deactivate() {} };
