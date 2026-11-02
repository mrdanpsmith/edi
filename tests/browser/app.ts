// Boots the real Edi page in Vitest browser mode, with a fake native shell.
//
// The page is the same one `backend/window.py` loads: the body of
// `index.html`, the shipped stylesheets and `init` from `src/main.ts`. Only the
// Python side is replaced. `window.bridge` is set before `init` runs, so
// `src/bridge.ts` uses it directly instead of opening a QWebChannel, and every
// call the page makes is recorded and answered here.
//
// Use this for frontend behaviour that needs a real layout engine (hit tests,
// geometry, trusted pointer and keyboard input) but not Python. Anything that
// needs the real shell (menus, dialogs, file IO, preferences) stays in
// `tests/window/`.

import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import '../../src/styles.css'

import indexHtml from '../../index.html?raw'
import type { BridgeObject } from '../../src/bridge'
import type { BridgeMethod } from '../../src/contract'
import { rootsFromDocument } from '../../src/appContext'
import { init } from '../../src/main'
import { resetPreferences } from '../../src/preferences'
import { resetState } from '../../src/state'

export interface BridgeCall {
  method: BridgeMethod
  payload: Record<string, unknown>
}

type Handler = (payload: Record<string, unknown>) => unknown

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
  /** Answer `method` with `handler` from now on. A thrown error is a failed call. */
  answer(method: BridgeMethod, handler: Handler): void
  /** Push a shell event (`notify`) to the page, as the backend would. */
  notify(event: unknown): void
}

function createFakeBridge(): { bridge: BridgeObject; fake: FakeBridge } {
  const calls: BridgeCall[] = []
  const answers = new Map<BridgeMethod, Handler>(
    Object.entries(DEFAULT_ANSWERS) as Array<[BridgeMethod, Handler]>,
  )
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
      queueMicrotask(() => {
        try {
          const handler = answers.get(call.method)
          reply({ id, ok: true, data: handler ? handler(call.payload) ?? null : null })
        } catch (error) {
          reply({ id, ok: false, error: String(error) })
        }
      })
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
  }
  return { bridge, fake }
}

// `src/bridge.ts` connects to `window.bridge` once per module load and keeps
// that connection, so one fake serves the whole test file (each file runs in
// its own iframe). `bootApp` clears its record for every test.
const shared = createFakeBridge()
window.bridge = shared.bridge

/** The app shell markup from `index.html`, without its module script. */
function appMarkup(): string {
  const parsed = new DOMParser().parseFromString(indexHtml, 'text/html')
  parsed.querySelectorAll('script').forEach((script) => script.remove())
  return parsed.body.innerHTML
}

export interface BootedApp {
  bridge: FakeBridge
  /** The ProseMirror editor element. */
  editor: HTMLElement
  /** Load `markdown` the way the shell does, and wait for the editor to show it. */
  setDocument(markdown: string): Promise<void>
  /** Tear the app down; call it from `afterEach`. */
  dispose(): void
}

export function bootApp(): BootedApp {
  shared.fake.calls.length = 0
  resetState()
  resetPreferences()
  document.body.innerHTML = appMarkup()
  const dispose = init(rootsFromDocument())

  const app = document.querySelector<HTMLElement>('#app')!
  return {
    bridge: shared.fake,
    get editor() {
      return document.querySelector<HTMLElement>('#editor-container .ProseMirror')!
    },
    async setDocument(markdown) {
      window.ediSetContent!(markdown)
      await waitFor(() => app.dataset.view === 'editor')
      await nextFrames()
    },
    dispose() {
      dispose()
      document.body.innerHTML = ''
    },
  }
}

/** Resolve once `condition` holds, polling every animation frame. */
export async function waitFor(
  condition: () => boolean,
  { timeout = 5000, message = 'condition never held' } = {},
): Promise<void> {
  const deadline = performance.now() + timeout
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`waitFor timed out: ${message}`)
    await nextFrames(1)
  }
}

/** Let `n` animation frames go by, so layout and rAF work has run. */
export async function nextFrames(n = 2): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}
