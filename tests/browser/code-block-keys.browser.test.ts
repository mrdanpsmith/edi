// Arrow keys leave a code block's CodeMirror views, with real key presses.
//
// Ported from `test_arrow_keys_leave_a_code_blocks_visual_and_source_views`
// in `tests/window/test_window.py`, which dispatches synthetic keydowns. A
// grammar-backed code block is an embedded CodeMirror whose own arrow keymap
// prevents the default even where its cursor cannot move, so the exit has to
// come from `arrowExitBindings` (`src/codemirror-block.ts`) and
// `exitCodeBlock` (`src/codeBlockExit.ts`). Moving between visual lines needs
// real layout, which jsdom does not have.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  caretParagraphText,
  charBox,
  middleOf,
  pressControl,
  topBlocks,
  waitForSelector,
} from './block-helpers'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

/** Press inside a code line with the real mouse and wait for CodeMirror to have focus. */
async function pressInCode(selector: string, line = 0): Promise<void> {
  const target = app.editor.querySelectorAll(`${selector} .cm-line`)[line]
  await pointer.press(center(target))
  await waitFor(() => document.activeElement?.closest(`${selector} .cm-content`) != null, {
    message: 'CodeMirror focused',
  })
}

/** Is the DOM selection in the main editor, outside any CodeMirror? */
function caretInProse(): boolean {
  const node = document.getSelection()?.anchorNode ?? null
  const el = node instanceof Element ? node : node?.parentElement ?? null
  return !!el && !!el.closest('#editor-container .ProseMirror') && !el.closest('.cm-editor')
}

describe("a code block's visual view", () => {
  // ArrowDown on the last line goes to the end of it first, then out.
  it('ArrowDown from the last line leaves into the paragraph after', async () => {
    await app.setDocument('before\n\n```js\nconst x = 1\nconst y = 2\n```\n\nafter')
    await pressInCode('.runnable-block', 1)
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    await waitFor(() => caretParagraphText() === 'after' && caretInProse(), {
      message: 'caret in "after"',
    })
    await userEvent.keyboard('Z')
    // The keystroke lands in "after" (at the goal column the arrow carried).
    await waitFor(() => /\n\n(Zafter|afterZ)\n/.test(app.markdown()), {
      message: `typed in "after": ${JSON.stringify(app.markdown())}`,
    })
    expect(app.markdown()).toContain('const x = 1\nconst y = 2')
  })

  // ...and ArrowUp from the first line leaves into the paragraph before.
  it('ArrowUp from the first line leaves into the paragraph before', async () => {
    await app.setDocument('before\n\n```js\nconst x = 1\nconst y = 2\n```\n\nafter')
    await pressInCode('.runnable-block', 0)
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    await waitFor(() => caretParagraphText() === 'before' && caretInProse(), {
      message: 'caret in "before"',
    })
  })

  // An arrow on an inner line is CodeMirror's own: it moves between lines and
  // never leaves the block.
  it('ArrowDown on an inner line stays in the code', async () => {
    await app.setDocument('before\n\n```js\na\nb\nc\n```\n\nafter')
    await pressInCode('.runnable-block', 0)
    await userEvent.keyboard('{ArrowDown}X')
    await settle()
    expect(document.activeElement?.closest('.cm-content')).not.toBeNull()
    expect(app.markdown()).toMatch(/```js\na\n(Xb|bX)\nc\n```/)
  })

  // A code block at the end of the document gets the empty paragraph every
  // other block at the end gets, so the caret has somewhere to go.
  it('ArrowDown out of a code block that ends the document makes an empty line to type in', async () => {
    await app.setDocument('before\n\n```js\nconst x = 1\n```')
    await pressInCode('.runnable-block', 0)
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    await waitFor(() => caretInProse(), { message: 'caret left the code' })
    await userEvent.keyboard('tail')
    await waitFor(() => app.markdown().trim().endsWith('tail'))
    expect(app.markdown()).toContain('```js\nconst x = 1\n```\n\ntail')
  })

  // The way in: ArrowDown from the paragraph above enters the code.
  //
  // Only *that* it enters, not at which column: nothing in the app handles the
  // way in, so the browser moves the caret down natively and keeps its
  // horizontal position, and the column it lands on depends on pixel metrics
  // (under a loaded full-suite run it was seen at column 1). Pinning the start
  // or the end of the line made this flaky.
  it('ArrowDown from the paragraph above enters the code block', async () => {
    await app.setDocument('before\n\n```js\nconst x = 1\n```\n\nafter')
    await pointer.press(middleOf(charBox(app.editor, 'before', 5)))
    await settle()
    await userEvent.keyboard('{End}{ArrowDown}')
    await waitFor(() => document.activeElement?.closest('.runnable-block .cm-content') != null, {
      message: 'code focused',
    })
    await userEvent.keyboard('Q')
    await waitFor(() => /Q/.test(app.markdown()))
    // The Q is in the code line, wherever in it, and nothing else moved.
    const code = /```js\n([^\n]*)\n```/.exec(app.markdown())?.[1] ?? ''
    expect(code).toContain('Q')
    expect(code.replace('Q', '')).toBe('const x = 1')
    expect(app.markdown()).toMatch(/^before\n\n```js\n[^\n]*\n```\n\nafter\n?$/)
  })
})

describe("a code block's source view", () => {
  // In the source form the exit must also commit what was typed.
  it('ArrowDown at the end commits the buffer and leaves into the paragraph after', async () => {
    await app.setDocument('before\n\n```js\nconst x = 1\n```\n\nafter')
    await pressControl(topBlocks(app)[1], 'Source')
    await waitForSelector(app, '.block-source-mode .cm-content')
    await waitFor(() => document.activeElement?.closest('.block-source-mode .cm-content') != null, {
      message: 'source focused',
    })
    // The source opens with the caret on the code line, inside the fences.
    await userEvent.keyboard('{End} // edited')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    await waitForSelector(app, '.block-source-mode', false)
    await waitFor(() => caretParagraphText() === 'after' && caretInProse(), {
      message: 'caret in "after"',
    })
    expect(app.markdown()).toContain('```js\nconst x = 1 // edited\n```')
  })
})
