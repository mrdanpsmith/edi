import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { blockNodeView } from '../blockview'
import { hasBridge, invoke, invokeStream, type StreamHandle } from '../bridge'
import type { CodeResult } from '../exec'
import { createCodeEditor, type BlockCodeMirror } from '../codemirror-block'
import { codeLanguageFor, shebangLanguage } from '../codeLanguages'
import { collectFormulaBlocks, formulaDefsKey, subscribeFormulaEnv } from '../formulaDefs'
import { buildDocumentFunctions, countDefinitions, type FormulaDefIssue } from '../formulaDsl'

// A runnable code block is an ordinary `code_block` whose first line starts
// with `#!`. Code blocks whose language tag (or shebang) resolves to a code
// grammar render their content in an embedded CodeMirror editor so they get
// syntax highlighting while typing; everything else keeps the plain native
// `<pre><code>` contenteditable. Runnable blocks add a Run button and an
// output area in both renderers.

function shebangOf(text: string): string | null {
  const line = text.split('\n', 1)[0] ?? ''
  return line.startsWith('#!') ? line : null
}

function sourceOf(text: string, shebang: string): string {
  return text.slice(shebang.length).replace(/^\n/, '')
}

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

async function copyPlainText(text: string): Promise<void> {
  if (hasBridge()) {
    try {
      await invoke('copyText', { text })
      return
    } catch {
      // Fall through to the web/execCommand paths.
    }
  }
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Fall through to the legacy execCommand path.
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function createCopyButton(
  getText: () => string,
  root: HTMLElement,
  revealSelector: string,
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'code-copy'
  btn.title = 'Copy to clipboard'
  btn.textContent = 'Copy'
  // Keep the caret out of the button's label and stop the editor from treating
  // the click as a selection change.
  btn.addEventListener('mousedown', (e) => e.preventDefault())

  // Visibility is JS-driven instead of CSS `:hover` so that, after a copy, the
  // button stays hidden (even while the cursor is still over the area) until the
  // user leaves and hovers the copiable area again. `elementFromPoint` lets us
  // tell source from output even though the button floats over the source.
  let locked = false
  let x = 0
  let y = 0
  const refresh = (): void => {
    if (locked) return
    const under = document.elementFromPoint(x, y)
    const over =
      under instanceof Element &&
      (under === btn || !!under.closest(revealSelector))
    btn.classList.toggle('code-copy-show', over)
  }
  root.addEventListener('mousemove', (e) => {
    x = e.clientX
    y = e.clientY
    refresh()
  })
  root.addEventListener('mouseleave', () => btn.classList.remove('code-copy-show'))

  btn.addEventListener('click', () => {
    void copyPlainText(getText()).then(() => {
      btn.textContent = 'Copied!'
      btn.classList.add('code-copy-fade')
      btn.classList.remove('code-copy-show')
      locked = true
      window.setTimeout(() => {
        btn.classList.remove('code-copy-fade')
        btn.textContent = 'Copy'
        locked = false
      }, 500)
    })
  })
  return btn
}

/** Issues reported against one `edi-formula` block, resolved through the
 * document-wide compiled state (so a call into another block validates). */
function formulaIssuesForBlock(state: EditorState, pos: number): FormulaDefIssue[] {
  const blocks = collectFormulaBlocks(state.doc)
  const index = blocks.findIndex((block) => block.from === pos)
  if (index < 0) return []
  const value = formulaDefsKey.getState(state)
  const issues = value
    ? value.issues
    : buildDocumentFunctions(blocks.map((block) => block.source)).issues
  return issues.filter((issue) => issue.sourceIndex === index)
}

class RunnableBlockNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement | null = null
  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined
  private editor: BlockCodeMirror | null = null
  private editorBusy = false
  private sourceHost: HTMLElement | null = null
  private langBar: HTMLElement | null = null
  private formulaErrors: HTMLElement | null = null
  private unsubscribeEnv: (() => void) | null = null
  private runButton: HTMLButtonElement | null = null
  private output: HTMLPreElement | null = null
  private outputCopy: HTMLButtonElement | null = null
  private controlsLayer: HTMLElement | null = null
  private shebang: string | null
  private lastContent: string
  private running = false
  private activeHandle: StreamHandle<CodeResult> | null = null
  private runStopped = false
  private runEpoch = 0
  private sawErrorOutput = false

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.shebang = shebangOf(node.textContent)
    this.lastContent = node.textContent

    this.dom = document.createElement('div')
    this.dom.className = 'runnable-block'

    const pos = getPos()
    if (pos !== undefined) {
      this.dom.appendChild(createHandleDOM(pos))
    }

    const langTag = String(node.attrs.language ?? '').trim()
    const info = codeLanguageFor(langTag || null, node.textContent)
    const badge =
      langTag ||
      (info?.formula ? info.label : '') ||
      (this.shebang ? shebangLanguage(this.shebang) ?? '' : '')
    if (badge) {
      this.langBar = document.createElement('div')
      this.langBar.className = 'code-lang-bar'
      this.langBar.setAttribute('data-language', badge)
      const label = document.createElement('span')
      label.className = 'code-lang-badge'
      label.textContent = badge
      this.langBar.appendChild(label)
      this.dom.appendChild(this.langBar)
      this.dom.classList.add('has-code-lang')
    }

    if (info) {
      const host = document.createElement('div')
      host.className = 'code-editor-host'
      this.sourceHost = host
      this.editor = createCodeEditor(host, node.textContent, info.extension, (value) => {
        this.commitEditorText(value)
      })
      this.dom.appendChild(host)
    } else {
      const pre = document.createElement('pre')
      pre.className = 'runnable-source'
      const code = document.createElement('code')
      if (langTag && !langTag.startsWith('#')) code.className = `language-${langTag}`
      this.contentDOM = code
      pre.appendChild(code)
      this.sourceHost = pre
      this.dom.appendChild(pre)
    }

    this.appendSourceCopyButton()

    if (this.shebang) this.buildControls(this.shebang)
    if (info?.formula) this.buildFormulaStatus()
  }

  /** Keep the ProseMirror document in lock-step with the embedded editor.
   * Runs while `editorBusy` is set only when a PM-side change is being
   * mirrored back into CodeMirror, so it never echoes its own dispatch. */
  private commitEditorText(value: string): void {
    if (this.editorBusy) return
    if (value === this.node.textContent) return
    const pos = this.getPos()
    if (pos === undefined) return
    const newNode = this.node.type.create(this.node.attrs, this.node.type.schema.text(value))
    this.view.dispatch(
      this.view.state.tr
        .replaceWith(pos, pos + this.node.nodeSize, newNode)
        .setMeta('addToHistory', true),
    )
  }

  private buildFormulaStatus(): void {
    this.formulaErrors = document.createElement('div')
    this.formulaErrors.className = 'formula-errors'
    this.dom.appendChild(this.formulaErrors)
    this.unsubscribeEnv = subscribeFormulaEnv(this.view, () => this.renderFormulaStatus())
    this.renderFormulaStatus()
  }

  private renderFormulaStatus(): void {
    const errors = this.formulaErrors
    if (!errors) return
    const pos = this.getPos()
    const issues = pos === undefined ? [] : formulaIssuesForBlock(this.view.state, pos)
    if (this.langBar) {
      const badge = this.langBar.querySelector('.code-lang-badge')
      if (badge) {
        const count = countDefinitions(this.node.textContent)
        const parts = ['edi-formula']
        if (count > 0) parts.push(`${count} ${count === 1 ? 'function' : 'functions'}`)
        if (issues.length > 0) parts.push(`${issues.length} ${issues.length === 1 ? 'error' : 'errors'}`)
        badge.textContent = parts.join(' · ')
        this.dom.classList.toggle('edi-formula-invalid', issues.length > 0)
      }
    }
    errors.replaceChildren()
    for (const issue of issues) {
      const row = document.createElement('div')
      row.className = 'formula-error-row'
      row.textContent = `line ${issue.line}: ${issue.message}`
      errors.appendChild(row)
    }
    errors.hidden = issues.length === 0
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
    // Keep the caret out of the button's label. Clicking a <button> natively
    // places the text cursor inside its text; that must not happen when toggling
    // a run. preventDefault on mousedown stops the button from taking the caret
    // (and focus) while allowing the click handler below to still fire.
    button.addEventListener('mousedown', (e) => e.preventDefault())
    toolbar.appendChild(button)
    this.runButton = button

    const output = document.createElement('pre')
    output.className = 'exec-output'
    output.hidden = true
    this.output = output

    const outputWrap = document.createElement('div')
    outputWrap.className = 'exec-output-wrap'
    this.outputCopy = createCopyButton(() => output.textContent ?? '', this.dom, '.exec-output-wrap')
    outputWrap.append(output, this.outputCopy)
    this.outputCopy.style.display = 'none'

    layer.append(toolbar, outputWrap)
    this.dom.appendChild(layer)

    button.addEventListener('click', () => {
      if (this.running) {
        void this.stopRun()
      } else {
        void this.run(shebang)
      }
    })
  }

  private appendSourceCopyButton(): void {
    const source = this.sourceHost
    if (!source) return
    source.classList.add('source-has-copy')
    const btn = createCopyButton(() => this.node.textContent, this.dom, '.runnable-source, .code-editor-host')
    btn.classList.add('code-copy-source')
    this.dom.appendChild(btn)
  }

  private clearControls(): void {
    // Cancelling a run here (as opposed to just disposing the handle) is what
    // stops the backend process. When a run is in flight and the view is
    // rebuilt — a tab switch, a document swap, or an edit to the block's body
    // via `update()` — ProseMirror reuses/replaces the node view and calls this.
    // If we only disposed the JS stream handle, `stopCodeBlock` would never be
    // sent and the child process would keep running in the background, letting
    // repeated switches pile up orphaned processes.
    if (this.running && this.activeHandle) {
      void this.stopRun()
    }
    this.running = false
    this.runEpoch++
    this.activeHandle?.dispose()
    this.activeHandle = null
    if (this.controlsLayer) this.controlsLayer.remove()
    this.controlsLayer = null
    this.runButton = null
    this.output = null
    this.outputCopy = null
  }

  private setRunState(running: boolean): void {
    const button = this.runButton
    if (!button) return
    this.running = running
    button.disabled = false
    button.textContent = running ? 'Stop' : 'Run'
    button.classList.toggle('exec-stop', running)
  }

  private async run(shebang: string): Promise<void> {
    if (!this.runButton || !this.output || this.running) return
    // If the controls are rebuilt (tab switch, document swap, editing the body)
    // while this run is in flight, the result of a stale run must never be
    // published onto the newly rebuilt UI. We snapshot the current epoch and
    // drop the result if it no longer matches when the run resolves. ProseMirror
    // reuses this node view across such swaps, so without this guard the old
    // run's output would land on the new document's fresh result cell.
    const epoch = this.runEpoch
    const source = sourceOf(this.node.textContent, shebang)
    this.runStopped = false
    this.sawErrorOutput = false
    this.output.hidden = false
    this.output.textContent = ''
    this.output.classList.remove('exec-error')
    if (this.outputCopy) this.outputCopy.style.display = ''
    this.setRunState(true)
    let handle: StreamHandle<CodeResult> | null = null
    try {
      handle = invokeStream<CodeResult>('streamCodeBlock', { shebang, source })
      // capture before `await` so Stop knows the live handle
      this.activeHandle = handle
      handle.onChunk((event) => {
        if (!this.output || epoch !== this.runEpoch) return
        if (event.kind === 'output' && event.text) {
          this.output.textContent += event.text
          if (event.stream === 'stderr') {
            this.sawErrorOutput = true
            this.output.classList.add('exec-error')
          }
        }
      })
      const result = await handle.result
      if (epoch !== this.runEpoch) return
      this.showOutput(this.runStopped ? ({ stopped: true } as CodeResult) : result)
    } catch (error) {
      if (epoch !== this.runEpoch) return
      this.showOutput({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (handle) {
        handle.dispose()
        if (this.activeHandle === handle) this.activeHandle = null
      }
      if (epoch === this.runEpoch) this.setRunState(false)
    }
  }

  private async stopRun(): Promise<void> {
    const handle = this.activeHandle
    if (!handle || !this.running) return
    this.runStopped = true
    try {
      await invoke('stopCodeBlock', { id: handle.id })
    } catch {
      // The run may have already finished; that's fine.
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
      if ((cached as CodeResult).stopped) lines.push('Process stopped')
      if (cached.exitCode && cached.exitCode !== 0) lines.push(`Process exited with code ${cached.exitCode}`)
    }
    out.textContent = lines.join('\n')
    out.classList.toggle(
      'exec-error',
      'error' in cached ||
        this.sawErrorOutput ||
        (!('error' in cached) && (cached as CodeResult).exitCode !== 0),
    )
  }

  update(node: ProseNode): boolean {
    if (node.attrs['_source'] !== this.node.attrs['_source']) return false
    // A change to the language tag can swap the grammar, the badge, or the
    // code/plaintext renderer — rebuild from scratch rather than reconcile.
    if (node.attrs.language !== this.node.attrs.language) return false
    this.node = node
    const newShebang = shebangOf(node.textContent)
    // Rebuild the controls/output whenever the block's text changes, not just
    // when the shebang line changes. ProseMirror reuses this node view across
    // updates at the same position (including whole-document swaps when tabs
    // switch), so a different body must not inherit the previous block's
    // result cell — fresh code always starts with no output.
    if (node.textContent !== this.lastContent) {
      this.lastContent = node.textContent
      this.clearControls()
      this.shebang = newShebang
      if (this.editor) {
        const current = this.editor.getValue()
        if (current !== node.textContent) {
          // PM-side change (undo, a swap, or a formatting command): mirror it
          // into the embedded editor without echo-dispatching back.
          this.editorBusy = true
          this.editor.setDoc(node.textContent)
          this.editorBusy = false
        }
      }
      if (newShebang) this.buildControls(newShebang)
    }
    if (this.formulaErrors) this.renderFormulaStatus()
    return true
  }

  getContentDOM(): { dom: HTMLElement; contentDOM?: HTMLElement } {
    return { dom: this.dom, contentDOM: this.contentDOM ?? undefined }
  }

  ignoreMutation(mutation: unknown): boolean {
    const target = (mutation as { target: Node }).target
    // CM-backed blocks manage their own DOM completely — CodeMirror mutates it
    // on every keystroke and ProseMirror must never try to reconcile it.
    if (this.editor) return true
    // Only content edits to the `<code>` element matter to ProseMirror. Our own
    // UI mutations (Run button text/disabled, unhiding/filling the output, the
    // block handle) live outside the contentDOM; if PM treats them as external
    // edits it remounts the view and wipes the transient output before the
    // async run resolves.
    return this.contentDOM === null || !this.contentDOM.contains(target)
  }

  stopEvent(event: Event): boolean {
    const t = event.target
    if (!(t instanceof Element)) return false
    return (
      t.closest('.exec-run') !== null ||
      t.closest('.block-handle') !== null ||
      t.closest('.code-copy') !== null ||
      t.closest('.cm-editor') !== null
    )
  }

  destroy(): void {
    this.unsubscribeEnv?.()
    // clearControls stops any in-flight run (sends stopCodeBlock to kill the
    // backend process) and tears the DOM down.
    this.clearControls()
    this.editor?.destroy()
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
