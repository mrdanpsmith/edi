import { NodeSelection, Plugin, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { Node as ProseNode, DOMOutputSpec } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { visit } from 'unist-util-visit'
import { blockNodeView } from '../blockview'
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
  clearModeMirror,
  currentBlockMode,
  modeFor,
  releaseSourceBlock,
  setBlockMode,
  setBlockModeAt,
  setInteractionAttr,
  type BlockMode,
} from '../block-modes'
import { markdownToProse, serializeBlock } from '../markdown'
import { createBlockCodeMirror } from '../codemirror-block'
import type { BlockCodeMirror } from '../codemirror-block'
import { showError } from '../bridge'
import { promptForKanbanColumns } from '../urlDialog'

export const MERMAID_TYPE = 'mermaid_block'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function remarkPlugin(this: any) {
  const data = this.data()
  if (!data.micromarkExtensions) data.micromarkExtensions = []
  if (!data.fromMarkdownExtensions) data.fromMarkdownExtensions = []
  if (!data.toMarkdownExtensions) data.toMarkdownExtensions = []

  data.fromMarkdownExtensions.push({
    transforms: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tree: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        visit(tree, 'code', (node: any, index: number | undefined, parent: any) => {
          if (index !== undefined && node.lang === 'mermaid') {
            parent.children[index] = {
              type: MERMAID_TYPE,
              value: node.value ?? '',
              position: node.position,
            }
          }
        })
      },
    ],
  })

  data.toMarkdownExtensions.push({
    handlers: {
      [MERMAID_TYPE]: (
        node: { value?: string },
        _: unknown,
        state: { enter: (t: string) => () => void },
        info: unknown,
      ) => {
        const exit = state.enter('code')
        void info
        exit()
        return `\`\`\`mermaid\n${node.value ?? ''}\n\`\`\`\n`
      },
    },
  })
}

