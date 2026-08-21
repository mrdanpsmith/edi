import { EditorState, Plugin } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import { tableEditing } from 'prosemirror-tables'
import { gapCursor } from 'prosemirror-gapcursor'
import { dropCursor } from 'prosemirror-dropcursor'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { blockPlugin, getSourceBlockState, toggleSourceMode, exitSourceMode } from './blockplugin'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { attachBlockHandles } from './blockhandle'
import { mermaidNodeViewPlugin } from './node/mermaid'
import { execNodeViewPlugin } from './node/execblock'
import { spreadsheetPlugin } from './node/spreadsheet'
import { highlight } from './remark/highlight'
import { subscript } from './remark/sub'
import { superscript } from './remark/sup'

function createInputRules() {
  function headingRule(level: number): InputRule {
    return new InputRule(new RegExp(`^${'#'.repeat(level)}\\s(.*)$`, 'm'), (state, match, start, end) => {
      const text = match[1]
      const nodeType = state.schema.nodes.heading
      const content = state.schema.text(text)
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
})

const blockToggleKeymap = keymap({
  'Mod-Shift-e': (state, dispatch) => {
    if (!dispatch) return false
    const blockState = getSourceBlockState(state)
    if (blockState.sourceBlockPos !== null) return false

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
  'Escape': (state, dispatch) => {
    if (!dispatch) return false
    const blockState = getSourceBlockState(state)
    if (blockState.sourceBlockPos !== null) {
      const tr = exitSourceMode(state)
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
  focus(): void
  destroy(): void
}

export function createBlockEditor(parent: HTMLElement, initialMarkdown: string): BlockEditor {
  const doc = markdownToProse(initialMarkdown, schema)

  const view = new EditorView(parent, {
    state: EditorState.create({
      doc,
      plugins: [
        history(),
        undoKeymap,
        listKeymap,
        keymap(baseKeymap),
        createInputRules(),
        blockToggleKeymap,
        tableEditing(),
        gapCursor(),
        dropCursor(),
        blockPlugin,
        mermaidNodeViewPlugin,
        execNodeViewPlugin,
        spreadsheetPlugin,
        new Plugin({
          props: {
            nodeViews: Object.fromEntries(
              [...BLOCK_NODE_TYPES, 'source_block'].map((name) => [name, blockNodeView]),
            ),
          },
        }),
      ],
    }),
  })

  attachBlockHandles(view)

  return {
    getView() {
      return view
    },
    getMarkdown() {
      return proseToMarkdown(view.state.doc)
    },
    setMarkdown(markdown: string) {
      const newDoc = markdownToProse(markdown, view.state.schema)
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content))
    },
    focus() {
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
}
