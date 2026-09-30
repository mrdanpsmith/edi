import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Replace the bridge so copyText() resolves without a real QWebChannel, and so
// the exact text it was asked to copy can be asserted.
vi.mock('./bridge', () => ({
  invoke: vi.fn(async () => true),
  invokeStream: vi.fn(),
  hasBridge: () => true,
  confirmAction: vi.fn(),
}))

import { invoke } from './bridge'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { inlineCodeCopyPlugin } from './inlineCodeCopy'

const invokeMock = invoke as ReturnType<typeof vi.fn>

function makeView(md: string) {
  return new EditorView(document.body, {
    state: EditorState.create({
      doc: markdownToProse(md, schema),
      plugins: [inlineCodeCopyPlugin()],
    }),
  })
}

const buttons = (view: EditorView) =>
  [...view.dom.querySelectorAll<HTMLButtonElement>('.edi-inline-code-copy')]

/** The tick glyph, as the only path in the button's own markup. */
const hasTick = (button: HTMLButtonElement) => button.querySelector('path[d^="m4 13"]') !== null

/** The position range of a run of document text, for editing around it. */
function findText(view: EditorView, text: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  view.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) found = { from: pos, to: pos + node.nodeSize }
    return found === null
  })
  if (!found) throw new Error(`no text node ${JSON.stringify(text)}`)
  return found
}

/** Let copyText()'s promise chain settle. */
const flushed = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('inline code copy button', () => {
  beforeEach(() => {
    invokeMock.mockClear()
    invokeMock.mockResolvedValue(true)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('puts an always-present button on every inline code span', () => {
    const view = makeView('Call `npm run check` before `npm run build`.')
    const found = buttons(view)
    expect(found).toHaveLength(2)
    // Always on: the button is in the document with no hover, focus or
    // scroll having happened.
    for (const button of found) {
      expect(button.getAttribute('aria-label')).toBe('Copy code to clipboard')
      expect(button.tabIndex).toBe(-1)
      expect(button.contentEditable).toBe('false')
    }
    view.destroy()
  })

  it('hangs the button inside the code element it copies, at the end of the text', () => {
    const view = makeView('Call `npm run check` here.')
    const button = buttons(view)[0]
    // The placement is the whole design: a widget inside the marked element is
    // laid out by the browser, so nothing in the app has to follow the span
    // across scrolls, resizes and reflows. It goes at the run's end with
    // `side: -1` — a widget on the far side of that position is rendered
    // *outside* the element, because by then the element has closed.
    expect(button.closest('code')).toBeTruthy()
    expect(button.parentElement?.tagName).toBe('CODE')
    expect(button.previousSibling?.textContent).toBe('npm run check')
    view.destroy()
  })

  it('copies the text the span shows, not the backticked source', async () => {
    const view = makeView('Write `a &amp; b` and `C:\\path\\to` please.')
    const found = buttons(view)
    found[0].click()
    found[1].click()
    await flushed()
    // Both are what the span shows and what a user gets from selecting it and
    // pressing Ctrl+C: the entity is *not* decoded (the editor renders the
    // characters the source holds) and the backslash is literal, because a code
    // span takes no escapes.
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'copyText', { text: 'a &amp; b' })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'copyText', { text: 'C:\\path\\to' })
    view.destroy()
  })

  it('shows a tick once the text is on the clipboard, then puts the glyph back', async () => {
    vi.useFakeTimers()
    const view = makeView('Copy `done` please.')
    const button = buttons(view)[0]
    button.click()
    await vi.advanceTimersByTimeAsync(1)
    expect(hasTick(button)).toBe(true)
    expect(button.classList.contains('edi-inline-code-copy-done')).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(hasTick(button)).toBe(false)
    expect(button.classList.contains('edi-inline-code-copy-done')).toBe(false)
    view.destroy()
  })

  it('says nothing when the clipboard write failed', async () => {
    invokeMock.mockRejectedValueOnce(new Error('no clipboard'))
    // No bridge, no web clipboard, and execCommand refuses: nothing was copied,
    // so nothing is claimed.
    const exec = vi.fn().mockReturnValue(false)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const view = makeView('Copy `nope` please.')
    const button = buttons(view)[0]
    button.click()
    await flushed()
    expect(hasTick(button)).toBe(false)
    expect(button.classList.contains('edi-inline-code-copy-done')).toBe(false)
    Reflect.deleteProperty(document, 'execCommand')
    view.destroy()
  })

  it('does not edit the document, and does not let the press reach the editor', () => {
    const view = makeView('Copy `me` please.')
    const before = view.state.doc.toString()
    const button = buttons(view)[0]
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(mousedown)
    button.click()
    // A copy button is a control in the document, not a click on the document:
    // the press must not move the caret or start a selection, and the click must
    // not be allowed to put a character in the text.
    expect(mousedown.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe(before)
    expect(view.state.selection.from).toBe(1)
    view.destroy()
  })

  it('leaves fenced code blocks to the block copy button', () => {
    const view = makeView('Inline `here` and a block:\n\n```\nconst a = 1\n```\n')
    // A fenced block is a node of its own that takes no marks, so there is no
    // inline span in it to offer — and it already has a copy button of its own.
    expect(buttons(view)).toHaveLength(1)
    view.destroy()
  })

  it('gives one button per element a single span is drawn as', () => {
    // `**`code` words**` is one code element holding three marked runs (the
    // strong mark splits the code mark without splitting the element).
    const view = makeView('Say `**`code` words** now.')
    expect(buttons(view)).toHaveLength(1)
    view.destroy()
  })

  it('keeps the button of a span that did not move, and drops the ones that went', () => {
    const view = makeView('Intro.\n\nKeep `one` and `two`.')
    const original = buttons(view)
    expect(original).toHaveLength(2)

    // An edit at the *end* of the document leaves both spans where they were, so
    // both keep the element they had — a rebuild that handed ProseMirror a fresh
    // button per span per keystroke would throw away a "copied" moment a
    // keystroke elsewhere in the document has no business ending.
    view.dispatch(view.state.tr.insertText('Z', view.state.doc.content.size - 1))
    const kept = buttons(view)
    expect(kept[0]).toBe(original[0])
    expect(kept[1]).toBe(original[1])

    // An edit *above* them moves both, so both are rebuilt...
    view.dispatch(view.state.tr.insertText('More words. ', 1))
    const shifted = buttons(view)
    expect(shifted[0]).not.toBe(kept[0])
    expect(shifted[1]).not.toBe(kept[1])

    // ...and a span taken out of the document takes its button with it, rather
    // than leaving a live reference to a detached element in the cache.
    const one = findText(view, 'one')
    view.dispatch(view.state.tr.delete(one.from - 1, one.to))
    const after = buttons(view)
    expect(after).toHaveLength(1)
    expect(after[0].closest('code')?.textContent).toBe('two')
    for (const button of after) expect(button.isConnected).toBe(true)
    view.destroy()
  })

  it('offers nothing for a span with no text in it', () => {
    // ProseMirror renders no element for a mark with no text in it, so there is
    // nothing to hang a button in.
    const view = makeView('An empty ` ` span here.')
    expect(buttons(view)).toHaveLength(0)
    view.destroy()
  })

  it('leaves the read-only preview alone', () => {
    const view = makeView('Copy `me` please.')
    // The decoration lives in the editor's view only, so the serialised document
    // — which is what the preview and the export are built from — is untouched.
    expect(view.state.doc.toString()).not.toContain('edi-inline-code-copy')
    expect(proseToMarkdown(view.state.doc)).not.toContain('edi-inline-code-copy')
    view.destroy()
  })
})
