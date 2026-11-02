// Kanban drag and drop with a real, trusted mouse.
//
// Ported from the card and column drag tests in `tests/window/test_window.py`
// (`test_kanban_label_edit_and_card_drag`, `..._drag_shows_the_slot_before_the_release`,
// `..._drop_line_stays_above_the_drawn_slot`, `..._column_drag_reorders_the_board`,
// `..._column_line_stays_left_of_the_drawn_column_slot`,
// `..._column_drag_paints_over_the_cards_it_passes`). Those have to synthesise
// PointerEvents because `QTest` input never reaches the page; here Playwright
// moves the mouse, so the drag also proves the browser's own native SVG drag
// does not swallow the pointer stream. The drag is held part-way with
// `pointer.startDrag` so the preview can be read before the release.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  KANBAN,
  KANBAN_TRAILING_EMPTY,
  bands,
  boardSource,
  boardSvg,
  cardNamed,
  cardSlots,
  cards,
  columnGrabPoint,
  columnSlot,
  drawnBoard,
  dropLine,
  field,
  frameOf,
  hitWith,
  isEditing,
  lineShown,
  openBoard,
  waitForSource,
} from './kanban-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(async () => {
  // A test that failed mid-drag must not leave the mouse button down.
  await pointer.release()
  app.dispose()
})

