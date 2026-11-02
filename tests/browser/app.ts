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

// First, before any `src/` module loads: see the header of fake-bridge.ts.
import { fakeBridge, type FakeBridge } from './fake-bridge'

import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import '../../src/styles.css'

import { commands } from 'vitest/browser'
import type { Node as ProseNode } from 'prosemirror-model'
import indexHtml from '../../index.html?raw'
import type { MenuCommand, PreferenceName } from '../../src/contract'
import { rootsFromDocument } from '../../src/appContext'
import { init } from '../../src/main'
import { proseToMarkdown } from '../../src/markdown'
import { resetPreferences } from '../../src/preferences'
import { resetState } from '../../src/state'
import type { InputStep } from './commands'

declare module 'vitest/browser' {
  interface BrowserCommands {
    input: (steps: InputStep[]) => Promise<void>
  }
}

export type { BridgeCall, FakeBridge } from './fake-bridge'

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
  /** The document ProseMirror holds right now (not the last saved snapshot). */
  doc(): ProseNode
  /** The current document serialised as markdown, as a save would write it. */
  markdown(): string
  /** Run a native menu command, as the shell's menu bar does. */
  menu(command: MenuCommand, argument?: string): void
  /** Tear the app down; call it from `afterEach`. */
  dispose(): void
}

export interface BootOptions {
  /** The preference snapshot the shell would inject before the bundle runs. */
  preferences?: Partial<Record<PreferenceName, unknown>>
}

export function bootApp(options: BootOptions = {}): BootedApp {
  fakeBridge.reset()
  window.ediPreferences = { ...(options.preferences ?? {}) }
  resetState()
  resetPreferences()
  document.body.innerHTML = appMarkup()
  const dispose = init(rootsFromDocument())

  const app = document.querySelector<HTMLElement>('#app')!
  const editorElement = (): HTMLElement =>
    document.querySelector<HTMLElement>('#editor-container .ProseMirror')!
  const doc = (): ProseNode =>
    (editorElement() as HTMLElement & { pmViewDesc: { node: ProseNode } }).pmViewDesc.node
  return {
    bridge: fakeBridge,
    get editor() {
      return editorElement()
    },
    async setDocument(markdown) {
      window.ediSetContent!(markdown)
      await waitFor(() => app.dataset.view === 'editor')
      await settle()
    },
    doc,
    markdown: () => proseToMarkdown(doc()),
    menu(command, argument) {
      window.ediMenuCommand!(command, argument)
    },
    dispose() {
      dispose()
      document.body.innerHTML = ''
      delete window.ediPreferences
    },
  }
}

// --- Geometry and input ------------------------------------------------------

export interface Point {
  x: number
  y: number
}

/** The centre of `element`'s box, in viewport coordinates. */
export function center(element: Element): Point {
  const r = element.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

export interface PressOptions {
  button?: 'left' | 'right' | 'middle'
  /** Modifier keys held across the press, e.g. `['Alt']` or `['Shift']`. */
  modifiers?: string[]
}

/**
 * Trusted mouse input at viewport coordinates (see `tests/browser/commands.ts`).
 *
 * Use `userEvent` when a locator or element is enough; use these when the
 * test is about *where* the pointer is (a gutter, the gap beside a table, a
 * band edge) or a drag has to be inspected before it is released.
 */
export const pointer = {
  /** Move the mouse to `at`, in `steps` intermediate moves. */
  async move(at: Point, steps = 1): Promise<void> {
    await commands.input([{ type: 'move', x: at.x, y: at.y, steps }])
  },

  /** A full click at `at`. */
  async press(at: Point, options: PressOptions = {}): Promise<void> {
    const modifiers = options.modifiers ?? []
    const button = options.button ?? 'left'
    await commands.input([
      ...modifiers.map((key): InputStep => ({ type: 'keyDown', key })),
      { type: 'move', x: at.x, y: at.y },
      { type: 'down', button },
      { type: 'up', button },
      ...modifiers.map((key): InputStep => ({ type: 'keyUp', key })),
    ])
  },

  /** Press at `from` and move to `to`, but do not release: call `release`. */
  async startDrag(from: Point, to: Point, steps = 12): Promise<void> {
    await commands.input([
      { type: 'move', x: from.x, y: from.y },
      { type: 'down' },
      // A few small moves first, so a drag threshold is crossed the way a hand
      // crosses it rather than in one jump.
      { type: 'move', x: from.x + 3, y: from.y + 3, steps: 3 },
      { type: 'move', x: to.x, y: to.y, steps },
    ])
  },

  /** Move a held drag on to `to`. */
  async dragTo(to: Point, steps = 8): Promise<void> {
    await commands.input([{ type: 'move', x: to.x, y: to.y, steps }])
  },

  async release(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await commands.input([{ type: 'up', button }])
  },

  /** A whole drag, released at `to`. */
  async drag(from: Point, to: Point, steps = 12): Promise<void> {
    await pointer.startDrag(from, to, steps)
    await pointer.release()
  },

  async wheel(dy: number, dx = 0): Promise<void> {
    await commands.input([{ type: 'wheel', dx, dy }])
  },
}

/**
 * Wait until the page has run what the last input queued behind it: two
 * animation frames, then a short timer (the window suite's `_settle`).
 */
export async function settle(): Promise<void> {
  await nextFrames(2)
  await new Promise((resolve) => setTimeout(resolve, 50))
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
