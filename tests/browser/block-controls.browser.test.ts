// The control cluster beside every top-level block, with real layout and a
// real pointer.
//
// Ported from the cluster tests in `tests/window/test_window.py`
// (`test_a_code_blocks_copy_lives_in_its_control_cluster`,
// `test_a_blocks_controls_are_beside_it_and_never_over_its_text`,
// `test_a_blocks_controls_can_be_reached_with_the_pointer`,
// `test_a_rules_whole_row_reaches_its_controls`,
// `test_a_blocks_controls_clear_its_own_editing_outline`,
// `test_a_source_blocks_way_out_lives_in_its_control_cluster`). The Qt suite
// cannot hover, so it re-installs the reveal rule as a class; here the mouse
// really hovers, so the reveal under test is the shipped `:hover` rule itself.
// jsdom has no layout, so none of this can live in a unit test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  control,
  controlLabels,
  dirtyCalls,
  hitKind,
  pill,
  pressControl,
  revealControls,
  strip,
  topBlocks,
  waitForDiagrams,
  waitForSelector,
} from './block-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const MIXED =
  'A paragraph long enough to reach the right edge of the column, with words in it.\n\n' +
  '## A heading\n\n' +
  '- a list item\n- another one\n\n' +
  '```python\nprint(1)\n```\n\n' +
  '```python\n#!/usr/bin/env python3\nprint(2)\n```\n\n' +
  '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n' +
  '```mermaid\ngraph TD\n  A[Alpha] --> B[Beta]\n```\n'

/** The box of the block's first visible character outside its own cluster. */
function firstGlyph(block: HTMLElement): DOMRect | null {
  const cluster = strip(block)
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || cluster?.contains(node)) continue
    if (node.parentElement?.closest('style')) continue
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 1)
    const box = range.getBoundingClientRect()
    if (box.width > 0) return box
  }
  return null
}

async function loadMixed(): Promise<void> {
  await app.setDocument(MIXED)
  await waitForDiagrams(app)
}

describe('a code block cluster', () => {
  // Copy used to be a second absolutely positioned control in the cluster's
  // corner; it is now one of the row's own buttons, drawn like its neighbours.
  it('holds Copy (and Run) to the left of Source, all one size, level with the bar', async () => {
    await app.setDocument(
      '```python\nprint(1)\nprint(2)\n```\n\n```\n#!/usr/bin/env python3\nprint(1)\n```',
    )
    const [plain, runnable] = topBlocks(app)
    expect(controlLabels(plain)).toEqual(['Copy', 'Source'])
    expect(controlLabels(runnable)).toEqual(['Copy', 'Run', 'Source'])

    for (const block of [plain, runnable]) {
      // The only floating copy is the run output's, and with no output it is
      // not drawn: nothing is left over the code.
      const floats = [...block.querySelectorAll<HTMLElement>('.code-copy-float')]
      expect(floats.filter((f) => f.getClientRects().length > 0)).toEqual([])
      const row = await revealControls(block)
      const buttons = [...row.querySelectorAll('button')]
      const heights = new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().height)))
      expect(heights.size).toBe(1)
      for (const button of buttons) {
        const style = getComputedStyle(button)
        expect(style.borderTopWidth).toBe('1px')
        expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)')
        // Once shown, each button is the thing under its own centre.
        const { x, y } = center(button)
        expect(document.elementFromPoint(x, y)?.closest('button')).toBe(button)
      }
      // The row is level with the block's first row of chrome, beside it.
      const blockBox = block.getBoundingClientRect()
      const rowBox = row.getBoundingClientRect()
      expect(rowBox.top - blockBox.top).toBeLessThanOrEqual(3)
      expect(rowBox.left).toBeGreaterThanOrEqual(blockBox.right - 1)
    }
  })

  // The copy is a real action: it hands the block's code to the shell.
  it('copies the code through the bridge when Copy is pressed', async () => {
    await app.setDocument('```python\nprint(1)\nprint(2)\n```')
    const [block] = topBlocks(app)
    await pressControl(block, 'Copy')
    await waitFor(() => app.bridge.calls.some((c) => /^copy/.test(c.method)), {
      message: 'a copy call',
    })
    const call = app.bridge.calls.find((c) => /^copy/.test(c.method))!
    expect(JSON.stringify(call.payload)).toContain('print(1)\\nprint(2)')
  })
})

