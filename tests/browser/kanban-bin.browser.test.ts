// Deleting a card by dropping it on the bin, with a real mouse.
//
// Ported from `test_a_card_dropped_on_the_board_s_slot_column_is_deleted` and
// `test_kanban_card_delete_asks_first` in `tests/window/test_window.py`. The
// bin is the card slot in the drawn column at the end of the board: invisible
// at rest, dressed for the length of a card's drag. Whether it is painted,
// whether its words fit the box mermaid sized and whether the held card is
// over it are all questions for a real layout engine.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp, type Point } from './app'
import {
  KANBAN,
  KANBAN_CARD_SLOT,
  KANBAN_COLUMN_SLOT,
  KANBAN_EMPTY,
  answerDeletePrompt,
  boardSource,
  boardSvg,
  cardNamed,
  columnSlot,
  deletePrompt,
  dropLine,
  frameOf,
  lineShown,
  openBoard,
  waitForSource,
} from './kanban-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(async () => {
  await pointer.release()
  app.dispose()
})

/**
 * The card slot in the drawn column: the bin. Only marked as such at rest (the
 * class comes off while it is dressed), so read it before a drag and keep it.
 */
function binCard(): SVGGElement {
  const bin = boardSvg().querySelector<SVGGElement>('.items > g.mermaid-kanban-bin-slot')
  if (!bin) throw new Error('the bin is not at rest')
  return bin
}

/**
 * The bin at rest is in the DOM (mermaid sized the band around it) and paints
 * neither its frame nor its words. `checkVisibility` is the reading: a computed
 * `display` on a descendant of a `display: none` node is its own value.
 */
function paintsNothing(bin: Element): boolean {
  return !bin.querySelector('rect')!.checkVisibility() && !bin.querySelector(CARD_WORDS)!.checkVisibility()
}

interface Half {
  words: string
  painted: boolean
  mark: boolean
  markStroke: string | null
  markFill: string | null
  colour: string
  opacity: string
  fits: boolean
}

/** One half of the bin, read the way a user meets it. */
function half(el: Element, label: string): Half {
  const words = el.querySelector(label)!
  const frame = el.querySelector('rect')!
  const path = words.querySelector('.mermaid-kanban-bin-mark path')
  const host = words.closest('foreignObject')!.getBoundingClientRect()
  const box = words.getBoundingClientRect()
  return {
    words: (words.textContent ?? '').trim(),
    painted: frame.checkVisibility(),
    mark: words.querySelector('.mermaid-kanban-bin-mark') !== null,
    markStroke: path ? getComputedStyle(path).stroke : null,
    markFill: path ? getComputedStyle(path).fill : null,
    colour: getComputedStyle(words).color,
    opacity: getComputedStyle(frame).fillOpacity,
    fits:
      box.left >= host.left - 0.5 &&
      box.right <= host.right + 0.5 &&
      box.top >= host.top - 0.5 &&
      box.bottom <= host.bottom + 0.5,
  }
}

const BAND_WORDS = '.cluster-label .nodeLabel, .cluster-label p'
const CARD_WORDS = '.nodeLabel p, .nodeLabel'

/** Where a card is dropped to bin it: the bin card's place in the drawn band. */
function binAim(): Point {
  const band = frameOf(columnSlot()!)
  // At rest the bin card is `display: none`, so its box is a point; the band's
  // lower part is where it is drawn once a card is in the air.
  return { x: band.left + band.width / 2, y: band.bottom - 30 }
}

async function dragToBin(title: string): Promise<void> {
  await pointer.startDrag(center(cardNamed(title)), binAim())
  await settle()
}

