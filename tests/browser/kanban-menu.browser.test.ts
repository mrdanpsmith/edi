// A column's `⋯` menu, with real hover and real clicks.
//
// Ported from `test_kanban_chrome_is_one_mark_per_column`,
// `test_kanban_menu_and_drawn_add_and_delete_columns` and
// `test_kanban_menu_offers_no_delete_on_a_board_of_one` in
// `tests/window/test_window.py`. The window suite has to dispatch
// `pointerover` by hand; here the mouse really moves, so "the walk from an item
// back up to its `⋯` does not close the menu" is the browser's own hover.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  KANBAN,
  KANBAN_EMPTY,
  KANBAN_ONE,
  answerDeletePrompt,
  bandText,
  bands,
  boardSource,
  cardNamed,
  clickLabel,
  columnSlot,
  commitField,
  deletePrompt,
  field,
  frameOf,
  inside,
  menuButton,
  menuItems,
  menuList,
  nameOf,
  openBoard,
  openMenu,
  waitForField,
  waitForSource,
} from './kanban-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

describe('the board chrome', () => {
  it('is one ⋯ per real column, in its band, on the line of its name', async () => {
    // The mark is placed from the name's real box; nothing but layout can say
    // whether it is in the band, clear of the name and level with it.
    await openBoard(app, KANBAN_EMPTY)
    const buttons = [...document.querySelectorAll<HTMLElement>('.mermaid .mermaid-kanban-btn')]
    expect(buttons.map((b) => b.textContent)).toEqual(['⋯', '⋯', '⋯'])
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Todo column actions',
      'Doing column actions',
      'Done column actions',
    ])
    // The drawn column gets none, and no card carries a control.
    expect(columnSlot()!.querySelector('.mermaid-kanban-btn')).toBeNull()
    expect(document.querySelector('.mermaid-kanban-card-remove')).toBeNull()
    buttons.forEach((button, i) => {
      const box = button.getBoundingClientRect()
      const band = bands()[i]!
      expect(inside(box, frameOf(band), 0.5), `⋯ ${i} in its band`).toBe(true)
      const name = nameOf(band)!.getBoundingClientRect()
      const overlaps =
        box.left < name.right && name.left < box.right && box.top < name.bottom && name.top < box.bottom
      expect(overlaps, `⋯ ${i} clear of the name`).toBe(false)
      expect(Math.abs((box.top + box.bottom) / 2 - (name.top + name.bottom) / 2)).toBeLessThanOrEqual(1)
    })
  })
})

