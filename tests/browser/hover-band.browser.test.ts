// The hover band: the faint row behind the block under the pointer, which
// answers "which block would Alt+click alter?".
//
// Ported from the `test_the_hover_band_*` tests in `tests/window/test_window.py`.
// The Qt suite cannot hover (a synthesised event never sets `:hover`), so it
// re-injects the band's declarations under a probe class. Here the mouse
// really hovers, so these read the band the shipped `:hover` rule generates:
// `getComputedStyle(block, '::before')` with real layout, which jsdom lacks.

import { afterEach, describe, expect, it } from 'vitest'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  bandOf,
  hasBand,
  hoverAt,
  pressControl,
  strip,
  topBlocks,
  waitForDiagrams,
  waitForSelector,
} from './block-helpers'

let app: BootedApp

afterEach(() => app.dispose())

const MIXED =
  'A paragraph.\n\n' +
  '> A quote.\n\n' +
  '- a list item\n- another\n\n' +
  '```python\nprint(1)\n```\n\n' +
  '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n' +
  '```mermaid\ngraph TD\n  A[Alpha]\n```\n\n' +
  'Tail.'

async function loadMixed(): Promise<void> {
  await app.setDocument(MIXED)
  await waitForDiagrams(app)
}

/** A point inside `block` that is on the block itself, left of any content. */
function insideLeft(block: HTMLElement): { x: number; y: number } {
  const r = block.getBoundingClientRect()
  return { x: r.left + 4, y: r.top + Math.min(r.height / 2, 8) }
}

