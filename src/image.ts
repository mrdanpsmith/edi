import type { Node as ProseNode } from 'prosemirror-model'
import type { NodeView, NodeViewConstructor } from 'prosemirror-view'

/**
 * Resolves a markdown image ``src`` into a URL the engine can actually load
 * (e.g. a ``file://`` URL based on the active document's directory).
 */
export type ResolveImage = (src: string) => string

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
    img.src = resolve(current.attrs.src as string)
    // Keep the raw markdown src so images can be re-resolved when the active
    // document's path changes (e.g. open or Save As).
    img.dataset.src = current.attrs.src as string
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
          img.dataset.src = next.attrs.src as string
          img.src = resolve(next.attrs.src as string)
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
    if (raw) img.src = resolve(raw)
  })
}
