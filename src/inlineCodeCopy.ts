import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { copyText } from './clipboard'

/**
 * A copy button on every inline code span, always on.
 *
 * It is a decoration, so it is rebuilt with the document and is in step with it
 * for free: an edit that adds a span adds a button, one that removes the span
 * takes the button with it, and there is no second copy of the document's shape
 * to fall out of date. The cost of "always on" is paid in width rather than in
 * hidden — the glyph sits in the pill's own right-hand padding, which is
 * reserved for it, and it stays quiet (muted) until the pointer or the focus is
 * on it, so a document full of code reads as a document full of code.
 */
const key = new PluginKey<DecorationSet>('edi-inline-code-copy')

/** The class on the button itself, plus `-done` while it is showing the tick. */
const COPY_BUTTON_CLASS = 'edi-inline-code-copy'

/** How long the button shows that it did it, in ms. */
const COPIED_FOR = 1200

/** A copy glyph: two overlapping sheets, the back one clipped by the front. */
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="12" height="12" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
/** A tick, for the moment after. Same frame, so it does not resize the pill. */
const DONE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m4 13 5 5L20 6"/></svg>'

/**
 * The text a code span shows, read off the DOM rather than off the document.
 *
 * A code span is a leaf: its text is one `inlineCode` value carried through
 * untouched — a backslash inside backticks is a literal backslash (code spans
 * take no escapes), and an entity is *not* decoded either, so `` `a &amp; b` ``
 * shows `a &amp; b` in the editor and in the preview alike. So the rendering and
 * the document agree here, and reading the DOM gets the text the user can see —
 * which is what they would get by selecting the span and pressing Ctrl+C, the
 * thing this button replaces.
 *
 * The button is inside the element it reads, so it is asked for the text with
 * itself excluded. It is a pair of glyphs and a `title`, so it has no text of its
 * own to leave out, but the glyphs are swapped for a tick afterwards and a tick
 * is still not a text node — `svg` contributes nothing either way. That is load
 * bearing, not incidental: this reads every text node in the span.
 */
function shownText(button: HTMLElement): string {
  return (button.closest('code')?.textContent ?? '').trim()
}

/**
 * The button, built once per span and then kept: a decoration set that is rebuilt
 * on every document change would otherwise hand ProseMirror a brand new element
 * per button per keystroke, throwing away the "copied" moment a change elsewhere
 * in the document should not have ended.
 *
 * It is a real `<button>` so the pointer, the title and the accessibility name
 * all come for free, and `contenteditable` is off on it so the editor does not
 * try to put a caret in a control and a click on a copy button is not a click
 * that edits the document.
 */
function copyButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = COPY_BUTTON_CLASS
  button.tabIndex = -1
  button.title = 'Copy to clipboard'
  button.setAttribute('aria-label', 'Copy code to clipboard')
  button.innerHTML = COPY_ICON
  button.contentEditable = 'false'
  // The selection belongs to the document, so a press on a control inside it is a
  // press on the control: the editor must not read it as the caret moving, and
  // the browser's own focus change is stopped so the button never takes focus
  // away from the text being read.
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const text = shownText(button)
    if (!text) return
    void copyText(text).then((copied) => {
      // A failed write says nothing, so it says nothing: the glyph only becomes a
      // tick when the text really is on the clipboard.
      if (!copied) return
      button.innerHTML = DONE_ICON
      button.classList.add(`${COPY_BUTTON_CLASS}-done`)
      window.setTimeout(() => {
        button.innerHTML = COPY_ICON
        button.classList.remove(`${COPY_BUTTON_CLASS}-done`)
      }, COPIED_FOR)
    })
  })
  return button
}

interface CodeSpan {
  from: number
  to: number
}

/**
 * Every run of code-marked text, one entry per element the mark renders.
 *
 * Two rules do the real work here, and both are about which element the button
 * can live in:
 *
 * - Runs are merged when they are *adjacent inside the same block*. One code span
 *   is drawn as one `<code>` element, and ProseMirror draws it as one element
 *   whatever splits the text up underneath — a hard break inside a paragraph is a
 *   newline in a text node, and a differently-marked run in the middle is still
 *   the same element. So they get one button, not one per fragment.
 * - A mark that *reaches past a block* gets one button per block it reaches, not
 *   one for the mark. There is no single element to hang a button in and no
 *   single position to put it at: the range is a series of elements, one per
 *   block, and a single button would have to be either five buttons or a widget
 *   with nothing to position against. Inline code does not wrap across blocks in
 *   practice (a newline inside backticks is a space, as far as the markdown is
 *   concerned), so the case is a document writing code fences by hand, and those
 *   get nothing — which is also what a fenced block does, since it is a node of
 *   its own that takes no marks.
 *
 * A run with nothing in it is skipped because ProseMirror renders no element for a
 * mark with no text in it, so a button in an empty range would be laid out against
 * whatever its ancestor happened to be.
 */
function codeSpans(state: EditorState): CodeSpan[] {
  const { doc } = state
  const code = state.schema.marks.code
  const spans: CodeSpan[] = []
  let parent: import('prosemirror-model').Node | null = null
  doc.descendants((node, pos) => {
    if (!node.isText || !code.isInSet(node.marks)) return true
    const from = pos
    const to = pos + node.nodeSize
    if (node.textContent.trim() === '') return false
    const block = doc.resolve(from).parent
    const last = spans[spans.length - 1]
    if (last !== undefined && last.to === from && parent === block) {
      last.to = to
    } else {
      spans.push({ from, to })
    }
    parent = block
    return false
  })
  return spans
}

/**
 * The decoration set, and the one place the buttons are made.
 *
 * The button goes at the *end* of the run with `side: -1`, which is the one
 * placement ProseMirror renders inside the `<code>` element: a widget on the far
 * side of a position is rendered outside the marks that end there, because by
 * then the element has closed. Sitting at `to - 1` instead also lands inside, but
 * it splits the last character off the run and the button lands *in the middle*
 * of the text — and the position it is read from matters for the same reason, so
 * the run's own end is the one to use.
 *
 * Being a widget inside that element is the whole design: the browser lays it
 * out, so no scroll, resize or reflow handler anywhere in the app has to know it
 * exists. Buttons are cached per `from:to`, so a span that did not move keeps its
 * element across a rebuild, and the cache is pruned to what is live.
 */
function build(state: EditorState, cache: Map<string, HTMLButtonElement>): DecorationSet {
  const decorations: Decoration[] = []
  const live = new Set<string>()
  for (const span of codeSpans(state)) {
    const id = `${span.from}:${span.to}`
    live.add(id)
    let button = cache.get(id)
    if (!button) {
      button = copyButton()
      cache.set(id, button)
    }
    decorations.push(Decoration.widget(span.to, button, { side: -1, key: `ic${id}` }))
  }
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id)
  return DecorationSet.create(state.doc, decorations)
}

export function inlineCodeCopyPlugin(): Plugin {
  // The cache is per plugin instance, so two editors do not share button elements
  // (a DOM node can only be in one document at a time, and one decoration set can
  // only own it).
  const cache = new Map<string, HTMLButtonElement>()
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => build(state, cache),
      apply: (tr, value, _old, state) => (tr.docChanged ? build(state, cache) : value),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  })
}
