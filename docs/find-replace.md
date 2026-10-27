# Find and replace

`src/search.ts` is the ProseMirror plugin and pure matching layer.
`src/searchPanel.ts` is the `#edi-search-bar` UI.

## What is searched

Search runs over the document's raw flat text:

- every text node, including fenced code blocks;
- the `attrs.value` markup of `table` and `mermaid_block` atoms.

Masked fields, images and source blocks contribute no searchable text.

Matches are highlighted on the rendered editor with inline decorations.
Matches that land on an atom use a whole-block `NodeSelection`.

## Replacement

Replace preserves marks.

A table's pipe value refuses a replacement containing `\n`, because a newline
would corrupt the row.

## Focus and navigation

The document focus follows the search:

- typing or toggling a flag jumps the caret and scroll to the first match
  while the panel keeps keyboard focus;
- plain document edits do **not** reset the active match;
- `SearchPanel.refresh()` re-applies only after a document swap;
- Enter and Shift+Enter step through matches;
- spreadsheet and plain-view tables scroll the cell under the match into view
  (`onSearchChange`/`scrollActiveCellIntoView` in `src/node/table.ts`).

Esc closes the bar. `Ctrl+F` opens find, `Ctrl+H` opens find and replace. The
bindings are wired in `src/main.ts` and `src/menus.ts`, and the Edit menu in
`backend/window.py` mirrors them.
