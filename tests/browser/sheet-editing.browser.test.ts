// Editing a live sheet with real keys and a real mouse: typing into cells, formula
// autocomplete, Excel-style point mode, mouse range selection, the fill handle and
// the sheet's own control row.
//
// Each of these needs a real browser: the suggestion list is positioned from the
// input's layout box, point mode and the fill handle resolve the cell under a
// moving pointer, and a range drag reads `mousemove` targets from the hit test.
// `test_a_sheets_own_controls_stay_in_its_own_row_at_the_left` is ported here too.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  clickSheetCell,
  liveSheet,
  openSheetAt,
  plainCell,
  plainTables,
  sheetCell,
  sheetGrid,
  sheetRange,
} from './table-helpers'

const DOC = '| Item | Qty | Double |\n| --- | --- | --- |\n| a | 1 | =B2*2 |\n| b | 3 |  |\n| c | 5 |  |\n\nAfter.\n'

let app: BootedApp

beforeEach(async () => {
  app = bootApp()
  await app.setDocument(DOC)
  await openSheetAt(app, plainCell(plainTables(app)[0]!, 'a'))
})

afterEach(() => app.dispose())

function editInput(): HTMLInputElement | null {
  return liveSheet(app)?.querySelector<HTMLInputElement>('.ss-edit-input') ?? null
}

function suggestions(): string[] {
  return [...document.querySelectorAll('.ss-ac-item-name')].map((el) => el.textContent ?? '')
}

function selectedSuggestion(): string | null {
  return document.querySelector('.ss-ac-item.is-selected .ss-ac-item-name')?.textContent ?? null
}

describe('typing in cells', () => {
  it('a key on the grid starts an edit with that key, and Enter commits and moves down', async () => {
    // The grid's own keyboard model: a printable key replaces the cell, Enter
    // commits it to the document and steps to the row below.
    await clickSheetCell(app, 2, 0)
    await userEvent.keyboard('zed')
    expect(editInput()?.value).toBe('zed')
    await userEvent.keyboard('{Enter}')
    await settle()
    expect(editInput()).toBeNull()
    expect(app.markdown()).toContain('| zed | 3 |')
    expect(sheetCell(app, 3, 0).classList.contains('ss-active')).toBe(true)
    expect(document.activeElement).toBe(sheetGrid(app))
  })
})

describe('formula autocomplete', () => {
  it('opens under the cell editor, arrows through matches and accepts with Enter', async () => {
    // The list is `position: fixed` from the input's own box, so where it lands
    // is layout; the keys are real, so the editor's handler order is real too.
    await clickSheetCell(app, 3, 2)
    await userEvent.keyboard('=SU')
    await waitFor(() => suggestions().length > 0, { message: 'no suggestions' })
    const input = editInput()!
    const list = document.querySelector<HTMLElement>('.ss-ac-list')!
    const inputBox = input.getBoundingClientRect()
    const listBox = list.getBoundingClientRect()
    expect(Math.abs(listBox.left - inputBox.left)).toBeLessThanOrEqual(1)
    expect(listBox.top).toBeGreaterThanOrEqual(inputBox.bottom)
    expect(listBox.top - inputBox.bottom).toBeLessThanOrEqual(4)
    expect(suggestions().slice(0, 2)).toEqual(['SUM', 'SUMIF'])
    expect(selectedSuggestion()).toBe('SUM')

    await userEvent.keyboard('{ArrowDown}')
    expect(selectedSuggestion()).toBe('SUMIF')
    await userEvent.keyboard('{ArrowUp}')
    expect(selectedSuggestion()).toBe('SUM')

    // Enter accepts the suggestion — it does not commit the cell — and leaves the
    // caret between the parentheses, ready for the arguments.
    await userEvent.keyboard('{Enter}')
    expect(document.querySelector('.ss-ac-list')).toBeNull()
    expect(editInput()?.value).toBe('=SUM()')
    expect(editInput()?.selectionStart).toBe(5)

    await userEvent.keyboard('B2:B4{Enter}')
    await settle()
    expect(app.markdown()).toContain('| c | 5 | =SUM(B2:B4) |')
    expect(sheetCell(app, 3, 2).textContent).toBe('9')
  })

  it('a click on a suggestion inserts it without committing or closing the editor', async () => {
    // The list swallows its own mousedown so the click never blurs the input,
    // which would commit a half-typed formula.
    await clickSheetCell(app, 3, 2)
    await userEvent.keyboard('=AVER')
    await waitFor(() => suggestions().includes('AVERAGE'), { message: 'no AVERAGE' })
    const item = [...document.querySelectorAll<HTMLElement>('.ss-ac-item')].find(
      (el) => el.querySelector('.ss-ac-item-name')?.textContent === 'AVERAGE',
    )!
    await pointer.press(center(item))
    await settle()
    expect(editInput()).not.toBeNull()
    expect(document.activeElement).toBe(editInput())
    expect(editInput()!.value).toBe('=AVERAGE()')
    expect(app.markdown()).not.toContain('AVERAGE')
  })
})

