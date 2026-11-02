// Adding cards and columns from the board's drawn slots, with real input.
//
// Ported from `test_kanban_drawn_slot_creates_a_card`,
// `test_an_empty_column_draws_its_own_place_to_add`,
// `test_a_composer_gets_the_room_it_needs_to_be_usable`,
// `test_kanban_card_editor_grows_with_its_text_and_only_with_it`,
// `test_kanban_drawn_slot_composes_a_wrapping_title`,
// `test_kanban_titles_holding_delimiters_stay_editable` (the slot half) and
// the add half of `test_kanban_menu_and_drawn_add_and_delete_columns` in
// `tests/window/test_window.py`. The slots are laid out by mermaid, the field
// is placed over them from real boxes, and the keys are real keystrokes, so
// Shift+Enter is a real Shift held over a real Enter rather than a flag on a
// synthesised event.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, settle, waitFor, type BootedApp } from './app'
import {
  KANBAN,
  KANBAN_BARE,
  KANBAN_CARD_SLOT,
  KANBAN_COLUMN_SLOT,
  KANBAN_EMPTY,
  bandText,
  bands,
  boardSource,
  cardSlots,
  clickCardSlot,
  clickColumnSlot,
  columnSlot,
  commitField,
  drawnBoard,
  field,
  fieldBox,
  frameOf,
  inside,
  isEditing,
  openBoard,
  typeInField,
  waitForField,
  waitForFieldClosed,
  waitForSource,
} from './kanban-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

/** The editing card's drawn height, in its own (svg) units. */
function editingCardHeight(): number {
  const card = document.querySelector('.mermaid .items > g.node.mermaid-node-editing rect')
  return card === null ? 0 : Number(card.getAttribute('height'))
}

