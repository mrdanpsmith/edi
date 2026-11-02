// A board's chrome, fields and drag on a magnified or resized document.
//
// Ported from `test_kanban_editors_sit_on_their_slots_when_the_document_is_magnified`,
// the zoom half of `test_kanban_drawn_slot_creates_a_card` and
// `test_the_chrome_follows_the_board_when_the_window_is_resized` in
// `tests/window/test_window.py`. `zoom:` makes `getBoundingClientRect()` answer
// in viewport pixels while an overlay's `left`/`top`/`width` are document
// pixels; only a real layout engine applies both, so this is where a placement
// that mixes the two spaces shows.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  KANBAN,
  KANBAN_EMPTY,
  bands,
  cardNamed,
  cardSlots,
  clickCardSlot,
  clickColumnSlot,
  columnSlot,
  drawnBoard,
  fieldBox,
  frameOf,
  inside,
  menuButton,
  menuList,
  nameOf,
  openBoard,
  openMenu,
  waitForField,
  waitForSource,
} from './kanban-helpers'

const ZOOM = 1.25

let app: BootedApp

afterEach(async () => {
  await pointer.release()
  app.dispose()
})

/** The edges two boxes share, to within `slack` viewport pixels. */
function agrees(a: DOMRect, b: DOMRect, edges: Array<'left' | 'right' | 'top' | 'bottom'>, slack = 1.5): boolean {
  return edges.every((edge) => Math.abs(a[edge] - b[edge]) <= slack)
}

/** Every real column's `⋯` in its band and clear of its name. */
function chromePlaced(): boolean {
  const slot = columnSlot()
  const real = bands().filter((b) => b !== slot)
  const menus = [...document.querySelectorAll('.mermaid .mermaid-kanban-menu')]
  if (menus.length !== real.length) return false
  return real.every((band, i) => {
    const box = menus[i]!.getBoundingClientRect()
    const name = nameOf(band)!.getBoundingClientRect()
    const clear = !(box.left < name.right && name.left < box.right && box.top < name.bottom && name.top < box.bottom)
    return inside(box, frameOf(band), 0.5) && clear
  })
}

describe('at 125%', () => {
  beforeEach(() => {
    app = bootApp({ preferences: { zoomFactor: ZOOM } })
  })

  it('puts a card composer exactly on its slot', async () => {
    await openBoard(app, KANBAN_EMPTY)
    expect(getComputedStyle(document.documentElement).getPropertyValue('--doc-zoom').trim()).toBe(String(ZOOM))
    const slot = await clickCardSlot(1)
    await waitForField()
    await waitFor(() => agrees(fieldBox(), slot.getBoundingClientRect(), ['left', 'right', 'top', 'bottom']), {
      message: 'the composer never settled on its slot',
    })
  })

  it('stands a column name in its band, one line tall in document pixels', async () => {
    await openBoard(app, KANBAN_EMPTY)
    const band = await clickColumnSlot()
    await waitForField()
    await waitFor(() => agrees(fieldBox(), frameOf(band), ['left', 'right', 'top']), {
      message: 'the column field never settled in its band',
    })
    expect(fieldBox().height).toBeCloseTo(30 * ZOOM, 0)
  })

  it('keeps every ⋯ and its menu in its own column', async () => {
    await openBoard(app, KANBAN_EMPTY)
    await waitFor(chromePlaced, { message: 'a ⋯ is out of its band' })
    const list = await openMenu(0)
    const box = list.getBoundingClientRect()
    const band = frameOf(bands()[0]!)
    expect(box.left).toBeGreaterThanOrEqual(band.left - 1)
    expect(box.right).toBeLessThanOrEqual(band.right + 1)
    expect(Math.abs(box.top - menuButton(0).getBoundingClientRect().bottom)).toBeLessThanOrEqual(1)
    // The width is the document-pixel constant, magnified.
    expect(box.width).toBeCloseTo(190 * ZOOM, 0)
  })

  it('moves a held card by the pointer’s own distance', async () => {
    // The drag offset is divided back into the drawing's units on every move;
    // a board that is not drawn 1:1 is where a missing division shows.
    await openBoard(app, KANBAN)
    const card = cardNamed('One')
    const doing = frameOf(bands()[1]!)
    const from = center(card)
    const to = { x: doing.left + doing.width / 2, y: doing.top + 30 }
    const half = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
    await pointer.startDrag(from, half)
    await settle()
    const atHalf = center(card)
    await pointer.dragTo(to)
    await settle()
    const atEnd = center(card)
    expect(atEnd.x - atHalf.x).toBeCloseTo(to.x - half.x, 0)
    expect(atEnd.y - atHalf.y).toBeCloseTo(to.y - half.y, 0)
    await pointer.release()
    await waitForSource(app, (s) => s.indexOf('id1[One]') > s.indexOf('Doing'))
    await waitFor(() => drawnBoard()[1]?.includes('One') ?? false)
  })
})

describe('magnifying while editing', () => {
  beforeEach(() => {
    app = bootApp()
  })

  it('keeps the slots in their columns, and a field on its slot', async () => {
    // The slots are mermaid's own cards, so there is nothing to keep in step
    // when the document is magnified; the field is an overlay and has to follow.
    await openBoard(app, KANBAN_EMPTY)
    const before = cardSlots()[0]!.getBoundingClientRect().width
    await clickCardSlot(1)
    await waitForField()
    await userEvent.keyboard('Half')
    app.menu('zoomTo', String(ZOOM))
    await waitFor(() => cardSlots()[0]!.getBoundingClientRect().width > before + 1, { message: 'never magnified' })
    cardSlots()
      .slice(0, 3)
      .forEach((slot, i) => {
        expect(inside(slot.getBoundingClientRect(), frameOf(bands()[i]!)), `slot ${i}`).toBe(true)
      })
    // The field followed its slot and kept what was typed.
    const slot = cardSlots()[1]!
    await waitFor(() => agrees(fieldBox(), slot.getBoundingClientRect(), ['left', 'top']), {
      message: 'the field was left behind by the zoom',
    })
    expect(document.querySelector<HTMLTextAreaElement>('.mermaid-edit-input')!.value).toBe('Half')
    await userEvent.keyboard('{Enter}')
    await waitForSource(app, (s) => s.includes('[Half]'))
  })
})

describe('resizing the window', () => {
  beforeEach(() => {
    app = bootApp()
  })

  afterEach(async () => {
    await page.viewport(1280, 900)
  })

  it('re-places the chrome on the centred board', async () => {
    // The preview narrows while the svg keeps its drawn size and the board is
    // centred in it, so the controls move without anything observed resizing.
    // A board narrower than the preview at every width tried, so it stays
    // centred (a wider one is pinned to the left and scrolls instead).
    await openBoard(app, KANBAN)
    await waitFor(chromePlaced)
    for (const width of [1100, 900]) {
      const left = frameOf(bands()[0]!).left
      await page.viewport(width, 900)
      await waitFor(() => Math.abs(frameOf(bands()[0]!).left - left) > 1, { message: `board never moved at ${width}` })
      await waitFor(chromePlaced, { message: `the chrome was left behind at ${width}` })
    }
    expect(menuList()).toBeNull()
  })
})
