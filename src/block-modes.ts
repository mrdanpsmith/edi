import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import { EditorView as CMEditorView } from '@codemirror/view'
import { markdownToProse } from './markdown'

/**
 * The two axes every block mode is expressed in, and the single record that
 * holds the one block in a non-default state.
 *
 * The axes are orthogonal: a mermaid block is `preview` *and* `editing`, which
 * is why they live on one record rather than in two. At most one block in a
 * document is in a non-default state at a time, and that invariant lives here
 * rather than in three places that each held one position and each invalidated
 * it differently.
 *
 * **The record is the whole of a block's mode; no node carries one.** There is
 * no `_source` or `_edit` attr on any node type, so:
 *
 * - a mode flip is not an edit — not undoable, and it does not mark the user's
 *   document dirty (`dispatchTransaction` only calls `onChange` for a doc
 *   change), where opening a block's source used to be an undoable edit to the
 *   file;
 * - undo can no longer desynchronise plugin state from the document, which it
 *   could: the attr change and the meta landed in one transaction, but history
 *   restores the *document* and replays `apply` without the meta, so undoing an
 *   entry left the block drawing visually while the record still said otherwise;
 * - nothing on disk moves, because the attrs were invisible to the serializer
 *   anyway. (`_plain` remains — see the note on `buildSourceCommitTransaction`.)
 *
 * What it costs is that a mode flip no longer changes the document, so
 * ProseMirror has no reason to re-ask the node views about it; `BLOCK_MODE_CLASS`
 * is how they find out.
 */

export type Representation = 'preview' | 'source'
export type Interaction = 'viewing' | 'editing'

export interface BlockMode {
  /** The one block in a non-default state, as a document position. */
  pos: number
  /**
   * The node type of that block, which is what makes the record recognisable
   * after the document has moved underneath it. Positions alone cannot say
   * whether the block they used to name is still there: deleting a heading hands
   * its position to the paragraph that followed, and that paragraph supports the
   * source form perfectly well.
   */
  type: string
  representation: Representation
  interaction: Interaction
}

export const BLOCK_MODE_KEY = new PluginKey<BlockMode | null>('EDI_BLOCK_MODE')

/**
 * The class the block the record names wears, and the reason a mode flip reaches
 * the node views at all.
 *
 * This is not decoration for its own sake. A mode is no longer an edit, so
 * flipping it leaves the document byte-identical — and ProseMirror only walks
 * the tree when the document changed *or a node's decorations did*
 * (`ViewDesc.matchesNode` compares them by value), so a node view whose rendering
 * depends on the mode would never be asked again and the block would keep drawing
 * the way it was. A node decoration on the block is what makes the walk happen;
 * the views answer it by asking `modeFor`.
 *
 * **It has to say *which* mode.** A decoration that only said "there is a mode"
 * would be byte-identical across two different modes, and a mode flip from one to
 * another while the record stays held would not be a change at all: pressing
 * Source on a diagram that is already in its edit mode left the record on Source
 * and the board still drawn, because nothing asked the node view. So the class
 * carries the axis, which is §7.2's accent rule doing the load-bearing half as
 * well as the legible one.
 */
export const BLOCK_MODE_CLASS = 'edi-block-mode'

/** `…-preview` / `…-source`, plus `…-editing` while the interaction axis is on. */
export const BLOCK_MODE_SOURCE_CLASS = `${BLOCK_MODE_CLASS}-source`
export const BLOCK_MODE_EDITING_CLASS = `${BLOCK_MODE_CLASS}-editing`

/**
 * What a block type supports. This is the declaration a block makes about
 * itself, and the control cluster (§6), the context menu and the Escape ladder
 * are all generated from it rather than from the block's wrapper class names.
 */
export interface BlockModeDescriptor {
  /** Can this block be shown as its raw markdown? True for every top-level block. */
  representation: boolean
  /** Does interacting with its rendered form have a state of its own? */
  interaction: 'none' | 'toggle'
  /** Rendered forms, for a block that can be drawn more than one way. */
  forms?: readonly { id: string; label: string; isDefault: boolean }[]
}

/** The node types whose rendered form carries an interaction state of its own. */
const INTERACTIVE_BLOCKS = new Set(['mermaid_block'])

