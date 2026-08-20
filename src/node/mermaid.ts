import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as ProseNode, DOMOutputSpec } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { visit } from 'unist-util-visit'
import { blockNodeView } from '../blockview'
import { loadMermaid, errorBlock } from '../mermaid'
import { BLOCK_PLUGIN_KEY } from '../blockplugin'
import { markdownToProse, serializeBlock } from '../markdown'
import { createBlockCodeMirror } from '../codemirror-block'
import type { BlockCodeMirror } from '../codemirror-block'

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

let seed = 0

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

  update(node: ProseNode): boolean {
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
    if (!node.attrs._source) {
      const newVal = String(node.attrs.value ?? '')
      if (newVal !== this.currentCode) {
        this.currentCode = newVal
        this.showPreview(newVal)
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
    this.dom.innerHTML = ''
    this.dom.className = 'mermaid'

    const pos = this.getPos()
    if (pos !== undefined) {
      this.dom.appendChild(createHandleDOM(pos))
    }

    const preview = document.createElement('div')
    preview.className = 'mermaid-preview'
    preview.textContent = code
    this.dom.appendChild(preview)
    void this.renderPreview(preview, code)
  }

  private async renderPreview(container: HTMLElement, code: string): Promise<void> {
    container.textContent = code
    try {
      const mermaid = await loadMermaid()
      const id = `mermaid-node-${Date.now()}-${seed++}`
      const { svg } = await mermaid.render(id, code)
      container.innerHTML = svg
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      container.innerHTML = ''
      container.appendChild(errorBlock(message))
    }
  }

  stopEvent(): boolean {
    return this.cm !== null
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.cm?.destroy()
    this.dom.innerHTML = ''
  }
}

export const mermaidNodeViewPlugin = new Plugin({
  key: new PluginKey('EDI_MERMAID_NODEVIEW'),
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
