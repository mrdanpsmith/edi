// Presses on, beside and around a Visual table, with real mouse input.
//
// Ported from `test_a_press_beside_a_table_puts_the_caret_beside_it`,
// `test_the_space_beside_a_table_is_white_space_not_part_of_the_table`,
// `test_a_click_with_nothing_to_select_drops_a_visual_tables_fill` and
// `test_a_press_in_a_document_with_nowhere_to_type_creates_nothing`. Which element
// is under the point (the grid, or the scroller's margin beside it) is the whole
// question, and it needs a real hit test; the window suite also notes it cannot
// make a synthetic press move the browser's caret, which a trusted press does.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp, type Point } from './app'
import { MOD, filledCells, liveSheet, modKey, plainTables, sheetGrid } from './table-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const SMALL = 'Prose above.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nProse below.\n'

const TABLES_ONLY = `\`\`\`edi-formula
GREET(name) = CONCAT("Hello, ", name, "!")
\`\`\`

| # | Provider | Username |
| --- | --- | --- |
| 1 | Hulu | one |
| 2 | Netflix | two |

| Name | Order | Amount |
| --- | --- | --- |
| Dan | 1 | 25.25 |
| Renee | 2 | 25.32 |
| John | 3 | 50 |

| Height | Width | Depth |
| --- | --- | --- |
| 97.6 | 63.7 | 5.1 |
`

function grid(table: Element): HTMLElement {
  return table.querySelector<HTMLElement>('.ss-plain-table')!
}

/** `dx` px to the right of a table's grid, at its vertical middle. */
function beside(table: Element, dx: number): Point {
  const box = grid(table).getBoundingClientRect()
  return { x: box.right + dx, y: box.top + box.height / 2 }
}

function topLevelKinds(): string[] {
  return [...app.editor.children]
    .filter((b) => !b.classList.contains('ProseMirror-gapcursor'))
    .map((b) =>
      b.classList.contains('ss-plain') ? 'table'
        : b.classList.contains('runnable-block') ? 'code'
          : 'para',
    )
}

function selectedNodes(): Element[] {
  return [...app.editor.querySelectorAll('.ProseMirror-selectednode')]
}

describe('the space beside a table', () => {
  beforeEach(async () => {
    await app.setDocument(SMALL)
  })

  it('is the block row, wider than the grid, and the strip beside the grid is the margin', async () => {
    // The block is the row like any paragraph; the grid inside it is only as
    // wide as its columns, and the strip beside it is the declared margin.
    const table = plainTables(app)[0]!
    const block = table.getBoundingClientRect()
    const gridBox = grid(table).getBoundingClientRect()
    expect(block.width).toBeGreaterThan(300)
    expect(gridBox.width).toBeLessThan(200)
    expect(Math.round(gridBox.left)).toBe(Math.round(block.left))
    for (const dx of [8, 60, 200]) {
      const at = beside(table, dx)
      const hit = document.elementFromPoint(at.x, at.y)!
      expect(hit.closest('.ss-plain')).toBe(table)
      expect(hit.classList.contains('ss-plain-scroll')).toBe(true)
      expect(hit.closest('.ss-plain-table')).toBeNull()
    }
  })

  it('a press there puts a caret in the prose beside the table, selects nothing and creates nothing', async () => {
    // ProseMirror's own answer beside a narrow atom is a NodeSelection on it —
    // the whole row painted and no caret. `press.ts` answers it as white space.
    const before = app.markdown()
    const table = plainTables(app)[0]!
    await pointer.press(beside(table, 120))
    await settle()
    const sel = document.getSelection()!
    expect(selectedNodes()).toHaveLength(0)
    expect(sel.isCollapsed).toBe(true)
    expect(table.contains(sel.anchorNode)).toBe(false)
    expect(sel.anchorNode!.parentElement!.closest('p')).not.toBeNull()
    expect(app.editor.querySelector('.ProseMirror-gapcursor')).toBeNull()
    expect(filledCells(app)).toHaveLength(0)
    expect(getComputedStyle(table).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(table).outlineStyle).toBe('none')
    expect(app.markdown()).toBe(before)

    // And it is a real caret: typing lands in the prose, not in a new block.
    await userEvent.keyboard('Q')
    await settle()
    expect(topLevelKinds()).toEqual(['para', 'table', 'para'])
    expect(app.markdown()).toMatch(/Q/)
    expect(app.markdown()).toContain('| 1 | 2 |')
  })

  it('after Ctrl+A, a press there drops the paint over the table', async () => {
    await pointer.press(center(app.editor.querySelector('p')!))
    await modKey('a')
    await waitFor(() => filledCells(app).length === 4, { message: 'select-all paint' })
    await pointer.press(beside(plainTables(app)[0]!, 120))
    await settle()
    expect(filledCells(app)).toHaveLength(0)
    expect(selectedNodes()).toHaveLength(0)
    expect(document.getSelection()!.isCollapsed).toBe(true)
  })
})

