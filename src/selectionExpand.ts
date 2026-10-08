/**
 * Cross-block keyboard selection for `Ctrl`/`Cmd` + `Shift` + `Up`/`Down`.
 *
 * The browser's native contenteditable gesture only walks the rendered DOM, so
 * it stalls at block boundaries (a task-list checkbox is a raw `<input>` inside
 * the contenteditable) and cannot enter an atomic node view at all (a kanban
 * board or table is `contenteditable=false`). This module computes the same
 * "select to the paragraph edge" move in the document model, so it works across
 * paragraphs, list items and blockquotes.
 *
 * A run of text blocks is one `TextSelection` (native-like), and an atomic
 * block is *bracketed* by that range and highlighted. The range grows one unit
 * at a time — a paragraph, then a table, then a code fence — by ending on the
 * far boundary of each atomic block it adds, so there is no stuck-point and no
 * jump from the paragraph straight to the document end. A `NodeSelection`
 * only arises when the gesture starts from one (e.g. a clicked block), from
 * which point it walks units one at a time.
 *
 * Because a bracketed atom is not part of the plain-text a native selection
 * yields, the copied text is produced by `clipboardText` below (registered as
 * the view's `clipboardTextSerializer`), which renders each atom as its
 * markdown. Without it the highlight covered a board/table/rule that the copied
 * text silently dropped.
 */
import { NodeSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState, Selection } from 'prosemirror-state'
import { keymap } from 'prosemirror-keymap'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import type { Node as ProseNode, Slice } from 'prosemirror-model'
import { CODE_LANGUAGE_ALIASES, shebangLanguage } from './codeLanguages'
import { modeFor } from './block-modes'

type Dir = 1 | -1

type Rung =
  | { kind: 'text'; anchor: number; head: number }
  | { kind: 'node'; pos: number }

export interface ExpandState {
  /** Every selection the gesture has visited; `rungs[0]` is where it began. */
  rungs: Rung[]
  /** Current position in `rungs`. */
  index: number
  /** The direction that grows the ladder. */
  dir: Dir
}

const EMPTY: ExpandState = { rungs: [], index: -1, dir: 1 }

export const SELECTION_EXPAND_KEY = new PluginKey<ExpandState>('EDI_SELECTION_EXPAND')
export const SELECTION_HIGHLIGHT_KEY = new PluginKey('EDI_SELECTION_HIGHLIGHT')

/**
 * True when a `code_block`'s node view owns its own DOM (CodeMirror) rather
 * than exposing a ProseMirror `contentDOM`. A grammar (a language tag or a
 * shebang) selects CodeMirror in `RunnableBlockNodeView`, and the source form
 * does too. A ProseMirror text position cannot be placed inside one of these,
 * and its chrome (language badge, Copy button) would otherwise be swept into a
 * range, so they are treated as atomic selection units — the same as a table
 * or a diagram. Plain fenced blocks (no grammar) keep an editable
 * `<pre><code>`, so those still behave as text.
 *
 * `pos` is the block's own position, because the source form is no longer
 * something a node can say about itself: it lives in the mode record, which
 * names exactly one block, so the question has to be asked against the state.
 */
export function isCodeEditorBlock(state: EditorState, node: ProseNode, pos: number): boolean {
  if (node.type.name !== 'code_block') return false
  if (modeFor(state, pos)?.representation === 'source') return true
  const tag = String(node.attrs.language ?? '').trim().toLowerCase()
  if (tag && tag in CODE_LANGUAGE_ALIASES) return true
  const interpreter = shebangLanguage(node.textContent)
  return !!(interpreter && interpreter in CODE_LANGUAGE_ALIASES)
}

/** A block the gesture selects whole: an atom, or a CodeMirror code block. */
export function isSelectionAtom(state: EditorState, node: ProseNode, pos: number): boolean {
  return node.isBlock && (node.isAtom || isCodeEditorBlock(state, node, pos))
}

