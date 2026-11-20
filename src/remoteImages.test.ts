import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inNativeShell, invoke } from './bridge'
import { applyImageSrc, BLOCKED_IMAGE_SRC, remoteImageHost } from './image'
import {
  blockedImageHosts,
  createRemoteImagesBar,
  describeHosts,
  gateRemoteImage,
  setAllowedImageHosts,
  type RemoteImagesBar,
} from './remoteImages'

vi.mock('./bridge')

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

beforeEach(() => {
  vi.mocked(inNativeShell).mockReturnValue(true)
  vi.mocked(invoke).mockReset()
  setAllowedImageHosts([])
})

describe('remoteImageHost', () => {
  it('names the site of an http or https image only', () => {
    expect(remoteImageHost('https://I.Imgur.com/a.png')).toBe('i.imgur.com')
    expect(remoteImageHost(' http://example.org:8080/a.png')).toBe('example.org')
    for (const src of ['pic.png', '/abs/pic.png', 'file:///tmp/a.png', 'data:image/png;base64,AA', '//cdn.example/a.png']) {
      expect(remoteImageHost(src), src).toBeNull()
    }
  })
})

describe('gateRemoteImage', () => {
  it('holds back a remote image until its site is allowed', () => {
    expect(gateRemoteImage('https://example.org/a.png')).toBe(BLOCKED_IMAGE_SRC)
    setAllowedImageHosts(['example.org'])
    expect(gateRemoteImage('https://example.org/a.png')).toBe('https://example.org/a.png')
    expect(gateRemoteImage('https://other.example/a.png')).toBe(BLOCKED_IMAGE_SRC)
  })

  it('never holds back a local image', () => {
    expect(gateRemoteImage('file:///tmp/a.png')).toBe('file:///tmp/a.png')
  })

  it('holds nothing back outside the shell', () => {
    vi.mocked(inNativeShell).mockReturnValue(false)
    expect(gateRemoteImage('https://example.org/a.png')).toBe('https://example.org/a.png')
  })
})

describe('applyImageSrc', () => {
  it('marks a held-back image and says which site it is from', () => {
    const img = document.createElement('img')
    applyImageSrc(img, 'https://example.org/a.png', 'A chart', gateRemoteImage)
    expect(img.classList.contains('edi-image-blocked')).toBe(true)
    expect(img.title).toBe('Image from example.org not loaded')
    expect(img.dataset.src).toBe('https://example.org/a.png')
    setAllowedImageHosts(['example.org'])
    applyImageSrc(img, 'https://example.org/a.png', 'A chart', gateRemoteImage)
    expect(img.classList.contains('edi-image-blocked')).toBe(false)
    expect(img.title).toBe('A chart')
  })
})

describe('describeHosts', () => {
  it('lists up to three sites and counts the rest', () => {
    expect(describeHosts(['a'])).toBe('a')
    expect(describeHosts(['a', 'b'])).toBe('a and b')
    expect(describeHosts(['a', 'b', 'c'])).toBe('a, b and c')
    expect(describeHosts(['a', 'b', 'c', 'd'])).toBe('a, b and 2 more sites')
  })
})

describe('the remote images bar', () => {
  let shell: HTMLElement
  let container: HTMLElement
  let bar: RemoteImagesBar
  let active: string | null
  const resolveImages = vi.fn(() => {
    for (const img of container.querySelectorAll('img')) {
      applyImageSrc(img, img.dataset.src ?? '', img.alt, gateRemoteImage)
    }
  })

  const addImage = (src: string): void => {
    const img = document.createElement('img')
    applyImageSrc(img, src, '', gateRemoteImage)
    container.append(img)
  }
  const shown = (): HTMLElement | null => shell.querySelector('.edi-remote-images-bar')
  const click = (label: string): void => {
    const button = [...(shown()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)
    if (!button) throw new Error(`no ${label} button`)
    button.click()
  }

  beforeEach(() => {
    shell = document.createElement('div')
    container = document.createElement('section')
    shell.append(container)
    document.body.append(shell)
    active = 'tab-1'
    resolveImages.mockClear()
    bar = createRemoteImagesBar({ container, activeId: () => active, resolveImages })
  })

  afterEach(() => {
    bar.destroy()
    shell.remove()
  })

  it('names the sites a document would load images from', async () => {
    addImage('https://i.imgur.com/a.png')
    addImage('https://i.imgur.com/b.png')
    addImage('https://example.org/c.png')
    addImage('pic.png')
    await flush()
    expect(blockedImageHosts(container)).toEqual(['i.imgur.com', 'example.org'])
    expect(shown()?.textContent).toContain('This document has 3 images from i.imgur.com and example.org.')
  })

  it('stays away from a document with no remote images', async () => {
    addImage('pic.png')
    bar.refresh()
    await flush()
    expect(shown()).toBeNull()
  })

  it('loads the images once the reader allows their sites', async () => {
    addImage('https://example.org/a.png')
    await flush()
    vi.mocked(invoke).mockResolvedValue(['example.org'])
    click('Load images')
    await vi.waitFor(() => expect(shown()).toBeNull())
    expect(invoke).toHaveBeenCalledWith('allowImageHosts', { hosts: ['example.org'], remember: false })
    expect(resolveImages).toHaveBeenCalled()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.org/a.png')
  })

  it('remembers the sites when asked to always load from them', async () => {
    addImage('https://example.org/a.png')
    await flush()
    vi.mocked(invoke).mockResolvedValue(['example.org'])
    click('Always load from this site')
    await vi.waitFor(() => expect(shown()).toBeNull())
    expect(invoke).toHaveBeenCalledWith('allowImageHosts', { hosts: ['example.org'], remember: true })
  })

  it('keeps the images held back when the shell refuses', async () => {
    addImage('https://example.org/a.png')
    await flush()
    vi.mocked(invoke).mockRejectedValue(new Error('no'))
    click('Load images')
    await flush()
    await flush()
    expect(shown()).not.toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toBe(BLOCKED_IMAGE_SRC)
  })

  it('hides for the tab the reader said not now on, and only that one', async () => {
    addImage('https://example.org/a.png')
    await flush()
    click('Not now')
    expect(shown()).toBeNull()
    bar.refresh()
    await flush()
    expect(shown()).toBeNull()
    active = 'tab-2'
    bar.refresh()
    await flush()
    expect(shown()).not.toBeNull()
  })

  it('holds images back again when the shell forgets the sites', async () => {
    setAllowedImageHosts(['example.org'])
    addImage('https://example.org/a.png')
    bar.refresh()
    await flush()
    expect(shown()).toBeNull()
    bar.allowedChanged([])
    expect(container.querySelector('img')?.getAttribute('src')).toBe(BLOCKED_IMAGE_SRC)
    expect(shown()).not.toBeNull()
  })
})
