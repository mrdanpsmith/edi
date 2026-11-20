/**
 * The Mermaid an exported HTML file loads when a diagram has no PNG snapshot.
 *
 * Pinned to the exact version Edi bundles, with its Subresource Integrity hash,
 * so the exported file runs the Mermaid it was checked against and nothing a CDN
 * serves later. `src/mermaidCdn.test.ts` fails when a Mermaid upgrade leaves
 * either value stale.
 */
export const MERMAID_CDN_VERSION = '11.17.2'

export const MERMAID_CDN_INTEGRITY = 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2'

export const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_CDN_VERSION}/dist/mermaid.min.js`
