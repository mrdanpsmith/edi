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
 * The axes are orthogonal: a mermaid block is `visual` *and* `editing`, which
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
 *   anyway.
 *
 * What it costs is that a mode flip no longer changes the document, so
 * ProseMirror has no reason to re-ask the node views about it; `BLOCK_MODE_CLASS`
 * is how they find out.
 */

export type Representation = 'visual' | 'source'
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
  /**
   * Which rendered form the block is drawn in, when it has more than one and is
   * not in its default one — a table as a sheet.
   *
   * This used to be a document attr (`_plain`) on the reasoning that a form is
   * per-block and non-exclusive, so no single record could hold it. That
   * reasoning described the *old* behaviour rather than a constraint, and taking
   * the form onto the record is what makes the app's own rule true: **at most one
   * block in a non-visual state, in the whole document** (§2.1). It also
   * deletes three things the attr needed — a `setNodeMarkup` that dirtied the
   * user's file for what is a view preference, an `addToHistory: false` to keep
   * that edit out of undo, and a hand-written carry of the value across a source
   * round-trip, which the record now does for free by simply still holding it.
   *
   * A block in its **default** form holds no record at all, which is what lets a
   * document have any number of tables: plain text is a table's rendering, not a
   * mode, and only the sheet is one.
   *
   * The value is meaningful only while the block is being viewed, but it is
   * *kept* while it is in its source form, so a table that entered source as a
   * sheet comes back as a sheet.
   */
  form?: string
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

/**
 * `…-visual` / `…-source`, plus `…-editing` while the interaction axis is on,
 * and `…-form` while a block is in a non-default rendered form.
 *
 * Both are what §7.2's accent rule is drawn from, and the difference between them
 * is what makes a mode flip reach the node views.
 *
 * **`…-form` is load-bearing in exactly the way §7.2 describes.** A table drawn
 * as a sheet differs from the same table drawn as text in nothing else the
 * decoration can see — both are `visual` and `viewing` — so without this marker
 * the flip is a byte-identical decoration, `ViewDesc.matchesNode` returns "no
 * change", the tree is not re-walked, and the table keeps drawing as text. That
 * is the whole of `setNodeMarkup`'s old behaviour, which the node view's
 * `update()` caught by diffing an attr; now that the form is plugin state, this
 * class is what catches it.
 */
export const BLOCK_MODE_VISUAL_CLASS = `${BLOCK_MODE_CLASS}-visual`
export const BLOCK_MODE_SOURCE_CLASS = `${BLOCK_MODE_CLASS}-source`
export const BLOCK_MODE_EDITING_CLASS = `${BLOCK_MODE_CLASS}-editing`
export const BLOCK_MODE_FORM_CLASS = `${BLOCK_MODE_CLASS}-form`

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
  { id: 'text', label: 'Text', isDefault: true },
  { id: 'sheet', label: 'Sheet', isDefault: false },
]

/**
 * The form a block is drawn in when nothing has asked for another — its
 * rendering rather than a mode, so it holds no record and any number of blocks
 * may be in it. `forms` is written in cycle order, so this could be `forms[0]`,
 * but the descriptor is a declaration and `isDefault` is what it declares;
 * reading the flag keeps the two from disagreeing if the list is reordered.
 */
function defaultFormOf(descriptor: BlockModeDescriptor): string | undefined {
  return descriptor.forms?.find((entry) => entry.isDefault)?.id
}

/** Is `form` this block's own rendering rather than a mode? */
function isDefaultForm(descriptor: BlockModeDescriptor, form: string): boolean {
  return form === defaultFormOf(descriptor)
}

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
  // A form the block no longer has is as stale as a mode it can no longer take:
  // a table whose forms were narrowed must not keep naming one of them.
  if (mode.form !== undefined && !descriptor.forms?.some((entry) => entry.id === mode.form)) {
    return false
  }
  return true
}

