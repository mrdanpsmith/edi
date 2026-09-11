import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addRecentFile, getRecentFiles } from './recents'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('./bridge', () => ({
  hasBridge: () => false,
  invoke: invokeMock,
}))

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined)
})

describe('recent files bridge wrappers', () => {
  it('delegates getRecentFiles to invoke even before the bridge is ready', async () => {
    // hasBridge() is false while the QWebChannel is still connecting during
    // page load; the wrapper must still call invoke() so it can await the
    // channel instead of short-circuiting to an empty list forever.
    invokeMock.mockResolvedValue(['/a.md', '/b.md'])
    await expect(getRecentFiles()).resolves.toEqual(['/a.md', '/b.md'])
    expect(invokeMock).toHaveBeenCalledWith('getRecentFiles', {})
  })

  it('delegates addRecentFile to invoke', async () => {
    await addRecentFile('/x.md')
    expect(invokeMock).toHaveBeenCalledWith('addRecentFile', { path: '/x.md' })
  })

  it('propagates missing-bridge errors to callers', async () => {
    invokeMock.mockRejectedValue(new Error('Native shell bridge is not available'))
    await expect(addRecentFile('/x.md')).rejects.toThrow('bridge is not available')
  })
})