/** A text block the gesture can place a selection endpoint inside. */
function isSelectionTextblock(state: EditorState, node: ProseNode, pos: number): boolean {
  return node.isTextblock && !isCodeEditorBlock(state, node, pos)
}

function rungFromSelection(sel: Selection): Rung {
  if (sel instanceof NodeSelection) return { kind: 'node', pos: sel.from }
  return { kind: 'text', anchor: sel.anchor, head: sel.head }
}

function selectionForRung(doc: ProseNode, rung: Rung): Selection {
  if (rung.kind === 'node') {
    if (doc.nodeAt(rung.pos)) return NodeSelection.create(doc, rung.pos)
    const $pos = doc.resolve(Math.min(rung.pos, doc.content.size))
    return TextSelection.near($pos)
  }
  return TextSelection.create(doc, rung.anchor, rung.head)
}

interface TextBlock {
  pos: number
  start: number
  end: number
}

/** The text block that contains `pos`, at any nesting depth. */
function enclosingTextBlock(state: EditorState, pos: number): TextBlock | null {
  const doc = state.doc
  const clamped = Math.min(Math.max(pos, 0), doc.content.size)
  const $pos = doc.resolve(clamped)
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (isSelectionTextblock(state, node, $pos.before(d))) {
      return { pos: $pos.before(d), start: $pos.start(d), end: $pos.end(d) }
    }
    // A CodeMirror code block is an atomic unit: its interior is not a place a
    // text selection can end, so don't resolve one for it.
    if (isCodeEditorBlock(state, node, $pos.before(d))) return null
  }
  return null
}

interface Unit {
  pos: number
  text: boolean
  size: number
}

/** Every text block and atomic block, in document order. */
function collectUnits(state: EditorState): Unit[] {
  const out: Unit[] = []
  state.doc.descendants((node, pos) => {
    if (isSelectionTextblock(state, node, pos)) out.push({ pos, text: true, size: node.content.size + 1 })
    else if (isSelectionAtom(state, node, pos)) out.push({ pos, text: false, size: node.nodeSize })
    return true
  })
  return out
}

/**
 * The unit the gesture moves onto next: from `tb` when the head is inside a
 * text block, or — when the head sits on a block boundary between two blocks —
 * the nearest unit on the `dir` side of `head`.
 */
function adjacentUnit(state: EditorState, tb: TextBlock | null, head: number, dir: Dir): Unit | null {
  const units = collectUnits(state)
  if (tb) {
    const idx = units.findIndex((u) => u.pos === tb.pos)
    if (idx >= 0) return units[idx + dir] ?? null
  }
  if (dir > 0) return units.find((u) => u.pos >= head) ?? null
  let found: Unit | null = null
  for (const unit of units) {
    if (unit.pos + unit.size <= head) found = unit
    else break
  }
  return found
}

function textRung(anchor: number, head: number): Rung {
  return { kind: 'text', anchor, head }
}

function unitRung(unit: Unit): Rung {
  return unit.text
    ? { kind: 'text', anchor: unit.pos + 1, head: unit.pos + unit.size }
    : { kind: 'node', pos: unit.pos }
}

/**
 * The next selection one step in `dir`, or null when the gesture is already at
 * the document edge. See the module comment for the text-range vs whole-block
 * distinction.
 */
export function nextRung(state: EditorState, sel: Selection, dir: Dir): Rung | null {
  const units = collectUnits(state)

  if (sel instanceof NodeSelection) {
    let idx = units.findIndex((u) => u.pos === sel.from)
    if (idx < 0) idx = units.findIndex((u) => sel.from >= u.pos && sel.from < u.pos + u.size)
    if (idx < 0) return null
    const unit = units[idx + dir]
    return unit ? unitRung(unit) : null
  }

  if (!(sel instanceof TextSelection)) return null

  const tb = enclosingTextBlock(state, sel.head)
  // Inside a text block the first press is the browser's move: snap the head to
  // the block edge. Only then does the gesture move a whole unit at a time.
  if (tb) {
    if (dir > 0 && sel.head < tb.end) return textRung(sel.anchor, tb.end)
    if (dir < 0 && sel.head > tb.start) return textRung(sel.anchor, tb.start)
  }

  const unit = adjacentUnit(state, tb, sel.head, dir)
  if (!unit) return null
  // A text block extends the range to its far edge; an atomic block is added on
  // its own, ending the range on its far boundary. Either way each press adds
  // exactly one block, so `paragraph → table → fence` grows one step at a time
  // instead of jumping to the document end.
  const target = dir > 0
    ? unit.pos + unit.size
    : unit.text
      ? unit.pos + 1
      : unit.pos
  return textRung(sel.anchor, target)
}

