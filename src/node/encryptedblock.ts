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
import { blockNodeView, showsSource } from '../blockview'
import { attachBlockControls } from '../block-modes'
import type { ResolveImage } from '../image'

let imageResolver: ResolveImage | undefined
export function setEncryptedBlockImageResolver(fn: ResolveImage | undefined): void {
  imageResolver = fn
}

let pendingUnlockPassword: string | null = null

let activeRevealView: EditorView | null = null

/** The editor view of the focused encrypted-block reveal, if any. Toolbar
 * commands target this instead of the collapsing document editor while an
 * unlocked encrypted block holds the caret. */
export function getActiveEncryptedBlockView(): EditorView | null {
  return activeRevealView
}

/** Forget the reveal editor — focus returned to the document proper. */
export function clearActiveEncryptedBlockView(): void {
  activeRevealView = null
}

// The reveal editor is a nested editor inside the main document's DOM, so a
// plain "main view got focusin" listener would also fire for the reveal. Only
// clear when focus lands somewhere that is not an unlocked block or the
// toolbar (toolbar button presses must keep the reveal as the format target).
document.addEventListener('focusin', (event) => {
  if (activeRevealView === null) return
  const target = event.target
  if (target instanceof Element && (target.closest('.encrypted-block-reveal') !== null || target.closest('#toolbar') !== null)) return
  clearActiveEncryptedBlockView()
})

export function primeEncryptedBlockShow(password: string): void {
  pendingUnlockPassword = password
}

interface EncryptedBlockAttrs {
  type: string
  label: string
  content: string
}

function encryptedBlockChipText(attrs: EncryptedBlockAttrs): string {
  const type = attrs.type.replace(/_/g, ' ') || 'block'
  return `🔒 encrypted · ${type}${attrs.label ? ' · ' + attrs.label : ''}`
}

function getAttrs(node: ProseNode): EncryptedBlockAttrs {
  return {
    type: String(node.attrs.type ?? ''),
    label: String(node.attrs.label ?? ''),
    content: String(node.attrs.content ?? ''),
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
    this.render()
  }

  update(node: ProseNode): boolean {
    // Source mode is a different node view (the decrypted block's markdown),
    // so a change of it rebuilds. Asked of the mode record, which is where the
    // representation lives now that no node carries one.
    if (showsSource(this.view, this.getPos())) return false
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
      this.wordsEl.textContent = encryptedBlockChipText(a)
      if (this.toggleBtn) this.toggleBtn.textContent = 'Lock ▾'
    }
    return true
  }

  destroy(): void {
    this.destroyTransient()
  }

  private destroyTransient(): void {
    if (activeRevealView === this.revealEditor) clearActiveEncryptedBlockView()
    this.revealEditor?.destroy()
    this.revealEditor = null
    this.revealHost = null
  }

  private async closeReveal(): Promise<void> {
    if (activeRevealView === this.revealEditor) clearActiveEncryptedBlockView()
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    // Commit any pending plaintext back into the envelope BEFORE tearing the
    // reveal down: persist awaits subtle-crypto and one saved-editor serialisation
    // otherwise outruns it and silently reverts the document to the old envelope.
    await this.persist()
    this.revealEditor?.destroy()
    this.revealEditor = null
    this.revealInner = null
    this.revealPassword = null
    this.revealHost?.remove()
    this.revealHost = null
    if (this.toggleBtn) this.toggleBtn.textContent = 'Unlock ▸'
    if (this.wordsEl) {
      const a = getAttrs(this.node)
      this.wordsEl.textContent = encryptedBlockChipText(a)
    }
  }

  private render(): void {
    const attrs = getAttrs(this.node)
    this.dom.innerHTML = ''
    const pill = document.createElement('div')
    pill.className = 'encrypted-block-pill'

    const words = document.createElement('span')
    words.className = 'encrypted-block-label'
    words.textContent = encryptedBlockChipText(attrs)
    this.wordsEl = words
    pill.appendChild(words)

    this.dom.appendChild(pill)

    // Unlock and Normalize are the block's own actions, so they go in the one
    // cluster every block has, in the same place as everything else's — which is
    // also what finally shows them: the old reveal list for the dot grid did not
    // mention `.encrypted-block`, so the handle this block injected was in the DOM
    // and never visible.
    const controls = attachBlockControls(this.node, this.view, this.getPos, [
      this.blockButton('Normalize', 'encrypted-block-unmask', () => { void this.unmask_() },
        'Convert to normal block (decrypted)'),
      this.toggleBtn = this.blockButton('Unlock ▸', 'encrypted-block-toggle', () => { void this.toggleShow_() }),
    ])
    if (controls) this.dom.appendChild(controls.dom)
  }

  private blockButton(
    text: string,
    cls: string,
    run: () => void,
    title?: string,
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `block-control toolbar-btn ${cls}`
    btn.textContent = text
    if (title) btn.title = title
    btn.addEventListener('click', (e) => { e.stopPropagation(); run() })
    return btn
  }

  /** Show: render the decrypted markdown inline, editable; never into the document. */
  private async toggleShow_(): Promise<void> {
    if (this.revealHost) {
      await this.closeReveal()
      return
    }
    const primed = pendingUnlockPassword
    pendingUnlockPassword = null
    let plaintext: string | null = null
    const password = primed ?? await promptForPassword(getAttrs(this.node).label || 'encrypted block', async (pw) => {
      try {
        plaintext = await decryptField(getAttrs(this.node).content, pw)
        return true
      } catch {
        plaintext = null
        return 'Incorrect password'
      }
    }, { title: 'Show encrypted block' })
    if (password === null) return
    if (plaintext === null) {
      try {
        plaintext = await decryptField(getAttrs(this.node).content, password)
      } catch {
        return
      }
    }
    await this.closeReveal()
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
    this.revealEditor.dom.addEventListener('focusin', () => {
      activeRevealView = this.revealEditor
    })
    host.addEventListener('mousedown', () => {
      activeRevealView = this.revealEditor
    })
    this.revealEditor.focus()
    if (this.toggleBtn) this.toggleBtn.textContent = 'Lock ▾'
    if (this.wordsEl) {
      const a = getAttrs(this.node)
      this.wordsEl.textContent = encryptedBlockChipText(a)
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => { void this.persist() }, 600)
  }

  private async persist(): Promise<void> {
    if (this.revealPassword === null || !this.revealInner) return
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
    } catch (e) {
      console.error('PERSIST FAILED', e)
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
    let plaintext: string | null = null
    const password = await promptForPassword(attrs.label || 'encrypted block', async (pw) => {
      try {
        plaintext = await decryptField(attrs.content, pw)
        return true
      } catch {
        plaintext = null
        return 'Incorrect password'
      }
    }, { title: 'Decrypt block' })
    if (password === null) return
    if (plaintext === null) {
      try {
        plaintext = await decryptField(attrs.content, password)
      } catch {
        return
      }
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
        // `blockNodeView` answers "is this block showing its source" from the
        // mode record; `encrypted_block` is never a `source_block`.
        if (showsSource(view, getPos())) {
          return blockNodeView(node, view, getPos) as NodeView
        }
        return new EncryptedBlockNodeView(node, view, getPos)
      },
    },
  },
})