/**
 * A block that *is* its source: `source_block` has no `markdown` attr and no
 * rendering to go back to, so it is permanently in the source form and never
 * takes part in the record. Everything else can be shown as markdown, which is
 * why this is an exclusion rather than a list — the list would drift.
 */
const SOURCE_ONLY_BLOCKS = new Set(['source_block'])

const TABLE_FORMS: BlockModeDescriptor['forms'] = [
  { id: 'text', label: 'Show as text', isDefault: true },
  { id: 'sheet', label: 'Show as sheet', isDefault: false },
]

export function blockModeFor(node: ProseNode): BlockModeDescriptor {
  if (SOURCE_ONLY_BLOCKS.has(node.type.name)) {
    return { representation: false, interaction: 'none' }
  }
  return {
    representation: true,
    interaction: INTERACTIVE_BLOCKS.has(node.type.name) ? 'toggle' : 'none',
    ...(node.type.name === 'table' ? { forms: TABLE_FORMS } : {}),
  }
}

/** Does `node` still support the mode `mode` describes, and is it still that block? */
function supportsMode(node: ProseNode, mode: BlockMode): boolean {
  if (node.type.name !== mode.type) return false
  const descriptor = blockModeFor(node)
  if (mode.representation === 'source' && !descriptor.representation) return false
  if (mode.interaction === 'editing' && descriptor.interaction === 'none') return false
  return true
}

function blockModeDecorations(state: EditorState): DecorationSet {
  const mode = currentBlockMode(state)
  if (mode === null) return DecorationSet.empty
  const node = state.doc.nodeAt(mode.pos)
  if (node === null || !supportsMode(node, mode)) return DecorationSet.empty
  const classes = [BLOCK_MODE_CLASS, `${BLOCK_MODE_CLASS}-${mode.representation}`]
  if (mode.interaction === 'editing') classes.push(BLOCK_MODE_EDITING_CLASS)
  return DecorationSet.create(state.doc, [
    Decoration.node(mode.pos, mode.pos + node.nodeSize, { class: classes.join(' ') }),
  ])
}

/**
 * What a block type needs the record for, registered by the node view that owns
 * it.
 *
 * `blockModeFor` says a block type *has* an interaction axis; this says how it is
 * entered and left, and what the Alt+click gesture does to it. It is a table
 * rather than an import because the two node views that have one — the diagram
 * and the table — both import this module, and what entering costs is a
 * subsystem concern: finishing a pending label before an interaction mode
 * changes is an ordering rule of `mermaid-edit.ts`, and cycling a table's
 * rendered form is a document edit of `node/table.ts`.
 */
export interface BlockModeHandlers {
  /** Enter the interaction axis, in that subsystem's own order. */
  enter?: (view: EditorView, pos: number) => void
  /** Leave it, the same way — the ladder's third step, and `Done`. */
  exit?: (view: EditorView, pos: number) => void
  /** What Alt+click on this block does (§5.2). */
  toggle?: (view: EditorView, pos: number) => void
}

export const BLOCK_MODE_HANDLERS: Record<string, BlockModeHandlers> = {}

export const blockModePlugin = new Plugin<BlockMode | null>({
  key: BLOCK_MODE_KEY,
  props: {
    decorations: blockModeDecorations,
  },
  view(view: EditorView) {
    const onClick = (event: MouseEvent): void => {
      blockModeGesture(view, event)
    }
    // The editor's *scroll container*: the editor's own box is only as tall as
    // its content, so a document that is one short block leaves the white space
    // under it on the scroller, where a `view.dom` listener sees nothing — and
    // that space is where a click aimed at the page *under* a lone board lands.
    // It is the scroller and not `document` (which the old table handler could
    // afford) so that an Alt+click in a dialog sitting on top of the editor
    // cannot reach through it.
    // `Document` is in the union for a mount into a fragment or a shadow root,
    // which ProseMirror allows and which has no `parentElement`.
    const host = view.dom.parentElement ?? document
    host.addEventListener('click', onClick as EventListener)
    return { destroy: () => host.removeEventListener('click', onClick as EventListener) }
  },
  state: {
    init: (): BlockMode | null => null,
    /**
     * One invalidation policy for every mode, taken from the strictest of the
     * three this replaces.
     *
     * The position is mapped **forwards** (`assoc` 1), and the direction is the
     * point: a block's position is a *block start*, so an insertion landing
     * exactly on it has to push the recorded position along with its own block
     * rather than leave it on the block that was inserted. ProseMirror ignores
     * the association at a replacement boundary anyway (`StepMap._map` pins
     * `side` to -1 when the position is the range's start), so this costs
     * nothing: a block being rewritten in place maps to its own start either
     * way, and the old source-mode policy — a bounds check and nothing else —
     * simply parked the record on whatever shifted into it.
     */
    apply(tr: Transaction, prev: BlockMode | null): BlockMode | null {
      const meta = tr.getMeta(BLOCK_MODE_KEY)
      if (meta !== undefined) return meta
      if (prev === null) return prev
      const pos = tr.mapping.map(prev.pos, 1)
      if (pos >= tr.doc.content.size) return null
      const node = tr.doc.nodeAt(pos)
      if (node === null || !supportsMode(node, prev)) return null
      return pos === prev.pos ? prev : { ...prev, pos }
    },
  },
})

