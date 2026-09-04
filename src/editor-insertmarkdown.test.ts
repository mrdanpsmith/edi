import { describe, expect, it, beforeEach } from 'vitest'
import { createBlockEditor } from './editor'
import { proseToMarkdown } from './markdown'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('insertMarkdown', () => {
  it('parses an inserted image reference into an image node', () => {
    const editor = createBlockEditor(document.body, 'Hello world')
    const view = editor.getView()

    editor.insertMarkdown('\n![A cat](./images/cat.png)\n')

    let foundImage = false
    view.state.doc.forEach((node) => {
      node.forEach((child) => {
        if (child.type.name === 'image') foundImage = true
      })
    })
    expect(foundImage).toBe(true)
    expect(proseToMarkdown(view.state.doc)).toContain('![A cat](./images/cat.png)')
    editor.destroy()
  })

  it('parses an inserted table into a table node', () => {
    const editor = createBlockEditor(document.body, 'Hello world')
    const view = editor.getView()

    editor.insertMarkdown('\n| A | B |\n| - | - |\n| 1 | 2 |\n')

    let foundTable = false
    view.state.doc.forEach((node) => {
      if (node.type.name === 'table') foundTable = true
    })
    expect(foundTable).toBe(true)
    editor.destroy()
  })

  it('preserves existing content around the inserted markdown', () => {
    const editor = createBlockEditor(document.body, 'Before world')
    const view = editor.getView()

    editor.insertMarkdown('\n![A cat](./images/cat.png)\n')

    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('Before')
    expect(md).toContain('![A cat](./images/cat.png)')
    editor.destroy()
  })
})
