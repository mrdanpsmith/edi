import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  dirname,
  fileExtension,
  fileName,
  imageReference,
  isAbsolutePath,
  isSupportedFile,
  pickExportPath,
  pickImageImportPath,
  pickImportPath,
  pickOpenPath,
  pickSavePath,
  pickTextImportPath,
  readAnyTextFile,
  readTextFile,
  UNTITLED,
  writeTextFile,
} from './files'

vi.mock('./bridge', () => ({
  invoke: vi.fn(),
}))

import { invoke } from './bridge'

beforeEach(() => {
  vi.mocked(invoke).mockReset()
})

describe('bridge wrappers', () => {
  it('readTextFile passes the path to the bridge', async () => {
    vi.mocked(invoke).mockResolvedValue('hello')
    await expect(readTextFile('/tmp/a.md')).resolves.toBe('hello')
    expect(invoke).toHaveBeenCalledWith('readTextFile', { path: '/tmp/a.md' })
  })

  it('readAnyTextFile passes the path to the bridge', async () => {
    vi.mocked(invoke).mockResolvedValue('raw')
    await expect(readAnyTextFile('/tmp/a.log')).resolves.toBe('raw')
    expect(invoke).toHaveBeenCalledWith('readAnyTextFile', { path: '/tmp/a.log' })
  })

  it('writeTextFile passes the path and content to the bridge', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    await expect(writeTextFile('/tmp/a.md', 'body')).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('writeTextFile', { path: '/tmp/a.md', content: 'body' })
  })

  it('pickOpenPath resolves to null when the user cancels', async () => {
    vi.mocked(invoke).mockResolvedValue(null)
    await expect(pickOpenPath()).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledWith('pickOpenPath', {})
  })

  it('pickOpenPath resolves to a chosen path', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/notes.md')
    await expect(pickOpenPath()).resolves.toBe('/tmp/notes.md')
  })

  it('pickSavePath passes the default name', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/Untitled.md')
    await expect(pickSavePath('Untitled.md')).resolves.toBe('/tmp/Untitled.md')
    expect(invoke).toHaveBeenCalledWith('pickSavePath', { defaultName: 'Untitled.md' })
  })

  it('pickExportPath passes the default name', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/out.html')
    await expect(pickExportPath('out.html')).resolves.toBe('/tmp/out.html')
    expect(invoke).toHaveBeenCalledWith('pickExportPath', { defaultName: 'out.html' })
  })

  it('pickImportPath resolves a path', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/data.csv')
    await expect(pickImportPath()).resolves.toBe('/tmp/data.csv')
    expect(invoke).toHaveBeenCalledWith('pickImportPath', {})
  })

  it('pickTextImportPath resolves a path', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/data.txt')
    await expect(pickTextImportPath()).resolves.toBe('/tmp/data.txt')
    expect(invoke).toHaveBeenCalledWith('pickTextImportPath', {})
  })

  it('pickImageImportPath resolves a path', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/pic.png')
    await expect(pickImageImportPath()).resolves.toBe('/tmp/pic.png')
    expect(invoke).toHaveBeenCalledWith('pickImageImportPath', {})
  })
})

describe('fileExtension', () => {
  it('returns the lowercase extension', () => {
    expect(fileExtension('/home/user/notes.MD')).toBe('md')
  })

  it('returns empty string when there is no extension', () => {
    expect(fileExtension('/home/user/notes')).toBe('')
  })

  it('handles dotfiles', () => {
    expect(fileExtension('/home/user/.gitignore')).toBe('gitignore')
  })
})

describe('fileName', () => {
  it('strips the directory and extension', () => {
    expect(fileName('/home/user/notes.md')).toBe('notes')
  })

  it('keeps the name when there is no extension', () => {
    expect(fileName('README')).toBe('README')
  })
})

describe('isSupportedFile', () => {
  it('accepts supported markdown extensions', () => {
    expect(isSupportedFile('/tmp/a.md')).toBe(true)
    expect(isSupportedFile('/tmp/a.markdown')).toBe(true)
    expect(isSupportedFile('/tmp/a.mermaid')).toBe(true)
  })

  it('rejects unsupported extensions', () => {
    expect(isSupportedFile('/tmp/a.pdf')).toBe(false)
    expect(isSupportedFile('/tmp/a')).toBe(false)
  })
})

describe('isAbsolutePath', () => {
  it('detects absolute paths', () => {
    expect(isAbsolutePath('/tmp/a.md')).toBe(true)
    expect(isAbsolutePath('a.md')).toBe(false)
  })
})

describe('dirname', () => {
  it('returns the parent directory', () => {
    expect(dirname('/home/user/docs/notes.md')).toBe('/home/user/docs')
  })

  it('returns the root for a top-level path', () => {
    expect(dirname('/notes.md')).toBe('/')
  })
})

describe('imageReference', () => {
  it('uses a relative path when the image is inside the doc directory', () => {
    expect(imageReference('/docs/notes.md', '/docs/img/pic.png')).toBe('img/pic.png')
  })

  it('keeps the absolute path when the image is elsewhere', () => {
    expect(imageReference('/docs/notes.md', '/home/user/Pictures/pic.png')).toBe(
      '/home/user/Pictures/pic.png',
    )
  })

  it('keeps the absolute path for an unsaved document', () => {
    expect(imageReference(null, '/home/user/pic.png')).toBe('/home/user/pic.png')
  })
})

describe('UNTITLED', () => {
  it('is the untitled placeholder', () => {
    expect(UNTITLED).toBe('Untitled')
  })
})
