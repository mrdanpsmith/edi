// Block markers and undo/redo typed with real keys.
//
// `src/blockstart.test.ts` runs the input rules on a view in jsdom. These type
// the marker through Playwright's keyboard, so the space that fires a rule is a
// real keystroke that Blink inserts and ProseMirror reads back from the DOM,
// and Enter/Tab/Backspace and Mod+Z go through the keymaps in their real order
// (block keymaps before the base keymap, history before the input-rule undo).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootApp, settle, type BootedApp } from './app'
import { MOD, blockTypes, emptyDocument, md, press, type } from './edit-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

describe('typing a block marker', () => {
  it('"## " makes a heading and the words land in it', async () => {
    await emptyDocument(app)
    await type('## Title')
    expect(blockTypes(app)).toEqual(['heading'])
    expect(app.doc().firstChild!.attrs.level).toBe(2)
    expect(md(app)).toBe('## Title')
  })

  it('"- " makes a bullet list, Enter continues it and Enter on an empty item ends it', async () => {
    await emptyDocument(app)
    await type('- one{Enter}two{Enter}{Enter}after')
    expect(md(app)).toBe('- one\n- two\n\nafter')
  })

  it('"1. " makes an ordered list, and Tab nests the next item', async () => {
    await emptyDocument(app)
    await type('1. first{Enter}')
    await press('Tab')
    await type('inner')
    const list = app.doc().firstChild!
    expect(list.type.name).toBe('ordered_list')
    expect(list.firstChild!.lastChild!.type.name).toBe('ordered_list')
    expect(md(app)).toMatch(/^1\. first\n\s+1\. inner$/)
  })

  it('"- [ ] " makes an unchecked task item', async () => {
    await emptyDocument(app)
    await type('- [[ ] buy milk')
    expect(md(app)).toBe('- [ ] buy milk')
  })

  it('"> " makes a blockquote holding what is typed', async () => {
    await emptyDocument(app)
    await type('> quoted')
    expect(blockTypes(app)).toEqual(['blockquote'])
    expect(md(app)).toBe('> quoted')
  })

  it('"```js " makes a code block whose editor takes the typing', async () => {
    // A language block is a CodeMirror node view with no contentDOM: the rule
    // parks ProseMirror's caret inside it, and the keys after the space have to
    // reach CodeMirror. They used to go nowhere (RunnableBlockNodeView had no
    // `setSelection` to hand the caret over), so the block stayed empty.
    await emptyDocument(app)
    await type('```js const a = 1')
    expect(blockTypes(app)).toEqual(['code_block'])
    expect(app.doc().firstChild!.attrs.language).toBe('js')
    expect(app.doc().firstChild!.textContent).toBe('const a = 1')
    expect(document.activeElement?.closest('.cm-editor')).not.toBeNull()
  })

  it('"---" on its own line becomes a horizontal rule', async () => {
    await emptyDocument(app)
    await type('---')
    expect(blockTypes(app)).toContain('horizontal_rule')
  })

  it('a marker typed after text on the line stays literal', async () => {
    await emptyDocument(app)
    await type('x # not a heading')
    expect(blockTypes(app)).toEqual(['paragraph'])
  })
})

describe('undo and redo', () => {
  it('Mod+Z takes a converted block back, and Mod+Y puts it back', async () => {
    await emptyDocument(app)
    await type('## Title')
    expect(blockTypes(app)).toEqual(['heading'])
    await press('z', MOD)
    expect(blockTypes(app)).toEqual(['paragraph'])
    expect(md(app)).toBe('')
    await press('y', MOD)
    expect(md(app)).toBe('## Title')
  })

  it('Mod+Z undoes typing and Mod+Shift+Z redoes it', async () => {
    await app.setDocument('start')
    await emptyDocument(app)
    await type('hello world')
    expect(md(app)).toBe('hello world')
    await press('z', MOD)
    expect(md(app)).toBe('')
    await press('z', MOD, 'Shift')
    expect(md(app)).toBe('hello world')
  })

  it('the Edit menu’s Undo and Redo act on the document the caret is in', async () => {
    await emptyDocument(app)
    await type('menu typed')
    app.menu('undo')
    await settle()
    expect(md(app)).toBe('')
    app.menu('redo')
    await settle()
    expect(md(app)).toBe('menu typed')
  })

  it('loading a document is not an undoable step', async () => {
    // A freshly loaded file must not undo back to the previous document.
    await app.setDocument('first file')
    await app.setDocument('second file')
    app.editor.focus()
    await press('z', MOD)
    expect(md(app)).toBe('second file')
  })
})
