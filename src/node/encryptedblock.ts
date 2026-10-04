/**
 * Encrypted block node view. A collapsed card shows the block's visible
 * metadata (its original type and optional label) and offers View / Edit /
 * Unmask. Plaintext is only ever rendered transiently: View and Edit keep the
 * document's markdown source free of decrypted text.
 */
import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import { EditorView, type NodeView } from 'prosemirror-view'
import { decryptField, encryptFieldVerified } from '../crypto'
import { promptForPassword } from '../crypto-dialog'
import { confirmAction } from '../bridge'
import { markdownToProse } from '../markdown'
import { createBlockEditor } from '../editor'
import { blockNodeView } from '../blockview'
import type { ResolveImage } from '../image'

let imageResolver: ResolveImage | undefined
export function setEncryptedBlockImageResolver(fn: ResolveImage | undefined): void {
  imageResolver = fn
}

let pendingUnlockPassword: string | null = null
export function primeEncryptedBlockShow(password: string): void {
  pendingUnlockPassword = password
}

interface EncryptedBlockAttrs {
  type: string
  label: string
  content: string
  _source: boolean | undefined
}

function getAttrs(node: ProseNode): EncryptedBlockAttrs {
  return {
    type: String(node.attrs.type ?? ''),
    label: String(node.attrs.label ?? ''),
    content: String(node.attrs.content ?? ''),
    _source: node.attrs._source as boolean | undefined,
  }
}

