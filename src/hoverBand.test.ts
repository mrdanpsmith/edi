import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  // `preferences.ts` reads the injected snapshot once, at module load, so every
  // test here starts a new module generation with its own snapshot — the same
  // arrangement `main.test.ts`'s `loadMain` needs.
  document.documentElement.classList.remove('edi-hover-band-off')
  window.ediPreferences = {}
  vi.resetModules()
})

/** A fresh generation of the module, as a new launch of the app would see. */
async function freshHoverBand() {
  return await import('./hoverBand')
}

describe('the hover band option', () => {
  it('is on when nothing has been saved', async () => {
    const { DEFAULT_HOVER_BAND, isHoverBandEnabled } = await freshHoverBand()
    expect(DEFAULT_HOVER_BAND).toBe(true)
    expect(isHoverBandEnabled()).toBe(true)
  })

  it('reads a saved opt-out out of the injected snapshot', async () => {
    window.ediPreferences = { hoverBand: false }
    const { isHoverBandEnabled } = await freshHoverBand()
    expect(isHoverBandEnabled()).toBe(false)
  })

  it('marks the document only when the band is off', async () => {
    const { applyHoverBand } = await freshHoverBand()
    applyHoverBand(true)
    expect(document.documentElement.classList.contains('edi-hover-band-off')).toBe(false)
    applyHoverBand(false)
    expect(document.documentElement.classList.contains('edi-hover-band-off')).toBe(true)
    // Idempotent both ways, so applying the same answer twice is not a toggle.
    applyHoverBand(false)
    expect(document.documentElement.classList.contains('edi-hover-band-off')).toBe(true)
    applyHoverBand(true)
    expect(document.documentElement.classList.contains('edi-hover-band-off')).toBe(false)
  })

  it('persists the answer, and re-reads it back as off', async () => {
    const { setHoverBand, isHoverBandEnabled } = await freshHoverBand()
    setHoverBand(false)
    // The class is the whole of what the stylesheet sees, so it is the thing to
    // assert — and the answer has to be *remembered*, or the next launch (which
    // re-reads the injected snapshot) would bring the band back.
    expect(document.documentElement.classList.contains('edi-hover-band-off')).toBe(true)
    expect(isHoverBandEnabled()).toBe(false)

    setHoverBand(true)
    expect(document.documentElement.classList.contains('edi-hover-band-off')).toBe(false)
    expect(isHoverBandEnabled()).toBe(true)
  })
})
