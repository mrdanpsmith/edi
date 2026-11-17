import { beforeEach, describe, expect, it, vi } from 'vitest'

import { trackOpenFiles } from './session'
import { activateSession, closeSession, createSession, resetState, setActivePath } from './state'

beforeEach(() => {
  resetState()
})

describe('trackOpenFiles', () => {
  it('tells the shell the open documents now and on each change, and only on a change', () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const a = createSession()
    setActivePath('/docs/a.md')
    const stop = trackOpenFiles(send)
    expect(send).toHaveBeenLastCalledWith(['/docs/a.md'], '/docs/a.md')

    // An untitled tab has nothing to reopen, until it is saved.
    const b = createSession()
    expect(send).toHaveBeenLastCalledWith(['/docs/a.md'], null)
    setActivePath('/docs/b.md')
    expect(send).toHaveBeenLastCalledWith(['/docs/a.md', '/docs/b.md'], '/docs/b.md')

    activateSession(a)
    expect(send).toHaveBeenLastCalledWith(['/docs/a.md', '/docs/b.md'], '/docs/a.md')
    const calls = send.mock.calls.length
    activateSession(a)
    expect(send).toHaveBeenCalledTimes(calls)

    closeSession(b)
    expect(send).toHaveBeenLastCalledWith(['/docs/a.md'], '/docs/a.md')

    stop()
    closeSession(a)
    expect(send).toHaveBeenLastCalledWith(['/docs/a.md'], '/docs/a.md')
  })

  it('survives having no shell to tell', async () => {
    const send = vi.fn().mockRejectedValue(new Error('no bridge'))
    createSession()
    setActivePath('/docs/a.md')
    trackOpenFiles(send)
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
