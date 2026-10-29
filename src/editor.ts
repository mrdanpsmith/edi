import { EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { Slice, type Node as ProseNode } from 'prosemirror-model'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import { gapCursor } from 'prosemirror-gapcursor'
import { dropCursor } from 'prosemirror-dropcursor'
import { blockStartKeymap, blockStartRules } from './blockstart'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown, sliceMarkdown } from './markdown'
import {
  blockModeFocusPlugin,
  blockModePlugin,
  commitSourceMode,
  currentBlockMode,
  forgetView,
  keepOneNonVisualBlock,
  enterSourceMode,
  exitBlockMode,
  leaveBlockMode,
  releaseDisplacedBlock,
} from './block-modes'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { blockDragPlugin } from './blockDrag'
import { pressPlugin } from './press'
import { codeBlockNodeViewPlugin } from './node/execblock'
import { codeBlockExitPlugin } from './codeBlockExit'
import { mermaidNodeViewPlugin } from './node/mermaid'
import { tableNodeViewPlugin } from './node/table'
import { formulaDefsPlugin, formulaEnvFor } from './formulaDefs'
import { maskedFieldNodeViewPlugin } from './node/masked'
import {
  discardOpenReveals,
  encryptedBlockNodeViewPlugin,
  flushOpenReveals,
} from './node/encryptedblock'
import { highlight } from './remark/highlight'
import { subscript } from './remark/sub'
import { superscript } from './remark/sup'
import { taskClickPlugin, toggleTaskItems, blockTypeSelectPlugin } from './toolbar'
import { markExitPlugin, stopMarking } from './markExit'
import { selectionExpandKeymap, selectionExpandPlugin, selectionHighlightPlugin, clipboardTextPlugin, isSelectionAtom } from './selectionExpand'
import { forgetPlainTableSelection } from './tableTextSelection'
import { emojiPlugin } from './emojiPlugin'
import { insertPastedText, containsRawUrl } from './paste'
import { isMisleadingLink } from './linkSecurity'
import { imageNodeView, reResolveImages, type ResolveImage } from './image'
import { searchPlugin } from './search'