/**
 * Write the record into `tr`. Subsystems whose mode is their own set it here
 * rather than minting a registry of their own (`node/mermaid.ts`), which is the
 * whole of what "one record" means.
 */
export function setBlockMode(tr: Transaction, mode: BlockMode | null): void {
  tr.setMeta(BLOCK_MODE_KEY, mode)
}

/**
 * Record a mode for the block at `pos`, stamping the record with that block's
 * node type so `apply` can still recognise it after the document moves. A block
 * that is not there, or cannot take the mode, releases the record instead.
 */
export function setBlockModeAt(
  tr: Transaction,
  pos: number,
  changes: { representation?: Representation; interaction?: Interaction },
): void {
  const node = tr.doc.nodeAt(pos)
  if (node === null) {
    setBlockMode(tr, null)
    return
  }
  const descriptor = blockModeFor(node)
  const representation = changes.representation ?? 'preview'
  const interaction = changes.interaction ?? 'viewing'
  if ((representation === 'source' && !descriptor.representation)
    || (interaction === 'editing' && descriptor.interaction === 'none')) {
    setBlockMode(tr, null)
    return
  }
  setBlockMode(tr, { pos, type: node.type.name, representation, interaction })
}

export function currentBlockMode(state: EditorState): BlockMode | null {
  return BLOCK_MODE_KEY.getState(state) ?? null
}

/** The mode of the block at `pos`, or null when some *other* block holds the record. */
export function modeFor(state: EditorState, pos: number | undefined): BlockMode | null {
  if (pos === undefined) return null
  const mode = currentBlockMode(state)
  return mode !== null && mode.pos === pos ? mode : null
}

/**
 * The top-level block `target` sits in, as a document position, or -1 when it is
 * not in this editor at all.
 *
 * This is the **one** DOM→position authority (§6.4). It replaced two: a
 * `data-block-pos` snapshot written into every handle when it was built, and a
 * walk that re-derived the position by scanning the document for a wrapper. The
 * snapshot is a number read at build time — stale the moment the document moves
 * under it — so every control now closes over the node view's `getPos()` and
 * asks at press time; this is the same question asked in the other direction,
 * for the two entry points that start from a DOM event (the context menu and the
 * Alt+click gesture) and have no node view to ask.
 *
 * `posAtDOM` is the primitive that answers it, and it needs no layout — which
 * matters, because the alternative (`posAtCoords`) needs a hit test and the real
 * engine is the only place a hit test exists. The containment check is not
 * redundant: an unlocked encrypted block is a *second* editor inside this one,
 * and a position in its document means nothing here.
 */
export function blockPosForElement(view: EditorView, target: EventTarget | null): number {
  if (!(target instanceof Element) || !view.dom.contains(target)) return -1
  let inside: number
  try {
    inside = view.posAtDOM(target, 0)
  } catch {
    return -1
  }
  if (inside < 0) return -1
  const doc = view.state.doc
  const blockEndingAt = (at: number): number => {
    let found = -1
    doc.forEach((node, offset) => {
      if (found < 0 && at === offset + node.nodeSize) found = offset
    })
    return found
  }
  let blockPos = -1
  doc.forEach((node, offset) => {
    if (blockPos >= 0) return
    if (inside >= offset && inside < offset + node.nodeSize) blockPos = offset
  })
  // A block's own DOM can report the position at its *end* boundary rather than
  // inside it, and for an atom — a table, a diagram, a rule — that boundary is
  // also where the next block starts. Left alone, a click in a table would name
  // whatever follows it, which is the same class of bug the old
  // `data-block-pos` snapshot had and this replaced.
  if (blockPos < 0) blockPos = blockEndingAt(inside)
  return blockPos
}