class EncryptedBlockNodeView implements NodeView {
  dom: HTMLElement
  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined
  private revealHost: HTMLDivElement | null = null
  private revealEditor: EditorView | null = null
  private revealInner: ReturnType<typeof createBlockEditor> | null = null
  private revealPassword: string | null = null
  private lastRevealedMd: string | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private toggleBtn: HTMLButtonElement | null = null
  private wordsEl: HTMLSpanElement | null = null

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.dom = document.createElement('div')
    this.dom.className = 'encrypted-block'
    const pos = getPos()
    if (pos !== undefined) {
      const $pos = view.state.doc.resolve(pos)
      if ($pos.parent.type.name === 'doc') {
        const handle = document.createElement('div')
        handle.className = 'block-handle'
        handle.setAttribute('data-block-pos', String(pos))
        this.dom.appendChild(handle)
      }
    }
    this.render()
  }

  update(node: ProseNode): boolean {
    const attrs = getAttrs(node)
    if (attrs._source) return false
    const structuralChange =
      node.attrs.content !== this.node.attrs.content ||
      node.attrs.label !== this.node.attrs.label ||
      node.attrs.type !== this.node.attrs.type
    this.node = node
    // Re-rendering (which rebuilds the whole shell) while a reveal is open
    // would hide it; content-only updates (including our own persist) keep
    // the reveal in place and just rely on the transient editor staying in
    // sync. Rebuild the pill text only when the block was truly re-labeled.
    if (!this.revealHost && structuralChange) {
      this.render()
    }
    if (this.revealHost && this.wordsEl) {
      const a = getAttrs(node)
      this.wordsEl.textContent = `🔒 encrypted · ${a.type || 'block'}${a.label ? ' · ' + a.label : ''}`
      if (this.toggleBtn) this.toggleBtn.textContent = 'Lock ▾'
    }
    return true
  }

  destroy(): void {
    this.destroyTransient()
  }

  private destroyTransient(): void {
    this.revealEditor?.destroy()
    this.revealEditor = null
    this.revealHost = null
  }

  private closeReveal(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      void this.persist()
    }
    this.revealEditor?.destroy()
    this.revealEditor = null
    this.revealInner = null
    this.revealPassword = null
    this.revealHost?.remove()
    this.revealHost = null
    if (this.toggleBtn) this.toggleBtn.textContent = 'Unlock ▸'
    if (this.wordsEl) {
      const a = getAttrs(this.node)
      this.wordsEl.textContent = `🔒 encrypted · ${a.type || 'block'}${a.label ? ' · ' + a.label : ''}`
    }
  }

  private render(): void {
    const attrs = getAttrs(this.node)
    this.dom.innerHTML = ''
    const pill = document.createElement('div')
    pill.className = 'encrypted-block-pill'

    const words = document.createElement('span')
    words.className = 'encrypted-block-label'
    words.textContent = `🔒 encrypted · ${attrs.type || 'block'}${attrs.label ? ' · ' + attrs.label : ''}`
    this.wordsEl = words
    pill.appendChild(words)

    const actions = document.createElement('span')
    actions.className = 'encrypted-block-actions'
    const makeBtn = (text: string, cls: string, run: () => void, title?: string): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `toolbar-btn ${cls}`
      btn.textContent = text
      if (title) btn.title = title
      btn.addEventListener('mousedown', (e) => e.preventDefault())
      btn.addEventListener('click', (e) => { e.stopPropagation(); run() })
      actions.appendChild(btn)
      return btn
    }
    makeBtn('Normalize', 'encrypted-block-unmask', () => { void this.unmask_() }, 'Convert to normal block (decrypted)')
    this.toggleBtn = makeBtn('Unlock ▸', 'encrypted-block-toggle', () => { void this.toggleShow_() })
    pill.appendChild(actions)
    this.dom.appendChild(pill)
  }

  /** Show: render the decrypted markdown inline, editable; never into the document. */
  private async toggleShow_(): Promise<void> {
    if (this.revealHost) {
      this.closeReveal()
      return
    }
    const primed = pendingUnlockPassword
    pendingUnlockPassword = null
    const password = primed ?? await promptForPassword(getAttrs(this.node).label || 'encrypted block', undefined, { title: 'Show encrypted block' })
    if (password === null) return
    let plaintext: string
    try {
      plaintext = await decryptField(getAttrs(this.node).content, password)
    } catch {
      return
    }
    this.closeReveal()
    const host = document.createElement('div')
    host.className = 'encrypted-block-reveal'
    this.dom.appendChild(host)
    this.revealHost = host
    this.revealPassword = password
    this.lastRevealedMd = plaintext
    this.revealInner = createBlockEditor(host, plaintext, {
      resolveImageSrc: imageResolver,
      onChange: () => this.schedulePersist(),
    })
    this.revealEditor = this.revealInner.getView()
    this.revealEditor.dom.classList.add('encrypted-block-reveal-editor')
    if (this.toggleBtn) this.toggleBtn.textContent = 'Lock ▾'
    if (this.wordsEl) {
      const a = getAttrs(this.node)
      this.wordsEl.textContent = `🔒 encrypted · ${a.type || 'block'}${a.label ? ' · ' + a.label : ''}`
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => { void this.persist() }, 600)
  }

  private async persist(): Promise<void> {
    if (!this.revealPassword || !this.revealInner) return
    const markdown = this.revealInner.getMarkdown()
    if (markdown === this.lastRevealedMd) return
    const a = getAttrs(this.node)
    try {
      const envelope = await encryptFieldVerified(markdown, this.revealPassword)
      const pos = this.getPos()
      if (pos !== undefined) {
        const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { type: a.type, label: a.label, content: envelope })
        this.view.dispatch(tr)
        this.lastRevealedMd = markdown
      }
    } catch {
      /* drop: a corrupt write would strand the user's content */
    }
  }

  stopEvent(event: Event): boolean {
    const t = event.target
    if (!(t instanceof Element)) return false
    return t.closest('.encrypted-block-reveal, .encrypted-block-show') !== null
  }

  ignoreMutation(): boolean {
    return true
  }

  /** Decrypt block: decrypt and replace the block with its real content. */
  private async unmask_(): Promise<void> {
    const attrs = getAttrs(this.node)
    if (!attrs.content) return
    const password = await promptForPassword(attrs.label || 'encrypted block', undefined, { title: 'Decrypt block' })
    if (password === null) return
    let plaintext: string
    try {
      plaintext = await decryptField(attrs.content, password)
    } catch {
      return
    }
    const ok = await confirmAction('This replaces the encrypted block with its decrypted contents. Undo can reverse this.')
    if (!ok) return
    const doc = markdownToProse(plaintext, this.view.state.schema)
    const pos = this.getPos()
    if (pos === undefined) return
    const fragment = doc.content
    const tr = this.view.state.tr.replaceWith(pos, pos + this.node.nodeSize, fragment.childCount === 1 ? fragment.firstChild! : fragment)
    this.view.dispatch(tr)
    this.view.focus()
  }
}

export const encryptedBlockNodeViewPlugin = new Plugin({
  key: new PluginKey('EDI_ENCRYPTED_BLOCK_NODEVIEW'),
  props: {
    nodeViews: {
      encrypted_block: (node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        if (node.attrs._source) {
          return blockNodeView(node, view, getPos) as NodeView
        }
        return new EncryptedBlockNodeView(node, view, getPos)
      },
    },
  },
})
