import { webcrypto } from 'node:crypto'

// jsdom does not implement the Web Crypto API (no `crypto.subtle`), which the
// masked-field encryption relies on. In tests, substitute Node's webcrypto.
if (typeof globalThis.crypto?.subtle === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true,
  })
}

// jsdom has no `ResizeObserver`, which the mermaid kanban ＋ and the tab bar
// use to follow the size of what they sit in. The stub records its callbacks in
// `__resizeCallbacks` so a test can fire one and assert the repositioning that
// follows — the same path a zoom takes in a real browser.
if (typeof globalThis.ResizeObserver === 'undefined') {
  const pending = new Set<() => void>()
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: class {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        pending.add(this.callback)
      }
      unobserve(): void {
        pending.delete(this.callback)
      }
      disconnect(): void {
        pending.delete(this.callback)
      }
    },
    writable: true,
    configurable: true,
  })
  Object.defineProperty(globalThis, '__resizeCallbacks', { value: pending, configurable: true })
}

/** Fire every callback the `ResizeObserver` stub is holding, as a resize would. */
export function fireResizeCallbacks(): void {
  const pending = (globalThis as { __resizeCallbacks?: Set<() => void> }).__resizeCallbacks
  for (const callback of [...(pending ?? [])]) callback()
}
