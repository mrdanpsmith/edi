const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

function looksLikeUrl(s: string): boolean {
  return URL_SCHEME.test(s) || /^www\./i.test(s)
}

function stripTrailingProsePunct(s: string): string {
  return s.replace(/[),;.!?]+$/, '')
}

function hostnameOf(s: string): string | null {
  const trimmed = stripTrailingProsePunct(s.trim())
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^www\./i.test(trimmed)) return null
  let host = trimmed
  const schemeIdx = host.indexOf('://')
  if (schemeIdx >= 0) host = host.slice(schemeIdx + 3)
  const slash = host.search(/[/?#]/)
  if (slash >= 0) host = host.slice(0, slash)
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  const colon = host.indexOf(':')
  if (colon >= 0) host = host.slice(0, colon)
  host = host.replace(/^\[|\]$/g, '')
  if (!host) return null
  return host.toLowerCase().replace(/^www\./, '')
}

function linkBaseName(s: string): string | null {
  const trimmed = s.trim()
  // Prose with spaces is descriptive text, not a filename reference.
  if (/\s/.test(trimmed)) return null
  let seg = trimmed
  const hash = seg.indexOf('#')
  if (hash >= 0) seg = seg.slice(0, hash)
  const q = seg.indexOf('?')
  if (q >= 0) seg = seg.slice(0, q)
  const slash = seg.lastIndexOf('/')
  if (slash >= 0) seg = seg.slice(slash + 1)
  if (!seg) return null
  // Require a dot or an explicit path slash to avoid treating a bare word
  // (e.g. "notes") as a filename reference.
  if (!seg.includes('.') && !trimmed.includes('/')) return null
  return seg.toLowerCase()
}

/**
 * Heuristic for a "misleading" link: the visible link text makes the link look
 * like it points somewhere other than where its href actually resolves to.
 *
 * - When the text itself reads as a URL, it is misleading if its host differs
 *   from the href's host (e.g. text ``https://www.google.com`` but href
 *   ``https://attacker.address``).
 * - When both the text and href read as path/filename references, it is
 *   misleading if their final path segments differ (e.g. text ``README.md``
 *   but href ``ATTACKER.md``).
 *
 * Descriptive prose text ("read the docs") is never flagged.
 */
export function isMisleadingLink(href: string, text: string): boolean {
  const H = href.trim()
  const T = text.trim()
  if (!H || !T) return false

  const hUrl = looksLikeUrl(H)
  const tUrl = looksLikeUrl(T)

  if (tUrl || hUrl) {
    if (!tUrl) return false
    const th = hostnameOf(T)
    const hh = hostnameOf(H)
    if (!th || !hh) return false
    return th !== hh
  }

  const tBase = linkBaseName(T)
  const hBase = linkBaseName(H)
  if (!tBase || !hBase) return false
  return tBase !== hBase
}