/**
 * A click Chrome already owns: a button, a text field, a link, a CodeMirror
 * editor, a diagram's own layer. Such a click is the control's own business —
 * Alt+click on a zoom button is a zoom, not a request about the block it happens
 * to sit on.
 *
 * The two diagram classes are spelled out rather than imported from
 * `mermaid-edit.ts`, which would put the whole rendering library behind this
 * module; they are the chrome layer's public names, and the kanban builder and
 * the diagram's `stopEvent` match the same ones.
 */
function chromeOwnsClick(event: MouseEvent): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(
      'a[href], button, input, textarea, select, .cm-editor, .block-controls,'
      + ' .mermaid-kanban-chrome, .mermaid-edit-field',
    ) !== null
  )
}

/**
 * The Alt+click gesture (§5.2), for every block type at once.
 *
 * On a block that has something to toggle, it toggles it; anywhere else it
 * finishes whatever is editing. The second half is deliberate and is what the
 * double click this replaces already did for a diagram: the gesture that turns a
 * mode off should not have to land back on the thing that turned it on, and a
 * board is the one block whose Alt+click target may have moved under the
 * pointer since. The click is never swallowed — a word to select, a caret to
 * place and a cell to mark all still happen, which is the whole reason the mode
 * gestures moved off double click in the first place.
 *
 * Nothing is claimed for a block type that registers no `toggle`, which is why
 * Alt+click on a paragraph is inert.
 */
export function blockModeGesture(view: EditorView, event: MouseEvent): boolean {
  if (!event.altKey || event.button !== 0) return false
  if (chromeOwnsClick(event)) return false
  const pos = blockPosForElement(view, event.target)
  if (pos >= 0) {
    const node = view.state.doc.nodeAt(pos)
    const toggle = node === null ? undefined : BLOCK_MODE_HANDLERS[node.type.name]?.toggle
    if (toggle !== undefined) {
      toggle(view, pos)
      return true
    }
  }
  return exitBlockMode(view)
}

/**
 * Put the block at `pos` into a mode.
 *
 * The ordering rule is not here but in the two entries below it, and it is the
 * same one: commit the outgoing source block, *then* build this transaction,
 * *then* dispatch it. Every route in the app goes through one of these, so no
 * route can move the record while an edit is still sitting in a buffer.
 */
export function enterBlockMode(
  view: EditorView,
  pos: number,
  changes: { representation?: Representation; interaction?: Interaction },
): void {
  if (changes.representation === 'source') {
    enterSourceMode(view, pos)
    return
  }
  if (changes.interaction === 'editing') {
    const node = view.state.doc.nodeAt(pos)
    const enter = node === null ? undefined : BLOCK_MODE_HANDLERS[node.type.name]?.enter
    enter?.(view, pos)
  }
}

/**
 * The Escape ladder (§5.3), and `exitBlockMode` in general.
 *
 * One block is in a non-default state at a time, so leaving it is one decision
 * with two rungs: a block in its source form has a buffer whose only copy of what
 * was typed lives in a CodeMirror instance, so committing it *is* the exit; any
 * other mode simply has the record dropped. Returns whether it did anything, so
 * the ladder's last rung can hand Escape on to every other handler — selection,
 * dialogs, a diagram's own.
 *
 * Step one of the ladder is not here and does not need to be: an open field, a
 * cell editor and a menu each take Escape themselves and stop it arriving.
 */
export function exitBlockMode(view: EditorView): boolean {
  const mode = currentBlockMode(view.state)
  if (mode === null) return false
  if (mode.representation === 'source') return commitSourceMode(view)
  if (mode.interaction === 'editing') {
    const exit = BLOCK_MODE_HANDLERS[mode.type]?.exit
    if (exit !== undefined) {
      exit(view, mode.pos)
      return true
    }
  }
  view.dispatch(view.state.tr.setMeta(BLOCK_MODE_KEY, null))
  return true
}