describe('point mode', () => {
  it('a click on another cell while typing a formula inserts its reference', async () => {
    // Excel-style reference picking: the press is resolved to a cell by the hit
    // test and becomes `B3` in the formula instead of moving the selection.
    await clickSheetCell(app, 3, 2)
    await userEvent.keyboard('=')
    await pointer.press(center(sheetCell(app, 2, 1)))
    await settle()
    expect(editInput()?.value).toBe('=B3')
    await userEvent.keyboard('+')
    await pointer.press(center(sheetCell(app, 3, 1)))
    await settle()
    expect(editInput()?.value).toBe('=B3+B4')
    await userEvent.keyboard('{Enter}')
    await settle()
    expect(app.markdown()).toContain('| c | 5 | =B3+B4 |')
    expect(sheetCell(app, 3, 2).textContent).toBe('8')
  })
})

describe('the mouse in the grid', () => {
  it('a drag across cells selects the rectangle between them', async () => {
    // The range follows the cell under the moving pointer (`mousemove` targets),
    // which only a real hit test can say.
    await pointer.drag(center(sheetCell(app, 1, 0)), center(sheetCell(app, 2, 1)))
    await settle()
    expect(sheetRange(app).map((c) => c.textContent)).toEqual(['a', '1', 'b', '3'])
    expect(sheetCell(app, 2, 1).classList.contains('ss-active')).toBe(true)
  })

  it('dragging the fill handle down fills the formula with shifted references', async () => {
    // The handle is a 10px square at the selection's corner; the fill grows to
    // the row under the pointer and rewrites `B2` per row on release.
    await clickSheetCell(app, 1, 2)
    const handle = await waitForHandle()
    const box = handle.getBoundingClientRect()
    const grab = { x: box.left + 3, y: box.top + 3 }
    expect(document.elementFromPoint(grab.x, grab.y)).toBe(handle)
    await pointer.drag(grab, center(sheetCell(app, 3, 2)))
    await settle()
    expect(app.markdown()).toContain('| b | 3 | =B3*2 |')
    expect(app.markdown()).toContain('| c | 5 | =B4*2 |')
    expect([2, 3].map((r) => sheetCell(app, r, 2).textContent)).toEqual(['6', '10'])
  })

  it('a click on a column header selects the column and the align control writes its alignment', async () => {
    // The header is chrome around the grid; the align button is in the sheet's
    // own control row. One commit, visible in the saved markdown.
    const header = sheetGrid(app).querySelectorAll<HTMLElement>('thead th.ss-col')[1]!
    await pointer.press(center(header))
    await settle()
    expect(sheetRange(app).map((c) => c.textContent)).toEqual(['Qty', '1', '3', '5'])
    const right = liveSheet(app)!.querySelector<HTMLElement>('.ss-tool-icon[data-align="right"]')!
    await userEvent.click(right)
    await waitFor(() => app.markdown().includes('| --- | ---: | --- |'), { message: 'no alignment' })
  })
})

describe("the sheet's own controls", () => {
  it('stay in the sheet row at the left; the cluster holds only the modes', async () => {
    // Column and cell controls live beside the grid they act on, left of the
    // status readout (which takes the row's slack); the hover cluster is about
    // the block and holds Visual and Source alone.
    const sheet = liveSheet(app)!
    const tools = sheet.querySelector('.ss-tools')!
    const cluster = sheet.querySelector('.block-controls')!
    const left = (selector: string): number =>
      sheet.querySelector(selector)!.getBoundingClientRect().left - sheet.getBoundingClientRect().left
    for (const selector of ['.ss-tool-icon', '.ss-tool-view', '.ss-tool-check', '.ss-status']) {
      expect(tools.contains(sheet.querySelector(selector)), selector).toBe(true)
      expect(cluster.contains(sheet.querySelector(selector)), selector).toBe(false)
    }
    for (const selector of ['.ss-tool-icon', '.ss-tool-view', '.ss-tool-check']) {
      expect(left(selector), selector).toBeLessThan(left('.ss-status'))
    }
    expect(left('.ss-tool-check')).toBeGreaterThan(left('.ss-tool-view'))
    expect(
      [...cluster.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Visual', 'Source'])
  })
})

async function waitForHandle(): Promise<HTMLElement> {
  await waitFor(() => liveSheet(app)!.querySelector('.ss-fill-handle') !== null, {
    message: 'no fill handle',
  })
  return liveSheet(app)!.querySelector<HTMLElement>('.ss-fill-handle')!
}