function blockModeDecorations(state: EditorState): DecorationSet {
  const mode = currentBlockMode(state)
  if (mode === null) return DecorationSet.empty
  const node = state.doc.nodeAt(mode.pos)
  if (node === null || !supportsMode(node, mode)) return DecorationSet.empty
  const classes = [
    BLOCK_MODE_CLASS,
    mode.representation === 'source' ? BLOCK_MODE_SOURCE_CLASS : BLOCK_MODE_VISUAL_CLASS,
  ]
  if (mode.interaction === 'editing') classes.push(BLOCK_MODE_EDITING_CLASS)
  if (mode.form !== undefined) classes.push(BLOCK_MODE_FORM_CLASS)
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
  /** Toggle it, from either end — the cluster's Edit/Done button, and the menu. */
  toggle?: (view: EditorView, pos: number) => void
  /**
   * Told that the record now names this form, so the owning subsystem can do what
   * only it can.
   *
   * A notification, **not** an entry point: the record write has already happened
   * and been dispatched by the time this runs, so a handler that wrote the record
   * again would undo the caller's own transition — and one that delegated back
   * would recurse. It exists because a sheet is a *live* editing surface: taking
   * one deselects the table, because a `NodeSelection` on a block means typing
   * replaces the block, and focuses the grid. Neither is the record's business.
   *
   * It is a quarter of what this hook was before the form moved onto the record.
   * The reading half is gone because the record answers that now, and the writing
   * half because the record *is* the write.
   */
  forms?: {
    /** `pos` is now drawn in `form`; do whatever that form's surface needs. */
    entered?: (view: EditorView, pos: number, form: string) => void
  }
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
/**
 * Record a mode for the block at `pos`, stamping the record with that block's
 * node type so `apply` can still recognise it after the document moves. A block
 * that is not there, or cannot take the mode, releases the record instead.
 *
 * `state` is the state `tr` was built from, and it is here for one reason: **a
 * form is sticky.** A caller that says nothing about the form keeps the one the
 * block already has, so entering a table's source form does not quietly turn it
 * back into plain text on the way out. That is the whole of what carrying a form
 * across a source round-trip needs, and it used to need a hand-written carry of
 * an attribute for exactly this reason (§4.3).
 *
 * Every caller has the view it is building `tr` from, so there is no case where
 * the state is unavailable and the form has to be dropped.
 */
export function setBlockModeAt(
  state: EditorState,
  tr: Transaction,
  pos: number,
  changes: { representation?: Representation; interaction?: Interaction; form?: string },
): void {
  const node = tr.doc.nodeAt(pos)
  if (node === null) {
    setBlockMode(tr, null)
    return
  }
  const descriptor = blockModeFor(node)
  const representation = changes.representation ?? 'visual'
  const interaction = changes.interaction ?? 'viewing'
  if ((representation === 'source' && !descriptor.representation)
    || (interaction === 'editing' && descriptor.interaction === 'none')) {
    setBlockMode(tr, null)
    return
  }
  const named = changes.form
  const kept = modeFor(state, pos)?.form
  const form = named === undefined ? kept : formId(descriptor, named)
  setBlockMode(tr, { pos, type: node.type.name, representation, interaction, form })
}

/** The stored form for `form`, or undefined when it is the block's own default. */
function formId(descriptor: BlockModeDescriptor, form: string): string | undefined {
  return isDefaultForm(descriptor, form) ? undefined : form
}

/**
 * Put the block at `pos` into the named rendered form, taking or releasing the
 * one record as that requires.
 *
 * A form in the block's **default** is its rendering rather than a mode, so it
 * releases the record instead of taking it — which is the whole of why a document
 * may hold any number of tables while only one of them may be a sheet.
 *
 * A form is only ever held by a block that is being *viewed*, so asking for a
 * form of a block in its source form is a no-op: the value is still remembered
 * there (the record keeps it), it is simply not drawn.
 *
 * Everything else about a block is dropped, because the record holds one block:
 * a table that was in its source form and is asked for a sheet comes back
 * rendered, as a sheet.
 */
export function setBlockForm(view: EditorView, pos: number, form: string): void {
  const node = view.state.doc.nodeAt(pos)
  if (node === null) return
  const type = node.type.name
  const descriptor = blockModeFor(node)
  const mode = modeFor(view.state, pos)
  const tr = view.state.tr
  if (form === defaultFormOf(descriptor)) {
    // The block's own rendering: the record goes, and it goes *entirely*. A
    // formless record naming a block that is merely being viewed is not a
    // weaker version of the same thing — it is a block in the one slot that
    // nothing else may occupy, which is exactly what the slot is for.
    if (mode === null || mode.form === undefined) return
    if (mode.representation === 'visual' && mode.interaction === 'viewing') {
      setBlockMode(tr, null)
    } else {
      const { form: _released, ...rest } = mode
      setBlockMode(tr, rest)
    }
  } else {
    setBlockModeAt(view.state, tr, pos, { form })
  }
  view.dispatch(tr)
  BLOCK_MODE_HANDLERS[type]?.forms?.entered?.(view, pos, form)
}

/** The form the block at `pos` is drawn in, default included. */
export function blockFormOf(state: EditorState, pos: number | undefined): string | undefined {
  if (pos === undefined) return undefined
  const node = state.doc.nodeAt(pos)
  return node === null ? undefined : defaultFormOf(blockModeFor(node))
}

/** The non-default form the record names for `pos`, if any. */
export function blockFormMode(state: EditorState, pos: number | undefined): string | undefined {
  return pos === undefined ? undefined : modeFor(state, pos)?.form
}

/**
 * The one editor holding the one non-visual block in the whole page.
 *
 * The record is per-`EditorState`, and an unlocked encrypted block is a *whole
 * nested editor* with its own state (`encryptedblock.ts`), so "at most one block
 * in a non-visual state" is a statement about the page and not about a document.
 * Unlocking a block is deliberately not one of the states that counts — it is a
 * reveal, per-block and non-exclusive, and it lives in a closure — but a sheet
 * inside the unlocked block is a table like any other and does count.
 *
 * So the exclusivity needs one thing the plugin cannot hold: a pointer to the
 * editor that has it. Everything else stays in plugin state, and this is only
 * ever *read* to find out whether somebody else has it. It is released the moment
 * that editor drops its record, and a destroyed editor leaves a stale reference
 * that `releaseOtherEditors` skips, so the worst case is one wasted comparison.
 */
let holder: EditorView | null = null

/**
 * Keep the page to **one** block in a non-visual state, from an editor's
 * `dispatchTransaction`.
 *
 * This is the whole cross-editor mechanism, and it is one function called after
 * every transaction rather than a list of the routes that can take a mode: the
 * cycle, the cluster's buttons, the keymap, the context menu and a node view's
 * own `enterDiagramEditMode` are five today and a sixth is a bug.
 *
 * **An editor that does not call this opts out of the rule**, silently — nothing
 * about it is invalid, it simply never claims the slot and so can never be
 * released from it. That is a real caveat and the reason it is stated here rather
 * than left to be discovered: every editor in the app comes from
 * `createBlockEditor`, which calls it, so there is exactly one place to remember.
 */
export function keepOneNonVisualBlock(view: EditorView): void {
  releaseOtherEditors(view)
  claimFor(view, currentBlockMode(view.state))
}

/** Remember `view` as the page's holder, if it is not already, or forget it. */
function claimFor(view: EditorView, mode: BlockMode | null): void {
  if (mode === null) {
    if (holder === view) holder = null
    return
  }
  if (holder !== view) holder = view
}

/**
 * Release the page's holder when it is some *other* editor, so the caller's next
 * transaction can take the record without two blocks being in a mode at once.
 *
 * Called from the one `dispatchTransaction` every editor shares (`editor.ts`),
 * after the transaction has been applied, rather than from each route that takes
 * a mode. That placement is the point: a mode can be taken by the cycle, by the
 * cluster's buttons, by the keymap, by the context menu, or by a node view's own
 * `enterDiagramEditMode`, and a list of them is a list that will grow a gap.
 *
 * The release goes through `exitBlockMode`, so a block being dropped out of its
 * source form has its buffer committed rather than discarded — the same rule §3
 * puts on every other route out.
 *
 * Whichever editor takes a mode last wins, which is what makes the gesture feel
 * like a decision rather than a refusal: the one you just did is the one that
 * counts, and the earlier one is committed and put back.
 */
export function releaseOtherEditors(view: EditorView): void {
  const other = holder
  if (other === null || other === view) return
  // An editor that has gone away (a closed tab, a re-locked encrypted block)
  // cannot be dispatched to, and holding a dead reference must not stop the page.
  if (other.dom.isConnected) exitBlockMode(other)
  if (holder === other) holder = null
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
 * A click Chrome already owns: a button, a text field, a link, a diagram's own
 * layer. Such a click is the control's own business — Alt+click on a zoom button
 * is a zoom, not a request about the block it happens to sit on.
 *
 * The two diagram classes are spelled out rather than imported from
 * `mermaid-edit.ts`, which would put the whole rendering library behind this
 * module; they are the chrome layer's public names, and the kanban builder and
 * the diagram's `stopEvent` match the same ones.
 *
 * **A CodeMirror is deliberately *not* on this list**, which it was, and which
 * cost the cycle two whole blocks. A block in its source form is a raw-markdown
 * editor, so a click in one looked like a click in a text field; but so is a
 * **code block's visual form**, and a *code block's text is the entire block* —
 * claiming it meant Alt+click did nothing on the one block type a reader most
 * wants to see as markdown, aimed at the only part of it anyone clicks. It then
 * cost the cycle its own way back out: the block that Alt+click had just opened
 * could not be Alt+clicked closed, because by then its editor *was* the source
 * form and so was claimed. A cycle that can only be entered is not a cycle.
 *
 * What Alt+click does inside a buffer is the cycle's, and that is the right
 * answer for a modifier gesture: a raw-markdown editor is selected with a plain
 * drag or double click, so Alt+click there is nobody's business but the block's.
 * The genuinely interactive fields are still claimed, and each is a real control
 * — `input`/`textarea` for a masked field or a table cell editor, and the
 * diagram's own label field and kanban composers, which are the modes' fields.
 */
function chromeOwnsClick(event: MouseEvent): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(
      'a[href], button, input, textarea, select, .block-controls,'
      + ' .mermaid-kanban-chrome, .mermaid-edit-field',
    ) !== null
  )
}


