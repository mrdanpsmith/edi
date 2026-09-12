import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BridgeObject } from './bridge'

vi.mock('./node/mermaid', () => ({
  rethemeMermaid: vi.fn(),
}))

type ThemeModule = typeof import('./theme')

let theme: ThemeModule
let retheme: ReturnType<typeof vi.fn>

async function freshTheme(): Promise<void> {
  vi.resetModules()
  delete document.documentElement.dataset.colorScheme
  retheme = (await import('./node/mermaid')).rethemeMermaid as ReturnType<typeof vi.fn>
  theme = await import('./theme')
}

interface FakeBridge extends BridgeObject {
  notifyHandlers: Array<(payload: string) => void>
  notify: { connect: (callback: (payload: string) => void) => void }
  _notify: (payload: string) => void
}

function fakeBridge(): FakeBridge {
  const handlers: Array<(payload: string) => void> = []
  return {
    invoke: vi.fn() as unknown as (method: string, requestId: number, payload: string) => void,
    result: { connect: () => undefined },
    notifyHandlers: handlers,
    notify: { connect: (callback) => handlers.push(callback) },
    _notify: (payload) => handlers.forEach((handler) => handler(payload)),
  }
}

interface MatchMediaStub {
  matches: boolean
  _fire: (dark: boolean) => void
}

function matchMediaStub(initial: boolean): typeof window.matchMedia & MatchMediaStub {
  const listeners: Array<(event: { matches: boolean }) => void> = []
  const list: Record<string, unknown> = {
    matches: initial,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, callback: (event: { matches: boolean }) => void) =>
      listeners.push(callback),
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }
  const stub = ((_query: string) => list) as unknown as typeof window.matchMedia &
    MatchMediaStub
  stub._fire = (dark: boolean) => {
    list.matches = dark
    listeners.forEach((listener) => listener({ matches: dark }))
  }
  return stub
}

function scheme(): string | undefined {
  return document.documentElement.dataset.colorScheme
}

beforeEach(() => {
  vi.clearAllMocks()
  window.matchMedia = matchMediaStub(false)
})

describe('theme', () => {
  it('applies the initial matchMedia scheme at boot', async () => {
    await freshTheme()
    theme.initTheme(undefined)
    expect(scheme()).toBe('light')
    expect(retheme).toHaveBeenCalledWith(false)
  })

  it('flips when matchMedia reports a system change', async () => {
    await freshTheme()
    const stub = matchMediaStub(false)
    window.matchMedia = stub
    theme.initTheme(undefined)
    stub._fire(true)
    expect(scheme()).toBe('dark')
    expect(retheme).toHaveBeenCalledWith(true)
  })

  it('ignores window focus: theme comes from the backend, not media re-reads', async () => {
    await freshTheme()
    theme.initTheme(undefined)
    window.dispatchEvent(new Event('focus'))
    expect(scheme()).toBe('light')
    expect(retheme).toHaveBeenCalledTimes(1)
  })

  it('flips when the backend pushes a colorScheme event', async () => {
    await freshTheme()
    const bridge = fakeBridge()
    theme.initTheme(bridge)
    bridge._notify(JSON.stringify({ type: 'colorScheme', dark: true }))
    expect(scheme()).toBe('dark')
    bridge._notify(JSON.stringify({ type: 'colorScheme', dark: false }))
    expect(scheme()).toBe('light')
  })

  it('dedupes repeated notifications of the same scheme', async () => {
    await freshTheme()
    const bridge = fakeBridge()
    theme.initTheme(bridge)
    bridge._notify(JSON.stringify({ type: 'colorScheme', dark: false }))
    bridge._notify(JSON.stringify({ type: 'colorScheme', dark: false }))
    expect(retheme).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed or unrelated notifications', async () => {
    await freshTheme()
    const bridge = fakeBridge()
    theme.initTheme(bridge)
    bridge._notify('not json')
    bridge._notify(JSON.stringify({ type: 'other', dark: true }))
    expect(scheme()).toBe('light')
    expect(retheme).toHaveBeenCalledWith(false)
  })

  it('applyColorScheme is idempotent for the same value', async () => {
    await freshTheme()
    theme.initTheme(undefined)
    theme.applyColorScheme(false)
    expect(retheme).toHaveBeenCalledTimes(1)
    expect(scheme()).toBe('light')
  })
})