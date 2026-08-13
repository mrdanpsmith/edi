interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export interface BridgeObject {
  invoke: (method: string, requestId: number, payload: string) => void
  result: {
    connect: (callback: (payload: string) => void) => void
  }
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
  }
}

let requestId = 0
const pending = new Map<number, PendingRequest>()
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

export async function invoke<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
  await ensureChannel()
  const bridge = window.bridge
  if (!bridge) {
    throw new Error('Native shell bridge is not available')
  }
  const id = ++requestId
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    bridge.invoke(method, id, JSON.stringify(payload ?? {}))
  })
}

export function confirmAction(message: string): Promise<boolean> {
  if (hasBridge()) {
    return invoke<boolean>('confirm', { message })
  }
  return Promise.resolve(window.confirm(message))
}

void ensureChannel()
