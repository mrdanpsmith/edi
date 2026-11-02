// Selecting text in Visual tables, and what Ctrl+C then puts on the clipboard.
//
// Ported from the frontend-only intent of
// `test_text_inside_a_visual_table_is_selected_word_by_word_and_copied`,
// `test_a_range_across_a_table_is_one_continuous_highlight`,
// `test_a_table_in_a_range_is_painted_whole`, `test_copying_across_a_table_is_unaffected`,
// `test_select_all_marks_every_selected_object`,
// `test_selection_is_the_browsers_where_the_browser_can_do_it` and
// `test_a_selected_visual_table_is_painted_by_its_cells_and_nothing_else`.
//
// The window suite builds its ranges with `addRange` and presses keys with synthetic
// events; here the drags and keys are trusted input, so the range is the one the
// browser really makes from a drag (including where it refuses to go), the copy key
// travels the real route to `registerShortcuts`, and the paint is read from computed
// styles of the shipped CSS.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, pointer, settle, waitFor, type BootedApp } from './app'
import {
  MOD,
  charLeft,
  charRight,
  copiedContent,
  copiedTexts,
  filledCells,
  highlightBoxes,
  modKey,
  paragraph,
  plainCell,
  plainTables,
  textBox,
} from './table-helpers'

const TWO_TABLES = `Prose that comes before the tables.

| Alpha | Bravo |
| --- | --- |
| one | two |
| three | four |

| Echo | Foxtrot |
| --- | --- |
| five | six |

Prose that comes after the tables.
`

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

/** A CSS colour token resolved to the `rgb()` spelling computed styles use. */
function token(name: string): string {
  const probe = document.createElement('div')
  probe.style.background = `var(${name})`
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).backgroundColor
  probe.remove()
  return value
}

function cellsOf(table: Element): HTMLElement[] {
  return [...table.querySelectorAll<HTMLElement>('th, td')]
}

