/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  base: './',
  test: {
    environment: 'jsdom',
    exclude: ['**/node_modules/**', '**/.cache/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'cobertura'],
      include: ['src/**'],
    },
  },
})
