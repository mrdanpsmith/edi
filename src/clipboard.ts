import { hasBridge, invoke } from './bridge'

export interface ClipboardPayload {
  html: string
  text: string
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

async function webClipboardWrite(payload: ClipboardPayload): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.write === 'function') {
      const item = new ClipboardItem({
        'text/html': new Blob([payload.html], { type: 'text/html' }),
        'text/plain': new Blob([payload.text], { type: 'text/plain' }),
      })
      await navigator.clipboard.write([item])
      return true
    }
  } catch {
    // Fall through to the text-only fallback.
  }
  return execCommandCopy(payload.text)
}

function execCommandCopy(text: string): boolean {
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
