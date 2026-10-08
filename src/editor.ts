import { EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
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
  blockModePlugin,
  commitSourceMode,
  currentBlockMode,
  keepOneNonVisualBlock,
  enterSourceMode,
  exitBlockMode,
  leaveBlockMode,
  setBlockMode,
} from './block-modes'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { codeBlockNodeViewPlugin } from './node/execblock'
import { mermaidNodeViewPlugin } from './node/mermaid'
import { tableNodeViewPlugin } from './node/table'
import { formulaDefsPlugin, formulaEnvFor } from './formulaDefs'
import { maskedFieldNodeViewPlugin } from './node/masked'
import { encryptedBlockNodeViewPlugin } from './node/encryptedblock'
import { highlight } from './remark/highlight'
import { subscript } from './remark/sub'
import { superscript } from './remark/sup'
import { taskClickPlugin, toggleTaskItems, blockTypeSelectPlugin } from './toolbar'
import { markExitPlugin, stopMarking } from './markExit'
import { selectionExpandKeymap, selectionExpandPlugin, selectionHighlightPlugin, clipboardTextPlugin, isSelectionAtom } from './selectionExpand'
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
  // Escape is deliberately **not** a way round the cycle. The other two steps are
  // moves through it rather than cancellations, so they are the cycle's own
  // backwards gesture's business (Alt+Shift+click, §5.2) and the controls on the
  // block's; a key that undid any of them would be answering "cancel" for two
  // different questions.
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
  setMarkdown(markdown: string): void
  insertMarkdown(markdown: string): void
  commitSource(): boolean
  // Per-tab editor state: each document owns its own ProseMirror EditorState
  // (doc, undo/redo history, selection). Tabs swap whole states into the view.
  createState(markdown: string): EditorState
  getState(): EditorState
  applyState(state: EditorState): void
  resolveImages(): void
  focus(): void
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
}

/** One link in the document, as the range of linked text it covers. */
export interface LinkRange {
  from: number
  to: number
  href: string
  text: string
}

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
        // is where a link is edited (`main.ts`), and it is a right-click.
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
      plugins,
    })

  const viewRef: { current: EditorView | null } = { current: null }
  const dispatchTransaction = (transaction: import('prosemirror-state').Transaction) => {
    const cur = viewRef.current
    if (!cur) return
    const before = currentBlockMode(cur.state)
    const next = cur.state.apply(transaction)
    cur.updateState(next)
    if (transaction.docChanged) {
      options.onChange?.()
    }
    const held = currentBlockMode(next)
    if (held !== before) {
      options.onModeChange?.(held)
    }
    // The one non-visual block in the *page*, not in this document: an unlocked
    // encrypted block is a whole nested editor with its own record, so a sheet
    // inside one and a diagram out here would otherwise both be in a mode.
    keepOneNonVisualBlock(cur)
  }
  const view = new EditorView(parent, {
    state: createState(initialMarkdown),
    dispatchTransaction,
    ...(options.readonly ? { editable: () => false } : {}),
  })
  viewRef.current = view

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
      return sliceMarkdown(view.state.selection.content().content, view.state.schema, formulaEnvFor(view.state))
    },
    setMarkdown(markdown: string) {
      // A swapped-in document is a fresh editing context: build a brand-new
      // EditorState so the tab owns its own doc, selection, and undo history,
      // and any source-mode block from the previous document is dropped.
      view.updateState(createState(markdown))
    },
    createState,
    getState() {
      return view.state
    },
    applyState(state: EditorState) {
      // A tab swap brings its own record with it, which is a mode change the
      // chip has to hear about like any other.
      const before = view.state
      view.updateState(state)
      if (currentBlockMode(state) !== currentBlockMode(before)) {
        options.onModeChange?.(currentBlockMode(state))
      }
    },
    insertMarkdown(markdown: string) {
      view.dispatch(view.state.tr.insertText(markdown))
      const newDoc = markdownToProse(proseToMarkdown(view.state.doc), view.state.schema)
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content)
      setBlockMode(tr, null)
      tr.setMeta('addToHistory', false)
      view.dispatch(tr)
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
    destroy() {
      view.dom.removeEventListener('click', onNodeViewLinkClick)
      parent.removeEventListener('mousedown', onScrollerMouseDown)
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