/**
 * The Alt+click gesture (§5.2), for every block type at once: **advance the
 * block under the pointer one step through its cycle.**
 *
 * Every block that has a source form cycles — visual → the block's own middle
 * step, if it has one → source → back to visual — so the descriptor is the only
 * thing consulted and the cycle reads the same on a paragraph, a diagram and a
 * table. Two cases fall through to `exitBlockMode`, and both are deliberate:
 *
 * - **a click that names no block.** That is the gesture turning a mode off
 *   without having to land back on the block that turned it on, which is why the
 *   listener sits on the scroller rather than on `view.dom` — a lone board
 *   leaves the space under itself on the scroller, and a click aimed at the page
 *   there has to be answered by the editor and not by Chrome selecting the
 *   document name in the status bar.
 * - **`source_block`**, which *is* its source form and so has one state and
 *   nothing to advance to.
 *
 * The click is never swallowed — a word to select, a caret to place and a cell to
 * mark all still happen, which is the whole reason the mode gestures moved off
 * double click in the first place. There is deliberately no off-ramp on a block
 * that *does* cycle: the way back down is Escape, which steps back exactly one
 * mode, and which is the only half of the gesture that stays on the keyboard.
 */
export function blockModeGesture(view: EditorView, event: MouseEvent): boolean {
  if (!event.altKey || event.button !== 0) return false
  if (chromeOwnsClick(event)) return false
  const pos = blockPosForElement(view, event.target)
  if (pos >= 0 && advanceBlockMode(view, pos)) return true
  return exitBlockMode(view)
}

