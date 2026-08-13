export interface DocState {
  path: string | null
  dirty: boolean
}

type Listener = (state: DocState) => void

const listeners = new Set<Listener>()

const state: DocState = {
  path: null,
  dirty: false,
}

export function getDocState(): DocState {
  return { ...state }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(): void {
  const snapshot = getDocState()
  for (const listener of listeners) {
    listener(snapshot)
  }
}

export function setPath(path: string | null): void {
  state.path = path
  emit()
}

export function setDirty(dirty: boolean): void {
  if (state.dirty !== dirty) {
    state.dirty = dirty
    emit()
  }
}
