// Tabs, with real input: typing in one, switching with the mouse, and what a
// switch does to work still pending in an open block.
//
// Ported from `test_switching_tabs_commits_what_was_typed_into_an_open_block`
// and `test_replacing_a_document_discards_its_pending_typing` in
// `tests/window/test_window.py`. Those set a paragraph's `textContent` and fire
// a synthetic `input`; here the words are typed into the unlocked block with
// real keys (so the nested editor's DOM observer and the reveal's debounced
// persist are what is exercised) and the tab is clicked with the real mouse.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { bootApp, center, pointer, settle, waitFor, type BootedApp } from './app'
import {
  BLOCK_PASSWORD,
  MOD,
  caretAfter,
  charBox,
  emptyDocument,
  encryptBlock,
  md,
  press,
  revealedText,
  type,
} from './edit-helpers'

const THREE_PARAGRAPHS = 'Opening the door.\n\nThe window.\n\nThe end.\n'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

const tabs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#tabbar .tab')]
const activeIndex = (): number => tabs().findIndex((t) => t.classList.contains('active'))

async function clickTab(index: number): Promise<void> {
  await pointer.press(center(tabs()[index]!.querySelector('.tab-title')!))
  await waitFor(() => activeIndex() === index, { message: `tab ${index} never became active` })
  await settle()
}

describe('switching tabs', () => {
  it('Mod+N opens a new tab, and each tab keeps what was typed into it', async () => {
    await emptyDocument(app)
    await type('first document')
    await press('n', MOD)
    await waitFor(() => tabs().length === 2 && activeIndex() === 1, { message: 'new tab' })
    await emptyDocument(app)
    await type('second document')

    await clickTab(0)
    expect(md(app)).toBe('first document')
    await clickTab(1)
    expect(md(app)).toBe('second document')
  })

  it('typing marks a tab dirty, and its title says so', async () => {
    await app.setDocument('clean text')
    expect(tabs()[0]!.textContent).not.toContain('*')
    await caretAfter(app, 'text')
    await type('!')
    await waitFor(() => (tabs()[0]!.querySelector('.tab-title')!.textContent ?? '').startsWith('* '), {
      message: 'the tab never showed it was dirty',
    })
  })

  it('closing a dirty tab asks first, and a refusal keeps it open', async () => {
    await emptyDocument(app)
    await type('unsaved words')
    await press('n', MOD)
    await waitFor(() => tabs().length === 2, { message: 'new tab' })
    await clickTab(0)
    app.bridge.answer('confirm', () => false)
    await page.getByRole('button', { name: 'Close Untitled' }).first().click()
    await waitFor(() => app.bridge.callsTo('confirm').length === 1, { message: 'confirm' })
    await settle()
    expect(tabs()).toHaveLength(2)
    expect(md(app)).toBe('unsaved words')

    // And a yes closes it, leaving the other tab active.
    app.bridge.answer('confirm', () => true)
    await page.getByRole('button', { name: 'Close Untitled' }).first().click()
    await waitFor(() => tabs().length === 1, { message: 'a confirmed close never closed' })
    expect(app.bridge.callsTo('confirm')).toHaveLength(2)
  })
})

describe('an unlocked block when its document is left', () => {
  async function openSecondTabWithBlock(): Promise<void> {
    await app.setDocument(THREE_PARAGRAPHS)
    app.menu('new')
    await waitFor(() => tabs().length === 2 && activeIndex() === 1, { message: 'new tab' })
    // The blank tab is the active one, so the document lands in it.
    await app.setDocument(THREE_PARAGRAPHS)
    await encryptBlock(app, 'Opening the door.')
  }

  /** Put the caret at the end of the reveal's paragraph and type `text` with real keys. */
  async function typeIntoReveal(text: string): Promise<void> {
    const reveal = app.editor.querySelector('.encrypted-block-reveal p')!
    const box = charBox(reveal, 'door.', 4)
    await pointer.press({ x: box.right - 1, y: box.top + box.height / 2 })
    await settle()
    await type(text)
  }

  it('clicking another tab commits what was typed into it', async () => {
    // Straight to the other tab, without giving the reveal's 600 ms debounce
    // time to fire on its own: a plain wait would make a switch that commits
    // nothing look like one that does.
    await openSecondTabWithBlock()
    await typeIntoReveal(' Typed into the secret.')
    await clickTab(0)
    await waitFor(() => app.editor.querySelectorAll('.encrypted-block-reveal').length === 0, {
      message: 'the other tab still shows a reveal',
    })

    // Back: the block is locked again, and unlocking it is the only thing that
    // can tell "the edit survived" from "the state object still looks right".
    await clickTab(1)
    const block = app.editor.querySelector('.encrypted-block')!
    await pointer.move(center(block))
    const unlock = block.querySelector<HTMLElement>('.block-control-interaction')!
    await waitFor(() => getComputedStyle(unlock.closest('.block-control-pill')!).opacity === '1', {
      message: 'the cluster never showed',
    })
    await pointer.press(center(unlock))
    await expect.element(page.getByText('Show encrypted block', { exact: true })).toBeVisible()
    await type(BLOCK_PASSWORD)
    await press('Enter')
    await waitFor(() => revealedText(app).length > 0, { timeout: 20_000, message: 'unlock' })
    expect(revealedText(app).join(' ')).toContain('Typed into the secret.')
  })

  it('replacing the document discards it, synchronously', async () => {
    // A document replaced from outside has nowhere to commit to, and waiting
    // for a crypto round trip would make the load asynchronous.
    await app.setDocument(THREE_PARAGRAPHS)
    await encryptBlock(app, 'Opening the door.')
    await typeIntoReveal(' Never written back.')

    window.ediSetContent!('A different document entirely.\n')
    // Same turn as the load, on purpose.
    expect(document.querySelector('#editor-container')!.textContent).toContain('different document')
    expect(app.editor.querySelectorAll('.encrypted-block-reveal')).toHaveLength(0)
    await settle()
    expect(md(app)).toBe('A different document entirely.')
  })
})
