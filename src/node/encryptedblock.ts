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
import { BLOCK_MODE_HANDLERS, BLOCK_MODE_KEY, attachBlockControls, modeFor, setBlockMode, setBlockModeAt } from '../block-modes'
import type { BlockControls } from '../block-modes'
import type { ResolveImage } from '../image'

let imageResolver: ResolveImage | undefined
export function setEncryptedBlockImageResolver(fn: ResolveImage | undefined): void {
  imageResolver = fn
}

let pendingUnlockPassword: string | null = null

let activeRevealView: EditorView | null = null

/**
 * Every open reveal's editor, by the host element it lives in.
 *
 * A `WeakMap`, so a host that goes away takes its entry with it and nothing has to
 * sweep — which matters here because these editors are destroyed on a route the page
 * does not own (a document swap, a re-render).
 */
const revealViews = new WeakMap<HTMLElement, EditorView>()

/** The editor view of the focused encrypted-block reveal, if any.
 *
 * **Read from where the caret actually is, and only remembered as a fallback.** The
 * rule this exists for is *"a nested editor owns its own selection and its own
 * keyboard, by virtue of holding focus"* — so focus is the input, and asking the DOM
 * for it is the only way that cannot be wrong.
 *
 * The remembered `activeRevealView` is a `focusin` heuristic: it is set when focus
 * lands in a reveal and cleared when focus lands anywhere else, which means any
 * momentary focus that escapes the reveal — a dialog closing, a node view rebuilding,
 * a grid taking and giving the caret back — silently demoted every later command to
 * the outer document. It is still worth keeping, because the **toolbar** is a case
 * the DOM cannot answer: focus is on a button in `#toolbar`, outside the reveal, and
 * the command still belongs to the reveal the reader came from.
 *
 * `closest()` walks up, so a reveal inside a reveal is found without a second rule.
 */
export function getActiveEncryptedBlockView(): EditorView | null {
  const active = document.activeElement
  const host = active instanceof Element ? active.closest('.encrypted-block-reveal') : null
  if (host instanceof HTMLElement) {
    const view = revealViews.get(host)
    if (view !== undefined) return view
  }
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
//
// This is the *remembrance*, not the answer: `getActiveEncryptedBlockView` asks
// the DOM first and only falls back to what this listener last saw.
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
  private revealToggle!: HTMLButtonElement
  /** The cluster's Edit/Lock button, for when it has to be told the reveal closed. */
  private modeControls: BlockControls | null = null
  private wordsEl: HTMLSpanElement | null = null

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.dom = document.createElement('div')
    this.dom.className = 'encrypted-block'
    encryptedBlockViews.set(view, this)
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
      // The cluster's Edit/Lock reads the record on paint, and a persist is a
      // document change, so it has to be told — or the button keeps saying Edit
      // over a block that has been open the whole time.
      this.modeControls?.refresh()
    }
    return true
  }

  destroy(): void {
    // Commit before the reveal editor exists no more. A document swap, a closed tab
    // or a re-render all arrive here, and they are the route a reader is most likely
    // to take by accident; losing the last half-second of typing because the record
    // went with the editor is the same bug as every other §3 exit.
    this.releaseWorkingState()
    this.destroyTransient()
  }

  private destroyTransient(): void {
    if (activeRevealView === this.revealEditor) clearActiveEncryptedBlockView()
    this.revealEditor?.destroy()
    this.revealEditor = null
    this.revealHost = null
  }

  /**
   * Hand this block back its "working" state, committing first.
   *
   * **Every route out of a mode commits, and a reveal has three of them** — the
   * reader pressing Lock, another block taking the page's one focus path, and this
   * view being destroyed — where a sheet or a source form has two. Edits persist on
   * a 600 ms debounce (`schedulePersist`) and `persist` awaits subtle-crypto, so a
   * close that skipped the flush would drop the last half-second of typing. That is
   * the rule block-modes §3 puts on every other route out, and a new route inherits
   * it rather than being the exception to it.
   */
  private releaseWorkingState(): void {
    if (encryptedBlockViews.get(this.view) === this) encryptedBlockViews.delete(this.view)
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    void this.persist().then(() => {
      const pos = this.getPos()
      if (pos === undefined || modeFor(this.view.state, pos) === null) return
      this.view.dispatch(this.view.state.tr.setMeta(BLOCK_MODE_KEY, null))
    })
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
    // The record goes with it, on the same terms — a block that is no longer open
    // is not working, however its plaintext was flushed.
    await this.persist()
    const pos = this.getPos()
    if (pos !== undefined && modeFor(this.view.state, pos) !== null) {
      this.view.dispatch(this.view.state.tr.setMeta(BLOCK_MODE_KEY, null))
    }
    this.revealEditor?.destroy()
    this.revealEditor = null
    this.revealInner = null
    this.revealPassword = null
    this.revealHost?.remove()
    this.revealHost = null
    this.revealToggle.textContent = 'Unlock ▸'
    this.modeControls?.refresh()
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
    //
    // **The cluster's own Edit/Lock button is not built here.** `blockModeFor` now
    // declares this block interactive, so `attachBlockControls` generates one from
    // the descriptor like every other block's — and it drives the same
    // `toggleBlockMode` an Alt+click does. The `Unlock ▸` button below stays for
    // the one thing the cluster's button cannot do: a reveal that is **not** yet in
    // a mode has nothing for `toggle` to toggle. Once open, the cluster reads
    // Edit/Lock and this one agrees with it.
    const controls = attachBlockControls(this.node, this.view, this.getPos, [
      this.blockButton('Normalize', 'encrypted-block-unmask', () => { void this.unmask_() },
        'Convert to normal block (decrypted)'),
      this.revealToggle = this.blockButton('Unlock ▸', 'encrypted-block-toggle', () => { void this.toggleShow_() }),
    ])
    if (controls) {
      this.modeControls = controls
      this.dom.appendChild(controls.dom)
    }
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
    // **One at a time, and only now.** Whichever other block is holding the page's
    // focus path is locked *after* this one's password has been accepted, because a
    // wrong password is not a decision to move on: lock first, decrypt second, and a
    // typo in the second block throws away a half-second of typing in the first one
    // the reader never actually left.
    //
    // The close goes through `closeReveal`, which is the same path a manual **Lock**
    // takes — persist first, then the record. `releaseOtherEditors` alone would not
    // do: it releases the *record*, and the plaintext is in a nested editor only this
    // node view knows how to tear down.
    await Promise.all(
      [...encryptedBlockViews.values()]
        .filter((other) => other !== this && other.isOpen)
        .map((other) => other.closeReveal()),
    )
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
      // This editor is a **rung** of the page's focus path, not a rival of it: the
      // block above is the encrypted block this reveal lives in, and saying so is
      // what stops a sheet opened down here from releasing *its* record — which
      // would lock the block out from under the sheet.
      focusParent: () => {
        const pos = this.getPos()
        return pos === undefined ? undefined : { view: this.view, pos, type: 'encrypted_block' }
      },
    })
    this.revealEditor = this.revealInner.getView()
    this.revealEditor.dom.classList.add('encrypted-block-reveal-editor')
    revealViews.set(host, this.revealEditor)
    this.revealEditor.dom.addEventListener('focusin', () => {
      activeRevealView = this.revealEditor
    })
    host.addEventListener('mousedown', () => {
      activeRevealView = this.revealEditor
    })
    this.revealEditor.focus()
    // **Opening a block is taking the page's one focus path**, which is why it is
    // done through the record and not left as a per-block closure: everything §7.2
    // generates then comes for free — the dashed outline, the chip that names the
    // state, the cluster's Lock button, Alt+click, and the Escape rung — and the
    // document dims and goes inert at once, because the plaintext is on screen and
    // the reader's attention is on this block. It does not wait for a click into the
    // reveal; by then there is nothing left to warn about.
    //
    // Taken **after** the reveal editor exists, because the reveal is the chain's
    // next rung and has to be published first — and after the password, so a wrong
    // one locks nothing at all. `setBlockModeAt` rather than a hand-written record:
    // it stamps the node type, collapses the selection the way every other route
    // into a mode does, and refuses outright on a block that cannot take the state.
    const pos = this.getPos()
    if (pos !== undefined) {
      const tr = this.view.state.tr
      setBlockModeAt(this.view.state, tr, pos, { interaction: 'editing' })
      this.view.dispatch(tr)
    }
    this.revealToggle.textContent = 'Lock ▾'
    this.modeControls?.refresh()
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
    // The block is being replaced outright, so whatever it was holding goes with it.
    setBlockMode(tr, null)
    this.view.dispatch(tr)
    this.view.focus()
  }

  /** The gesture that takes this block into its working state. */
  async enter(): Promise<void> {
    await this.toggleShow_()
  }

  /** The gesture that puts it back — Alt+click, or the cluster's Lock button. */
  exit(): void {
    void this.closeReveal()
  }

  /** The cluster's button, which names the step it goes to rather than the state. */
  toggle(): void {
    if (this.revealHost) this.exit()
    else void this.enter()
  }

  /** Has this block decrypted its contents and is showing them? */
  get isOpen(): boolean {
    return this.revealHost !== null
  }
}

