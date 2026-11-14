import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./files')>()),
  readTextFile: vi.fn(),
}))

import { readTextFile } from './files'
import { createDiskController, openCompareDialog } from './diskChanges'
import {
  createSession,
  getActive,
  getState,
  resetState,
  setActiveDirty,
  setActivePath,
} from './state'
import type { AppContext } from './appContext'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeContext() {
  const workspace = document.createElement('main')
  const editorContainer = document.createElement('section')
  workspace.append(editorContainer)
  const statusbar = document.createElement('footer')
  const statusLeft = document.createElement('span')
  statusbar.append(statusLeft)
  document.body.append(workspace, statusbar)
  let markdown = 'mine\n'
  const blockEditor = {
    flushReveals: vi.fn(async () => undefined),
    getMarkdown: vi.fn(() => markdown),
    replaceMarkdown: vi.fn((text: string) => {
      markdown = text
    }),
    markSavedPoint: vi.fn(),
    getView: () => ({ state: { doc: {} } }),
  }
  const ctx = {
    roots: { editorContainer, statusLeft },
    blockEditor,
    updateTitle: vi.fn(),
    syncDirty: vi.fn(),
    flashStatus: vi.fn(),
  } as unknown as AppContext
  return { ctx, blockEditor }
}

const bar = () => document.querySelector('.edi-disk-bar')
const barButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.edi-disk-bar button')]
const clickBar = (label: string) => barButtons().find((b) => b.textContent === label)!.click()

beforeEach(() => {
  resetState()
  vi.mocked(readTextFile).mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
})

function openTab(path: string, dirty = false): void {
  createSession()
  setActivePath(path)
  if (dirty) setActiveDirty(true)
}

describe('a document changed on disk', () => {
  it('reloads a tab with no unsaved edits, as an undoable edit, and says so', async () => {
    const { ctx, blockEditor } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md')
    disk.noteDiskText('/docs/a.md', 'mine\n')
    vi.mocked(readTextFile).mockResolvedValue('theirs\n')

    disk.onEvent('diskChanged', '/docs/a.md')
    await flush()

    expect(blockEditor.replaceMarkdown).toHaveBeenCalledWith('theirs\n')
    expect(blockEditor.markSavedPoint).toHaveBeenCalled()
    expect(getActive()!.dirty).toBe(false)
    expect(bar()).toBeNull()
    expect(ctx.flashStatus).toHaveBeenCalledWith('Reloaded a.md: changed on disk')
  })

  it('asks instead when the tab has unsaved edits', async () => {
    const { ctx, blockEditor } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md', true)
    disk.noteDiskText('/docs/a.md', 'base\n')

    disk.onEvent('diskChanged', '/docs/a.md')

    expect(bar()!.textContent).toContain('a.md was changed on disk while you were editing it.')
    expect(barButtons().map((b) => b.textContent)).toEqual(['Compare…', 'Take theirs', 'Keep mine'])
    expect(blockEditor.replaceMarkdown).not.toHaveBeenCalled()
    expect(readTextFile).not.toHaveBeenCalled()
  })

  it('Keep mine reads the disk (so the shell knows it was seen) and keeps the edits', async () => {
    const { ctx, blockEditor } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md', true)
    disk.onEvent('diskChanged', '/docs/a.md')
    vi.mocked(readTextFile).mockResolvedValue('theirs\n')

    clickBar('Keep mine')
    await flush()

    expect(readTextFile).toHaveBeenCalledWith('/docs/a.md')
    expect(blockEditor.replaceMarkdown).not.toHaveBeenCalled()
    expect(getActive()!.dirty).toBe(true)
    expect(bar()).toBeNull()
  })

  it('Take theirs replaces the edits with the disk text and leaves the tab clean', async () => {
    const { ctx, blockEditor } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md', true)
    disk.onEvent('diskChanged', '/docs/a.md')
    vi.mocked(readTextFile).mockResolvedValue('theirs\n')

    clickBar('Take theirs')
    await flush()

    expect(blockEditor.replaceMarkdown).toHaveBeenCalledWith('theirs\n')
    expect(getActive()!.dirty).toBe(false)
    expect(bar()).toBeNull()
  })

  it('waits for a tab out of view until it is shown again', async () => {
    const { ctx, blockEditor } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/other.md')
    disk.onEvent('diskChanged', '/docs/a.md')
    await flush()
    expect(readTextFile).not.toHaveBeenCalled()

    openTab('/docs/a.md')
    vi.mocked(readTextFile).mockResolvedValue('theirs\n')
    disk.refresh()
    await flush()
    expect(blockEditor.replaceMarkdown).toHaveBeenCalledWith('theirs\n')
  })

  it('a refused save raises the bar instead of an error', () => {
    const { ctx } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md', true)
    disk.saveRefused('/docs/a.md')
    expect(bar()).not.toBeNull()
    expect(ctx.flashStatus).toHaveBeenCalledWith('Not saved: a.md changed on disk')
  })

  it('a deleted file says so and can be dismissed', () => {
    const { ctx } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md')
    disk.onEvent('diskDeleted', '/docs/a.md')
    expect(bar()!.textContent).toContain('deleted or moved on disk')
    clickBar('Dismiss')
    expect(bar()).toBeNull()
  })

  it('Compare shows each side against the base, and its choice is carried out', async () => {
    const { ctx, blockEditor } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md', true)
    disk.noteDiskText('/docs/a.md', 'base\n')
    disk.onEvent('diskChanged', '/docs/a.md')
    vi.mocked(readTextFile).mockResolvedValue('theirs\n')

    clickBar('Compare…')
    await flush()
    await flush()
    const panes = [...document.querySelectorAll('.edi-compare-pane')]
    expect(panes.map((p) => p.querySelector('.edi-dialog-label')!.textContent)).toEqual([
      'Their changes (on disk, since you opened it)',
      'Your unsaved changes',
    ])
    expect(panes[0]!.querySelector('.edi-history-added')!.textContent).toBe('+ theirs')
    expect(panes[1]!.querySelector('.edi-history-added')!.textContent).toBe('+ mine')

    const take = [...document.querySelectorAll<HTMLButtonElement>('.edi-compare-dialog button')].find(
      (b) => b.textContent === 'Take theirs',
    )!
    take.click()
    await flush()
    expect(blockEditor.replaceMarkdown).toHaveBeenCalledWith('theirs\n')
    // The file was read once, for the dialog; the choice used that text.
    expect(readTextFile).toHaveBeenCalledTimes(1)
  })

  it('reloads a Mermaid file as its one diagram', async () => {
    const { ctx, blockEditor } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/flow.mmd')
    disk.noteDiskText('/docs/flow.mmd', 'mine\n')
    vi.mocked(readTextFile).mockResolvedValue('graph TD\n')

    disk.onEvent('diskChanged', '/docs/flow.mmd')
    await flush()

    expect(blockEditor.replaceMarkdown).toHaveBeenCalledWith('```mermaid\ngraph TD\n```\n')
  })

  it('compares a Mermaid file as the bare source it writes', async () => {
    const { ctx, blockEditor } = fakeContext()
    blockEditor.replaceMarkdown('```mermaid\ngraph LR\n```\n')
    blockEditor.replaceMarkdown.mockClear()
    const disk = createDiskController(ctx)
    openTab('/docs/flow.mmd', true)
    disk.noteDiskText('/docs/flow.mmd', 'graph TD\n')
    disk.onEvent('diskChanged', '/docs/flow.mmd')
    vi.mocked(readTextFile).mockResolvedValue('graph BT\n')

    clickBar('Compare…')
    await flush()
    await flush()
    const mine = document.querySelector('.edi-compare-mine')!
    expect(mine.querySelector('.edi-history-added')!.textContent).toBe('+ graph LR')
    expect(mine.textContent).not.toContain('```')
  })
})

