import { beforeEach, describe, expect, it, vi } from 'vitest'

import { invoke } from './bridge'

vi.mock('./bridge')

beforeEach(() => {
  vi.mocked(invoke).mockClear()
  vi.mocked(invoke).mockResolvedValue(undefined)
  window.ediPreferences = {}
  vi.resetModules()
})

async function freshPreferences() {
  return await import('./preferences')
}

describe('preferences', () => {
  it('defaults to the shipped answers with no shell at all', async () => {
    // `npm run dev` in a plain browser, and every unit test: nothing injected.
    delete window.ediPreferences
    const { currentPreferences: read, DEFAULT_PREFERENCES: defaults } = await freshPreferences()
    expect(read()).toEqual({ zoomFactor: 1, toolbarVisible: true, hoverBand: true })
    expect(defaults).toEqual({ zoomFactor: 1, toolbarVisible: true, hoverBand: true })
  })

  it('takes the shell\'s injected snapshot as it stands', async () => {
    window.ediPreferences = { zoomFactor: 1.5, toolbarVisible: false, hoverBand: false }
    const { currentPreferences: read } = await freshPreferences()
    expect(read()).toEqual({ zoomFactor: 1.5, toolbarVisible: false, hoverBand: false })
  })

  it('takes only the keys that are the right shape', async () => {
    // A page from an older edi, or a hand-edited Edi.conf behind it: a missing
    // key and a wrongly-typed one both have to land on the default rather than
    // reaching the editor as `undefined` or as a string.
    window.ediPreferences = { zoomFactor: '1.5', toolbarVisible: 'no' }
    const { currentPreferences: read } = await freshPreferences()
    expect(read()).toEqual({ zoomFactor: 1, toolbarVisible: true, hoverBand: true })
  })

  it('rejects a NaN level rather than letting it into the ladder', async () => {
    window.ediPreferences = { zoomFactor: null }
    const { currentPreferences: read } = await freshPreferences()
    expect(read().zoomFactor).toBe(1)
  })

  it('sends a write to the shell and keeps its own record of it', async () => {
    const { currentPreferences: read, savePreference: save } = await freshPreferences()
    save('hoverBand', false)
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('setPreference', {
      name: 'hoverBand',
      value: false,
    })
    // `current` is what `setMenuState` publishes, so it has to be the answer
    // just given — not a re-read of the injection, which is this launch's.
    expect(read().hoverBand).toBe(false)
    expect(read().zoomFactor).toBe(1)
  })

  it('survives a shell that is not there', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('bridge down'))
    const { currentPreferences: read, savePreference: save } = await freshPreferences()
    save('toolbarVisible', false)
    // The page has already applied the change by the time it asks; a failed
    // write costs the next launch its memory of it, and nothing in this one.
    expect(read().toolbarVisible).toBe(false)
  })
})
