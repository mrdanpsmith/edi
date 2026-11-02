// Dragging a whole block starts no drag.
//
// Ported from `test_dragging_a_whole_block_starts_no_drag` in
// `tests/window/test_window.py`, which dispatches a synthetic `dragstart` and
// so cannot say whether a real drag would begin. Here Playwright's mouse
// really presses, moves and releases: a selected atom is `draggable` (set by
// ProseMirror on the press), so Chromium itself starts a drag, and
// `blockDragPlugin` (`src/blockDrag.ts`) has to refuse it at that real
// `dragstart`. jsdom has no drag and drop at all.
//
// The text half of the gate (a word inside a paragraph still drags) stays in
// the Qt suite: headless Chromium under Playwright never starts a drag of
// *selected text* (a `draggable` element drags, a selection only extends), so
// that case cannot be driven with a real mouse here. See the skipped test.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import { charBox, middleOf, topBlocks, waitForDiagrams } from './block-helpers'

let app: BootedApp

interface DragRecord {
  refused: boolean
  types: string[]
}

let drags: DragRecord[] = []
const record = (event: DragEvent): void => {
  drags.push({
    refused: event.defaultPrevented,
    types: [...(event.dataTransfer?.types ?? [])],
  })
}

beforeEach(() => {
  app = bootApp()
  drags = []
  // Bubble phase on the window: after ProseMirror and the gate have spoken.
  window.addEventListener('dragstart', record)
})

afterEach(() => {
  window.removeEventListener('dragstart', record)
  app.dispose()
})

const DIAGRAM_DOC = 'Before.\n\n```mermaid\ngraph TD\n  A[Alpha]\n```\n\nAfter.'

async function selectDiagram(): Promise<HTMLElement> {
  await app.setDocument(DIAGRAM_DOC)
  await waitForDiagrams(app)
  const diagram = app.editor.querySelector<HTMLElement>('.mermaid')!
  await pointer.press(center(diagram.querySelector('svg')!))
  await waitFor(() => diagram.classList.contains('ProseMirror-selectednode'), {
    message: 'diagram selected',
  })
  return diagram
}

// A diagram is an atom; once a press holds it as a node, Chromium starts a
// real drag from it, and the gate cancels that drag with an empty transfer.
// Released over the paragraph below, nothing moves and nothing is copied.
it('of a selected diagram is refused, carries nothing, and moves nothing', async () => {
  const diagram = await selectDiagram()
  const before = app.doc()
  // Far enough from the press that ProseMirror does not count it a double click.
  const svg = diagram.querySelector('svg')!.getBoundingClientRect()
  const from = { x: svg.left + svg.width * 0.25, y: svg.top + svg.height / 2 }
  const after = charBox(app.editor, 'After.', 5)
  await pointer.drag(from, { x: after.right + 2, y: after.top + after.height / 2 }, 16)
  await settle()
  expect(drags).toEqual([{ refused: true, types: [] }])
  expect(app.doc().eq(before)).toBe(true)
  expect(topBlocks(app).map((b) => b.className.split(' ')[0])).toEqual([
    'block-visual-mode',
    'mermaid',
    'block-visual-mode',
  ])
})

// A refused drag leaves the press as a press: the diagram is still the
// selected block, and typing replaces nothing it should not.
it('leaves the diagram selected after the refused drag', async () => {
  const diagram = await selectDiagram()
  const svg = diagram.querySelector('svg')!.getBoundingClientRect()
  await pointer.drag(
    { x: svg.left + svg.width * 0.25, y: svg.top + svg.height / 2 },
    { x: 400, y: 700 },
    16,
  )
  await settle()
  expect(drags.length).toBeGreaterThan(0)
  expect(drags.every((d) => d.refused)).toBe(true)
  expect(diagram.classList.contains('ProseMirror-selectednode')).toBe(true)
})

// Kept for when the runner can drag selected text: the gate's other half.
it.skip('of a word inside a paragraph starts, carries the word and moves it', async () => {
  await app.setDocument('Ordinary prose to drag from.\n\nTail.')
  const p = app.editor.querySelector('p')!
  const pr = p.getBoundingClientRect()
  const a = middleOf(charBox(app.editor, 'Ordinary', 1))
  await userEvent.dblClick(p, { position: { x: a.x - pr.left, y: a.y - pr.top } } as never)
  await settle()
  const tail = charBox(app.editor, 'Tail.', 4)
  await pointer.drag(middleOf(charBox(app.editor, 'Ordinary', 6)), { x: tail.right + 1, y: tail.top + 8 })
  await waitFor(() => drags.length > 0, { message: 'dragstart' })
  expect(drags[0].refused).toBe(false)
  expect(drags[0].types).toContain('text/plain')
})