describe('every block cluster', () => {
  // The row lives in the right margin, so it never covers a glyph, stands 8px
  // off the block (clearing a 2px outline at 2px offset), and fits the gutter
  // without growing a horizontal scrollbar.
  it('is beside its block, off its outline, never over its text, and the page does not scroll sideways', async () => {
    await loadMixed()
    const blocks = topBlocks(app)
    expect(blocks).toHaveLength(7)
    const scroller = document.querySelector<HTMLElement>('#editor-container')!
    expect(scroller.scrollWidth - scroller.clientWidth).toBe(0)

    const pmBox = app.editor.getBoundingClientRect()
    for (const block of blocks) {
      const s = strip(block)
      expect(s, block.className).not.toBeNull()
      const b = block.getBoundingClientRect()
      const c = s!.getBoundingClientRect()
      const p = pill(block).getBoundingClientRect()
      expect(c.left, block.className).toBeGreaterThanOrEqual(b.right - 1)
      expect(p.left - b.right, block.className).toBeGreaterThanOrEqual(4)
      expect(p.right, block.className).toBeLessThanOrEqual(c.right)
      // The strip is the whole right margin, the block's whole height. (`left:
      // 100%` is the padding box, so a bordered block's strip ends 1px short.)
      expect(Math.abs(c.right - pmBox.right), block.className).toBeLessThanOrEqual(1)
      // (On a bordered block it is the padding box's height.)
      expect(b.height - c.height, block.className).toBeGreaterThanOrEqual(0)
      expect(b.height - c.height, block.className).toBeLessThanOrEqual(2)
      // No cluster box intersects the block's own first glyph.
      const glyph = firstGlyph(block)
      if (glyph) {
        const overlaps = !(c.right <= glyph.left || c.left >= glyph.right ||
          c.bottom <= glyph.top || c.top >= glyph.bottom)
        expect(overlaps, block.className).toBe(false)
      }
      // The text column is centred in the page.
      expect(Math.round(b.left - pmBox.left)).toBe(Math.round(pmBox.right - b.right))
    }
    // A table hugs its grid, but its row is the page's like every other block's.
    const table = blocks.find((b) => b.classList.contains('ss-plain'))!
    expect(pill(table).getBoundingClientRect().left).toBe(pill(blocks[0]).getBoundingClientRect().left)
  })

  // At rest an invisible row must not be pressable: the thing under a button's
  // centre is the strip, so a press there is white space.
  it('is inert at rest and pressable once the block is hovered', async () => {
    await loadMixed()
    // Park the pointer far from every block first.
    await pointer.move({ x: 5, y: 890 })
    await settle()
    for (const block of topBlocks(app)) {
      for (const button of pill(block).querySelectorAll('button')) {
        const { x, y } = center(button)
        expect(hitKind(x, y, block), `${block.className} at rest`).toBe('strip')
      }
    }
    for (const block of topBlocks(app)) {
      await revealControls(block)
      for (const button of pill(block).querySelectorAll('button')) {
        const { x, y } = center(button)
        expect(hitKind(x, y, block), `${block.className} revealed`).toBe('button')
      }
    }
  })

  // The reported bug: on a tall block the row is at the top, so the pointer
  // crosses the block's right edge far below it. The strip is the whole
  // margin, so the reveal survives the journey and the button can be pressed.
  it("is reached from beside the middle of a tall block, the reveal never dropping on the way", async () => {
    const lines = Array.from({ length: 24 }, (_, i) => `print(${i})`).join('\n')
    await app.setDocument(`Prose above.\n\n\`\`\`python\n${lines}\n\`\`\`\n\nProse below.`)
    const block = topBlocks(app)[1]
    const b = block.getBoundingClientRect()
    const row = pill(block)
    const target = center(control(block, 'Source'))
    expect(b.height).toBeGreaterThan(row.getBoundingClientRect().height * 8)

    // Inside the block, low down; out across its right edge; then up the margin.
    const path = [
      { x: b.right - 24, y: b.top + b.height * 0.8 },
      { x: b.right + 20, y: b.top + b.height * 0.8 },
      { x: b.right + 20, y: b.top + b.height * 0.5 },
      { x: b.right + 20, y: b.top + b.height * 0.1 },
      target,
    ]
    for (const at of path) {
      await pointer.move(at, 6)
      expect(block.matches(':hover'), `hover at ${at.x},${at.y}`).toBe(true)
    }
    await waitFor(() => getComputedStyle(row).opacity === '1')
    await pointer.press(target)
    await waitForSelector(app, '.block-source-mode')
    expect(app.editor.querySelector('.block-source-mode')?.textContent).toContain('print(23)')
  })

  // An <hr> is 1px tall, so its row is the whitespace around it: the strip
  // covers the margins, and a pointer in them reaches the rule's Source.
  it("is reachable from anywhere in a rule's row", async () => {
    await app.setDocument('Above the rule.\n\n---\n\nBelow the rule.')
    const rule = app.editor.querySelector<HTMLElement>('.block-visual-rule')!
    const b = rule.getBoundingClientRect()
    const c = strip(rule)!.getBoundingClientRect()
    expect(c.top).toBeLessThanOrEqual(b.top - 12)
    expect(c.bottom).toBeGreaterThanOrEqual(b.bottom + 12)
    const x = c.left + c.width / 2
    for (const y of [b.top - 12, b.top, b.bottom + 12]) {
      expect(hitKind(x, y, rule), `y=${y}`).toBe('strip')
    }
    // Enter from the margin below the line, then press the revealed Source.
    await revealControls(rule, { x, y: b.bottom + 12 })
    await pointer.press(center(control(rule, 'Source')))
    await waitForSelector(app, '.block-source-mode')
    expect(app.editor.querySelector('.block-source-mode')?.textContent).toContain('---')
  })
})

