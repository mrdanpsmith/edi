# Edi Rewrite: Per-Block Source/Visual Editor

## Goal

Replace the current all-or-nothing dual-mode editor (Milkdown WYSIWYG vs. CodeMirror raw) with a
block-based editor where each block can independently toggle between rendered visual and source
markdown editing. At most one block is in source mode at a time (the focused block). The global
Ctrl+E mode toggle is removed.

**Block definition:** Top-level markdown blocks separated by blank lines — paragraphs, headings,
lists, blockquotes, code blocks, tables, horizontal rules, definition lists, and custom block
types (mermaid, exec, spreadsheet).

**Interaction model:** Hover handle on the left edge of each block + keyboard shortcut
(Ctrl+Shift+E) to toggle the focused block. All blocks default to visual mode on open.

## Architecture Change

**Current:** Milkdown/ProseMirror (full-document WYSIWYG) ⇄ CodeMirror 6 (full-document raw text)

**Target:** Raw ProseMirror (block-level rendering) + per-block mini CodeMirror (source editing)

Markdown remains the source of truth. remark-parse/remark-stringify handle parsing/serialization.
ProseMirror is a thin editing/rendering layer. No Milkdown dependency.

```
                    ┌─────────────────────────────────┐
                    │       Full Document Markdown      │
                    └──────────┬──────────────────┬────┘
                               │                  │
                    remark-parse          remark-stringify
                               │                  │
                    ┌──────────▼──────────┐       │
                    │    ProseMirror Doc   │───────┘
                    │  (block NodeViews)   │
                    └──────────┬──────────┘
                               │
               ┌───────────────┼───────────────┐
               │               │               │
          ┌────▼────┐    ┌────▼────┐    ┌─────▼─────┐
          │ Block 1  │    │ Block 2  │    │  Block N   │
          │ (visual) │    │ (source) │    │  (visual)  │
          └─────────┘    │  mini CM │    └───────────┘
                         └─────────┘
```

## Key Data Structures

### Block Offsets

When parsing the full markdown into a ProseMirror document, we record the source offset of each
top-level block. This enables precise splicing when a block exits source mode.

```ts
interface BlockOffset {
  id: string           // unique block ID (generated on parse)
  start: number        // start offset in markdown source
  end: number          // end offset in markdown source
  nodePos: number      // ProseMirror doc position of the block node
}
```

### Block Edit State

A single global record tracks which block (if any) is in source mode.

```ts
interface BlockEditState {
  blockId: string | null    // null = no block in source mode
  codeMirror: EditorView | null
}
```

## ProseMirror Schema

### Nodes

| Type | Group | Content | Attrs | Notes |
|------|-------|---------|-------|-------|
| `doc` | — | `block+` | — | Root node |
| `paragraph` | `block` | `inline*` | — | Plain paragraph |
| `heading` | `block` | `inline*` | `level: 1-6` | ATX headings |
| `blockquote` | `block` | `block+` | — | `>` prefixed |
| `bullet_list` | `block` | `list_item+` | — | Unordered list |
| `ordered_list` | `block` | `list_item+` | `order: 1` | Ordered list |
| `list_item` | — | `paragraph (block \| bullet_list \| ordered_list)*` | `checked?: boolean` | Task lists via `checked` attr |
| `code_block` | `block` | (text only) | `language: string` | Fenced code blocks |
| `horizontal_rule` | `block` | — | — | Atomic, `---` / `***` / `___` |
| `table` | `block` | `table_row+` | — | GFM tables |
| `table_row` | — | `table_cell+` | — | |
| `table_cell` | — | `inline*` | — | |
| `table_header` | — | `inline*` | — | First row cells |
| `descriptionlist` | `block` | `descriptionterm descriptiondetails+` | — | Custom (remark-deflist) |
| `descriptionterm` | — | `inline*` | — | |
| `descriptiondetails` | — | `block+` | — | |
| `mermaid_block` | `block` | — | `value: string` | Atomic, rendered SVG |
| `exec_block` | `block` | (text) | `shebang: string, value: string` | Interactive code editing |

