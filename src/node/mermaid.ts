import { NodeSelection, Plugin, TextSelection } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { Node as ProseNode, DOMOutputSpec } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { blockNodeView, showsSource } from '../blockview'
import { reinitializeMermaidTheme } from '../mermaid'
import {
  EDITING_CLASS,
  FIELD_CLASS,
  KANBAN_CHROME_CLASS,
  buildKanbanSource,
  discardMermaidSession,
  finishMermaidLabelEditing,
  kanbanAuthoringSource,
  kanbanRealSource,
  renderDiagram,
} from '../mermaid-edit'
import {
  BLOCK_CONTROLS_CLASS,
  BLOCK_MODE_HANDLERS,
  attachBlockControls,
  currentBlockMode,
  modeFor,
  releaseSourceBlock,
  setBlockMode,
  setBlockModeAt,
  type BlockControls,
  type BlockMode,
} from '../block-modes'
import { MERMAID_TYPE } from '../remark/mermaid'
import { markdownToProse, serializeBlock } from '../markdown'
import { createBlockCodeMirror } from '../codemirror-block'
import type { BlockCodeMirror } from '../codemirror-block'
import { showError } from '../bridge'
import { promptForKanbanColumns } from '../urlDialog'

export const mermaidSchema = {
  group: 'block',
  marks: '',
  code: true,
  atom: true,
  attrs: {
    value: { default: '' },
  },
  parseDOM: [
    {
      tag: 'div[data-mermaid-block]',
      getAttrs: (dom: HTMLElement) => ({ value: dom.textContent ?? '' }),
    },
  ],
  toDOM(): DOMOutputSpec {
    return ['div', { 'data-mermaid-block': '', style: 'white-space:pre' }]
  },
}

const mermaidViews = new Set<MermaidNodeView>()

class MermaidNodeView implements NodeView {
  dom: HTMLElement
  private currentCode = ''
  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined
  private cm: BlockCodeMirror | null = null
  /**
   * The mode this view was built for. The node view cannot ask the record about
   * *what changed* — `update` is handed the new node while the state is already
   * the new one — so the old answer is what it has to remember.
   */
  private mode: BlockMode | null
  private controls: BlockControls | null = null

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    mermaidViews.add(this)
    this.node = node
    this.view = view
    this.getPos = getPos
    this.mode = modeFor(view.state, getPos())
    this.dom = document.createElement('div')
    this.dom.className = 'mermaid'