/** Toggle one axis of the block at `pos`, in both directions. */
export function toggleBlockMode(
  view: EditorView,
  pos: number,
  axis: 'representation' | 'interaction',
): void {
  if (axis === 'representation') {
    toggleSourceMode(view, pos)
    return
  }
  const node = view.state.doc.nodeAt(pos)
  if (node === null) return
  BLOCK_MODE_HANDLERS[node.type.name]?.toggle?.(view, pos)
}

/**
 * Set a caret (collapsed text selection) near `pos`, preferring `pos` itself.
 * `replaceWith`/`delete` behind the block attrs remap a caret that sat inside
 * the replaced node onto the node's *end*; when that endpoint does not point
 * into inline content, `TextSelection.map` snaps forward via `Selection.near`
 * and lands on the next selectable node — e.g. a table directly below, which
 * then lights up as a bogus NodeSelection. Restoring an explicit caret keeps
 * mode enter/exit from hijacking the selection of the following block.
 */
export function placeCaretInText(tr: Transaction, pos: number, fromBound: number, toBound: number): void {
  const size = tr.doc.content.size
  const clamp = (p: number): number => Math.min(Math.max(p, 0), size)
  const tryPos = (p: number): boolean => {
    const $p = tr.doc.resolve(clamp(p))
    if ($p.parent.inlineContent) {
      tr.setSelection(TextSelection.create(tr.doc, clamp(p)))
      return true
    }
    return false
  }
  if (tryPos(pos)) return
  for (let p = Math.min(pos - 1, size); p >= Math.max(fromBound, 1); p--) {
    if (tryPos(p)) return
  }
  for (let p = pos + 1; p <= Math.min(toBound, size); p++) {
    if (tryPos(p)) return
  }
}

/**
 * Reparse a block's markdown into the document, as one transaction, so undo
 * takes the whole edit back. A table's form (`_plain`) is not part of its
 * markdown, so re-parsing resets it to the default — carry it onto the reparsed
 * table when the block is still a table, or a table edited in source returns to
 * the view it was opened from.
 */
function buildSourceCommitTransaction(
  view: EditorView,
  pos: number,
  nodeSize: number,
  markdown: string,
): Transaction {
  const tr = view.state.tr
  const original = view.state.doc.nodeAt(pos)
  const newDoc = markdownToProse(markdown, view.state.schema)
  const nodes: ProseNode[] = []
  newDoc.forEach((child) => nodes.push(child))
  if (original?.type.name === 'table') {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      if (node.type.name === 'table' && node.attrs._plain !== original.attrs._plain) {
        nodes[i] = node.type.create(
          { ...node.attrs, _plain: original.attrs._plain },
          node.content,
          node.marks,
        )
      }
    }
  }
  if (nodes.length > 0) {
    tr.replaceWith(pos, pos + nodeSize, nodes)
    const insertedSize = nodes.reduce((sum, n) => sum + n.nodeSize, 0)
    placeCaretInText(tr, pos + insertedSize - 1, pos + 1, pos + insertedSize)
  } else {
    tr.delete(pos, pos + nodeSize)
    placeCaretInText(tr, pos, 0, tr.doc.content.size)
  }
  setBlockMode(tr, null)
  return tr
}

/** Exported for the source node view, which commits on Escape and on its banner. */
export function commitSourceBlock(view: EditorView, pos: number, markdown: string): void {
  const node = view.state.doc.nodeAt(pos)
  if (node === null) return
  view.dispatch(buildSourceCommitTransaction(view, pos, node.nodeSize, markdown))
}

/**
 * Build the transaction that writes the open source block's live CodeMirror
 * buffer to the document and clears the record. Null when there is nothing to
 * commit, which is how the callers know a transaction was not dispatched.
 */
function buildCommitFromBuffer(view: EditorView): Transaction | null {
  const mode = currentBlockMode(view.state)
  if (mode === null || mode.representation !== 'source') return null
  const pos = mode.pos
  if (pos >= view.state.doc.content.size) return null
  const node = view.state.doc.nodeAt(pos)
  if (node === null) return null
  const dom = view.nodeDOM(pos)
  const cmEl = dom instanceof HTMLElement ? dom.querySelector('.cm-editor') : null
  const cmView = cmEl instanceof HTMLElement ? CMEditorView.findFromDOM(cmEl) : undefined
  const value = cmView?.state.doc.toString()
  if (value === undefined) return null
  return buildSourceCommitTransaction(view, pos, node.nodeSize, value)
}

