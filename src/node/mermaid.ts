import { $nodeSchema, $prose, $remark } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { Node as ProseNode, DOMOutputSpec } from '@milkdown/prose/model'
import type { NodeView } from '@milkdown/prose/view'
import { visit } from 'unist-util-visit'
import { loadMermaid, errorBlock } from '../mermaid'

const MERMAID_TYPE = 'mermaid_block'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function remarkMermaidPlugin(this: any) {
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

export const mermaidRemark = $remark('remarkMermaid', () => remarkMermaidPlugin)
export { remarkMermaidPlugin as rawMermaidRemarkPlugin }

export const mermaidSchema = $nodeSchema(MERMAID_TYPE as never, () => ({
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
  toDOM: (): DOMOutputSpec => [
    'div',
    { 'data-mermaid-block': '', style: 'white-space:pre' },
  ],
  parseMarkdown: {
    match: (node: { type: string }) => node.type === MERMAID_TYPE,
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value ?? '' })
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === MERMAID_TYPE,
    runner: (state, node) => {
      state.addNode('code', undefined, String(node.attrs.value ?? ''), { lang: 'mermaid', meta: null })
    },
  },
}))

let seed = 0

class MermaidNodeView implements NodeView {
  dom: HTMLElement
  private currentCode = ''

  constructor(node: ProseNode) {
    this.dom = document.createElement('div')
    this.dom.className = 'mermaid'
    this.currentCode = String(node.attrs.value ?? '')
    this.render(this.currentCode)
  }

  update(node: ProseNode): boolean {
    const newVal = String(node.attrs.value ?? '')
    if (newVal !== this.currentCode) {
      this.currentCode = newVal
      this.render(newVal)
    }
    return true
  }

  private async render(code: string): Promise<void> {
    this.dom.innerHTML = ''
    this.dom.textContent = code

    try {
      const mermaid = await loadMermaid()
      const id = `mermaid-node-${Date.now()}-${seed++}`
      const { svg } = await mermaid.render(id, code)
      this.dom.innerHTML = svg
      const svgEl = this.dom.querySelector('svg')
      if (svgEl) {
        svgEl.removeAttribute('width')
        svgEl.removeAttribute('height')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.dom.innerHTML = ''
      this.dom.appendChild(errorBlock(message))
    }
  }

  destroy(): void {
    this.dom.innerHTML = ''
  }
}

export const mermaidNodeView = $prose(() => {
  return new Plugin({
    key: new PluginKey('MILKDOWN_MERMAID_NODEVIEW'),
    props: {
      nodeViews: {
        [MERMAID_TYPE]: (node: ProseNode): NodeView => {
          return new MermaidNodeView(node)
        },
      },
    },
  })
})