describe('dragging a card', () => {
  it('carries the real card across columns and drops it there', async () => {
    // Real input only: a native SVG drag would swallow the pointer stream, and
    // whether the card follows the pointer is the browser's layout.
    await openBoard(app, KANBAN)
    const card = cardNamed('One')
    const doing = bands()[1]!
    const frame = frameOf(doing)
    const from = center(card)
    const half = { x: (from.x + frame.left + frame.width / 2) / 2, y: (from.y + frame.top + 30) / 2 }
    await pointer.startDrag(from, half)
    await settle()
    const atHalf = center(card)

    const to = { x: frame.left + frame.width / 2, y: frame.top + 30 }
    await pointer.dragTo(to)
    await settle()
    const atEnd = center(card)

    // No clone: the card under the pointer is the real node, lifted and painted
    // last so it is on top of the board.
    expect(document.querySelector('.mermaid-drag-card')).toBeNull()
    expect(card.classList.contains('kanban-dragging-card')).toBe(true)
    expect(card.parentElement!.lastElementChild).toBe(card)
    // It moved by exactly the pointer's own distance.
    expect(atEnd.x - atHalf.x).toBeCloseTo(to.x - half.x, 0)
    expect(atEnd.y - atHalf.y).toBeCloseTo(to.y - half.y, 0)
    // It is what is painted at the pointer (a held card takes no pointer
    // events, so it is made hit-testable for the sample).
    expect(card.contains(hitWith([card], to))).toBe(true)
    expect(doing.classList.contains('kanban-drop-target')).toBe(true)
    // Neither the svg nor the scrolling preview clips a card in flight.
    const preview = card.closest('.mermaid-preview')!
    expect(getComputedStyle(boardSvg()).overflow).toBe('visible')
    expect(getComputedStyle(preview).overflow).toBe('visible')

    await pointer.release()
    await waitForSource(app, (s) => s.indexOf('id1[One]') > s.indexOf('Doing'))
    expect(boardSource(app)).toBe('kanban\n  Todo\n    id2[Two]\n  Doing\n    id1[One]\n    id3[Three]')
    await waitFor(() => drawnBoard().length === 2 && drawnBoard()[1]!.includes('One'))
    expect(drawnBoard()).toEqual([['Two'], ['One', 'Three']])
    // Still editing, and the drag left nothing behind.
    expect(isEditing()).toBe(true)
    expect(dropLine()).toBeNull()
    expect(document.querySelector('.kanban-dragging')).toBeNull()
  })

  it('draws the drop line in the gap above the drawn slot, and lands there', async () => {
    // The foot of a column looks like the drawn `+ Add a card` slot, and a slot
    // is not a gap below the last card: the line has to stay above it. Mermaid's
    // own layout decides where the slot and the gaps are.
    await openBoard(app, KANBAN)
    const todo = bands()[0]!
    const frame = frameOf(todo)
    const slot = cardSlots()[0]!
    const slotBox = slot.getBoundingClientRect()
    // Card One, down its own column, aimed at the slot's lower half.
    await pointer.startDrag(center(cardNamed('One')), {
      x: frame.left + frame.width / 2,
      y: slotBox.top + slotBox.height * 0.75,
    })
    await settle()

    const line = dropLine()
    expect(lineShown(line)).toBe(true)
    const drawn = line!.getBoundingClientRect()
    // Spanning the column (overhanging it a little), above the slot.
    expect(drawn.left).toBeGreaterThanOrEqual(frame.left - 6)
    expect(drawn.width).toBeGreaterThan(0)
    expect(drawn.width).toBeLessThanOrEqual(frame.width + 12)
    expect(drawn.top + drawn.height / 2).toBeLessThan(slotBox.top)
    expect(drawn.top + drawn.height / 2).toBeGreaterThan((frame.top + frame.bottom) / 2)
    // An svg child just ahead of the cards: over the column, under every card.
    expect(line!.parentElement).toBe(boardSvg())
    expect(line!.nextElementSibling).toBe(boardSvg().querySelector('.items'))

    await pointer.release()
    await waitForSource(app, (s) => s.indexOf('id1[One]') > s.indexOf('id2[Two]'))
    await waitFor(() => drawnBoard()[0]?.[0] === 'Two')
    expect(drawnBoard()).toEqual([['Two', 'One'], ['Three']])
  })

  it('is undone in one step', async () => {
    // A move is one `setNodeMarkup`, so one undo takes the whole move back.
    await openBoard(app, KANBAN)
    const doing = frameOf(bands()[1]!)
    await pointer.drag(center(cardNamed('Two')), { x: doing.left + doing.width / 2, y: doing.top + 30 })
    await waitForSource(app, (s) => s !== KANBAN)
    app.menu('undo')
    await waitForSource(app, (s) => s === KANBAN, 'one undo did not restore the board')
    await waitFor(() => drawnBoard()[0]?.length === 2)
    expect(drawnBoard()).toEqual([['One', 'Two'], ['Three']])
  })

  it('a press and release without travel is a rename, not a drag', async () => {
    // The drag arms on press and starts past a threshold, so a click on a
    // card's title still reaches the editor and the board is not touched.
    await openBoard(app, KANBAN)
    await pointer.press(center(cardNamed('Three').querySelector('.nodeLabel') ?? cardNamed('Three')))
    await waitFor(() => field() !== null, { message: 'no rename field opened' })
    expect(field()!.value).toBe('Three')
    expect(boardSource(app)).toBe(KANBAN)
    expect(document.querySelector('.kanban-dragging')).toBeNull()
  })

  it('a slot is not a card to pick up', async () => {
    // A press on a drawn slot asks for a title; dragging from it must neither
    // lift it nor move the column it stands in.
    await openBoard(app, KANBAN)
    const slot = cardSlots()[0]!
    const doing = frameOf(bands()[1]!)
    await pointer.startDrag(center(slot), { x: doing.left + doing.width / 2, y: doing.top + 30 })
    await settle()
    expect(slot.classList.contains('kanban-dragging-card')).toBe(false)
    expect(document.querySelector('.kanban-dragging-column')).toBeNull()
    expect(dropLine()).toBeNull()
    await pointer.release()
    await settle()
    expect(boardSource(app)).toBe(KANBAN)
  })
})

