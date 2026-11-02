// Document zoom and its layout effect (`src/zoom.ts`, `src/zoomController.ts`).
//
// `src/zoom.test.ts` checks the ladder and that a CSS variable is written. Only
// a real layout engine can say what that variable does: the document's boxes
// scale, the chrome's do not, a press still lands on the character under it,
// and the shortcut and the status-bar indicator go through real input.

import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { bootApp, settle, waitFor, type BootedApp } from './app'
import { MOD, caretAfter, charBox, press, type } from './edit-helpers'

let app: BootedApp | null = null

afterEach(() => {
  app?.dispose()
  app = null
})

async function boot(preferences: Record<string, unknown> = {}): Promise<BootedApp> {
  app = bootApp({ preferences })
  await app.setDocument('# Heading\n\nZoom target words here.')
  return app
}

const indicator = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('#status-zoom')!
const textHeight = (a: BootedApp): number => charBox(a.editor, 'target', 0).height

/** The drawn width of the sentence, which scales smoothly (a line box rounds). */
function textWidth(a: BootedApp): number {
  const first = charBox(a.editor, 'Zoom target words here.', 0)
  const last = charBox(a.editor, 'Zoom target words here.', 'Zoom target words here.'.length - 1)
  return last.right - first.left
}
const toolbarHeight = (): number => document.querySelector('#toolbar, .toolbar')!.getBoundingClientRect().height

describe('the zoom level', () => {
  it('a stored zoomFactor scales the document on boot, and the indicator shows it', async () => {
    const plain = await boot()
    const base = textWidth(plain)
    const chrome = toolbarHeight()
    plain.dispose()

    const zoomed = await boot({ zoomFactor: 1.5 })
    expect(textWidth(zoomed) / base).toBeCloseTo(1.5, 1)
    // The chrome is outside `#editor-container`, so it never scales.
    expect(toolbarHeight()).toBeCloseTo(chrome, 0)
    expect(indicator().hidden).toBe(false)
    expect(indicator().textContent).toBe('150%')
  })

  it('a stored level off the ladder is clamped to the nearest rung', async () => {
    await boot({ zoomFactor: 1.3 })
    expect(indicator().textContent).toBe('125%')
  })

  it('Mod+= and Mod+- step the ladder, save the preference, and Mod+0 resets', async () => {
    const a = await boot()
    const base = textWidth(a)
    await caretAfter(a, 'words')
    await press('=', MOD)
    await waitFor(() => indicator().textContent === '110%', { message: 'zoom in' })
    expect(textWidth(a) / base).toBeCloseTo(1.1, 1)
    expect(a.bridge.callsTo('setPreference').at(-1)!.payload).toMatchObject({ name: 'zoomFactor', value: 1.1 })

    await press('-', MOD)
    await press('-', MOD)
    await waitFor(() => indicator().textContent === '90%', { message: 'zoom out' })
    await press('0', MOD)
    await waitFor(() => indicator().hidden, { message: 'reset hides the indicator' })
    expect(textWidth(a)).toBeCloseTo(base, 0)
  })

  it('the View menu’s zoomTo sets an exact level, and the indicator click resets it', async () => {
    const a = await boot()
    a.menu('zoomTo', '2')
    await waitFor(() => indicator().textContent === '200%', { message: 'zoomTo' })
    await page.getByRole('button', { name: '200%' }).click()
    await waitFor(() => indicator().hidden, { message: 'the indicator never reset the zoom' })
  })
})

describe('editing at a zoom level', () => {
  it('a press lands on the character under it, and typing goes there', async () => {
    // A zoomed document has two coordinate spaces; a hit test that used the
    // wrong one would put the caret a factor away from the press.
    const a = await boot({ zoomFactor: 2 })
    await caretAfter(a, 'Zoom')
    await type('!')
    expect(a.markdown().trim()).toBe('# Heading\n\nZoom! target words here.')
  })

  it('the find bar, which is chrome, stays its own size while the document is zoomed', async () => {
    const plain = await boot()
    await caretAfter(plain, 'words')
    await press('f', MOD)
    const bar = (): DOMRect => document.querySelector('#edi-search-bar')!.getBoundingClientRect()
    await waitFor(() => bar().height > 0, { message: 'find bar' })
    const height = bar().height
    plain.dispose()

    const zoomed = await boot({ zoomFactor: 2 })
    await caretAfter(zoomed, 'words')
    await press('f', MOD)
    await waitFor(() => bar().height > 0, { message: 'find bar' })
    expect(bar().height).toBeCloseTo(height, 0)
    await type('target')
    await settle()
    // The highlight is drawn in the document, so it scales with the text.
    const match = zoomed.editor.querySelector('.edi-search-match-current')!.getBoundingClientRect()
    expect(match.height).toBeCloseTo(textHeight(zoomed), 0)
  })
})
