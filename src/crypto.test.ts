import { describe, expect, it } from 'vitest'
import {
  decryptField,
  encryptField,
  encryptFieldVerified,
  MASKED_FORMAT_VERSION,
  MASKED_IV_LENGTH,
  MASKED_SALT_LENGTH,
  MASKED_TAG_LENGTH,
} from './crypto'

function decodeEnvelope(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

describe('encryptField / decryptField', () => {
  it('round-trips a value', async () => {
    const envelope = await encryptField('s3cr3t-value', 'hunter2')
    expect(envelope).not.toContain('s3cr3t-value')
    expect(await decryptField(envelope, 'hunter2')).toBe('s3cr3t-value')
  })

  it('rejects a wrong password', async () => {
    const envelope = await encryptField('value', 'right-password')
    await expect(decryptField(envelope, 'wrong-password')).rejects.toThrow('Incorrect password')
  })

  it('uses a fresh salt and IV per encrypt', async () => {
    const a = await encryptField('same value', 'same password')
    const b = await encryptField('same value', 'same password')
    expect(a).not.toBe(b)
    const bytesA = decodeEnvelope(a)
    const bytesB = decodeEnvelope(b)
    expect(bytesA.subarray(1, 1 + MASKED_SALT_LENGTH)).not.toEqual(bytesB.subarray(1, 1 + MASKED_SALT_LENGTH))
    expect(bytesA.subarray(1 + MASKED_SALT_LENGTH, 1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH)).not.toEqual(
      bytesB.subarray(1 + MASKED_SALT_LENGTH, 1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH),
    )
  })

  it('lays out the versioned envelope with the documented offsets', async () => {
    const envelope = await encryptField('x', 'pw')
    const bytes = decodeEnvelope(envelope)
    expect(bytes[0]).toBe(MASKED_FORMAT_VERSION)
    expect(bytes.length).toBe(
      1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH + MASKED_TAG_LENGTH + new TextEncoder().encode('x').length,
    )
  })

  it('rejects a malformed envelope', async () => {
    await expect(decryptField('not-base64!!', 'pw')).rejects.toThrow('Malformed encrypted field')
  })

  it('rejects an unsupported format version', async () => {
    const envelope = await encryptField('x', 'pw')
    const bytes = decodeEnvelope(envelope)
    bytes[0] = 99
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('')
    await expect(decryptField(btoa(binary), 'pw')).rejects.toThrow('Unsupported encrypted field format')
  })

  it('self-checks the decrypted round-trip before returning an envelope', async () => {
    const envelope = await encryptFieldVerified('value', 'pw')
    expect(await decryptField(envelope, 'pw')).toBe('value')
  })
})