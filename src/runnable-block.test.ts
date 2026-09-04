import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { invoke, invokeStream } from './bridge'

// Replace the bridge invoke so the node view's run() resolves without any
// real QWebChannel. We assert on the arguments and return a known result.
vi.mock('./bridge', () => ({
  invoke: vi.fn(),
  invokeStream: vi.fn(),
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
import { createBlockEditor } from './editor'

const invokeMock = invoke as ReturnType<typeof vi.fn>
const invokeStreamMock = invokeStream as ReturnType<typeof vi.fn>

function timingSafeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((r, j) => {
    resolve = r
    reject = j
  })
  return { promise, resolve, reject }
}

function streamHandle(result: unknown) {
  const callbacks = new Set<(event: Record<string, unknown>) => void>()
  const deferred = timingSafeDeferred<unknown>()
  return {
    id: 1,
    result: deferred.promise,
    onChunk: vi.fn((callback) => callbacks.add(callback)),
    dispose: vi.fn(),
    _emit: (event: Record<string, unknown>) => callbacks.forEach((cb) => cb(event)),
    _finish: () => deferred.resolve(result),
  }
}

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
    invokeStreamMock.mockReset()
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

  it('streams output progressively and shows the final result', async () => {
    const handle = streamHandle({
      exitCode: 0,
      stdout: 'Hello, World!\n',
      stderr: '',
      timedOut: false,
    })
    invokeStreamMock.mockReturnValue(handle)

    const view = makeView('```\n#!/usr/bin/env python3\nprint("Hello, World!")\n```')
    const btn = view.dom.querySelector('.exec-run') as HTMLButtonElement
    expect(btn).toBeTruthy()
    btn.click()

    expect(invokeStreamMock).toHaveBeenCalledTimes(1)
    const [method, args] = invokeStreamMock.mock.calls[0] as [string, unknown]
    expect(method).toBe('streamCodeBlock')
    expect(args).toEqual({ shebang: '#!/usr/bin/env python3', source: 'print("Hello, World!")' })

    const out = view.dom.querySelector('.exec-output') as HTMLElement
    expect(out.hidden).toBe(false)

    // Button flips to Stop while running.
    expect(btn.textContent).toBe('Stop')
    expect(btn.classList.contains('exec-stop')).toBe(true)

    // Output appears incrementally as chunks arrive, before the result resolves.
    handle._emit({ id: handle.id, kind: 'output', stream: 'stdout', text: 'Hello, Wo' })
    expect(out.textContent).toBe('Hello, Wo')
    handle._emit({ id: handle.id, kind: 'output', stream: 'stdout', text: 'rld!\n' })
    expect(out.textContent).toBe('Hello, World!\n')

    handle._finish()
    await new Promise((r) => setTimeout(r, 0))

    expect(btn.textContent).toBe('Run')
    expect(btn.classList.contains('exec-stop')).toBe(false)
    expect(out.hidden).toBe(false)
    expect(out.textContent.trim()).toBe('Hello, World!')
    expect(out.classList.contains('exec-error')).toBe(false)

    view.destroy()
  })

  it('requests a stop and marks the run stopped when Stop is clicked', async () => {
    const handle = streamHandle({ exitCode: null, stdout: 'partial', stderr: '', timedOut: false })
    invokeStreamMock.mockReturnValue(handle)
    invokeMock.mockResolvedValue(null)

    const view = makeView('```\n#!/bin/sh\necho hi\n```')
    const btn = view.dom.querySelector('.exec-run') as HTMLButtonElement
    btn.click()

    expect(btn.textContent).toBe('Stop')
    btn.click()

    expect(invokeMock).toHaveBeenCalledWith('stopCodeBlock', { id: handle.id })
    const out = view.dom.querySelector('.exec-output') as HTMLElement

    // The backend kills the process and sends a stopped result.
    handle._emit({ id: handle.id, kind: 'done', ok: true })
    handle._finish()
    await new Promise((r) => setTimeout(r, 0))

    expect(btn.textContent).toBe('Run')
    expect(out.textContent).toContain('Process stopped')

    view.destroy()
  })

  it('shows an error output when the stream carries stderr', async () => {
    const handle = streamHandle({
      exitCode: 1,
      stdout: '',
      stderr: 'boom\n',
      timedOut: false,
    })
    invokeStreamMock.mockReturnValue(handle)

    const view = makeView('```\n#!/bin/sh\ncat /nonexistent\n```')
    const btn = view.dom.querySelector('.exec-run') as HTMLButtonElement
    btn.click()

    const out = view.dom.querySelector('.exec-output') as HTMLElement
    handle._emit({ id: handle.id, kind: 'output', stream: 'stderr', text: 'boom\n' })
    expect(out.classList.contains('exec-error')).toBe(true)

    handle._finish()
    await new Promise((r) => setTimeout(r, 0))

    expect(out.classList.contains('exec-error')).toBe(true)
    expect(out.textContent).toContain('exited with code 1')

    view.destroy()
  })

  it('does not inherit a previous document\'s result after switching documents', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editor = createBlockEditor(host, '')

    const docA =
      '```\n#!/usr/bin/env python3\nprint("Hello from Python!")\n```'
    const docB =
      '```\n#!/usr/bin/env python3\nfrom time import sleep\nprint("1")\nprint("2")\n```'

    // Load document A and run it.
    editor.setMarkdown(docA)
    const handleA = streamHandle({
      exitCode: 0,
      stdout: 'Hello from Python!\n',
      stderr: '',
      timedOut: false,
    })
    invokeStreamMock.mockReturnValueOnce(handleA)
    ;(host.querySelector('.exec-run') as HTMLButtonElement).click()
    handleA._emit({ id: handleA.id, kind: 'output', stream: 'stdout', text: 'Hello from Python!\n' })
    handleA._finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(host.querySelector('.exec-output')?.textContent).toContain('Hello from Python!')

    // Switch to a persisted document B whose block shares the shebang but has a
    // different body. The result cell must NOT follow it across the swap.
    editor.setMarkdown(docB)
    const outB = host.querySelector('.exec-output') as HTMLElement
    expect(outB.hidden).toBe(true)
    expect(outB.textContent).toBe('')

    // Running document B executes and shows only its own output.
    const handleB = streamHandle({
      exitCode: 0,
      stdout: '1\n2\n',
      stderr: '',
      timedOut: false,
    })
    invokeStreamMock.mockReturnValueOnce(handleB)
    ;(host.querySelector('.exec-run') as HTMLButtonElement).click()
    handleB._emit({ id: handleB.id, kind: 'output', stream: 'stdout', text: '1\n' })
    handleB._emit({ id: handleB.id, kind: 'output', stream: 'stdout', text: '2\n' })
    handleB._finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(outB.textContent).toContain('1')
    expect(outB.textContent).toContain('2')
    expect(outB.textContent).not.toContain('Hello from Python!')

    editor.destroy()
  })

  it('stops the backend process when switching documents mid-run', async () => {
    invokeMock.mockResolvedValue(undefined)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editor = createBlockEditor(host, '')

    const docA =
      '```\n#!/usr/bin/env python3\nimport time\nwhile True:\n    time.sleep(1)\n```'
    const docB =
      '```\n#!/usr/bin/env python3\nprint("another document")\n```'

    editor.setMarkdown(docA)
    const handleA = streamHandle({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    })
    invokeStreamMock.mockReturnValueOnce(handleA)
    ;(host.querySelector('.exec-run') as HTMLButtonElement).click()
    expect(invokeStreamMock).toHaveBeenCalledTimes(1)

    // Switch tabs while the run is still pending. The in-flight run must be
    // cancelled on the backend so its child process does not keep running and
    // pile up alongside the next one.
    editor.setMarkdown(docB)
    expect(invokeMock).toHaveBeenCalledWith('stopCodeBlock', { id: handleA.id })

    // Let the orphaned run() continuation resolve; it must not crash or leave
    // stale output behind.
    handleA._finish()
    await new Promise((r) => setTimeout(r, 0))
    const outB = host.querySelector('.exec-output') as HTMLElement
    expect(outB.hidden).toBe(true)
    expect(outB.textContent).toBe('')

    editor.destroy()
  })

  it('executes fresh on every Run of the same block (no result cache)', async () => {
    const view = makeView('```\n#!/usr/bin/env python3\nprint("Hello, World!")\n```')
    const btn = view.dom.querySelector('.exec-run') as HTMLButtonElement

    // First run.
    const first = streamHandle({
      exitCode: 0,
      stdout: 'run one\n',
      stderr: '',
      timedOut: false,
    })
    invokeStreamMock.mockReturnValueOnce(first)
    btn.click()
    first._emit({ id: first.id, kind: 'output', stream: 'stdout', text: 'run one\n' })
    first._finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(btn.textContent).toBe('Run')

    // Second run of the identical block must invoke the backend again and
    // replace the output rather than showing the cached first result.
    const second = streamHandle({
      exitCode: 0,
      stdout: 'run two\n',
      stderr: '',
      timedOut: false,
    })
    invokeStreamMock.mockReturnValueOnce(second)
    btn.click()
    expect(invokeStreamMock).toHaveBeenCalledTimes(2)
    second._emit({ id: second.id, kind: 'output', stream: 'stdout', text: 'run two\n' })
    second._finish()
    await new Promise((r) => setTimeout(r, 0))
    const out = view.dom.querySelector('.exec-output') as HTMLElement
    expect(out.textContent).toContain('run two')
    expect(out.textContent).not.toContain('run one')

    view.destroy()
  })
})