describe('a document of nothing but tables', () => {
  beforeEach(async () => {
    await app.setDocument(TABLES_ONLY)
    await waitFor(() => plainTables(app).length === 3)
  })

  async function selectAll(): Promise<void> {
    await modKey('a')
    await waitFor(() => filledCells(app).length === 27, { message: 'select-all paint' })
  }

  it('one click in a cell after Ctrl+A drops the paint everywhere, the clicked table included', async () => {
    // The report was "once you select all there's no way to unselect". A click
    // that selected nothing gives a caret beside the table — never the table
    // as an object, which took a second click to clear.
    await pointer.press(center(grid(plainTables(app)[0]!)))
    await selectAll()
    const cell = plainTables(app)[1]!.querySelectorAll('tbody td')[3]!
    await pointer.press(center(cell))
    await settle()
    expect(filledCells(app)).toHaveLength(0)
    expect(selectedNodes()).toHaveLength(0)
  })

  it(`a ${MOD}+click in a cell after Ctrl+A extends rather than drops the selection`, async () => {
    // A modifier press is the reader extending a selection; clearing it there
    // would fight them.
    await pointer.press(center(grid(plainTables(app)[0]!)))
    await selectAll()
    const cell = plainTables(app)[1]!.querySelectorAll('tbody td')[3]!
    await pointer.press(center(cell), { modifiers: [MOD] })
    await settle()
    const others = [plainTables(app)[0]!, plainTables(app)[2]!]
    expect(others.every((t) => t.querySelectorAll('.ss-cell-in-selection').length === t.querySelectorAll('th, td').length)).toBe(true)
  })

  it('presses beside, between and below the tables create no block and offer a gap cursor', async () => {
    // Clicking around must not edit the file. With no textblock anywhere, the
    // affordance is a gap cursor, which is a mark and not a block.
    const before = app.markdown()
    const kinds = topLevelKinds()
    expect(kinds).toEqual(['code', 'table', 'table', 'table'])
    const [first, second] = plainTables(app)
    const firstGrid = grid(first!).getBoundingClientRect()
    const last = app.editor.lastElementChild!.getBoundingClientRect()
    const points: Point[] = [
      beside(first!, 40),
      {
        x: firstGrid.left + 8,
        y: (first!.getBoundingClientRect().bottom + second!.getBoundingClientRect().top) / 2,
      },
      { x: firstGrid.left + 8, y: last.bottom + 60 },
    ]
    for (const at of points) {
      await pointer.press(at)
      await settle()
      expect(topLevelKinds()).toEqual(kinds)
    }
    expect(app.markdown()).toBe(before)
    expect(app.editor.querySelectorAll('.ProseMirror-gapcursor').length).toBeGreaterThanOrEqual(1)
  })

  it("the table's own Edit control opens it as a sheet that takes the caret", async () => {
    // "Nowhere to type" is answered by the sheet: one click in the block's own
    // cluster, and the grid is the typing surface.
    const table = plainTables(app)[0]!
    const edit = table.querySelector<HTMLElement>('.block-controls .block-control-form')!
    expect(edit.getAttribute('aria-label')).toBe('Edit')
    await userEvent.click(edit)
    await waitFor(() => liveSheet(app) !== null, { message: 'the sheet never opened' })
    await waitFor(() => sheetGrid(app).contains(document.activeElement), { message: 'grid focus' })
    await userEvent.keyboard('X{Enter}')
    await settle()
    expect(app.markdown()).toContain('| X | Provider | Username |')
  })
})
