import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { visit } from 'unist-util-visit'
import { decryptField, encryptFieldVerified } from '../crypto'
import { promptForPassword, promptForSecretCreate } from '../crypto-dialog'

export const MASKED_TYPE = 'masked_field'

const MASKED_TOKEN = 'maskedField'
const MASKED_BULLETS = '••••••••••••'

// --- Syntax helpers ---------------------------------------------------------

export function validateMaskedLabel(label: string): string | null {
  if (/[\]}\\]/u.test(label)) return 'Labels may not contain ] } or \\'
  if (/[\n\r]/u.test(label)) return 'Labels may not contain line breaks'
  return null
}

/**
 * Match a complete ``!masked[...]{label="..."}`` token. Returns the parsed
 * content/label or ``null``. Labels may contain backslash-escaped quotes.
 */
export function detectMasked(text: string): { content: string; label: string } | null {
  const match = /^!masked\[([^\]]*)\](?:\{label="((?:[^"\\]|\\.)*)"\})?$/u.exec(text)
  if (!match) return null
  const label = (match[2] ?? '').replace(/\\(.)/gu, '$1')
  return { content: match[1] ?? '', label }
}

/**
 * Build the markdown for a masked field. Escapes ``"`` in the label and
 * rejects labels containing ``]``, ``}``, backslashes, or line breaks (they
 * would break the token syntax). The user-facing insert flow rejects these
 * up front via ``validateMaskedLabel``.
 */
export function renderMasked(content: string, label: string): string {
  const problem = validateMaskedLabel(label)
  if (problem) throw new Error(problem)
  return maskedFieldToMarkdown(content, label)
}

export function maskedFieldToMarkdown(content: string, label: string): string {
  const cleaned = label
    .replace(/[\]}\\]/gu, '')
    .replace(/[\n\r]+/gu, ' ')
    .replace(/"/gu, '\\"')
  const suffix = cleaned ? `{label="${cleaned}"}` : ''
  return `!masked[${content}]${suffix}`
}

// --- Micromark extension -----------------------------------------------------

const C_BANG = 33
const C_LBRACKET = 91
const C_RBRACKET = 93
const C_LBRACE = 123
const C_RBRACE = 125
const C_QUOTE = 34
const C_EQUALS = 61
const C_BACKSLASH = 92

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function micromarkExtension(): any {
  return { text: { [C_BANG]: { name: MASKED_TOKEN, tokenize: tokenizeMasked } } }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tokenizeMasked(effects: any, ok: any, nok: any) {
  return start

  function start(code: number | null) {
    if (code !== C_BANG) return nok(code)
    effects.enter(MASKED_TOKEN)
    effects.consume(code)
    return consumeLiteral('masked', afterName)
  }

  function consumeLiteral(
    literal: string,
    next: (code: number | null) => unknown,
  ): (code: number | null) => unknown {
    let index = 0
    const step: (code: number | null) => unknown = consume
    function consume(code: number | null): unknown {
      if (code === null || code !== literal.charCodeAt(index)) return nok(code)
      effects.consume(code)
      index++
      return index === literal.length ? next : step
    }
    return step
  }

  function afterName(code: number | null) {
    if (code !== C_LBRACKET) return nok(code)
    effects.consume(code)
    return cipherText
  }

  function cipherText(code: number | null) {
    if (code === null) return nok(code)
    if (code === C_RBRACKET) {
      effects.consume(code)
      return afterCipher
    }
    effects.consume(code)
    return cipherText
  }

  function afterCipher(code: number | null) {
    if (code === C_LBRACE) {
      effects.consume(code)
      return consumeLiteral('label', afterLabelEquals)
    }
    effects.exit(MASKED_TOKEN)
    return ok(code)
  }

  function afterLabelEquals(code: number | null) {
    if (code !== C_EQUALS) return nok(code)
    effects.consume(code)
    return afterLabelQuote
  }

  function afterLabelQuote(code: number | null) {
    if (code !== C_QUOTE) return nok(code)
    effects.consume(code)
    return labelText
  }

  function labelText(code: number | null) {
    if (code === null) return nok(code)
    if (code === C_BACKSLASH) {
      effects.consume(code)
      return labelEscape
    }
    if (code === C_QUOTE) {
      effects.consume(code)
      return afterLabelClose
    }
    effects.consume(code)
    return labelText
  }

  function labelEscape(code: number | null) {
    if (code === null) return nok(code)
    effects.consume(code)
    return labelText
  }

  function afterLabelClose(code: number | null) {
    if (code !== C_RBRACE) return nok(code)
    effects.consume(code)
    effects.exit(MASKED_TOKEN)
    return ok(code)
  }
}

// --- Remark plugin ------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function remarkPlugin(this: any) {
  const data = this.data()
  if (!data.micromarkExtensions) data.micromarkExtensions = []
  if (!data.fromMarkdownExtensions) data.fromMarkdownExtensions = []
  if (!data.toMarkdownExtensions) data.toMarkdownExtensions = []

  data.micromarkExtensions.push(micromarkExtension())

  data.fromMarkdownExtensions.push({
    transforms: [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tree: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        visit(tree, 'text', (node: any, index: number | undefined, parent: any) => {
          if (index === undefined || !parent) return
          const parsed = detectMasked(String(node.value ?? ''))
          if (!parsed) return
          parent.children[index] = {
            type: MASKED_TYPE,
            content: parsed.content,
            label: parsed.label,
            position: node.position,
          }
        })
      },
    ],
    enter: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [MASKED_TOKEN](this: any, token: any) {
        this.enter({ type: MASKED_TYPE, content: '', label: '' }, token)
      },
    },
    exit: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [MASKED_TOKEN](this: any, token: any) {
        const node = this.stack[this.stack.length - 1]
        if (node && node.type === MASKED_TYPE) {
          const parsed = detectMasked(this.sliceSerialize(token))
          node.content = parsed?.content ?? ''
          node.label = parsed?.label ?? ''
        }
        this.exit(token)
      },
    },
  })

  data.toMarkdownExtensions.push({
    handlers: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [MASKED_TYPE](node: any) {
        return maskedFieldToMarkdown(String(node.content ?? ''), String(node.label ?? ''))
      },
    },
  })
}

