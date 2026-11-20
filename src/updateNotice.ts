/**
 * "Edi 1.2.0 is available" in the status bar, after the shell's automatic update
 * check found a newer release (`backend/updates.py`). A click opens that
 * release's page in the browser and puts the notice away; it is not shown again
 * until the next launch finds one.
 *
 * The shell builds the link from the version, and the page only ever opens a
 * release page of Edi's own repository.
 */
import { invoke } from './bridge'

const RELEASES = 'https://github.com/mrdanpsmith/edi/releases/tag/'

export interface UpdateNotice {
  show(version: string, url: string): void
  destroy(): void
}

export function createUpdateNotice(after: HTMLElement | null | undefined): UpdateNotice {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'status-update'
  button.hidden = true
  let url = ''
  button.addEventListener('click', () => {
    button.hidden = true
    if (url) void invoke('openUrl', { url }).catch(() => undefined)
  })
  after?.after(button)

  return {
    show(version, link) {
      if (!link.startsWith(RELEASES) || !/^\d+\.\d+\.\d+$/.test(version)) return
      url = link
      button.textContent = `Edi ${version} is available`
      button.title = 'Open the release page'
      button.hidden = false
    },
    destroy() {
      button.remove()
    },
  }
}
