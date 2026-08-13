import { describe, expect, it } from 'vitest'

import { fileExtension, fileName, isAbsolutePath, isSupportedFile, UNTITLED } from './files'

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

describe('UNTITLED', () => {
  it('is the untitled placeholder', () => {
    expect(UNTITLED).toBe('Untitled')
  })
})
