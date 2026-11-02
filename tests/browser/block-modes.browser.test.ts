// Visual / source / editing modes, driven by the real gestures: Alt+click with
// the Alt key really held, the keyboard shortcut, Escape.
//
// Ported from `test_alt_click_on_a_code_blocks_text_toggles_its_modes`,
// `test_a_non_visual_mode_is_a_dashed_outline_whatever_the_mode`,
// `test_a_block_in_a_non_visual_mode_is_never_marked_in_red` and
// `test_alt_click_outside_a_working_state_closes_it` in
// `tests/window/test_window.py`, which dispatch synthetic MouseEvents with
// `altKey: true`. Here the press goes through hit testing (which element is
// under the pointer decides which block toggles), which jsdom cannot do.
//
// The rule every test here also checks: a mode is plugin state, never
// document content, so a flip neither edits nor dirties the document.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  altClick,
  charBox,
  controlLabels,
  dirtyCalls,
  middleOf,
  topBlocks,
  waitForDiagrams,
  waitForSelector,
} from './block-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

/** The accent colour as the page computes it. */
function accent(): string {
  const probe = document.createElement('div')
  probe.style.color = 'var(--accent)'
  document.body.append(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value
}

describe('Alt+click', () => {
  // A code block's visual form is a CodeMirror editor; the rule that hands an
  // Alt+click inside a text field to that field once made the gesture
  // unreachable on the code itself. The second half: the same click inside
  // the source form's own CodeMirror must toggle back out.
  it("on a code block's text toggles visual ⇄ source, and back from inside the source", async () => {
    const markdown = 'before\n\n```js\nconst x = 1\n```\n\nafter'
    await app.setDocument(markdown)
    const before = app.doc()
    await altClick(center(app.editor.querySelector('.runnable-block .cm-content .cm-line')!))
    await waitForSelector(app, '.block-source-mode .cm-content')
    expect(app.editor.querySelector('.block-source-mode')?.textContent).toContain('```js')

    await altClick(center(app.editor.querySelector('.block-source-mode .cm-content .cm-line')!))
    await waitForSelector(app, '.block-source-mode', false)
    expect(app.editor.querySelector('.runnable-block .cm-editor')).not.toBeNull()
    expect(app.doc().eq(before)).toBe(true)
    expect(dirtyCalls(app)).toBe(0)
  })

  // A paragraph has no edit step, so its pair is visual ⇄ source.
  it('on a paragraph toggles it into its source form and back, without editing the document', async () => {
    await app.setDocument('Alpha **bold** text.\n\nSecond paragraph.')
    const before = app.doc()
    await altClick(middleOf(charBox(app.editor, 'Alpha', 1)))
    await waitForSelector(app, '.block-source-mode')
    const source = app.editor.querySelector('.block-source-mode')!
    expect(source.textContent).toContain('Alpha **bold** text.')
    // Exactly one block holds the record.
    expect(app.editor.querySelectorAll('.edi-block-mode')).toHaveLength(1)

    await altClick(center(source.querySelector('.cm-line')!))
    await waitForSelector(app, '.block-source-mode', false)
    expect(app.doc().eq(before)).toBe(true)
    expect(dirtyCalls(app)).toBe(0)
  })

  // A block with an edit step toggles that step and never its source form.
  it('on a diagram toggles its editing layer, never its source', async () => {
    await app.setDocument('Prose.\n\n```mermaid\ngraph TD\n  A[Alpha] --> B[Beta]\n```\n')
    await waitForDiagrams(app)
    const diagram = app.editor.querySelector<HTMLElement>('.mermaid')!
    const before = app.doc()
    await altClick(center(diagram.querySelector('svg')!))
    await waitForSelector(app, '.mermaid-editing')
    expect(app.editor.querySelector('.block-source-mode')).toBeNull()
    expect(diagram.classList.contains('edi-block-mode-editing')).toBe(true)
    // While editing, the cluster's interaction button reports the state.
    expect(controlLabels(diagram)).toEqual(['Done', 'Source'])

    await altClick(center(app.editor.querySelector('.mermaid svg')!))
    await waitForSelector(app, '.mermaid-editing', false)
    expect(app.editor.querySelector('.edi-block-mode')).toBeNull()
    expect(app.doc().eq(before)).toBe(true)
  })

  // There is one record: opening a second block commits the first and moves
  // the mode, so text typed in the first source buffer is kept, not lost.
  it('on a second block commits the first block’s source and moves the mode', async () => {
    await app.setDocument('First paragraph.\n\nSecond paragraph.')
    await altClick(middleOf(charBox(app.editor, 'First', 1)))
    await waitForSelector(app, '.block-source-mode .cm-content')
    await waitFor(() => document.activeElement?.closest('.cm-content') !== null, {
      message: 'source focused',
    })
    await userEvent.keyboard('{End} edited')
    await settle()

    await altClick(middleOf(charBox(app.editor, 'Second', 1)))
    await waitFor(() => app.markdown().includes('First paragraph. edited'), {
      message: 'first block committed',
    })
    const sources = app.editor.querySelectorAll('.block-source-mode')
    expect(sources).toHaveLength(1)
    expect(sources[0].textContent).toContain('Second paragraph.')
    expect(app.editor.querySelectorAll('.edi-block-mode')).toHaveLength(1)
  })

  // A press naming no block finishes whatever is open: Alt+click in the page's
  // white space below the last block closes a source form.
  it('in the white space below the document closes the open source form', async () => {
    await app.setDocument('Only paragraph.')
    await altClick(middleOf(charBox(app.editor, 'Only', 1)))
    await waitForSelector(app, '.block-source-mode')
    const last = topBlocks(app).at(-1)!.getBoundingClientRect()
    await altClick({ x: last.left + 20, y: last.bottom + 200 })
    await waitForSelector(app, '.block-source-mode', false)
    expect(app.markdown().trim()).toBe('Only paragraph.')
  })
})

describe('the keyboard', () => {
  // Mod+Shift+E (Ctrl off macOS) enters source on the caret's block; Escape
  // commits and leaves.
  it('Mod+Shift+E enters source on the caret block and Escape commits it', async () => {
    await app.setDocument('First paragraph.\n\nSecond paragraph.')
    await pointer.press(middleOf(charBox(app.editor, 'Second', 2)))
    await settle()
    await userEvent.keyboard('{ControlOrMeta>}{Shift>}E{/Shift}{/ControlOrMeta}')
    await waitForSelector(app, '.block-source-mode')
    const source = app.editor.querySelector('.block-source-mode')!
    expect(source.textContent).toContain('Second paragraph.')
    expect(topBlocks(app).indexOf(source as HTMLElement)).toBe(1)

    await waitFor(() => document.activeElement?.closest('.cm-content') !== null)
    // Escape straight after a keystroke, the way a hand types it. This used to
    // do nothing: the emoji completion's pending state (~100ms after every
    // keystroke, no card on screen) took Escape for itself.
    await userEvent.keyboard('{End}!{Escape}')
    await waitForSelector(app, '.block-source-mode', false)
    expect(app.markdown()).toContain('Second paragraph.!')
  })

  // The other half of that rule: while an emoji card really is showing, the
  // first Escape closes the card and keeps the source form; the next leaves.
  it('Escape closes an open emoji card first, then leaves the source form', async () => {
    await app.setDocument('Some words.')
    await altClick(middleOf(charBox(app.editor, 'words', 1)))
    await waitForSelector(app, '.block-source-mode')
    await waitFor(() => document.activeElement?.closest('.cm-content') !== null)
    await userEvent.keyboard('{End} :smil')
    await waitFor(() => document.querySelector('.cm-tooltip-autocomplete') !== null, {
      message: 'emoji card',
    })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => document.querySelector('.cm-tooltip-autocomplete') === null)
    await settle()
    expect(app.editor.querySelector('.block-source-mode')).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    await waitForSelector(app, '.block-source-mode', false)
    expect(app.markdown()).toContain('Some words. :smil')
  })
})