/**
 * Advance the block at `pos` one step through its cycle, and report whether the
 * block has a cycle to advance through.
 *
 * The steps are the descriptor's, in this order, and a block only has the ones
 * it can actually take:
 *
 * 1. **its rendered form**, where it has more than one (a table: text → sheet);
 * 2. **its interaction axis**, where it has one (a diagram: viewing → editing);
 * 3. **source**, which every block but `source_block` has.
 *
 * and then it wraps to the first. The form and the interaction axis are separate
 * steps rather than two spellings of one because they are separate mechanisms —
 * a form is a document attr and a mode flip is not (§4.3) — but a block
 * carrying both would spend a step on each, which is why the checks fall through
 * rather than being exclusive.
 *
 * Two transitions carry the ordering rule of §3 with them:
 *
 * - **editing → source.** `enterSourceMode` cannot finish a pending diagram
 *   field (it is in the other direction of the import, and finishing it is a
 *   commit rather than a mode change), so the subsystem's own `exit` accepts it
 *   first and this call goes on to build its own transaction against the
 *   document that exit left behind. Calling `enterSourceMode` on its own would
 *   drop the half-typed label on the floor — the exact failure
 *   `exitDiagramEditMode` documents. `pos` needs no remapping across that exit,
 *   and this is why: the accept is a `setNodeMarkup` on the block itself, and a
 *   block start maps to its own start either way — the same reason the record's
 *   own `apply` can carry a position across a visual commit.
 * - **source → visual.** `releaseSourceBlock` rather than `exitBlockMode`,
 *   because the commit is a document edit and re-parsing a block can move it by
 *   an arbitrary amount; the wrap is then written against wherever the block
 *   ended up. It wraps to the cycle's *first* step rather than to whatever the
 *   block was drawn as before, because a table that entered source as a sheet
 *   would otherwise oscillate sheet ⇄ source and never reach text again.
 */