describe('code block copy buttons', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeStreamMock.mockReset()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('adds a source copy button to runnable (shebang) code blocks', () => {
    const view = makeView('```\n#!/usr/bin/env python3\nprint(1)\n```')
    const btn = view.dom.querySelector('.code-copy-source') as HTMLButtonElement
    expect(btn).toBeTruthy()
    view.destroy()
  })

  it('adds a source copy button to plain (non-runnable) code blocks', () => {
    const view = makeView('```\nconsole.log("hi")\n```')
    const btn = view.dom.querySelector('.code-copy-source') as HTMLButtonElement
    expect(btn).toBeTruthy()
    view.destroy()
  })

  it('copies the full code block source to the clipboard via the bridge', async () => {
    invokeMock.mockResolvedValue(null)

    const view = makeView('```\nconsole.log("hi")\n```')
    const btn = view.dom.querySelector('.code-copy-source') as HTMLButtonElement
    btn.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(invokeMock).toHaveBeenCalledWith('copyText', { text: 'console.log("hi")' })
    expect(btn.textContent).toBe('Copied!')
    view.destroy()
  })

  it('copies the shebang source including the shebang line', async () => {
    invokeMock.mockResolvedValue(null)

    const view = makeView('```\n#!/usr/bin/env python3\nprint(1)\n```')
    const btn = view.dom.querySelector('.code-copy-source') as HTMLButtonElement
    btn.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(invokeMock).toHaveBeenCalledWith('copyText', { text: '#!/usr/bin/env python3\nprint(1)' })
    view.destroy()
  })

  it('copies the run output via the output copy button', async () => {
    invokeMock.mockResolvedValue(null)

    const handle = streamHandle({
      exitCode: 0,
      stdout: 'Hello out\n',
      stderr: '',
      timedOut: false,
    })
    invokeStreamMock.mockReturnValue(handle)

    const view = makeView('```\n#!/bin/sh\necho "Hello out"\n```')
    ;(view.dom.querySelector('.exec-run') as HTMLButtonElement).click()
    handle._emit({ id: handle.id, kind: 'output', stream: 'stdout', text: 'Hello out\n' })
    handle._finish()
    await new Promise((r) => setTimeout(r, 0))

    const outCopy = view.dom.querySelector('.exec-output-wrap .code-copy') as HTMLButtonElement
    expect(outCopy).toBeTruthy()
    invokeMock.mockClear()
    outCopy.click()
    await new Promise((r) => setTimeout(r, 0))

    expect(invokeMock).toHaveBeenCalledWith('copyText', { text: 'Hello out' })
    view.destroy()
  })
})
