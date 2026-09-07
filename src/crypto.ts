/**
 * Per-field encryption for masked fields. All operations are pure
 * ``window.crypto.subtle`` (Web Crypto API) — no third-party dependency.
 *
 * Envelope layout (base64 payload, format version 1):
 *
 *   offset  size  field
 *   0       1     format_version = 1
 *   1       16    PBKDF2 salt
 *   17      12    AES-GCM IV
 *   29      16    GCM auth tag
 *   45      n     ciphertext
 *
 * The KDF is PBKDF2-HMAC-SHA-256 with 600,000 iterations (OWASP 2023). Every
 * encrypt draws a fresh salt and IV so no salt/IV pair is ever reused.
 */

export const MASKED_FORMAT_VERSION = 1
export const MASKED_SALT_LENGTH = 16
export const MASKED_IV_LENGTH = 12
export const MASKED_TAG_LENGTH = 16
export const MASKED_PBKDF2_ITERATIONS = 600_000
export const MASKED_KEY_LENGTH = 256

const HEADER_LENGTH = 1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH + MASKED_TAG_LENGTH

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
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

/**
 * Encrypt ``value`` with ``password`` into a versioned base64 envelope.
 * A fresh salt + IV is drawn for every call.
 */
export async function encryptField(value: string, password: string): Promise<string> {
  const salt = randomBytes(MASKED_SALT_LENGTH)
  const iv = randomBytes(MASKED_IV_LENGTH)
  const key = await deriveKey(password, salt)
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      new TextEncoder().encode(value),
    ),
  )
  const authTag = sealed.subarray(0, MASKED_TAG_LENGTH)
  const gcmCiphertext = sealed.subarray(MASKED_TAG_LENGTH)
  const envelope = new Uint8Array(HEADER_LENGTH + gcmCiphertext.length)
  envelope[0] = MASKED_FORMAT_VERSION
  envelope.set(salt, 1)
  envelope.set(iv, 1 + MASKED_SALT_LENGTH)
  envelope.set(authTag, 1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH)
  envelope.set(gcmCiphertext, 1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH + MASKED_TAG_LENGTH)
  return bytesToBase64(envelope)
}

/**
 * Encrypt ``value`` and prove the password is correct by immediately
 * decrypting the result (GCM auth). The envelope is only returned if the
 * round-trip matches — this catches a mistyped password at creation/re-encrypt
 * time, where there is no separate confirm field.
 */
export async function encryptFieldVerified(value: string, password: string): Promise<string> {
  const envelope = await encryptField(value, password)
  const roundTrip = await decryptField(envelope, password)
  if (roundTrip !== value) {
    throw new Error('Encrypted field self-check failed')
  }
  return envelope
}

/**
 * Decrypt ``envelope`` (base64) with ``password``. A wrong password fails the
 * GCM auth tag check and rejects with ``Incorrect password``.
 */
export async function decryptField(envelope: string, password: string): Promise<string> {
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = base64ToBytes(envelope)
  } catch {
    throw new Error('Malformed encrypted field')
  }
  if (bytes.length < HEADER_LENGTH) {
    throw new Error('Malformed encrypted field')
  }
  if (bytes[0] !== MASKED_FORMAT_VERSION) {
    throw new Error('Unsupported encrypted field format')
  }
  const salt = bytes.subarray(1, 1 + MASKED_SALT_LENGTH)
  const iv = bytes.subarray(1 + MASKED_SALT_LENGTH, 1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH)
  const authTag = bytes.subarray(
    1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH,
    1 + MASKED_SALT_LENGTH + MASKED_IV_LENGTH + MASKED_TAG_LENGTH,
  )
  const gcmCiphertext = bytes.subarray(HEADER_LENGTH)
  const sealed = new Uint8Array(MASKED_TAG_LENGTH + gcmCiphertext.length)
  sealed.set(authTag, 0)
  sealed.set(gcmCiphertext, MASKED_TAG_LENGTH)
  const key = await deriveKey(password, salt)
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, sealed)
    return new TextDecoder().decode(plaintext)
  } catch {
    throw new Error('Incorrect password')
  }
}