function step(view: EditorView, dir: Dir): boolean {
  const state = view.state
  const memo = SELECTION_EXPAND_KEY.getState(state) ?? EMPTY
  const current = rungFromSelection(state.selection)
  let rungs = memo.rungs
  let index = memo.index
  let memoDir = memo.dir

  if (rungs.length === 0) {
    const next = nextRung(state, state.selection, dir)
    if (!next) return false
    rungs = [current, next]
    index = 1
    memoDir = dir
  } else if (memoDir === dir) {
    if (index + 1 < rungs.length) {
      index += 1
    } else {
      const next = nextRung(state, selectionForRung(state.doc, rungs[index]!), dir)
      // Already at the edge: swallow the key. Returning false here would let
      // the browser's own Ctrl+Shift+Down run, and *that* collapses the
      // selection — the "grows past the last block then snaps back" bug.
      if (!next) return true
      rungs = [...rungs, next]
      index += 1
    }
  } else if (index > 0) {
    index -= 1
  } else {
    const next = nextRung(state, state.selection, dir)
    if (!next) return true
    rungs = [current, next]
    index = 1
    memoDir = dir
  }

  const tr = state.tr.setSelection(selectionForRung(state.doc, rungs[index]!)).scrollIntoView()
  tr.setMeta(SELECTION_EXPAND_KEY, { rungs, index, dir: memoDir })
  view.dispatch(tr)
  return true
}

function gesture(dir: Dir) {
  return (_state: EditorState, _dispatch: unknown, view?: EditorView): boolean =>
    view ? step(view, dir) : false
}

/**
 * The only keys this module handles. Both `Ctrl` and `Cmd` are bound on every
 * platform: `Mod` alone means Cmd on macOS, so a Mac user pressing Ctrl+Shift
 * would otherwise fall through to the OS and select something else entirely.
 */
export const selectionExpandKeymap = keymap({
  'Mod-Shift-ArrowUp': gesture(-1),
  'Mod-Shift-ArrowDown': gesture(1),
  'Ctrl-Shift-ArrowUp': gesture(-1),
  'Ctrl-Shift-ArrowDown': gesture(1),
  'Meta-Shift-ArrowUp': gesture(-1),
  'Meta-Shift-ArrowDown': gesture(1),
})

/** Does the range pass through a block the gesture treats as special? */
function selectionHasAtom(state: EditorState): boolean {
  let found = false
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
    if (isSelectionAtom(state, node, pos)) {
      found = true
      return false
    }
    return true
  })
  return found
}

function arrowDir(key: string): Dir | 0 {
  if (key === 'ArrowLeft' || key === 'ArrowUp') return -1
  if (key === 'ArrowRight' || key === 'ArrowDown') return 1
  return 0
}

/**
 * The retrace memo. Any edit, mouse interaction, or selection change the
 * gesture did not make clears it, so the next press starts a fresh ladder
 * rather than walking stale rungs.
 */
