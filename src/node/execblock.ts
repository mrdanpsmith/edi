import { $nodeSchema, $prose, $remark } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { Node as ProseNode, DOMOutputSpec } from '@milkdown/prose/model'
import type { NodeView } from '@milkdown/prose/view'
import { visit } from 'unist-util-visit'
import { invoke } from '../bridge'
import type { CodeResult } from '../exec'

const EXEC_TYPE = 'exec_block'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function remarkExecPlugin(this: any) {
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
          if (index === undefined) return
          const lang = String(node.lang ?? '').trim()
          const value = String(node.value ?? '')
          const firstLine = value.split('\n', 1)[0] ?? ''
          const shebang = lang.startsWith('#!') ? lang : firstLine.startsWith('#!') ? firstLine : null
          if (shebang) {
            parent.children[index] = {
              type: EXEC_TYPE,
              shebang,
              value,
              position: node.position,
            }
          }
        })
      },
    ],
  })

  data.toMarkdownExtensions.push({
    handlers: {
      [EXEC_TYPE]: (
        node: { shebang?: string; value?: string },
        _: unknown,
        state: { enter: (t: string) => () => void },
        info: unknown,
      ) => {
        const exit = state.enter('code')
        void info
        exit()
        const shebang = node.shebang ?? ''
        const value = node.value ?? ''
        const isInline = value.startsWith(shebang)
        if (isInline) {
          return `\`\`\`\n${value}\n\`\`\`\n`
        }
        return `\`\`\`${shebang}\n${value}\n\`\`\`\n`
      },
    },
  })
}

export const execRemark = $remark('remarkExec', () => remarkExecPlugin)
export { remarkExecPlugin as rawExecRemarkPlugin }

export const execSchema = $nodeSchema(EXEC_TYPE as never, () => ({
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  attrs: {
    shebang: { default: '' },
    value: { default: '' },
  },
  parseDOM: [
    {
      tag: 'div[data-exec-block]',
      getAttrs: (dom: HTMLElement) => ({
        shebang: dom.dataset['shebang'] ?? '',
        value: dom.querySelector<HTMLElement>('.exec-source code')?.textContent ?? '',
      }),
    },
  ],
  toDOM: (): DOMOutputSpec => [
    'div',
    { 'data-exec-block': '' },
    ['div', { class: 'exec-source' }, ['code', 0]],
  ],
  parseMarkdown: {
    match: (node: { type: string }) => node.type === EXEC_TYPE,
    runner: (state, node, type) => {
      state.addNode(type, { shebang: String(node.shebang ?? ''), value: String(node.value ?? '') })
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === EXEC_TYPE,
    runner: (state, node) => {
      const shebang = String(node.attrs.shebang)
      const value = String(node.attrs.value)
      const isInline = value.startsWith(shebang)
      if (isInline) {
        state.addNode('code', undefined, value)
      } else {
        state.addNode('code', undefined, value, { lang: shebang, meta: null })
      }
    },
  },
}))

const outputCache = new Map<string, CodeResult | { error: string }>()

class ExecBlockNodeView implements NodeView {
  dom: HTMLElement
  private shebang: string
  private source: string
  private button: HTMLButtonElement
  private output: HTMLElement
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private node: any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(node: any) {
    this.node = node
    this.shebang = node.attrs.shebang
    this.source = node.attrs.value

    this.dom = document.createElement('div')
    this.dom.className = 'exec-block'
    this.dom.dataset['shebang'] = this.shebang

    const pre = document.createElement('pre')
    pre.className = 'exec-source'
    const code = document.createElement('code')
    code.textContent = this.source
    pre.append(code)

    const toolbar = document.createElement('div')
    toolbar.className = 'exec-toolbar'
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'exec-run'
    this.button.textContent = 'Run'
    toolbar.append(this.button)

    this.output = document.createElement('pre')
    this.output.className = 'exec-output'
    this.output.hidden = true

    this.dom.append(pre, toolbar, this.output)

    this.button.addEventListener('click', this.handleClick)

    const cached = outputCache.get(this.cacheKey())
    if (cached) {
      this.showOutput(cached)
    }
  }

  private handleClick = (): void => {
    void this.run()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(node: any): boolean {
    if (node.attrs.value !== this.node?.attrs?.value || node.attrs.shebang !== this.node?.attrs?.shebang) {
      this.node = node
      this.shebang = node.attrs.shebang
      this.source = node.attrs.value
      this.dom.dataset['shebang'] = this.shebang
      this.dom.querySelector<HTMLElement>('.exec-source code')!.textContent = this.source
    }
    return true
  }

  private cacheKey(): string {
    return `${this.shebang}\u0000${this.source}`
  }

  private async run(): Promise<void> {
    this.button.disabled = true
    this.button.textContent = 'Running…'
    this.output.hidden = false
    this.output.textContent = ''
    this.output.classList.remove('exec-error')
    const key = this.cacheKey()
    try {
      const result = await invoke<CodeResult>('runCodeBlock', { shebang: this.shebang, source: this.source })
      outputCache.set(key, result)
      this.showOutput(result)
    } catch (error) {
      const cached = { error: error instanceof Error ? error.message : String(error) }
      outputCache.set(key, cached)
      this.showOutput(cached)
    } finally {
      this.button.disabled = false
      this.button.textContent = 'Run'
    }
  }

  private showOutput(cached: CodeResult | { error: string }): void {
    const lines: string[] = []
    if ('error' in cached) {
      lines.push(`Error: ${cached.error}`)
    } else {
      if (cached.stdout) lines.push(cached.stdout.replace(/\s+$/, ''))
      if (cached.stderr) lines.push(cached.stderr.replace(/\s+$/, ''))
      if (cached.timedOut) lines.push('Execution timed out after 30 seconds')
      if (cached.exitCode && cached.exitCode !== 0) lines.push(`Process exited with code ${cached.exitCode}`)
    }
    this.output.textContent = lines.join('\n')
    this.output.classList.toggle('exec-error', 'error' in cached || (!('error' in cached) && (cached as CodeResult).exitCode !== 0))
  }

  destroy(): void {
    this.button.removeEventListener('click', this.handleClick)
  }
}

export const execNodeView = $prose(() => {
  return new Plugin({
    key: new PluginKey('MILKDOWN_EXEC_NODEVIEW'),
    props: {
      nodeViews: {
        [EXEC_TYPE]: (node: ProseNode): NodeView => {
          return new ExecBlockNodeView(node)
        },
      },
    },
  })
})
