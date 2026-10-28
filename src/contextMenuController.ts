import { redo as cmRedo, undo as cmUndo } from '@codemirror/commands'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { redoDepth, undoDepth } from 'prosemirror-history'
import { TextSelection } from 'prosemirror-state'
import type { EditorView as ProseEditorView } from 'prosemirror-view'

import { showError } from './bridge'
import {
  blockFormMode,
  blockModeFor,
  interactionLabels,
  modeFor,
  setBlockForm,
  toggleBlockMode,
} from './block-modes'
import { copyText, readText } from './clipboard'
import type { ContextMenuEntry, ContextMenuItem } from './contextmenu'
import { encryptFieldVerified } from './crypto'
import { promptForEncryptedBlockLabel, promptForNewPassword } from './crypto-dialog'
import { linkRangeAt, type LinkRange } from './editor'
import { fileName, UNTITLED } from './files'
import { formulaEnvFor } from './formulaDefs'
import { serializeBlock } from './markdown'
import { copyMermaidAsImage, saveMermaidAsImage } from './mermaid'
import { unlockEncryptedBlockAt } from './node/encryptedblock'
import { spreadsheetMenuEntries } from './node/table'
import { pressTarget } from './press'
import { getActive } from './state'
import { applyLink } from './toolbar'
import { promptForLink } from './urlDialog'
import type { AppContext } from './appContext'
import type { EditController } from './editController'

export interface ContextMenuController {
  buildContextMenu(event: MouseEvent): ContextMenuEntry[]
  buildInputMenu(input: HTMLInputElement | HTMLTextAreaElement): ContextMenuEntry[]
  buildDocumentMenu(target?: Element | null): ContextMenuEntry[]
  buildBlockMenuItems(target: Element, event: MouseEvent): ContextMenuEntry[]
  encryptBlockCommand(): void
}

/**
 * The context menus, built from the block's own descriptor rather than from a
 * chain on its wrapper class names.
 *
 * The controller receives the edit controller because the document menu's Cut,
 * Copy, Paste and undo items are those same commands — one spelling, not a second
 * copy that could grey out differently.
 */
