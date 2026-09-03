import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BridgeObject } from './bridge'

type BridgeModule = typeof import('./bridge')

interface FakeBridge extends BridgeObject {
  invoke: ReturnType<typeof vi.fn<(method: string, requestId: number, payload: string) => void>>
  _fire: (payload: string) => void
  _fireStream: (payload: string) => void
}

function fakeBridge(): FakeBridge {
  const invoke = vi.fn()
  const handlers: ((payload: string) => void)[] = []
  const streamHandlers: ((payload: string) => void)[] = []
  return {
    invoke,
    result: {
      connect: (callback) => handlers.push(callback),
    },
    stream: {
      connect: (callback) => streamHandlers.push(callback),
    },
    _fire: (payload) => handlers.forEach((handler) => handler(payload)),
    _fireStream: (payload) => streamHandlers.forEach((handler) => handler(payload)),
  }
}

async function freshBridge(setup?: () => void): Promise<BridgeModule> {
  vi.resetModules()
  delete window.bridge
  delete window.qt
  delete window.QWebChannel
  setup?.()
  return import('./bridge')
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('bridge', () => {
  it('reports no native bridge by default', async () => {
    const bridge = await freshBridge()
    expect(bridge.hasBridge()).toBe(false)
  })

  it('invoke rejects when no bridge is available', async () => {
    const bridge = await freshBridge()
    await expect(bridge.invoke('ping')).rejects.toThrow('Native shell bridge is not available')
  })

  it('confirmAction falls back to window.confirm', async () => {
    const bridge = await freshBridge()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await expect(bridge.confirmAction('Continue?')).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith('Continue?')
  })

  it('invoke routes a request through a pre-attached bridge', async () => {
    const fake = fakeBridge()
    const bridge = await freshBridge(() => {
      window.bridge = fake
    })

    const promise = bridge.invoke<string>('ping', { now: 42 })
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalledTimes(1))
    const [method, id, payload] = fake.invoke.mock.calls[0] as [string, number, string]
    expect(method).toBe('ping')
    expect(typeof id).toBe('number')
    expect(JSON.parse(payload)).toEqual({ now: 42 })

    fake._fire(JSON.stringify({ id, ok: true, data: 'pong' }))
    await expect(promise).resolves.toBe('pong')
  })

  it('rejects when the bridge replies with an error', async () => {
    const fake = fakeBridge()
    const bridge = await freshBridge(() => {
      window.bridge = fake
    })

    const promise = bridge.invoke('save')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    const id = fake.invoke.mock.calls[0]![1]
    fake._fire(JSON.stringify({ id, ok: false, error: 'boom' }))
    await expect(promise).rejects.toThrow('boom')
  })

  it('rejects with a default message when the error is missing', async () => {
    const fake = fakeBridge()
    const bridge = await freshBridge(() => {
      window.bridge = fake
    })

    const promise = bridge.invoke('save')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    const id = fake.invoke.mock.calls[0]![1]
    fake._fire(JSON.stringify({ id, ok: false }))
    await expect(promise).rejects.toThrow('Bridge call failed')
  })

  it('ignores malformed payloads and unknown request ids', async () => {
    const fake = fakeBridge()
    const bridge = await freshBridge(() => {
      window.bridge = fake
    })

    const promise = bridge.invoke<string>('ping')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    const id = fake.invoke.mock.calls[0]![1]

    fake._fire('not json')
    fake._fire(JSON.stringify({ id: 999, ok: true, data: 1 }))

    fake._fire(JSON.stringify({ id, ok: true, data: 'done' }))
    await expect(promise).resolves.toBe('done')
  })

  it('dispatches replies to the matching request id', async () => {
    const fake = fakeBridge()
    const bridge = await freshBridge(() => {
      window.bridge = fake
    })

    const first = bridge.invoke<string>('a')
    const second = bridge.invoke<string>('b')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalledTimes(2))
    const idA = fake.invoke.mock.calls[0]![1]
    const idB = fake.invoke.mock.calls[1]![1]
    expect(idA).not.toBe(idB)

    fake._fire(JSON.stringify({ id: idA, ok: true, data: 'first' }))
    fake._fire(JSON.stringify({ id: idB, ok: true, data: 'second' }))
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })

  it('boots the bridge through QWebChannel when not pre-attached', async () => {
    const fake = fakeBridge()
    const initCallback = vi.fn()
    const bridge = await freshBridge(() => {
      window.QWebChannel = class {
        constructor(transport: unknown, callback: (channel: { objects: { bridge: BridgeObject } }) => void) {
          initCallback(transport)
          callback({ objects: { bridge: fake } })
        }
      }
      window.qt = { webChannelTransport: { marker: true } }
    })
    const promise = bridge.invoke<string>('ping', {})
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    expect(initCallback).toHaveBeenCalledWith({ marker: true })

    const id = fake.invoke.mock.calls[0]![1]
    fake._fire(JSON.stringify({ id, ok: true, data: 'ok' }))
    await expect(promise).resolves.toBe('ok')
  })

  it('confirmAction routes through the bridge when available', async () => {
    const fake = fakeBridge()
    const bridge = await freshBridge(() => {
      window.bridge = fake
    })

    const promise = bridge.confirmAction('Really?')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    expect(fake.invoke.mock.calls[0][0]).toBe('confirm')

    const id = fake.invoke.mock.calls[0]![1]
    fake._fire(JSON.stringify({ id, ok: true, data: false }))
    await expect(promise).resolves.toBe(false)
  })

  it('showError falls back to window.alert', async () => {
    const bridge = await freshBridge()
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    await bridge.showError('Something broke')
    expect(alert).toHaveBeenCalledWith('Something broke')
  })

  it('showError routes through the bridge when available', async () => {
    const fake = fakeBridge()
    const bridge = await freshBridge(() => {
      window.bridge = fake
    })

    const promise = bridge.showError('Something broke')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    expect(fake.invoke.mock.calls[0][0]).toBe('alert')

    const id = fake.invoke.mock.calls[0]![1]
    fake._fire(JSON.stringify({ id, ok: true, data: null }))
    await expect(promise).resolves.toBeUndefined()
  })

  it('invokeStream routes chunks by id and delivers the final result', async () => {
    const fake = fakeBridge()
    const bridge = await freshBridge(() => {
      window.bridge = fake
    })

    const stream = bridge.invokeStream<{ exitCode: number }>('streamCodeBlock', { shebang: '#!sh', source: 'echo hi' })
    const chunks: string[] = []
    stream.onChunk((event) => {
      if (event.kind === 'output' && event.text) chunks.push(event.text)
    })

    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    const id = fake.invoke.mock.calls[0]![1]
    expect(stream.id).toBe(id)

    fake._fireStream(JSON.stringify({ id, kind: 'output', stream: 'stdout', text: 'hi\n' }))
    fake._fireStream(JSON.stringify({ id, kind: 'output', stream: 'stderr', text: 'warn' }))
    fake._fire(JSON.stringify({ id, ok: true, data: { exitCode: 0 } }))

    await expect(stream.result).resolves.toEqual({ exitCode: 0 })
    expect(chunks).toEqual(['hi\n', 'warn'])
  })

  it('invokeStream drops chunks for an unknown id', async () => {
    const fake = fakeBridge()
    const bridge = await freshBridge(() => {
      window.bridge = fake
    })

    const stream = bridge.invokeStream<string>('streamCodeBlock', {})
    const chunks: string[] = []
    stream.onChunk((event) => {
      if (event.text) chunks.push(event.text)
    })

    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    // A chunk bearing a different id (e.g. a stale run) must not reach this handle.
    fake._fireStream(JSON.stringify({ id: 999, kind: 'output', stream: 'stdout', text: 'ignored' }))
    expect(chunks).toEqual([])

    const id = fake.invoke.mock.calls[0]![1]
    fake._fire(JSON.stringify({ id, ok: true, data: 'done' }))
    await expect(stream.result).resolves.toBe('done')
  })
})
