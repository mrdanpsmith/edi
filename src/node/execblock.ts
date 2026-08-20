import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as ProseNode, DOMOutputSpec } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { visit } from 'unist-util-visit'
import { invoke } from '../bridge'
import type { CodeResult } from '../exec'

export const EXEC_TYPE = 'exec_block'

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

export const execSchema = {
  group: 'block',
  marks: '',
  code: true,
  attrs: {
    shebang: { default: '' },
    value: { default: '' },
    _source: { default: false },
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
  toDOM(): DOMOutputSpec {
    return ['div', { 'data-exec-block': '' }, ['div', { class: 'exec-source' }, ['code', 0]]]
  },
}

const outputCache = new Map<string, CodeResult | { error: string }>()

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

class ExecBlockNodeView implements NodeView {
  dom: HTMLElement
  private codeEl: HTMLPreElement
  private shebang: string
  private source: string
  private button: HTMLButtonElement
  private output: HTMLElement
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private node: any
  private view: EditorView
  private getPos: () => number | undefined
  private skipNextUpdate = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(node: any, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.shebang = node.attrs.shebang
    this.source = node.attrs.value

    this.dom = document.createElement('div')
    this.dom.className = 'exec-block'
    this.dom.dataset['shebang'] = this.shebang

    const pos = getPos()
    if (pos !== undefined) {
      this.dom.appendChild(createHandleDOM(pos))
    }

    this.codeEl = document.createElement('pre')
    this.codeEl.className = 'exec-source'
    const code = document.createElement('code')
    code.contentEditable = 'true'
    code.spellcheck = false
    code.textContent = this.source
    this.codeEl.append(code)

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

    this.dom.append(this.codeEl, toolbar, this.output)

    this.button.addEventListener('click', this.handleClick)
    code.addEventListener('input', this.handleInput)
    code.addEventListener('keydown', this.handleKeyDown)

    const cached = outputCache.get(this.cacheKey())
    if (cached) {
      this.showOutput(cached)
    }
  }

  private handleClick = (): void => {
    void this.run()
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    e.stopPropagation()
  }

  private handleInput = (): void => {
    const code = this.codeEl.querySelector('code')
    if (!code) return
    this.source = code.textContent ?? ''
    this.node = { ...this.node, attrs: { ...this.node.attrs, value: this.source } }
    this.skipNextUpdate = true
    const pos = this.getPos()
    if (pos !== undefined) {
      const tr = this.view.state.tr.setNodeAttribute(pos, 'value', this.source)
      this.view.dispatch(tr)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(node: any): boolean {
    if (this.skipNextUpdate) {
      this.skipNextUpdate = false
      return true
    }
    if (node.attrs.value !== this.source || node.attrs.shebang !== this.shebang) {
      this.node = node
      this.shebang = node.attrs.shebang
      this.source = node.attrs.value
      this.dom.dataset['shebang'] = this.shebang
      const code = this.codeEl.querySelector('code')
      if (code) code.textContent = this.source
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
    const code = this.codeEl.querySelector('code')
    if (code) {
      code.removeEventListener('input', this.handleInput)
      code.removeEventListener('keydown', this.handleKeyDown)
    }
  }
}

export const execNodeViewPlugin = new Plugin({
  key: new PluginKey('EDI_EXEC_NODEVIEW'),
  props: {
    nodeViews: {
      [EXEC_TYPE]: (node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        return new ExecBlockNodeView(node, view, getPos)
      },
    },
  },
})
