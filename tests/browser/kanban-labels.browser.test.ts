// Renaming a board's cards and columns by clicking their labels, with real input.
//
// Ported from the rename halves of `test_kanban_label_edit_and_card_drag` and
// `test_kanban_titles_holding_delimiters_stay_editable` in
// `tests/window/test_window.py`, plus the field-to-field gestures the window
// suite cannot make: its synthesised clicks never move the focus, so the blur a
// real press causes (or, on the drawing, does not cause) never happens there.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, settle, waitFor, type BootedApp } from './app'
import {
  KANBAN,
  KANBAN_QUOTED,
  boardSource,
  clickCardSlot,
  clickLabel,
  commitField,
  drawnBoard,
  field,
  openBoard,
  typeInField,
  waitForField,
  waitForSource,
} from './kanban-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

describe('renaming', () => {
  it('renames a card from its title, seeded with the title', async () => {
    await openBoard(app, KANBAN)
    await clickLabel('One')
    const input = await waitForField()
    expect(input.value).toBe('One')
    await commitField('Renamed')
    await waitForSource(app, (s) => s.includes('id1[Renamed]'))
    await waitFor(() => drawnBoard()[0]?.[0] === 'Renamed', { message: 'never drawn' })
  })

  it('renames a column from its header', async () => {
    await openBoard(app, KANBAN)
    await clickLabel('Doing')
    expect((await waitForField()).value).toBe('Doing')
    await commitField('In progress')
    expect(await waitForSource(app, (s) => s.includes('In progress'))).toBe(
      'kanban\n  Todo\n    id1[One]\n    id2[Two]\n  In progress\n    id3[Three]',
    )
  })

  it('keeps quotes a title already has, and adds them when a rename needs them', async () => {
    // Whether a quoted title is drawn without its quotes and still offered for
    // editing is real mermaid's grammar and the real label walk.
    await openBoard(app, KANBAN_QUOTED)
    const drawn = [...document.querySelectorAll('.mermaid-editables')].map((e) => (e.textContent ?? '').trim())
    expect(drawn).toEqual(expect.arrayContaining(['Fix (the bug)', 'Doing (now)', 'Plain']))
    expect(drawn.some((t) => t.includes('"'))).toBe(false)

    await clickLabel('Fix (the bug)')
    expect((await waitForField()).value).toBe('Fix (the bug)')
    await commitField('Ship (v2)')
    await waitForSource(app, (s) => s.includes('["Ship (v2)"]'))

    await waitFor(() => document.querySelector('.mermaid-editables') !== null)
    await settle()
    await clickLabel('Plain')
    await commitField('Ship (v1)')
    const source = await waitForSource(app, (s) => s.includes('Ship (v1)'))
    expect(source).toContain('id2["Ship (v1)"]')
    expect(document.querySelector('.mermaid-error, .mermaid-edit-notice')).toBeNull()
  })

  it('refuses an empty title in place', async () => {
    await openBoard(app, KANBAN)
    await clickLabel('Three')
    const input = await waitForField()
    await userEvent.clear(input)
    await userEvent.keyboard('{Enter}')
    await settle()
    expect(field()).not.toBeNull()
    expect(boardSource(app)).toBe(KANBAN)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => field() === null)
    expect(boardSource(app)).toBe(KANBAN)
  })
})

describe('moving from one field to another', () => {
  // Regression: a press on the drawing has its `mousedown` cancelled (so it does
  // not start a ProseMirror node selection), which keeps the focus in the open
  // field, so no blur commits it. The new field then claimed the session's text
  // phase and took the old one away unaccepted: what was typed was dropped.
  // Then, once the old one did commit, the render it caused detached the new
  // field, Chromium fired `blur` on it as it was removed, and that closed it.

  it('commits a typed card title when another label is clicked', async () => {
    await openBoard(app, KANBAN)
    await clickCardSlot(1)
    await waitForField()
    await typeInField('Typed')
    await clickLabel('Todo')
    await waitForSource(app, (s) => s.includes('[Typed]'), 'the typed title was dropped')
    expect(boardSource(app)).toBe('kanban\n  Todo\n    id1[One]\n    id2[Two]\n  Doing\n    id3[Three]\n    [Typed]')
    // The field that was asked for is the one open, and survived the render.
    await waitFor(() => drawnBoard()[1]?.includes('Typed') ?? false, { message: 'never drawn' })
    await settle()
    expect(field()?.value).toBe('Todo')
    expect(document.activeElement).toBe(field())
  })

  it('commits a half-done rename when another card is clicked, and carries on', async () => {
    await openBoard(app, KANBAN)
    await clickLabel('One')
    await waitForField()
    await typeInField(' more')
    await clickLabel('Three')
    await waitForSource(app, (s) => s.includes('id1[One more]'), 'the rename was dropped')
    await waitFor(() => drawnBoard()[0]?.[0] === 'One more', { message: 'never drawn' })
    await settle()
    // The second field is open on Three, focused, and takes keystrokes.
    expect(field()?.value).toBe('Three')
    expect(document.activeElement).toBe(field())
    await typeInField('!')
    await userEvent.keyboard('{Enter}')
    await waitForSource(app, (s) => s.includes('id3[Three!]'))
    expect(boardSource(app)).toBe('kanban\n  Todo\n    id1[One more]\n    id2[Two]\n  Doing\n    id3[Three!]')
  })
})
