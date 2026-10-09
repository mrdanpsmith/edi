/**
 * Preferences that outlive a run: the View menu's controllable options and the
 * document zoom level.
 *
 * **The store is the shell's, not the page's.** `window.ediPreferences` is
 * injected by `backend/window.py`'s document-creation script before this bundle
 * runs — which is the whole reason a read can be synchronous here, and zoom has
 * to be applied before the editor's first paint. Writes go back over the bridge
 * to the same `QSettings` the recent-files list uses.
 *
 * It is not `localStorage`, and it cannot be: the app never creates a
 * `QWebEngineProfile`, so the page runs on the *default* profile, which is
 * off-the-record — `QWebEngineProfile.defaultProfile().isOffTheRecord()` is
 * `True` and every byte of web storage it holds is dropped when the process
 * exits. A packaged build showed this most plainly, since `build-pyzip.sh`
 * extracts to a fresh temp directory per run, so even a persistent web profile
 * would have keyed the app's origin by a path that no longer exists. Nothing
 * about that was migration-worthy: those keys had never reached a disk.
 *
 * `current` is seeded from the injected snapshot and is then the page's own
 * record of what it has asked for, because the menu checkmarks are published
 * from it (`setMenuState`) and a re-read of the injection would answer with the
 * answers this window booted with.
 */
import { invoke } from './bridge'

export interface Preferences {
  zoomFactor: number
  toolbarVisible: boolean
  hoverBand: boolean
}

/**
 * Must match `DEFAULTS` in `backend/preferences.py`. Both are load-bearing:
 * this is what a page gets when there is no shell to ask (`npm run dev` in a
 * browser, a unit test), and that is what the shell injects when it has never
 * been asked a question.
 */
export const DEFAULT_PREFERENCES: Preferences = {
  zoomFactor: 1,
  toolbarVisible: true,
  hoverBand: true,
}

/**
 * The injected snapshot, or the defaults, with each value taken only if it is
 * the right shape — a shell built from an older edi, or a hand-edited
 * `Edi.conf` behind it, must not be able to put a string where the editor
 * wants a factor.
 */
function injected(): Preferences {
  const raw = (window.ediPreferences ?? {}) as Partial<Record<keyof Preferences, unknown>>
  const zoom = Number(raw.zoomFactor)
  return {
    zoomFactor: typeof raw.zoomFactor === 'number' && Number.isFinite(zoom) ? zoom : DEFAULT_PREFERENCES.zoomFactor,
    toolbarVisible: typeof raw.toolbarVisible === 'boolean' ? raw.toolbarVisible : DEFAULT_PREFERENCES.toolbarVisible,
    hoverBand: typeof raw.hoverBand === 'boolean' ? raw.hoverBand : DEFAULT_PREFERENCES.hoverBand,
  }
}

let current: Preferences = injected()

/** Every preference as this window last understood it. */
export function currentPreferences(): Preferences {
  return current
}

/**
 * Ask the shell to persist one preference. Fire-and-forget, like the menu state:
 * a preference is not worth failing an action over, and the page has already
 * applied the change by the time this is called — `current` is the page's
 * record, and the shell is the one that has to catch up.
 */
export function savePreference<K extends keyof Preferences>(name: K, value: Preferences[K]): void {
  current = { ...current, [name]: value }
  void invoke('setPreference', { name, value }).catch(() => undefined)
}