describe('the menu', () => {
  it('offers Rename and Delete, hangs off its ⋯ with no gap, and focuses the first item', async () => {
    await openBoard(app, KANBAN_EMPTY)
    const list = await openMenu(0)
    expect(list.getAttribute('aria-label')).toBe('Todo column actions')
    const items = menuItems()
    expect(items.map((i) => i.textContent)).toEqual(['Rename column', 'Delete column'])
    expect(items.map((i) => i.classList.contains('is-danger'))).toEqual([false, true])
    expect(document.activeElement).toBe(items[0])
    // Inside the column, right-aligned to its ⋯ and touching it.
    const box = list.getBoundingClientRect()
    const band = frameOf(bands()[0]!)
    const button = menuButton(0).getBoundingClientRect()
    expect(box.left).toBeGreaterThanOrEqual(band.left - 1)
    expect(box.right).toBeLessThanOrEqual(band.right + 1)
    expect(Math.round(box.top - button.bottom)).toBe(0)
    expect(Math.abs(box.right - button.right)).toBeLessThanOrEqual(1)
    // Every pixel down from the button into the first row is the button, then
    // the menu: no strip of board between them.
    const x = Math.round(box.right - 8)
    const seen: string[] = []
    for (let y = Math.ceil(button.top) + 1; y <= Math.floor(box.top) + 2; y += 1) {
      const hit = document.elementFromPoint(x, y)
      const who = hit?.closest('.mermaid-kanban-menu-list')
        ? 'the menu'
        : hit?.closest('.mermaid-kanban-menu')
          ? 'its button'
          : (hit?.getAttribute('class') ?? String(hit?.tagName))
      if (seen.at(-1) !== who) seen.push(who)
    }
    expect(seen).toEqual(['its button', 'the menu'])
    // Items wrap inside the popover rather than widening it.
    for (const item of items) {
      expect(getComputedStyle(item).whiteSpace).toBe('normal')
      expect(item.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 0.5)
    }
  })

  it('survives the walk back to its own ⋯, and closes on another ⋯ or a card', async () => {
    await openBoard(app, KANBAN_EMPTY)
    await openMenu(0)
    // Item, then back up to the ⋯ that owns it: still open.
    await pointer.move(center(menuItems()[1]!), 4)
    await pointer.move(center(menuButton(0)), 4)
    await settle()
    expect(menuList()).not.toBeNull()
    // Another column's ⋯ is a move away.
    await pointer.move(center(menuButton(1)), 4)
    await waitFor(() => menuList() === null, { message: 'the menu stayed open over another ⋯' })

    // A card in another column: Todo's own cards are under its open list.
    await openMenu(0)
    await pointer.move(center(cardNamed('Two')), 4)
    await waitFor(() => menuList() === null, { message: 'the menu stayed open over a card' })
  })

  it('toggles on its own ⋯, moves on another, and closes on Escape', async () => {
    await openBoard(app, KANBAN)
    await openMenu(0)
    await pointer.press(center(menuButton(0)))
    await waitFor(() => menuList() === null, { message: 'a second press did not close it' })

    await openMenu(0)
    // Pressing another ⋯ opens that one's menu in a single press.
    await pointer.press(center(menuButton(1)))
    await waitFor(() => menuList()?.getAttribute('aria-label') === 'Doing column actions', {
      message: 'the second ⋯ did not take the menu over',
    })
    expect(document.querySelectorAll('.mermaid-kanban-menu-list')).toHaveLength(1)

    // The keyboard: the focus is on the first item, the arrows move it between
    // items (regression: the arrow handler was only on the `⋯`, which never
    // has the focus while its menu is open), and Escape takes it away.
    expect(document.activeElement).toBe(menuItems()[0])
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(menuItems()[1])
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(menuItems()[0])
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(menuItems()[1])
    await userEvent.keyboard('{Escape}')
    await waitFor(() => menuList() === null, { message: 'Escape left the menu open' })
    expect(boardSource(app)).toBe(KANBAN)
  })

  it('renames the column through the same field its header opens', async () => {
    await openBoard(app, KANBAN)
    await openMenu(1)
    await pointer.press(center(menuItems()[0]!))
    const input = await waitForField()
    expect(menuList()).toBeNull()
    expect(input.value).toBe('Doing')
    await commitField('Review')
    expect(await waitForSource(app, (s) => s.includes('Review'))).toBe(
      'kanban\n  Todo\n    id1[One]\n    id2[Two]\n  Review\n    id3[Three]',
    )
  })

  it('deletes a column and its cards after asking, saying how many go', async () => {
    await openBoard(app, KANBAN)
    await openMenu(0)
    await pointer.press(center(menuItems()[1]!))
    await waitFor(() => deletePrompt() !== null, { message: 'no prompt' })
    const prompt = deletePrompt()!
    expect(prompt.querySelector('.edi-dialog-title')!.textContent).toBe('Delete the Todo column?')
    expect(prompt.querySelector('.edi-dialog-note')!.textContent).toContain('Its 2 cards go with it.')
    await answerDeletePrompt('Cancel')
    await settle()
    expect(boardSource(app)).toBe(KANBAN)

    await openMenu(0)
    await pointer.press(center(menuItems()[1]!))
    await answerDeletePrompt('Delete')
    expect(await waitForSource(app, (s) => !s.includes('Todo'))).toBe('kanban\n  Doing\n    id3[Three]')
    await waitFor(() => bands().length === 2, { message: 'the board never redrew' })
    expect(bands().map(bandText)).toEqual(['Doing', '+ Add a column'])
    // A board of one is offered no delete.
    await openMenu(0)
    expect(menuItems().map((i) => i.textContent)).toEqual(['Rename column'])
  })

  it('says an empty column takes no cards with it', async () => {
    await openBoard(app, KANBAN_EMPTY)
    await openMenu(1)
    await pointer.press(center(menuItems()[1]!))
    await waitFor(() => deletePrompt() !== null)
    expect(deletePrompt()!.querySelector('.edi-dialog-note')!.textContent).toContain(
      'The column is removed from the board.',
    )
    await answerDeletePrompt('Delete')
    expect(await waitForSource(app, (s) => !s.includes('Doing'))).toBe('kanban\n  Todo\n    id1[One]\n  Done\n    id2[Two]')
  })

  it('offers no delete on a board of one', async () => {
    await openBoard(app, KANBAN_ONE)
    await openMenu(0)
    expect(menuItems().map((i) => i.textContent)).toEqual(['Rename column'])
    expect(menuItems().some((i) => i.classList.contains('is-danger'))).toBe(false)
    expect(bands().at(-1)).toBe(columnSlot())
  })

  it('opening it does not throw away a rename in progress', async () => {
    // A menu does not preempt a field, and the focus moving to its first item
    // is a real blur here, which accepts the rename rather than dropping it.
    // (The commit's render rebuilds the chrome, so that first press's menu does
    // not stay open; the next press opens it.)
    await openBoard(app, KANBAN)
    await clickLabel('Three')
    await waitForField()
    await userEvent.keyboard('!')
    await pointer.press(center(menuButton(0)))
    await waitForSource(app, (s) => s.includes('id3[Three!]'), 'the rename was dropped')
    await waitFor(() => field() === null && menuList() === null)
    await settle()
    await openMenu(0)
    expect(menuItems().map((i) => i.textContent)).toEqual(['Rename column', 'Delete column'])
  })
})
