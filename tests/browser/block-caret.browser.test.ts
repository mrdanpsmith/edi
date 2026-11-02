// Where a press puts the caret around blocks, and what typing there does.
//
// Ported from `test_a_press_in_a_document_with_nowhere_to_type_creates_nothing`,
// `test_every_press_in_every_block_classifies_and_the_two_refusals_hold` and
// `test_a_block_marker_typed_in_front_of_a_paragraph_keeps_its_words` in
// `tests/window/test_window.py`. Those synthesise MouseEvents at an element and
// `execCommand('insertText')`; here the presses are trusted mouse input at
// exact coordinates (so `posAtCoords` and the hit test decide, as for a
// person) and the keys are real keystrokes. jsdom has no hit test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  caretBlock,
  caretParagraphText,
  charBox,
  dirtyCalls,
  pill,
  strip,
  topBlocks,
  waitForDiagrams,
} from './block-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const TABLES_ONLY =
  '```python\nprint(1)\n```\n\n' +
  '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n' +
  '| C | D |\n| --- | --- |\n| 3 | 4 |\n\n' +
  '| E | F |\n| --- | --- |\n| 5 | 6 |\n'

function gapCursors(): number {
  return app.editor.querySelectorAll('.ProseMirror-gapcursor').length
}

function selectedNodes(): number {
  return app.editor.querySelectorAll('.ProseMirror-selectednode').length
}

describe('a document with nowhere to type', () => {
  // A fresh document of tables starts on a gap cursor, never with its leading
  // atom node-selected (ProseMirror's default `Selection.atStart`).
  it('opens with a gap cursor rather than a selected block', async () => {
    await app.setDocument('| A | B |\n| --- | --- |\n| 1 | 2 |\n')
    app.editor.focus()
    await settle()
    expect(selectedNodes()).toBe(0)
    expect(gapCursors()).toBe(1)
  })

  // Clicking around must never create a block or dirty the file: beside a
  // table, between two tables, below the last block. Each press answers
  // with a gap cursor, the affordance without the edit.
  it('creates nothing on a press beside, between or below its blocks, and offers a gap cursor', async () => {
    await app.setDocument(TABLES_ONLY)
    const before = app.doc()
    const blocks = topBlocks(app)
    expect(blocks).toHaveLength(4)
    const grid = blocks[1].querySelector('.ss-plain-table')!.getBoundingClientRect()
    const points = [
      { x: grid.right + 40, y: grid.top + 20 },
      {
        x: grid.left + 8,
        y: (blocks[1].getBoundingClientRect().bottom + blocks[2].getBoundingClientRect().top) / 2,
      },
      { x: grid.left + 8, y: blocks[3].getBoundingClientRect().bottom + 60 },
    ]
    for (const at of points) {
      await pointer.press(at)
      await settle()
      expect(app.doc().eq(before), `press at ${at.x},${at.y}`).toBe(true)
      expect(selectedNodes(), `press at ${at.x},${at.y}`).toBe(0)
    }
    expect(dirtyCalls(app)).toBe(0)
  })

  // With no textblock at all (a code block's text counts as one), the caret a
  // press beside a block gets is a gap cursor on the pressed side.
  it('answers a press beside a table with a gap cursor when the document is only tables', async () => {
    await app.setDocument(TABLES_ONLY.slice(TABLES_ONLY.indexOf('|')))
    const before = app.doc()
    const blocks = topBlocks(app)
    expect(blocks).toHaveLength(3)
    for (const block of blocks) {
      const grid = block.querySelector('.ss-plain-table')!.getBoundingClientRect()
      await pointer.press({ x: grid.right + 40, y: grid.top + 20 })
      await settle()
      expect(gapCursors(), block.textContent ?? '').toBe(1)
      expect(selectedNodes()).toBe(0)
    }
    expect(app.doc().eq(before)).toBe(true)
  })

  // A gap cursor creates nothing by itself; typing at it does.
  it('turns typing at the gap cursor into a new paragraph', async () => {
    await app.setDocument(TABLES_ONLY)
    const last = topBlocks(app).at(-1)!.getBoundingClientRect()
    await pointer.press({ x: last.left + 8, y: last.bottom + 60 })
    await settle()
    expect(gapCursors()).toBe(1)
    await userEvent.keyboard('typed here')
    await waitFor(() => app.markdown().includes('typed here'))
    expect(app.markdown().trim().endsWith('typed here')).toBe(true)
    expect(topBlocks(app)).toHaveLength(5)
  })

  // The way to write in such a document is the sheet: one press on the table's
  // own cluster opens a surface that takes the caret.
  it("opens a table as a sheet from its cluster, and the sheet takes the focus", async () => {
    await app.setDocument(TABLES_ONLY)
    const table = topBlocks(app)[1]
    const r = table.getBoundingClientRect()
    await pointer.move({ x: r.left + 4, y: r.top + 4 })
    await waitFor(() => getComputedStyle(pill(table)).opacity === '1')
    const edit = [...pill(table).querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Edit',
    )!
    await pointer.press(center(edit))
    await waitFor(() => app.editor.querySelector('.ss-grid') !== null, { message: 'sheet open' })
    await waitFor(() => !!document.activeElement?.closest('.ss-grid'), { message: 'sheet focused' })
  })
})

