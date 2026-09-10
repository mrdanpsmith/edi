# Spec: Block-start input rules overhaul

**Status:** Agreed, ready to implement
**Scope:** Overhaul the way block elements are inserted by typing in the visual editor. Block-starting symbols — `````/````lang`, `* `, `- `, `1. `, `- [ ]`, `- [x]`, `> ` — convert to their block elements instead of remaining literal text. Also expose headings H1–H6 in the toolbar as a dropdown (the standard in Word/Notion/Obsidian/Typora), replacing the H1/H2/H3 buttons.

---

## 1. Problem / Motivation

Inline expressions (``code``, `**bold**`, `~~strike~~`, `==highlight==`), headings (`# `–`###### `), and `---` auto-convert via `inputRules()` in `src/editor.ts`. But the block-starting syntaxes that produce lists, tasks, blockquotes, and fenced code blocks do **not**: typing `* `, `- `, `1. `, `- [ ]`, `- [x]`, `> `, `````, or ````mermaid` leaves literal text. The only way to begin a fence block today is the `Mod-Shift-E` source round-trip (toggle source mode, `Escape`, and the literal fence text gets re-parsed into a real block).

**Requirements (agreed)**

- Typing a block-starting marker at the start of a block converts it into its block element, closing the gap with inline expressions.
- ````` / ````lang` → code block (mermaid / shebang-`#!` / language).
- `- `/`* ` + content → bullet list. `1. ` → ordered list. `- [ ] `/`- [x] ` → task list. `> ` → blockquote.
- `# `–`###### ` → headings (already works; keep and regression-test).
- Markers are also honored when Enter is pressed after an unterminated marker (````js`, `- `, `1.`…).
- `- ` alone must stay literal text until either content follows or Enter is pressed, so an incrementally-typed `- [ ]`/`- [x]` always wins (Obsidian-style deferral).
- Toolbar exposes headings via a single dropdown listing Paragraph + H1–H6.

---

## 2. Core design — new module `src/blockstart.ts`

`prosemirror-inputrules` v6 no longer ships `bulletListRule`/`orderedListRule`/`blockQuoteRule` (verified: only `InputRule`, `wrappingInputRule`, `textblockTypeInputRule`, `inputRules`, `undoInputRule`, smart-quote rules are exported). We build the block-start rules ourselves using the exported primitives + custom `InputRule`s, and move the existing heading + `---` rules under the same roof for cohesion.

### `blockStartRules(): InputRule[]`

Returned rules are spread into `createInputRules()`'s `inputRules({ rules })` alongside the retained inline mark rules:

| Rule | Regex | Fires on | Produces |  |
| --- | --- | --- | --- | --- |
| Heading 1–6 | `^#{1,6}\s(.*)$` (`m`) | space | heading{level}  |  |
| Horizontal rule | `^---$` | third `-` | horizontal_rule  |  |
| Fence | `/^```(\S+)?\s$/` | space after fence token | see §"Fence builder" |  |
| Task list | `/^-\s[[ xX]](?:\s | $)/` | trailing space | `bullet_list(list_item{checked}, …)` |
| Bullet (deferred) | `/^([-*+])\s[^\s\[]$/u` | **first content char** after `- `/`* `/`+ ` | `bullet_list(list_item(para(marker-remainder)))` |  |
| Ordered list | `wrappingInputRule(/^(\d+)\.\s$/, ordered_list, m => ({ order: +m[1] }))` | space after `n.` | `ordered_list{order}` |  |
| Blockquote | `wrappingInputRule(/^\s*>\s$/, blockquote)` | space after `>` | blockquote wrap |  |

Rule ordering within the array: task before bullet (defense-in-depth — the bullet regex's `[^\s\[]` already excludes `[`), fences wherever (disjoint).

All rules are `undoable` by default (prosemirror-inputrules' `undoInputRule` on Enter), matching existing heading behavior.

### Fence builder

```ts
function fenceNode(state, info): { node, sourcePos?: number } | null
```

- `info === 'mermaid'` → `mermaid_block.create({ value: '', _source: true })` and, after `replaceWith`, set `tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: <pos> })` where `<pos>` is the inserted node's position, computed robustly (`tr.doc.nodeAt(start)` check; fallback `doc.forEach` scan when the replace reshaped the doc).
- `info.startsWith('#!')` → `code_block.create(null, [schema.text(info)])` (the shebang becomes the first content line → RunnableBlock node view shows the Run button immediately).
- else → `code_block.create({ language: info })` (empty textblock; caret lands inside).

### `blockStartKeymap()`

A `keymap({ Enter: … })` converted by matching the **current textblock's full text** (`$from.parent.textBetween(0, $from.parentOffset, '\n')`), guarded by `state.selection.empty && $from.parent.isTextblock && !$from.parent.type.code`:

| Text | Produces |
| --- | --- |
| `/^```(\S+)?$/` | fence (same builder as above) |
| `/^[-*+]\s?$/` | bullet list (empty item) |
| `/^-\s\[[ xX]\]$/` | task item |
| `/^\d+\.\s?$/` | ordered list |
| `/^>\s?$/` | blockquote |

Return `false` otherwise (falls through to `undoInputRule` / `baseKeymap` newline). The keymap instance is inserted in the plugins array **after** `createInputRules()` so it outranks `undoInputRule`/`baseKeymap` for Enter (later plugins take precedence in ProseMirror). After a conversion the caret is inside the new block, so subsequent Enter presses type normally.

---

## 3. Wiring in `src/editor.ts`

- `createInputRules()` returns `inputRules({ rules: [...inlineMarkRules(), ...blockStartRules()] })` (inline mark rules stay here: `strong`, `em`, `code`, `strikethrough`, `highlight`, `sub`, `sup`).
- Plugins array gains `blockStartKeymap()` immediately after `createInputRules()`.

**Test hooks:** `createInputRules`/`blockStartKeymap` stay private; tests exercise the real `createBlockEditor` via `view.someProp('handleTextInput', …)` and `view.someProp('handleKeyDown', …)` (the exact entry points the plugins use, same pattern as `formatting-keymap.test.ts`).

---

## 4. Mermaid fence UX

### `src/codemirror-block.ts`

`createBlockCodeMirror(parent, doc, onExit, initialPos?: number)`: when `initialPos` is provided, dispatch a transaction before focusing so the caret lands there. Existing callers unaffected.

### `src/blockview.ts`

`BlockSourceNodeView`: when the source markdown starts with `````, pass `initialPos = markdown.indexOf('\n') + 1` so the caret lands on the blank content line — the first keystroke can't corrupt the opening fence. Improves handle-toggled source editing too.

So typing ````mermaid` (space) creates the mermaid block already in source mode (the `_source:true` node + `sourceBlockPos` meta), focuses the CodeMirror with ````mermaid ``` `````, and `Escape`/"Visual mode"/`Mod-Shift-E` commits to the rendered preview — the identical flow to clicking a mermaid block's handle today.

---

## 5. Toolbar heading dropdown

Answer to "what is the standard?": a single heading style control listing Paragraph + H1–H6 (Word, Google Docs, Notion, Obsidian, Typora). h1–h6 are already fully covered end-to-end (schema `heading{level}`, editor + export CSS, remark parse, `'#'.repeat(level)` serialize) — only the toolbar exposure is missing.

### `src/formatToolbar.ts`

- Extend `ButtonSpec` with `options?: { label: string; run(view: EditorView): boolean | Promise<boolean> }[]`. `ButtonSpec.run` stays required — a spec with `options` simply must also satisfy the interface (or make both optional; prefer keeping `run` and typing `options` as additive).
- `FormatToolbar.build()`: when `spec.options` is present, render a native `<select class="fmt-btn fmt-heading fmt-select" title=… aria-label=…>` with one `<option>` per entry; `change` handler → `view.focus()`, run `options[selectedIndex].run(view)`, then reset `selectedIndex = 0` (no selection observer exists, so the label would otherwise go stale and lie about the current block type).
- Replace the three H1/H2/H3 specs with one spec: Paragraph → `setBlockType(paragraph)`; H1–H6 → `setBlockType(heading, { level })`.

### `src/styles.css`

`.fmt-select` styled to match `fmt-btn` (same height, `var(--surface)` background, border, radius, hover).

---

## 6. Tests

### New `src/blockstart.test.ts`

Set up like `formatting-keymap.test.ts` (real `createBlockEditor`, `./mermaid` mocked as in `main.test.ts`). Helpers:

- `typeText(view, str)` — iterate chars through `view.someProp('handleTextInput', fn => fn(view, pos, pos, ch))` with `pos = view.state.selection.head` (mirrors real typing; the rules plugin's own entry point).
- `dispatchKeydown(view, 'Enter')` — existing pattern.

Cases:

1. ````` + space → `code_block` language `''`, caret inside; serializes ````` ``` + ``` `` ` (no orphan fence text).
2. ````js` + space → `code_block` language `'js'`; ````python` → `'python'`.
3. ````mermaid` + space → `mermaid_block` with `_source: true`; `getSourceBlockState(state).sourceBlockPos` points at it; Escape commits to a (mocked-render) visual block; markdown round-trips as ````mermaid ```.
4. ````#!sh` + space → runnable `code_block` whose `textContent` starts with `#!sh`.
5. Enter variants of (1)–(4) with no trailing space.
6. Bullet deferral: `- ` (alone) stays literal text; `- h` → `- h` bullet; `* a` → bullet; `+ x` → bullet; `-- x` stays text.
7. Tasks: `- [ ] ` → unchecked item; `- [x] done` typed incrementally → checked item, markdown `- [x] done`; Enter on `- [x]` (no trailing space) → checked item.
8. Ordered: `1. ` → ordered list; `3. hi` → order 3, markdown `3. hi`; `3.14 ` and `1x` stay literal text.
9. Blockquote: `> ` → empty blockquote; `> quoted` → `> quoted`.
10. Heading + `---` regressions.
11. Negatives: fencing/lists after leading text (`abc ` then ````js`) do not convert; `*foo*` emphasis unaffected.

### `src/formatToolbar.test.ts`

- Dropdown renders 7 options (Paragraph, H1–H6); selecting H5 sets the active block to heading level 5 (assert via view doc).
- Existing tests reference buttons by `title` (e.g. 'Bullet list', 'Horizontal rule'); verified none assert on the removed H1/H2/H3 titles — no cascade.

---

## 7. Documentation

- `README.md`: add to the visual-editor section — "Type `````/````lang`, `- [ ]`, `- `, `1. `, or `> ` at the start of a block to begin a code/mermaid/runnable block, task, bullet, numbered, or blockquote element; headings H1–H6 are available from the toolbar's Heading dropdown."
- `SPEC-toolbar-file-actions.md`: extend the rename map with `.fmt-select` and the `ButtonSpec.options` kind (that spec is deferred).

---

## 8. Acceptance criteria

1. `npm run check` (typecheck + eslint + all Vitest suites) and `npm run build` pass. No backend changes → `pytest` unaffected.
2. Typing ````` ``` `````, ````js`, ````mermaid`, ````#!sh` (space or Enter) begins the corresponding block; ````mermaid` opens the source editor and Escape renders.
3. Typing `- ` then content, `* ` then content, `1. `, `- [ ] `, `- [x] `, and `> ` converts to the right element; `- ` and `- [` alone stay literal until content or Enter.
4. Round-trips: serialized markdown for created lists/tasks/quotes/fences matches what remark re-parses to the same structure.
5. Toolbar shows Paragraph + H1–H6 in a Heading dropdown; choosing H4–H6 applies a level-4–6 heading.

**Known tradeoffs / follow-ups**

- Tilde (`~~~`) and 4+-backtick fences stay literal text (remark still parses them from source mode).
- Empty-heading + Enter doesn't exit to a paragraph (pre-existing `splitBlock` behavior) — polish follow-up.
- The heading dropdown label resets to "Paragraph" after each pick; live syncing to the caret's block type needs a selection observer — follow-up.
- `- ` alone shows literal text until content or Enter (deliberate deferral protecting `- [ ]`).
- The deferred bullet converts one keypress late (after the first content character) — the standard resolution for list-marker ambiguity.
