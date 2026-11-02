// The fake native shell the browser tests run against.
//
// This module installs `window.bridge` as a side effect, and `app.ts` imports
// it before any `src/` module. The order matters: `src/bridge.ts` calls
// `ensureChannel()` the moment it loads, connects its reply listener to
// whatever `window.bridge` is then, and never looks again. ES modules evaluate
// in import order, so a bridge assigned in `app.ts`'s own body would arrive
// after `src/main` (and with it `src/bridge.ts`) had loaded, and no reply
// would ever reach the page.

import type { BridgeObject } from '../../src/bridge'
import type { BridgeMethod } from '../../src/contract'

export interface BridgeCall {
  method: BridgeMethod
  payload: Record<string, unknown>
}

export type Handler = (payload: Record<string, unknown>) => unknown

/** What the fake shell answers when a test has not said otherwise. */
const DEFAULT_ANSWERS: Partial<Record<BridgeMethod, Handler>> = {
  confirm: () => true,
  getPendingFiles: () => [],
  getRecentFiles: () => [],
  getPreferences: () => ({}),
  ping: () => 'pong',
}

export interface FakeBridge {
  /** Every call the page made, in order. */
  readonly calls: BridgeCall[]
  /** The calls made to one method. */
  callsTo(method: BridgeMethod): BridgeCall[]
  /**
   * Answer `method` with `handler` until the next `reset`. A thrown error is a
   * failed call; a returned promise is awaited.
   */
  answer(method: BridgeMethod, handler: Handler): void
  /** Push a shell event (`notify`) to the page, as the backend would. */
  notify(event: unknown): void
  /** Forget the recorded calls and restore the default answers. */
  reset(): void
}

function createFakeBridge(): { bridge: BridgeObject; fake: FakeBridge } {
  const calls: BridgeCall[] = []
  const answers = new Map<BridgeMethod, Handler>()
  const resultListeners: Array<(payload: string) => void> = []
  const notifyListeners = new Set<(payload: string) => void>()

  const reply = (message: unknown): void => {
    const text = JSON.stringify(message)
    for (const listener of resultListeners) listener(text)
  }

  const bridge: BridgeObject = {
    invoke(method, id, payload) {
      const call = { method: method as BridgeMethod, payload: JSON.parse(payload) }
      calls.push(call)
      // Answer asynchronously, as the real QWebChannel does.
      const handler = answers.get(call.method)
      Promise.resolve()
        .then(() => (handler ? handler(call.payload) : null))
        .then(
          (data) => reply({ id, ok: true, data: data ?? null }),
          (error: unknown) => reply({ id, ok: false, error: String(error) }),
        )
    },
    result: { connect: (callback) => void resultListeners.push(callback) },
    stream: { connect: () => undefined },
    notify: {
      connect: (callback) => void notifyListeners.add(callback),
      disconnect: (callback) => void notifyListeners.delete(callback),
    },
  }

  const fake: FakeBridge = {
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    answer: (method, handler) => void answers.set(method, handler),
    notify: (event) => {
      const text = JSON.stringify(event)
      for (const listener of notifyListeners) listener(text)
    },
    reset() {
      calls.length = 0
      answers.clear()
      for (const [method, handler] of Object.entries(DEFAULT_ANSWERS)) {
        answers.set(method as BridgeMethod, handler)
      }
    },
  }
  fake.reset()
  return { bridge, fake }
}

// One fake per test file (each file runs in its own iframe); `bootApp` resets
// it for every test.
//
// The install is idempotent across module instances. This file is both the
// browser project's setup file and an import of `app.ts`, and Vitest can load
// those as two instances of the module. A second instance that installed its
// own fake would replace `window.bridge` after `src/bridge.ts` had connected to
// the first: calls would go to the new fake, replies to nobody.
const KEY = '__ediFakeBridge'
type Installed = ReturnType<typeof createFakeBridge>
const holder = window as unknown as Record<typeof KEY, Installed | undefined>
const installed: Installed = holder[KEY] ?? (holder[KEY] = createFakeBridge())
window.bridge = installed.bridge

export const fakeBridge: FakeBridge = installed.fake
