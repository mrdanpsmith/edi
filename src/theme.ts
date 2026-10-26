import { onBridgeReady, type BridgeObject } from './bridge'
import { rethemeMermaid } from './node/mermaid'

const currentScheme: { value: 'dark' | 'light' | null } = { value: null }

export function applyColorScheme(dark: boolean): void {
  const next = dark ? 'dark' : 'light'
  if (currentScheme.value === next) return
  currentScheme.value = next
  document.documentElement.dataset.colorScheme = next
  rethemeMermaid(dark)
}

function onNotify(payload: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const message = parsed as { type?: unknown; dark?: unknown }
  if (message.type === 'colorScheme' && typeof message.dark === 'boolean') {
    applyColorScheme(message.dark)
  }
}

export function initTheme(bridge: BridgeObject | undefined): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const sync = (): void => applyColorScheme(media.matches)
  sync()
  // The backend watcher is authoritative for transitions; it pushes on Qt
  // signals and on its own poll, and re-applies the scheme the moment the
  // page bridges in. matchMedia is only trusted at boot and on genuine
  // change events — NOT on focus/visibility re-reads: in QtWebEngine the
  // media query does not track the system and re-reading it on focus would
  // stomp a correct backend push (the packaged binary reports stale light).
  media.addEventListener('change', sync)
  bridge?.notify?.connect(onNotify)
}

export function startThemeWatcher(): void {
  onBridgeReady(initTheme)
}