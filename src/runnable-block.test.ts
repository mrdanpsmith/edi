import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { invoke } from './bridge'

// Replace the bridge invoke so the node view's run() resolves without any
// real QWebChannel. We assert on the arguments and return a known result.
vi.mock('./bridge', () => ({
  invoke: vi.fn(),
  hasBridge: () => true,
  confirmAction: vi.fn(),
}))

import { schema } from './schema'
import { markdownToProse } from './markdown'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Plugin } from 'prosemirror-state'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { codeBlockNodeViewPlugin } from './node/execblock'
import { blockPlugin } from './blockplugin'

const invokeMock = invoke as ReturnType<typeof vi.fn>

function makeView(md: string) {
  const doc = markdownToProse(md, schema)
  const generic = new Plugin({
    props: {
      nodeViews: Object.fromEntries(
        [...BLOCK_NODE_TYPES, 'source_block'].map((name) => [name, blockNodeView]),
      ),
    },
  })
  const view = new EditorView(document.body, {
    state: EditorState.create({
      doc,
      plugins: [blockPlugin, codeBlockNodeViewPlugin, generic],
    }),
  })
  return view
}

describe('runnable code block node view', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders a Run button only for a shebang code block', () => {
    const runnable = makeView('```\n#!/usr/bin/env python3\nprint(1)\n```')
    expect(runnable.dom.querySelector('.exec-run')).toBeTruthy()
    runnable.destroy()

    const plain = makeView('```js\nconsole.log(1)\n```')
    expect(plain.dom.querySelector('.exec-run')).toBeNull()
    plain.destroy()
  })

  it('shows the result cell after clicking Run', async () => {
    invokeMock.mockResolvedValue({
      exitCode: 0,
      stdout: 'Hello, World!\n',
      stderr: '',
      timedOut: false,
    })

    const view = makeView('```\n#!/usr/bin/env python3\nprint("Hello, World!")\n```')
    const btn = view.dom.querySelector('.exec-run') as HTMLButtonElement
    expect(btn).toBeTruthy()
    btn.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(invokeMock).toHaveBeenCalledTimes(1)
    const [method, args] = invokeMock.mock.calls[0] as [string, unknown]
    expect(method).toBe('runCodeBlock')
    expect(args).toEqual({ shebang: '#!/usr/bin/env python3', source: 'print("Hello, World!")' })

    const out = view.dom.querySelector('.exec-output') as HTMLElement
    expect(out.hidden).toBe(false)
    expect(out.textContent.trim()).toBe('Hello, World!')

    view.destroy()
  })
})
