import { describe, expect, it } from 'vitest'

import {
  dirname,
  fileExtension,
  fileName,
  imageReference,
  isAbsolutePath,
  isSupportedFile,
  UNTITLED,
} from './files'

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
