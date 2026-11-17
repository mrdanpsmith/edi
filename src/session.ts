import { invoke } from './bridge'
import { getState, subscribe, type StateSnapshot } from './state'

/**
 * The documents open in the window, kept by the shell so the next launch
 * reopens them (`backend/session.py`). Only documents with a path count; an
 * untitled tab has nothing to reopen.
 */
export interface StoredSession {
  paths: string[]
  active: string | null
}

export async function getSession(): Promise<StoredSession> {
  return invoke<StoredSession>('getSession', {})
}

export async function setOpenFiles(paths: string[], active: string | null): Promise<void> {
  await invoke('setOpenFiles', { paths, active })
}

function openFiles(state: StateSnapshot): StoredSession {
  const paths = state.sessions.flatMap((session) => (session.path ? [session.path] : []))
  const active = state.sessions.find((session) => session.id === state.activeId)?.path ?? null
  return { paths, active }
}

/**
 * Tell the shell the open documents now and whenever they change (a tab
 * opened, closed, switched to, saved under a new name). Written at once rather
 * than at quit, so a crash keeps them too. Start it only once the last
 * session has been reopened, or a half-done restore would be stored over it.
 */
export function trackOpenFiles(send = setOpenFiles): () => void {
  let last = ''
  const sync = (state: StateSnapshot): void => {
    const { paths, active } = openFiles(state)
    const key = JSON.stringify([paths, active])
    if (key === last) return
    last = key
    // No shell (plain `vite dev`): nothing to keep them.
    send(paths, active).catch(() => undefined)
  }
  sync(getState())
  return subscribe(sync)
}
