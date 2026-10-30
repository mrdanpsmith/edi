/**
 * Encryption for masked fields and encrypted blocks. All operations are pure
 * ``window.crypto.subtle`` (Web Crypto API) — no third-party dependency.
 *
 * Envelope layout (base64 payload):
 *
 *   offset  size  field
 *   0       1     format_version (1 or 2)
 *   1       16    PBKDF2 salt
 *   17      12    AES-GCM IV
 *   29      n     AES-GCM ciphertext
 *   29+n    16    AES-GCM auth tag
 *
 * Bytes 29 onward are exactly what ``crypto.subtle.encrypt`` returns, which puts
 * the tag **last**. (Version 1 was documented with the tag first; the bytes were
 * always written in this order, so a version 1 envelope reads the same way.)
 *
 * The KDF is PBKDF2-HMAC-SHA-256 with 600,000 iterations (OWASP 2023). Every
 * envelope draws a fresh IV; a fresh salt is drawn per key (see {@link SealingKey}).
 *
 * **Version 2 binds the envelope to what it is.** The version byte, the kind
 * (field or block) and the label are GCM's additional data, so an envelope cannot
 * be moved to another label or kind, or relabelled, and still open. Version 1
 * envelopes are bound to nothing and are still read; anything re-encrypted is
 * written as version 2.
 */

export const MASKED_FORMAT_VERSION = 2
export const MASKED_SALT_LENGTH = 16
export const MASKED_IV_LENGTH = 12
export const MASKED_TAG_LENGTH = 16
export const MASKED_PBKDF2_ITERATIONS = 600_000
export const MASKED_KEY_LENGTH = 256

const HEADER_LENGTH = 1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH

/** What an envelope holds, which a version 2 envelope is bound to. */
export interface SecretContext {
  kind: 'field' | 'block'
  /** The label exactly as it is saved in the markdown. */
  label: string
}

/**
 * Why an envelope did not open: the password (or, for version 2, the label or kind
 * it was bound to), a format newer than this build reads, or bytes that are not an
 * envelope at all.
 */
export class DecryptError extends Error {
  readonly reason: 'password' | 'newer' | 'malformed'
  readonly version: number

  constructor(reason: DecryptError['reason'], message: string, version = 0) {
    super(message)
    this.reason = reason
    this.version = version
  }
}

/** The words to show a reader for a failed decrypt — never "wrong password" for a format problem. */
export function decryptFailureMessage(error: unknown): string {
  if (!(error instanceof DecryptError)) return 'Could not decrypt'
  if (error.reason === 'newer') return 'This was encrypted by a newer version of Edi. Update Edi to open it.'
  if (error.reason === 'malformed') return 'This encrypted content is damaged and cannot be opened.'
  return error.version >= 2 ? 'Incorrect password, or the label was changed after encrypting' : 'Incorrect password'
}

/**
 * A derived key and the salt it came from. Deriving is the slow part (PBKDF2), so
 * an open encrypted block keeps one of these instead of the password and seals
 * every save with it — a fresh IV each time, which is what GCM requires.
 */
export interface SealingKey {
  readonly key: CryptoKey
  readonly salt: Uint8Array<ArrayBuffer>
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export async function deriveSealingKey(
  password: string,
  salt: Uint8Array<ArrayBuffer> = randomBytes(MASKED_SALT_LENGTH),
): Promise<SealingKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: MASKED_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: MASKED_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  )
  return { key, salt }
}

function additionalData(version: number, context: SecretContext): Uint8Array<ArrayBuffer> | undefined {
  if (version < 2) return undefined
  return new TextEncoder().encode(`${version}\0${context.kind}\0${context.label}`)
}

