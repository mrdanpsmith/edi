import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'

export type ChangeHandler = (view: EditorView) => void

const highlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--md-heading)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--md-link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--md-link)' },
  { tag: tags.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
  { tag: tags.monospace, color: 'var(--md-code)' },
  { tag: tags.comment, color: 'var(--text-muted)' },
  { tag: [tags.keyword, tags.atom, tags.bool, tags.typeName, tags.number], color: 'var(--md-code-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--md-code-string)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--text-muted)' },
  { tag: tags.contentSeparator, color: 'var(--text-muted)' },
])

const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--text-primary)',
    fontSize: '13px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '12px 16px 24px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--text-muted)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 12px',
    minWidth: '24px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    {
      backgroundColor: 'var(--selection)',
    },
  '.cm-activeLine': {
    backgroundColor: 'var(--active-line)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--active-line)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--selection-strong)',
  },
})

export interface EdiEditor {
  view: EditorView
  getValue(): string
  setValue(value: string): void
  focus(): void
}

export function createEditor(parent: HTMLElement, onChange: ChangeHandler): EdiEditor {
  let suppressChange = false

  const state = EditorState.create({
    doc: '',
    extensions: [
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressChange) {
          onChange(update.view)
        }
      }),
      lineNumbers(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown({ codeLanguages: languages }),
      syntaxHighlighting(highlight),
      theme,
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
    ],
  })

  const view = new EditorView({ state, parent })

  return {
    view,
    getValue() {
      return view.state.doc.toString()
    },
    setValue(value: string) {
      suppressChange = true
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      })
      suppressChange = false
    },
    focus() {
      view.focus()
    },
  }
}
