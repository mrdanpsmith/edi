/**
 * Remote images: shown only from sites the reader has allowed.
 *
 * Loading an image from a server tells that server the document was opened,
 * when, and from what address, so a document from anywhere loads nothing remote
 * until the reader says so. A remote image from a site not allowed resolves to
 * `BLOCKED_IMAGE_SRC` (a local placeholder), and a bar above the document names
 * the sites its images would come from:
 *
 * - **Load images** allows them until Edi quits;
 * - **Always load from these sites** allows them for good;
 * - **Not now** hides the bar for this tab.
 *
 * The answer is the shell's to keep (`backend/remote.py`), and the shell's
 * request interceptor is what enforces it, for this page and anything it loads.
 * View › Forget Allowed Image Sites… takes the answers back. Outside the shell
 * (`vite dev` in a browser) nothing is held back.
 */
import { inNativeShell, invoke } from './bridge'
import { BLOCKED_IMAGE_SRC, remoteImageHost } from './image'

const allowed = new Set<string>()

/** The bar's refresh, told whenever an image is held back. */
const onBlocked: { value: (() => void) | null } = { value: null }

/** Whether the image at resolved-or-raw `src` may be requested. */
export function isImageAllowed(src: string): boolean {
  const host = remoteImageHost(src)
  return host === null || !inNativeShell() || allowed.has(host)
}

/** `url` unchanged when it may be requested, otherwise the placeholder. */
export function gateRemoteImage(url: string): string {
  if (isImageAllowed(url)) return url
  onBlocked.value?.()
  return BLOCKED_IMAGE_SRC
}

export function setAllowedImageHosts(hosts: readonly string[]): void {
  allowed.clear()
  for (const host of hosts) allowed.add(host.toLowerCase())
}

/** The sites the shell already allows. */
export async function loadAllowedImageHosts(): Promise<string[]> {
  const hosts = await invoke<string[]>('allowedImageHosts')
  return Array.isArray(hosts) ? hosts : []
}

/** The sites of the blocked images shown under `root`, in document order. */
export function blockedImageHosts(root: ParentNode): string[] {
  const hosts: string[] = []
  for (const img of root.querySelectorAll<HTMLImageElement>('img.edi-image-blocked')) {
    const host = remoteImageHost(img.dataset.src ?? '')
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

/** "a", "a and b", "a, b and 2 more sites". */
export function describeHosts(hosts: readonly string[]): string {
  if (hosts.length <= 2) return hosts.join(' and ')
  if (hosts.length === 3) return `${hosts[0]}, ${hosts[1]} and ${hosts[2]}`
  return `${hosts[0]}, ${hosts[1]} and ${hosts.length - 2} more sites`
}

export interface RemoteImagesBar {
  /** Show, update or hide the bar for what the editor now shows. */
  refresh(): void
  /** The shell changed the allowed sites (View › Forget…). */
  allowedChanged(hosts: readonly string[]): void
  destroy(): void
}

export interface RemoteImagesBarOptions {
  /** Where the document's images are drawn. */
  container: HTMLElement
  /** The tab in view, so Not now holds for that tab only. */
  activeId(): string | null
  /** Draw every image again against the current answers. */
  resolveImages(): void
}

export function createRemoteImagesBar(options: RemoteImagesBarOptions): RemoteImagesBar {
  const dismissed = new Set<string>()
  let bar: HTMLElement | null = null
  let scheduled = false

  function hide(): void {
    bar?.remove()
    bar = null
  }

  async function allow(hosts: string[], remember: boolean): Promise<void> {
    try {
      setAllowedImageHosts(await invoke<string[]>('allowImageHosts', { hosts, remember }))
    } catch {
      return
    }
    options.resolveImages()
    refreshNow()
  }

  function show(hosts: string[], count: number): void {
    hide()
    bar = document.createElement('div')
    bar.className = 'edi-disk-bar edi-remote-images-bar'
    bar.setAttribute('role', 'status')
    const message = document.createElement('span')
    message.className = 'edi-disk-bar-message'
    const images = count === 1 ? 'an image' : `${count} images`
    message.textContent = `This document has ${images} from ${describeHosts(hosts)}. Loading them tells ${
      hosts.length === 1 ? 'that site' : 'those sites'
    } that you opened it.`
    message.title = hosts.join('\n')
    const actions = document.createElement('span')
    actions.className = 'edi-disk-bar-actions'
    const button = (label: string, onClick: () => void, primary = false): void => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = primary ? 'toolbar-btn toolbar-primary' : 'toolbar-btn'
      element.textContent = label
      element.addEventListener('click', onClick)
      actions.append(element)
    }
    button('Load images', () => void allow(hosts, false), true)
    button(hosts.length === 1 ? 'Always load from this site' : 'Always load from these sites', () => void allow(hosts, true))
    button('Not now', () => {
      const id = options.activeId()
      if (id) dismissed.add(id)
      hide()
    })
    bar.append(message, actions)
    options.container.parentElement?.insertBefore(bar, options.container)
  }

  function refreshNow(): void {
    scheduled = false
    const id = options.activeId()
    const blocked = options.container.querySelectorAll('img.edi-image-blocked').length
    const hosts = blockedImageHosts(options.container)
    if (id === null || blocked === 0 || dismissed.has(id)) {
      hide()
      return
    }
    show(hosts, blocked)
  }

  function refresh(): void {
    // Images are drawn by node views during a transaction; read the DOM once
    // they have all landed.
    if (scheduled) return
    scheduled = true
    queueMicrotask(refreshNow)
  }
  onBlocked.value = refresh

  return {
    refresh,
    allowedChanged(hosts) {
      setAllowedImageHosts(hosts)
      options.resolveImages()
      refreshNow()
    },
    destroy() {
      if (onBlocked.value === refresh) onBlocked.value = null
      hide()
    },
  }
}
