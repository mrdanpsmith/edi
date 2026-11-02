// The clipboard and select-all keys while a sheet is live, with real keys.
//
// Ported from `test_ctrl_c_copies_the_cells_when_a_sheet_is_live_and_the_document_when_it_is_not`
// and `test_select_all_in_a_sheet_selects_its_cells_and_in_a_reveal_it_means_the_reveal`
// (the sheet half). The window suite has to dispatch a synthetic `KeyboardEvent` on
// the grid by hand, guessing which element the key would come from; here the key
// goes wherever focus really is, so the routing between the grid's own handler and
// the window's `registerShortcuts` is exercised as a person's key press is.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  clickSheetCell,
  copiedContent,
  copiedTexts,
  liveSheet,
  modKey,
  openSheetAt,
  plainCell,
  plainTables,
  sheetCell,
  sheetGrid,
  sheetRange,
} from './table-helpers'

const DOC = 'Prose before the table.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nProse after the table.\n'

let app: BootedApp

beforeEach(async () => {
  app = bootApp()
  await app.setDocument(DOC)
  await openSheetAt(app, plainCell(plainTables(app)[0]!, '1'))
})

afterEach(() => app.dispose())

async function selectBodyRange(): Promise<void> {
  await clickSheetCell(app, 1, 0)
  await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowDown}{/Shift}')
  await waitFor(() => sheetRange(app).length === 4, { message: 'a 2x2 range' })
}

it('Ctrl+C copies the selected cells as TSV while a sheet is live, and the document once it is not', async () => {
  // A sheet collapses the document selection on entry, so the key is the grid's:
  // TSV of the range through `copyText`, never a rich copy of the prose around it.
  await selectBodyRange()
  await modKey('c')
  await waitFor(() => copiedTexts(app).length === 1, { message: 'the cells were not copied' })
  expect(copiedTexts(app)[0]!.split(/\r?\n/)).toEqual(['1\t2', '3\t4'])
  expect(copiedContent(app)).toEqual([])

  // Leave the sheet; select-all and copy now mean the document.
  await pointer.press(center(sheetCell(app, 1, 0)), { modifiers: ['Alt'] })
  await waitFor(() => liveSheet(app) === null, { message: 'the sheet never closed' })
  await modKey('a')
  await modKey('c')
  await waitFor(() => copiedContent(app).length === 1, { message: 'the document was not copied' })
  const [payload] = copiedContent(app)
  expect(payload!.text).toContain('Prose before the table.')
  expect(payload!.markdown).toContain('| --- | --- |')
  expect(copiedTexts(app)).toHaveLength(1)
})

it('Ctrl+A in a sheet selects its cells and keeps the caret in the grid, from the key or the menu', async () => {
  // Select-all belongs to the editor the reader is in: in a grid that is every
  // cell, and the caret must not be pulled out to the document around it.
  for (const how of ['key', 'menu'] as const) {
    await clickSheetCell(app, 1, 1)
    expect(sheetRange(app)).toHaveLength(1)
    if (how === 'key') await modKey('a')
    else {
      app.menu('selectAll')
      await settle()
    }
    const cells = sheetGrid(app).querySelectorAll('td.ss-cell')
    expect(cells.length).toBe(6)
    expect(sheetRange(app)).toHaveLength(cells.length)
    expect(document.activeElement).toBe(sheetGrid(app))
    expect(app.editor.querySelectorAll('.edi-block-selected')).toHaveLength(0)
    expect(document.getSelection()!.isCollapsed).toBe(true)
  }
})

it('Ctrl+X marks a pending cut, Escape cancels the cut before it leaves the sheet', async () => {
  // The cut is a rung of the Escape ladder of its own: cancel the pending cut,
  // and only the next Escape closes the sheet. Nothing is removed until a paste.
  await selectBodyRange()
  const before = app.markdown()
  await modKey('x')
  await waitFor(() => sheetGrid(app).querySelectorAll('td.ss-cut').length === 4, {
    message: 'no cut marked',
  })
  expect(copiedTexts(app)[0]!.split(/\r?\n/)).toEqual(['1\t2', '3\t4'])
  expect(app.markdown()).toBe(before)

  await userEvent.keyboard('{Escape}')
  await settle()
  expect(liveSheet(app)).not.toBeNull()
  expect(sheetGrid(app).querySelectorAll('td.ss-cut')).toHaveLength(0)

  await userEvent.keyboard('{Escape}')
  await waitFor(() => liveSheet(app) === null, { message: 'the second Escape did not leave' })
  expect(app.markdown()).toBe(before)
})

it('Ctrl+V pastes TSV from the shell clipboard into the cells from the active cell', async () => {
  // The grid reads the clipboard through the bridge and writes the block, rather
  // than letting the window's paste drop a paragraph beside the grid.
  app.bridge.answer('readClipboardText', () => ({ text: 'x\ty\nz\tw', html: '' }))
  await clickSheetCell(app, 1, 0)
  await modKey('v')
  await waitFor(() => app.markdown().includes('| x | y |'), { message: 'nothing was pasted' })
  expect(app.markdown()).toContain('| z | w |')
  expect(app.markdown()).toContain('Prose before the table.\n\n|')
  expect(app.doc().childCount).toBe(3)
  expect(liveSheet(app)).not.toBeNull()
})