describe('a press around blocks in a document with prose', () => {
  // The space beside a narrow table maps onto the table atom by coordinates;
  // a press there is a request for a caret beside it, never a block selection.
  it('beside a table puts a caret in the prose, not a selection on the table', async () => {
    await app.setDocument('Prose above.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nProse below.')
    const before = app.doc()
    const table = topBlocks(app)[1]
    const grid = table.querySelector('.ss-plain-table')!.getBoundingClientRect()
    await pointer.press({ x: grid.right + 40, y: grid.top + grid.height / 2 })
    await settle()
    expect(selectedNodes()).toBe(0)
    expect(['Prose above.', 'Prose below.']).toContain(caretParagraphText())
    expect(app.doc().eq(before)).toBe(true)
  })

  // A press in a cell is the browser's text selection: no block selection and
  // no painted cells.
  it('in a table cell selects neither the table nor its cells', async () => {
    await app.setDocument('Prose above.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nProse below.')
    const cell = app.editor.querySelector('.ss-plain tbody td')!
    await pointer.press(center(cell))
    await settle()
    expect(selectedNodes()).toBe(0)
    expect(app.editor.querySelectorAll('.ss-cell-in-selection')).toHaveLength(0)
  })

  // The strip is the page's white space wherever no button is. A press in the
  // right margin beside a line of a paragraph is a caret at the end of *that*
  // line, as a press in the left gutter is a caret at its start. It used to
  // fall through to the browser's own placement for a non-editable box, which
  // put the caret at the start of the next paragraph.
  it("in a paragraph's right margin puts the caret at the end of the line beside it", async () => {
    await app.setDocument(
      `First paragraph, ${'long enough to wrap onto several lines, '.repeat(12)}the end.\n\n` +
        'Second paragraph.',
    )
    const first = topBlocks(app)[0]
    const s = strip(first)!.getBoundingClientRect()
    const row = pill(first).getBoundingClientRect()
    expect(s.bottom - row.bottom).toBeGreaterThan(40)

    // Beside each line below the row, at the strip's near edge, middle and far edge.
    const offsets: number[] = []
    for (const f of [0.4, 0.65, 0.9]) {
      for (const dx of [2, s.width / 2, s.width - 4]) {
        await pointer.press({ x: s.left + dx, y: s.top + s.height * f })
        await settle()
        expect(caretBlock(app), `${f} ${dx}`).toBe(first)
        if (dx === 2) offsets.push(document.getSelection()!.anchorOffset)
      }
    }
    // Three different lines, top to bottom.
    expect(offsets[0]).toBeLessThan(offsets[1])
    expect(offsets[1]).toBeLessThan(offsets[2])
    expect(app.editor.querySelector('.edi-block-mode')).toBeNull()

    // Beside the last line, the caret is at the paragraph's end.
    await pointer.press({ x: s.left + s.width / 2, y: s.bottom - 3 })
    await settle()
    await userEvent.keyboard('!')
    await waitFor(() => app.markdown().includes('!'))
    expect(app.markdown()).toContain('the end.!\n\nSecond paragraph.')
  })

  // A press on a diagram's drawing is the diagram's business: it changes
  // nothing in the document and opens no mode.
  it('on a diagram changes nothing', async () => {
    await app.setDocument('Prose.\n\n```mermaid\ngraph TD\n  A[Alpha]\n```\n\nMore prose.')
    await waitForDiagrams(app)
    const before = app.doc()
    await pointer.press(center(app.editor.querySelector('.mermaid svg')!))
    await settle()
    expect(app.doc().eq(before)).toBe(true)
    expect(app.editor.querySelector('.edi-block-mode')).toBeNull()
  })
})

describe('a block marker typed in front of a paragraph', () => {
  const DOC = 'First para.\n\nSecond para.\n\n## Heading\n\nTail para.'

  async function caretAtStartOfSecond(): Promise<void> {
    await app.setDocument(DOC)
    const box = charBox(app.editor, 'Second', 0)
    await pointer.press({ x: box.left + 1, y: box.top + box.height / 2 })
    await settle()
  }

  // A block-start rule rebuilds the block from what its regex matched, which
  // is only the text before the caret: `## ` used to delete the paragraph.
  it('`## ` makes a heading that keeps the words', async () => {
    await caretAtStartOfSecond()
    await userEvent.keyboard('## ')
    await waitFor(() => app.markdown().includes('## Second para.'))
    expect(app.markdown().trim()).toBe('First para.\n\n## Second para.\n\n## Heading\n\nTail para.')
  })

  // The list rules keep the text too: it becomes the item's.
  it('`- [ ] ` makes a task item that keeps the words', async () => {
    await caretAtStartOfSecond()
    await userEvent.keyboard('- [[ ] ') // `[[` is a literal `[`
    await waitFor(() => app.markdown().includes('- [ ] Second para.'))
    expect(topBlocks(app)).toHaveLength(4)
  })

  // A fence and a rule are whole-line constructs, so they decline on a line
  // that has more on it: the prose stays prose.
  it('a fence or a rule in front of prose declines and leaves the prose', async () => {
    await caretAtStartOfSecond()
    await userEvent.keyboard('```py ')
    await settle()
    expect(app.markdown()).toContain('```py Second para.')
    expect(app.editor.querySelectorAll('.cm-editor')).toHaveLength(0)

    await caretAtStartOfSecond()
    await userEvent.keyboard('---')
    await settle()
    expect(app.markdown()).toContain('---Second para.')
    expect(app.editor.querySelectorAll('hr')).toHaveLength(0)
  })
})