describe('with the band on (the default)', () => {
  // Exactly one band, on the block under the pointer; moving on moves it.
  it('marks the hovered top-level block and no other', async () => {
    app = bootApp()
    await loadMixed()
    const blocks = topBlocks(app)
    for (const block of blocks) {
      await hoverAt(insideLeft(block), block)
      const banded = blocks.filter(hasBand)
      expect(banded, block.className).toEqual([block])
    }
  })

  // The band is the row, and the row is the editor's content box: it runs
  // from the editor's left edge to its right edge for every block type,
  // including a table that hugs its grid, and costs no horizontal scrollbar.
  it('reaches both page edges for every block type, without scrolling the page sideways', async () => {
    app = bootApp()
    await loadMixed()
    const pm = app.editor.getBoundingClientRect()
    const scroller = document.querySelector<HTMLElement>('#editor-container')!
    for (const block of topBlocks(app)) {
      await hoverAt(insideLeft(block), block)
      const band = bandOf(block)
      expect(Math.abs(band.left - pm.left), `${block.className} left`).toBeLessThanOrEqual(1)
      expect(Math.abs(band.right - pm.right), `${block.className} right`).toBeLessThanOrEqual(1)
      expect(band.top, block.className).toBeLessThan(block.getBoundingClientRect().top)
      expect(scroller.scrollWidth - scroller.clientWidth, block.className).toBe(0)
    }
  })

  // One band per row: a list item's paragraph is nested, so it is never banded
  // (its inset pushed the band past the page edge); its list is.
  it("bands a list, not the list item's own paragraph", async () => {
    app = bootApp()
    await app.setDocument('- first item\n- second item\n\nAfter.')
    const list = topBlocks(app)[0]
    const nested = list.querySelector<HTMLElement>('li .block-visual-mode')!
    expect(nested).not.toBeNull()
    const text = nested.querySelector('p')!
    await hoverAt(center(text), nested)
    expect(hasBand(nested)).toBe(false)
    expect(hasBand(list)).toBe(true)
    const scroller = document.querySelector<HTMLElement>('#editor-container')!
    expect(scroller.scrollWidth - scroller.clientWidth).toBe(0)
  })

  // A rule's band covers the row its strip covers (the margins around a 1px
  // line), not a 9px sliver centred on the line.
  it("covers a rule's whole row, the same box as its strip", async () => {
    app = bootApp()
    await app.setDocument('Above the rule.\n\n---\n\nBelow the rule.')
    const rule = app.editor.querySelector<HTMLElement>('.block-visual-rule')!
    const r = rule.getBoundingClientRect()
    await hoverAt({ x: r.left + 40, y: r.top }, rule)
    const band = bandOf(rule)
    const s = strip(rule)!.getBoundingClientRect()
    expect(band.top).toBeLessThanOrEqual(r.top - 12)
    expect(band.bottom).toBeGreaterThanOrEqual(r.bottom + 12)
    expect(Math.abs(band.top - s.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(band.bottom - s.bottom)).toBeLessThanOrEqual(1)
  })

  // A block already in a mode wears the dashed accent outline instead: the
  // band would claim Alt+click moves it on, when the gesture finishes it.
  it('stands down on a block in its source form', async () => {
    app = bootApp()
    await app.setDocument('First.\n\nSecond.')
    await pressControl(topBlocks(app)[0], 'Source')
    await waitForSelector(app, '.block-source-mode')
    const source = app.editor.querySelector<HTMLElement>('.block-source-mode')!
    await hoverAt(center(source), source)
    expect(hasBand(source)).toBe(false)
    // ...while its neighbour still bands.
    const second = topBlocks(app)[1]
    await hoverAt(insideLeft(second), second)
    expect(hasBand(second)).toBe(true)
  })

  // The band is `z-index: -1`, which a native form control is painted below
  // unless it is lifted: hovering a task list must leave its checkbox both on
  // top and pressable.
  it("leaves a task's checkbox on top and pressable", async () => {
    app = bootApp()
    await app.setDocument('- [ ] write the tests\n\nAfter.')
    const list = topBlocks(app)[0]
    const box = list.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await hoverAt(center(box), list)
    expect(hasBand(list)).toBe(true)
    const { x, y } = center(box)
    expect(document.elementFromPoint(x, y)).toBe(box)
    await pointer.press({ x, y })
    await waitFor(() => app.markdown().includes('- [x] write the tests'), {
      message: 'task checked',
    })
  })

  // A code block has no child whose surface covers its frame, so a band
  // trapped in the block's own stacking context painted over its border and
  // padding. So, while hovered (the state that matters), the block must make
  // no stacking context of its own and the editor must be the one the band
  // escapes into.
  it("does not paint over a code block's own frame", async () => {
    app = bootApp()
    await app.setDocument('```python\nprint(1)\n```\n\nAfter.')
    const block = topBlocks(app)[0]
    await hoverAt(insideLeft(block), block)
    expect(hasBand(block)).toBe(true)
    expect(getComputedStyle(block, '::before').zIndex).toBe('-1')
    const style = getComputedStyle(block)
    expect({
      zIndex: style.zIndex,
      isolation: style.isolation,
      opacity: style.opacity,
      transform: style.transform,
      filter: style.filter,
      contain: style.contain,
    }).toEqual({
      zIndex: 'auto',
      isolation: 'auto',
      opacity: '1',
      transform: 'none',
      filter: 'none',
      contain: 'none',
    })
    expect(getComputedStyle(app.editor).isolation).toBe('isolate')
  })
})

describe('the View → Hover Band option', () => {
  // Off at boot from the shell's preference snapshot: no pseudo-element at all.
  it('draws no band when the hoverBand preference is off', async () => {
    app = bootApp({ preferences: { hoverBand: false } })
    await app.setDocument('A paragraph.\n\n```python\nprint(1)\n```')
    expect(document.documentElement.classList.contains('edi-hover-band-off')).toBe(true)
    for (const block of topBlocks(app)) {
      await hoverAt(insideLeft(block), block)
      expect(getComputedStyle(block, '::before').content, block.className).toBe('none')
    }
  })

  // The menu command turns it off and on again, and persists each answer in
  // the shell's settings store (never localStorage).
  it('toggles from the menu and saves each answer through the bridge', async () => {
    app = bootApp()
    await app.setDocument('A paragraph.')
    const block = topBlocks(app)[0]
    await hoverAt(insideLeft(block), block)
    const on = bandOf(block)
    expect(on.content).toBe('""')

    app.menu('toggleHoverBand')
    await settle()
    expect(getComputedStyle(block, '::before').content).toBe('none')
    app.menu('toggleHoverBand')
    await settle()
    expect(bandOf(block)).toEqual(on)

    await waitFor(() => app.bridge.callsTo('setPreference').length >= 2)
    expect(app.bridge.callsTo('setPreference').map((c) => c.payload)).toEqual([
      { name: 'hoverBand', value: false },
      { name: 'hoverBand', value: true },
    ])
  })
})