export const selectionExpandPlugin = new Plugin<ExpandState>({
  key: SELECTION_EXPAND_KEY,
  state: {
    init: () => EMPTY,
    apply(tr, prev) {
      const meta = tr.getMeta(SELECTION_EXPAND_KEY) as ExpandState | undefined
      if (meta !== undefined) return meta
      if (tr.docChanged || tr.selectionSet) return EMPTY
      return prev
    },
  },
  props: {
    handleKeyDown(view, event) {
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
      const dir = arrowDir(event.key)
      if (!dir) return false
      const sel = view.state.selection
      if (sel.empty) return false
      // A plain text selection collapses natively. One that ends on an atomic
      // block — or is a whole-block `NodeSelection` — does not: the browser
      // cannot move the caret across a node view, so it stays stuck. Collapse
      // it ourselves to the leading/trailing side.
      if (!(sel instanceof NodeSelection) && !selectionHasAtom(view.state)) return false
      const tr = view.state.tr
      const target = dir < 0 ? sel.from : sel.to
      const $target = tr.doc.resolve(Math.min(Math.max(target, 0), tr.doc.content.size))
      tr.setSelection(TextSelection.near($target, dir))
      tr.setMeta(SELECTION_EXPAND_KEY, EMPTY)
      view.dispatch(tr)
      view.focus()
      return true
    },
  },
})

/**
 * Mark every **top-level block** the selection covers as a unit, so a selected
 * block looks selected by the same rule whatever it is and however it was
 * selected.
 *
 * **The selection's kind is not consulted, which is the fix.** This used to require
 * a `TextSelection`, so `Ctrl+A` — which ProseMirror makes an `AllSelection` —
 * highlighted nothing at all: open `spreadsheets.md`, press select-all, and not one
 * block looked selected. Every kind of non-empty selection has `from` and `to`, and
 * the question this plugin answers is only "is this block inside them", so the kind
 * was never needed. A whole-block `NodeSelection` is styled separately, via the
 * `.ProseMirror-selectednode` class ProseMirror puts on the node itself.
 *
 * **Only top-level blocks.** A list item or a paragraph inside a blockquote is not
 * a block the reader thinks of as a unit, and outlining every one of them turns
 * select-all into a wall of boxes. The native text highlight still covers the text
 * inside them.
 */
export const selectionHighlightPlugin = new Plugin({
  key: SELECTION_HIGHLIGHT_KEY,
  props: {
    decorations(state) {
      const sel = state.selection
      if (sel.empty) return null
      const decos: Decoration[] = []
      // `doc.children`, not `descendants`: see the note above.
      state.doc.forEach((node, pos) => {
        if (pos >= sel.from && pos + node.nodeSize <= sel.to) {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'edi-block-selected' }))
        }
      })
      return decos.length ? DecorationSet.create(state.doc, decos) : null
    },
  },
})

/**
 * The markdown a leaf/atom node stands for, or `''` when it has no useful text
 * (a secret, a hard break, an unknown atom). Never `null`: `Fragment.textBetween`
 * concatenates whatever `leafText` returns, and a `null` would land in the copy
 * as the literal text `"null"`.
 */
function atomClipboardText(node: ProseNode): string {
  switch (node.type.name) {
    case 'horizontal_rule':
      return '---'
    case 'mermaid_block':
      return `\`\`\`mermaid\n${String(node.attrs.value ?? '')}\n\`\`\``
    case 'table':
      return String(node.attrs.value ?? '')
    case 'source_block':
      return String(node.attrs.markdown ?? '')
    case 'encrypted_block':
      return '[encrypted block]'
    case 'image':
      return `![${String(node.attrs.alt ?? '')}](${String(node.attrs.src ?? '')})`
    default:
      return ''
  }
}

/**
 * Plain text for a copied selection: the slice's text with every atom rendered
 * as the markdown it stands for. `textBetween`'s `leafText` hook is exactly the
 * seam for this, and is what keeps a bracketed board/table/rule in the copied
 * text while it is visibly selected — the native `textBetween` drops atoms.
 */
export function clipboardText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, '\n\n', (node) => atomClipboardText(node))
}

export const clipboardTextPlugin = new Plugin({
  key: new PluginKey('EDI_CLIPBOARD_TEXT'),
  props: {
    clipboardTextSerializer(slice) {
      return clipboardText(slice)
    },
  },
})
