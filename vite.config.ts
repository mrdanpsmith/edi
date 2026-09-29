/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  base: './',
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: false,
        // Stable, hash-free filenames: the AV false-positive mitigation. AV
        // vendors that flagged the minified bundle can key on the known
        // assets/index.js path instead of re-scanning every hash-named build.
        entryFileNames: 'assets/index.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    exclude: ['**/node_modules/**', '**/.cache/**', '**/.npm/**', '**/dist/**', '**/dist-app/**', '**/build/**', '**/coverage-py/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'cobertura'],
      // There is no coverage.all in v4: the v8 provider globs include after a
      // full run and reports whatever it never loaded, so a module no test
      // imports lands at 0% instead of quietly leaving the denominator (proved
      // with a throwaway src/zzNeverImportedProbe.ts: 0%, 63 -> 64 classes).
      // Two consequences of the same code path: a single-file re-run skips it
      // (cleanOnRerun), so "npm run coverage" is the report that counts, and
      // src/test-setup.ts is in neither bucket (the runner loads it without
      // instrumenting it) -- so leave coverage.exclude unset, since replacing
      // the default list would pull all 53 *.test.ts files into the report.
      include: ['src/**'],
    },
  },
})
