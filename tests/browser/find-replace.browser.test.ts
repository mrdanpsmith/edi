// The find/replace bar with real keys (docs/find-replace.md).
//
// `src/search.test.ts` and `src/searchPanel.test.ts` cover matching and the
// panel's handlers. These open the bar with the real shortcut, type into its
// real input, and read what is painted: the highlight decorations as styled
// elements in the editor, where the caret and the focus actually are, and
// whether the active match was scrolled into view.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { bootApp, settle, waitFor, type BootedApp } from './app'
import { MOD, caretAfter, press, runs, type } from './edit-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const bar = (): HTMLElement => document.querySelector<HTMLElement>('#edi-search-bar')!
const findInput = (): HTMLInputElement => bar().querySelector<HTMLInputElement>('input[aria-label="Find"]')!
const count = (): string => bar().querySelector('.edi-search-count')!.textContent ?? ''
const highlighted = (): string[] =>
  [...app.editor.querySelectorAll('.edi-search-match, .edi-search-match-current')].map(
    (el) => el.textContent ?? '',
  )
const current = (): HTMLElement | null => app.editor.querySelector('.edi-search-match-current')

/** The text the DOM selection covers, i.e. what ProseMirror drew as selected. */
function selectedText(): string {
  return document.getSelection()?.toString() ?? ''
}

async function openFind(): Promise<void> {
  await press('f', MOD)
  await waitFor(() => bar() !== null && !bar().hidden, { message: 'find bar' })
}

describe('finding', () => {
  beforeEach(async () => {
    await app.setDocument('The cat sat.\n\nA Cat and a category.\n\nNo match here.')
    await caretAfter(app, 'sat')
  })

  it('Mod+F opens the bar with the focus in the find field', async () => {
    await openFind()
    await expect.element(page.getByRole('textbox', { name: 'Find' })).toHaveFocus()
  })

  it('plain Find hides the replace row, and the … toggle shows it with the focus in it', async () => {
    // The row's `display: flex` used to outrank `[hidden]`, so it always showed.
    await openFind()
    const field = bar().querySelector<HTMLInputElement>('input[aria-label="Replace"]')!
    expect(field.getBoundingClientRect().height).toBe(0)
    await page.getByRole('button', { name: 'Replace', exact: true }).click()
    const replace = page.getByRole('textbox', { name: 'Replace' })
    await expect.element(replace).toBeVisible()
    await expect.element(replace).toHaveFocus()
  })

  it('typing paints every match, case-insensitively, and counts them', async () => {
    await openFind()
    await type('cat')
    expect(highlighted()).toEqual(['cat', 'Cat', 'cat'])
    expect(count()).toBe('1 / 3')
    // The match is painted: the decoration is a styled element, not just a class.
    const paint = getComputedStyle(current()!).backgroundColor
    expect(paint).not.toBe('rgba(0, 0, 0, 0)')
  })

  it('the caret follows the first match while the field keeps the focus', async () => {
    await openFind()
    await type('category')
    expect(document.activeElement).toBe(findInput())
    expect(current()?.textContent).toBe('category')
    // Once the bar hands the focus back, the document's selection is the match.
    await press('Escape')
    expect(selectedText()).toBe('category')
  })

  it('Enter and Shift+Enter step through the matches, wrapping', async () => {
    await openFind()
    await type('cat')
    await press('Enter')
    expect(count()).toBe('2 / 3')
    expect(current()?.textContent).toBe('Cat')
    await press('Enter')
    await press('Enter')
    expect(count()).toBe('1 / 3')
    await press('Enter', 'Shift')
    expect(count()).toBe('3 / 3')
  })

  it('Match case and whole word narrow the matches', async () => {
    await openFind()
    await type('cat')
    await page.getByRole('button', { name: 'Match case' }).click()
    await settle()
    expect(highlighted()).toEqual(['cat', 'cat'])
    await page.getByRole('button', { name: 'Match whole word' }).click()
    await settle()
    expect(highlighted()).toEqual(['cat'])
    expect(count()).toBe('1 / 1')
  })

  it('Escape closes the bar, clears the paint and gives the editor the focus', async () => {
    await openFind()
    await type('cat')
    await press('Escape')
    expect(bar().hidden).toBe(true)
    expect(highlighted()).toEqual([])
    expect(document.activeElement).toBe(app.editor)
  })

  it('typing in the document while the bar is open keeps the matches live', async () => {
    await openFind()
    await type('cat')
    await caretAfter(app, 'here')
    await type(' cat')
    expect(highlighted()).toHaveLength(4)
    expect(bar().hidden).toBe(false)
  })
})

