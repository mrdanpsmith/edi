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

// jsdom has no layout, so it has nothing to scroll: `scrollIntoView` reports
// itself as unimplemented, which vitest counts as an unhandled error the moment a
// composer grows the block around it. Nothing about scrolling is under test — the
// padding that makes the growth possible is plain style — so it is stubbed here
// rather than guarded around in the code that uses it.
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}

/**
 * Let `n` animation frames go by.
 *
 * The kanban chrome does not reposition inside the `ResizeObserver` callback
 * itself: it asks for a frame and asks for another only while something actually
 * moved, so a board that is still settling is followed and a settled one is
 * left alone. A test that fires the observer and reads a style in the same tick
 * would read the placement from before the resize, which is the placement the
 * test is not about.
 */
export async function flushFrames(n = 4): Promise<void> {
  for (let frame = 0; frame < n; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}