describe('the drawn slots', () => {
  it('are drawn one per column, inside it, with a column at the end', async () => {
    // Only mermaid's layout says where a slot is, and the empty column is the
    // one that matters: its band is sized to the header plus the slot.
    await openBoard(app, KANBAN_EMPTY)
    const slots = cardSlots()
    // One per column, plus the bin in the drawn column.
    expect(slots.map((s) => (s.textContent ?? '').trim())).toEqual(Array(4).fill(KANBAN_CARD_SLOT))
    expect(bandText(columnSlot()!)).toContain(KANBAN_COLUMN_SLOT)
    const all = bands()
    expect(all.at(-1)).toBe(columnSlot())
    for (const [i, band] of all.slice(0, 3).entries()) {
      expect(inside(slots[i]!.getBoundingClientRect(), frameOf(band)), `slot ${i} is in its band`).toBe(true)
    }
    // The empty column is shorter than the one with a card, but holds a slot.
    expect(frameOf(all[1]!).height).toBeLessThan(frameOf(all[0]!).height)
    expect(frameOf(all[1]!).height).toBeGreaterThan(slots[1]!.getBoundingClientRect().height)
    // The document never sees them.
    expect(boardSource(app)).toBe(KANBAN_EMPTY)
  })

  it('opens an empty composer on the slot and adds the card to that column', async () => {
    await openBoard(app, KANBAN_EMPTY)
    const slot = await clickCardSlot(1)
    const input = await waitForField()
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Card title')
    expect(input.tagName).toBe('TEXTAREA')
    // The field stands where the slot was drawn: same top and left edge.
    const box = fieldBox()
    const anchor = slot.getBoundingClientRect()
    expect(Math.abs(box.left - anchor.left)).toBeLessThanOrEqual(1.5)
    expect(Math.abs(box.top - anchor.top)).toBeLessThanOrEqual(1.5)

    await typeInField('Fresh')
    await userEvent.keyboard('{Enter}')
    await waitForFieldClosed()
    const source = await waitForSource(app, (s) => s.includes('[Fresh]'))
    expect(source).toBe('kanban\n  Todo\n    id1[One]\n  Doing\n    [Fresh]\n  Done\n    id2[Two]')
    await waitFor(() => drawnBoard()[1]?.[0] === 'Fresh', { message: 'Fresh never drawn in Doing' })
    // Re-drawn with a slot in every column again.
    expect(cardSlots()).toHaveLength(4)
    expect(isEditing()).toBe(true)
  })

  it('discards what was typed on Escape', async () => {
    await openBoard(app, KANBAN)
    await clickCardSlot(0)
    await waitForField()
    await typeInField('Discarded')
    await userEvent.keyboard('{Escape}')
    await waitForFieldClosed()
    await settle()
    expect(boardSource(app)).toBe(KANBAN)
    // The slot is drawn again where the field stood.
    expect(cardSlots()[0]!.querySelector('rect')!.checkVisibility()).toBe(true)
  })

  it('commits on blur, the way a click elsewhere does', async () => {
    await openBoard(app, KANBAN, '\nAfter the board\n')
    await clickCardSlot(1)
    await waitForField()
    await typeInField('Blurred')
    // The document's own paragraph, not a `<p>` mermaid drew inside a label.
    const paragraph = [...app.editor.querySelectorAll('p')].find((p) => p.closest('.mermaid') === null)!
    await userEvent.click(paragraph)
    await waitForFieldClosed()
    await waitForSource(app, (s) => s.includes('[Blurred]'))
    expect(boardSource(app)).toBe('kanban\n  Todo\n    id1[One]\n    id2[Two]\n  Doing\n    id3[Three]\n    [Blurred]')
  })

  it('refuses Shift+Enter, keeps the field, and commits on Enter', async () => {
    // A card title cannot hold a line break, so Shift+Enter neither commits
    // nor writes one. Real modifier, real key.
    await openBoard(app, KANBAN_EMPTY)
    await clickCardSlot(1)
    await waitForField()
    const title = 'A title long enough to wrap onto a second line of the composer'
    await typeInField(title)
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    await settle()
    expect(field()).not.toBeNull()
    expect(field()!.value).toBe(title)
    expect(boardSource(app)).toBe(KANBAN_EMPTY)
    await userEvent.keyboard('{Enter}')
    await waitForFieldClosed()
    await waitForSource(app, (s) => s.includes(title))
  })

  it('refuses a pasted line break in place, with a notice', async () => {
    // The one thing quoting cannot carry. The field stays open with the value,
    // flagged, and the board stays editable.
    await openBoard(app, KANBAN)
    await clickCardSlot(0)
    const input = await waitForField()
    await userEvent.fill(input, 'one\ntwo')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => document.querySelector('.mermaid-edit-notice') !== null, { message: 'no notice' })
    expect(field()).not.toBeNull()
    expect(field()!.classList.contains('mermaid-edit-invalid')).toBe(true)
    expect(boardSource(app)).toBe(KANBAN)
    expect(isEditing()).toBe(true)
  })

  it('quotes a title holding delimiters, and carries a quote as an entity', async () => {
    // Whether `["Add (the log)"]` parses and draws without its quotes is real
    // mermaid's grammar.
    await openBoard(app, KANBAN)
    await clickCardSlot(0)
    await commitField('Add (the log)')
    await waitForSource(app, (s) => s.includes('["Add (the log)"]'))
    await waitFor(() => drawnBoard()[0]?.includes('Add (the log)') ?? false, { message: 'never drawn' })

    await clickCardSlot(1)
    await commitField('He said "hi"')
    await waitForSource(app, (s) => s.includes('["He said &quot;hi&quot;"]'))
    await waitFor(() => drawnBoard()[1]?.includes('He said "hi"') ?? false, { message: 'never drawn' })
    expect(document.querySelector('.mermaid-error, .mermaid-edit-notice')).toBeNull()
  })
})

