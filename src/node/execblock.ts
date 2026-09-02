import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { blockNodeView } from '../blockview'
import { invoke } from '../bridge'
import type { CodeResult } from '../exec'

// A runnable code block is an ordinary `code_block` whose first line starts
// with `#!`. This node view renders the standard code block and, for such
// blocks, adds a Run button and an output area. Editing stays fully native
// because the view exposes the `<code>` element as its contentDOM.

function shebangOf(text: string): string | null {
  const line = text.split('\n', 1)[0] ?? ''
  return line.startsWith('#!') ? line : null
}

function sourceOf(text: string, shebang: string): string {
  return text.slice(shebang.length).replace(/^\n/, '')
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

class RunnableBlockNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private node: ProseNode
  private runButton: HTMLButtonElement | null = null
  private output: HTMLPreElement | null = null
  private controlsLayer: HTMLElement | null = null
  private shebang: string | null

  constructor(node: ProseNode, _view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.shebang = shebangOf(node.textContent)

    this.dom = document.createElement('div')
    this.dom.className = 'runnable-block'

    const pos = getPos()
    if (pos !== undefined) {
      this.dom.appendChild(createHandleDOM(pos))
    }

    const pre = document.createElement('pre')
    pre.className = 'runnable-source'
    const code = document.createElement('code')
    const lang = String(node.attrs.language ?? '')
    if (lang && !lang.startsWith('#')) code.className = `language-${lang}`
    this.contentDOM = code
    pre.appendChild(code)
    this.dom.appendChild(pre)

    if (this.shebang) this.buildControls(this.shebang)
  }

  private buildControls(shebang: string): void {
    const layer = document.createElement('div')
    layer.className = 'runnable-controls'
    this.controlsLayer = layer

    const toolbar = document.createElement('div')
    toolbar.className = 'exec-toolbar'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'exec-run'
    button.textContent = 'Run'
    toolbar.appendChild(button)
    this.runButton = button

    const output = document.createElement('pre')
    output.className = 'exec-output'
    output.hidden = true
    this.output = output

    layer.append(toolbar, output)
    this.dom.appendChild(layer)

    button.addEventListener('click', () => {
      void this.run(shebang)
    })

    const cached = outputCache.get(this.cacheKey(shebang))
    if (cached) this.showOutput(cached)
  }

  private clearControls(): void {
    if (this.controlsLayer) this.controlsLayer.remove()
    this.controlsLayer = null
    this.runButton = null
    this.output = null
  }

  private cacheKey(shebang: string): string {
    return `${shebang}\u0000${sourceOf(this.node.textContent, shebang)}`
  }

  private async run(shebang: string): Promise<void> {
    if (!this.runButton || !this.output) return
    const source = sourceOf(this.node.textContent, shebang)
    this.runButton.disabled = true
    this.runButton.textContent = 'Running…'
    this.output.hidden = false
    this.output.textContent = ''
    this.output.classList.remove('exec-error')
    const key = this.cacheKey(shebang)
    try {
      const result = await invoke<CodeResult>('runCodeBlock', { shebang, source })
      outputCache.set(key, result)
      this.showOutput(result)
    } catch (error) {
      const cached = { error: error instanceof Error ? error.message : String(error) }
      outputCache.set(key, cached)
      this.showOutput(cached)
    } finally {
      if (this.runButton) {
        this.runButton.disabled = false
        this.runButton.textContent = 'Run'
      }
    }
  }

  private showOutput(cached: CodeResult | { error: string }): void {
    const out = this.output
    if (!out) return
    const lines: string[] = []
    if ('error' in cached) {
      lines.push(`Error: ${cached.error}`)
    } else {
      if (cached.stdout) lines.push(cached.stdout.replace(/\s+$/, ''))
      if (cached.stderr) lines.push(cached.stderr.replace(/\s+$/, ''))
      if (cached.timedOut) lines.push('Execution timed out after 30 seconds')
      if (cached.exitCode && cached.exitCode !== 0) lines.push(`Process exited with code ${cached.exitCode}`)
    }
    out.textContent = lines.join('\n')
    out.classList.toggle(
      'exec-error',
      'error' in cached || (!('error' in cached) && (cached as CodeResult).exitCode !== 0),
    )
  }

  update(node: ProseNode): boolean {
    if (node.attrs['_source'] !== this.node.attrs['_source']) return false
    this.node = node
    const newShebang = shebangOf(node.textContent)
    if (newShebang !== this.shebang) {
      this.clearControls()
      this.shebang = newShebang
      if (newShebang) this.buildControls(newShebang)
    }
    return true
  }

  getContentDOM(): { dom: HTMLElement; contentDOM: HTMLElement } {
    return { dom: this.dom, contentDOM: this.contentDOM }
  }

  ignoreMutation(mutation: unknown): boolean {
    // Only content edits to the `<code>` element matter to ProseMirror. Our own
    // UI mutations (Run button text/disabled, unhiding/filling the output, the
    // block handle) live outside the contentDOM; if PM treats them as external
    // edits it remounts the view and wipes the transient output before the
    // async run resolves.
    return this.contentDOM === null || !this.contentDOM.contains(
      (mutation as { target: Node }).target,
    )
  }

  stopEvent(event: Event): boolean {
    const t = event.target as HTMLElement
    return t.closest('.exec-run') !== null || t.closest('.block-handle') !== null
  }

  destroy(): void {
    this.clearControls()
  }
}

export function isRunnableCodeBlock(node: ProseNode): boolean {
  return node.type.name === 'code_block' && shebangOf(node.textContent) !== null
}

export const codeBlockNodeViewPlugin = new Plugin({
  key: new PluginKey('EDI_CODEBLOCK_NODEVIEW'),
  props: {
    nodeViews: {
      code_block(node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView {
        if (node.attrs['_source']) {
          return blockNodeView(node, view, getPos) as unknown as NodeView
        }
        return new RunnableBlockNodeView(node, view, getPos)
      },
    },
  },
})
