// Entering and leaving a live sheet (a table's Edit mode) with real input.
//
// Ported from the frontend-only intent of the window suite's sheet tests
// (`test_escape_leaves_a_sheet_and_escape_in_a_cell_does_not`,
// `test_a_double_click_in_a_spreadsheet_cell_stays_a_word_selection`,
// `test_a_press_beside_a_live_sheet_is_an_ordinary_press`,
// `test_a_press_in_the_document_does_not_damage_the_grid_holding_a_selection`,
// `test_a_table_as_a_sheet_is_marked_like_any_other_mode`,
// `test_entering_a_mode_drops_a_document_wide_selection`). Those have to
// synthesise `MouseEvent`/`KeyboardEvent`s in JavaScript; here the Alt+click,
// double click, Escape and typing are trusted Playwright input, so focus moves
// and the browser's own default actions run exactly as they would for a person.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  charLeft,
  clickSheetCell,
  filledCells,
  liveSheet,
  modKey,
  openSheetAt,
  paragraph,
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
})

afterEach(() => app.dispose())

function modeLabels(block: Element): Array<string | null> {
  return [...block.querySelectorAll('.block-control-representation, .block-control-form')].map(
    (b) => b.getAttribute('aria-label'),
  )
}

describe('entering and leaving a sheet', () => {
  it('Alt+click on a cell opens the sheet, marked dashed, and Alt+click on the sheet closes it', async () => {
    // Pins the mode's vocabulary and mark: the plain cluster says Edit/Source, an
    // open sheet says Visual/Source, wears the shared dashed outline (no bar) and
    // the chip says Edit; the plain table wears nothing. Needs real Alt+click and
    // computed styles from the shipped CSS.
    const before = app.markdown()
    expect(modeLabels(plainTables(app)[0]!)).toEqual(['Edit', 'Source'])
    expect(getComputedStyle(plainTables(app)[0]!).outlineStyle).toBe('none')

    await openSheetAt(app, plainCell(plainTables(app)[0]!, '1'))
    const sheet = liveSheet(app)!
    await waitFor(() => document.activeElement === sheetGrid(app), { message: 'grid focus' })
    expect(getComputedStyle(sheet).outlineStyle).toBe('dashed')
    expect(getComputedStyle(sheet).boxShadow).toBe('none')
    expect(document.querySelector('#status-mode')!.textContent).toMatch(/^Edit/)
    expect(modeLabels(sheet.querySelector('.block-controls')!)).toEqual(['Visual', 'Source'])

    await pointer.press(center(sheetCell(app, 1, 0)), { modifiers: ['Alt'] })
    await waitFor(() => liveSheet(app) === null && plainTables(app).length === 1, {
      message: 'the sheet never closed',
    })
    // A mode is plugin state, never document content.
    expect(app.markdown()).toBe(before)
  })

  it('Ctrl+A then Alt+click drops the document-wide selection on the way in', async () => {
    // Entering a mode is a fresh start on one block: the select-all paint must
    // not survive into the sheet, or the dashed mark reads as "selected".
    await modKey('a')
    await waitFor(() => filledCells(app).length > 0, { message: 'select-all paint' })
    await openSheetAt(app, plainCell(plainTables(app)[0]!, '2'))
    expect(document.getSelection()!.isCollapsed).toBe(true)
    expect(app.editor.querySelectorAll('.edi-block-selected')).toHaveLength(0)
    expect(getComputedStyle(liveSheet(app)!).outlineStyle).toBe('dashed')
  })

  it('a double click in a sheet cell edits that cell and keeps the sheet', async () => {
    // Double click is the browser's (and the grid's in-cell editor), never a mode
    // gesture: it must not leave the sheet.
    await openSheetAt(app, plainCell(plainTables(app)[0]!, '1'))
    await userEvent.dblClick(sheetCell(app, 2, 0))
    await settle()
    expect(liveSheet(app)).not.toBeNull()
    const input = liveSheet(app)!.querySelector<HTMLInputElement>('.ss-edit-input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect(input!.value).toBe('3')
    expect(liveSheet(app)!.querySelector('.block-control-form')!.getAttribute('aria-label')).toBe('Visual')
  })
})

describe('the Escape ladder', () => {
  it('rejects a cell edit first, then leaves the sheet with the caret back in the document', async () => {
    // The first Escape belongs to the field and discards what was typed; the
    // second leaves the sheet the way Alt+click does — and, like Alt+click, it
    // must leave the reader somewhere to type. Real keys, so focus is real.
    await openSheetAt(app, plainCell(plainTables(app)[0]!, '1'))
    await clickSheetCell(app, 1, 1)
    await userEvent.keyboard('DISCARDS')
    await waitFor(() => liveSheet(app)!.querySelector('.ss-edit-input') !== null)

    await userEvent.keyboard('{Escape}')
    await settle()
    expect(liveSheet(app)).not.toBeNull()
    expect(liveSheet(app)!.querySelector('.ss-edit-input')).toBeNull()
    expect(liveSheet(app)!.textContent).not.toContain('DISCARDS')
    expect(document.activeElement).toBe(sheetGrid(app))

    await userEvent.keyboard('{Escape}')
    await waitFor(() => liveSheet(app) === null && plainTables(app).length === 1, {
      message: 'the second Escape did not leave the sheet',
    })
    expect(app.markdown()).not.toContain('DISCARDS')

    // Out of the sheet, the editor has the caret, beside the table and not in it.
    expect(document.activeElement).toBe(app.editor)
    await userEvent.keyboard('Z')
    await settle()
    expect(app.markdown()).toContain('| 1 | 2 |')
    expect(app.markdown()).toContain('ZProse after the table.')
  })

  it('closes formula suggestions before it rejects the edit', async () => {
    // Three rungs when the autocomplete is open: list, then edit, then sheet.
    await openSheetAt(app, plainCell(plainTables(app)[0]!, '1'))
    await clickSheetCell(app, 2, 1)
    await userEvent.keyboard('=SU')
    await waitFor(() => document.querySelector('.ss-ac-list') !== null, { message: 'suggestions' })

    await userEvent.keyboard('{Escape}')
    await settle()
    expect(document.querySelector('.ss-ac-list')).toBeNull()
    const input = liveSheet(app)!.querySelector<HTMLInputElement>('.ss-edit-input')
    expect(input?.value).toBe('=SU')

    await userEvent.keyboard('{Escape}')
    await settle()
    expect(liveSheet(app)!.querySelector('.ss-edit-input')).toBeNull()
    expect(sheetCell(app, 2, 1).textContent).toBe('4')

    await userEvent.keyboard('{Escape}')
    await waitFor(() => liveSheet(app) === null, { message: 'the third Escape did not leave' })
  })
})

describe('the document beside a live sheet', () => {
  it('a press in a paragraph moves the caret there and leaves the grid selection alone', async () => {
    // The grid's anchor/active/range are the reader's work; a press outside the
    // sheet is ordinary editing (focus follows it) and must not reset them.
    await openSheetAt(app, plainCell(plainTables(app)[0]!, '1'))
    await clickSheetCell(app, 1, 0)
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowDown}{/Shift}')
    await waitFor(() => sheetRange(app).length === 4, { message: 'a 2x2 range' })
    const range = sheetRange(app).map((c) => c.textContent)

    for (const needle of ['Prose before', 'Prose after']) {
      await pointer.press(charLeft(paragraph(app, needle), 'Prose', 2))
      await settle()
      expect(liveSheet(app)).not.toBeNull()
      expect(sheetRange(app).map((c) => c.textContent)).toEqual(range)
      expect(sheetGrid(app).querySelectorAll('td.ss-active')).toHaveLength(1)
      expect(document.activeElement).toBe(app.editor)
      const anchor = document.getSelection()!.anchorNode!
      expect(paragraph(app, needle).contains(anchor)).toBe(true)
    }
    // An ordinary press opens no block's Source.
    expect(app.editor.querySelectorAll(':scope > .block-source-mode')).toHaveLength(0)
  })

  it('Alt+click on a paragraph opens that paragraph and hands the sheet back', async () => {
    // Alt+click names the block it is over: the paragraph's Source opens and
    // the table returns to its plain form — one working state at a time.
    await openSheetAt(app, plainCell(plainTables(app)[0]!, '1'))
    await pointer.press(charLeft(paragraph(app, 'Prose after'), 'Prose', 2), { modifiers: ['Alt'] })
    await waitFor(
      () =>
        app.editor.querySelectorAll(':scope > .block-source-mode').length === 1 &&
        liveSheet(app) === null,
      { message: 'the paragraph never took the working state' },
    )
    expect(plainTables(app)).toHaveLength(1)
  })
})