    if (this.mode?.representation === 'source') {
      this.showSource()
    } else {
      this.currentCode = String(node.attrs.value ?? '')
      this.showVisual(this.currentCode)
    }
  }

  private get editing(): boolean {
    return this.mode?.interaction === 'editing'
  }

  private get showingSource(): boolean {
    return this.mode?.representation === 'source'
  }

  retheme(): void {
    if (this.showingSource || this.cm) return
    this.rerender()
  }

  update(node: ProseNode): boolean {
    const next = modeFor(this.view.state, this.getPos())
    const wasSource = this.mode?.representation === 'source'
    const nowSource = next?.representation === 'source'
    const interactionChanged = next?.interaction !== this.mode?.interaction
    this.mode = next
    if (nowSource && !wasSource) {
      this.node = node
      this.showSource()
      return true
    }
    if (!nowSource && wasSource) {
      this.node = node
      this.cm?.destroy()
      this.cm = null
      this.currentCode = String(node.attrs.value ?? '')
      this.showVisual(this.currentCode)
      return true
    }
    this.node = node
    if (interactionChanged) this.syncModeClass()
    if (!nowSource) {
      const newVal = String(node.attrs.value ?? '')
      if (newVal !== this.currentCode) {
        this.currentCode = newVal
        // Re-render in place rather than rebuilding: a source that no longer
        // parses (a visual edit, a paste, an undo of one) has to leave the last
        // good diagram on screen behind a notice instead of an error block.
        this.rerender()
      } else if (interactionChanged) {
        // Entering or leaving edit mode re-renders too: the vector is unbaked
        // while editing so every label is clickable, and baked again after.
        this.rerender()
      }
    }
    return true
  }

  private showSource(): void {
    // The session owns the overlays, and they are children of the block rather
    // than of the drawing a render replaces — so tearing the block down without
    // ending the session would leave a field floating over a diagram that is no
    // longer there, still swallowing its own events, with the block's own padding
    // for it still applied.
    discardMermaidSession(this.dom)
    this.controls?.remove()
    this.controls = null
    this.dom.innerHTML = ''
    this.dom.className = 'block-source-mode'

    const toolbar = document.createElement('div')
    toolbar.className = 'block-source-toolbar'
    const label = document.createElement('span')
    label.className = 'block-source-label'
    label.textContent = 'Source'
    toolbar.appendChild(label)

    const exitBtn = document.createElement('button')
    exitBtn.type = 'button'
    exitBtn.className = 'block-source-exit'
    exitBtn.textContent = 'Visual'
    exitBtn.title = 'Back to the rendered block (Esc)'
    exitBtn.addEventListener('click', () => {
      this.exitSource(this.cm?.getValue() ?? '')
    })
    toolbar.appendChild(exitBtn)

    this.dom.appendChild(toolbar)

    const markdown = serializeBlock(this.node)
    this.cm = createBlockCodeMirror(this.dom, markdown, (value) => {
      this.exitSource(value)
    })

    requestAnimationFrame(() => this.cm?.focus())
  }

  private exitSource(value: string): void {
    const pos = this.getPos()
    if (pos === undefined) return

    const tr = this.view.state.tr
    const newDoc = markdownToProse(value, this.view.state.schema)
    const nodes: ProseNode[] = []
    newDoc.forEach((child) => nodes.push(child))

    if (nodes.length > 0) {
      tr.replaceWith(pos, pos + this.node.nodeSize, nodes)
    } else {
      tr.delete(pos, pos + this.node.nodeSize)
    }

    setBlockMode(tr, null)
    this.view.dispatch(tr)
    this.view.focus()
  }

  private showVisual(code: string): void {
    this.currentCode = code
    this.buildVisual(code)
  }

  private buildVisual(code: string): void {
    // The element holding the drawing is about to be replaced, and the session
    // places everything against it, so a session that outlived this would be
    // placing overlays in a detached scroller. A rebuild is a fresh block anyway.
    discardMermaidSession(this.dom)
    this.controls?.remove()
    this.controls = null
    this.dom.innerHTML = ''
    this.dom.className = 'mermaid'
    this.syncModeClass()

    // The variable is named for the mode (`visual`) and the class for what the
    // element is — the scroller the drawing lives in, which has been called
    // `.mermaid-preview` since long before the two axes had names. Not a
    // half-renamed pair: the mode says how the block is shown, the element holds
    // the diagram.
    const visual = document.createElement('div')
    visual.className = 'mermaid-preview'
    this.dom.appendChild(visual)
    this.controls = attachBlockControls(this.node, this.view, this.getPos)
    if (this.controls) this.dom.appendChild(this.controls.dom)
    void this.renderVisual(visual, code)
  }

  private syncModeClass(): void {
    this.dom.classList.toggle(EDITING_CLASS, this.editing)
    this.controls?.refresh()
  }

  /** Re-render into the existing drawing, so the last good diagram survives a failure. */
  private rerender(): void {
    const visual = this.dom.querySelector<HTMLElement>('.mermaid-preview')
    if (!visual) {
      this.buildVisual(this.currentCode)
      return
    }
    void this.renderVisual(visual, this.currentCode)
  }

  private async renderVisual(container: HTMLElement, code: string): Promise<void> {
    // A board is authored from the board, so in edit mode it is *drawn* with the
    // two places a card or a column can be added: mermaid lays a card slot out in
    // the next card's own place and a column slot out as a column, which is
    // something no hand-placed control can be. The slots are part of what is
    // rendered and never part of what is committed — the document holds the
    // board, and the slots are derived from it on every render.
    const drawn = this.editing ? kanbanAuthoringSource(code) : code
    await renderDiagram(container, drawn, {
      host: this.dom,
      // A commit handler is what puts the diagram into edit mode.
      commit: this.editing
        ? // A patch made against the drawn board comes back through the real
          // source, which keeps a slot the user has typed a name for — the edit
          // itself — and drops one still holding its placeholder.
          (patched) => this.commitSource(kanbanRealSource(patched))
        : undefined,
    })
  }

  /**
   * Apply a visual edit (a relabelled node, a moved kanban card) as a single
   * transaction, so undo takes a whole edit back. `currentCode` is deliberately
   * *not* pre-set here: `update` uses it to spot a changed value, and this is
   * exactly such a change — pre-setting it would make the view skip the
   * re-render and leave the old diagram on screen.
   */
  private commitSource(value: string): void {
    const pos = this.getPos()
    if (pos === undefined) return
    // Only ever a diagram: the block can have gone to its source mode while a
    // dialog was up, and a commit that landed then would be an edit in the
    // document that neither the rendered diagram nor the CodeMirror buffer ever
    // showed.
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== MERMAID_TYPE) return
    // The record is deliberately left alone: this is a visual edit to a block
    // that is still in edit mode, and releasing it here would drop the block out
    // of editing on its first label rename. A block in the source form cannot
    // reach this at all — `commit` is only wired up while editing.
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, value })
    this.view.dispatch(tr)
  }

  stopEvent(event: Event): boolean {
    if (this.cm !== null) return true
    const target = event.target
    if (!(target instanceof Element)) return false
    // The label editor, the board's own chrome and the block's control cluster
    // are real controls inside the block: every keystroke and mouse event in them
    // belongs to the editor, not to ProseMirror. The chrome is matched by its
    // *layer* rather than by the button class, because an open `⋯` menu is a list
    // of items rather than a button and is just as much the editor's own surface.
    // The rest of the diagram keeps its normal behaviour — clicking it still
    // selects the block, and Alt+click on it still toggles edit mode.
    return target.closest(
      `.${FIELD_CLASS}, .${KANBAN_CHROME_CLASS}, .${BLOCK_CONTROLS_CLASS}`,
    ) !== null
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    mermaidViews.delete(this)
    this.cm?.destroy()
    // Nothing to accept: the block is gone, so there is no document to commit to.
    discardMermaidSession(this.dom, false)
    this.dom.innerHTML = ''
  }
}

