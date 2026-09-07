import { webcrypto } from 'node:crypto'

// jsdom does not implement the Web Crypto API (no `crypto.subtle`), which the
// masked-field encryption relies on. In tests, substitute Node's webcrypto.
if (typeof globalThis.crypto?.subtle === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true,
  })
}