/**
 * Write the block's live buffer to the document, clearing the record.
 *
 * This is the only way out of the source form that keeps what was typed: the
 * buffer is not in the document until it is read here, so any path that moves
 * the record without calling this throws the edit away.
 */
export function commitSourceMode(view: EditorView): boolean {
  const tr = buildCommitFromBuffer(view)
  if (tr === null) return false
  view.dispatch(tr)
  return true
}

/**
 * Commit the open source block, if the record is in the source form, and report
 * where the block that was at `pos` ended up.
 *
 * Every caller that is about to move the record calls this first, and it takes
 * the incoming position for a reason: **the commit is a document edit**, so a
 * block above the one being opened moves, and a caller that kept its old
 * position would set the mode on whatever shifted into it. A commit that
 * reparses to a different shape moves it by an arbitrary amount.
 */
export function releaseSourceBlock(view: EditorView, pos: number): number {
  const outgoing = currentBlockMode(view.state)
  if (outgoing === null || outgoing.representation !== 'source') return pos
  const tr = buildCommitFromBuffer(view)
  if (tr === null) return pos
  view.dispatch(tr)
  // Reparsing the recorded block keeps it where it was; anything else is a
  // position in the rest of the document, mapped forwards like the record's own.
  return pos === outgoing.pos ? pos : tr.mapping.map(pos, 1)
}

function sourceCaret(state: EditorState, tr: Transaction, blockPos: number): number {
  const node = tr.doc.nodeAt(blockPos)
  const end = blockPos + (node?.nodeSize ?? 0)
  const caret = state.selection.from
  return caret > blockPos && caret < end ? caret : blockPos + 1
}

/**
 * Put the block at `pos` into the source form, committing whichever block is in
 * it first.
 *
 * The order is the whole point, and it is the same rule `node/mermaid.ts` pays
 * for with `finishMermaidLabelEditing`: commit, *then* build the mode change's
 * transaction, *then* dispatch it. Committing afterwards would read a buffer
 * the block no longer owns, and building the mode transaction before committing
 * would land it on a document that has already moved — ProseMirror raises
 * `Applying a mismatched transaction`. Every entry point goes through here, so
 * no route can move the record while an edit is still sitting in a buffer.
 */
export function enterSourceMode(view: EditorView, pos: number): void {
  const mode = currentBlockMode(view.state)
  if (mode !== null && mode.pos === pos && mode.representation === 'source') return
  const at = releaseSourceBlock(view, pos)

  const tr = view.state.tr
  setBlockModeAt(tr, at, { representation: 'source' })
  const end = at + (tr.doc.nodeAt(at)?.nodeSize ?? 0)
  placeCaretInText(tr, sourceCaret(view.state, tr, at), at + 1, end)
  view.dispatch(tr)
}

/**
 * Toggle the block at `pos` in and out of the source form, in both directions
 * and from either block: a block already in it goes back to its rendering, and
 * opening a second block commits the first.
 */
export function toggleSourceMode(view: EditorView, pos: number): void {
  const mode = currentBlockMode(view.state)
  if (mode !== null && mode.pos === pos && mode.representation === 'source') {
    exitBlockMode(view)
    return
  }
  enterSourceMode(view, pos)
}

// ── the control cluster ─────────────────────────────────────────────────────

export const BLOCK_CONTROLS_CLASS = 'block-controls'

/** One button in the cluster, as the record and the node view describe it. */
interface ControlButton {
  button: HTMLButtonElement
  /** Repaint from the record — the label is the mode, so it follows it. */
  paint(): void
}

export interface BlockControls {
  dom: HTMLElement
  /** Re-read the record and repaint the mode buttons. */
  refresh(): void
  /**
   * Replace the block's *own* actions (everything after the mode buttons).
   *
   * A node view owns the elements it contributes — a diagram's zoom buttons are
   * rebuilt on every render, because they bind to the drawing that render
   * produced — so they arrive as elements rather than as descriptors.
   */
  setActions(elements: readonly HTMLElement[]): void
  /** Take the cluster down: the block is showing its source, or is going away. */
  remove(): void
}

