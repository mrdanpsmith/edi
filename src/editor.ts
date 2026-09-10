import { EditorState, Plugin, PluginKey } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import { tableEditing } from 'prosemirror-tables'
import { gapCursor } from 'prosemirror-gapcursor'
import { dropCursor } from 'prosemirror-dropcursor'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { blockPlugin, getSourceBlockState, toggleSourceMode, BLOCK_PLUGIN_KEY } from './blockplugin'
import { blockNodeView, BLOCK_NODE_TYPES, commitSourceMode } from './blockview'
import { codeBlockNodeViewPlugin } from './node/execblock'
import { attachBlockHandles } from './blockhandle'
import { mermaidNodeViewPlugin } from './node/mermaid'
import { spreadsheetPlugin } from './node/spreadsheet'
import { maskedFieldNodeViewPlugin } from './node/masked'
import { highlight } from './remark/highlight'
import { subscript } from './remark/sub'
import { superscript } from './remark/sup'
import { taskClickPlugin, toggleTaskItems } from './formatToolbar'
import { insertPastedText, containsRawUrl } from './paste'
import { isMisleadingLink } from './linkSecurity'
import { imageNodeView, reResolveImages, type ResolveImage } from './image'

function createInputRules() {
  function headingRule(level: number): InputRule {
    return new InputRule(new RegExp(`^${'#'.repeat(level)}\\s(.*)$`, 'm'), (state, match, start, end) => {
      const text = match[1]
      const nodeType = state.schema.nodes.heading
      const content = text ? state.schema.text(text) : null
      const headingNode = nodeType.create({ level }, content)
      return state.tr.replaceWith(start, end, headingNode)
    })
  }

  function markRule(pattern: RegExp, markType: import('prosemirror-model').MarkType): InputRule {
    return new InputRule(pattern, (state, match, start, end) => {
      if (match[1]) {
        return state.tr.replaceWith(start, end, state.schema.text(match[1], [markType.create()]))
      }
      return state.tr
    })
  }

  return inputRules({ rules: [
    headingRule(1),
    headingRule(2),
    headingRule(3),
    headingRule(4),
    headingRule(5),
    headingRule(6),
    markRule(/\*\*([^*]+)\*\*$/, schema.marks.strong),
    markRule(/(?<!\*)\*([^*]+)\*(?!\*)$/, schema.marks.em),
    markRule(/`([^`]+)`$/, schema.marks.code),
    markRule(/~~([^~]+)~~$/, schema.marks.strikethrough),
    highlight.createInputRule(schema),
    subscript.createInputRule(schema),
    superscript.createInputRule(schema),
    new InputRule(/^---$/, (state, _match, start) => {
      return state.tr.replaceWith(start, start + 3, state.schema.nodes.horizontal_rule.create())
    }),
  ] })
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
})

const blockToggleKeymap = keymap({
  'Mod-Shift-e': (state, dispatch, view) => {
    if (!dispatch || !view) return false
    const blockState = getSourceBlockState(state)
    if (blockState.sourceBlockPos !== null) {
      const tr = commitSourceMode(view)
      if (!tr) return false
      dispatch(tr)
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

    const tr = toggleSourceMode(state, blockPos)
    dispatch(tr)
    return true
  },
  'Escape': (state, dispatch, view) => {
    if (!dispatch || !view) return false
    const blockState = getSourceBlockState(state)
    if (blockState.sourceBlockPos !== null) {
      const tr = commitSourceMode(view)
      if (!tr) return false
      dispatch(tr)
      return true
    }
    return false
  },
})

export interface BlockEditor {
  getView(): EditorView
  getMarkdown(): string
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
  resolveImageSrc?: ResolveImage
}

export function createBlockEditor(
  parent: HTMLElement,
  initialMarkdown: string,
  options: BlockEditorOptions = {},
): BlockEditor {
  const resolveImageSrc = options.resolveImageSrc

  const linkClickPlugin = new Plugin({
    props: {
      handleClick(view, pos) {
        const link = linkMarkAt(view.state.doc, pos)
        if (!link) return false
        const href = link.attrs.href as string
        if (typeof href !== 'string' || href === '') return false
        const text = linkTextAt(view.state.doc, link)
        options.onOpenLink?.(href, text)
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
    undoKeymap,
    listKeymap,
    keymap(baseKeymap),
    formattingKeymap,
    createInputRules(),
    blockToggleKeymap,
    tableEditing(),
    gapCursor(),
    dropCursor(),
    linkClickPlugin,
    urlPastePlugin,
    misleadingLinkPlugin,
    blockPlugin,
    mermaidNodeViewPlugin,
    maskedFieldNodeViewPlugin,
    spreadsheetPlugin,
    taskClickPlugin(),
    codeBlockNodeViewPlugin,
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
    const next = cur.state.apply(transaction)
    cur.updateState(next)
    if (transaction.docChanged) {
      options.onChange?.()
    }
  }
  const view = new EditorView(parent, {
    state: createState(initialMarkdown),
    dispatchTransaction,
  })
  viewRef.current = view

  attachBlockHandles(view)

  return {
    getView() {
      return view
    },
    getMarkdown() {
      return proseToMarkdown(view.state.doc)
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
      view.updateState(state)
    },
    insertMarkdown(markdown: string) {
      view.dispatch(view.state.tr.insertText(markdown))
      const newDoc = markdownToProse(proseToMarkdown(view.state.doc), view.state.schema)
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content)
      tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: null })
      tr.setMeta('addToHistory', false)
      view.dispatch(tr)
      view.focus()
    },
    commitSource(): boolean {
      const tr = commitSourceMode(view)
      if (!tr) return false
      view.dispatch(tr)
      return true
    },
    resolveImages() {
      if (resolveImageSrc) reResolveImages(view.dom, resolveImageSrc)
    },
    focus() {
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
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

function linkTextAt(doc: import('prosemirror-model').Node, mark: import('prosemirror-model').Mark): string {
  let text = ''
  doc.nodesBetween(0, doc.content.size, (node) => {
    if (!node.isText) return
    const link = node.marks.find((m) => m.type.name === 'link')
    if (link && link.eq(mark)) text += node.text ?? ''
  })
  return text
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
