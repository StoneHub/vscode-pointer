// vscode://stonehub.pointer/show?file=/abs/path.rb&lines=84,120-125&fold=1-40&unfold=84&note=text
// vscode://stonehub.pointer/clear
const vscode = require('vscode');

const deco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: 'rgba(255, 200, 0, 0.28)',
  borderColor: 'rgba(255, 170, 0, 0.9)',
  borderWidth: '0 0 0 3px',
  borderStyle: 'solid',
  overviewRulerColor: 'rgba(255, 170, 0, 0.9)',
  overviewRulerLane: vscode.OverviewRulerLane.Full,
});
const marked = new Map(); // fsPath -> ranges

function parseRanges(spec) {
  if (!spec) return [];
  return spec.split(',').map((part) => {
    const [a, b] = part.split('-').map((n) => parseInt(n, 10) - 1);
    return [a, Number.isNaN(b) || b === undefined ? a : b];
  }).filter(([a]) => !Number.isNaN(a));
}

function paint(editor) {
  const ranges = marked.get(editor.document.uri.fsPath);
  if (!ranges) return;
  editor.setDecorations(deco, ranges.map(({ range, note }) => ({
    range,
    hoverMessage: note,
    renderOptions: note ? { after: { contentText: `  ← ${note}`, color: 'rgba(255,170,0,0.95)', fontStyle: 'italic' } } : undefined,
  })));
}

async function show(params) {
  const file = params.get('file');
  if (!file) return;
  const lines = parseRanges(params.get('lines'));
  const notes = (params.get('notes') || params.get('note') || '').split('|');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const entries = lines.map(([a, b], i) => ({
    range: new vscode.Range(a, 0, b, doc.lineAt(Math.min(b, doc.lineCount - 1)).text.length),
    note: notes[i] || undefined,
  }));
  if (params.get('add') === '1') entries.unshift(...(marked.get(doc.uri.fsPath) || []));
  marked.set(doc.uri.fsPath, entries);
  paint(editor);

  const toLines = (spec) => parseRanges(spec).flatMap(([a, b]) => [a]);
  const fold = toLines(params.get('fold'));
  const unfold = toLines(params.get('unfold'));
  if (fold.length) await vscode.commands.executeCommand('editor.fold', { levels: 1, selectionLines: fold });
  if (unfold.length) await vscode.commands.executeCommand('editor.unfold', { levels: 1, selectionLines: unfold });
  if (params.get('foldOthers') === '1') {
    editor.selections = entries.map((e) => new vscode.Selection(e.range.start, e.range.start));
    await vscode.commands.executeCommand('editor.foldAllExcept');
  }

  if (entries.length) {
    editor.revealRange(entries[0].range, vscode.TextEditorRevealType.InCenter);
  }
}

function clear() {
  marked.clear();
  for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(deco, []);
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const params = new URLSearchParams(uri.query);
        if (uri.path === '/clear') return clear();
        return show(params).catch((e) => vscode.window.showErrorMessage(`Pointer: ${e.message}`));
      },
    }),
    vscode.commands.registerCommand('pointer.clear', clear),
    vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(paint)),
  );
}

module.exports = { activate, deactivate() {} };