it('is invisible at rest and says "Delete" on both halves mid-drag', async () => {
  await openBoard(app, KANBAN)
  const band = columnSlot()!
  // At rest the drawn column is a place to add a column, and its card slot
  // paints nothing.
  const bin = binCard()
  expect(paintsNothing(bin)).toBe(true)
  expect(half(band, BAND_WORDS).painted).toBe(true)
  expect(half(band, BAND_WORDS).words).toBe(KANBAN_COLUMN_SLOT)
  expect(half(band, BAND_WORDS).mark).toBe(false)

  await dragToBin('One')
  const card = cardNamed('One')
  expect(bin.classList.contains('mermaid-kanban-bin-slot')).toBe(false)
  const halves = { band: half(band, BAND_WORDS), card: half(bin, CARD_WORDS) }
  expect(halves.band.words).toBe('Delete card')
  expect(halves.card.words).toBe('Delete')
  for (const part of [halves.band, halves.card]) {
    expect(part.painted).toBe(true)
    expect(part.mark).toBe(true)
    // The mark's own path is the danger colour, not mermaid's palette.
    expect(part.markStroke).toBe(part.colour)
    expect(part.markFill).toBe('none')
    expect(part.opacity).toBe('0.28')
    expect(part.fits).toBe(true)
  }
  // No promise of a landing place over the bin.
  expect(lineShown(dropLine())).toBe(false)
  expect(band.classList.contains('kanban-drop-target')).toBe(false)
  // The held card is painted over the bin: frames first, the card last, and
  // its box over the pointer, the bin card and the band.
  const svg = boardSvg()
  const items = svg.querySelector('.items')!
  expect(svg.querySelector('.sections')!.compareDocumentPosition(items) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(items.lastElementChild).toBe(card)
  const aim = binAim()
  const within = (r: DOMRect) => r.left <= aim.x && aim.x <= r.right && r.top <= aim.y && aim.y <= r.bottom
  expect(within(card.getBoundingClientRect())).toBe(true)
  expect(within(bin.getBoundingClientRect())).toBe(true)
  expect(within(frameOf(band))).toBe(true)

  await pointer.release()
  await waitFor(() => deletePrompt() !== null)
  await answerDeletePrompt('Cancel')
  // The bin went with the drag.
  await waitFor(() => half(columnSlot()!, BAND_WORDS).words === KANBAN_COLUMN_SLOT)
  expect(half(columnSlot()!, BAND_WORDS).mark).toBe(false)
  expect(paintsNothing(binCard())).toBe(true)
  expect((binCard().textContent ?? '').trim()).toBe(KANBAN_CARD_SLOT)
})

it('asks first, keeps the card on Cancel and deletes it on Delete', async () => {
  await openBoard(app, KANBAN_EMPTY)
  await dragToBin('One')
  await pointer.release()
  await waitFor(() => deletePrompt() !== null, { message: 'no delete prompt' })
  const prompt = deletePrompt()!
  expect(prompt.querySelector('.edi-dialog-title')!.textContent).toBe('Delete “One”?')
  expect(prompt.querySelector('.edi-dialog-note')!.textContent).toContain('removed from the Todo column')
  expect([...prompt.querySelectorAll('.edi-dialog-actions button')].map((b) => b.textContent!.trim())).toEqual([
    'Cancel',
    'Delete',
  ])
  expect(prompt.querySelector('.toolbar-danger')).not.toBeNull()
  await answerDeletePrompt('Cancel')
  await settle()
  expect(boardSource(app)).toBe(KANBAN_EMPTY)

  await dragToBin('One')
  await pointer.release()
  await answerDeletePrompt('Delete')
  const source = await waitForSource(app, (s) => !s.includes('id1[One]'))
  expect(source).toBe('kanban\n  Todo\n  Doing\n  Done\n    id2[Two]')
  // One edit: one undo brings it back.
  app.menu('undo')
  await waitForSource(app, (s) => s === KANBAN_EMPTY, 'undo did not restore the card')
})

it('Escape on the prompt is a Cancel, and Enter is the Delete', async () => {
  // Delete holds the focus, so Enter answers it; Escape is the safe way out.
  // Real keys, delivered to whatever the browser has focused.
  await openBoard(app, KANBAN)
  await dragToBin('Two')
  await pointer.release()
  await waitFor(() => deletePrompt() !== null)
  expect(document.activeElement?.textContent?.trim()).toBe('Delete')
  await userEvent.keyboard('{Escape}')
  await waitFor(() => deletePrompt() === null, { message: 'Escape left the prompt up' })
  await settle()
  expect(boardSource(app)).toBe(KANBAN)
  // And the board is still a board to drag on: the cancelled drop released
  // the drag phase.
  await dragToBin('Two')
  await pointer.release()
  await waitFor(() => deletePrompt() !== null)
  await userEvent.keyboard('{Enter}')
  const after = await waitForSource(app, (s) => !s.includes('id2[Two]'))
  expect(after).toBe('kanban\n  Todo\n    id1[One]\n  Doing\n    id3[Three]')
})