describe('the mode mark', () => {
  // Editing, Source and a sheet share one dashed accent outline; solid is
  // spent on selection, and the destructive red is never used for a mode.
  it('is a dashed accent outline for a source block and a diagram being edited, never red', async () => {
    await app.setDocument('A paragraph.\n\n```mermaid\ngraph TD\n  A[Alpha]\n```\n')
    await waitForDiagrams(app)
    const colour = accent()

    await altClick(middleOf(charBox(app.editor, 'paragraph', 1)))
    await waitForSelector(app, '.edi-block-mode-source')
    let marked = app.editor.querySelector<HTMLElement>('.edi-block-mode-source')!
    let style = getComputedStyle(marked)
    expect(style.outlineStyle).toBe('dashed')
    expect(style.outlineColor).toBe(colour)
    // The source frame's own border is chrome, not the mode's accent.
    expect(getComputedStyle(marked).borderTopColor).not.toBe(colour)

    await altClick(center(app.editor.querySelector('.mermaid svg')!))
    await waitForSelector(app, '.edi-block-mode-editing')
    marked = app.editor.querySelector<HTMLElement>('.edi-block-mode-editing')!
    style = getComputedStyle(marked)
    expect(style.outlineColor).toBe(colour)
    expect(style.outlineColor).not.toBe('rgb(209, 36, 47)')
    // Selection's solid outline wins over the mode's dashed one when both apply.
    expect(['dashed', 'solid']).toContain(style.outlineStyle)
    if (!marked.classList.contains('ProseMirror-selectednode')) {
      expect(style.outlineStyle).toBe('dashed')
    }
  })
})
