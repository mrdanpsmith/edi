// A press puts the caret where it lands.
//
// ProseMirror maps a press to a document position with `posAtCoords`, which
// needs the browser's hit test; jsdom has none (`src/test-setup.ts` stubs
// `elementFromPoint` to `null`). These presses are trusted mouse input at
// exact coordinates, through `pointer` in `tests/browser/app.ts`.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, pointer, settle, type BootedApp } from './app'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

/** The viewport box of characters `[from, to)` of `text` inside `element`. */
function charBox(element: Element, text: string, offset: number): DOMRect {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node.textContent ?? '').indexOf(text)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at + offset)
    range.setEnd(node, at + offset + 1)
    return range.getBoundingClientRect()
  }
  throw new Error(`no text ${JSON.stringify(text)}`)
}

/** The text before the caret in the paragraph that holds it. */
function textBeforeCaret(): string {
  const selection = document.getSelection()!
  const range = document.createRange()
  const block = (selection.anchorNode as Node).parentElement!.closest('p, h1, h2, li')!
  range.setStart(block, 0)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString()
}

it('puts the caret before the character whose left half was pressed', async () => {
  await app.setDocument('alpha bravo charlie\n\nsecond paragraph')
  const box = charBox(app.editor, 'bravo', 2) // the "a" in "bravo"
  await pointer.press({ x: box.left + 1, y: box.top + box.height / 2 })
  await settle()
  expect(textBeforeCaret()).toBe('alpha br')
})

it('puts the caret after the character whose right half was pressed', async () => {
  await app.setDocument('alpha bravo charlie\n\nsecond paragraph')
  const box = charBox(app.editor, 'bravo', 2)
  await pointer.press({ x: box.right - 1, y: box.top + box.height / 2 })
  await settle()
  expect(textBeforeCaret()).toBe('alpha bra')
})

it('a press in a second paragraph lands in that paragraph', async () => {
  await app.setDocument('alpha bravo charlie\n\nsecond paragraph')
  const box = charBox(app.editor, 'paragraph', 0)
  await pointer.press({ x: box.left + 1, y: box.top + box.height / 2 })
  await settle()
  expect(textBeforeCaret()).toBe('second ')
})

it('typing after a press inserts at the pressed position', async () => {
  await app.setDocument('alpha bravo charlie')
  const box = charBox(app.editor, 'charlie', 0)
  await pointer.press({ x: box.left + 1, y: box.top + box.height / 2 })
  await settle()
  await userEvent.keyboard('big ')
  expect(app.markdown().trim()).toBe('alpha bravo big charlie')
})
