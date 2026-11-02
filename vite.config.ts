/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { playwright } from '@vitest/browser-playwright'

const TEST_EXCLUDE = ['**/node_modules/**', '**/.cache/**', '**/.npm/**', '**/dist/**', '**/dist-app/**', '**/build/**', '**/coverage-py/**']

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
  test: {
    exclude: TEST_EXCLUDE,
    // Two projects (see docs/development.md, "Browser tests"):
    //   unit    -- src/**/*.test.ts in jsdom: fast, no layout.
    //   browser -- tests/browser/*.browser.test.ts in headless Chromium via
    //              Playwright: real layout and trusted input, no Python.
    // `npm test` and `npm run coverage` run only `unit`; `npm run test:browser`
    // runs `browser`.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./src/test-setup.ts'],
          exclude: [...TEST_EXCLUDE, 'tests/browser/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            // Roughly the shell's default window, not Vitest's phone-sized one.
            viewport: { width: 1280, height: 900 },
            instances: [{ browser: 'chromium' }],
            screenshotFailures: true,
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // 'html' is the browsable report the CI job ships as an artifact; the
      // rest are machine-readable (cobertura feeds the badges branch, lcov is
      // for editors/IDEs). The text one is what the run summary tails.
      reporter: ['text', 'lcov', 'cobertura', 'html'],
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
