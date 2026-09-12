interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export interface BridgeObject {
  invoke: (method: string, requestId: number, payload: string) => void
  result: {
    connect: (callback: (payload: string) => void) => void
  }
  stream?: {
    connect: (callback: (payload: string) => void) => void
  }
  notify?: {
    connect: (callback: (payload: string) => void) => void
  }
}

export interface StreamEvent {
  id: number
  kind: 'output' | 'done'
  stream?: 'stdout' | 'stderr'
  text?: string
  ok?: boolean
}

export interface StreamHandle<T> {
  /** The id shared by the request/response and the stream events. */
  id: number
  /** Resolves with the final CodeResult when the run finishes. */
  result: Promise<T>
  /** Register a callback for each streamed chunk. */
  onChunk: (callback: (event: StreamEvent) => void) => void
  /** Release the stream routing. */
  dispose: () => void
}

declare global {
  interface Window {
    qt?: { webChannelTransport: unknown }
    bridge?: BridgeObject
    QWebChannel?: new (
      transport: unknown,
      callback: (channel: { objects: { bridge: BridgeObject } }) => void,
    ) => unknown
    ediMenuCommand?: (command: string) => void
    ediSetContent?: (markdown: string) => void
  }
}

let requestId = 0
const pending = new Map<number, PendingRequest>()
const streamHandlers = new Map<number, (event: StreamEvent) => void>()
let channelPromise: Promise<void> | null = null

function connectResult(bridge: BridgeObject): void {
  bridge.result.connect((payload) => {
    let message: { id: number; ok: boolean; data?: unknown; error?: string }
    try {
      message = JSON.parse(payload) as { id: number; ok: boolean; data?: unknown; error?: string }
    } catch {
      return
    }
    const entry = pending.get(message.id)
    if (!entry) {
      return
    }
    pending.delete(message.id)
    if (message.ok) {
      entry.resolve(message.data)
    } else {
      entry.reject(new Error(message.error ?? 'Bridge call failed'))
    }
  })
  bridge.stream?.connect((payload) => {
    let event: StreamEvent
    try {
      event = JSON.parse(payload) as StreamEvent
    } catch {
      return
    }
    const handler = streamHandlers.get(event.id)
    if (handler) {
      handler(event)
    }
  })
}

function ensureChannel(): Promise<void> {
  if (channelPromise) {
    return channelPromise
  }
  channelPromise = new Promise<void>((resolve) => {
    if (window.bridge) {
      connectResult(window.bridge)
      resolve()
      return
    }
    const { qt, QWebChannel } = window
    if (!qt?.webChannelTransport || typeof QWebChannel !== 'function') {
      resolve()
      return
    }
    new QWebChannel(qt.webChannelTransport, (channel) => {
      window.bridge = channel.objects.bridge
      connectResult(window.bridge as BridgeObject)
      resolve()
    })
  })
  return channelPromise
}

export function hasBridge(): boolean {
  return Boolean(window.bridge)
}

export function onBridgeReady(callback: (bridge: BridgeObject | undefined) => void): void {
  void ensureChannel().then(() => callback(window.bridge))
}

export async function invoke<T = unknown>(
  method: string,
  payload: unknown = {},
  explicitId?: number,
): Promise<T> {
  await ensureChannel()
  const bridge = window.bridge
  if (!bridge) {
    throw new Error('Native shell bridge is not available')
  }
  const id = explicitId ?? ++requestId
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    bridge.invoke(method, id, JSON.stringify(payload ?? {}))
  })
}

/**
 * Invoke a native call whose result arrives both as the normal request/response
 * on ``result`` *and* as incremental chunks on the ``stream`` signal. The run
 * id is shared by both channels so chunks route to the right caller.
 */
export function invokeStream<T = unknown>(
  method: string,
  payload: unknown = {},
): StreamHandle<T> {
  const id = ++requestId
  const callbacks = new Set<(event: StreamEvent) => void>()
  streamHandlers.set(id, (event) => {
    callbacks.forEach((callback) => callback(event))
  })
  const result = invoke<T>(method, payload, id)
  const dispose = (): void => {
    streamHandlers.delete(id)
    callbacks.clear()
  }
  result.finally(dispose).catch(() => undefined)
  return {
    id,
    result,
    onChunk: (callback) => {
      callbacks.add(callback)
    },
    dispose,
  }
}

export function confirmAction(message: string): Promise<boolean> {
  if (hasBridge()) {
    return invoke<boolean>('confirm', { message })
  }
  return Promise.resolve(window.confirm(message))
}

export async function showError(message: string): Promise<void> {
  if (hasBridge()) {
    await invoke('alert', { message })
    return
  }
  window.alert(message)
}

void ensureChannel()
