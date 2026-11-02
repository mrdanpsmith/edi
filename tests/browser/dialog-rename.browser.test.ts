// The in-page rename dialog (`promptForRename` in `src/urlDialog.ts`), opened
// from the File menu command over a document that has a path.
//
// The real-browser part: the field is found by its label (which it was not
// associated with), the stem is what the opening selection covers so the
// first keystrokes replace the name and keep the extension, and a refused name
// is reported in place without closing the dialog.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { bootApp, settle, waitFor, type BootedApp } from './app'
import { press, type } from './edit-helpers'

const PATH = '/home/reader/notes/draft.md'

let app: BootedApp

beforeEach(async () => {
  app = bootApp()
  app.bridge.answer('pickOpenPath', () => [PATH])
  app.bridge.answer('readTextFile', () => 'Some notes.\n')
  app.menu('open')
  await waitFor(() => (document.querySelector('#tabbar .tab.active')?.textContent ?? '').includes('draft.md'), {
    message: 'the file never opened',
  })
  await settle()
})

afterEach(() => app.dispose())

const field = () => page.getByLabelText('New name for this document')
const dialog = (): HTMLElement | null => document.querySelector('.edi-dialog')

it('opens with the stem selected, so typing replaces the name and keeps .md', async () => {
  app.menu('rename')
  await expect.element(field()).toHaveFocus()
  await expect.element(field()).toHaveValue('draft.md')
  await type('final{Enter}')
  await waitFor(() => app.bridge.callsTo('renameTextFile').length === 1, { message: 'rename' })
  expect(app.bridge.callsTo('renameTextFile')[0]!.payload).toEqual({
    oldPath: PATH,
    newPath: '/home/reader/notes/final.md',
    content: 'Some notes.\n',
  })
  await waitFor(() => (document.querySelector('#tabbar .tab.active')?.textContent ?? '').includes('final.md'), {
    message: 'the tab never took the new name',
  })
})

it('refuses the current name and a path, in place, and keeps the dialog open', async () => {
  app.menu('rename')
  await expect.element(field()).toHaveFocus()
  await press('Enter')
  await expect.element(page.getByText('That is the document’s current name')).toBeVisible()

  await field().fill('../escape.md')
  await press('Enter')
  await expect.element(page.getByText('A document name is one file name, not a path')).toBeVisible()
  expect(dialog()).not.toBeNull()
  expect(app.bridge.callsTo('renameTextFile')).toEqual([])
})

it('Escape cancels without touching the file', async () => {
  app.menu('rename')
  await expect.element(field()).toHaveFocus()
  await type('other')
  await press('Escape')
  await waitFor(() => dialog() === null, { message: 'Escape never closed the dialog' })
  expect(app.bridge.callsTo('renameTextFile')).toEqual([])
})
