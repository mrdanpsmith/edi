import { selectAll as cmSelectAll } from '@codemirror/commands'
import { EditorView as CMEditorView } from '@codemirror/view'
import { selectAll } from 'prosemirror-commands'
import { redoNoScroll, undoNoScroll } from 'prosemirror-history'
import type { EditorView as ProseEditorView } from 'prosemirror-view'

import { hasBridge, invoke } from './bridge'
import { copyText, readText, writeClipboard } from './clipboard'
import { selectionMarkdownFor } from './editor'
import { getActiveEncryptedBlockView } from './node/encryptedblock'
import { selectAllInSpreadsheet } from './node/table'
import { insertPastedText, pasteAsMarkdown } from './paste'
import { snapshotMermaidHtml } from './mermaid-export'
import { computeSpreadsheet } from './spreadsheet'
import { formulaEnvFor } from './formulaDefs'
import { plainTableSelectionText } from './tableTextSelection'
import type { AppContext } from './appContext'

export interface EditController {
  focusedEditor(): ProseEditorView | null
  focusIsForeign(): boolean
  undo(): void
  redo(): void
  cut(): void
  copy(): void
  copyAsMarkdown(): void
  paste(): Promise<void>
  pasteAsMarkdown(): Promise<void>
  selectAll(): void
  hasSelection(): boolean
}

/**
 * Is a dialog, a CodeMirror buffer or a form field holding the caret?
 *
 * Clipboard shortcuts must not be taken from any of them. Each has its own: a
 * masked field's revealed input, a spreadsheet cell editor, the raw-markdown editor
 * in a block's Source form — and a document-level Copy in the middle of one would
 * either copy the wrong thing or nothing.
 *
 * **A revealed encrypted block is deliberately *not* on this list**, even though it
 * is a whole second editor holding a selection of its own, and its comment is the
 * failure this function exists to prevent. Standing down here is the obvious
 * reading of "let the innermost editor keep the key" and it is wrong: the reveal's
 * DOM selection spans a block boundary happily — a drag from the outer prose into
 * the reveal puts the plaintext in `getSelection().toString()` while nothing on
 * screen paints it — so a native copy that runs from here can put a decrypted
 * secret on the clipboard with nothing to say so. The block is an *object* and the
 * clipboard has to agree with the paint.
 *
 * So the key is not declined, it is **routed**: `focusedEditor()` resolves the
 * editor the caret is really in and the command acts on that editor's own
 * selection, which is inside the block by construction. That is the rule this
 * function's docstring used to imply and now states — every document command
 * resolves to the editor that has focus, and the *hosts that are not documents*
 * are the ones it stays out of the way of.
 */
function focusIsForeign(): boolean {
  const active = document.activeElement
  return (
    active instanceof HTMLElement &&
    !!active.closest('.edi-dialog-overlay, .cm-editor, input, textarea')
  )
}

/**
 * The editor a document command belongs to: **the one that has the caret.**
 *
 * A revealed encrypted block is a whole second `EditorView` — the document's own
 * `createBlockEditor`, with the whole plugin stack — nested inside this one. The
 * document commands were bound to *one* editor (`blockEditor`), and nothing in
 * that path could ask which editor has focus, so a command run from inside a
 * reveal acted on a document the reader is not in: `Ctrl+C` read the outer
 * (always empty) selection and did nothing at all, and `Ctrl+X` would
 * additionally have yanked the caret out of the block the reader was standing in.
 *
 * **The toolbar already did this** — `getActiveEncryptedBlockView() ?? getView()` —
 * and it is why find and the clipboard were the inconsistencies rather than the
 * other way round. This function is that composition, named, so there is one
 * answer to "which editor is this command about" instead of three call sites
 * spelling it.
 *
 * It is read at the moment the command runs, not cached: focus is a per-interaction
 * fact, so where the reader is working has to be asked fresh. (What should *recede*
 * is the other question, and it is a per-page fact answered from the record — see
 * the working-state dimming.)
 */
function focusedEditor(ctx: AppContext): ProseEditorView | null {
  return getActiveEncryptedBlockView() ?? ctx.blockEditor?.getView() ?? null
}

/**
 * The selection as the **rich** clipboard copy carries it: ProseMirror's own
 * `serializeForClipboard` output — which is the schema's `toDOM`, where a table
 * is a real grid carrying its pipes on an attribute (`richTableDom`) — with the
 * formulas a copied table's cells would show on screen solved into view values.
 *
 * The solve does not touch the document and cannot lose a formula: it repaints
 * cells *inside the detached serialization*, while the raw pipes sit untouched
 * on the `data-edi-table` attribute it renders them from, which is exactly where
 * this app's paste parser reads a copied table back from. Confluence and Docs
 * take the resolved grid; this app takes the formulas it was written with.
 */
