import { beforeEach, describe, expect, it } from 'vitest'

import {
  activateSession,
  closeSession,
  createSession,
  getActive,
  getState,
  isAnyDirty,
  setActiveDirty,
  setActivePath,
  subscribe,
} from './state'

beforeEach(() => {
  const { sessions } = getState()
  for (const session of sessions) {
    closeSession(session.id)
  }
})

describe('state session store', () => {
  it('creates a session and makes it active', () => {
    const id = createSession()
    expect(getActive()?.id).toBe(id)
    expect(getState().sessions).toHaveLength(1)
  })

  it('generates unique ids', () => {
    createSession()
    createSession()
    expect(getState().sessions.map((session) => session.id)).toHaveLength(2)
  })

  it('activates an existing session', () => {
    const a = createSession()
    createSession()
    expect(activateSession(a)).toBe(true)
    expect(getActive()?.id).toBe(a)
    expect(activateSession('missing')).toBe(false)
  })

  it('closes the active session and picks the previous one', () => {
    const a = createSession()
    createSession()
    const next = closeSession(getActive()!.id)
    expect(next).toBe(a)
    expect(getActive()?.id).toBe(a)
  })

  it('returns null when the last session is closed', () => {
    createSession()
    expect(closeSession(getActive()!.id)).toBeNull()
    expect(getActive()).toBeUndefined()
  })

  it('tracks path and dirty per session', () => {
    const id = createSession()
    setActivePath('/tmp/a.md')
    setActiveDirty(true)
    expect(getState().sessions[0]).toMatchObject({ id, path: '/tmp/a.md', dirty: true })
  })

  it('reports dirty across sessions', () => {
    createSession()
    const second = createSession()
    expect(isAnyDirty()).toBe(false)
    setActiveDirty(true)
    expect(isAnyDirty()).toBe(true)
    activateSession(second)
    setActiveDirty(false)
    expect(isAnyDirty()).toBe(false)
  })

  it('notifies subscribers on changes and unsubscribes', () => {
    let count = 0
    const off = subscribe(() => count++)
    createSession()
    setActivePath('/tmp/x.md')
    off()
    createSession()
    expect(count).toBe(2)
  })
})