describe('the changed-on-disk marker', () => {
  const statusNote = () => document.querySelector<HTMLButtonElement>('.status-disk')!

  it('marks a tab out of view, and counts each change', () => {
    const { ctx } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md')
    const a = getActive()!.id
    openTab('/docs/b.md')

    disk.onEvent('diskChanged', '/docs/a.md')
    disk.onEvent('diskChanged', '/docs/a.md')

    const note = getState().sessions.find((s) => s.id === a)!.diskNote!
    expect(note).toMatchObject({ kind: 'changed', count: 2 })
    // Only the tab in view has its note in the status bar.
    expect(statusNote().hidden).toBe(true)
  })

  it('survives the reload it caused, and shows in the status bar', async () => {
    const { ctx, blockEditor } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md')
    // The editor reports its own rewrite as an edit, as the real one does.
    blockEditor.replaceMarkdown.mockImplementation(() => disk.edited())
    vi.mocked(readTextFile).mockResolvedValue('theirs\n')

    disk.onEvent('diskChanged', '/docs/a.md')
    await flush()

    expect(getActive()!.diskNote).toMatchObject({ kind: 'changed', count: 1 })
    expect(statusNote().hidden).toBe(false)
    expect(statusNote().textContent).toMatch(/^Changed on disk at /)
  })

  it('clears when the reader edits', () => {
    const { ctx } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md', true)
    disk.onEvent('diskChanged', '/docs/a.md')
    disk.edited()
    expect(getActive()!.diskNote).toBeNull()
    expect(statusNote().hidden).toBe(true)
  })

  it('clears on a click in the status bar, on a save, and on a choice', async () => {
    const { ctx } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md', true)

    disk.onEvent('diskChanged', '/docs/a.md')
    statusNote().click()
    expect(getActive()!.diskNote).toBeNull()

    disk.onEvent('diskChanged', '/docs/a.md')
    disk.noteDiskText('/docs/a.md', 'saved\n')
    expect(getActive()!.diskNote).toBeNull()

    disk.onEvent('diskChanged', '/docs/a.md')
    vi.mocked(readTextFile).mockResolvedValue('theirs\n')
    clickBar('Keep mine')
    await flush()
    expect(getActive()!.diskNote).toBeNull()
  })

  it('says deleted for a deleted file', () => {
    const { ctx } = fakeContext()
    const disk = createDiskController(ctx)
    openTab('/docs/a.md')
    disk.onEvent('diskDeleted', '/docs/a.md')
    expect(statusNote().textContent).toMatch(/^Deleted on disk at /)
  })
})

describe('openCompareDialog', () => {
  it('without a base shows one diff, from yours to the disk', async () => {
    const promise = openCompareDialog({ name: 'a.md', base: null, mine: 'mine\n', theirs: 'theirs\n' })
    expect(document.querySelectorAll('.edi-compare-pane')).toHaveLength(1)
    document
      .querySelector('.edi-compare-dialog')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect(promise).resolves.toBeNull()
  })
})
