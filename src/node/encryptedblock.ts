/**
 * Encrypted block node view. A collapsed card shows the block's visible
 * metadata (its original type and optional label) and offers View / Edit /
 * Unmask. Plaintext is only ever rendered transiently: View and Edit keep the
 * document's markdown source free of decrypted text.
 */
import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import { EditorView, type NodeView } from 'prosemirror-view'
import { decryptFailureMessage, decryptField, openEnvelope, openWithKey, sealWithKey, type SealingKey, type SecretContext } from '../crypto'
import { promptForPassword } from '../crypto-dialog'
import { confirmAction } from '../bridge'
import { markdownToProse } from '../markdown'
import { createBlockEditor } from '../editor'
import { blockNodeView, showsSource } from '../blockview'
import { BLOCK_MODE_HANDLERS, BLOCK_MODE_KEY, attachBlockControls, modeFor, setBlockMode, setBlockModeAt } from '../block-modes'
import type { BlockControls } from '../block-modes'
import { PLAIN_PAGE_ICON, paintIcon } from '../icons'
import type { ResolveImage } from '../image'

const imageResolver: { value: ResolveImage | undefined } = { value: undefined }
export function setEncryptedBlockImageResolver(fn: ResolveImage | undefined): void {
  imageResolver.value = fn
}

const pendingUnlockKey: { value: SealingKey | null } = { value: null }

const activeRevealView: { value: EditorView | null } = { value: null }

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
  return activeRevealView.value
}

/** Is `view` the editor of an open reveal — that is, already inside an encrypted block? */
export function isEncryptedBlockReveal(view: EditorView): boolean {
  return view.dom.parentElement?.closest('.encrypted-block-reveal') != null
}

/** Does `from`–`to` of `doc` hold an encrypted block? */
export function containsEncryptedBlock(doc: ProseNode, from = 0, to = doc.content.size): boolean {
  let found = false
  doc.nodesBetween(from, to, (node) => {
    if (node.type.name === 'encrypted_block') found = true
    return !found
  })
  return found
}

function countEncryptedBlocks(doc: ProseNode): number {
  let count = 0
  doc.descendants((node) => {
    if (node.type.name === 'encrypted_block') count++
    return !node.isTextblock
  })
  return count
}

/**
 * **One level of encryption**, for the editor inside an open reveal: any change that
 * would add an encrypted block — a paste, a typed fence, a flip out of source — is
 * refused. Counted rather than forbidden outright, so a document that already nests
 * (written before this rule) still opens, edits and saves without losing anything.
 */
export const noNestedEncryptedBlocksPlugin = new Plugin({
  filterTransaction: (tr, state) =>
    !tr.docChanged || countEncryptedBlocks(tr.doc) <= countEncryptedBlocks(state.doc),
})

/** Forget the reveal editor — focus returned to the document proper. */
export function clearActiveEncryptedBlockView(): void {
  activeRevealView.value = null
}

// The reveal editor is a nested editor inside the main document's DOM, so a
// plain "main view got focusin" listener would also fire for the reveal. Only
// clear when focus lands somewhere that is not an unlocked block or the
// toolbar (toolbar button presses must keep the reveal as the format target).
//
// This is the *remembrance*, not the answer: `getActiveEncryptedBlockView` asks
// the DOM first and only falls back to what this listener last saw.
document.addEventListener('focusin', (event) => {
  if (activeRevealView.value === null) return
  const target = event.target
  if (target instanceof Element && (target.closest('.encrypted-block-reveal') !== null || target.closest('#toolbar') !== null)) return
  clearActiveEncryptedBlockView()
})

/**
 * The key the *next* unlock will use without asking, set by
 * {@link unlockEncryptedBlockAt} for a block that was just sealed with it.
 */
function primeEncryptedBlockShow(key: SealingKey): void {
  pendingUnlockKey.value = key
}