describe('dragging a column', () => {
  it('carries the frame and its cards, rigid, and reorders the board', async () => {
    // A column is two sibling lists in mermaid's drawing (frame in `.sections`,
    // cards in `.items`), so the lift has to carry both, unscaled, in a group of
    // its own on top of the board.
    await openBoard(app, KANBAN)
    const todo = bands()[0]!
    const before = frameOf(todo)
    const doing = frameOf(bands()[1]!)
    // Its cards and its drawn slot: everything standing in the band travels.
    const mine = [cardNamed('One'), cardNamed('Two'), cardSlots()[0]!]
    const slot = frameOf(columnSlot()!)
    const from = columnGrabPoint(todo)
    // Past the last real column, over the drawn one at 75% of its width.
    const to = { x: slot.left + slot.width * 0.75, y: before.top + 12 }
    const half = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
    await pointer.startDrag(from, half)
    await settle()
    const frameHalf = frameOf(todo)
    const cardsHalf = mine.map((c) => c.getBoundingClientRect())
    await pointer.dragTo(to)
    await settle()

    expect(todo.classList.contains('kanban-dragging-column')).toBe(true)
    expect(mine.every((c) => c.classList.contains('kanban-dragging-column'))).toBe(true)
    // Held in one group, last in the svg: the frame, then the cards it carries.
    const svg = boardSvg()
    const layer = svg.querySelector('.kanban-drag-layer')!
    expect(svg.lastElementChild).toBe(layer)
    expect([...layer.children]).toEqual([todo, ...mine])
    // Everything moved by the pointer's own distance, and nothing was scaled.
    const frameEnd = frameOf(todo)
    expect(frameEnd.left - frameHalf.left).toBeCloseTo(to.x - half.x, 0)
    expect(frameEnd.width).toBeCloseTo(before.width, 1)
    expect(frameEnd.height).toBeCloseTo(before.height, 1)
    mine.forEach((card, i) => {
      expect(card.getBoundingClientRect().left - cardsHalf[i]!.left).toBeCloseTo(to.x - half.x, 0)
    })
    // The rule is vertical and full height, in the last real gap: left of the
    // drawn column, never past it.
    const line = dropLine()
    expect(lineShown(line)).toBe(true)
    const rule = line!.getBoundingClientRect()
    expect(rule.width).toBeLessThanOrEqual(8)
    expect(rule.height).toBeGreaterThan(before.height * 0.5)
    expect(rule.left).toBeLessThan(slot.left)
    expect(rule.left).toBeGreaterThan(doing.right - 1)
    // Ahead of the frames, behind everything else.
    expect(line!.nextElementSibling).toBe(svg.querySelector('.sections'))

    await pointer.release()
    await waitForSource(app, (s) => s.indexOf('Doing') < s.indexOf('Todo'))
    expect(boardSource(app)).toBe('kanban\n  Doing\n    id3[Three]\n  Todo\n    id1[One]\n    id2[Two]')
    await waitFor(() => drawnBoard()[0]?.[0] === 'Three')
    expect(drawnBoard()).toEqual([['Three'], ['One', 'Two']])
    expect(document.querySelector('.kanban-drag-layer')).toBeNull()
  })

  it('paints the held column over the cards it passes', async () => {
    // Without the drag layer a neighbour's card lies across the held column and
    // reads as picked up. Paint order is only answerable by a real hit test.
    await openBoard(app, KANBAN_TRAILING_EMPTY)
    const done = bands()[3]!
    const passed = cardNamed('STDIN support for code blocks')
    const target = passed.getBoundingClientRect()
    const from = columnGrabPoint(done)
    const grabOffsetX = from.x - frameOf(done).left
    // Hold `Done` so its frame overlaps the `Specified` card.
    await pointer.startDrag(from, { x: target.left + grabOffsetX, y: from.y })
    await settle()
    const held = frameOf(done)
    const overlap = {
      x: (Math.max(held.left, target.left) + Math.min(held.right, target.right)) / 2,
      y: (Math.max(held.top, target.top) + Math.min(held.bottom, target.bottom)) / 2,
    }
    const layer = boardSvg().querySelector('.kanban-drag-layer')!
    const hit = hitWith([...layer.children], overlap)
    expect(hit !== null && layer.contains(hit), 'the held column is on top').toBe(true)

    // Released between Todo and Specified.
    const todo = frameOf(bands()[0]!)
    const specified = frameOf(bands()[1]!)
    await pointer.dragTo({ x: (todo.right + specified.left) / 2, y: from.y })
    await pointer.release()
    await waitForSource(app, (s) => s.indexOf('col4[Done]') < s.indexOf('col2[Specified]'))
    expect(boardSource(app)).toBe(
      'kanban\n  col1[Todo]\n  col4[Done]\n  col2[Specified]\n    [STDIN support for code blocks]\n' +
        '  col3[Doing]\n    [Kanban editor]',
    )
  })

  it('cannot pick up the drawn column', async () => {
    // The drawn column at the end is a place to name, not a column.
    await openBoard(app, KANBAN)
    const slot = columnSlot()!
    const frame = frameOf(slot)
    const todo = frameOf(bands()[0]!)
    await pointer.startDrag({ x: frame.left + 4, y: frame.bottom - 6 }, { x: todo.left + 20, y: frame.bottom - 6 })
    await settle()
    expect(document.querySelector('.kanban-drag-layer')).toBeNull()
    expect(slot.classList.contains('kanban-dragging-column')).toBe(false)
    await pointer.release()
    await settle()
    expect(boardSource(app)).toBe(KANBAN)
    expect(cards().length).toBeGreaterThan(0)
  })
})