### Marks

| Type | DOM | Markdown |
|------|-----|----------|
| `strong` | `<strong>` | `**text**` |
| `em` | `<em>` | `*text*` |
| `code` | `<code>` | `` `text` `` |
| `strikethrough` | `<del>` | `~~text~~` |
| `link` | `<a href>` | `[text](url)` |
| `image` | `<img src alt>` | `![alt](url)` |
| `highlight` | `<mark>` | `==text==` |
| `sub` | `<sub>` | `~text~` |
| `sup` | `<sup>` | `^text^` |

## Per-Block Source/Visual Mechanism

### Visual Mode (default)

Each block is a standard ProseMirror NodeView. The ProseMirror document is the editing surface.
Keyboard navigation (arrow keys, Enter, Backspace) works naturally across blocks.

### Source Mode (one block at a time)

1. User triggers toggle (handle click or Ctrl+Shift+E) on a block
2. Any previously-open source block returns to visual first
3. The block's ProseMirror NodeView switches to render a mini CodeMirror instance
4. CodeMirror is populated with the block's markdown (extracted from source via `BlockOffset`)
5. CodeMirror gets focus; ProseMirror keyboard events are suppressed for this block
6. User edits markdown in CodeMirror
7. On blur or Escape or Ctrl+Shift+E again:
   - CodeMirror content is read
   - The block's range in the full markdown source is spliced with the new content
   - Full document markdown is re-parsed into a new ProseMirror doc
   - ProseMirror view is replaced with the new doc
   - Focus returns to the block (now in visual mode)

### Block Handle

A pseudo-element or absolutely-positioned element on the left edge of each block:
- Appears on block hover
- Shows a grip/drag icon + toggle icon (eye/source toggle)
- Click toggles source mode for that block
- When block is in source mode, handle shows a "rendered" icon

## Interaction Details

| Action | Effect |
|--------|--------|
| Hover over block | Block handle appears on left edge |
| Click handle (visual block) | Block enters source mode (mini CodeMirror) |
| Click handle (source block) | Block returns to visual mode |
| Ctrl+Shift+E on focused block | Toggles source/visual for that block |
| Escape in source mode | Block returns to visual mode |
| Arrow Up at top of source block | Exit source mode, move to previous block |
| Arrow Down at bottom of source block | Exit source mode, move to next block |
| Enter in visual mode | ProseMirror native — creates new block below |
| Tab in source mode | Inserts tab in CodeMirror (standard indent) |
| Click on visual block | Standard ProseMirror focus (stays visual) |

## NPM Dependency Changes

### Add (direct dependencies)
- `prosemirror-model` — Document model (schema, nodes, marks)
- `prosemirror-state` — Editor state, transactions, plugins
- `prosemirror-view` — EditorView, NodeViews, decorations
- `prosemirror-commands` — Standard editing commands
- `prosemirror-keymap` — Keymap binding
- `prosemirror-history` — Undo/redo
- `prosemirror-inputrules` — Typing shortcuts (bold, italic, lists)
- `prosemirror-schema-list` — List node schema helpers
- `prosemirror-tables` — Table editing (cell selection, column add/remove)
- `prosemirror-gapcursor` — Gap cursor for empty blocks
- `prosemirror-dropcursor` — Drop cursor for drag-and-drop
- `prosemirror-changeset` — Change tracking (used by some plugins)
- `remark-parse` — Markdown → MDAST (currently transitive via Milkdown)
- `remark-stringify` — MDAST → markdown (currently transitive via Milkdown)
- `unified` — Pipeline for remark plugins (currently transitive)
- `remark-gfm` — GFM support (currently transitive via Milkdown)

### Remove
- `@milkdown/core`
- `@milkdown/kit`
- `@milkdown/plugin-block`
- `@milkdown/plugin-listener`
- `@milkdown/plugin-tooltip`
- `@milkdown/preset-commonmark`
- `@milkdown/preset-gfm`

