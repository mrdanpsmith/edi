// Inline marks typed with real keys (docs/editor-marks.md).
//
// `src/markExit.test.ts` and `src/formatting-keymap.test.ts` call the input
// rules and key handlers directly. These type the characters through
// Playwright's keyboard, so the path is the real one: a `keydown`, the
// browser's own `beforeinput`/text insertion, ProseMirror's DOM observer and
// `handleTextInput`, then the input rule, then the next character inheriting
// (or not) `storedMarks`. An arrow key here is the browser's, so the second
// press really moves the DOM caret rather than a test setting a selection.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootApp, type BootedApp } from './app'
import { MOD, caretAfter, chord, emptyDocument, md, press, runs, type } from './edit-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

describe('a closing delimiter', () => {
  it('makes bold, and the text typed after it is plain', async () => {
    await emptyDocument(app)
    await type('**bold** and more')
    expect(runs(app)).toEqual([
      { text: 'bold', marks: ['strong'] },
      { text: ' and more', marks: [] },
    ])
    expect(md(app)).toBe('**bold** and more')
  })

  it('makes emphasis from single stars without stealing a bold pair', async () => {
    await emptyDocument(app)
    await type('*it* then **strong**!')
    expect(runs(app)).toEqual([
      { text: 'it', marks: ['em'] },
      { text: ' then ', marks: [] },
      { text: 'strong', marks: ['strong'] },
      { text: '!', marks: [] },
    ])
  })

  it('makes a code span, and the next character is outside it', async () => {
    await emptyDocument(app)
    await type('run `ls -la` now')
    expect(runs(app)).toEqual([
      { text: 'run ', marks: [] },
      { text: 'ls -la', marks: ['code'] },
      { text: ' now', marks: [] },
    ])
  })

  it('makes strikethrough from ~~, not a subscript of the inner ~…~', async () => {
    // The whole-run guards: typing `~~strike~~` passes through `~~strike~`,
    // where the subscript rule would match `~strike~` without its lookbehind.
    await emptyDocument(app)
    await type('~~strike~~ after')
    expect(runs(app)).toEqual([
      { text: 'strike', marks: ['strikethrough'] },
      { text: ' after', marks: [] },
    ])
  })

  it('makes highlight, subscript and superscript from their paired delimiters', async () => {
    await emptyDocument(app)
    await type('==hi== H~2~O x^2^ end')
    expect(runs(app)).toEqual([
      { text: 'hi', marks: ['highlight'] },
      { text: ' H', marks: [] },
      { text: '2', marks: ['sub'] },
      { text: 'O x', marks: [] },
      { text: '2', marks: ['sup'] },
      { text: ' end', marks: [] },
    ])
  })

  it('inside bold, a code span ends and the bold carries on', async () => {
    // `stopMarking` drops only the mark it closed: the next character keeps the
    // bold it was already typed in.
    await emptyDocument(app)
    await press('b', MOD)
    await type('see `x` here')
    expect(runs(app)).toEqual([
      { text: 'see ', marks: ['strong'] },
      { text: 'x', marks: ['strong', 'code'] },
      { text: ' here', marks: ['strong'] },
    ])
  })

  it('inside italics, a ==highlight== keeps the italics', async () => {
    // The paired-delimiter rules (`src/remark/pairedDelimiter.ts`) are a
    // separate code path from the `**`/`` ` `` ones, with the same contract.
    await emptyDocument(app)
    await press('i', MOD)
    await type('so ==very== much')
    expect(runs(app)).toEqual([
      { text: 'so ', marks: ['em'] },
      { text: 'very', marks: ['em', 'highlight'] },
      { text: ' much', marks: ['em'] },
    ])
  })
})

describe('walking out of a mark with an arrow key', () => {
  it('ArrowRight at the end of a code span that ends the line leaves it', async () => {
    // The caret at the end of a run has one DOM position; the first arrow press
    // is what gives the outside stop meaning, since the browser cannot move.
    await app.setDocument('Use `code`')
    await caretAfter(app, 'code')
    await press('ArrowRight')
    await type(' after')
    expect(runs(app)).toEqual([
      { text: 'Use ', marks: [] },
      { text: 'code', marks: ['code'] },
      { text: ' after', marks: [] },
    ])
  })

  it('ArrowRight at the end of a span mid-sentence leaves it, and the next press moves', async () => {
    await app.setDocument('A `code`tail')
    await caretAfter(app, 'code')
    await press('ArrowRight')
    await type('!')
    expect(md(app)).toBe('A `code`!tail')
  })

  it('the press after leaving a span is the browser’s, and moves the caret', async () => {
    await app.setDocument('A `code`tail')
    await caretAfter(app, 'code')
    await press('ArrowRight')
    await press('ArrowRight')
    await type('X')
    expect(md(app)).toBe('A `code`tXail')
  })

  it('ArrowLeft onto the end of a span from the text after it lands outside', async () => {
    await app.setDocument('A **bold**tail')
    await caretAfter(app, 't')
    await press('ArrowLeft')
    await type('+')
    expect(runs(app)).toEqual([
      { text: 'A ', marks: [] },
      { text: 'bold', marks: ['strong'] },
      { text: '+tail', marks: [] },
    ])
  })

  it('without the arrow, typing at the end of a span extends it', async () => {
    // The contrast that makes the arrow tests mean something.
    await app.setDocument('Use `code`')
    await caretAfter(app, 'code')
    await type('s')
    expect(runs(app)).toEqual([
      { text: 'Use ', marks: [] },
      { text: 'codes', marks: ['code'] },
    ])
  })
})

describe('formatting shortcuts', () => {
  it('Mod+B and Mod+I toggle the mark for what is typed next', async () => {
    // Toggled between letters, so no space is involved: a space typed just before
    // the toggle is `edit-whitespace.browser.test.ts`'s.
    await emptyDocument(app)
    await type('x')
    await press('b', MOD)
    await type('bold')
    await press('b', MOD)
    await type('y')
    await press('i', MOD)
    await type('it')
    expect(runs(app)).toEqual([
      { text: 'x', marks: [] },
      { text: 'bold', marks: ['strong'] },
      { text: 'y', marks: [] },
      { text: 'it', marks: ['em'] },
    ])
  })

  it('Mod+Alt+C turns a selection into inline code', async () => {
    await app.setDocument('call foo now')
    await caretAfter(app, 'foo')
    await userEvent_shiftLeft(3)
    await press('c', MOD, 'Alt')
    expect(md(app)).toBe('call `foo` now')
  })
})

/** Extend the selection `n` characters to the left with Shift+ArrowLeft. */
async function userEvent_shiftLeft(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await type(chord('ArrowLeft', 'Shift'))
}
