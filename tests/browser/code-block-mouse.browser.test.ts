// The mouse on code blocks, with real pointer input.
//
// A code block drawn by CodeMirror is selected as a unit (`isSelectionAtom`), like a
// diagram: a range covering it marks it `edi-block-selected`. A drag into one used to
// stop at its edge and a drag out of one stayed inside it (`src/codeBlockMouse.ts`), and
// there was no press that selected the block itself; its frame does now (`src/press.ts`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootApp, pointer, settle, type BootedApp, type Point } from './app'
import { charBox } from './edit-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const DOC = 'above line\n\n```py\nx = 1\ny = 2\n```\n\nmiddle line\n\n```\nplain one\nplain two\n```\n\nbelow line'

/** A point on a prose line, or on a CodeMirror line (whose text is split into tokens). */
function at(text: string, offset = 0): Point {
  const line = [...app.editor.querySelectorAll('.cm-line')].find((l) => l.textContent === text)
  const box = line ? line.getBoundingClientRect() : charBox(app.editor, text, offset)
  return { x: box.left + (line ? 4 + offset * 7 : 1), y: box.top + box.height / 2 }
}

const highlighted = () => app.editor.querySelector('.runnable-block:has(.cm-editor)')!
const plain = () => app.editor.querySelector('.runnable-block:has(.runnable-source)')!

describe('dragging across a highlighted code block', () => {
  beforeEach(async () => {
    await app.setDocument(DOC)
    await settle()
  })

  it('from the text above into the code takes in the whole block', async () => {
    await pointer.drag(at('above line'), at('y = 2', 2))
    await settle()
    expect(highlighted().classList.contains('edi-block-selected')).toBe(true)
  })

  it('from the code out to the text below selects the block and the text it crosses', async () => {
    await pointer.drag(at('x = 1', 2), at('middle line', 8))
    await settle()
    expect(highlighted().classList.contains('edi-block-selected')).toBe(true)
    expect(document.activeElement).toBe(app.editor)
    expect(document.getSelection()?.toString()).toContain('middle')
  })

  it('a drag that stays in the code is still CodeMirror\'s own selection', async () => {
    await pointer.drag(at('x = 1', 0), at('y = 2', 3))
    await settle()
    expect(highlighted().classList.contains('edi-block-selected')).toBe(false)
    expect(document.activeElement?.closest('.cm-editor')).not.toBeNull()
  })
})

describe('pressing a code block\'s frame', () => {
  beforeEach(async () => {
    await app.setDocument(DOC)
    await settle()
  })

  it('the language bar selects a highlighted block', async () => {
    const bar = highlighted().querySelector('.code-lang-bar')!.getBoundingClientRect()
    await pointer.press({ x: bar.left + 200, y: bar.top + bar.height / 2 })
    await settle()
    expect(highlighted().classList.contains('ProseMirror-selectednode')).toBe(true)
  })

  it('the padding selects a plain block', async () => {
    const pre = plain().querySelector('.runnable-source')!.getBoundingClientRect()
    await pointer.press({ x: pre.left + 4, y: pre.top + 3 })
    await settle()
    expect(plain().classList.contains('ProseMirror-selectednode')).toBe(true)
  })

  it('a press beside a short line of code is still a caret in the code', async () => {
    const pre = plain().querySelector('.runnable-source')!.getBoundingClientRect()
    await pointer.press({ x: pre.left + 300, y: at('plain one').y })
    await settle()
    expect(plain().classList.contains('ProseMirror-selectednode')).toBe(false)
    expect(document.getSelection()?.isCollapsed).toBe(true)
  })
})

// A raw block (an HTML block, front matter, a definition) is a code block, so the mouse
// treats it as one: its frame selects it and a drag takes it in whole.
describe('the mouse on a raw block', () => {
  const raw = () => app.editor.querySelector<HTMLElement>('.runnable-block')!

  beforeEach(async () => {
    await app.setDocument('above line\n\n<div>\nraw html\n</div>\n\nbelow line')
    await settle()
  })

  it('the label bar selects it', async () => {
    const bar = raw().querySelector('.code-lang-bar')!.getBoundingClientRect()
    await pointer.press({ x: bar.left + 200, y: bar.top + bar.height / 2 })
    await settle()
    expect(raw().classList.contains('ProseMirror-selectednode')).toBe(true)
  })

  it('a drag from the text above into it takes in the whole block', async () => {
    await pointer.drag(at('above line'), at('raw html', 2))
    await settle()
    expect(raw().classList.contains('edi-block-selected')).toBe(true)
  })
})
