// Link clicks with real, trusted mouse input.
//
// Ported from `test_right_click_edits_a_link_and_never_opens_it` in
// `tests/window/test_window.py`. jsdom cannot run this: ProseMirror resolves a
// click through `posAtCoords`, which needs a hit test, and the Qt suite has to
// synthesise the events in JavaScript because `QTest` input never reaches the
// page. Here Playwright presses the real mouse buttons.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { bootApp, waitFor, type BootedApp } from './app'

let app: BootedApp

beforeEach(async () => {
  app = bootApp()
  await app.setDocument('See [the site](https://example.com/) now')
})

afterEach(() => app.dispose())

function link(): HTMLAnchorElement {
  return app.editor.querySelector<HTMLAnchorElement>('a[href]')!
}

function linkHrefs(): string[] {
  const hrefs: string[] = []
  const anchors = app.editor.querySelectorAll<HTMLAnchorElement>('a[href]')
  anchors.forEach((a) => hrefs.push(a.getAttribute('href') ?? ''))
  return hrefs
}

describe('clicking a link', () => {
  it('opens it on a left click, through the shell', async () => {
    await userEvent.click(link())
    await waitFor(() => app.bridge.callsTo('openUrl').length > 0, { message: 'openUrl' })
    expect(app.bridge.callsTo('openUrl')).toEqual([
      { method: 'openUrl', payload: { url: 'https://example.com/' } },
    ])
  })

  it('offers to edit it on a right click, and never opens it', async () => {
    // A right click runs ProseMirror's click path on release, the path that
    // used to open the link as well as raise the menu.
    await userEvent.click(link(), { button: 'right' })
    const editItem = page.getByRole('menuitem', { name: 'Edit link…' })
    await expect.element(editItem).toBeVisible()
    expect(app.bridge.callsTo('openUrl')).toEqual([])

    await editItem.click()
    await expect.element(page.getByText('Edit link', { exact: true })).toBeVisible()
    const url = page.getByRole('textbox', { name: 'URL' })
    await expect.element(url).toHaveValue('https://example.com/')
    await url.fill('https://example.org/edited')
    await page.getByRole('button', { name: 'Update' }).click()

    await waitFor(() => linkHrefs()[0] === 'https://example.org/edited', { message: 'href' })
    expect(linkHrefs()).toEqual(['https://example.org/edited'])
    expect(app.bridge.callsTo('openUrl')).toEqual([])
  })
})
