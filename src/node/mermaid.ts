import { NodeSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { Node as ProseNode, DOMOutputSpec } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { visit } from 'unist-util-visit'
import { blockNodeView } from '../blockview'
import { reinitializeMermaidTheme } from '../mermaid'
import {
  ADD_BUTTON_CLASS,
  EDITING_CLASS,
  buildKanbanSource,
  finishMermaidLabelEditing,
  renderDiagram,
} from '../mermaid-edit'
import { BLOCK_PLUGIN_KEY } from '../blockplugin'
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

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    mermaidViews.add(this)
    this.node = node
    this.view = view
    this.getPos = getPos
    this.dom = document.createElement('div')
    this.dom.className = 'mermaid'

    if (node.attrs._source) {
      this.showSource()
    } else {
      this.currentCode = String(node.attrs.value ?? '')
      this.showPreview(this.currentCode)
    }
  }

  private get editing(): boolean {
    return this.node.attrs._edit === true
  }

  retheme(): void {
    if (this.node.attrs._source || this.cm) return
    this.rerender()
  }

  update(node: ProseNode): boolean {
    const modeChanged = node.attrs._edit !== this.node.attrs._edit
    if (node.attrs._source && !this.node.attrs._source) {
      this.node = node
      this.showSource()
      return true
    }
    if (!node.attrs._source && this.node.attrs._source) {
      this.node = node
      this.cm?.destroy()
      this.cm = null
      this.currentCode = String(node.attrs.value ?? '')
      this.showPreview(this.currentCode)
      return true
    }
    this.node = node
    if (modeChanged) this.syncModeClass()
    if (!node.attrs._source) {
      const newVal = String(node.attrs.value ?? '')
      if (newVal !== this.currentCode) {
        this.currentCode = newVal
        // Re-render in place rather than rebuilding: a source that no longer
        // parses (a visual edit, a paste, an undo of one) has to leave the last
        // good diagram on screen behind a notice instead of an error block.
        this.rerender()
      } else if (modeChanged) {
        // Entering or leaving edit mode re-renders too: the vector is unbaked
        // while editing so every label is clickable, and baked again after.
        this.rerender()
      }
    }
    return true
  }

  private showSource(): void {
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

    tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: null })
    this.view.dispatch(tr)
    this.view.focus()
  }

  private showPreview(code: string): void {
    this.currentCode = code
    this.buildPreview(code)
  }

  private buildPreview(code: string): void {
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
    await renderDiagram(container, code, {
      host: this.dom,
      // A commit handler is what puts the diagram into edit mode.
      commit: this.editing ? (source) => this.commitSource(source) : undefined,
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
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value })
    tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: null })
    this.view.dispatch(tr)
  }

  stopEvent(event: Event): boolean {
    if (this.cm !== null) return true
    const target = event.target
    if (!(target instanceof Element)) return false
    // The label editor and the kanban ＋ are real controls inside the block:
    // every keystroke and mouse event in them belongs to the editor, not to
    // ProseMirror. The rest of the diagram keeps its normal behaviour — clicking
    // it still selects the block and reveals its handle.
    return target.closest(`.mermaid-edit-input, .${ADD_BUTTON_CLASS}`) !== null
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    mermaidViews.delete(this)
    this.cm?.destroy()
    this.dom.innerHTML = ''
  }
}

export function rethemeMermaid(dark: boolean): void {
  void reinitializeMermaidTheme(dark).then(() => {
    for (const view of mermaidViews) view.retheme()
  })
}

// ── edit mode ──────────────────────────────────────────────────────────────

interface MermaidEditState {
  /** The diagram currently in edit mode, or null. At most one, like tables. */
  editPos: number | null
}

export const MERMAID_EDIT_KEY = new PluginKey<MermaidEditState>('EDI_MERMAID_EDIT')

function currentEditPos(state: EditorState): number | null {
  return MERMAID_EDIT_KEY.getState(state)?.editPos ?? null
}

