// The in-page link dialog (`promptForLink` in `src/urlDialog.ts`), driven from
// the toolbar with real input.
//
// `src/urlDialog.test.ts` resolves the promise by clicking buttons in jsdom.
// These open it the way a reader does, find its fields by their accessible
// names (the labels are associated with the inputs, which they were not), and
// check what a real browser adds: focus on open, a click on a label focusing
// its field, Enter/Escape from inside a field, and a press on the backdrop.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import { caretAfter, charBox, press, type } from './edit-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const dialog = (): HTMLElement | null => document.querySelector('.edi-dialog')
const hrefs = (): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  app.doc().descendants((node) => {
    const link = node.marks.find((m) => m.type.name === 'link')
    if (node.isText && link) out.push([node.text ?? '', String(link.attrs.href)])
  })
  return out
}

/** Select `text` in the editor with a real drag across it. */
async function selectText(text: string): Promise<void> {
  const first = charBox(app.editor, text, 0)
  const last = charBox(app.editor, text, text.length - 1)
  const y = first.top + first.height / 2
  await pointer.drag({ x: first.left + 1, y }, { x: last.right - 1, y }, 4)
  await settle()
  expect(document.getSelection()?.toString()).toBe(text)
}

/** A button of the open dialog (the toolbar has "Insert …" buttons of its own). */
const button = (name: string) => page.getByRole('dialog').getByRole('button', { name, exact: true })

async function openFromToolbar(): Promise<void> {
  await page.getByRole('button', { name: 'Hyperlink' }).click()
  await waitFor(() => dialog() !== null, { message: 'the link dialog never opened' })
}

describe('inserting a link from the toolbar', () => {
  it('over a selection, asks only for the URL and links the selected words', async () => {
    await app.setDocument('Read the manual first.')
    await selectText('the manual')
    await openFromToolbar()
    await expect.element(page.getByText('Insert link', { exact: true })).toBeVisible()
    const url = page.getByRole('textbox', { name: 'URL' })
    await expect.element(url).toHaveFocus()
    // The words come from the selection, so there is no text field to fill.
    expect(page.getByRole('textbox', { name: 'Link text' }).elements()).toHaveLength(0)

    await type('https://example.com/manual{Enter}')
    await waitFor(() => dialog() === null, { message: 'Enter never confirmed' })
    expect(hrefs()).toEqual([['the manual', 'https://example.com/manual']])
  })

  it('with no selection, asks for the text too and inserts the link at the caret', async () => {
    await app.setDocument('See here.')
    await caretAfter(app, 'See')
    await openFromToolbar()
    await page.getByRole('textbox', { name: 'URL' }).fill('https://example.org/')
    await page.getByRole('textbox', { name: 'Link text' }).fill('the site')
    await button('Insert').click()
    await waitFor(() => dialog() === null, { message: 'Insert never confirmed' })
    expect(hrefs()).toEqual([['the site', 'https://example.org/']])
    expect(app.markdown().trim()).toBe('See[the site](https://example.org/) here.')
  })

  it('a click on a field’s label focuses that field', async () => {
    await app.setDocument('See here.')
    await caretAfter(app, 'See')
    await openFromToolbar()
    await expect.element(page.getByRole('textbox', { name: 'URL' })).toHaveFocus()
    await page.getByText('Link text', { exact: true }).click()
    await expect.element(page.getByLabelText('Link text')).toHaveFocus()
  })

  it('Escape from inside the field cancels and changes nothing', async () => {
    await app.setDocument('Read the manual first.')
    await selectText('manual')
    await openFromToolbar()
    await type('https://nowhere.example/')
    await press('Escape')
    await waitFor(() => dialog() === null, { message: 'Escape never closed the dialog' })
    expect(hrefs()).toEqual([])
  })

  it('a press on the backdrop cancels', async () => {
    await app.setDocument('Read the manual first.')
    await selectText('manual')
    await openFromToolbar()
    await type('https://nowhere.example/')
    const box = dialog()!.getBoundingClientRect()
    await pointer.press({ x: box.left / 2, y: center(dialog()!).y })
    await waitFor(() => dialog() === null, { message: 'the backdrop never cancelled' })
    expect(hrefs()).toEqual([])
  })

  it('Tab walks from the URL to the link text, then to the buttons', async () => {
    await app.setDocument('See here.')
    await caretAfter(app, 'See')
    await openFromToolbar()
    await press('Tab')
    await expect.element(page.getByRole('textbox', { name: 'Link text' })).toHaveFocus()
    await press('Tab')
    await expect.element(button('Cancel')).toHaveFocus()
    await press('Tab')
    await expect.element(button('Insert')).toHaveFocus()
  })
})