export const mermaidSchema = {
  group: 'block',
  marks: '',
  code: true,
  atom: true,
  attrs: {
    value: { default: '' },
    _source: { default: false },
    _edit: { default: false },
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

function createHandleDOM(pos: number): HTMLElement {
  const handle = document.createElement('div')
  handle.className = 'block-handle'
  handle.setAttribute('data-block-pos', String(pos))
  handle.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
    <circle cx="3" cy="2" r="1.2"/><circle cx="9" cy="2" r="1.2"/>
    <circle cx="3" cy="6" r="1.2"/><circle cx="9" cy="6" r="1.2"/>
    <circle cx="3" cy="10" r="1.2"/><circle cx="9" cy="10" r="1.2"/>
  </svg>`
  return handle
}

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
      this.showPreview(this.currentCode)
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
      this.showPreview(this.currentCode)
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
    this.dom.innerHTML = ''
    this.dom.className = 'block-source-mode'

    const toolbar = document.createElement('div')
    toolbar.className = 'block-source-toolbar'
    const label = document.createElement('span')
    label.className = 'block-source-label'
    label.textContent = 'Mermaid source'
    toolbar.appendChild(label)

    const exitBtn = document.createElement('button')
    exitBtn.type = 'button'
    exitBtn.className = 'block-source-exit'
    exitBtn.textContent = 'Visual mode'
    exitBtn.title = 'Back to visual mode (Esc)'
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

  private showPreview(code: string): void {
    this.currentCode = code
    this.buildPreview(code)
  }

  private buildPreview(code: string): void {
    // The preview element is about to be replaced, and the session places
    // everything against it, so a session that outlived this would be placing
    // overlays in a detached scroller. A rebuild is a fresh block either way.
    discardMermaidSession(this.dom)
    this.dom.innerHTML = ''
    this.dom.className = 'mermaid'
    this.syncModeClass()

    const pos = this.getPos()
    if (pos !== undefined) {
      this.dom.appendChild(createHandleDOM(pos))
    }

    const preview = document.createElement('div')
    preview.className = 'mermaid-preview'
    this.dom.appendChild(preview)
    void this.renderPreview(preview, code)
  }

  private syncModeClass(): void {
    this.dom.classList.toggle(EDITING_CLASS, this.editing)
  }

  /** Re-render into the existing preview, so the last good diagram survives a failure. */
  private rerender(): void {
    const preview = this.dom.querySelector<HTMLElement>('.mermaid-preview')
    if (!preview) {
      this.buildPreview(this.currentCode)
      return
    }
    void this.renderPreview(preview, this.currentCode)
  }

  private async renderPreview(container: HTMLElement, code: string): Promise<void> {
    const button = this.createToggleButton()
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
      actions: [button],
    })
  }

  private createToggleButton(): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mermaid-toolbar-btn mermaid-edit-toggle'
    this.paintToggle(button)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      const pos = this.getPos()
      if (pos !== undefined) toggleDiagramEditMode(this.view, pos)
    })
    button.addEventListener('mousedown', (event) => {
      // Keep ProseMirror from treating the button press as a block selection.
      event.preventDefault()
      event.stopPropagation()
    })
    return button
  }

  private paintToggle(button: HTMLButtonElement): void {
    const editing = this.editing
    button.textContent = editing ? 'Done' : 'Edit'
    button.title = editing ? 'Finish editing the diagram' : 'Edit the diagram in place'
    button.setAttribute('aria-pressed', String(editing))
    button.setAttribute('aria-label', button.title)
    button.classList.toggle('mermaid-edit-toggle-on', editing)
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
    // document that neither the preview nor the CodeMirror buffer ever showed.
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
    // The label editor and the board's own chrome are real controls inside the
    // block: every keystroke and mouse event in them belongs to the editor, not
    // to ProseMirror. The chrome is matched by its *layer* rather than by the
    // button class, because an open `⋯` menu is a list of items rather than a
    // button and is just as much the editor's own surface. The rest of the
    // diagram keeps its normal behaviour — clicking it still selects the block
    // and reveals its handle.
    return target.closest(`.${FIELD_CLASS}, .${KANBAN_CHROME_CLASS}`) !== null
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
 * Put the diagram at `pos` into edit mode inside `tr`. Everything entering edit
 * mode needs in the *document* lives here, so a board inserted with the edit
 * already on is one transaction — and one undo — rather than an insert followed
 * by a second mode change.
 */
function openDiagramEditIn(state: EditorState, tr: Transaction, pos: number): void {
  const open = currentEditPos(state)
  if (open !== null && open !== pos) clearModeMirror(tr, currentBlockMode(state))
  setInteractionAttr(tr, pos, true)
  setBlockModeAt(tr, pos, { interaction: 'editing' })
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
  // session to "this is a preview" — so a field accepted afterwards would be
  // committing to a block that had already stopped being editable, and the
  // half-typed label would be dropped on the floor. Accepting first lets the
  // commit's own render happen in edit mode, and the mode change then renders over
  // it; the two are ordered, so the mode is what is left on screen.
  if (dropped !== null && dropped !== pos) {
    finishMermaidLabelEditing(view.nodeDOM(dropped), true)
  }
  // A block in the *source* form is released by committing it, and a commit is
  // a document edit — so the position to open is wherever that block moved to,
  // not the one this call was handed.
  const at = releaseSourceBlock(view, pos)
  if (view.state.doc.nodeAt(at)?.type.name !== MERMAID_TYPE) return

  const tr = view.state.tr
  clearModeMirror(tr, currentBlockMode(view.state))
  setInteractionAttr(tr, at, true)
  setBlockModeAt(tr, at, { interaction: 'editing' })
  const sel = tr.selection
  if (sel instanceof NodeSelection && sel.node.type.name === MERMAID_TYPE) {
    // `between` lands on the nearest real text position (or a selection over a
    // neighbouring block, for a document with no text at all). The document end
    // is not a text position, and building a TextSelection there directly only
    // warns and leaves the selection where it was.
    const $end = tr.doc.resolve(Math.min(at + sel.node.nodeSize, tr.doc.content.size))
    tr.setSelection(TextSelection.between($end, $end, 1))
  }
  // The diagram about to drop out of edit mode finishes its pending field
  // *before* the transaction lands, not after it. A dispatch re-renders the
  // block synchronously as far as the first `await`, which is far enough to
  // rebind its session to "this is a preview" — so a field accepted afterwards
  // would be committing to a block that had already stopped being editable, and
  // the half-typed label would be dropped on the floor. Accepting first lets the
  // commit's own render happen in edit mode, and the mode change then renders
  // over it; the two are ordered, so the mode is what is left on screen.
  if (dropped !== null) finishMermaidLabelEditing(view.nodeDOM(dropped), true)
  view.dispatch(tr)
}

export function exitDiagramEditMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  // Done, or a double click that finished the diagram: a half-typed label is an
  // edit the user made, and finishing the diagram is finishing it — so it commits
  // before the mode goes, for the reason `enterDiagramEditMode` gives.
  finishMermaidLabelEditing(view.nodeDOM(pos), true)
  const tr = view.state.tr
  setInteractionAttr(tr, pos, false)
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
  openDiagramEditIn(view.state, tr, boardPos)
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

/** The diagram a double click lands on, or null when it is not on one. */
function diagramEditTogglePos(event: MouseEvent): number | null {
  if (!(event.target instanceof Element)) return null
  const block = event.target.closest<HTMLElement>('.mermaid')
  if (!block) return null
  // Chrome and an open label editor handle their own double clicks, and so does
  // a board's controls: a double click on one of them — or inside a `⋯` menu —
  // is a click on that, not a request to toggle this diagram.
  if (event.target.closest(`.mermaid-toolbar, .${FIELD_CLASS}, .${KANBAN_CHROME_CLASS}`) !== null) return null
  if (block.querySelector(`.${FIELD_CLASS}`) !== null) return null
  const handle = block.querySelector<HTMLElement>('.block-handle[data-block-pos]')
  const pos = handle ? Number(handle.dataset.blockPos) : Number.NaN
  return Number.isInteger(pos) && pos >= 0 ? pos : null
}

/**
 * A double click Chrome already owns: a word to select, a link to open, a
 * button to press, a caret in an editor. Such a click is left to do its own
 * job — it merely happens to also end diagram edit mode.
 */
function chromeHandlesDoubleClick(event: MouseEvent): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest('a[href], button, input, textarea, select, .cm-editor') !== null
  )
}

export const mermaidNodeViewPlugin = new Plugin({
  view(view: EditorView) {
    const onDblClick = (event: MouseEvent): void => {
      const pos = diagramEditTogglePos(event)
      if (pos !== null) {
        toggleDiagramEditMode(view, pos)
        return
      }
      // A double click outside the diagram finishes it too: edit mode belongs to
      // one diagram, and the gesture that turns it off should not have to land
      // back on the diagram — on a diagram in source mode, or on one that no
      // longer shows one. The click is not swallowed, so whatever it meant for
      // the page below (a word, a caret) still happens.
      if (chromeHandlesDoubleClick(event)) return
      const open = currentEditPos(view.state)
      if (open === null || view.nodeDOM(open) === null) return
      exitDiagramEditMode(view, open)
    }
    // The editor's own box is only as tall as its content, so a document that is
    // one short diagram leaves the rest of the scroller — the white area under
    // the board — outside `view.dom` entirely, and a double click landed there
    // never reached this handler: the mode stayed on and the browser went on to
    // select the nearest text on the page instead, which is the document name in
    // the status bar. Listen on the scroller, which holds both. It is the
    // scroller and not `document` (which is what the table plugin can afford)
    // so that a double click in a dialog sitting on top of the editor cannot
    // reach through it and end the session behind the dialog.
    // `Document` is in the union for a mount into a fragment or a shadow root,
    // which ProseMirror allows and which has no `parentElement`; the union is
    // what defeats `addEventListener`'s typed overloads.
    const host = view.dom.parentElement ?? document
    host.addEventListener('dblclick', onDblClick as EventListener)
    return { destroy: () => host.removeEventListener('dblclick', onDblClick as EventListener) }
  },
  props: {
    nodeViews: {
      [MERMAID_TYPE]: (node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        if ((node.attrs['_source'] as boolean)) {
          return blockNodeView(node, view, getPos) ?? new MermaidNodeView(node, view, getPos)
        }
        return new MermaidNodeView(node, view, getPos)
      },
    },
  },
})