export function createContextMenuController(
  ctx: AppContext,
  edit: EditController,
): ContextMenuController {
  /**
   * Build the right-click menu for a point in the document. Spreadsheet text
   * inputs get editing commands scoped to the cell; other spreadsheet targets
   * (a selected cell, the chrome) get only the spreadsheet actions, since the
   * generic document commands would silently act on the whole table block.
   * Everything else gets the standard editing commands plus any block-specific
   * actions for the element under the pointer.
   */
  function buildContextMenu(event: MouseEvent): ContextMenuEntry[] {
    const target = event.target instanceof Element ? event.target : null
    const input = target?.closest<HTMLInputElement | HTMLTextAreaElement>('.ss-edit-input, .ss-fx-input, .masked-field-input, .mermaid-edit-input') ?? null
    let entries: ContextMenuEntry[]
    if (input) {
      entries = buildInputMenu(input)
    } else if (target?.closest('.cm-editor')) {
      entries = buildSourceEditorMenu(target)
    } else if (target?.closest('.spreadsheet, .ss-plain')) {
      // The node view owns the grid's editing commands; the plain/read-only
      // view has none, so it falls through to the block actions alone.
      entries = spreadsheetMenuEntries(target) ?? []
    } else {
      entries = buildDocumentMenu(target)
    }
    if (target) {
      const blockEntries = buildBlockMenuItems(target, event)
      if (blockEntries.length > 0) {
        if (entries.length > 0) entries.push({ type: 'separator' })
        entries.push(...blockEntries)
      }
    }
    return entries
  }

  /** Standard editing commands scoped to the focused spreadsheet input. */
  function buildInputMenu(input: HTMLInputElement | HTMLTextAreaElement): ContextMenuEntry[] {
    const hasSelection = input.selectionStart !== input.selectionEnd
    const canUndo = typeof document.execCommand === 'function'
    return [
      {
        type: 'item',
        label: 'Undo',
        disabled: !canUndo,
        onSelect: () => runInputHistory(input, 'undo'),
      },
      {
        type: 'item',
        label: 'Redo',
        disabled: !canUndo,
        onSelect: () => runInputHistory(input, 'redo'),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Cut',
        disabled: !hasSelection,
        onSelect: () => cutInput(input),
      },
      {
        type: 'item',
        label: 'Copy',
        disabled: !hasSelection,
        onSelect: () => copyInput(input),
      },
      { type: 'item', label: 'Paste', onSelect: () => void pasteIntoInput(input) },
      { type: 'item', label: 'Select all', onSelect: () => input.select() },
    ]
  }

  function inputSelection(input: HTMLInputElement | HTMLTextAreaElement): { text: string; start: number; end: number } {
    const start = input.selectionStart ?? 0
    const end = input.selectionEnd ?? start
    return { text: input.value.slice(start, end), start, end }
  }

  function runInputHistory(input: HTMLInputElement | HTMLTextAreaElement, command: 'undo' | 'redo'): void {
    input.focus()
    if (typeof document.execCommand === 'function') document.execCommand(command)
  }

  function copyInput(input: HTMLInputElement | HTMLTextAreaElement): void {
    const { text } = inputSelection(input)
    if (text) void copyText(text)
  }

  function cutInput(input: HTMLInputElement | HTMLTextAreaElement): void {
    const { text, start, end } = inputSelection(input)
    if (!text) return
    void copyText(text)
    input.setRangeText('', start, end, 'start')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }

  /** Standard editing commands scoped to the right-clicked CodeMirror source editor. */
  function buildSourceEditorMenu(target: Element): ContextMenuEntry[] {
    const el = target.closest<HTMLElement>('.cm-editor')
    const cmView = el ? EditorView.findFromDOM(el) : null
    const sel = cmView?.state.selection.main
    const hasSelection = !!sel && !sel.empty
    return [
      { type: 'item', label: 'Undo', onSelect: () => { if (cmView) cmUndo(cmView) } },
      { type: 'item', label: 'Redo', onSelect: () => { if (cmView) cmRedo(cmView) } },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Cut',
        disabled: !hasSelection,
        onSelect: () => {
          if (!cmView || !sel || sel.empty) return
          void copyText(cmView.state.sliceDoc(sel.from, sel.to))
          cmView.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
          cmView.focus()
        },
      },
      {
        type: 'item',
        label: 'Copy',
        disabled: !hasSelection,
        onSelect: () => {
          if (!cmView || !sel || sel.empty) return
          void copyText(cmView.state.sliceDoc(sel.from, sel.to))
          cmView.focus()
        },
      },
      {
        type: 'item',
        label: 'Paste',
        onSelect: () => {
          if (!cmView) return
          void readText().then((text) => {
            if (text === null) return
            const range = cmView.state.selection.main
            cmView.dispatch({ changes: { from: range.from, to: range.to, insert: text } })
            cmView.focus()
          })
        },
      },
      { type: 'item', label: 'Select all', onSelect: () => cmView?.dispatch({ selection: EditorSelection.single(0, cmView.state.doc.length) }) },
    ]
  }

  async function pasteIntoInput(input: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
    const text = await readText()
    if (text === null || text === '') return
    const { start, end } = inputSelection(input)
    input.setRangeText(text, start, end, 'end')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }

  function buildDocumentMenu(target: Element | null = null): ContextMenuEntry[] {
    const view = ctx.blockEditor?.getView()
    // Only offer undo/redo when there is actually history to traverse; a
    // enabled-but-no-op Redo just looks broken.
    const undoable = !!view && undoDepth(view.state) > 0
    const redoable = !!view && redoDepth(view.state) > 0
    const entries: ContextMenuEntry[] = [
      { type: 'item', label: 'Undo', disabled: !undoable, onSelect: () => edit.undo() },
      { type: 'item', label: 'Redo', disabled: !redoable, onSelect: () => edit.redo() },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Cut',
        disabled: !edit.hasSelection(),
        onSelect: () => edit.cut(),
      },
      {
        type: 'item',
        label: 'Copy',
        disabled: !edit.hasSelection(),
        onSelect: () => edit.copy(),
      },
      {
        type: 'item',
        label: 'Copy as Markdown',
        disabled: !edit.hasSelection(),
        onSelect: () => edit.copyAsMarkdown(),
      },
      { type: 'item', label: 'Paste', onSelect: () => void edit.paste() },
      { type: 'item', label: 'Paste as Markdown', onSelect: () => void edit.pasteAsMarkdown() },
      { type: 'item', label: 'Select all', onSelect: () => edit.selectAll() },
    ]
    // A right-click on a link is how it is edited: a left-click opens it, and
    // the click plugin ignores every other button (see `createBlockEditor`), so
    // the context menu is the only place left to change one.
    const link = linkRangeForTarget(target)
    if (link) {
      entries.push(
        { type: 'item', label: 'Copy link', onSelect: () => void copyLink(link) },
        { type: 'separator' },
        { type: 'item', label: 'Edit link…', onSelect: () => editLink(link) },
      )
    }
    return entries
  }

  /** The link the right-click landed on, as its document range. */
  function linkRangeForTarget(target: Element | null): LinkRange | null {
    const view = ctx.blockEditor?.getView()
    const anchor = target?.closest('a[href]')
    if (!view || !anchor || !view.dom.contains(anchor)) return null
    // The <a> ProseMirror drew *is* the mark's range, so the position at its
    // first child is a position inside the link -- which is all `linkRangeAt`
    // needs to walk out to the rest of the linked text, however many text nodes
    // emphasis in the label split it into.
    return linkRangeAt(view.state.doc, view.posAtDOM(anchor, 0))
  }

  /**
   * Copy the link covering `link`, the context menu's "Copy link".
   *
   * The href is the one in the document (a relative markdown target stays
   * relative), so what lands on the clipboard is what the source says, not a
   * URL resolved against the app. The range is read at menu-build time for the
   * same reason `editLink` does: that is the only moment the right-click's
   * target is around, and copying cannot move it anyway.
   */
  async function copyLink(link: LinkRange): Promise<void> {
    if (await copyText(link.href)) ctx.flashStatus(`Copied ${link.href}`)
  }

  /**
   * Edit the link covering `link`, the context menu's "Edit link…".
   *
   * The range is resolved when the menu is built, because that is the only
   * moment the right-click's target element is around. The dialog's overlay
   * covers the editor, so nothing can move the link while it is up; it is
   * re-checked against the document once the dialog settles regardless, so a
   * range that no longer holds a link marks nothing at all.
   */
  function editLink(link: LinkRange): void {
    const view = ctx.blockEditor?.getView()
    if (!view) return
    void promptForLink(link.text, link.href, { editing: true }).then((entered) => {
      if (entered === null) return
      const current = linkRangeAt(view.state.doc, link.from)
      if (!current) return
      // `applyLink` writes over the selection, so the range is selected first.
      // It also leaves the linked text selected, which is where the toolbar's
      // Link button picks the same link up from.
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, current.from, current.to)),
      )
      view.focus()
      applyLink(view, entered.url, entered.text)
    })
  }

  /**
   * The block items of the context menu, generated from the block's own descriptor
   * rather than from a chain on its wrapper class names.
   *
   * Three names existed for source mode and two each for a diagram's edit mode and
   * a table's rendered form, all of them spelled per call site; and the block was
   * identified by a `data-block-pos` written into its dot grid when that grid was
   * built. Both problems have the same fix: ask `blockModeFor` what the block
   * supports, and ask the DOM for where the block is now. A right-click inside a
   * list item or a blockquote reaches this too, and works precisely because it no
   * longer needs a handle to identify the block it is in (§6.7).
   */
  function buildBlockMenuItems(target: Element, event: MouseEvent): ContextMenuEntry[] {
    const view = ctx.blockEditor?.getView()
    if (!view) return []
    const entries: ContextMenuEntry[] = []
    const addItem = (
      label: string,
      onSelect: () => void,
      extra: Partial<Pick<ContextMenuItem, 'disabled' | 'danger'>> = {},
    ): void => {
      entries.push({ type: 'item', label, onSelect, ...extra })
    }

    // **The press is classified, not sniffed** (`src/press.ts`): the menu is offered for the block
    // the press names, and for nothing else.
    const press = pressTarget(view, event)
    if (press.kind !== 'content' && press.kind !== 'margin') return entries
    const pos = press.pos
    const node = view.state.doc.nodeAt(pos)
    if (node === null) return entries
    // The wrapper is still needed for two things that are about the *rendering*,
    // not the mode: a diagram's image to copy, and a runnable block's own controls.
    const wrapper = blockWrapperFor(view, target)

    const img = wrapper?.querySelector<HTMLImageElement>('.mermaid-img') ?? null
    const svg = wrapper?.querySelector<SVGSVGElement>('.mermaid svg[id]') ?? null
    if (img ?? svg) {
      addItem('Copy image', () => {
        void copyMermaidAsImage(img ?? (svg as SVGSVGElement)).then((result) => {
          if (!result.ok) showError(result.error ?? 'Could not copy image')
        })
      })
      addItem('Save image…', () => {
        const active = getActive()
        const base = active?.path ? fileName(active.path) : UNTITLED
        void saveMermaidAsImage(img ?? (svg as SVGSVGElement), base).then((result) => {
          if (!result.ok) {
            showError(result.error ?? 'Could not save image')
          } else if (result.path) {
            ctx.flashStatus(`Saved ${result.path}`)
          }
        })
      })
    }

    const runnable = wrapper?.closest('.runnable-block') ?? null
    if (runnable) {
      const runButton = runnable.querySelector<HTMLButtonElement>('.exec-run')
      if (runButton) {
        const running = runButton.classList.contains('exec-stop')
        addItem(running ? 'Stop' : 'Run', () => runButton.click())
      }
      const source = runnable.querySelector<HTMLElement>('.runnable-source')
      if (source?.textContent !== null && source?.textContent !== undefined) {
        const text = source.textContent
        addItem('Copy source', () => {
          void copyText(text)
        })
      }
    }

    const descriptor = blockModeFor(node)

    // A table's rendered form, labelled from the descriptor's own form list.
    if (descriptor.forms) {
      // The record, not the table node view: a form is plugin state now, so asking
      // `block-modes` for it is the direction the dependency should run — and it is
      // the only one that works from the mocked module boundary anyway.
      const current = blockFormMode(view.state, pos) ?? 'text'
      const other = descriptor.forms.find((form) => form.id !== current)
      if (other) addItem(other.label, () => setBlockForm(view, pos, other.id))
    }

    if (descriptor.interaction === 'toggle') {
      // The axis's own words, from the one declaration the cluster button reads too —
      // so a block whose edit step is unlocking is not also `Edit` in its menu.
      const labels = interactionLabels(node.type.name)
      const editing = modeFor(view.state, pos)?.interaction === 'editing'
      addItem(editing ? labels.active : labels.idle, () => {
        toggleBlockMode(view, pos, 'interaction')
      })
    }
    if (descriptor.representation) {
      const source = modeFor(view.state, pos)?.representation === 'source'
      addItem(source ? 'Visual' : 'Source', () => {
        toggleBlockMode(view, pos, 'representation')
      })
    }
    if (node.type.name !== 'encrypted_block') {
      addItem('Encrypt block…', () => { void encryptBlockAt(view, pos) })
    }
    return entries
  }

  /** The top-level block's own wrapper element, for the items about its rendering. */
  function blockWrapperFor(view: ProseEditorView, target: Element): HTMLElement | null {
    let el: Element | null = target
    while (el && el !== view.dom && el.parentElement !== view.dom) {
      el = el.parentElement
    }
    return el instanceof HTMLElement && el !== view.dom ? el : null
  }

  function encryptBlockCommand(): void {
    const view = ctx.blockEditor?.getView()
    if (!view) return
    const selPos = view.state.selection.from
    let blockPos = -1
    view.state.doc.forEach((node, offset) => {
      if (blockPos >= 0) return
      if (selPos >= offset && selPos <= offset + node.nodeSize) blockPos = offset
    })
    if (blockPos < 0) return
    void encryptBlockAt(view, blockPos)
  }

  async function encryptBlockAt(view: ProseEditorView, pos: number): Promise<void> {
    const node = view.state.doc.nodeAt(pos)
    if (!node) return
    const labelResult = await promptForEncryptedBlockLabel(node.type.name)
    if (labelResult === null) return
    const label = labelResult.label
    const lockImmediately = labelResult.lockImmediately
    const password = await promptForNewPassword(label || node.type.name, { okText: 'Encrypt', title: 'Set password' })
    if (password === null) return
    const markdown = serializeBlock(node, formulaEnvFor(view.state))
    const envelope = await encryptFieldVerified(markdown, password)
    const encrypted = view.state.schema.nodes.encrypted_block.create({ type: node.type.name, label, content: envelope })
    view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, encrypted))
    view.focus()
    // Unless "Lock immediately" was chosen, freshly encrypted blocks arrive
    // unlocked (no second lock).
    if (!lockImmediately) unlockEncryptedBlockAt(view, pos, password)
  }

  return {
    buildContextMenu,
    buildInputMenu,
    buildDocumentMenu,
    buildBlockMenuItems,
    encryptBlockCommand,
  }
}
