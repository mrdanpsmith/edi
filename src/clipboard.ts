import { hasBridge, invoke } from './bridge'

export interface ClipboardPayload {
  html: string
  text: string
  markdown?: string
}

/**
 * Write rich clipboard content (HTML + plain text). Uses the native bridge so
 * the desktop shell's system clipboard carries both representations, falling
 * back to the web Clipboard API when there is no bridge.
 */
export async function writeClipboard(payload: ClipboardPayload): Promise<boolean> {
  if (hasBridge()) {
    try {
      await invoke('copyContent', payload)
      return true
    } catch {
      return webClipboardWrite(payload)
    }
  }
  return webClipboardWrite(payload)
}

/**
 * Copy plain text to the clipboard. Prefers the native bridge (the desktop
 * shell's system clipboard), then the web Clipboard API, then the legacy
 * execCommand path.
 */
export async function copyText(text: string): Promise<boolean> {
  if (hasBridge()) {
    try {
      await invoke('copyText', { text })
      return true
    } catch {
      // Fall through to the web/execCommand paths.
    }
  }
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy execCommand path.
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  return copied
}

/**
 * Read plain text from the clipboard. Prefers the native bridge (the desktop
 * shell's system clipboard), then the web Clipboard API. Returns null when
 * nothing readable is available.
 */
export async function readText(): Promise<string | null> {
  if (hasBridge()) {
    try {
      const data = await invoke<{ text: string }>('readClipboardText')
      if (data?.text) return data.text
    } catch {
      // Fall through to the web API.
    }
  }
  try {
    if (typeof navigator.clipboard?.readText === 'function') {
      return await navigator.clipboard.readText()
    }
    if (typeof navigator.clipboard?.read === 'function') {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          return await item.getType('text/plain').then((blob) => blob.text())
        }
      }
    }
  } catch {
    // Ignore: treat unreadable clipboard as empty.
  }
  return null
}

async function webClipboardWrite(payload: ClipboardPayload): Promise<boolean> {
  if (typeof navigator.clipboard?.write === 'function') {
    const items: Record<string, Blob> = {
      'text/html': new Blob([payload.html], { type: 'text/html' }),
      'text/plain': new Blob([payload.text], { type: 'text/plain' }),
    }
    if (payload.markdown) {
      items['text/markdown'] = new Blob([payload.markdown], { type: 'text/markdown' })
    }
    try {
      await navigator.clipboard.write([new ClipboardItem(items)])
      return true
    } catch {
      if (payload.markdown) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/html': items['text/html']!,
              'text/plain': items['text/plain']!,
            }),
          ])
          return true
        } catch {
          // Fall through to the text-only fallback.
        }
      }
    }
  }
  return execCommandCopy(payload.text)
}

/**
 * The last-resort clipboard write: a hidden off-screen textarea and the
 * synchronous `document.execCommand('copy')`, for a page where neither the
 * native bridge nor the async web Clipboard API is available.
 *
 * Exported because the table copy control needs the same fallback for its
 * text-only leg. It cannot reach for `copyText` there: it writes its own rich
 * `ClipboardItem` first and drops to plain text only if that throws, so it
 * must not also re-enter the bridge.
 */
export function execCommandCopy(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  return copied
}
