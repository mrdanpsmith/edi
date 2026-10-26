import { EditorState, EditorSelection, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
  lineNumbers,
  type KeyBinding,
} from '@codemirror/view'
import { history, historyKeymap } from '@codemirror/commands'
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { EMOJI_ENTRIES, matchEmoji } from './emoji'
import { emojiTokenAt } from './emojiToken'

export const highlight = HighlightStyle.define([
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

export const blockTheme = EditorView.theme({
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

/**
 * The `:` emoji source for the block source editor. It reuses `emojiTokenAt`
 * (so the trigger rules match the body editor), and turns off CodeMirror's own
 * filtering because the options are already the matched set — the filter text
 * would otherwise be `:sm`, which no emoji name starts with.
 */
function emojiCompletion(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos)
  const before = context.state.sliceDoc(line.from, context.pos)
  const token = emojiTokenAt(before, before.length)
  if (!token) return null
  const options = matchEmoji(EMOJI_ENTRIES, token.query).map((entry) => ({
    label: entry.name,
    displayLabel: `${entry.emoji} :${entry.name}:`,
    apply: entry.emoji,
    type: 'text',
  }))
  if (options.length === 0) return null
  return { from: line.from + token.from, options, filter: false }
}

export interface BlockCodeMirror {
  view: EditorView
  getValue(): string
  setDoc(text: string): void
  focus(): void
  destroy(): void
}

type ArrowOut = (dir: 1 | -1) => void

/**
 * An arrow at the first or last position of the CodeMirror document leaves the
 * whole block. CodeMirror's own `ArrowUp`/`ArrowDown` bindings swallow those
 * presses (they prevent the default even when there is nowhere left to move),
 * so these have to run before `defaultKeymap` and hand the caret back.
 */
function arrowExitBindings(onArrowOut: ArrowOut | undefined): KeyBinding[] {
  if (!onArrowOut) return []
  const binding = (dir: 1 | -1) => ({
    key: dir > 0 ? 'ArrowDown' : 'ArrowUp',
    run(view: EditorView): boolean {
      const { state } = view
      if (state.selection.ranges.length !== 1) return false
      const range = state.selection.main
      const edge = dir > 0 ? state.doc.length : 0
      if (!range.empty || range.head !== edge) return false
      onArrowOut(dir)
      return true
    },
  })
  return [binding(1), binding(-1)]
}

export function createBlockCodeMirror(
  parent: HTMLElement,
  doc: string,
  onExit: (value: string) => void,
  initialPos?: number,
  onArrowOut?: ArrowOut,
): BlockCodeMirror {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        // Before the Escape exit below, so an open emoji card owns Escape
        // instead of the card closing *and* the source editor exiting.
        autocompletion({ override: [emojiCompletion] }),
        keymap.of([
          ...arrowExitBindings(onArrowOut),
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

  if (initialPos !== undefined) {
    view.dispatch({ selection: EditorSelection.cursor(initialPos) })
  }

  return {
    view,
    getValue() {
      return view.state.doc.toString()
    },
    setDoc(text: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    focus() {
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
}

/** A bare CodeMirror editor for visual-mode code blocks: no fences, a
 * `language`/grammar extension, and a callback on every content change so the
 * node view can keep the ProseMirror document in sync. */
export function createCodeEditor(
  parent: HTMLElement,
  doc: string,
  language: Extension,
  onChange: (value: string) => void,
  onArrowOut?: ArrowOut,
): BlockCodeMirror {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([
          ...arrowExitBindings(onArrowOut),
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        language,
        syntaxHighlighting(highlight),
        blockTheme,
        lineNumbers(),
        /* blockTheme hides the gutter (the full-document markdown editor has
         * none); re-show it here with more-specific selectors, and keep it on
         * the block surface instead of a white CM gutter. */
        EditorView.theme({
          '& > .cm-scroller > .cm-gutters': {
            display: 'flex',
            backgroundColor: 'var(--surface)',
            color: 'var(--text-muted)',
            borderRight: '1px solid var(--border)',
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString())
        }),
        EditorState.tabSize.of(2),
      ],
    }),
    parent,
  })

  return {
    view,
    getValue() {
      return view.state.doc.toString()
    },
    setDoc(text: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    focus() {
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
}
