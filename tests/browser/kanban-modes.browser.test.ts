// Entering and leaving a board's edit mode with real gestures.
//
// Ported from `test_alt_click_below_a_lone_board_closes_it`,
// `test_source_from_a_board_s_own_cluster_while_it_is_being_edited` and
// `test_kanban_board_command_inserts_a_board_ready_to_fill` in
// `tests/window/test_window.py`. The Alt+click below a lone board has to land
// on the scroller's white space, outside the editor's own box, which only real
// layout can place; the block controls are revealed by a real hover.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  KANBAN,
  KANBAN_CARD_SLOT,
  KANBAN_LONE,
  boardSource,
  boardSvg,
  cardSlots,
  clickCardSlot,
  clickLabel,
  columnSlot,
  commitField,
  drawnBoard,
  enterEditMode,
  field,
  isEditing,
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

function editLayerGone(): boolean {
  return (
    !isEditing() &&
    document.querySelectorAll('.mermaid-editables').length === 0 &&
    cardSlots().length === 0 &&
    columnSlot() === null &&
    document.querySelector('.mermaid-kanban-chrome') === null
  )
}

/** Alt+click the scroller's white space under a document that is one board. */
async function altClickBelowTheDocument(): Promise<void> {
  const editor = app.editor.getBoundingClientRect()
  const scroller = app.editor.parentElement!.getBoundingClientRect()
  const at = { x: scroller.left + scroller.width / 2, y: Math.min(editor.bottom + 24, scroller.bottom - 8) }
  const hit = document.elementFromPoint(at.x, at.y)
  expect(hit?.closest('.ProseMirror'), 'the point is outside the editor').toBeNull()
  await pointer.press(at, { modifiers: ['Alt'] })
}

/** Hover the block and press one of its cluster's buttons by its label. */
async function pressControl(label: string): Promise<void> {
  await pointer.move(center(document.querySelector('.mermaid')!))
  await settle()
  const button = [...document.querySelectorAll<HTMLElement>('.block-controls button')].find(
    (b) => b.getAttribute('aria-label') === label,
  )
  if (!button) throw new Error(`no ${label} control`)
  await pointer.press(center(button))
}

it('Alt+click below a lone board ends its edit session, and the board reopens', async () => {
  // The listener is on the scroller, not `view.dom`, because a document of one
  // board leaves white space no editor element covers.
  await openBoard(app, KANBAN_LONE)
  await altClickBelowTheDocument()
  await waitFor(editLayerGone, { message: 'the edit layer outlived the Alt+click' })
  // No word selected anywhere on the page by the press.
  expect(String(window.getSelection())).toBe('')

  // Repeatable, and Alt+click on the board itself is the way back in.
  await pointer.press(center(boardSvg()), { modifiers: ['Alt'] })
  await waitFor(() => isEditing() && cardSlots().length > 0, { message: 'Alt+click did not reopen it' })
  await altClickBelowTheDocument()
  await waitFor(editLayerGone)
  expect(boardSource(app)).toBe(KANBAN_LONE)
})

it('Done accepts an open field before the mode changes', async () => {
  // Leaving edit mode must resolve the field first; accepted after the mode
  // change it would commit to a block that is no longer editable and be lost.
  await openBoard(app, KANBAN)
  await clickLabel('Two')
  await waitForField()
  await typeInField(' and a half')
  await pressControl('Done')
  await waitFor(editLayerGone, { message: 'Done did not leave edit mode' })
  expect(await waitForSource(app, (s) => s.includes('id2[Two and a half]'))).toBe(
    'kanban\n  Todo\n    id1[One]\n    id2[Two and a half]\n  Doing\n    id3[Three]',
  )
  expect(field()).toBeNull()
})

it('Source from the cluster while editing shows the source, and Visual brings the board back', async () => {
  // A mode flip that leaves the decoration byte-identical is never redrawn, so
  // the record would say Source while the board stays drawn.
  await openBoard(app, KANBAN)
  await pressControl('Source')
  await waitFor(() => document.querySelector('.block-source-mode') !== null, { message: 'no source mode' })
  await waitFor(editLayerGone)
  expect(document.querySelector('.mermaid-editables')).toBeNull()
  // A mode is not document content.
  expect(boardSource(app)).toBe(KANBAN)

  const visual = document.querySelector<HTMLElement>('.block-source-mode .block-control-representation')!
  expect(visual.getAttribute('aria-label')).toBe('Visual')
  await pointer.move(center(visual))
  await pointer.press(center(visual))
  await waitFor(() => document.querySelector('.mermaid .mermaid-preview svg') !== null, { timeout: 20_000 })
  await waitFor(() => !isEditing() && document.querySelector('.block-source-mode') === null)
  // Back as the drawn board, and editable again from its own control.
  await enterEditMode()
  expect(cardSlots().length).toBe(3)
})

it('the Kanban board command inserts a board already open for editing', async () => {
  // The built source has to satisfy real mermaid, and the board arrives with
  // its slots drawn so the first card can be added straight away.
  await app.setDocument('# Tasks\n')
  app.menu('insertKanban')
  await waitFor(() => document.querySelector('.edi-dialog-input') !== null, { message: 'no dialog' })
  const dialogInput = document.querySelector<HTMLTextAreaElement>('.edi-dialog-input')!
  await userEvent.fill(dialogInput, 'Todo\nDoing\nDone')
  await userEvent.click(document.querySelector<HTMLElement>('.edi-dialog .toolbar-primary')!)
  await waitFor(() => cardSlots().length === 4 && columnSlot() !== null, {
    timeout: 20_000,
    message: 'the board never came up editable',
  })
  expect(isEditing()).toBe(true)
  expect(cardSlots().map((s) => (s.textContent ?? '').trim())).toEqual(Array(4).fill(KANBAN_CARD_SLOT))
  expect(boardSource(app)).toBe('kanban\n  col1[Todo]\n  col2[Doing]\n  col3[Done]')

  await settle()
  await clickCardSlot(1)
  await commitField('Write the spec')
  await waitForSource(app, (s) => s.includes('[Write the spec]'))
  await waitFor(() => drawnBoard()[1]?.[0] === 'Write the spec', { message: 'never drawn in Doing' })
  expect(boardSource(app)).toBe('kanban\n  col1[Todo]\n  col2[Doing]\n    [Write the spec]\n  col3[Done]')
})
