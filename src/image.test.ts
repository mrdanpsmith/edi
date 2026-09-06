import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Node as ProseNode } from 'prosemirror-model'
import { createBlockEditor } from './editor'
import { markdownToProse, proseToMarkdown } from './markdown'
import { schema } from './schema'
import { imageNodeView, reResolveImages } from './image'

interface ShallowNodeView {
  dom: HTMLElement
  update?: (node: ProseNode) => boolean
  selectNode?: () => void
  deselectNode?: () => void
}

function makeNodeView(resolve: (src: string) => string): (node: ProseNode) => ShallowNodeView {
  return imageNodeView(resolve) as unknown as (node: ProseNode) => ShallowNodeView
}

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

describe('image nodeView lifecycle', () => {
  it('adds and removes the selected-node class on select/deselect', () => {
    const node = schema.nodes.image.create({ src: 'a.png', alt: 'alt' })
    const nv = makeNodeView((src) => `resolved/${src}`)(node)
    nv.selectNode!()
    expect(nv.dom.classList.contains('ProseMirror-selectednode')).toBe(true)
    nv.deselectNode!()
    expect(nv.dom.classList.contains('ProseMirror-selectednode')).toBe(false)
  })

  it('re-renders the img when the node attrs change', () => {
    const a = schema.nodes.image.create({ src: 'a.png', alt: 'A' })
    const b = schema.nodes.image.create({ src: 'b.png', alt: 'B' })
    const nv = makeNodeView((src) => `resolved/${src}`)(a)
    expect(nv.update!(b)).toBe(true)
    expect(nv.dom.getAttribute('src')).toBe('resolved/b.png')
    expect(nv.dom.getAttribute('title')).toBe('B')
    expect(nv.dom.dataset.src).toBe('b.png')
    // Updating with a different node type is rejected.
    expect(nv.update!(schema.nodes.paragraph.create())).toBe(false)
  })

  it('keeps the img untouched when attrs are unchanged', () => {
    const a = schema.nodes.image.create({ src: 'a.png', alt: 'A' })
    const nv = makeNodeView((src) => `resolved/${src}`)(a)
    expect(nv.update!(schema.nodes.image.create({ src: 'a.png', alt: 'A' }))).toBe(true)
    expect(nv.dom.getAttribute('src')).toBe('resolved/a.png')
  })
})

describe('reResolveImages', () => {
  it('re-resolves only edi-image elements that carry a dataset.src', () => {
    const host = document.createElement('div')
    host.innerHTML =
      '<img class="edi-image" data-src="./a.png">' +
      '<img data-src="./b.png">' +
      '<img class="edi-image">'
    const seen: string[] = []
    reResolveImages(host, (src) => {
      seen.push(src)
      return `new/${src}`
    })
    const imgs = host.querySelectorAll<HTMLImageElement>('img')
    expect(imgs.item(0).getAttribute('src')).toBe('new/./a.png')
    expect(imgs.item(1).getAttribute('src')).toBeNull()
    expect(imgs.item(2).getAttribute('src')).toBeNull()
    expect(seen).toEqual(['./a.png'])
  })
})
