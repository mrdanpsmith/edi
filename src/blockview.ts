import type { Node as ProseNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { createBlockCodeMirror, type BlockCodeMirror } from './codemirror-block'
import { attachBlockControls, commitSourceBlock, modeFor } from './block-modes'
import { serializeBlock } from './markdown'
import { headingSlug } from './schema'

/**
 * What the visual-mode wrapper DOM depends on. The node view rebuilds the
 * wrapper only when this changes: type changes already force a fresh node
 * view, but attr-only changes (heading level, list start order, code language)
 * would otherwise keep the old element — e.g. an `<h1>` staying an `<h1>`
 * after the block was set to level 2.
 */
function visualSignature(node: ProseNode): string {
  const type = node.type.name
  if (type === 'heading') return `heading:${node.attrs.level as number}`
  if (type === 'ordered_list') return `ordered_list:${node.attrs.order as number}`
  if (type === 'code_block') return `code_block:${node.attrs.language as string}`
  return type
}

function createSemanticWrapper(node: ProseNode): HTMLElement | null {
  const type = node.type.name
  switch (type) {
    case 'paragraph': {
      const el = document.createElement('p')
      return el
    }
    case 'heading': {
      const el = document.createElement(`h${node.attrs.level as number}`)
      const id = (node.attrs.id as string | null | undefined) ?? headingSlug(node.textContent)
      if (id) el.id = id
      return el
    }
    case 'blockquote': {
      const el = document.createElement('blockquote')
      return el
    }
    case 'bullet_list': {
      const el = document.createElement('ul')
      return el
    }
    case 'ordered_list': {
      const el = document.createElement('ol')
      const order = node.attrs.order as number
      if (order !== 1) el.setAttribute('start', String(order))
      return el
    }
    case 'code_block': {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      const lang = node.attrs.language as string
      if (lang) code.className = `language-${lang}`
      pre.appendChild(code)
      return pre
    }
    case 'horizontal_rule': {
      return document.createElement('hr')
    }
    default:
      return null
  }
}

/** Is the block at `pos` showing its raw markdown, per the mode record? */
export function showsSource(view: EditorView, pos: number | undefined): boolean {
  return modeFor(view.state, pos)?.representation === 'source'
}

class BlockSourceNodeView implements NodeView {
  dom: HTMLElement
  private cm: BlockCodeMirror | null = null
  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement('div')
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

    const markdown = (node.attrs.markdown as string ?? '') ||
      serializeBlock(this.node) ||
      ''
    let initialPos: number | undefined
    if (markdown.startsWith('```')) {
      const nl = markdown.indexOf('\n')
      if (nl >= 0) initialPos = nl + 1
    }
    this.cm = createBlockCodeMirror(this.dom, markdown, (value) => {
      this.exitSource(value)
    }, initialPos)

    requestAnimationFrame(() => this.cm?.focus())
  }

  private exitSource(value: string): void {
    const pos = this.getPos()
    if (pos === undefined) return
    commitSourceBlock(this.view, pos, value)
    this.view.focus()
  }

  update(node: ProseNode): boolean {
    // The mode is not a document attr, so it cannot be read off the node: ask
    // the record, and rebuild when the answer has changed — the source editor
    // and the rendering are two entirely different views of the same block.
    if (!showsSource(this.view, this.getPos())) return false
    this.node = node
    return true
  }

  stopEvent(): boolean {
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.cm?.destroy()
  }
}

class BlockVisualNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private sig: string
  private view: EditorView
  private getPos: () => number | undefined

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.sig = visualSignature(node)
    this.view = view
    this.getPos = getPos
    this.dom = document.createElement('div')
    this.dom.className = 'block-visual-mode'

    const semantic = createSemanticWrapper(node)
    if (semantic) {
      this.contentDOM = semantic
      this.dom.appendChild(semantic)
    } else {
      this.contentDOM = document.createElement('div')
      this.contentDOM.className = 'block-content'
      this.dom.appendChild(this.contentDOM)
    }
    // Appended after the content so it paints over it, which is what lets it be
    // pressed where it overlaps a wide diagram or a long code block.
    const controls = attachBlockControls(node, view, getPos)
    if (controls) this.dom.appendChild(controls.dom)
  }

  update(node: ProseNode): boolean {
    if (showsSource(this.view, this.getPos())) return false
    if (visualSignature(node) !== this.sig) return false
    // The heading's id derives from its text, so a text edit within the same
    // level keeps the node view alive but must refresh the anchor.
    if (node.type.name === 'heading') {
      const id = (node.attrs.id as string | null | undefined) ?? headingSlug(node.textContent) ?? ''
      if (this.contentDOM.id !== id) this.contentDOM.id = id
    }
    return true
  }

  getContentDOM(): { dom: HTMLElement; contentDOM?: HTMLElement } {
    return { dom: this.dom, contentDOM: this.contentDOM }
  }
}

export const BLOCK_NODE_TYPES = new Set([
  'paragraph', 'heading', 'blockquote', 'bullet_list', 'ordered_list',
  'code_block', 'horizontal_rule',
])

export function blockNodeView(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  if (showsSource(view, getPos()) || node.type.name === 'source_block') {
    return new BlockSourceNodeView(node, view, getPos)
  }

  if (BLOCK_NODE_TYPES.has(node.type.name)) {
    return new BlockVisualNodeView(node, view, getPos)
  }

  return undefined as unknown as NodeView
}