function setEditAttr(tr: Transaction, pos: number, editing: boolean): void {
  const node = tr.doc.nodeAt(pos)
  if (!node || node.type.name !== MERMAID_TYPE) return
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, _edit: editing })
}

/**
 * Open the diagram at `pos` for editing inside `tr`, dropping whichever other
 * diagram was in edit mode, and return that dropped diagram's new position (or
 * null). Everything entering edit mode needs in the *document* lives here, so a
 * board inserted with the edit already on is one transaction — and one undo —
 * rather than an insert followed by a second mode change.
 */
function openDiagramEditIn(state: EditorState, tr: Transaction, pos: number): number | null {
  const open = currentEditPos(state)
  const dropped = open !== null && open !== pos ? tr.mapping.map(open) : null
  if (dropped !== null) setEditAttr(tr, dropped, false)
  setEditAttr(tr, pos, true)
  tr.setMeta(MERMAID_EDIT_KEY, { editPos: pos })
  return dropped
}

/**
 * Enter edit mode on the diagram at `pos`, dropping whichever other diagram was
 * in it. The block is deselected on the way in: a node selection left in place
 * would let a stray keystroke replace the whole diagram with typed text.
 */
export function enterDiagramEditMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== MERMAID_TYPE) return
  const tr = view.state.tr
  const dropped = openDiagramEditIn(view.state, tr, pos)
  const sel = tr.selection
  if (sel instanceof NodeSelection && sel.node.type.name === MERMAID_TYPE) {
    // `between` lands on the nearest real text position (or a selection over a
    // neighbouring block, for a document with no text at all). The document end
    // is not a text position, and building a TextSelection there directly only
    // warns and leaves the selection where it was.
    const $end = tr.doc.resolve(Math.min(pos + sel.node.nodeSize, tr.doc.content.size))
    tr.setSelection(TextSelection.between($end, $end, 1))
  }
  view.dispatch(tr)
  // The diagram just dropped out of edit mode, so its label editor (if one was
  // open) has to go with it. Dispatching first is what makes that safe: the
  // re-render the mode change triggers already sees `_edit: false`, so the
  // commit below renders the finished diagram instead of racing an edit-mode
  // render that would re-mark the labels.
  if (dropped !== null) finishMermaidLabelEditing(view.nodeDOM(dropped), true)
}

export function exitDiagramEditMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  const tr = view.state.tr
  setEditAttr(tr, pos, false)
  tr.setMeta(MERMAID_EDIT_KEY, { editPos: currentEditPos(view.state) === pos ? null : currentEditPos(view.state) })
  view.dispatch(tr)
  finishMermaidLabelEditing(view.nodeDOM(pos), true)
}

export function toggleDiagramEditMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== MERMAID_TYPE) return
  if (node.attrs._edit) {
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
  const dropped = openDiagramEditIn(view.state, tr, boardPos)
  view.dispatch(tr)
  if (dropped !== null) finishMermaidLabelEditing(view.nodeDOM(dropped), true)
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
  // a kanban ＋: a double click on a button is a click on a button, not a
  // request to toggle this diagram.
  if (event.target.closest(`.mermaid-toolbar, .mermaid-edit-input, .${ADD_BUTTON_CLASS}`) !== null) return null
  if (block.querySelector('.mermaid-edit-input') !== null) return null
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

export const mermaidNodeViewPlugin = new Plugin<MermaidEditState>({
  key: MERMAID_EDIT_KEY,
  state: {
    init: (): MermaidEditState => ({ editPos: null }),
    apply(tr: Transaction, prev: MermaidEditState): MermaidEditState {
      const meta = tr.getMeta(MERMAID_EDIT_KEY)
      if (meta !== undefined) return meta
      if (prev.editPos !== null && tr.docChanged) {
        if (prev.editPos >= tr.doc.content.size) return { editPos: null }
        const node = tr.doc.nodeAt(prev.editPos)
        if (!node || node.type.name !== MERMAID_TYPE) return { editPos: null }
        if (node.attrs._edit !== true) return { editPos: null }
      }
      return prev
    },
  },
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
