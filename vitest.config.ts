// Test configuration. Vitest reads this file in preference to vite.config.ts,
// and merges the build config in below so tests resolve modules exactly as the
// build does.
//
// It is a separate file so that `vite build` never loads test code: the
// frontend stages of Dockerfile and Dockerfile.pyzip copy only the build's
// inputs (src/, shared/, tests/harness/, ...), not tests/browser/.
import { defineConfig, mergeConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import viteConfig from './vite.config.ts'
import { browserCommands } from './tests/browser/commands.ts'

const TEST_EXCLUDE = ['**/node_modules/**', '**/.cache/**', '**/.npm/**', '**/dist/**', '**/dist-app/**', '**/build/**', '**/coverage-py/**']

export default mergeConfig(
  viteConfig,
  defineConfig({
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
            // Installs window.bridge before any test file (and so before
            // src/bridge.ts) loads; see tests/browser/fake-bridge.ts.
            setupFiles: ['./tests/browser/fake-bridge.ts'],
            browser: {
              enabled: true,
              headless: true,
              provider: playwright(),
              // Roughly the shell's default window, not Vitest's phone-sized one.
              viewport: { width: 1280, height: 900 },
              instances: [{ browser: 'chromium' }],
              screenshotFailures: true,
              commands: browserCommands,
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
  }),
)
