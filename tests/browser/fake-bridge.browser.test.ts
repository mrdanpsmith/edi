// The fake shell itself: replies must reach the page.
//
// `src/bridge.ts` connects its reply listener the moment it loads, so a fake
// installed too late records calls but never answers them, and every awaited
// bridge call (confirm, paste, file pickers) hangs. These pin that it answers.

import { invoke, confirmAction } from '../../src/bridge'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { bootApp, type BootedApp } from './app'

let app: BootedApp

beforeEach(() => {
  app = bootApp()
})

afterEach(() => app.dispose())

it('answers a call with the default reply', async () => {
  await expect(invoke('ping')).resolves.toBe('pong')
})

it('answers with what a test told it to', async () => {
  app.bridge.answer('confirm', () => false)
  await expect(confirmAction('Sure?')).resolves.toBe(false)
  expect(app.bridge.callsTo('confirm')).toEqual([
    { method: 'confirm', payload: { message: 'Sure?' } },
  ])
})

it('turns a thrown answer into a failed call', async () => {
  app.bridge.answer('readTextFile', () => {
    throw new Error('no such file')
  })
  await expect(invoke('readTextFile', { path: '/nope.md' })).rejects.toThrow('no such file')
})

it('forgets a test’s answers before the next test', async () => {
  // The previous test answered `confirm` with false; bootApp reset it.
  await expect(confirmAction('Again?')).resolves.toBe(true)
})