function richSelectionHtml(
  view: ProseEditorView,
): { dom: HTMLElement; text: string } {
  const { dom, text } = view.serializeForClipboard(view.state.selection.content())
  computeSpreadsheet(dom, formulaEnvFor(view.state))
  return { dom, text }
}

/**
 * The controller for the commands the app owns itself: undo/redo off the menu,
 * and Cut / Copy / Paste and Select all.
 *
 * **`copy` has one route that does not go through the editor, and it is the one a
 * Visual table's cells answer.** A `table` node is an atom with no content, so the
 * document selection cannot hold "three characters of that cell" — but the browser's
 * range can, and it is what the reader is looking at when they press the key.
 * `plainTableSelectionText()` asks whether that is the selection in question and returns
 * the text a normal editor would have put on the clipboard; see
 * `src/tableTextSelection.ts` for the measurement behind it, which is also why the text
 * comes from the range rather than from `Selection.toString()`.
 *
 * It is deliberately **text, not the table's markdown**: what is selected is what was
 * drawn, and a fragment of a cell is not a table. `Ctrl+Shift+C` is the key that copies
 * markdown, and it still copies the editor's own selection.
 */
export function createEditController(ctx: AppContext): EditController {
  let richClipboardTicket = 0

  function writeRichClipboard(
    dom: HTMLElement,
    text: string,
    markdown: string,
  ): void {
    const ticket = ++richClipboardTicket
    if (!dom.querySelector('[data-mermaid-block]')) {
      void writeClipboard({ html: dom.innerHTML, text, markdown })
      return
    }
    void (async () => {
      await snapshotMermaidHtml(dom)
      if (ticket !== richClipboardTicket) return
      await writeClipboard({ html: dom.innerHTML, text, markdown })
    })()
  }

  function pasteEvent(): ClipboardEvent {
    return typeof ClipboardEvent === 'function'
      ? new ClipboardEvent('paste')
      : ({ clipboardData: null } as unknown as ClipboardEvent)
  }

  // Menu-triggered undo/redo must not scroll: the transaction is dispatched with
  // scrollIntoView=false so the viewport stays put (undoNoScroll/redoNoScroll).
  // Reaching for the menu (or a context menu) means the pointer is away from the
  // content, so yanking the viewport to the restored selection is disorienting;
  // keyboard undo keeps its scroll-to-change behavior via the editor keymap.
  function undo(): void {
    const view = ctx.blockEditor?.getView()
    if (view) {
      view.focus()
      undoNoScroll(view.state, view.dispatch, view)
    }
  }

  function redo(): void {
    const view = ctx.blockEditor?.getView()
    if (view) {
      view.focus()
      redoNoScroll(view.state, view.dispatch, view)
    }
  }

  function cut(): void {
    const view = focusedEditor(ctx)
    if (!view) return
    // **A cut of selected table text does nothing, rather than cutting something else.**
    // The document selection is not what the reader has selected — it cannot be — so the
    // deletion below would take out whatever was selected *before* the drag, somewhere
    // else in the document. Refusing is the only answer that cannot delete a selection
    // nobody made.
    if (plainTableSelectionText() !== null) return
    if (view.state.selection.empty) return
    view.focus()
    const { dom, text } = richSelectionHtml(view)
    const markdown = selectionMarkdownFor(view)
    view.dispatch(view.state.tr.deleteSelection())
    void writeRichClipboard(dom, text, markdown)
  }

  function copy(): void {
    const view = focusedEditor(ctx)
    if (!view) return
    const tableText = plainTableSelectionText()
    if (tableText !== null) {
      void copyText(tableText)
      return
    }
    if (view.state.selection.empty) return
    view.focus()
    const { dom, text } = richSelectionHtml(view)
    void writeRichClipboard(dom, text, selectionMarkdownFor(view))
  }

  function copyAsMarkdown(): void {
    const view = focusedEditor(ctx)
    if (!view || view.state.selection.empty) return
    view.focus()
    void copyText(selectionMarkdownFor(view))
  }

  async function paste(): Promise<void> {
    const view = focusedEditor(ctx)
    if (!view) return
    let html: string | null = null
    let text: string | null = null
    let markdown: string | null = null
    if (hasBridge()) {
      const data = await invoke<{ text: string; html: string; markdown?: string }>('readClipboardText')
      html = data?.html || null
      text = data?.text || null
      markdown = data?.markdown || null
    } else {
      try {
        const items = await navigator.clipboard.read()
        for (const item of items) {
          if (item.types.includes('text/html')) {
            html = await item.getType('text/html').then((b) => b.text())
          }
          if (item.types.includes('text/plain')) {
            text = await item.getType('text/plain').then((b) => b.text())
          }
          if (item.types.includes('text/markdown')) {
            markdown = await item.getType('text/markdown').then((b) => b.text())
          }
        }
      } catch {
        return
      }
    }
    view.focus()
    // **An Edi-to-Edi copy carries its selection as markdown, and that is the leg
    // this app reads.** The HTML leg is for other apps (a mermaid block is a PNG
    // there), so parsing it back would turn the diagram into a picture; the
    // markdown leg is the document's own words, mermaid source included.
    if (markdown && markdown.trim() !== '' && pasteAsMarkdown(view, markdown)) {
      return
    }
    // Rich media first: pasteHTML runs ProseMirror's full clipboard parser, which
    // preserves formatting (bold, links, code) and turns block HTML (our own
    // serializeForClipboard output) into real paragraphs. Only fall back to plain
    // text when no HTML is available (insertPastedText handles line breaks and
    // linkifies bare URLs).
    if (html && html.trim() !== '') {
      view.pasteHTML(html, pasteEvent())
    } else if (text && text.trim() !== '') {
      insertPastedText(view, text)
    }
  }

  async function pasteAsMarkdownCommand(): Promise<void> {
    const view = focusedEditor(ctx)
    if (!view) return
    view.focus()
    const text = await readText()
    if (!pasteAsMarkdown(view, text)) await paste()
  }

  /**
   * Select all — in **the editor the reader is in**, and without taking the caret out of
   * a grid that has it.
   *
   * The first half is the same rule as the clipboard: a command bound to one editor is
   * wrong the moment there is a second one, and `Ctrl+A` inside an open encrypted block
   * used to select the document around it rather than the block the reader was standing
   * in. The second half is the part that is only right because of it: routing through the
   * focus resolver means a spreadsheet grid now resolves to the editor *containing* it,
   * and the old unconditional `view.focus()` would have pulled the caret out of a grid
   * the reader had a cell selected in — the two-selections state in reverse.
   */
  function editSelectAll(): void {
    // The menu and `Ctrl+A` both land here (`registerShortcuts` takes the key before any
    // widget sees it), so this is the one answer to "select all in what?". A code editor
    // selects its own text and a live sheet its own cells — never the document around
    // them, which would put a second selection on screen while the reader works inside one.
    const active = document.activeElement
    const cm = active?.closest<HTMLElement>('.cm-editor')
    const cmView = cm ? CMEditorView.findFromDOM(cm) : null
    if (cmView) {
      cmSelectAll(cmView)
      return
    }
    if (selectAllInSpreadsheet(active)) return
    if (active?.closest('.ss-plain')) return
    const view = focusedEditor(ctx)
    if (!view) return
    const scrollTop = ctx.roots.editorContainer.scrollTop
    view.focus()
    selectAll(view.state, view.dispatch)
    // selectAll scrolls the full-document selection into view (the bottom),
    // which jump-scrolls the editor. Restore the prior scroll position on the
    // next frame once ProseMirror has performed its scrollIntoView.
    requestAnimationFrame(() => {
      ctx.roots.editorContainer.scrollTop = scrollTop
    })
  }

  /**
   * Is there a selection to copy or cut?
   *
   * **Or one the editor cannot see.** A Visual table's cells are selected by the browser,
   * because the document model cannot hold that at all (`src/tableTextSelection.ts`), so
   * asking the editor alone leaves Edit → Copy greyed out at the exact moment the reader
   * has something selected — and it would be *enabled* by the stale selection a drag like
   * that leaves behind, which is worse.
   */
  function hasEditorSelection(): boolean {
    if (plainTableSelectionText() !== null) return true
    const selection = focusedEditor(ctx)?.state.selection
    return !!selection && !selection.empty
  }

  return {
    focusedEditor: () => focusedEditor(ctx),
    focusIsForeign,
    undo,
    redo,
    cut,
    copy,
    copyAsMarkdown,
    paste,
    pasteAsMarkdown: pasteAsMarkdownCommand,
    selectAll: editSelectAll,
    hasSelection: hasEditorSelection,
  }
}