// --- Node view ----------------------------------------------------------------

class MaskedFieldNodeView implements NodeView {
  dom: HTMLElement
  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined
  private plaintext: string | null = null
  private editActive = false
  private editCancelled = false
  private awaitingPassword = false
  private destroyed = false

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement('span')
    this.dom.className = 'masked-field'
    this.dom.addEventListener('mousedown', (e) => e.preventDefault())
    this.dom.addEventListener('click', (e) => {
      e.preventDefault()
      void this.onClick()
    })
    this.dom.addEventListener('dblclick', (e) => {
      e.preventDefault()
      void this.onEditStart()
    })
    this.render()

    if (node.attrs['revealed']) {
      queueMicrotask(() => this.dropStaleReveal())
    }
  }

  private render(): void {
    const content = String(this.node.attrs.content ?? '')
    const label = String(this.node.attrs.label ?? '')
    const revealed = Boolean(this.node.attrs['revealed']) && this.plaintext !== null

    this.dom.dataset.content = content
    this.dom.dataset.label = label
    this.dom.classList.toggle('masked-field-revealed', revealed)
    this.dom.classList.toggle('masked-field-edit', this.editActive)
    this.dom.textContent = ''

    if (this.editActive && this.plaintext !== null) {
      const existing = this.dom.querySelector<HTMLInputElement>('.masked-field-input')
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'masked-field-input'
      input.value = existing?.value ?? this.plaintext
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void this.commitEdit(input.value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          this.cancelEdit()
        }
      })
      input.addEventListener('blur', () => {
        if (!this.editCancelled && !this.awaitingPassword) {
          void this.commitEdit(input.value)
        }
      })
      this.dom.appendChild(input)
      requestAnimationFrame(() => {
        input.focus()
        input.select()
      })
      return
    }

    if (revealed) {
      const value = document.createElement('span')
      value.className = 'masked-field-value'
      value.textContent = this.plaintext
      this.dom.appendChild(value)
      return
    }

    const dots = document.createElement('span')
    dots.className = 'masked-field-dots'
    dots.textContent = label ? `${MASKED_BULLETS} (${label})` : MASKED_BULLETS
    this.dom.appendChild(dots)
  }

  private async onClick(): Promise<void> {
    if (this.editActive) return
    if (this.plaintext !== null) {
      this.hide()
    } else {
      await this.unlockAndShow()
    }
  }

  private async unlockAndShow(): Promise<boolean> {
    const pos = this.getPos()
    if (pos === undefined) return false
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== MASKED_TYPE) return false
    const label = String(node.attrs.label ?? '')
    const content = String(node.attrs.content ?? '')
    const password = await promptForPassword(label || 'encrypted field', async (pw) => {
      try {
        this.plaintext = await decryptField(content, pw)
        return true
      } catch {
        this.plaintext = null
        return 'Incorrect password'
      }
    })
    if (password === null) {
      this.plaintext = null
      return false
    }
    return this.setRevealed(true)
  }

  private hide(): void {
    this.plaintext = null
    if (!this.setRevealed(false)) this.render()
  }

  private setRevealed(revealed: boolean): boolean {
    const pos = this.getPos()
    if (pos === undefined) return false
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== MASKED_TYPE) return false
    if (Boolean(node.attrs['revealed']) === revealed) return true
    const tr = this.view.state.tr
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, revealed })
    this.view.dispatch(tr)
    return true
  }

  private async onEditStart(): Promise<void> {
    if (this.editActive) return
    const pos = this.getPos()
    if (pos === undefined) return
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== MASKED_TYPE) return
    const label = String(node.attrs.label ?? '')
    const content = String(node.attrs.content ?? '')
    if (this.plaintext === null) {
      const password = await promptForPassword(label || 'encrypted field', async (pw) => {
        try {
          this.plaintext = await decryptField(content, pw)
          return true
        } catch {
          this.plaintext = null
          return 'Incorrect password'
        }
      })
      if (password === null || this.plaintext === null) return
    }
    this.editActive = true
    this.editCancelled = false
    this.render()
  }

  private async commitEdit(value: string): Promise<void> {
    if (this.editCancelled || this.awaitingPassword) return
    this.editActive = false
    this.awaitingPassword = true
    const pos = this.getPos()
    if (pos === undefined) {
      this.awaitingPassword = false
      this.render()
      return
    }
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== MASKED_TYPE) {
      this.awaitingPassword = false
      this.render()
      return
    }
    const label = String(node.attrs.label ?? '')
    const password = await promptForPassword(label || 'encrypted field')
    this.awaitingPassword = false
    if (password === null) {
      this.render()
      this.view.focus()
      return
    }
    try {
      const envelope = await encryptFieldVerified(value, password)
      this.plaintext = value
      const tr = this.view.state.tr
      tr.setNodeMarkup(pos, undefined, { content: envelope, label, revealed: true })
      this.view.dispatch(tr)
      this.view.focus()
    } catch {
      this.plaintext = null
      this.render()
      this.view.focus()
    }
  }

  private cancelEdit(): void {
    this.editCancelled = true
    this.editActive = false
    this.render()
  }

  private dropStaleReveal(): void {
    if (this.destroyed) return
    const pos = this.getPos()
    if (pos === undefined) return
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== MASKED_TYPE || !node.attrs['revealed']) return
    const tr = this.view.state.tr
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, revealed: false })
    this.view.dispatch(tr)
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== MASKED_TYPE) return false
    this.node = node
    if (!node.attrs['revealed']) this.plaintext = null
    this.render()
    return true
  }

  stopEvent(event: Event): boolean {
    return (event.target as HTMLElement).closest('.masked-field') !== null
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.destroyed = true
    this.plaintext = null
    this.dom.textContent = ''
  }
}

export const maskedFieldNodeViewPlugin = new Plugin({
  key: new PluginKey('EDI_MASKEDFIELD_NODEVIEW'),
  props: {
    nodeViews: {
      [MASKED_TYPE]: (node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        return new MaskedFieldNodeView(node, view, getPos)
      },
    },
  },
})

// --- Insert command ------------------------------------------------------------

export async function insertMaskedFieldCommand(view: EditorView): Promise<boolean> {
  const created = await promptForSecretCreate()
  if (!created) return false
  const password = await promptForPassword(created.label || 'encrypted field')
  if (password === null) return false
  try {
    const envelope = await encryptFieldVerified(created.value, password)
    const node = view.state.schema.nodes[MASKED_TYPE].create({
      content: envelope,
      label: created.label,
    })
    const { state } = view
    const { $from, $to } = state.selection
    if (!$from.sameParent($to) || !$from.parent.isTextblock) {
      view.focus()
      return false
    }
    const tr = state.tr
    tr.replaceSelectionWith(node, false)
    view.dispatch(tr)
    view.focus()
    return true
  } catch {
    return false
  }
}