describe('text inside a Visual table', () => {
  beforeEach(async () => {
    await app.setDocument(TWO_TABLES)
  })

  it('a drag inside one cell selects that fragment, highlights it to the words and copies it', async () => {
    // Chromium paints nothing inside the table, so the app draws one box over
    // the dragged characters; the cell is not filled, and the copy is the
    // fragment through `copyText` rather than the table's markdown.
    const three = plainCell(plainTables(app)[0]!, 'three')
    await pointer.drag(charLeft(three, 'three', 0), charRight(three, 'three', 2))
    await settle()
    expect(String(document.getSelection())).toBe('thr')
    expect(getComputedStyle(three).userSelect).toBe('text')

    const boxes = highlightBoxes(app)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.parentElement).toBe(three)
    const drawn = boxes[0]!.getBoundingClientRect()
    const words = textBox(three, 'three', 0, 3)
    expect(Math.abs(drawn.left - words.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(drawn.right - words.right)).toBeLessThanOrEqual(1)
    expect(drawn.width).toBeLessThan(three.getBoundingClientRect().width / 2)
    expect(getComputedStyle(boxes[0]!).backgroundColor).toBe(token('--selection'))
    expect(filledCells(app)).toHaveLength(0)

    await modKey('c')
    expect(copiedTexts(app)).toEqual(['thr'])
    expect(copiedContent(app)).toEqual([])
  })

  it('a double click on a word in a cell selects the word, as in prose', async () => {
    // Double click is the browser's in every block type, a Visual table included.
    const cell = plainCell(plainTables(app)[0]!, 'three')
    await userEvent.dblClick(cell)
    await settle()
    expect(String(document.getSelection())).toBe('three')
    expect(highlightBoxes(app)).toHaveLength(1)
    await modKey('c')
    expect(copiedTexts(app)).toEqual(['three'])
  })

  it('a drag across cells copies the cells tab- and newline-separated', async () => {
    // The copy is read from the range in the shape an editable table gives:
    // cells by tabs, rows by newlines, the block controls left out.
    const table = plainTables(app)[0]!
    await pointer.drag(charLeft(plainCell(table, 'one'), 'one', 0), charRight(plainCell(table, 'three'), 'three', 2))
    await settle()
    expect(highlightBoxes(app).length).toBeGreaterThanOrEqual(3)
    expect(highlightBoxes(app).every((b) => b.parentElement!.matches('th, td'))).toBe(true)
    await modKey('c')
    expect(copiedTexts(app)).toEqual(['one\ttwo\nthr'])
  })

  it('a drag from one table into the next stops at the first, and the copy says what is painted', async () => {
    // Measured here: a real drag (or Shift+click) whose anchor is inside a
    // contenteditable=false table cannot carry its focus into the next table —
    // Chromium clamps it to the first table's end. What matters is that the
    // paint and the clipboard agree: both are the first table only.
    const [first, second] = plainTables(app)
    await pointer.drag(
      charLeft(plainCell(first!, 'one'), 'one', 0),
      charRight(plainCell(second!, 'five'), 'five', 3),
    )
    await settle()
    const boxes = highlightBoxes(app)
    expect(boxes.length).toBeGreaterThan(0)
    expect(boxes.every((b) => first!.contains(b))).toBe(true)
    await modKey('c')
    expect(copiedTexts(app)).toEqual(['one\ttwo\nthree\tfour'])
  })

  it('a range from one table into the next is highlighted in both and copied whole', async () => {
    // The browser's own `toString()` stops at the end of the first table, so the
    // copy is read off the range. A drag cannot build this range (above), but
    // the Selection API can, and the copy route has to be right for it.
    const [first, second] = plainTables(app)
    expect(first!.nextElementSibling).toBe(second)
    const from = plainCell(first!, 'one').firstChild!
    const to = plainCell(second!, 'five').firstChild!
    document.getSelection()!.setBaseAndExtent(from, 0, to, 4)
    await waitFor(() => highlightBoxes(app).some((b) => second!.contains(b)), {
      message: 'the second table is not highlighted',
    })
    expect(String(document.getSelection())).not.toContain('five')
    expect(highlightBoxes(app).some((b) => first!.contains(b))).toBe(true)
    expect(highlightBoxes(app).every((b) => b.parentElement!.matches('th, td'))).toBe(true)
    expect(filledCells(app)).toHaveLength(0)

    await modKey('c')
    expect(copiedTexts(app)).toEqual(['one\ttwo\nthree\tfour\nEcho\tFoxtrot\nfive'])
  })
})

