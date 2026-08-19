# Edi Rewrite: Typora-style Visual/Text Editor with Milkdown

## Goal

Replace Edi's split-pane (CodeMirror + markdown-it preview) architecture with a
single-pane WYSIWYG markdown editor inspired by Typora. Two modes:

- **Visual mode** — Milkdown/ProseMirror renders markdown inline. Click to edit
  any block in place. Task checkboxes, tables, and links are interactive.
- **Text mode** — Raw markdown in CodeMirror 6 (same as today's editor pane).
- **Toggle** — Ctrl+E or toolbar button switches between modes.
- **Background render** — The ProseMirror state stays in sync while typing in
  text mode so switching to visual is instant.

## Architecture Change

**Current:** CodeMirror 6 (raw markdown) → markdown-it (preview HTML) → QWebChannel (Python shell)

**Target:** Milkdown/ProseMirror (visual WYSIWYG) ⇄ CodeMirror 6 (raw text) → QWebChannel (Python shell)

The Python backend, bridge, file I/O, packaging, and selftest are **unchanged**.
The entire rewrite is in `src/`.

## NPM Dependencies

### Add
- `@milkdown/core` — Editor core (remark-parse + remark-stringify)
- `@milkdown/kit` — Plugin bundle (presets, history, clipboard, tooltip, block,
  listener, indent, cursor, trailing, slash)
- `@milkdown/preset-gfm` — Tables, task lists, strikethrough, footnotes,
  autolinks
- `@milkdown/preset-commonmark` — Headings, bold, italic, code, blockquotes,
  links, images, lists, HR
- `@milkdown/plugin-listener` — onChange callback to get markdown output
- `@milkdown/plugin-tooltip` — Inline formatting toolbar on selection
- `@milkdown/plugin-block` — Block-level operations menu
- `remark-deflist` — Definition list support
- `unist-util-visit` — AST traversal for custom remark plugins

### Remove
- `markdown-it`, `markdown-it-task-lists`, `markdown-it-footnote`,
  `markdown-it-deflist`, `markdown-it-mark`, `markdown-it-sub`,
  `markdown-it-sup`

### Keep
- `@codemirror/*` — Still used for text mode (raw markdown editing)

## Feature Mapping

| Edi Feature | Milkdown Equivalent | Work Needed |
|---|---|---|
| Headings, bold, italic, strikethrough, code, links, images, lists, blockquotes, HR | `@milkdown/preset-commonmark` | None — built in |
| Tables, task lists, footnotes, autolinks | `@milkdown/preset-gfm` | None — built in |
| Definition lists | `remark-deflist` via custom remark plugin | Small custom plugin |
| Highlighted text (`==text==`) | Custom remark + ProseMirror mark | Small custom plugin |
| Subscript/superscript | Custom remark + ProseMirror marks | Small custom plugins |
| Syntax highlighting (editor) | Milkdown's built-in ProseMirror highlighting | Theme CSS |
| Format toolbar | Milkdown `plugin-block` + `plugin-tooltip` or custom | Medium — rewrite button wiring |
| Keyboard shortcuts (bold/italic/strikethrough) | ProseMirror keymap (built into presets) | None |
| Mermaid diagrams | Custom ProseMirror node + remark fence plugin | Large — new file |
| Spreadsheet tables | Custom ProseMirror node + remark plugin | Large — new file |
| Executable code blocks | Custom ProseMirror node (extends code block) | Medium — new file |
| Task checkbox toggle in preview | Built into GFM preset (interactive) | None |
| Table copy to clipboard | Adapt `tablecopy.ts` to work on ProseMirror DOM | Small |
| Multi-tab editing | Rewrite to snapshot Milkdown `EditorState` | Medium — rewrite `tabs.ts` |
| Split pane layout | Replace with single-pane mode toggle | Large — rewrite `layout.ts` |
| Link navigation | Adapt click handler for ProseMirror rendered DOM | Small |
| HTML export | Re-render markdown via remark for export HTML | Medium — rewrite `export.ts` |
| Spreadsheet import (CSV/XLSX/ODS) | Keep Python backend, adapt frontend insert | Small |
| Exec code blocks | Keep Python backend, adapt ProseMirror node view | Small |

## Files to Rewrite, Adapt, or Keep

### DELETE (replaced by Milkdown)
- `src/preview.ts` — markdown-it rendering → Milkdown does this internally
- `src/tasktoggle.ts` — Checkbox sync → GFM preset handles this
- `src/format.ts` — String-based formatting → ProseMirror transactions
- `src/editor.ts` — CodeMirror full editor → Only used in text mode now

### MAJOR REWRITE
- `src/main.ts` — Orchestrator: split-pane → single-pane mode toggle, new editor init
- `src/tabs.ts` — Snapshot `EditorState` instead of CodeMirror state
- `src/layout.ts` — Split pane → visual/text mode toggle (button or Ctrl+E)
- `src/export.ts` — Render markdown via remark instead of reading preview DOM
- `src/styles.css` — Milkdown theme + mode toggle styling

### ADAPT (keep logic, change integration)
- `src/formatToolbar.ts` — Rewire buttons to dispatch ProseMirror commands
- `src/mermaid.ts` — Render into ProseMirror node views instead of preview DOM
- `src/exec.ts` — Render into ProseMirror node views instead of preview DOM
- `src/tablecopy.ts` — Adapt selectors for ProseMirror-rendered tables
- `src/spreadsheet.ts` — Adapt to run on ProseMirror's rendered table DOM
- `src/menus.ts` — Add visual/text mode toggle command
- `src/import.ts` — Keep as-is (pure string manipulation)

### KEEP UNCHANGED
- `src/bridge.ts`
- `src/files.ts`
- `src/state.ts`
- `src/types/`

### NEW FILES
- `src/milkdown.ts` — Milkdown editor creation, config, and lifecycle
- `src/textmode.ts` — CodeMirror text-mode setup and markdown ↔ ProseMirror sync
- `src/remark/deflist.ts` — Definition list remark plugin
- `src/remark/highlight.ts` — Highlighted text remark plugin
- `src/remark/sub.ts` — Subscript remark plugin
- `src/remark/sup.ts` — Superscript remark plugin
- `src/node/mermaid.ts` — ProseMirror node for Mermaid diagrams
- `src/node/spreadsheet.ts` — ProseMirror node for spreadsheet tables
- `src/node/execblock.ts` — ProseMirror node for executable code blocks

## Migration Phases

### Phase 1: Core Milkdown Editor
Replace CodeMirror+markdown-it with Milkdown as the primary editing surface.

1. Install Milkdown packages, remove markdown-it packages
2. Create `src/milkdown.ts` — initialize `@milkdown/core` with commonmark + GFM
   + listener plugin
3. Create `src/textmode.ts` — keep CodeMirror for text mode, wire bidirectional sync
   - Visual→Text: `ctx.get(markdown)` → CodeMirror `setValue()`
   - Text→Visual: CodeMirror `getValue()` → Milkdown `ctx.get(insert)`
4. Rewrite `src/main.ts` — single editor container, mode toggle, new init flow
5. Rewrite `src/layout.ts` — remove split pane, add visual/text toggle (Ctrl+E)
6. Rewrite `src/tabs.ts` — snapshot both Milkdown and CodeMirror state per tab
7. Delete `src/preview.ts`, `src/tasktoggle.ts`, `src/format.ts`, `src/editor.ts`

### Phase 2: Formatting Toolbar
1. Rewrite `src/formatToolbar.ts` — use ProseMirror commands (`toggleStrong`,
   `toggleEmphasis`, etc.) from `@milkdown/prose/commands`
2. Adapt keyboard shortcuts — presets include standard keymaps; add Ctrl+Shift+X
   for strikethrough

### Phase 3: Custom Markdown Extensions
1. Write `src/remark/deflist.ts` — remark plugin for `: ` definition list syntax
2. Write `src/remark/highlight.ts` — remark plugin for `==text==` → highlight mark
3. Write `src/remark/sub.ts` — remark plugin for `~text~` → subscript mark
4. Write `src/remark/sup.ts` — remark plugin for `^text^` → superscript mark
5. Register all custom remark plugins in the Milkdown editor config

### Phase 4: Custom ProseMirror Nodes
1. Write `src/node/mermaid.ts` — node spec (schema, parseDOM, toDOM) + nodeView
   that lazy-loads mermaid
2. Write `src/node/spreadsheet.ts` — node spec + nodeView for formula-enabled tables
3. Write `src/node/execblock.ts` — node spec + nodeView for shebang code blocks
   with "Run" button
4. Adapt `src/mermaid.ts`, `src/spreadsheet.ts`, `src/exec.ts` to work as
   ProseMirror nodeViews

### Phase 5: Peripheral Features
1. Adapt `src/tablecopy.ts` — change selectors for ProseMirror DOM
2. Adapt `src/export.ts` — re-render markdown via remark to produce standalone HTML
3. Adapt `src/menus.ts` — add visual/text toggle command, keep existing commands
4. Adapt `src/import.ts` — insert markdown tables via ProseMirror transactions
5. Update `src/styles.css` — Milkdown theme, mode toggle UI, node view styles

### Phase 6: Tests
1. Rewrite unit tests for formatting (now ProseMirror transactions)
2. Add tests for custom remark plugins (markdown → AST)
3. Add tests for mode switching (visual ↔ text round-trip)
4. Adapt integration tests for new editor init flow
5. Keep backend tests unchanged

## Key Risks

1. **Custom node complexity** — Mermaid and spreadsheet nodeViews are the hardest
   parts. ProseMirror nodeViews require managing DOM lifecycle, decorations, and
   update tracking. The Mermaid node is simpler (read-only rendering), but the
   spreadsheet node needs interactive formula cells.

2. **Markdown round-trip fidelity** — The current markdown-it plugins and the new
   remark plugins must produce identical markdown output for the same input.
   Definition lists, highlights, and sub/sup syntax must serialize back correctly.

3. **Mode-switch latency** — Parsing a large markdown document into ProseMirror
   state takes time. For very large documents, switching from text→visual mode
   might briefly block. Mitigation: the background render keeps the parsed state warm.

4. **Test volume** — 274 tests need reworking. The backend tests (~30) are
   unaffected, but all frontend tests touch CodeMirror or markdown-it APIs.
