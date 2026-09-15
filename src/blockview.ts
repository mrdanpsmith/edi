import type { Node as ProseNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import type { Transaction } from 'prosemirror-state'
import { EditorView as CMEditorView } from '@codemirror/view'
import { createBlockCodeMirror, type BlockCodeMirror } from './codemirror-block'
import { BLOCK_PLUGIN_KEY, getSourceBlockState } from './blockplugin'
import { markdownToProse, serializeBlock } from './markdown'

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

function buildSourceCommitTransaction(
  view: EditorView,
  pos: number,
  nodeSize: number,
  markdown: string,
): Transaction {
  const tr = view.state.tr
  const newDoc = markdownToProse(markdown, view.state.schema)
  const nodes: ProseNode[] = []
  newDoc.forEach((child) => nodes.push(child))
  if (nodes.length > 0) {
    tr.replaceWith(pos, pos + nodeSize, nodes)
  } else {
    tr.delete(pos, pos + nodeSize)
  }
  tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: null })
  return tr
}

export function commitSourceMode(view: EditorView): Transaction | null {
  const blockState = getSourceBlockState(view.state)
  const pos = blockState.sourceBlockPos
  if (pos === null || pos >= view.state.doc.content.size) return null
  const node = view.state.doc.nodeAt(pos)
  if (!node) return null
  const dom = view.nodeDOM(pos)
  const cmEl = dom instanceof HTMLElement ? dom.querySelector('.cm-editor') : null
  const cmView = cmEl instanceof HTMLElement ? CMEditorView.findFromDOM(cmEl) : undefined
  const value = cmView?.state.doc.toString()
  if (value === undefined) return null
  return buildSourceCommitTransaction(view, pos, node.nodeSize, value)
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
    label.textContent = 'Markdown source'
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

    const tr = buildSourceCommitTransaction(this.view, pos, this.node.nodeSize, value)
    this.view.dispatch(tr)
    this.view.focus()
  }

  update(node: ProseNode): boolean {
    if (!node.attrs._source) return false
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

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.sig = visualSignature(node)
    this.dom = document.createElement('div')
    this.dom.className = 'block-visual-mode'

    const pos = getPos()
    if (pos !== undefined) {
      const $pos = view.state.doc.resolve(pos)
      if ($pos.parent.type.name === 'doc') {
        this.dom.appendChild(createHandleDOM(pos))
      }
    }

    const semantic = createSemanticWrapper(node)
    if (semantic) {
      this.contentDOM = semantic
      this.dom.appendChild(semantic)
    } else {
      this.contentDOM = document.createElement('div')
      this.contentDOM.className = 'block-content'
      this.dom.appendChild(this.contentDOM)
    }
  }

  update(node: ProseNode): boolean {
    if (node.attrs._source) return false
    if (visualSignature(node) !== this.sig) return false
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
  if (node.attrs._source || node.type.name === 'source_block') {
    return new BlockSourceNodeView(node, view, getPos)
  }

  if (BLOCK_NODE_TYPES.has(node.type.name)) {
    return new BlockVisualNodeView(node, view, getPos)
  }

  return undefined as unknown as NodeView
}