describe('a table inside a range', () => {
  beforeEach(async () => {
    await app.setDocument(TWO_TABLES)
  })

  it('a drag from the prose above to the prose below fills every cell and copies the tables as markdown', async () => {
    // A range that brackets the tables has no end in a cell, so the cells carry
    // the paint (one continuous highlight, no block mark) and the copy is the
    // document's rich copy with the tables still rendered as pipes.
    const before = paragraph(app, 'comes before')
    const after = paragraph(app, 'comes after')
    await pointer.drag(charLeft(before, 'comes', 0), charRight(after, 'after', 4))
    await settle()
    const cells = plainTables(app).flatMap(cellsOf)
    expect(filledCells(app)).toHaveLength(cells.length)
    expect(highlightBoxes(app)).toHaveLength(0)
    expect(app.editor.querySelectorAll('.edi-block-selected')).toHaveLength(0)
    const selection = token('--selection')
    expect(cells.every((c) => getComputedStyle(c).backgroundColor === selection)).toBe(true)

    await modKey('c')
    expect(copiedTexts(app)).toEqual([])
    const [payload] = copiedContent(app)
    expect(payload!.markdown).toContain('comes before the tables.')
    expect(payload!.markdown).toContain('| Alpha | Bravo |\n| --- | --- |')
    expect(payload!.markdown).toContain('| five | six |')
    expect(payload!.markdown).toContain('Prose that comes after')
  })

  it('one press in the prose afterwards drops the fill, in a single click', async () => {
    // The regression the last table-selection fix closed: a press in prose fires
    // `selectionchange` before ProseMirror commits the caret, so the cells used
    // to stay lit until a second click. Only a real press reproduces the order.
    const before = paragraph(app, 'comes before')
    const after = paragraph(app, 'comes after')
    await pointer.drag(charLeft(before, 'comes', 0), charRight(after, 'after', 4))
    await settle()
    expect(filledCells(app).length).toBeGreaterThan(0)
    await pointer.press(charLeft(after, 'comes', 2))
    await settle()
    expect(document.getSelection()!.isCollapsed).toBe(true)
    expect(filledCells(app)).toHaveLength(0)
  })

  it('Ctrl+Shift+Down from the paragraph above takes the table as one rung, and Ctrl+Shift+C copies its pipes', async () => {
    // `selectionExpand.ts`: the table is an atom the gesture brackets whole.
    await app.setDocument('Above the table.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nBelow the table.\n')
    await pointer.press(charLeft(paragraph(app, 'Above'), 'Above', 0))
    await settle()
    await userEvent.keyboard(`{${MOD}>}{Shift>}{ArrowDown}{/Shift}{/${MOD}}`)
    await settle()
    expect(filledCells(app)).toHaveLength(0)
    await userEvent.keyboard(`{${MOD}>}{Shift>}{ArrowDown}{/Shift}{/${MOD}}`)
    await waitFor(() => filledCells(app).length === 4, { message: 'the table is not in the range' })
    await userEvent.keyboard(`{${MOD}>}{Shift>}c{/Shift}{/${MOD}}`)
    await settle()
    const [markdown] = copiedTexts(app)
    expect(markdown).toContain('Above the table.')
    expect(markdown).toContain('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(markdown).not.toContain('Below')
  })
})

describe('select all', () => {
  const SPREADSHEETS = `\`\`\`edi-formula
GREET(name) = CONCAT("Hello, ", name, "!")
\`\`\`

| Name | Amount | Greeting |
| --- | ---: | --- |
| Dan | 25.25 | =GREET(A2) |
| **Total** | **=SUM(B2:B2)** |  |

| Height | Width |
| --- | --- |
| 97.6 | 63.7 |

A closing paragraph.
`

  it('paints every cell of every table, header included, and marks only the code block as an object', async () => {
    // A Visual table is text in a range, painted by its cells from `--selection`;
    // only blocks the browser cannot paint inside wear the solid object outline.
    await app.setDocument(SPREADSHEETS)
    await pointer.press(charLeft(paragraph(app, 'closing'), 'closing', 0))
    await modKey('a')
    const cells = plainTables(app).flatMap(cellsOf)
    await waitFor(() => filledCells(app).length === cells.length, { message: 'not every cell painted' })

    const marked = [...app.editor.querySelectorAll<HTMLElement>('.edi-block-selected')]
    expect(marked.map((el) => el.classList.contains('runnable-block'))).toEqual([true])
    expect(getComputedStyle(marked[0]!).outlineStyle).toBe('solid')
    expect(getComputedStyle(marked[0]!).outlineColor).toBe(token('--accent'))

    const selection = token('--selection')
    for (const table of plainTables(app)) {
      expect(table.classList.contains('edi-block-selected')).toBe(false)
      expect(getComputedStyle(table).outlineStyle).toBe('none')
      expect(getComputedStyle(table.querySelector('.ss-plain-table')!).outlineStyle).toBe('none')
      expect(cellsOf(table).map((c) => getComputedStyle(c).backgroundColor)).toEqual(
        cellsOf(table).map(() => selection),
      )
    }
    expect(paragraph(app, 'closing').closest('.edi-block-selected')).toBeNull()
  })

  it('then Ctrl+C copies the whole document, tables as markdown', async () => {
    await app.setDocument(SPREADSHEETS)
    await pointer.press(charLeft(paragraph(app, 'closing'), 'closing', 0))
    await modKey('a')
    await modKey('c')
    const [payload] = copiedContent(app)
    expect(payload!.markdown).toContain('GREET(name)')
    expect(payload!.markdown).toContain('| Height | Width |\n| --- | --- |\n| 97.6 | 63.7 |')
    expect(payload!.markdown).toContain('A closing paragraph.')
    expect(copiedTexts(app)).toEqual([])
  })
})