### Keep (unchanged)
- `@codemirror/*` — Used for mini source-editing CodeMirror
- `@lezer/highlight` — CodeMirror syntax highlighting
- `mermaid` — Diagram rendering
- `remark-deflist` — Definition list remark plugin
- `unist-util-visit` — AST traversal

## Files to Delete

- `src/milkdown.ts` — Milkdown editor creation, config, lifecycle (replaced by new ProseMirror setup)

## Files to Rewrite

| File | Current Role | New Role |
|------|-------------|----------|
| `src/main.ts` | Dual-mode orchestrator, full-doc sync | Single ProseMirror editor, block-level toggle |
| `src/layout.ts` | Visual/text mode toggle (2 panes) | Removed — single editor pane, no mode concept |
| `src/tabs.ts` | Snapshots markdown + editor state | Snapshots markdown only (no dual-state) |
| `src/formatToolbar.ts` | Dispatches Milkdown commands or text-mode format edits | Dispatches ProseMirror commands on focused block |
| `src/textmode.ts` | Full-page CodeMirror editor | Becomes mini block CodeMirror (source editing) |
| `src/remark/pairedDelimiter.ts` | Milkdown $markSchema/$command/$inputRule + remark plugin | Standalone remark plugin + raw ProseMirror mark schema + prosemirror-commands toggleMark + prosemirror-inputrules markRule |
| `src/remark/highlight.ts` | Calls pairedDelimiterFactory, returns Milkdown components | Returns `{ remarkPlugin, markSchema, command, inputRule }` — raw ProseMirror equivalents |
| `src/remark/sub.ts` | Same pattern | Same rewrite |
| `src/remark/sup.ts` | Same pattern | Same rewrite |
| `src/remark/deflist.ts` | Milkdown $remark + $nodeSchema for dl/dt/dd | Standalone remark plugin + raw ProseMirror node schemas |
| `src/node/mermaid.ts` | $remark/$nodeSchema/$prose NodeView | Standalone remark plugin + raw ProseMirror node schema + ProseMirror Plugin for NodeView |
| `src/node/execblock.ts` | $remark/$nodeSchema/$prose NodeView | Same rewrite pattern |
| `src/node/spreadsheet.ts` | ProseMirror Plugin (DOM-walking formula evaluator) | Same concept, remove Milkdown imports |
| `src/export.ts` | Grabs Milkdown innerHTML or renders via markdown-it | Grabs ProseMirror DOM innerHTML or renders markdown via remark pipeline |
| `src/styles.css` | Dual-pane layout + Milkdown theme + text-pane theme | Single editor pane + block handle + source-mode block styling |

## Files to Adapt (minor changes)

| File | Change |
|------|--------|
| `src/format.ts` | Remove text-mode string formatting (no longer needed) or repurpose for CodeMirror block editing |
| `src/tablecopy.ts` | Update DOM selectors from `.milkdown .editor` to new ProseMirror container |
| `src/spreadsheet.ts` | Remove Milkdown import, adapt to new DOM structure |
| `src/mermaid.ts` | Remove Milkdown import, adapt for standalone use |
| `src/exec.ts` | Remove Milkdown import, adapt for standalone use |
| `src/menus.ts` | Remove visual/text mode toggle command, add block toggle command |
| `src/state.ts` | Remove mode-related state if any |
| `src/bridge.ts` | No changes |
| `src/files.ts` | No changes |
| `index.html` | Remove `#visual-pane` / `#text-pane` split, single `#editor-pane` |

## Migration Phases

### Phase 1: Remark Pipeline + ProseMirror Schema

**Goal:** Parse markdown to ProseMirror doc and back, with all custom remark plugins working.

1. Install new dependencies (prosemirror-*, remark-parse, remark-stringify, unified, remark-gfm)
2. Remove Milkdown dependencies
3. Create `src/markdown.ts` — unified pipeline: markdown → MDAST → ProseMirror doc, and reverse
4. Create `src/schema.ts` — ProseMirror SchemaSpec (all nodes and marks above)
5. Rewrite `src/remark/pairedDelimiter.ts` — extract standalone remark plugin (the `remarkPlugin`
   function is already standalone; remove $markSchema/$command/$inputRule/$remark/$useKeymap wrappers)
   and provide raw ProseMirror mark definitions (parseDOM/toDOM, toggleMark command, markRule input rule)
