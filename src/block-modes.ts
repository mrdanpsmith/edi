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
 * the tree when the document (or a node's decorations) changed, so a node view
 * whose rendering depends on the mode would never be asked again and the block
 * would keep drawing the way it was. A node decoration on the block is what
 * makes the walk happen; the views answer it by asking `modeFor`.
 */
export const BLOCK_MODE_CLASS = 'edi-block-mode'

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
  return DecorationSet.create(state.doc, [
    Decoration.node(mode.pos, mode.pos + node.nodeSize, { class: BLOCK_MODE_CLASS }),
  ])
}

export const blockModePlugin = new Plugin<BlockMode | null>({
  key: BLOCK_MODE_KEY,
  props: {
    decorations: blockModeDecorations,
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
 * Leave the source form, committing the buffer on the way out.
 *
 * In the source form the buffer is the only copy of what was typed, so the
 * commit *is* the exit: `commitSourceMode` writes it to the document and clears
 * the record itself. Any other mode simply has the record dropped.
 */
export function exitSourceMode(view: EditorView): void {
  if (commitSourceMode(view)) return
  if (currentBlockMode(view.state) === null) return
  view.dispatch(view.state.tr.setMeta(BLOCK_MODE_KEY, null))
}

/**
 * Toggle the block at `pos` in and out of the source form, in both directions
 * and from either block: a block already in it goes back to its rendering, and
 * opening a second block commits the first.
 */
export function toggleSourceMode(view: EditorView, pos: number): void {
  const mode = currentBlockMode(view.state)
  if (mode !== null && mode.pos === pos && mode.representation === 'source') {
    exitSourceMode(view)
    return
  }
  enterSourceMode(view, pos)
}