/**
 * Open the encrypted block at `pos` with the key it was just sealed with.
 *
 * **This is what "Encrypt…" calls to leave a fresh block unlocked, and it is
 * a function rather than the button press it used to be.** That route primed the
 * password and then found `.encrypted-block-toggle` in the block's DOM and clicked
 * it — which only worked because the node view had rendered that button
 * synchronously, and which had a second copy of the interaction to keep in step with
 * the first. Going through `BLOCK_MODE_HANDLERS` is the same gesture the cluster's
 * `Edit` makes, so a fresh block and a clicked one are the same code path.
 */
export function unlockEncryptedBlockAt(view: EditorView, pos: number, key: SealingKey): void {
  const node = view.state.doc.nodeAt(pos)
  if (node === null || node.type.name !== 'encrypted_block') return
  primeEncryptedBlockShow(key)
  BLOCK_MODE_HANDLERS['encrypted_block'].enter?.(view, pos)
}

interface EncryptedBlockAttrs {
  type: string
  label: string
  content: string
}

/**
 * The chip names the block by its label only. The stored `type` is kept for old
 * files but not shown: a block holds any number of blocks once it is open, so the
 * type it was made from stops describing it.
 */
function encryptedBlockChipText(attrs: EncryptedBlockAttrs): string {
  return `🔒 encrypted${attrs.label ? ' · ' + attrs.label : ''}`
}

