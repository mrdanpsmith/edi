// Build configuration only. Tests are configured in vitest.config.ts, which
// merges this file in; keep test code (and test-only imports) out of here, or
// the Docker frontend stages, which copy only the build's inputs, cannot build.
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  clearScreen: false,
  base: './',
  build: {
    // Single bundle by design (see codeSplitting below): it already exceeds
    // the 500 kB default, so raise the limit rather than code-split.
    chunkSizeWarningLimit: 6500,
    emptyOutDir: process.env.VITE_HARNESS !== '1',
    rolldownOptions: {
      input:
        process.env.VITE_HARNESS === '1'
          ? { harness: resolve(import.meta.dirname, 'tests/harness/index.ts') }
          : { main: resolve(import.meta.dirname, 'index.html') },
      output: {
        codeSplitting: false,
        // Stable, hash-free filenames: the AV false-positive mitigation. AV
        // vendors that flagged the minified bundle can key on the known
        // assets/index.js path instead of re-scanning every hash-named build.
        entryFileNames:
          process.env.VITE_HARNESS === '1' ? 'harness.js' : 'assets/index.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
