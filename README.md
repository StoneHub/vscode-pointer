# Pointer

A whiteboard layer over your code in VS Code. Highlight lines, circle a call, box a block, draw an arrow between two lines, cross something out, dim everything else, or pin a note next to the code. Nothing is written to the file: every mark is an editor decoration, and one command clears them all.

Pointer is scriptable. A small CLI drops a JSON "board" into `~/.pointer/board.json`, and the extension draws it in the window whose workspace holds that file. That makes it a good way for an AI coding assistant (or a teammate's script) to point at code during a review instead of listing line numbers. It does not take focus or touch the mouse or keyboard.

## Mark your own selection

Select some code, then right-click and choose **Pointer**, or run these from the Command Palette:

| Command | What it does |
|---|---|
| Pointer: Highlight selection | Tints whole lines |
| Pointer: Circle selection | Hand-drawn ellipse around the selected text |
| Pointer: Box selection | Outline around the selected lines |
| Pointer: Cross out selection | Strikes the text through |
| Pointer: Underline selection | Wavy underline |
| Pointer: Dim everything except selection | Fades the rest of the file |
| Pointer: Add note at selection | Sticky label at the end of the line |
| Pointer: Arrow between two cursors | Place two cursors, get an arrow from the first to the second |
| Pointer: Undo last mark | Removes the most recent mark in this file |
| Pointer: Clear marks in this file / Clear all marks | Wipes the board |

## Script it

```bash
point src/server.js 84,120-125 "first save|second save"   # quick highlight with notes
point board review.json                                    # full board
cat review.json | point board -                            # same, from stdin
point --clear
```

A board is one file plus a list of marks. Line numbers are 1-based, the same as the editor shows.

```json
{
  "file": "src/server.js",
  "fold": "10,40",
  "reveal": "84-120",
  "ops": [
    { "op": "highlight", "lines": "84,120-125", "note": "first|second" },
    { "op": "circle", "line": 84, "text": "save!" },
    { "op": "box", "lines": "92-98", "label": "enrichment path" },
    { "op": "arrow", "from": 84, "to": 120, "label": "two saves" },
    { "op": "strike", "line": 99 },
    { "op": "underline", "line": 102, "text": "identifiers" },
    { "op": "note", "line": 50, "text": "belongs with the others", "color": "green" },
    { "op": "note", "line": 60, "text": "pseudo code:\n1. upsert\n2. associate\n3. persist" },
    { "op": "dim", "except": "82-122" },
    { "op": "svg", "line": 10, "cols": 30, "rows": 4, "svg": "<rect width='{w}' height='{h}' fill='none' stroke='red'/>" }
  ]
}
```

Board fields: `file`, `ops`, `add` (keep the marks already on the file), `fold` / `unfold` (lines whose regions to collapse or expand), `unfoldAll`, `reveal` (scroll there), `clear: "all"`.

Mark fields: `lines` or `line` picks the lines. `text` narrows a mark to the first match on the line, `cols` to a column range. `color` is `red`, `amber`, `green`, `blue`, `purple`, `white` or any hex colour. A multi-line `note` becomes a floating sticky. `svg` draws raw SVG at a line for diagrams; `{w}`, `{h}`, `{lh}` (line height) and `{cw}` (character width) are filled in for you. Arrows run down the indent gutter by default; `"side": "right"` routes them past the end of the lines.

## Install

Not on the Marketplace yet. From a clone:

```bash
./install.sh
```

That packages the extension, installs it into VS Code, and links `point` into `~/.local/bin`. Run **Developer: Restart Extension Host** afterwards.

## Limits

- Marks are tied to line numbers and are not saved; they do not follow edits, and they are gone when the window reloads.
- Overlays are sized from `editor.fontSize` and `editor.lineHeight` and assume a monospace font at roughly Menlo's proportions.
- A multi-line sticky or `svg` mark disappears while its first line is scrolled out of view or folded.

## License

MIT
