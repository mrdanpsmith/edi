/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  base: './',
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: false,
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
