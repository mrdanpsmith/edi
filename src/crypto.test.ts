import { describe, expect, it } from 'vitest'
import {
  DecryptError,
  decryptFailureMessage,
  decryptField,
  deriveSealingKey,
  encryptField,
  MASKED_FORMAT_VERSION,
  MASKED_IV_LENGTH,
  MASKED_SALT_LENGTH,
  MASKED_TAG_LENGTH,
  openEnvelope,
  openWithKey,
  sealWithKey,
  type SecretContext,
} from './crypto'

const FIELD: SecretContext = { kind: 'field', label: 'API Key' }

/** Written by the version 1 code (this repository at 0.21.0): 'legacy secret' under 'old-pw'. */
const V1_ENVELOPE = 'AeW1NXh3e8tj3hIh3N8WiYWC9hfpxnXCn3OvamMqUt6hFUZhVU6qnT7fysKgI/+/GwID/G74gX8YFA=='

function decodeEnvelope(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
}

async function rejection(promise: Promise<unknown>): Promise<DecryptError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DecryptError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('encryptField / decryptField', () => {
  it('round-trips a value', async () => {
    const envelope = await encryptField('s3cr3t-value', 'hunter2', FIELD)
    expect(envelope).not.toContain('s3cr3t-value')
    expect(await decryptField(envelope, 'hunter2', FIELD)).toBe('s3cr3t-value')
  })

  it('rejects a wrong password', async () => {
    const envelope = await encryptField('value', 'right-password', FIELD)
    const error = await rejection(decryptField(envelope, 'wrong-password', FIELD))
    expect(error.reason).toBe('password')
  })

  it('uses a fresh salt and IV per encrypt', async () => {
    const a = decodeEnvelope(await encryptField('same value', 'same password', FIELD))
    const b = decodeEnvelope(await encryptField('same value', 'same password', FIELD))
    expect(a.subarray(1, 1 + MASKED_SALT_LENGTH)).not.toEqual(b.subarray(1, 1 + MASKED_SALT_LENGTH))
    expect(a.subarray(1 + MASKED_SALT_LENGTH, 1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH)).not.toEqual(
      b.subarray(1 + MASKED_SALT_LENGTH, 1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH),
    )
  })

  it('writes version 2 with the documented layout', async () => {
    const bytes = decodeEnvelope(await encryptField('x', 'pw', FIELD))
    expect(bytes[0]).toBe(MASKED_FORMAT_VERSION)
    expect(MASKED_FORMAT_VERSION).toBe(2)
    expect(bytes.length).toBe(1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH + 1 + MASKED_TAG_LENGTH)
  })

  it('puts the GCM tag last: changing the final byte breaks authentication', async () => {
    const bytes = decodeEnvelope(await encryptField('x', 'pw', FIELD))
    bytes[bytes.length - 1] ^= 1
    expect((await rejection(decryptField(encode(bytes), 'pw', FIELD))).reason).toBe('password')
  })

  it('rejects a malformed envelope', async () => {
    expect((await rejection(decryptField('not-base64!!', 'pw', FIELD))).reason).toBe('malformed')
    expect((await rejection(decryptField(btoa('short'), 'pw', FIELD))).reason).toBe('malformed')
  })

  it('reports a newer format as newer, not as a wrong password', async () => {
    const bytes = decodeEnvelope(await encryptField('x', 'pw', FIELD))
    bytes[0] = 3
    const error = await rejection(decryptField(encode(bytes), 'pw', FIELD))
    expect(error.reason).toBe('newer')
    expect(decryptFailureMessage(error)).toContain('newer version of Edi')
  })
})

describe('version 2 binding', () => {
  it('will not open under another label', async () => {
    const envelope = await encryptField('value', 'pw', FIELD)
    const error = await rejection(decryptField(envelope, 'pw', { kind: 'field', label: 'Other' }))
    expect(error.reason).toBe('password')
    expect(decryptFailureMessage(error)).toBe('Incorrect password, or the label was changed after encrypting')
  })

  it('will not open as the other kind', async () => {
    const envelope = await encryptField('value', 'pw', { kind: 'block', label: 'Keys' })
    expect((await rejection(decryptField(envelope, 'pw', { kind: 'field', label: 'Keys' }))).reason).toBe('password')
  })

  it('will not open when downgraded to version 1', async () => {
    const bytes = decodeEnvelope(await encryptField('value', 'pw', FIELD))
    bytes[0] = 1
    expect((await rejection(decryptField(encode(bytes), 'pw', FIELD))).reason).toBe('password')
  })
})

describe('version 1 envelopes', () => {
  it('still open, under any label, and say only "Incorrect password" when wrong', async () => {
    expect(await decryptField(V1_ENVELOPE, 'old-pw', FIELD)).toBe('legacy secret')
    expect(await decryptField(V1_ENVELOPE, 'old-pw', { kind: 'block', label: 'anything' })).toBe('legacy secret')
    const error = await rejection(decryptField(V1_ENVELOPE, 'nope', FIELD))
    expect(decryptFailureMessage(error)).toBe('Incorrect password')
  })

  it('are rewritten as version 2 when sealed again with the key they opened with', async () => {
    const { plaintext, key } = await openEnvelope(V1_ENVELOPE, 'old-pw', FIELD)
    const resealed = await sealWithKey(plaintext + '!', key, FIELD)
    expect(decodeEnvelope(resealed)[0]).toBe(2)
    expect(await decryptField(resealed, 'old-pw', FIELD)).toBe('legacy secret!')
  })
})

describe('sealing keys', () => {
  it('seal repeatedly without deriving again, with a fresh IV each time', async () => {
    const key = await deriveSealingKey('pw')
    const a = await sealWithKey('one', key, FIELD)
    const b = await sealWithKey('one', key, FIELD)
    expect(a).not.toBe(b)
    expect(await openWithKey(a, key, FIELD)).toBe('one')
    expect(await decryptField(b, 'pw', FIELD)).toBe('one')
  })

  it('only open envelopes sealed under their own salt', async () => {
    const key = await deriveSealingKey('pw')
    const other = await encryptField('x', 'pw', FIELD)
    expect((await rejection(openWithKey(other, key, FIELD))).reason).toBe('password')
  })
})
