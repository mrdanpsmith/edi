import type { Node as ProseNode } from 'prosemirror-model'
import type { NodeView, NodeViewConstructor } from 'prosemirror-view'

/**
 * Resolves a markdown image ``src`` into a URL the engine can actually load
 * (e.g. a ``file://`` URL based on the active document's directory).
 */
export type ResolveImage = (src: string) => string

/**
 * What a resolver returns for a remote image from a site the reader has not
 * allowed (`src/remoteImages.ts`): a local picture, so nothing is requested.
 */
export const BLOCKED_IMAGE_SRC =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96" viewBox="0 0 160 96">' +
      '<rect x="1" y="1" width="158" height="94" rx="6" fill="none" stroke="#8a8f98" stroke-dasharray="6 4"/>' +
      '<path d="M58 64l14-18 10 12 8-9 12 15z" fill="#8a8f98"/><circle cx="96" cy="38" r="5" fill="#8a8f98"/></svg>',
  )

/** The site a remote image would be requested from, or null for a local one. */
export function remoteImageHost(src: string): string | null {
  const trimmed = src.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  try {
    return new URL(trimmed).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * How many times images have been reloaded from disk (File › Revert). The
 * engine caches images by URL, so a ``file://`` image changed on disk keeps
 * showing the old pixels until its URL changes; ``withImageReload`` appends
 * this generation as a query, which ``file://`` loads ignore.
 */
let imageReload = 0

/** Make every ``file://`` image URL resolved from now on fetch from disk again. */
export function bumpImageReload(): void {
  imageReload += 1
}

/** ``url`` with the current reload generation, for ``file://`` URLs only. */
export function withImageReload(url: string): string {
  if (imageReload === 0 || !url.startsWith('file://')) return url
  const parsed = new URL(url)
  parsed.searchParams.set('edi-reload', String(imageReload))
  return parsed.href
}

/**
 * The hover tooltip text for an image: its alt text, falling back to the file
 * name in the src. Browsers show image tooltips from the ``title`` attribute
 * (not ``alt``), so we mirror the markdown alt text onto ``title``.
 */
function imageTooltip(alt: string, src: string): string {
  if (alt) return alt
  const clean = src.split('#')[0]
  const base = clean.split('/').pop() ?? ''
  const query = base.indexOf('?')
  return (query >= 0 ? base.slice(0, query) : base) || src
}

/**
 * Point ``img`` at markdown ``src`` through ``resolve``, and mark it blocked
 * when the resolver held it back. The one place an image's ``src`` is set, so
 * a blocked image always says why.
 */
export function applyImageSrc(img: HTMLImageElement, src: string, alt: string, resolve: ResolveImage): void {
  img.dataset.src = src
  const url = resolve(src)
  const blocked = url === BLOCKED_IMAGE_SRC
  img.classList.toggle('edi-image-blocked', blocked)
  if (blocked) img.classList.remove('edi-image-error')
  img.title = blocked ? `Image from ${remoteImageHost(src) ?? src} not loaded` : imageTooltip(alt, src)
  img.src = url
}

/**
 * Build a ProseMirror nodeView for inline images. The rendered ``<img>`` uses
 * the *resolved* src (an absolute file URL or remote/data URL), not the raw
 * relative markdown path, so QtWebEngine can display it.
 */
export function imageNodeView(resolve: ResolveImage): NodeViewConstructor {
  return (node: ProseNode): NodeView => {
    let current = node
    const img = document.createElement('img')
    img.className = 'edi-image'
    img.alt = current.attrs.alt as string
    // Keeps the raw markdown src on the element, so images can be re-resolved
    // when the active document's path changes (e.g. open or Save As) or a site
    // is allowed.
    applyImageSrc(img, current.attrs.src as string, img.alt, resolve)
    img.addEventListener('error', () => img.classList.add('edi-image-error'))
    return {
      dom: img,
      ignoreMutation: () => true,
      selectNode: () => {
        img.classList.add('ProseMirror-selectednode')
      },
      deselectNode: () => {
        img.classList.remove('ProseMirror-selectednode')
      },
      update(next: ProseNode): boolean {
        if (next.type !== current.type) return false
        if (next.attrs.src !== current.attrs.src || next.attrs.alt !== current.attrs.alt) {
          current = next
          img.alt = next.attrs.alt as string
          applyImageSrc(img, next.attrs.src as string, img.alt, resolve)
        }
        return true
      },
    }
  }
}

/**
 * Re-resolve every rendered ``<img class="edi-image">`` against a fresh
 * ``resolve``. Used when the active document's path changes so relative
 * references point at the current directory.
 */
export function reResolveImages(host: HTMLElement, resolve: ResolveImage): void {
  host.querySelectorAll<HTMLImageElement>('img.edi-image').forEach((img) => {
    const raw = img.dataset.src
    if (raw) applyImageSrc(img, raw, img.alt, resolve)
  })
}