function inlineMarkRules(): InputRule[] {
  function markRule(pattern: RegExp, markType: import('prosemirror-model').MarkType): InputRule {
    return stopMarking(
      new InputRule(pattern, (state, match, start, end) => {
        if (match[1]) {
          return state.tr.replaceWith(start, end, state.schema.text(match[1], [markType.create()]))
        }
        return state.tr
      }),
      markType,
    )
  }

  // Every pair of delimiters ends its mark at the closing one, and the caret
  // leaves it there rather than staying inside the run it just made — see
  // `markExit.ts`, which owns that rule and the arrow keys that leave a mark
  // the same way. The lookbehind on each opening delimiter is what keeps a
  // rule from matching inside a *longer* run of the same character and firing
  // early, which is how `~~strike~~` used to become a subscript.
  return [
    markRule(/(?<!\*)\*\*([^*]+)\*\*$/, schema.marks.strong),
    markRule(/(?<!\*)\*([^*]+)\*(?!\*)$/, schema.marks.em),
    markRule(/(?<!`)`([^`]+)`$/, schema.marks.code),
    markRule(/(?<!~)~~([^~]+)~~$/, schema.marks.strikethrough),
    stopMarking(highlight.createInputRule(schema), schema.marks.highlight),
    stopMarking(subscript.createInputRule(schema), schema.marks.sub),
    stopMarking(superscript.createInputRule(schema), schema.marks.sup),
  ]
}

function createInputRules() {
  return inputRules({ rules: [...inlineMarkRules(), ...blockStartRules()] })
}

const undoKeymap = keymap({
  'Mod-z': (state, dispatch, view) => {
    if (!dispatch) return false
    return undo(state, dispatch, view)
  },
  'Mod-Shift-z': (state, dispatch, view) => {
    if (!dispatch) return false
    return redo(state, dispatch, view)
  },
  'Mod-y': (state, dispatch, view) => {
    if (!dispatch) return false
    return redo(state, dispatch, view)
  },
})

const listKeymap = keymap({
  'Enter': splitListItem(schema.nodes.list_item),
  'Backspace': (state, dispatch) => {
    if (dispatch && state.selection.empty && state.selection.$from.parent.type.name === 'list_item' && state.selection.$from.parent.content.size === 0) {
      return liftListItem(schema.nodes.list_item)(state, dispatch)
    }
    return false
  },
  'Tab': sinkListItem(schema.nodes.list_item),
  'Shift-Tab': liftListItem(schema.nodes.list_item),
  'Mod-Shift-x': (_state, dispatch, view) => {
    if (!dispatch || !view) return false
    return toggleTaskItems(view)
  },
})

const formattingKeymap = keymap({
  'Mod-b': toggleMark(schema.marks.strong),
  'Mod-i': toggleMark(schema.marks.em),
  'Alt-Mod-c': toggleMark(schema.marks.code),
})

const blockToggleKeymap = keymap({
  'Mod-Shift-e': (state, dispatch, view) => {
    if (!dispatch || !view) return false
    // Any open source block is closed, not moved: the caret may well be in a
    // different block, and opening *that* one as a side effect of asking to
    // close the first would be a surprise.
    if (currentBlockMode(state) !== null) {
      if (!leaveBlockMode(view, currentBlockMode(state)!.pos)) return false
      return true
    }

    let blockPos = -1
    state.doc.forEach((_node, offset) => {
      const end = offset + _node.nodeSize
      if (state.selection.from >= offset && state.selection.from < end) {
        blockPos = offset
      }
    })

    if (blockPos < 0) return false

    enterSourceMode(view, blockPos)
    return true
  },
  // One rung, and it is the only one (§5.3): a block in its **source** form
  // commits and returns to its rendering. Everything else hands Escape straight
  // on — which is what leaves selection handling, dialogs, the spreadsheet's own
  // cell editor and a diagram's own Escape alone.
  //
  // Escape is deliberately **not** a way round a block's other mode. Leaving a
  // diagram's editing layer, or dropping a sheet back to plain text, is a move
  // between modes rather than a cancellation, so it is the Alt+click gesture's
  // business (§5.2) and the controls on the block's; a key that undid either
  // would be answering "cancel" for two different questions.
  'Escape': (_state, dispatch, view) => {
    if (!dispatch || !view) return false
    return exitBlockMode(view)
  },
})

export interface BlockEditor {
  getView(): EditorView
  getMarkdown(): string
  /** Markdown source of the current selection ("Copy as Markdown"). */
  getSelectionMarkdown(): string
  /**
   * Swap in a different document.
   *
   * **Returns a promise because the swap has to wait for something.** An open
   * encrypted block holds its plaintext in a nested editor that `updateState` is about
   * to destroy, and encrypting it back is `crypto.subtle`'s asynchronous work — so a
   * swap that did not wait would either drop the last half-second of typing or, worse,
   * dispatch the write at a stale position into the document arriving. See
   * `flushOpenReveals`, which is what this awaits and why it is not optional.
   */
  setMarkdown(markdown: string): void | Promise<void>
  insertMarkdown(markdown: string): void
  commitSource(): boolean
  // Per-tab editor state: each document owns its own ProseMirror EditorState
  // (doc, undo/redo history, selection). Tabs swap whole states into the view.
  createState(markdown: string): EditorState
  getState(): EditorState
  /** Swaps another tab's whole state in. Asynchronous, for {@link setMarkdown}'s reason. */
  applyState(state: EditorState): void | Promise<void>
  resolveImages(): void
  focus(): void
  /**
   * Write back whatever is pending in this editor and not yet in the document.
   *
   * Exposed for the one caller that has to: `Tabs` takes a tab's copy of the document
   * by reading the live state, so anything not written yet has to be written before
   * that read or the tab stores a document that has since been rewritten under it.
   */
  flushReveals(): void | Promise<void>
  /** Whether the document is the one last saved (or loaded): undoing back to it
   * makes a tab clean again. */
  isAtSavedPoint(): boolean
  /** `doc` is now on disk. It is the document the save read, which a keystroke
   * since then may already have moved past. */
  markSavedPoint(doc: ProseNode): void
  /**
   * Forget this editor's pending commits rather than writing them.
   *
   * For the one caller that is replacing the document from outside — see
   * `discardOpenReveals`, which is where the reasoning lives.
   */
  discardPending(): void
  destroy(): void
}

export interface BlockEditorOptions {
  onOpenLink?: (href: string, text: string) => void
  onChange?: () => void
  /**
   * Called whenever the block-mode record changes, and only then.
   *
   * A mode is not a document change, so there is no `onChange` to hang the
   * status chip on — and the *nested* editor an unlocked encrypted block creates
   * has a record of its own, which is why this is an option rather than
   * something the plugin writes into a shared element: only the editor that was
   * asked for it gets told.
   */
  onModeChange?: (mode: ReturnType<typeof currentBlockMode>) => void
  resolveImageSrc?: ResolveImage
  /** Render as a read-only view (selection/copy allowed, typing disabled). */
  readonly?: boolean
  /**
   * The block in the document **above** this one that contains it, when this
   * editor is nested.
   *
   * It is the one fact a nested editor has and its parent does not — the reveal's
   * node view already knows its own `getPos()` in the outer document — and it is
   * what makes this editor a *rung* of the page's focus path rather than a rival
   * chain of its own. Publishing it is what stops a sheet opened inside an open
   * encrypted block from releasing that block's record, which would lock the very
   * thing the sheet was opened in.
   */
  focusParent?: () => { view: EditorView; pos: number; type: string } | undefined
}

/** One link in the document, as the range of linked text it covers. */
export interface LinkRange {
  from: number
  to: number
  href: string
  text: string
}

/**
 * The Markdown a view's own selection stands for.
 *
 * A function of the **view** rather than of the editor that created it, because a
 * revealed encrypted block is a second `EditorView` built by this same factory and
 * `Ctrl+Shift+C` pressed inside one has to render *that* selection, not the outer
 * document's (which is empty, and so would copy nothing at all). Every other
 * document command resolves its editor the same way — see `focusedEditor`.
 */
export function selectionMarkdownFor(view: EditorView): string {
  return sliceMarkdown(view.state.selection.content().content, view.state.schema, formulaEnvFor(view.state))
}

/**
 * The document as it was last saved, kept in the state it belongs to — so it
 * travels with a tab's state when tabs swap, and a document created from a
 * file starts out at its saved point. A transaction carrying the meta moves it.
 */
const savedPointKey = new PluginKey<ProseNode>('savedPoint')
const savedPointPlugin = new Plugin<ProseNode>({
  key: savedPointKey,
  state: {
    init: (_config, state) => state.doc,
    apply: (tr, saved) => (tr.getMeta(savedPointKey) as ProseNode | undefined) ?? saved,
  },
})

export function createBlockEditor(
  parent: HTMLElement,
  initialMarkdown: string,
  options: BlockEditorOptions = {},
): BlockEditor {
  const resolveImageSrc = options.resolveImageSrc

  const linkClickPlugin = new Plugin({
    props: {
      handleClick(view, pos, event) {
        // ProseMirror routes every button's click through this prop (its mouse
        // handler only filters on `button == 0` for the drag/selection paths,
        // not before calling us), so a right-click has to be turned away here
        // or it opens the link *and* offers the context menu. The context menu
        // is where a link is edited (`contextMenuController.ts`), on right-click.
        if (event.button !== 0) return false
        const link = linkRangeAt(view.state.doc, pos)
        if (!link) return false
        if (typeof link.href !== 'string' || link.href === '') return false
        options.onOpenLink?.(link.href, link.text)
        return true
      },
    },
  })

  const urlPastePlugin = new Plugin({
    props: {
      handlePaste(view, event) {
        const data = event.clipboardData
        if (!data) return false
        // Rich text (HTML) is handled by ProseMirror's own parser, which turns
        // <a> into a link mark. Only intercept plain-text pastes containing a
        // raw URL so it becomes a clickable link instead of dead text.
        const types = Array.isArray(data.types) ? data.types : []
        if (types.includes('text/html')) return false
        const text = data.getData('text/plain')
        if (!containsRawUrl(text)) return false
        event.preventDefault()
        insertPastedText(view, text)
        return true
      },
    },
  })

  const misleadingLinkKey = new PluginKey('misleading-links')

  const misleadingLinkPlugin = new Plugin({
    key: misleadingLinkKey,
    state: {
      init(_config, state) {
        return buildMisleadingDecorations(state.doc)
      },
      apply(_tr, _old, _oldState, newState) {
        return buildMisleadingDecorations(newState.doc)
      },
    },
    props: {
      decorations(state) {
        return misleadingLinkKey.getState(state)
      },
    },
  })

  const plugins = [
    history(),
    // Before every keymap, so an open emoji card owns Enter/Tab/Esc instead of
    // `baseKeymap` splitting the block or inserting a newline first.
    emojiPlugin(),
    // Block-start markers convert on Enter as well. Can't go after the base
    // keymap: prosemirror-view iterates plugins from index 0, so an earlier
    // plugin wins. Right after history() outranks baseKeymap's undoInputRule /
    // splitBlock and listKeymap's splitListItem.
    blockStartKeymap(),
    undoKeymap,
    selectionExpandKeymap,
    listKeymap,
    keymap(baseKeymap),
    formattingKeymap,
    markExitPlugin,
    codeBlockExitPlugin,
    selectionExpandPlugin,
    selectionHighlightPlugin,
    clipboardTextPlugin,
    createInputRules(),
    blockToggleKeymap,
    gapCursor(),
    dropCursor(),
    linkClickPlugin,
    urlPastePlugin,
    misleadingLinkPlugin,
    blockModePlugin,
    blockModeFocusPlugin,
    blockDragPlugin,
    pressPlugin(),
    formulaDefsPlugin,
    mermaidNodeViewPlugin,
    maskedFieldNodeViewPlugin,
    encryptedBlockNodeViewPlugin,
    tableNodeViewPlugin,
    taskClickPlugin(),
    blockTypeSelectPlugin(),
    codeBlockNodeViewPlugin,
    searchPlugin(),
    new Plugin({
      props: {
        nodeViews: {
          ...Object.fromEntries(
            [...BLOCK_NODE_TYPES, 'source_block'].map((name) => [name, blockNodeView]),
          ),
          ...(resolveImageSrc
            ? { image: imageNodeView(resolveImageSrc) }
            : {}),
        },
      },
    }),
  ]

  const createState = (markdown: string): EditorState =>
    EditorState.create({
      doc: markdownToProse(markdown, schema),
      plugins: [...plugins, savedPointPlugin],
    })

  const viewRef: { current: EditorView | null } = { current: null }
  const dispatchTransaction = (transaction: import('prosemirror-state').Transaction) => {
    const cur = viewRef.current
    if (!cur) return
    const before = currentBlockMode(cur.state)
    const next = cur.state.apply(transaction)
    cur.updateState(next)
    if (transaction.docChanged) {
      // A Visual table's cells are selected by the browser, because the document cannot
      // hold that at all, so the app remembers the selection itself
      // (`tableTextSelection.ts`). Text moving under it is the one thing that ends it.
      forgetPlainTableSelection()
      options.onChange?.()
    }
    const held = currentBlockMode(next)
    if (held !== before) {
      // **The record is one slot, so taking it releases the block that had it.** The faded
      // overlay used to refuse the press that could do this, so nothing ever found out;
      // `keepOneNonVisualBlock` below arbitrates *between* editors, and two blocks in one
      // document never met there. Read the state that was displaced *before* the
      // transaction that took it — by the time it is gone the record names the new block.
      if (before !== null && held !== null && before.pos !== held.pos) {
        releaseDisplacedBlock(cur, before)
      }
      options.onModeChange?.(held)
    }
    // The one focus path in the *page*, not in this document: an unlocked
    // encrypted block is a whole nested editor with its own record, so a sheet
    // inside one and a diagram out here would otherwise both be in a mode. The
    // parent link turns this editor into a rung of that path rather than a rival
    // of it.
    keepOneNonVisualBlock(cur, options.focusParent?.())
  }
  const view = new EditorView(parent, {
    state: createState(initialMarkdown),
    dispatchTransaction,
    ...(options.readonly ? { editable: () => false } : {}),
  })
  viewRef.current = view

  /**
   * Replace the document, once whatever is pending has been written back.
   *
   * **The swap waits, and it is the wait that keeps the write from going astray.** An
   * open encrypted block's plaintext is in a nested editor that `updateState` is about
   * to destroy, and encrypting it is `crypto.subtle`'s asynchronous work — so a write
   * that had not finished by this line lands on a document that is no longer on
   * screen, at a position belonging to the one that was. `persist`'s guard refuses such
   * a write; this is what stops it being refused, which is the difference between a
   * saved edit and a dropped one.
   *
   * Every route that swaps today also flushes at `Tabs`' snapshot boundary first, so
   * this is the **backstop rather than the mechanism** — and it is here for the route
   * that will be added next without knowing any of this. Being a backstop is also why
   * it must be **synchronous unless there is something to write**: when there is not,
   * nothing is waited on and every caller keeps the timing it already had, which is
   * what lets the rest of the app read a document on the line after swapping it.
   */
  const swapOut = (replace: () => void): void | Promise<void> => {
    const pending = flushOpenReveals(view)
    if (pending === undefined) {
      replace()
      return undefined
    }
    return pending.then(replace)
  }

  // Links inside spreadsheet/plain table node views are raw `<a>` elements in
  // the cell HTML, not ProseMirror marks, so the click plugin above never sees
  // them. Delegate at the editor root and route them through the same opener,
  // so they get identical external/internal routing and clickjacking warning.
  const onNodeViewLinkClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest<HTMLAnchorElement>('.spreadsheet a[href], .ss-plain a[href]')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    if (!href) return
    event.preventDefault()
    options.onOpenLink?.(href, anchor.textContent ?? '')
  }
  view.dom.addEventListener('click', onNodeViewLinkClick)

  const onScrollerMouseDown = attachScrollerCaretFallback(view, parent)

  return {
    getView() {
      return view
    },
    getMarkdown() {
      return proseToMarkdown(view.state.doc, formulaEnvFor(view.state))
    },
    getSelectionMarkdown() {
      return selectionMarkdownFor(view)
    },
    setMarkdown(markdown: string) {
      // A swapped-in document is a fresh editing context: build a brand-new
      // EditorState so the tab owns its own doc, selection, and undo history,
      // and any source-mode block from the previous document is dropped.
      //
      // **The flush comes first, and it is not optional.** `updateState` destroys the
      // node views of the document it is leaving, synchronously, and an open encrypted
      // block's plaintext lives in one of them. Writing it back is asynchronous, so
      // anything not written before this line is written into a document that is no
      // longer on screen.
      return swapOut(() => view.updateState(createState(markdown)))
    },
    createState,
    getState() {
      return view.state
    },
    applyState(state: EditorState) {
      // A tab swap brings its own record with it, which is a mode change the
      // chip has to hear about like any other.
      return swapOut(() => {
        const before = view.state
        view.updateState(state)
        if (currentBlockMode(state) !== currentBlockMode(before)) {
          options.onModeChange?.(currentBlockMode(state))
        }
      })
    },
    insertMarkdown(markdown: string) {
      // Only the inserted markdown is parsed; the rest of the document is not
      // re-read, and the insert is one ordinary, undoable step. A single
      // paragraph goes in at the caret as inline content, anything else as blocks.
      commitSourceMode(view)
      const parsed = markdownToProse(markdown, view.state.schema)
      const inline = parsed.childCount === 1 && parsed.firstChild!.type.name === 'paragraph'
      const slice = inline ? new Slice(parsed.content, 1, 1) : new Slice(parsed.content, 0, 0)
      view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
      view.focus()
    },
    commitSource(): boolean {
      return commitSourceMode(view)
    },
    resolveImages() {
      if (resolveImageSrc) reResolveImages(view.dom, resolveImageSrc)
    },
    focus() {
      view.focus()
    },
    flushReveals() {
      return flushOpenReveals(view)
    },
    isAtSavedPoint() {
      return savedPointKey.getState(view.state)?.eq(view.state.doc) ?? false
    },
    markSavedPoint(doc) {
      view.dispatch(view.state.tr.setMeta(savedPointKey, doc).setMeta('addToHistory', false))
    },
    discardPending() {
      discardOpenReveals(view)
    },
    destroy() {
      // Best-effort, and deliberately not awaited: the view is going away, so there is
      // no document left to write into. `persist`'s own guard is what makes this safe —
      // it refuses a dispatch into a view that has been destroyed rather than reaching
      // the caller's next document at a stale position.
      void flushOpenReveals(view)
      view.dom.removeEventListener('click', onNodeViewLinkClick)
      parent.removeEventListener('mousedown', onScrollerMouseDown)
      // **Before the view goes.** The page's focus path holds a reference to this
      // editor, and a destroyed one cannot be dispatched to — so forgetting it here
      // is what stops a closed tab or a re-locked block from wedging the next
      // working state that comes along.
      forgetView(view)
      view.destroy()
    },
  }
}

/**
 * Clicks in the scroller's empty space (below the editor's own box, which is
 * only as tall as its content) never reach ProseMirror, so nothing wrote a
 * caret. Redirect them into the document: focus and place the caret at the
 * end — the natural target of a click below the content.
 */
function attachScrollerCaretFallback(view: EditorView, parent: HTMLElement): (event: MouseEvent) => void {
  const onScrollerMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || event.target !== parent) return
    event.preventDefault()
    view.focus()
    const doc = view.state.doc
    const last = doc.lastChild
    // A trailing special block (a board, a table, a code fence) has no
    // caret-capable position after it, so clicking below it opens a new
    // paragraph to put the caret in. That is the only way to then select the
    // block itself from below — a range from above always includes the text
    // before it. Its own position is asked of the block, because a fence in its
    // source form is one of these too and only the record says so.
    if (last && isSelectionAtom(view.state, last, doc.content.size - last.nodeSize)) {
      const tr = view.state.tr.insert(doc.content.size, view.state.schema.nodes.paragraph.create())
      tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1))
      view.dispatch(tr)
    } else {
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(doc)))
    }
  }
  parent.addEventListener('mousedown', onScrollerMouseDown)
  return onScrollerMouseDown
}

