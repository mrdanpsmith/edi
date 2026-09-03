import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBlockEditor } from './editor'
import { markdownToProse, proseToMarkdown } from './markdown'
import { schema } from './schema'

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('image parsing and rendering', () => {
  it('parses image nodes as inline content inside a paragraph', () => {
    // Would throw "Invalid content for node paragraph: <image>" before the
    // image node was added to the inline group.
    const doc = markdownToProse('Hello ![A cat](./images/cat.png) there', schema)
    let image: unknown = null
    doc.descendants((node) => {
      if (node.type.name === 'image') image = node.attrs
    })
    expect(image).toEqual({ src: './images/cat.png', alt: 'A cat' })
  })

  it('renders the image using the resolved src from resolveImageSrc', () => {
    const editor = createBlockEditor(
      document.body,
      'Before\n\n![A cat](./images/cat.png)\n\nAfter',
      {
        resolveImageSrc: (src) => `file:///resolved/${src}`,
      },
    )
    const view = editor.getView()
    const img = view.dom.querySelector<HTMLImageElement>('img.edi-image')
    expect(img).not.toBeNull()
    // The rendered <img> uses the resolved file URL, not the raw relative path.
    expect(img!.getAttribute('src')).toBe('file:///resolved/./images/cat.png')
    // The document still round-trips to the raw relative markdown.
    expect(proseToMarkdown(view.state.doc)).toContain('![A cat](./images/cat.png)')
    view.destroy()
  })

  it('does not decorate an image nodeView when no resolver is supplied', () => {
    // The editor still works without a resolver (uses raw src).
    const editor = createBlockEditor(document.body, '![x](./img.png)')
    const view = editor.getView()
    const img = view.dom.querySelector<HTMLImageElement>('img')
    expect(img).not.toBeNull()
    view.destroy()
  })

  it('shows the alt text as the hover tooltip via the title attribute', () => {
    const editor = createBlockEditor(document.body, '![A fluffy cat](./images/cat.png)', {
      resolveImageSrc: (src) => `file:///${src}`,
    })
    const view = editor.getView()
    const img = view.dom.querySelector<HTMLImageElement>('img.edi-image')
    expect(img!.getAttribute('alt')).toBe('A fluffy cat')
    expect(img!.getAttribute('title')).toBe('A fluffy cat')
    view.destroy()
  })

  it('falls back to the file name when the image has no alt text', () => {
    const editor = createBlockEditor(document.body, '![](./images/dog.png)', {
      resolveImageSrc: (src) => `file:///${src}`,
    })
    const view = editor.getView()
    const img = view.dom.querySelector<HTMLImageElement>('img.edi-image')
    expect(img!.getAttribute('title')).toBe('dog.png')
    view.destroy()
  })
})
