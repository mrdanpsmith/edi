import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from './bridge'
import { createUpdateNotice, type UpdateNotice } from './updateNotice'

vi.mock('./bridge')

describe('the update notice', () => {
  let status: HTMLElement
  let notice: UpdateNotice
  const button = (): HTMLButtonElement => status.parentElement!.querySelector('.status-update')!

  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockResolvedValue(undefined)
    const bar = document.createElement('footer')
    status = document.createElement('span')
    bar.append(status)
    document.body.append(bar)
    notice = createUpdateNotice(status)
  })

  afterEach(() => {
    notice.destroy()
    document.body.innerHTML = ''
  })

  it('is hidden until the shell reports a newer release', () => {
    expect(button().hidden).toBe(true)
    notice.show('1.2.0', 'https://github.com/mrdanpsmith/edi/releases/tag/v1.2.0')
    expect(button().hidden).toBe(false)
    expect(button().textContent).toBe('Edi 1.2.0 is available')
  })

  it('opens the release page and puts itself away on a click', () => {
    notice.show('1.2.0', 'https://github.com/mrdanpsmith/edi/releases/tag/v1.2.0')
    button().click()
    expect(invoke).toHaveBeenCalledWith('openUrl', { url: 'https://github.com/mrdanpsmith/edi/releases/tag/v1.2.0' })
    expect(button().hidden).toBe(true)
  })

  it('offers a newer release candidate to someone running one', () => {
    notice.show('1.0.0-rc.2', 'https://github.com/mrdanpsmith/edi/releases/tag/v1.0.0-rc.2')
    expect(button().textContent).toBe('Edi 1.0.0-rc.2 is available')
  })

  it('never offers a link outside Edi\'s own releases', () => {
    notice.show('1.2.0', 'https://example.com/releases/tag/v1.2.0')
    notice.show('1.2.0 now', 'https://github.com/mrdanpsmith/edi/releases/tag/v1.2.0')
    expect(button().hidden).toBe(true)
  })
})