export function rethemeMermaid(dark: boolean): void {
  void reinitializeMermaidTheme(dark).then(() => {
    for (const view of mermaidViews) view.retheme()
  })
}

// ── edit mode ──────────────────────────────────────────────────────────────

/**
 * The diagram in edit mode, or null. Edit mode is the record's *interaction*
 * axis, so there is no registry of its own here: at most one block in the
 * document is in a non-default state, and that is enforced once, in
 * `block-modes.ts`.
 */
function currentEditPos(state: EditorState): number | null {
  const mode = currentBlockMode(state)
  return mode !== null && mode.interaction === 'editing' ? mode.pos : null
}

/**
 * Enter edit mode on the diagram at `pos`, dropping whichever other diagram was
 * in it. The block is deselected on the way in: a node selection left in place
 * would let a stray keystroke replace the whole diagram with typed text.
 */
export function enterDiagramEditMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  if (view.state.doc.nodeAt(pos)?.type.name !== MERMAID_TYPE) return
  // Read before anything is built: both of the steps below dispatch, and a
  // transaction built before them would land on a document that has moved on.
  const dropped = currentEditPos(view.state)
  // The diagram about to drop out of edit mode finishes its pending field *before*
  // the transaction lands, not after it. A dispatch re-renders the block
  // synchronously as far as the first `await`, which is far enough to rebind its
  // session to "this is not editable any more" — so a field accepted afterwards
  // would be
  // committing to a block that had already stopped being editable, and the
  // half-typed label would be dropped on the floor. Accepting first lets the
  // commit's own render happen in edit mode, and the mode change then renders over
  // it; the two are ordered, so the mode is what is left on screen. Every entry
  // point reaches this only from *outside* edit mode, so `dropped === pos` cannot
  // happen and the field belongs to the diagram that is actually losing it.
  if (dropped !== null && dropped !== pos) {
    finishMermaidLabelEditing(view.nodeDOM(dropped), true)
  }
  // A block in the *source* form is released by committing it, and a commit is
  // a document edit — so the position to open is wherever that block moved to,
  // not the one this call was handed.
  const at = releaseSourceBlock(view, pos)
  if (view.state.doc.nodeAt(at)?.type.name !== MERMAID_TYPE) return

  const tr = view.state.tr
  setBlockModeAt(view.state, tr, at, { interaction: 'editing' })
  const sel = tr.selection
  if (sel instanceof NodeSelection && sel.node.type.name === MERMAID_TYPE) {
    // `between` lands on the nearest real text position (or a selection over a
    // neighbouring block, for a document with no text at all). The document end
    // is not a text position, and building a TextSelection there directly only
    // warns and leaves the selection where it was.
    const $end = tr.doc.resolve(Math.min(at + sel.node.nodeSize, tr.doc.content.size))
    tr.setSelection(TextSelection.between($end, $end, 1))
  }
  view.dispatch(tr)
}

