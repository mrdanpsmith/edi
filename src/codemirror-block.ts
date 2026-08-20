import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'

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
  {
    tag: [tags.keyword, tags.atom, tags.bool, tags.typeName, tags.number],
    color: 'var(--md-code-keyword)',
  },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--md-code-string)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--text-muted)' },
  { tag: tags.contentSeparator, color: 'var(--text-muted)' },
])

const blockTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--text-primary)',
    fontSize: '13px',
    minHeight: '1.6em',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '4px 0',
  },
  '.cm-gutters': {
    display: 'none',
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
})

export interface BlockCodeMirror {
  view: EditorView
  getValue(): string
  focus(): void
  destroy(): void
}

export function createBlockCodeMirror(
  parent: HTMLElement,
  doc: string,
  onExit: (value: string) => void,
): BlockCodeMirror {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          {
            key: 'Escape',
            run: () => {
              onExit(view.state.doc.toString())
              return true
            },
          },
          {
            key: 'Mod-Shift-e',
            run: () => {
              onExit(view.state.doc.toString())
              return true
            },
          },
        ]),
        markdown({ codeLanguages: languages }),
        syntaxHighlighting(highlight),
        blockTheme,
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        cmPlaceholder('(edit markdown…)'),
      ],
    }),
    parent,
  })

  return {
    view,
    getValue() {
      return view.state.doc.toString()
    },
    focus() {
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
}