function gcmParams(iv: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer> | undefined): AesGcmParams {
  return aad ? { name: 'AES-GCM', iv, tagLength: 128, additionalData: aad } : { name: 'AES-GCM', iv, tagLength: 128 }
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let result = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += btoa(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return result
}

function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

interface ParsedEnvelope {
  version: number
  salt: Uint8Array<ArrayBuffer>
  iv: Uint8Array<ArrayBuffer>
  sealed: Uint8Array<ArrayBuffer>
}

function parseEnvelope(envelope: string): ParsedEnvelope {
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = base64ToBytes(envelope)
  } catch {
    throw new DecryptError('malformed', 'Malformed encrypted field')
  }
  if (bytes.length < HEADER_LENGTH + MASKED_TAG_LENGTH) {
    throw new DecryptError('malformed', 'Malformed encrypted field')
  }
  const version = bytes[0]!
  if (version > MASKED_FORMAT_VERSION) {
    throw new DecryptError('newer', 'Unsupported encrypted field format', version)
  }
  if (version < 1) throw new DecryptError('malformed', 'Malformed encrypted field')
  return {
    version,
    salt: bytes.slice(1, 1 + MASKED_SALT_LENGTH),
    iv: bytes.slice(1 + MASKED_SALT_LENGTH, HEADER_LENGTH),
    sealed: bytes.slice(HEADER_LENGTH),
  }
}

async function open(parsed: ParsedEnvelope, key: CryptoKey, context: SecretContext): Promise<string> {
  try {
    const plaintext = await crypto.subtle.decrypt(gcmParams(parsed.iv, additionalData(parsed.version, context)), key, parsed.sealed)
    return new TextDecoder().decode(plaintext)
  } catch {
    throw new DecryptError('password', 'Incorrect password', parsed.version)
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * Seal ``value`` with an already-derived key, then prove the envelope opens
 * (GCM auth) before returning it. No key derivation happens here.
 */
export async function sealWithKey(value: string, key: SealingKey, context: SecretContext): Promise<string> {
  const iv = randomBytes(MASKED_IV_LENGTH)
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(gcmParams(iv, additionalData(MASKED_FORMAT_VERSION, context)), key.key, new TextEncoder().encode(value)),
  )
  const envelope = new Uint8Array(HEADER_LENGTH + sealed.length)
  envelope[0] = MASKED_FORMAT_VERSION
  envelope.set(key.salt, 1)
  envelope.set(iv, 1 + MASKED_SALT_LENGTH)
  envelope.set(sealed, HEADER_LENGTH)
  const encoded = bytesToBase64(envelope)
  if ((await openWithKey(encoded, key, context)) !== value) {
    throw new Error('Encrypted field self-check failed')
  }
  return encoded
}

/** Open an envelope with a key derived earlier — only one sealed under that key's salt. */
export async function openWithKey(envelope: string, key: SealingKey, context: SecretContext): Promise<string> {
  const parsed = parseEnvelope(envelope)
  if (!sameBytes(parsed.salt, key.salt)) throw new DecryptError('password', 'Incorrect password', parsed.version)
  return open(parsed, key.key, context)
}

/** Open an envelope with its password, keeping the derived key for sealing later saves. */
export async function openEnvelope(
  envelope: string,
  password: string,
  context: SecretContext,
): Promise<{ plaintext: string; key: SealingKey }> {
  const parsed = parseEnvelope(envelope)
  const key = await deriveSealingKey(password, parsed.salt)
  return { plaintext: await open(parsed, key.key, context), key }
}

/**
 * Encrypt ``value`` with ``password`` into a version 2 envelope bound to
 * ``context``, self-checked before it is returned. One key derivation.
 */
export async function encryptField(value: string, password: string, context: SecretContext): Promise<string> {
  return sealWithKey(value, await deriveSealingKey(password), context)
}

/**
 * Decrypt ``envelope`` (base64) with ``password``. Rejects with a {@link DecryptError}
 * that says whether the password, the format or the bytes were the problem.
 */
export async function decryptField(envelope: string, password: string, context: SecretContext): Promise<string> {
  return (await openEnvelope(envelope, password, context)).plaintext
}