describe('the composer', () => {
  it('grows with its title, and the card with it, and only with it', async () => {
    // The card is stretched to the composer's content plus its own padding;
    // the field used to read its floor off the card it was stretching, so the
    // two fed each other a line per keystroke.
    await openBoard(app, KANBAN)
    await clickCardSlot(0)
    await waitForField()
    const drawn = editingCardHeight()
    const title =
      'A title long enough that mermaid has to wrap it across several lines of the card it is drawn in'
    await typeInField(title)
    const agree = () => {
      const h = editingCardHeight()
      const f = field()!.getBoundingClientRect().height
      return field()!.style.height !== 'auto' && h > 0 && h <= f + 9
    }
    await waitFor(agree, { message: 'the card and the field never agreed' })
    await settle()
    const whole = { card: editingCardHeight(), field: field()!.getBoundingClientRect().height }
    expect(whole.card).toBeGreaterThan(drawn)
    expect(whole.card).toBeLessThanOrEqual(whole.field + 9)
    // An edit that changes nothing about the length leaves it where it is.
    await userEvent.keyboard('{Backspace}n')
    await settle()
    expect(editingCardHeight()).toBeCloseTo(whole.card, 0)
    await userEvent.keyboard('{Enter}')
    await waitForFieldClosed()
    await waitForSource(app, (s) => s.includes(title))
  })

  it('does not grow the card for a title that fits it', async () => {
    // Regression: the card grew by its padding on the first keystroke and hung
    // out of the bottom of its column, because the title's height was read as
    // a textarea's two-row default inside a field already the card's height.
    await openBoard(app, KANBAN_EMPTY)
    const slot = await clickCardSlot(1)
    await waitForField()
    const drawn = editingCardHeight()
    await typeInField('Half')
    await settle()
    expect(editingCardHeight()).toBe(drawn)
    expect(inside(slot.getBoundingClientRect(), frameOf(bands()[1]!))).toBe(true)
    expect(Math.abs(fieldBox().height - slot.getBoundingClientRect().height)).toBeLessThanOrEqual(1)
  })

  it('grows the block when it hangs below the board, and gives the room back', async () => {
    // A field is absolutely positioned, so a tall one would hang off the end of
    // the document. The block's padding grows to hold it.
    await openBoard(app, KANBAN_BARE)
    const band = frameOf(bands()[0]!)
    await clickCardSlot(0)
    await waitForField()
    const short = fieldBox()
    expect(short.bottom).toBeLessThanOrEqual(band.bottom + 0.5)
    const block = document.querySelector<HTMLElement>('.mermaid')!
    await typeInField(
      'a card title long enough that the composer grows well past the height of the column it was opened in',
    )
    await waitFor(
      () => fieldBox().height > short.height + 20 && fieldBox().bottom <= block.getBoundingClientRect().bottom + 0.5,
      { message: 'the block never made room' },
    )
    expect(fieldBox().bottom).toBeGreaterThan(band.bottom)
    expect(Number.parseFloat(getComputedStyle(block).paddingBottom)).toBeGreaterThan(0)
    await userEvent.keyboard('{Escape}')
    await waitForFieldClosed()
    await waitFor(() => Number.parseFloat(getComputedStyle(block).paddingBottom) === 0, {
      message: 'the padding was never given back',
    })
  })
})

describe('the drawn column', () => {
  it('is named in place and becomes a real column at the end', async () => {
    await openBoard(app, KANBAN_EMPTY)
    const band = await clickColumnSlot()
    const input = await waitForField()
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Column name')
    // Standing in the band, one line tall.
    const box = fieldBox()
    const frame = frameOf(band)
    expect(Math.abs(box.left - frame.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.right - frame.right)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.top - frame.top)).toBeLessThanOrEqual(1)
    expect(box.height).toBeCloseTo(30, 0)

    await commitField('In review')
    const source = await waitForSource(app, (s) => s.includes('In review'))
    expect(source.split('\n').at(-1)).toBe('  col1[In review]')
    await waitFor(() => bands().length === 5, { message: 'the board never redrew with five bands' })
    // Appended as a real column, with a fresh drawn column after it.
    expect(bands().map(bandText)).toEqual(['Todo', 'Doing', 'Done', 'In review', KANBAN_COLUMN_SLOT])
    expect(bands().at(-1)).toBe(columnSlot())
  })

  it('refuses an empty name and stays open', async () => {
    await openBoard(app, KANBAN)
    await clickColumnSlot()
    await waitForField()
    await userEvent.keyboard('{Enter}')
    await settle()
    expect(field()).not.toBeNull()
    expect(boardSource(app)).toBe(KANBAN)
    await userEvent.keyboard('{Escape}')
    await waitForFieldClosed()
  })
})