/** What a block's envelope is bound to: its kind and its label as saved. */
export function blockContext(label: string): SecretContext {
  return { kind: 'block', label }
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
  /** The open reveal's derived key — never the password. */
  private revealKey: SealingKey | null = null
  private lastRevealedMd: string | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  /** The cluster's mode buttons, for when the record moves and they have to be told. */
  private modeControls: BlockControls | null = null
  private wordsEl: HTMLSpanElement | null = null

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.dom = document.createElement('div')
    this.dom.className = 'encrypted-block'
    encryptedBlockViews.add(this)
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
      // The cluster's Unlock/Lock reads the record on paint, and a persist is a
      // document change, so it has to be told — or the button keeps saying Unlock
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
    if (activeRevealView.value === this.revealEditor) clearActiveEncryptedBlockView()
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
    encryptedBlockViews.delete(this)
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
    if (activeRevealView.value === this.revealEditor) clearActiveEncryptedBlockView()
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
    this.revealKey = null
    this.revealHost?.remove()
    this.revealHost = null
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
    // **Unlock is not here.** `blockModeFor` declares this block interactive, so
    // `attachBlockControls` generates the interaction button from the descriptor
    // like every other block's — and this block's `toggle` is its `toggleShow_`, so
    // the cluster's `Edit` already decrypts and reveals, and its `Done` already
    // locks. A second `Unlock ▸` / `Lock ▾` button beside it was the same act under
    // two names: one that stayed correct on its own and one that the record
    // repainted, which is the pair that drifts. (The comment this replaces claimed
    // the cluster's button could not open a reveal "that is not yet in a mode" —
    // true of `toggleBlockMode`, which reads the record, and **not** true of
    // `toggle`, which reads the block's own `revealHost` and so answers both ends.)
    const controls = attachBlockControls(this.node, this.view, this.getPos, [
      this.blockButton('Normalize', PLAIN_PAGE_ICON, 'encrypted-block-unmask',
        () => { void this.unmask_() }, 'Convert to a normal block (decrypted)'),
    ])
    if (controls) {
      this.modeControls = controls
      this.dom.appendChild(controls.dom)
    }
  }

  private blockButton(
    label: string,
    iconMarkup: string,
    cls: string,
    run: () => void,
    title?: string,
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    // **Not `toolbar-btn`.** That class is the menubar row's metrics — 5px 8px of
    // padding and a 20px glyph — and a cluster button is a 24px square in the page
    // gutter. Keeping both meant the first had to be un-done by the second on every
    // property they share, which is how the Copy button came to stand 3px taller
    // than the button beside it.
    btn.className = `block-control ${cls}`
    paintIcon(btn, iconMarkup, label)
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
    const primed = pendingUnlockKey.value
    pendingUnlockKey.value = null
    // The key is derived once, here, and every save while the block is open seals
    // with it: the password itself is not kept, and a save costs no PBKDF2.
    let opened: { plaintext: string; key: SealingKey } | null = null
    const { content, label } = getAttrs(this.node)
    if (primed) {
      try {
        opened = { plaintext: await openWithKey(content, primed, blockContext(label)), key: primed }
      } catch {
        opened = null
      }
    }
    if (opened === null) {
      const password = await promptForPassword(label || 'encrypted block', async (pw) => {
        try {
          opened = await openEnvelope(content, pw, blockContext(label))
          return true
        } catch (error) {
          opened = null
          return decryptFailureMessage(error)
        }
      }, { title: 'Show encrypted block' })
      if (password === null) return
      if (opened === null) {
        try {
          opened = await openEnvelope(content, password, blockContext(label))
        } catch {
          return
        }
      }
    }
    const { plaintext, key } = opened as { plaintext: string; key: SealingKey }
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
      [...encryptedBlockViews]
        .filter((other) => other !== this && other.isOpen)
        .map((other) => other.closeReveal()),
    )
    await this.closeReveal()
    const host = document.createElement('div')
    host.className = 'encrypted-block-reveal'
    this.dom.appendChild(host)
    this.revealHost = host
    this.revealKey = key
    this.lastRevealedMd = plaintext
    this.revealInner = createBlockEditor(host, plaintext, {
      resolveImageSrc: imageResolver.value,
      onChange: () => this.schedulePersist(),
      insideEncryptedBlock: true,
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
      activeRevealView.value = this.revealEditor
    })
    host.addEventListener('mousedown', () => {
      activeRevealView.value = this.revealEditor
    })
    this.revealEditor.focus()
    // **Opening a block is taking the page's one focus path**, which is why it is
    // done through the record and not left as a per-block closure: everything §7.2
    // generates then comes for free — the dashed outline, the chip that names the
    // state, the cluster's Done button, Alt+click, and the Escape rung — and it
    // takes the page's one working state with it, because the plaintext is on screen
    // and the reader's attention is on this block. It does not wait for a click into
    // the reveal; by then there is nothing left to warn about.
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

  /**
   * Encrypt the reveal's plaintext back into its block.
   *
   * **Two guards, and the second one is the load-bearing one.** Encrypting is
   * asynchronous (`crypto.subtle`), so everything between the `await` and the dispatch
   * can have happened: the node view can be destroyed, and then `this.view.state` is
   * whatever document the view is showing *now*. Without the guard that is not a lost
   * edit — `setNodeMarkup` at a position belonging to the document that used to be
   * here would replace an unrelated node in the document that is here now. A tab swap
   * is exactly that shape, and it is silent either way.
   *
   * So the write is conditional on this block still being the block at that position:
   * a destroyed view, a moved position, a different node type, or a node that is no
   * longer the one we read are all "somebody else's document", and the honest answer
   * is to drop the write. The pending plaintext is not lost by dropping it on the
   * destroy route — {@link flushOpenReveals} runs *before* the swap, which is the
   * route that exists to get here first.
   */
  private async persist(): Promise<void> {
    if (this.revealKey === null || !this.revealInner) return
    const markdown = this.revealInner.getMarkdown()
    if (markdown === this.lastRevealedMd) return
    const a = getAttrs(this.node)
    const from = this.node
    try {
      const envelope = await sealWithKey(markdown, this.revealKey, blockContext(a.label))
      if (this.view.isDestroyed) return
      const pos = this.getPos()
      if (pos === undefined) return
      const node = this.view.state.doc.nodeAt(pos)
      if (node === null || node.type.name !== 'encrypted_block' || node !== from) return
      const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { type: a.type, label: a.label, content: envelope })
      this.view.dispatch(tr)
      this.lastRevealedMd = markdown
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
        plaintext = await decryptField(attrs.content, pw, blockContext(attrs.label))
        return true
      } catch (error) {
        plaintext = null
        return decryptFailureMessage(error)
      }
    }, { title: 'Decrypt block' })
    if (password === null) return
    if (plaintext === null) {
      try {
        plaintext = await decryptField(attrs.content, password, blockContext(attrs.label))
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

  /** The gesture that puts it back — Alt+click, or the cluster's Done button. */
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

  /** The editor this block lives in, for the module-level lookups above. */
  get editorView(): EditorView {
    return this.view
  }

  /** Where this block is in its editor's document, or `undefined` if it is not there. */
  position(): number | undefined {
    return this.getPos()
  }

  /**
   * Is there plaintext in the reveal that the document has not been told about?
   *
   * **A synchronous question on purpose.** {@link flushOpenReveals} asks it before
   * deciding whether to be asynchronous at all, so it has to be answerable without
   * awaiting: `getMarkdown` is a synchronous serialisation of a document that is still
   * here, and the comparison against the last committed text is the whole of what
   * "pending" means.
   */
  hasPendingCommit(): boolean {
    if (this.revealKey === null || !this.revealInner) return false
    return this.revealInner.getMarkdown() !== this.lastRevealedMd
  }

  /**
   * Stop owing the document anything, without writing it.
   *
   * The timer is cancelled so it cannot fire later and dispatch into whatever is on
   * screen by then, and `lastRevealedMd` is brought up to date for the same reason:
   * the text is being discarded *with* the document, so there is no pending commit
   * left to account for. `persist`'s own guard would refuse a late write anyway, but
   * "would be refused" is not the same as "was never attempted".
   */
  discardPending(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (this.revealInner) this.lastRevealedMd = this.revealInner.getMarkdown()
  }

  /**
   * Write back whatever is pending, now, rather than when the debounce would fire.
   *
   * The timer is cancelled rather than left to race: a second `persist` for the same
   * text is harmless, but a *late* one arriving after a flush would dispatch into a
   * state that has already moved on — which is the thing `persist`'s guard refuses.
   */
  flush(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    return this.persist()
  }
}

/**
 * Every encrypted block's node view, in every editor.
 *
 * **This registry is what makes "one at a time" possible at all.** The mode record
 * can only be written by whichever editor owns it, and a reveal's plaintext lives
 * in a *nested* editor this node view created — so when a second block takes the
 * page's one working state, the first one's record is released for it, and releasing
 * a record is not the same as tearing a reveal down. Nothing else in the app knows
 * how to close one. So the node view that owns the editor is the one that closes it,
 * and it has to be findable from the block opening.
 *
 * **A set of the node views, not a map keyed by editor**, because a document may hold
 * several blocks and a map keyed by the editor kept only the last one constructed. The
 * block that was then unreachable by position could not be closed, flushed, or driven
 * from its own cluster button — and "one block at a time" is the rule the registry is
 * here to enforce, so the one case it could not name was the case it exists for. Reads
 * go through {@link encryptedBlockViewFor}, which resolves by position.
 */
const encryptedBlockViews = new Set<EncryptedBlockNodeView>()

/**
 * The node view for the encrypted block at `pos`, in `view`.
 *
 * **By position, not by "the editor's only one"**, because the editor may hold many.
 * With no position to go on (a caller that only has an editor — the flush) the first
 * one it finds is the honest answer, and every open reveal still gets flushed because
 * the flush walks the whole set rather than asking this.
 */
function encryptedBlockViewFor(view: EditorView, pos?: number): EncryptedBlockNodeView | undefined {
  for (const nodeView of encryptedBlockViews) {
    if (nodeView.editorView !== view) continue
    if (pos === undefined || nodeView.position() === pos) return nodeView
  }
  return undefined
}

/**
 * Commit whatever an open reveal in `view` has typed but not yet written back.
 *
 * **This is the flush a reveal owes on the one route that cannot wait for it.** Every
 * other route out of a working state is synchronous enough to commit inside: the
 * **Lock** button and another block taking the focus path both go through
 * `closeReveal`, which awaits `persist` before it tears anything down. The route this
 * exists for is **the editor's state being replaced under it** — a tab swap, via
 * `BlockEditor.setMarkdown` / `applyState` — which destroys the node view, and with it
 * the nested editor holding the plaintext, *inside* a synchronous `view.updateState`.
 *
 * That timing is the whole of the problem, and it is not a matter of tidying: `persist`
 * awaits `crypto.subtle`, so its `setNodeMarkup` runs on a later microtask, by which
 * time the state it was about to write into is gone. It does not merely fail to save —
 * `this.view.state.tr` is the *incoming* document, and a stale position in it is a node
 * in someone else's file. So the flush has to happen **before** the swap, which means
 * the swap has to be awaited, which is why `setMarkdown`/`applyState` return a promise.
 *
 * Nothing else needs this: a document edit keeps the same state and the ordinary
 * 600 ms debounce catches up on its own.
 *
 * **It answers `undefined` when there is nothing to write, and that is the load-bearing
 * half of its signature.** Not returning a promise is what lets every caller stay
 * synchronous in the ordinary case — no reveal open, or one open with nothing typed
 * since it last wrote back — rather than pushing one microtask between a tab switch and
 * the state it reads. `Tabs` depends on it, and so does every reader of the document
 * that assumes a swap has happened by the time the function returns. An async API that
 * is awaited everywhere and meaningful in one place is a different API; this one is
 * awaited in exactly the one place it can be.
 */
export function flushOpenReveals(view: EditorView): void | Promise<void> {
  const open = [...encryptedBlockViews].filter((n) => n.editorView === view && n.hasPendingCommit())
  if (open.length === 0) return
  return Promise.all(open.map((n) => n.flush())).then(() => undefined)
}

/**
 * Give up on whatever an open reveal in `view` has not written back, so that
 * {@link flushOpenReveals} has nothing left to do.
 *
 * **Only for a document being replaced from outside, never for a tab being left.**
 * The two are different acts and only one of them has something to come back to:
 *
 * - *Switching tabs* keeps the outgoing document — it is stored, and the reader is
 *   coming back to it — so a half-second of typing has to be written into it first, or
 *   the tab returns to text that was never saved. That is {@link flushOpenReveals}.
 * - *Replacing the document* — reopening a file, the shell loading a document over the
 *   tab, a harness setting content — throws the outgoing document away whole. There is
 *   no tab to return to and nothing to return to it with; committing would be writing
 *   into a document that is being discarded, and *waiting* for it would make an
 *   operation that is otherwise instantaneous take as long as a crypto round trip.
 *
 * So the second one cancels, and says so in one line at the call site rather than
 * making every reader of `setState` know which kind of swap they are performing.
 */
export function discardOpenReveals(view: EditorView): void {
  for (const nodeView of encryptedBlockViews) {
    if (nodeView.editorView === view) nodeView.discardPending()
  }
}

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
  enter: (view, pos) => { void encryptedBlockViewFor(view, pos)?.enter() },
  exit: (view, pos) => encryptedBlockViewFor(view, pos)?.exit(),
  toggle: (view, pos) => encryptedBlockViewFor(view, pos)?.toggle(),
  // **The axis has its own verbs, and it is still the same axis.** Revealing a
  // secret is a working state exactly as editing a diagram is — one at a time, one
  // gesture, one focus path around it — but the act is not the
  // same act, so the app says `Unlock` / `Lock` here and `Edit` / `Done` on a
  // diagram. `engaged` is a third word because the chip names the *state*: `Edit`
  // covers both jobs on a diagram, and `Unlock`/`Unlocked` are what it takes here.
  //
  // Declared in the handler, beside the three functions that do the work, because
  // this is the one object all three surfaces read (`interactionLabels`) — a block
  // that renames its axis renames it in the cluster, the context menu and the chip
  // at once, rather than discovering that one of the three still calls it a diagram.
  labels: { idle: 'Unlock', active: 'Lock', engaged: 'Unlocked' },
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
