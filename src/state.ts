export interface SessionMeta {
  id: string
  path: string | null
  dirty: boolean
}

export interface StateSnapshot {
  sessions: SessionMeta[]
  activeId: string
}

type Listener = (state: StateSnapshot) => void

const listeners = new Set<Listener>()

const sessions: SessionMeta[] = []
const activeId = { value: '' }
const nextId = { value: 1 }

export function getState(): StateSnapshot {
  return { sessions: sessions.map((session) => ({ ...session })), activeId: activeId.value }
}

export function getActive(): SessionMeta | undefined {
  return sessions.find((session) => session.id === activeId.value)
}

export function findSessionByPath(path: string): SessionMeta | undefined {
  return sessions.find((session) => session.path === path)
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function createSession(): string {
  const id = `tab-${nextId.value++}`
  sessions.push({ id, path: null, dirty: false })
  activeId.value = id
  emit()
  return id
}

export function activateSession(id: string): boolean {
  const session = sessions.find((entry) => entry.id === id)
  if (!session) {
    return false
  }
  activeId.value = id
  emit()
  return true
}

export function closeSession(id: string): string | null {
  const index = sessions.findIndex((session) => session.id === id)
  if (index < 0) {
    return null
  }
  sessions.splice(index, 1)
  if (sessions.length === 0) {
    activeId.value = ''
    emit()
    return null
  }
  if (activeId.value === id) {
    activeId.value = sessions[Math.max(0, index - 1)]!.id
  }
  emit()
  return activeId.value
}

export function setActivePath(path: string | null): void {
  const active = getActive()
  if (active) {
    active.path = path
    emit()
  }
}

export function setActiveDirty(dirty: boolean): void {
  const active = getActive()
  if (active && active.dirty !== dirty) {
    active.dirty = dirty
    emit()
  }
}

export function isAnyDirty(): boolean {
  return sessions.some((session) => session.dirty)
}

function emit(): void {
  const snapshot = getState()
  for (const listener of listeners) {
    listener(snapshot)
  }
}

/**
 * Remove every session and reset the id sequence. Tests boot the app more than
 * once in a process; production boots it once and never calls this.
 */
export function resetState(): void {
  sessions.length = 0
  activeId.value = ''
  nextId.value = 1
}
