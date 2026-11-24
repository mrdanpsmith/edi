// A run's output, with real pointer input: its text is the reader's to select
// and copy, under both code block renderers.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { bootApp, pointer, settle, waitFor, type BootedApp, type Point } from './app'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const OUTPUT = 'first output line\nsecond output line\n'

/** A point `offset` characters into the output line that reads `text`. */
function inOutput(block: Element, text: string, offset: number): Point {
  const line = [...block.querySelectorAll('.exec-output .term-line')].find(
    (l) => l.textContent?.replace('\n', '') === text,
  )!
  const node = [...line.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent !== '\n')!
  const range = document.createRange()
  range.setStart(node, offset)
  range.setEnd(node, offset + 1)
  const box = range.getBoundingClientRect()
  return { x: box.left + 1, y: box.top + box.height / 2 }
}

async function runBlock(block: Element): Promise<void> {
  ;(block.querySelector('.exec-run') as HTMLButtonElement).click()
  await waitFor(() => block.querySelector('.exec-output')?.textContent?.includes('second') === true, {
    message: 'the run output never showed',
  })
  await settle()
}

describe.each([
  ['highlighted (CodeMirror)', '```\n#!/usr/bin/env python3\nprint("hi")\n```'],
  ['plain', '```\n#!/usr/bin/env fortune\nhi\n```'],
])('the run output of a %s block', (_name, markdown) => {
  beforeEach(async () => {
    app.bridge.answer('streamCodeBlock', () => ({ exitCode: 0, stdout: OUTPUT, stderr: '', timedOut: false }))
    await app.setDocument(`above\n\n${markdown}\n\nbelow`)
  })

  it('is selected by a drag across its text', async () => {
    const block = app.editor.querySelector('.runnable-block')!
    await runBlock(block)

    await pointer.drag(inOutput(block, 'first output line', 6), inOutput(block, 'second output line', 6))
    await settle()

    expect(document.getSelection()?.toString()).toBe('output line\nsecond')
  })

  it('selects a word on a double-click', async () => {
    const block = app.editor.querySelector('.runnable-block')!
    await runBlock(block)

    const output = block.querySelector('.exec-output')!
    const at = inOutput(block, 'second output line', 9)
    const box = output.getBoundingClientRect()
    await userEvent.dblClick(output, { position: { x: at.x - box.left, y: at.y - box.top } })
    await settle()

    expect(document.getSelection()?.toString().trim()).toBe('output')
  })

  /** Select the reader's text in the output, as a drag does. */
  async function selectOutput(block: Element): Promise<void> {
    await pointer.drag(inOutput(block, 'first output line', 6), inOutput(block, 'second output line', 6))
    await settle()
  }

  it('copies the selection from the context menu', async () => {
    const block = app.editor.querySelector('.runnable-block')!
    await runBlock(block)
    await selectOutput(block)

    await pointer.press(inOutput(block, 'first output line', 8), { button: 'right' })
    await waitFor(() => document.querySelector('.edi-context-menu') !== null, { message: 'context menu' })
    const copy = page.getByRole('menuitem', { name: 'Copy', exact: true })
    expect(copy.element().hasAttribute('disabled')).toBe(false)
    // The output is not the document's: there is nothing to cut.
    expect(page.getByRole('menuitem', { name: 'Cut', exact: true }).element().hasAttribute('disabled')).toBe(true)
    // Picking the item hands focus back first; in a highlighted block that is
    // CodeMirror, whose caret then replaces the output's DOM selection.
    await copy.click()
    await settle()

    expect(copiedTexts()).toEqual(['output line\nsecond'])
  })

  it('copies from the context menu without scrolling the document', async () => {
    // Far enough down that the editor's own caret, still at the top, is off screen.
    const filler = Array.from({ length: 60 }, (_, i) => `paragraph ${i}`).join('\n\n')
    await app.setDocument(`${filler}\n\n${markdown}\n\nbelow`)
    const block = app.editor.querySelector('.runnable-block')!
    await runBlock(block)
    block.querySelector('.exec-output')!.scrollIntoView({ block: 'center' })
    await settle()
    const scroller = document.querySelector('#editor-container')!
    const before = scroller.scrollTop
    expect(before).toBeGreaterThan(0)
    await selectOutput(block)

    await pointer.press(inOutput(block, 'first output line', 8), { button: 'right' })
    await waitFor(() => document.querySelector('.edi-context-menu') !== null, { message: 'context menu' })
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click()
    await settle()

    expect(copiedTexts()).toEqual(['output line\nsecond'])
    expect(scroller.scrollTop).toBe(before)
    // And the reader's selection is still there to see.
    expect(document.getSelection()?.toString()).toBe('output line\nsecond')
  })

  it('copies the selection with the copy key, even with text selected in the document before', async () => {
    const block = app.editor.querySelector('.runnable-block')!
    await runBlock(block)
    // A document selection the drag into the output does not replace.
    await userEvent.dblClick(page.getByText('below', { exact: true }))
    await settle()
    await selectOutput(block)

    await userEvent.keyboard(`{${MOD}>}c{/${MOD}}`)
    await settle()

    expect(copiedTexts()).toEqual(['output line\nsecond'])
  })
})

const MOD = navigator.platform.includes('Mac') ? 'Meta' : 'Control'

function copiedTexts(): string[] {
  return app.bridge.callsTo('copyText').map((call) => String(call.payload.text))
}