describe('scrolling', () => {
  it('a match far down the document is scrolled into view as it is typed', async () => {
    // Real layout: the match has to end up inside the visible editor box.
    // ProseMirror's own `scrollIntoView()` does nothing here, because the DOM
    // selection is in the find field; `selectSearchMatch` scrolls the painted
    // match itself (this used to leave the view at the top).
    const filler = Array.from({ length: 80 }, (_, i) => `Paragraph number ${i}.`).join('\n\n')
    await app.setDocument(`${filler}\n\nThe needle is here.`)
    await caretAfter(app, 'number 0')
    await openFind()
    await type('needle')
    await waitFor(() => {
      const box = current()?.getBoundingClientRect()
      const view = document.querySelector('#editor-container')!.getBoundingClientRect()
      return !!box && box.top >= view.top - 1 && box.bottom <= view.bottom + 1
    }, { message: 'the match was never scrolled into view' })
  })

  it('Enter scrolls the next match into view too', async () => {
    const filler = Array.from({ length: 80 }, (_, i) => `Paragraph number ${i}.`).join('\n\n')
    await app.setDocument(`A needle at the top.\n\n${filler}\n\nThe needle at the end.`)
    await caretAfter(app, 'top')
    await openFind()
    await type('needle')
    const scroller = document.querySelector('#editor-container')!
    expect(scroller.scrollTop).toBe(0)
    await press('Enter')
    expect(count()).toBe('2 / 2')
    await waitFor(() => scroller.scrollTop > 0, { message: 'Enter never scrolled' })
  })
})

describe('replacing', () => {
  it('Mod+H opens replace; Enter in the field replaces the current match only', async () => {
    await app.setDocument('one fish two fish')
    await caretAfter(app, 'one')
    await press('h', MOD)
    await waitFor(() => !bar().hidden, { message: 'find bar' })
    await type('fish')
    const replace = page.getByRole('textbox', { name: 'Replace' })
    await replace.click()
    await type('cat{Enter}')
    expect(app.markdown().trim()).toBe('one cat two fish')
    expect(count()).toBe('1 / 1')
  })

  it('Replace all replaces every match in one undoable step', async () => {
    await app.setDocument('one fish two fish red fish')
    await caretAfter(app, 'one')
    app.menu('replace')
    await waitFor(() => !bar().hidden, { message: 'find bar' })
    await type('fish')
    await page.getByRole('textbox', { name: 'Replace' }).click()
    await type('cat')
    await page.getByRole('button', { name: 'Replace all' }).click()
    await settle()
    expect(app.markdown().trim()).toBe('one cat two cat red cat')
    expect(count()).toBe('0 / 0')
    // Replace all hands the focus back to the document, so undo is the editor's.
    await press('z', MOD)
    expect(app.markdown().trim()).toBe('one fish two fish red fish')
  })

  it('a replacement takes the marks of the text it replaces', async () => {
    await app.setDocument('a **bold** word and **more**foo')
    await caretAfter(app, 'word')
    await press('h', MOD)
    await type('bold')
    await page.getByRole('textbox', { name: 'Replace' }).click()
    await type('BIG{Enter}')
    await page.getByRole('textbox', { name: 'Find' }).click()
    await userSelectAll()
    await type('foo')
    await page.getByRole('textbox', { name: 'Replace' }).click()
    await userSelectAll()
    await type('bar{Enter}')
    expect(runs(app)).toEqual([
      { text: 'a ', marks: [] },
      { text: 'BIG', marks: ['strong'] },
      { text: ' word and ', marks: [] },
      { text: 'more', marks: ['strong'] },
      { text: 'bar', marks: [] },
    ])
  })
})

/** Select everything in the focused field, with the platform's key. */
async function userSelectAll(): Promise<void> {
  await press('a', MOD)
}
