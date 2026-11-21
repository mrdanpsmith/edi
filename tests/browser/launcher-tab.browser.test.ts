// The launcher tab ("New Tab"): the launcher in a tab of its own, laid out by
// a real engine and driven with real keys.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootApp, settle, waitFor, type BootedApp } from './app'
import { MOD, press } from './edit-helpers'

const RECENTS = ['/docs/notes.md', '/docs/plans/roadmap.md']

let app: BootedApp

beforeEach(() => {
  app = bootApp()
  app.bridge.answer('getRecentFiles', () => RECENTS)
  app.bridge.answer('readTextFile', ({ path }) => `# ${String(path)}\n`)
})

afterEach(() => app.dispose())

const view = (): string | undefined => document.querySelector<HTMLElement>('#app')!.dataset.view
const shown = (selector: string): boolean => {
  const element = document.querySelector<HTMLElement>(selector)
  return element !== null && element.getClientRects().length > 0
}
const tabTitles = (): string[] =>
  [...document.querySelectorAll('#tabbar .tab-title')].map((title) => title.textContent ?? '')
const focusedPath = (): string | undefined => (document.activeElement as HTMLElement | null)?.dataset.path

async function openLauncherTab(): Promise<void> {
  // Open a file first: that is also what fills the recent list.
  app.menu('openRecent', RECENTS[0])
  await waitFor(() => view() === 'editor')
  await press('t', MOD)
  await waitFor(() => view() === 'launcher')
  await settle()
}

describe('the launcher tab', () => {
  it('shows the launcher under the tab strip, without the document chrome or Exit', async () => {
    await openLauncherTab()
    expect(tabTitles()).toEqual(['notes.md', 'New Tab'])
    expect(shown('#tabbar')).toBe(true)
    expect(shown('#home-screen')).toBe(true)
    expect(shown('#home-recent-list')).toBe(true)
    expect(shown('#home-help')).toBe(true)
    expect(shown('#toolbar')).toBe(false)
    expect(shown('#editor-container')).toBe(false)
    expect(shown('#home-exit')).toBe(false)
  })

  it('puts the keyboard on the most recent document; arrows and Enter open another in place', async () => {
    await openLauncherTab()
    expect(focusedPath()).toBe(RECENTS[0])
    await press('ArrowDown')
    expect(focusedPath()).toBe(RECENTS[1])
    await press('Enter')
    await waitFor(() => view() === 'editor')
    expect(tabTitles()).toEqual(['notes.md', 'roadmap.md'])
  })

  it('keeps Exit on the screen shown with no tab open', async () => {
    await openLauncherTab()
    await press('w', MOD)
    await press('w', MOD)
    await waitFor(() => view() === 'home')
    expect(shown('#home-exit')).toBe(true)
    expect(shown('#tabbar')).toBe(false)
  })
})