6. Rewrite `src/remark/highlight.ts`, `sub.ts`, `sup.ts` — adapt to new pairedDelimiter API
7. Rewrite `src/remark/deflist.ts` — standalone remark plugin + raw ProseMirror node schemas
8. Rewrite `src/node/mermaid.ts` — standalone remark plugin + raw ProseMirror node schema
9. Rewrite `src/node/execblock.ts` — standalone remark plugin + raw ProseMirror node schema
10. Delete `src/milkdown.ts`

**Verification:** Unit tests parse markdown → ProseMirror doc → serialize back, checking round-trip
fidelity for all block types including custom remark extensions.

### Phase 2: ProseMirror Editor + Block NodeViews

**Goal:** Render a full ProseMirror editor with block-level NodeViews that support source/visual toggle.

1. Create `src/editor.ts` — ProseMirror EditorView creation with all extensions (history, keymap,
   input rules, gapcursor, dropcursor, tables, line wrapping)
2. Create `src/blockview.ts` — Generic block NodeView factory. Each block type gets a NodeView that:
   - **Visual mode:** Renders the ProseMirror node content normally (inline content is editable,
     atomic nodes like mermaid/exec are rendered via their custom views)
   - **Source mode:** Renders a mini CodeMirror instance (no line numbers, compact, content-sized)
   - Handles the toggle between modes
3. Create `src/blockhandle.ts` — Block hover handle (appears on left edge, click toggles source mode)
4. Create `src/blockplugin.ts` — ProseMirror plugin that:
   - Tracks `BlockOffset[]` (block boundaries in markdown source)
   - Tracks which block (if any) is in source mode
   - Provides `toggleBlockSource(blockId)` command
   - Handles Escape to exit source mode
   - Handles arrow keys at source block boundaries
5. Create `src/codemirror-block.ts` — Mini CodeMirror setup for source editing (compact, no line
   numbers, content-sized, markdown syntax highlighting, Ctrl+Shift+E to toggle back)

**Verification:** Open a markdown document, see blocks rendered visually, hover to see handles,
click handle to toggle a block to source mode, edit, press Escape to return to visual.

### Phase 3: Integration

**Goal:** Wire the new editor into the app, replacing the old dual-mode system.

1. Rewrite `src/main.ts` — Initialize single ProseMirror editor, remove dual-mode sync logic
2. Rewrite `src/layout.ts` — Remove visual/text mode concept, single editor pane
3. Rewrite `src/tabs.ts` — Snapshot markdown only (no dual-state)
4. Rewrite `src/formatToolbar.ts` — Dispatch ProseMirror commands based on focused block
5. Rewrite `src/textmode.ts` — Remove or repurpose (CodeMirror logic moves to `src/codemirror-block.ts`)
6. Update `src/format.ts` — Remove text-mode string formatting (formatting is now ProseMirror commands)
7. Update `index.html` — Single `#editor-pane` replacing `#visual-pane` + `#text-pane`
8. Update `src/menus.ts` — Remove visual/text toggle, add block toggle command
9. Update `src/state.ts` — Remove mode-related state

**Verification:** Full app boots, can open/edit/save files, tabs work, formatting toolbar works,
keyboard shortcuts work.

### Phase 4: Peripheral Features

**Goal:** Adapt export, import, table copy, and other features.

1. Update `src/export.ts` — Grab ProseMirror DOM innerHTML (visual blocks) or render markdown
   via remark pipeline for standalone HTML export