/**
 * Build a block's one control cluster: its mode buttons, generated from
 * `blockModeFor`, followed by whatever actions the node view contributes.
 *
 * This replaces five places controls used to be built and four of them had a
 * hover rule and a geometry of their own (§6.2). Every top-level block now gets
 * the same row at the same place, so which control a block has is a question
 * about what the block *can do* rather than about which node view drew it.
 *
 * Every button reads its position from `getPos()` **when it is pressed**. That is
 * the single position authority (§6.4): the alternative every one of these had
 * was a `data-block-pos` written into the DOM when the control was built, which
 * is a snapshot of a position the document is free to move.
 *
 * Returns null when there is nothing to put in it — a nested block (§6.7), or a
 * type with no modes at all, which is what keeps `source_block` (permanently in
 * its source form, so with the banner and never a cluster) out of it.
 */
export function attachBlockControls(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
  actions: readonly HTMLElement[] = [],
): BlockControls | null {
  const pos = getPos()
  // A cluster on every list item would clutter exactly the dense structures where
  // it is least useful, so controls stay on top-level blocks — and nested blocks
  // reach Source through `Mod-Shift-e`, the status chip and the context menu,
  // none of which need a control to exist.
  if (pos === undefined || view.state.doc.resolve(pos).parent.type.name !== 'doc') return null

  const descriptor = blockModeFor(node)
  const buttons: ControlButton[] = []
  if (descriptor.representation) buttons.push(representationButton(view, getPos))
  if (descriptor.interaction === 'toggle') buttons.push(interactionButton(view, getPos))
  if (buttons.length === 0 && actions.length === 0) return null

  const dom = document.createElement('div')
  dom.className = BLOCK_CONTROLS_CLASS
  const actionSlot = document.createElement('span')
  actionSlot.className = 'block-control-actions'
  dom.append(...buttons.map((entry) => entry.button), actionSlot)
  // Keep the caret out of the labels: clicking a <button> natively puts the text
  // cursor inside its text, and a press that moved the caret into a diagram's
  // zoom pill would deselect the block the user was working on.
  dom.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  const setActions = (elements: readonly HTMLElement[]): void => {
    actionSlot.replaceChildren(...elements)
  }
  setActions(actions)
  for (const entry of buttons) entry.paint()

  return {
    dom,
    refresh: () => {
      for (const entry of buttons) entry.paint()
    },
    setActions,
    remove: () => dom.remove(),
  }
}

function controlButton(className: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `block-control ${className}`
  return button
}

function representationButton(
  view: EditorView,
  getPos: () => number | undefined,
): ControlButton {
  const button = controlButton('block-control-representation')
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const at = getPos()
    if (at === undefined) return
    // Through the shared toggle, which is what makes this the two-way control the
    // one-way dot grid of §1.5 could not be: opening another block commits this
    // one first, so a press here can never throw away what was typed in it.
    toggleBlockMode(view, at, 'representation')
  })
  return {
    button,
    paint: () => {
      const at = getPos()
      const source = at !== undefined && modeFor(view.state, at)?.representation === 'source'
      button.textContent = source ? 'Preview' : 'Source'
      button.title = source
        ? 'Back to the rendered block (Esc)'
        : 'Show this block as markdown (Ctrl+Shift+E)'
      button.setAttribute('aria-pressed', String(source))
    },
  }
}

function interactionButton(
  view: EditorView,
  getPos: () => number | undefined,
): ControlButton {
  const button = controlButton('block-control-interaction')
  const toggle = (): void => {
    const at = getPos()
    if (at === undefined) return
    toggleBlockMode(view, at, 'interaction')
  }
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    toggle()
  })
  return {
    button,
    paint: () => {
      const at = getPos()
      const editing = at !== undefined && modeFor(view.state, at)?.interaction === 'editing'
      button.textContent = editing ? 'Done' : 'Edit'
      button.title = editing
        ? 'Finish editing the diagram (Esc)'
        : 'Edit the diagram in place (Alt+click)'
      button.classList.toggle('block-control-on', editing)
      button.setAttribute('aria-pressed', String(editing))
    },
  }
}
