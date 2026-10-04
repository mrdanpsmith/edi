import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MaskedFieldInteractions } from './node/masked'
import { encryptField } from './crypto'
import { promptForPassword } from './crypto-dialog'

vi.mock('./crypto-dialog', () => ({
  promptForPassword: vi.fn(),
  promptForSecretCreate: vi.fn(),
}))

const promptMock = vi.mocked(promptForPassword)

function fakeBackend(envelope: string) {
  let content = envelope
  return {
    content: () => content,
    label: () => 'field',
    commit(next: string) { content = next },
    present() {},
  }
}

beforeEach(() => {
  promptMock.mockReset()
  promptMock.mockImplementation(async (_label, ok) => {
    const accepted = ok ? await ok('pw') : true
    return accepted === true ? 'pw' : null
  })
})

describe('MaskedFieldInteractions password retention', () => {
  it('copy prompts but leaves nothing cached behind', async () => {
    const envelope = await encryptField('secret', 'pw')
    const it = new MaskedFieldInteractions(fakeBackend(envelope))
    await it.copy()
    expect(it.plaintextValue).toBeNull()
    await it.copy()
    expect(promptMock).toHaveBeenCalledTimes(2)
  })

  it('reveal then hide forgets the password; next reveal re-prompts', async () => {
    const envelope = await encryptField('secret', 'pw')
    const it = new MaskedFieldInteractions(fakeBackend(envelope))
    await it.toggle()
    expect(it.isRevealed).toBe(true)
    it.hide()
    await it.toggle()
    expect(promptMock).toHaveBeenCalledTimes(2)
  })

  it('commit forgets the password used for the edit', async () => {
    const envelope = await encryptField('secret', 'pw')
    const it = new MaskedFieldInteractions(fakeBackend(envelope))
    await it.startEdit()
    await it.commitEdit('secret2')
    expect(it.plaintextValue).toBeNull()
    // A following reveal must prompt again rather than reusing 'pw' silently.
    await it.toggle()
    expect(promptMock).toHaveBeenCalledTimes(2)
  })

  it('cancel clears the unlocked session', async () => {
    const envelope = await encryptField('secret', 'pw')
    const it = new MaskedFieldInteractions(fakeBackend(envelope))
    await it.startEdit()
    it.cancelEdit()
    expect(it.plaintextValue).toBeNull()
    await it.toggle()
    expect(promptMock).toHaveBeenCalledTimes(2)
  })
})