2. Update `src/tablecopy.ts` — New DOM selectors for ProseMirror-rendered tables
3. Update `src/spreadsheet.ts` — Remove Milkdown import, adapt DOM walking to new table structure
4. Update `src/mermaid.ts` — Remove Milkdown import, standalone mermaid rendering
5. Update `src/exec.ts` — Remove Milkdown import, standalone exec block rendering
6. Update `src/import.ts` — Insert markdown tables via ProseMirror transactions
7. Update `src/styles.css` — New block editor theme, handle styling, source block styling,
   remove dual-pane layout, remove `.milkdown`/`.editor` scoping

**Verification:** Export produces correct HTML, table copy works, spreadsheets evaluate formulas,
mermaid diagrams render, exec blocks run, import inserts tables.

### Phase 5: Tests

**Goal:** Rewrite all affected tests.

1. Rewrite `src/remark/remark.test.ts` — Test standalone remark plugins + new ProseMirror schema
2. Rewrite `src/main.test.ts` — Adapt for single-editor init (no dual-mode)
3. Rewrite `src/layout.test.ts` — Remove or repurpose (no mode concept)
4. Rewrite `src/tabs.test.ts` — Snapshot only markdown
5. Rewrite `src/formatToolbar.test.ts` — Test ProseMirror command dispatch
6. Rewrite `src/format.test.ts` — Test ProseMirror formatting (if kept)
7. Add `src/editor.test.ts` — ProseMirror editor init, block rendering, toggle
8. Add `src/blockview.test.ts` — Block NodeView source/visual toggle
9. Update `src/spreadsheet.test.ts`, `src/mermaid.test.ts`, `src/tablecopy.test.ts` — Adapt selectors
10. Keep `src/bridge.test.ts`, `src/files.test.ts`, `src/import.test.ts`, `src/state.test.ts` unchanged
11. Keep `tests/` (backend) unchanged

## Key Risks

1. **Markdown ↔ ProseMirror fidelity** — Mapping between remark's MDAST and ProseMirror's document
   model must be lossless. Edge cases: nested lists, blockquotes with multiple paragraphs, tables
   with alignment, code blocks with language tags. The existing remark plugins already handle
   MDAST correctly; the new risk is in the ProseMirror ↔ MDAST mapping layer.

2. **Block boundary detection** — Determining where one block ends and another begins in both the
   markdown source and the ProseMirror document. ProseMirror's block structure maps cleanly to
   markdown blocks, but blank-line handling around blockquotes and lists needs care.

3. **Source → Visual re-parse fidelity** — When a block exits source mode, the full document is
   re-parsed from markdown. If the user typed markdown that doesn't parse to the same ProseMirror
   structure, the document could change unexpectedly. Mitigation: the re-parse should be transparent
   to the user since they just typed the markdown.

4. **Custom node NodeViews in raw ProseMirror** — The mermaid and exec block NodeViews currently
   rely on Milkdown's context system. Rewriting them as standalone ProseMirror NodeViews is
   straightforward but requires managing DOM lifecycle, update tracking, and event handling manually.

5. **Table editing** — ProseMirror's table editing plugin (`prosemirror-tables`) has its own
   schema requirements (table_header, table_cell must have specific content specs). Aligning our
   markdown table schema with prosemirror-tables' expectations needs care.

6. **Test volume** — ~15 test files need reworking. The remark round-trip tests are the most
   critical to get right; the integration tests are the most labor-intensive.

7. **Performance on large documents** — Re-parsing the full document on every source→visual toggle
   could be slow for very large files. Mitigation: the toggle is explicit user action, so a brief
   re-parse is acceptable. For truly massive documents, we could eventually add incremental parsing.

## Success Criteria

- All blocks render visually by default
- Any block can be toggled to source mode (mini CodeMirror) via handle or Ctrl+Shift+E
- Only one block at a time can be in source mode
- Editing source and returning to visual correctly updates the document markdown
- All custom remark extensions (highlight, sub, sup, deflist, mermaid, exec) work correctly
- Mermaid diagrams, exec blocks, and spreadsheet tables can be toggled to source mode
- Full round-trip: open markdown → edit blocks → save → reopen → same content
- All existing features work: tabs, save/open, export, import, table copy, formatting toolbar
- All tests pass (rewritten for new architecture)
- No Milkdown dependency remains
