/**
 * The one **Encrypt…** gesture — the toolbar's lock, Edit ▸ Encrypt… and the block
 * context menu all come here, so the three cannot drift apart.
 *
 * The selection decides what is made, *before* any dialog opens:
 *
 * - **nothing selected, or a range inside one line** → an encrypted field, with the
 *   selected text (if any) offered as its value;
 * - **anything else** → an encrypted block holding every top-level block the
 *   selection touches.
 *
 * **One level of encryption.** An encrypted block never holds another encrypted
 * block, so a block is refused inside an open one and over a selection that already
 * contains one. Fields are not a level — a field may sit anywhere, including inside a
 * block. The nested editor enforces the same rule for paste and typing; see
 * `noNestedEncryptedBlocksPlugin`.
 */
import { NodeSelection, type EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { showError } from './bridge'
import { encryptFieldVerified } from './crypto'
import { promptForEncrypt } from './crypto-dialog'
import { formulaEnvFor } from './formulaDefs'
import { sliceMarkdown } from './markdown'
import { containsEncryptedBlock, isEncryptedBlockReveal, unlockEncryptedBlockAt } from './node/encryptedblock'
import { MASKED_TYPE, primeMaskedFieldReveal, promptForNewSecret } from './node/masked'

/** The gesture's one name, wherever it is offered (the Edit menu spells it in `window.py`). */
export const ENCRYPT_LABEL = 'Encrypt…'

export const NESTED_BLOCK_REFUSAL =
  'An encrypted block cannot contain another encrypted block. Select text within one line to encrypt it as a field instead.'

export type EncryptTarget =
  | { kind: 'field'; from: number; to: number; value: string }
  | { kind: 'block'; from: number; to: number }
  | { kind: 'refused'; reason: string }

/** The positions of every top-level block the range `from`–`to` touches. */
function topLevelRange(state: EditorState, from: number, to: number): { from: number; to: number } {
  let start = -1
  let end = -1
  state.doc.forEach((node, offset) => {
    const nodeEnd = offset + node.nodeSize
    if (nodeEnd > from && offset < Math.max(to, from + 1)) {
      if (start < 0) start = offset
      end = nodeEnd
    }
  })
  return { from: start, to: end }
}

/**
 * The block range for top-level blocks `from`–`to`, or the refusal one level of
 * encryption makes of it.
 */
function blockTarget(view: EditorView, from: number, to: number): EncryptTarget {
  if (isEncryptedBlockReveal(view) || containsEncryptedBlock(view.state.doc, from, to)) {
    return { kind: 'refused', reason: NESTED_BLOCK_REFUSAL }
  }
  return { kind: 'block', from, to }
}

/** What Encrypt… will make of this view's selection. */
export function encryptTarget(view: EditorView): EncryptTarget {
  const { state } = view
  const sel = state.selection
  const { $from, $to } = sel
  const fieldFits = !(sel instanceof NodeSelection)
    && $from.sameParent($to)
    && $from.parent.inlineContent
    && $from.parent.canReplaceWith($from.index(), $to.index(), state.schema.nodes[MASKED_TYPE]!)
  if (fieldFits) {
    return { kind: 'field', from: sel.from, to: sel.to, value: state.doc.textBetween(sel.from, sel.to, '\n') }
  }
  if (sel.empty) return { kind: 'refused', reason: 'An encrypted field cannot be inserted here.' }
  // A drag that ends at the very start of a line has not selected that line.
  const end = $to.parentOffset === 0 && sel.to > sel.from ? sel.to - 1 : sel.to
  const range = topLevelRange(state, sel.from, end)
  return blockTarget(view, range.from, range.to)
}

/** Run Encrypt… on the view's selection. */
export async function encryptSelection(view: EditorView): Promise<boolean> {
  const target = encryptTarget(view)
  if (target.kind === 'refused') {
    await showError(target.reason)
    return false
  }
  return target.kind === 'field' ? encryptField(view, target) : encryptBlocks(view, target.from, target.to)
}

/**
 * Encrypt… from the block context menu on the top-level block at `pos`: that block,
 * widened to the selection when the selection reaches into it.
 */
export async function encryptBlockAt(view: EditorView, pos: number): Promise<boolean> {
  const node = view.state.doc.nodeAt(pos)
  if (!node) return false
  let from = pos
  let to = pos + node.nodeSize
  const sel = view.state.selection
  if (!sel.empty && sel.from < to && sel.to > from) {
    const range = topLevelRange(view.state, sel.from, sel.to)
    from = Math.min(from, range.from)
    to = Math.max(to, range.to)
  }
  const target = blockTarget(view, from, to)
  if (target.kind === 'refused') {
    await showError(target.reason)
    return false
  }
  return encryptBlocks(view, from, to)
}

async function encryptField(view: EditorView, target: { from: number; to: number; value: string }): Promise<boolean> {
  const secret = await promptForNewSecret(target.value)
  if (!secret) return false
  const node = view.state.schema.nodes[MASKED_TYPE]!.create({ content: secret.envelope, label: secret.label })
  const tr = view.state.tr.replaceRangeWith(target.from, target.to, node)
  // The user just typed the value and the password: render it revealed until they
  // hide it. Primed before the dispatch so the new node's view consumes it.
  if (secret.showValueInitially) primeMaskedFieldReveal(secret.envelope, secret.password, secret.value)
  view.dispatch(tr)
  view.focus()
  return true
}

async function encryptBlocks(view: EditorView, from: number, to: number): Promise<boolean> {
  const request = await promptForEncrypt({ kind: 'block' })
  if (request === null) return false
  const { state } = view
  const markdown = sliceMarkdown(state.doc.slice(from, to).content, state.schema, formulaEnvFor(state))
  const envelope = await encryptFieldVerified(markdown, request.password)
  const encrypted = state.schema.nodes.encrypted_block!.create({ label: request.label, content: envelope })
  view.dispatch(view.state.tr.replaceWith(from, to, encrypted))
  view.focus()
  // A fresh block arrives unlocked unless "Lock immediately" was chosen.
  if (!request.lockImmediately) unlockEncryptedBlockAt(view, from, request.password)
  return true
}