export function advanceBlockMode(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos)
  if (node === null) return false
  const type = node.type.name
  const descriptor = blockModeFor(node)
  if (!descriptor.representation) return false

  const mode = modeFor(view.state, pos)
  const representation = mode?.representation ?? 'visual'
  const interaction = mode?.interaction ?? 'viewing'

  if (representation === 'source') {
    const at = releaseSourceBlock(view, pos)
    // The wrap lands on the cycle's *first* step, which for a table is its
    // default form: wrapping onto whatever the block was drawn as before would
    // leave a sheet table oscillating sheet ⇄ source and never reaching text.
    const back = view.state.doc.nodeAt(at)
    const fallback = defaultFormOf(descriptor)
    if (back !== null && fallback !== undefined && mode?.form !== undefined) {
      setBlockForm(view, at, fallback)
    }
    return true
  }

  if (interaction === 'editing') {
    BLOCK_MODE_HANDLERS[type]?.exit?.(view, pos)
    enterSourceMode(view, pos)
    return true
  }

  // Visual. The form comes before the interaction axis because a block that has
  // both is asking to be drawn a different way before it is asking to be edited.
  if (descriptor.forms !== undefined && (mode?.form ?? defaultFormOf(descriptor))
    === defaultFormOf(descriptor)) {
    const other = descriptor.forms.find((entry) => entry.id !== defaultFormOf(descriptor))
    if (other !== undefined) {
      setBlockForm(view, pos, other.id)
      return true
    }
  }
  if (descriptor.interaction === 'toggle') {
    BLOCK_MODE_HANDLERS[type]?.enter?.(view, pos)
    return true
  }
  enterSourceMode(view, pos)
  return true
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
 * takes the whole edit back.
 *
 * A table's **form** has to survive this, because a re-parse rebuilds the table
 * from its markdown and a form is not part of its markdown. The record is cleared
 * here — the block left its source form, and the round-trip is a document edit
 * that must not be holding a mode — so the form is read off the outgoing record
 * and written onto the one that replaces it.
 *
 * That is the same special case §4.3 described as the *cost* of a form living in
 * the document, and the debt did not go away when the attr did: the carry is still
 * needed. What did go away is the half where it had to reconstruct an attribute
 * and the half where the switch was a document edit at all — this now moves one
 * field of one plugin record, and only for a block that had one.
 */
function buildSourceCommitTransaction(
  view: EditorView,
  pos: number,
  nodeSize: number,
  markdown: string,
): Transaction {
  const tr = view.state.tr
  const outgoing = modeFor(view.state, pos)
  const carriedForm = outgoing?.form
  const newDoc = markdownToProse(markdown, view.state.schema)
  const nodes: ProseNode[] = []
  newDoc.forEach((child) => nodes.push(child))
  if (nodes.length > 0) {
    tr.replaceWith(pos, pos + nodeSize, nodes)
    const insertedSize = nodes.reduce((sum, n) => sum + n.nodeSize, 0)
    placeCaretInText(tr, pos + insertedSize - 1, pos + 1, pos + insertedSize)
  } else {
    tr.delete(pos, pos + nodeSize)
    placeCaretInText(tr, pos, 0, tr.doc.content.size)
  }
  // A re-parse can produce any number of blocks, so the form only survives onto
  // the one at the old position — and only if what landed there is still a block
  // that can take it.
  if (carriedForm !== undefined && tr.doc.nodeAt(pos)?.type.name === outgoing?.type) {
    setBlockModeAt(view.state, tr, pos, { form: carriedForm })
  } else {
    setBlockMode(tr, null)
  }
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
  setBlockModeAt(view.state, tr, at, { representation: 'source' })
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
      button.textContent = source ? 'Visual' : 'Source'
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