export function exitDiagramEditMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  // Done, or a double click that finished the diagram: a half-typed label is an
  // edit the user made, and finishing the diagram is finishing it — so it commits
  // before the mode goes, for the reason `enterDiagramEditMode` gives.
  finishMermaidLabelEditing(view.nodeDOM(pos), true)
  const tr = view.state.tr
  const mode = currentBlockMode(view.state)
  setBlockMode(tr, mode !== null && mode.pos !== pos ? mode : null)
  view.dispatch(tr)
}

export function toggleDiagramEditMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== MERMAID_TYPE) return
  if (modeFor(view.state, pos)?.interaction === 'editing') {
    exitDiagramEditMode(view, pos)
  } else {
    enterDiagramEditMode(view, pos)
  }
}

/**
 * Insert a new, empty kanban board from `source` (a `buildKanbanSource` result)
 * and open it straight in edit mode, so the per-column ＋ can fill it: a board
 * with no cards has nothing else to edit. The insert mirrors `insertTable`'s two
 * branches — an empty paragraph is replaced, otherwise the board goes after the
 * top-level block the selection is in — and the mode rides along in the same
 * transaction, so one undo takes the whole board away.
 */
export function insertKanbanSource(view: EditorView, source: string): boolean {
  if (!source) return false
  const node = view.state.schema.nodes[MERMAID_TYPE].create({ value: source })
  // Before anything is built, for the reason `enterDiagramEditMode` gives:
  // finishing the diagram that is losing edit mode dispatches, and a transaction
  // built before that would land on a document that has moved on.
  const dropped = currentEditPos(view.state)
  if (dropped !== null) finishMermaidLabelEditing(view.nodeDOM(dropped), true)
  // Likewise a block in the source form: committing it is a document edit, so
  // the selection — and therefore the insertion point — has to be read after it
  // rather than before.
  releaseSourceBlock(view, view.state.selection.from)
  const { $from } = view.state.selection
  const tr = view.state.tr
  let boardPos: number
  if ($from.parent.isTextblock && $from.parent.content.size === 0) {
    boardPos = $from.before($from.depth)
    tr.replaceWith(boardPos, $from.after($from.depth), node)
  } else {
    boardPos = $from.depth > 0 ? $from.after(1) : $from.pos
    tr.insert(boardPos, node)
  }
  // The mode rides along in the same transaction, so one undo takes the whole
  // board away: the mode is the record's own state and costs the document
  // nothing, but it still belongs to the insert rather than to a second step.
  setBlockModeAt(view.state, tr, boardPos, { interaction: 'editing' })
  view.dispatch(tr)
  return true
}

/**
 * Ask for a board's columns and insert it. Resolves false if the user cancelled
 * the dialog or every name they typed is one the kanban grammar cannot carry —
 * a column is delimited by `]`, so `]` and a few friends are not names.
 */
export async function insertKanbanBoard(view: EditorView): Promise<boolean> {
  const columns = await promptForKanbanColumns()
  if (columns === null) return false
  const source = buildKanbanSource(columns)
  if (!source) {
    await showError('None of those column names can be used in a kanban column')
    return false
  }
  return insertKanbanSource(view, source)
}

/**
 * A diagram is the one block type with an interaction axis, so it is what
 * registers how that axis is entered and left, and what Alt+click does to it
 * (§5.2). Registered rather than imported into `block-modes.ts`, which cannot
 * import this file.
 */
BLOCK_MODE_HANDLERS[MERMAID_TYPE] = {
  enter: enterDiagramEditMode,
  exit: exitDiagramEditMode,
  toggle: toggleDiagramEditMode,
}

export const mermaidNodeViewPlugin = new Plugin({
  props: {
    nodeViews: {
      [MERMAID_TYPE]: (node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        // The source form is the record's business and is asked of it directly
        // (`mermaid_block` is never a `source_block`); `blockNodeView` then
        // builds the same raw-markdown editor every other block type gets.
        if (showsSource(view, getPos())) {
          return blockNodeView(node, view, getPos) as NodeView
        }
        return new MermaidNodeView(node, view, getPos)
      },
    },
  },
})