describe('a block in its source form', () => {
  // A source editor has no banner of its own: its way out is the same cluster,
  // whose one button now reads Visual. The Qt version found it clipped by the
  // source frame's `overflow: hidden`, which only a hit test can see.
  it('keeps its way out in the cluster, and pressing it returns the block unchanged', async () => {
    await app.setDocument('First paragraph.\n\nSecond paragraph.')
    const before = app.doc()
    const first = topBlocks(app)[0]
    await pressControl(first, 'Source')
    await waitForSelector(app, '.block-source-mode')

    const source = app.editor.querySelector<HTMLElement>('.block-source-mode')!
    expect(source.querySelector('.block-source-toolbar, .block-source-label, .block-source-exit')).toBeNull()
    expect(controlLabels(source)).toEqual(['Visual'])
    const row = await revealControls(source)
    const button = control(source, 'Visual')
    expect(button.getBoundingClientRect().width).toBeGreaterThan(0)
    const { x, y } = center(button)
    expect(document.elementFromPoint(x, y)?.closest('button')).toBe(button)
    expect(row.contains(button)).toBe(true)

    await pointer.press({ x, y })
    await waitForSelector(app, '.block-source-mode', false)
    expect(app.editor.querySelectorAll('.block-visual-mode')).toHaveLength(2)
    // A mode is plugin state: the round trip leaves the document untouched.
    expect(app.doc().eq(before)).toBe(true)
    expect(dirtyCalls(app)).toBe(0)
  })

  // The row stands off the block because the dashed mode outline is drawn
  // 4px outside it; read the computed outline, not a stylesheet number.
  it("stands its row clear of the block's own dashed outline", async () => {
    await app.setDocument('A paragraph in source.\n\nAnother.')
    await pressControl(topBlocks(app)[0], 'Source')
    await waitForSelector(app, '.edi-block-mode-source')
    const block = app.editor.querySelector<HTMLElement>('.edi-block-mode-source')!
    const style = getComputedStyle(block)
    expect(style.outlineStyle).toBe('dashed')
    const reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
    expect(reach).toBeGreaterThan(0)
    const outlineRight = block.getBoundingClientRect().right + reach
    expect(pill(block).getBoundingClientRect().left).toBeGreaterThan(outlineRight)
  })
})