function linkMarkAt(doc: import('prosemirror-model').Node, pos: number): import('prosemirror-model').Mark | null {
  const $pos = doc.resolve(pos)
  // Only treat the click as "on the link" when it lands on a linked text
  // child, i.e. strictly inside the linked text. A click at the trailing
  // boundary after the link (marks() would still report the mark) must NOT
  // open the link.
  const child = $pos.parent.maybeChild($pos.index())
  if (child && child.isText) {
    return child.marks.find((m) => m.type.name === 'link') ?? null
  }
  return null
}

/**
 * The link under `pos`, as the whole run of text it covers.
 *
 * A markdown link is not always one text node — emphasis inside the label
 * splits it (`[read *the* docs](url)`), and a click can land on any of the
 * pieces — so the mark is expanded over its neighbours rather than reporting
 * only the clicked one. Reading the text back from the range (rather than
 * gathering every text node in the document carrying the same mark, which
 * merges the labels of two links to the same place) is also what lets the
 * context menu pre-fill the edit dialog with *this* link.
 */
export function linkRangeAt(
  doc: import('prosemirror-model').Node,
  pos: number,
): LinkRange | null {
  const mark = linkMarkAt(doc, pos)
  if (!mark) return null
  const $pos = doc.resolve(pos)
  const parent = $pos.parent
  const linked = (child: import('prosemirror-model').Node | null | undefined): boolean =>
    !!child && child.isText && child.marks.some((m) => m.eq(mark))
  const index = $pos.index()
  let first = index
  while (first > 0 && linked(parent.child(first - 1))) first--
  let last = index + 1
  while (last < parent.childCount && linked(parent.child(last))) last++
  // `pos` is somewhere *inside* the text node it lands in, so the run is
  // measured from that node's own start, not from `pos`.
  let from = $pos.start()
  for (let i = 0; i < first; i++) from += parent.child(i)!.nodeSize
  let to = from
  for (let i = first; i < last; i++) to += parent.child(i)!.nodeSize
  return { from, to, href: mark.attrs.href as string, text: doc.textBetween(from, to) }
}

function buildMisleadingDecorations(doc: import('prosemirror-model').Node): DecorationSet {
  const decorations: Decoration[] = []
  let run: { from: number; to: number; mark: import('prosemirror-model').Mark; text: string } | null = null

  function flush() {
    if (!run) return
    const href = run.mark.attrs.href as string
    if (typeof href === 'string' && isMisleadingLink(href, run.text)) {
      decorations.push(Decoration.inline(run.from, run.to, { class: 'ml-misleading' }))
    }
    run = null
  }

  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (!node.isText) {
      flush()
      return
    }
    const link = node.marks.find((m) => m.type.name === 'link')
    if (!link) {
      flush()
      return
    }
    if (run && run.mark.eq(link) && run.to === pos) {
      run.to = pos + node.nodeSize
      run.text += node.text ?? ''
    } else {
      flush()
      run = { from: pos, to: pos + node.nodeSize, mark: link, text: node.text ?? '' }
    }
  })
  flush()

  return DecorationSet.create(doc, decorations)
}