/**
 * Every encrypted block's node view, by the editor it belongs to.
 *
 * **This registry is what makes "one at a time" possible at all.** The mode record
 * can only be written by whichever editor owns it, and a reveal's plaintext lives
 * in a *nested* editor this node view created — so when a second block takes the
 * page's one working state, the first one's record is released for it, and releasing
 * a record is not the same as tearing a reveal down. Nothing else in the app knows
 * how to close one. So the node view that owns the editor is the one that closes it,
 * and it has to be findable from the block opening.
 */
const encryptedBlockViews = new Map<EditorView, EncryptedBlockNodeView>()

/**
 * An unlocked block is a **working state**, like a diagram being edited and like a
 * table held as a sheet, and it is the only one at a time.
 *
 * `blockModePlugin` used to say the opposite — that a reveal is per-block and
 * non-exclusive, and lives in a closure — and that was wrong for a reason worth
 * recording: **it let a storage fact decide a semantic question.** A closure is
 * where the state happens to sit; whether the reader is *working somewhere* is a
 * different question, and the model had already answered it — *producing states
 * with a selection surface of their own*. A revealed block has a whole nested
 * editor as its selection surface. It qualified all along.
 *
 * So the block joins `INTERACTIVE_BLOCKS` and everything §7.2 generates comes for
 * free: the dashed outline, the chip that names the state, a cluster button,
 * Alt+click, and the Escape rung. **Nothing here is designed; a block type is
 * described once.**
 *
 * **What is genuinely lost** is comparing two secrets side by side. That was a real
 * use and it is now refused on purpose, for a reason that is not about selection at
 * all: several decrypted secrets on one screen is a shoulder-surfing surface. A
 * refusal with that reason is better than a capability nobody thought to close.
 */
BLOCK_MODE_HANDLERS['encrypted_block'] = {
  enter: (view) => { void encryptedBlockViews.get(view)?.enter() },
  exit: (view) => encryptedBlockViews.get(view)?.exit(),
  toggle: (view) => encryptedBlockViews.get(view)?.toggle(),
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
