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
      include: ['src/**'],
    },
  },
})
